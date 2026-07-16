import assert from "node:assert/strict";
import test from "node:test";
import { getIntercomAdmin, hydrateConversationFromIntercom, hydrateTicketFromIntercom } from "../src/intercomApi";

test("hydrates ticket replies through their linked conversation", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.INTERCOM_ACCESS_TOKEN;
  const originalVersion = process.env.INTERCOM_VERSION;
  const urls: string[] = [];
  process.env.INTERCOM_ACCESS_TOKEN = "test-token";
  process.env.INTERCOM_VERSION = "2.15";
  globalThis.fetch = (async (url) => {
    const value = String(url);
    urls.push(value);

    if (value.includes("/tickets/ticket-1")) {
      return new Response(JSON.stringify({
        id: "ticket-1",
        ticket_id: "display-ticket-1",
        open: true,
        created_at: 1_700_000_000,
        ticket_attributes: {
          discord_followup_thread_id: "123456789012345678",
          discord_followup_last_seen_part_id: "ticket-part-0",
          discord_followup_status: "open"
        },
        linked_objects: { data: [{ type: "conversation", id: "conversation-1" }] },
        ticket_parts: {
          ticket_parts: [
            {
              id: "ticket-part-1",
              body: "I also tried Metamask.",
              created_at: 1_700_000_001,
              author: { type: "user", name: "Player" }
            }
          ]
        }
      }), { status: 200 });
    }

    return new Response(JSON.stringify({
      id: "conversation-1",
      created_at: 1_700_000_000,
      state: "open",
      contacts: { contacts: [{ id: "user-1", name: "Player", custom_attributes: { level: 71 } }] },
      conversation_parts: { conversation_parts: [] }
    }), { status: 200 });
  }) as typeof fetch;

  try {
    const ticket = await hydrateTicketFromIntercom("ticket-1", 1_000);

    assert.equal(ticket?.conversationId, "conversation-1");
    assert.equal(ticket?.ticketId, "ticket-1");
    assert.equal(ticket?.ticketDisplayId, "display-ticket-1");
    assert.equal(ticket?.followUpSync?.threadId, "123456789012345678");
    assert.deepEqual(ticket?.messages.map((message) => [message.partId, message.text]), [
      ["ticket-part-1", "I also tried Metamask."]
    ]);
    assert.deepEqual(urls.map((url) => new URL(url).pathname), ["/tickets/ticket-1", "/conversations/conversation-1"]);
  } finally {
    globalThis.fetch = originalFetch;

    if (originalToken === undefined) {
      delete process.env.INTERCOM_ACCESS_TOKEN;
    } else {
      process.env.INTERCOM_ACCESS_TOKEN = originalToken;
    }

    if (originalVersion === undefined) {
      delete process.env.INTERCOM_VERSION;
    } else {
      process.env.INTERCOM_VERSION = originalVersion;
    }
  }
});

test("assigns the VIP/Partner route when Intercom's Partner contact attribute is true", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.INTERCOM_ACCESS_TOKEN;
  process.env.INTERCOM_ACCESS_TOKEN = "test-token";
  globalThis.fetch = (async (url) => {
    if (String(url).includes("/conversations/conversation-partner")) {
      return new Response(JSON.stringify({
        id: "conversation-partner",
        created_at: 1_700_000_000,
        state: "open",
        contacts: {
          contacts: [{
            id: "user-partner",
            name: "Partner player",
            custom_attributes: { Partner: true }
          }]
        },
        conversation_parts: { conversation_parts: [] }
      }), { status: 200 });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const conversation = await hydrateConversationFromIntercom("conversation-partner", 1_000);

    assert.deepEqual(conversation.routingTags, ["vipPartner"]);
  } finally {
    globalThis.fetch = originalFetch;

    if (originalToken === undefined) {
      delete process.env.INTERCOM_ACCESS_TOKEN;
    } else {
      process.env.INTERCOM_ACCESS_TOKEN = originalToken;
    }
  }
});

test("preserves an Intercom admin's display name and ID, with an ID fallback", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.INTERCOM_ACCESS_TOKEN;
  process.env.INTERCOM_ACCESS_TOKEN = "test-token";
  globalThis.fetch = (async (url) => {
    if (String(url).includes("/admins/admin-1")) {
      return new Response(JSON.stringify({ id: "admin-1", name: "Arg" }), { status: 200 });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    assert.deepEqual(await getIntercomAdmin("admin-1", 1_000), { id: "admin-1", name: "Arg" });
    assert.deepEqual(await getIntercomAdmin("admin-missing", 1_000), {
      id: "admin-missing",
      name: "admin-missing"
    });
  } finally {
    globalThis.fetch = originalFetch;

    if (originalToken === undefined) {
      delete process.env.INTERCOM_ACCESS_TOKEN;
    } else {
      process.env.INTERCOM_ACCESS_TOKEN = originalToken;
    }
  }
});
