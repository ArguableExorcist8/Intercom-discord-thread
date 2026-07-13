import { randomUUID, timingSafeEqual, createHash } from "crypto";
import dotenv from "dotenv";
import express, { NextFunction, Request, Response } from "express";
import { initializeDiscordBot } from "./bot";
import { loadRuntimeConfig, RuntimeConfig } from "./config";
import { createFollowUpThread } from "./discord";
import { hydrateConversationFromIntercom } from "./intercomApi";
import { parseIntercomTicketRequest } from "./intercom";
import { InMemoryRateLimiter, InMemoryTicketDeduplicator } from "./protection";
import { generateSummary } from "./summary";
import type { Conversation, DiscordThreadResult } from "./types";
import { AppError, logEvent } from "./utils";

interface TicketResponse {
  conversationId: string;
  thread: DiscordThreadResult;
}

export interface ServerDependencies {
  fetchConversation: (conversationId: string) => Promise<Conversation>;
  processConversation: (conversation: Conversation) => Promise<DiscordThreadResult>;
}

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
      return createFollowUpThread(conversation, summary);
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

  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxyHops);
  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.set("X-Request-Id", res.locals.requestId);
    next();
  });
  app.use(applySecurityHeaders);
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
      const { conversationId, playerLevel } = ticket;
      const result = await deduplicator.run(conversationId, async () => {
        const conversation = await dependencies.fetchConversation(conversationId);
        const thread = await dependencies.processConversation({
          ...conversation,
          ...(playerLevel === undefined ? {} : { playerLevel })
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
