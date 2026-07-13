import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp } from "../src/server";
import type { RuntimeConfig } from "../src/config";
import type { Conversation } from "../src/types";

const config: RuntimeConfig = {
  port: 3000,
  connectorSecret: "test-connector-secret",
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

test("ticket endpoint accepts Bearer authentication, applies player_level, and rejects unknown fields", async () => {
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
      body: JSON.stringify({ conversation_id: "conversation-1", player_level: "68" })
    });

    assert.equal(validResponse.status, 200);
    assert.equal(processedConversation?.playerLevel, 68);

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
