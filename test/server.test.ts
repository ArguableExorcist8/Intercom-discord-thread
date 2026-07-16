import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/server";
import type { RuntimeConfig } from "../src/config";
import type { Conversation } from "../src/types";

const config: RuntimeConfig = {
  port: 3000,
  connectorSecret: "test-connector-secret",
  webhookClientSecret: "test-webhook-secret",
  webhookProcessingTimeoutMs: 1_000,
  outboundTimeoutMs: 1_000,
  rateLimitMax: 10,
  rateLimitWindowMs: 60_000,
  deduplicationTtlMs: 60_000,
  trustProxyHops: 0
};

const conversation: Conversation = {
  conversationId: "conversation-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  playerName: "Player",
  playerLevel: 1,
  userId: "user-1",
  createdBy: "Agent",
  routingTags: [],
  messages: [{ role: "user", text: "Need help", timestamp: "2026-01-01T00:00:00.000Z" }]
};

async function withServer(
  app: ReturnType<typeof createApp>,
  callback: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      (server as Server).close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function testApp(overrides: Partial<RuntimeConfig> = {}) {
  return createApp(
    { ...config, ...overrides },
    {
      fetchConversation: async (conversationId) => ({ ...conversation, conversationId }),
      processConversation: async () => ({ threadId: "thread-1", threadUrl: "https://discord.test/thread-1" })
    }
  );
}

function headers(secret = config.connectorSecret): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Intercom-Connector-Secret": secret
  };
}

function webhookHeaders(body: string, secret = config.webhookClientSecret): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Hub-Signature": `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`
  };
}

test("health check does not expose runtime configuration", async () => {
  await withServer(testApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test("ticket endpoint requires connector authentication", async () => {
  await withServer(testApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/intercom/ticket`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: "conversation-1" })
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { success: false, error: "Unauthorized." });
  });
});

test("ticket endpoint accepts Bearer authentication, applies connector routing fields, and rejects unknown fields", async () => {
  let processedConversation: Conversation | undefined;
  const app = createApp(config, {
    fetchConversation: async (conversationId) => ({ ...conversation, conversationId }),
    processConversation: async (ticket) => {
      processedConversation = ticket;
      return { threadId: "thread-1", threadUrl: "https://discord.test/thread-1" };
    }
  });

  await withServer(app, async (baseUrl) => {
    const validResponse = await fetch(`${baseUrl}/intercom/ticket`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.connectorSecret}`
      },
      body: JSON.stringify({ conversation_id: "conversation-1", player_level: "68", partner_status: "true" })
    });

    assert.equal(validResponse.status, 200);
    assert.equal(processedConversation?.playerLevel, 68);
    assert.deepEqual(processedConversation?.routingTags, ["vipPartner"]);

    const rejectedResponse = await fetch(`${baseUrl}/intercom/ticket`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ conversation_id: "conversation-2", messages: ["untrusted"] })
    });

    assert.equal(rejectedResponse.status, 400);
  });
});

test("ticket endpoint rejects non-JSON requests and rate limits callers", async () => {
  await withServer(testApp({ rateLimitMax: 1 }), async (baseUrl) => {
    const nonJson = await fetch(`${baseUrl}/intercom/ticket`, {
      method: "POST",
      headers: { "X-Intercom-Connector-Secret": config.connectorSecret },
      body: "conversation-1"
    });

    assert.equal(nonJson.status, 415);

    const first = await fetch(`${baseUrl}/intercom/ticket`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ conversation_id: "conversation-1" })
    });
    const second = await fetch(`${baseUrl}/intercom/ticket`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ conversation_id: "conversation-2" })
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
  });
});

test("ticket endpoint rejects oversized bodies", async () => {
  await withServer(testApp(), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/intercom/ticket`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ conversation_id: "conversation-1", padding: "x".repeat(9_000) })
    });

    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { success: false, error: "Request body is too large." });
  });
});

test("provider failures do not create threads or expose error details", async () => {
  let processCalls = 0;
  const app = createApp(config, {
    fetchConversation: async () => {
      throw new Error("provider response included a sensitive detail");
    },
    processConversation: async () => {
      processCalls += 1;
      return { threadId: "unexpected", threadUrl: "https://discord.test/unexpected" };
    }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/intercom/ticket`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ conversation_id: "conversation-1" })
    });

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { success: false, error: "Internal server error." });
    assert.equal(processCalls, 0);
  });
});

test("ticket endpoint uses the internal ticket ID for ticket-first thread creation", async () => {
  let receivedTicketId = "";
  let receivedPlayerLevel: number | undefined;
  let receivedConversationId: string | undefined;
  let receivedPartnerStatus: boolean | undefined;
  const app = createApp(config, {
    processTicket: async (ticketId, playerLevel, conversationId, partnerStatus) => {
      receivedTicketId = ticketId;
      receivedPlayerLevel = playerLevel;
      receivedConversationId = conversationId;
      receivedPartnerStatus = partnerStatus;
      return {
        conversationId: "conversation-1",
        thread: { threadId: "thread-1", threadUrl: "https://discord.test/thread-1" }
      };
    }
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/intercom/ticket`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        ticket_id: "internal-ticket-1",
        conversation_id: "conversation-1",
        player_level: 71,
        partner_status: true
      })
    });

    assert.equal(response.status, 200);
  });

  assert.equal(receivedTicketId, "internal-ticket-1");
  assert.equal(receivedPlayerLevel, 71);
  assert.equal(receivedConversationId, "conversation-1");
  assert.equal(receivedPartnerStatus, true);
});

test("webhook validates signatures, handles supported topics, and ignores unsupported topics", async () => {
  const received: Array<{ topic: string; conversationId: string }> = [];
  const connectorExecutions: Array<{ conversationId: string; adminId: string }> = [];
  const app = createApp(config, {
    processFollowUpWebhook: async (topic, conversationId) => {
      received.push({ topic, conversationId });
    },
    processDataConnectorExecution: async (conversationId, adminId) => {
      connectorExecutions.push({ conversationId, adminId });
    }
  });
  const supportedBody = JSON.stringify({
    topic: "conversation.user.replied",
    data: { item: { id: "conversation-1" } }
  });
  const unsupportedBody = JSON.stringify({
    topic: "conversation.priority.updated",
    data: { item: { id: "conversation-1" } }
  });
  const ticketBody = JSON.stringify({
    topic: "ticket.contact.replied",
    data: { item: { ticket_id: "ticket-1" } }
  });
  const connectorExecutionBody = JSON.stringify({
    topic: "data_connector.execution.completed",
    data: {
      item: {
        success: true,
        source_type: "inbox",
        conversation_id: "conversation-1",
        admin_id: "admin-1"
      }
    }
  });
  const failedConnectorExecutionBody = JSON.stringify({
    topic: "data_connector.execution.completed",
    data: {
      item: {
        success: false,
        source_type: "inbox",
        conversation_id: "conversation-1",
        admin_id: "admin-1"
      }
    }
  });
  const otherAgentConnectorExecutionBody = JSON.stringify({
    topic: "data_connector.execution.completed",
    data: {
      item: {
        success: true,
        source_type: "other",
        conversation_id: "conversation-1",
        admin_id: "admin-1"
      }
    }
  });

  await withServer(app, async (baseUrl) => {
    const head = await fetch(`${baseUrl}/intercom/webhook`, { method: "HEAD" });
    assert.equal(head.status, 200);

    const rejected = await fetch(`${baseUrl}/intercom/webhook`, {
      method: "POST",
      headers: webhookHeaders(supportedBody, "wrong-secret"),
      body: supportedBody
    });
    assert.equal(rejected.status, 401);

    const accepted = await fetch(`${baseUrl}/intercom/webhook`, {
      method: "POST",
      headers: webhookHeaders(supportedBody),
      body: supportedBody
    });
    assert.equal(accepted.status, 200);

    const ticketAccepted = await fetch(`${baseUrl}/intercom/webhook`, {
      method: "POST",
      headers: webhookHeaders(ticketBody),
      body: ticketBody
    });
    assert.equal(ticketAccepted.status, 200);

    const connectorExecutionAccepted = await fetch(`${baseUrl}/intercom/webhook`, {
      method: "POST",
      headers: webhookHeaders(connectorExecutionBody),
      body: connectorExecutionBody
    });
    assert.equal(connectorExecutionAccepted.status, 200);

    const failedConnectorExecution = await fetch(`${baseUrl}/intercom/webhook`, {
      method: "POST",
      headers: webhookHeaders(failedConnectorExecutionBody),
      body: failedConnectorExecutionBody
    });
    assert.equal(failedConnectorExecution.status, 200);

    const otherAgentConnectorExecution = await fetch(`${baseUrl}/intercom/webhook`, {
      method: "POST",
      headers: webhookHeaders(otherAgentConnectorExecutionBody),
      body: otherAgentConnectorExecutionBody
    });
    assert.equal(otherAgentConnectorExecution.status, 200);

    const malformedBody = "{not-json";
    const malformed = await fetch(`${baseUrl}/intercom/webhook`, {
      method: "POST",
      headers: webhookHeaders(malformedBody),
      body: malformedBody
    });
    assert.equal(malformed.status, 400);

    const ignored = await fetch(`${baseUrl}/intercom/webhook`, {
      method: "POST",
      headers: webhookHeaders(unsupportedBody),
      body: unsupportedBody
    });
    assert.equal(ignored.status, 204);
  });

  assert.deepEqual(received, [
    { topic: "conversation.user.replied", conversationId: "conversation-1" },
    { topic: "ticket.contact.replied", conversationId: "ticket-1" }
  ]);
  assert.deepEqual(connectorExecutions, [
    { conversationId: "conversation-1", adminId: "admin-1" },
    { conversationId: "conversation-1", adminId: "admin-1" }
  ]);
});
