import { randomUUID, timingSafeEqual, createHash, createHmac } from "crypto";
import dotenv from "dotenv";
import express, { NextFunction, Request, Response } from "express";
import { initializeDiscordBot } from "./bot";
import { loadRuntimeConfig, RuntimeConfig } from "./config";
import {
  closeFollowUpThread,
  createFollowUpThread,
  getLatestFollowUpCustomerUpdate,
  postFollowUpCustomerUpdate,
  reopenFollowUpThread,
  updateFollowUpCreatedBy
} from "./discord";
import {
  getIntercomAdmin,
  hydrateConversationFromIntercom,
  hydrateTicketFromIntercom,
  updateFollowUpTicketSyncState,
  updateFollowUpSyncState
} from "./intercomApi";
import { parseIntercomTicketRequest } from "./intercom";
import { InMemoryRateLimiter, InMemoryTicketDeduplicator } from "./protection";
import { generateMaterialConversationUpdate, generateSummary } from "./summary";
import {
  getFollowUpSyncEvent,
  getLatestCustomerPartId,
  isFollowUpWebhookTopic,
  isTicketFollowUpWebhookTopic,
  processFollowUpWebhook
} from "./followUpSync";
import type { Conversation, DiscordThreadResult } from "./types";
import { AppError, logEvent } from "./utils";

interface TicketResponse {
  conversationId: string;
  thread: DiscordThreadResult;
  ticketId?: string;
  ticketDisplayId?: string;
}

export interface ServerDependencies {
  fetchConversation: (conversationId: string) => Promise<Conversation>;
  processConversation: (conversation: Conversation) => Promise<DiscordThreadResult>;
  processTicket: (ticketId: string, playerLevel?: number, conversationId?: string) => Promise<TicketResponse>;
  processFollowUpWebhook?: (topic: string, conversationId: string) => Promise<void>;
  processDataConnectorExecution?: (conversationId: string, adminId: string) => Promise<void>;
}

const DATA_CONNECTOR_EXECUTION_COMPLETED_TOPIC = "data_connector.execution.completed";

function hashSecret(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function assertIntercomConnectorAuthorized(req: Request, expectedSecret: string): void {
  const headerSecret = req.get("x-intercom-connector-secret")?.trim() ?? "";
  const authorization = req.get("authorization")?.trim() ?? "";
  const bearerSecret = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice("bearer ".length).trim()
    : "";
  const expectedHash = hashSecret(expectedSecret);
  const headerMatches = timingSafeEqual(hashSecret(headerSecret), expectedHash);
  const bearerMatches = timingSafeEqual(hashSecret(bearerSecret), expectedHash);

  if (!headerMatches && !bearerMatches) {
    throw new AppError(401, "Unauthorized.", "CONNECTOR_UNAUTHORIZED");
  }
}

function assertIntercomWebhookAuthorized(req: Request, body: Buffer, expectedSecret: string): void {
  const signature = req.get("x-hub-signature")?.trim() ?? "";
  const expected = `sha1=${createHmac("sha1", expectedSecret).update(body).digest("hex")}`;
  const validFormat = /^sha1=[a-f0-9]{40}$/i.test(signature);

  if (
    !validFormat ||
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"))
  ) {
    throw new AppError(401, "Unauthorized.", "WEBHOOK_UNAUTHORIZED");
  }
}

function readWebhookObjectId(payload: unknown): { topic: string; objectId: string } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new AppError(400, "Invalid Intercom webhook payload.", "WEBHOOK_INVALID_PAYLOAD");
  }

  const notification = payload as Record<string, unknown>;
  const data = notification.data;
  const item = typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>).item
    : null;
  const topic = typeof notification.topic === "string" ? notification.topic.trim() : "";
  const itemRecord = typeof item === "object" && item !== null && !Array.isArray(item)
    ? item as Record<string, unknown>
    : {};
  const ticket = typeof itemRecord.ticket === "object" && itemRecord.ticket !== null && !Array.isArray(itemRecord.ticket)
    ? itemRecord.ticket as Record<string, unknown>
    : itemRecord;
  const objectId = String(ticket.id ?? ticket.ticket_id ?? itemRecord.id ?? itemRecord.ticket_id ?? "").trim();

  if (!topic || !objectId) {
    throw new AppError(400, "Invalid Intercom webhook payload.", "WEBHOOK_INVALID_PAYLOAD");
  }

  return { topic, objectId };
}

function readDataConnectorExecution(payload: unknown): {
  success: boolean;
  sourceType: string;
  conversationId: string;
  adminId: string;
} {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new AppError(400, "Invalid Intercom webhook payload.", "WEBHOOK_INVALID_PAYLOAD");
  }

  const notification = payload as Record<string, unknown>;
  const data = notification.data;
  const item = typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>).item
    : null;

  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new AppError(400, "Invalid Intercom webhook payload.", "WEBHOOK_INVALID_PAYLOAD");
  }

  const execution = item as Record<string, unknown>;

  return {
    success: execution.success === true,
    sourceType: typeof execution.source_type === "string" ? execution.source_type.trim().toLowerCase() : "",
    conversationId: String(execution.conversation_id ?? "").trim(),
    adminId: String(execution.admin_id ?? "").trim()
  };
}

function createFollowUpSyncDependencies(config: RuntimeConfig, source: "conversation" | "ticket" = "conversation") {
  return {
    updateState: (id: string, update: { threadId?: string; lastSeenPartId?: string; status?: "open" | "closed" }) =>
      source === "ticket"
        ? updateFollowUpTicketSyncState(id, update, config.outboundTimeoutMs)
        : updateFollowUpSyncState(id, update, config.outboundTimeoutMs),
    classifyCustomerUpdate: (
      conversation: Conversation,
      newMessages: Conversation["messages"],
      previousUpdate: string
    ) => generateMaterialConversationUpdate(conversation, newMessages, config.outboundTimeoutMs, previousUpdate),
    getLatestCustomerUpdate: getLatestFollowUpCustomerUpdate,
    postCustomerUpdate: postFollowUpCustomerUpdate,
    closeThread: closeFollowUpThread,
    reopenThread: reopenFollowUpThread
  };
}

async function withinTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new AppError(500, "Internal server error.", "WEBHOOK_PROCESSING_TIMEOUT")),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function applySecurityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.set({
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });

  if (process.env.NODE_ENV === "production") {
    res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  next();
}

function defaultDependencies(config: RuntimeConfig): ServerDependencies {
  return {
    fetchConversation: (conversationId) =>
      hydrateConversationFromIntercom(conversationId, config.outboundTimeoutMs),
    processConversation: async (conversation) => {
      const summary = await generateSummary(conversation, config.outboundTimeoutMs);
      const thread = await createFollowUpThread(conversation, summary);
      await updateFollowUpSyncState(conversation.conversationId, {
        threadId: thread.threadId,
        lastSeenPartId: getLatestCustomerPartId(conversation.messages),
        status: "open"
      }, config.outboundTimeoutMs);
      return thread;
    },
    processTicket: async (ticketId, playerLevel, conversationId) => {
      const conversation = await hydrateTicketFromIntercom(ticketId, config.outboundTimeoutMs, conversationId);

      if (!conversation) {
        throw new AppError(404, "Intercom ticket is not linked to a conversation.", "INTERCOM_TICKET_NOT_LINKED");
      }

      const preparedConversation = playerLevel === undefined
        ? conversation
        : { ...conversation, playerLevel };
      const summary = await generateSummary(preparedConversation, config.outboundTimeoutMs);
      const thread = await createFollowUpThread(preparedConversation, summary);
      await updateFollowUpTicketSyncState(ticketId, {
        threadId: thread.threadId,
        lastSeenPartId: getLatestCustomerPartId(preparedConversation.messages),
        status: "open"
      }, config.outboundTimeoutMs);

      if (preparedConversation.conversationId !== ticketId) {
        await updateFollowUpSyncState(preparedConversation.conversationId, {
          threadId: thread.threadId,
          status: "open"
        }, config.outboundTimeoutMs);
      }

      return {
        conversationId: preparedConversation.conversationId,
        thread,
        ticketId: preparedConversation.ticketId ?? ticketId,
        ticketDisplayId: preparedConversation.ticketDisplayId
      };
    }
  };
}

function errorResponse(error: unknown): { statusCode: number; message: string; code: string } {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      message: error.statusCode >= 500 ? "Internal server error." : error.message,
      code: error.code
    };
  }

  return { statusCode: 500, message: "Internal server error.", code: "UNEXPECTED_ERROR" };
}

export function createApp(config: RuntimeConfig, overrides?: Partial<ServerDependencies>) {
  const app = express();
  const dependencies = { ...defaultDependencies(config), ...overrides };
  const rateLimiter = new InMemoryRateLimiter(config.rateLimitMax, config.rateLimitWindowMs);
  const deduplicator = new InMemoryTicketDeduplicator<TicketResponse>(config.deduplicationTtlMs);
  const ticketApiIdsByEventId = new Map<string, string>();
  const processWebhook = overrides?.processFollowUpWebhook ?? (async (topic: string, objectId: string) => {
    if (!isFollowUpWebhookTopic(topic)) {
      return;
    }

    let conversation: Conversation;

    if (isTicketFollowUpWebhookTopic(topic)) {
      const ticketApiId = ticketApiIdsByEventId.get(objectId) ?? objectId;
      const ticketConversation = await hydrateTicketFromIntercom(ticketApiId, config.outboundTimeoutMs);

      if (!ticketConversation) {
        return;
      }

      if (ticketConversation.ticketId) {
        ticketApiIdsByEventId.set(ticketConversation.ticketId, ticketConversation.ticketId);
      }

      if (ticketConversation.ticketDisplayId && ticketConversation.ticketId) {
        ticketApiIdsByEventId.set(ticketConversation.ticketDisplayId, ticketConversation.ticketId);
      }

      conversation = ticketConversation;
    } else {
      conversation = await dependencies.fetchConversation(objectId);
    }

    const event = getFollowUpSyncEvent(topic, conversation.state);

    if (!event) {
      return;
    }

    const syncId = isTicketFollowUpWebhookTopic(topic) ? (conversation.ticketId ?? objectId) : conversation.conversationId;
    await processFollowUpWebhook(event, syncId, {
      fetchConversation: async () => conversation,
      ...createFollowUpSyncDependencies(config, isTicketFollowUpWebhookTopic(topic) ? "ticket" : "conversation")
    });
  });
  const processDataConnectorExecution = overrides?.processDataConnectorExecution ?? (async (
    conversationId: string,
    adminId: string
  ) => {
    const conversation = await dependencies.fetchConversation(conversationId);
    const threadId = conversation.followUpSync?.threadId;

    if (!threadId) {
      logEvent("info", "data_connector_execution_ignored", {
        reason: "missing_discord_thread"
      });
      return;
    }

    const runner = await getIntercomAdmin(adminId, config.outboundTimeoutMs);
    const updateResult = await updateFollowUpCreatedBy(threadId, runner);

    if (updateResult !== "updated") {
      logEvent("info", "data_connector_execution_ignored", { reason: updateResult });
    }
  });

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxyHops);
  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.set("X-Request-Id", res.locals.requestId);
    next();
  });
  app.use(applySecurityHeaders);

  app.head("/intercom/webhook", (_req: Request, res: Response) => {
    res.sendStatus(200);
  });

  app.post(
    "/intercom/webhook",
    express.raw({ limit: "64kb", type: "application/json" }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!Buffer.isBuffer(req.body)) {
          throw new AppError(415, "Content-Type must be application/json.", "UNSUPPORTED_MEDIA_TYPE");
        }

        assertIntercomWebhookAuthorized(req, req.body, config.webhookClientSecret);
        let payload: unknown;

        try {
          payload = JSON.parse(req.body.toString("utf8")) as unknown;
        } catch {
          throw new AppError(400, "Invalid Intercom webhook payload.", "WEBHOOK_INVALID_PAYLOAD");
        }

        const topic = typeof payload === "object" && payload !== null && !Array.isArray(payload)
          ? String((payload as Record<string, unknown>).topic ?? "").trim()
          : "";

        if (topic === DATA_CONNECTOR_EXECUTION_COMPLETED_TOPIC) {
          const execution = readDataConnectorExecution(payload);

          logEvent("info", "data_connector_execution_received", {
            requestId: res.locals.requestId,
            success: execution.success,
            sourceType: execution.sourceType || "unknown",
            hasConversationId: Boolean(execution.conversationId),
            hasAdminId: Boolean(execution.adminId)
          });

          const ignoredReason = !execution.success
            ? "failed_execution"
            : !execution.conversationId
              ? "missing_conversation_id"
              : !execution.adminId
                ? "missing_admin_id"
                : "";

          if (!ignoredReason) {
            await withinTimeout(
              processDataConnectorExecution(execution.conversationId, execution.adminId),
              config.webhookProcessingTimeoutMs
            );
            logEvent("info", "data_connector_execution_processed", {
              requestId: res.locals.requestId,
              topic,
              sourceType: execution.sourceType || "unknown"
            });
          } else {
            logEvent("info", "data_connector_execution_ignored", { reason: ignoredReason });
          }

          return res.status(200).json({ success: true });
        }

        const { objectId } = readWebhookObjectId(payload);

        if (!isFollowUpWebhookTopic(topic)) {
          return res.status(204).end();
        }

        await withinTimeout(processWebhook(topic, objectId), config.webhookProcessingTimeoutMs);
        logEvent("info", "webhook_processed", { requestId: res.locals.requestId, topic });
        return res.status(200).json({ success: true });
      } catch (error) {
        next(error);
      }
    }
  );

  app.use(express.json({ limit: "8kb", type: "application/json" }));

  app.get("/", (_req: Request, res: Response) => {
    res.json({ ok: true, service: "intercom-discord-followup" });
  });

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.post("/intercom/ticket", async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.is("application/json")) {
        throw new AppError(415, "Content-Type must be application/json.", "UNSUPPORTED_MEDIA_TYPE");
      }

      rateLimiter.assertAllowed(req.ip ?? req.socket.remoteAddress ?? "unknown");
      assertIntercomConnectorAuthorized(req, config.connectorSecret);
      const ticket = parseIntercomTicketRequest(req.body);
      const sourceId = ticket.ticketId ?? ticket.conversationId ?? "";
      const result = await deduplicator.run(`${ticket.ticketId ? "ticket" : "conversation"}:${sourceId}`, async () => {
        if (ticket.ticketId) {
          const ticketResult = await dependencies.processTicket(
            ticket.ticketId,
            ticket.playerLevel,
            ticket.conversationId
          );

          if (ticketResult.ticketId) {
            ticketApiIdsByEventId.set(ticketResult.ticketId, ticketResult.ticketId);
          }

          if (ticketResult.ticketDisplayId && ticketResult.ticketId) {
            ticketApiIdsByEventId.set(ticketResult.ticketDisplayId, ticketResult.ticketId);
          }

          return ticketResult;
        }

        const conversation = await dependencies.fetchConversation(ticket.conversationId ?? "");
        const thread = await dependencies.processConversation({
          ...conversation,
          ...(ticket.playerLevel === undefined ? {} : { playerLevel: ticket.playerLevel })
        });

        return { conversationId: conversation.conversationId, thread };
      });

      logEvent("info", "ticket_processed", { requestId: res.locals.requestId });
      res.json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof SyntaxError && "body" in error) {
      return res.status(400).json({ success: false, error: "Invalid JSON body." });
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      error.type === "entity.too.large"
    ) {
      return res.status(413).json({ success: false, error: "Request body is too large." });
    }

    next(error);
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const requestId = res.locals.requestId ?? "unknown";
    const response = errorResponse(error);

    logEvent(response.statusCode >= 500 ? "error" : "warn", "request_failed", {
      requestId,
      statusCode: response.statusCode,
      code: response.code
    });

    res.status(response.statusCode).json({ success: false, error: response.message });
  });

  return app;
}

async function bootstrap(): Promise<void> {
  dotenv.config();
  dotenv.config({ path: ".env.local", override: true });

  const config = loadRuntimeConfig();
  await initializeDiscordBot();
  const app = createApp(config);

  app.listen(config.port, () => {
    logEvent("info", "server_started", { port: config.port });
  });
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    const code = error instanceof AppError ? error.code : "STARTUP_FAILED";
    logEvent("error", "startup_failed", { code });
    process.exit(1);
  });
}
