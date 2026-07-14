import assert from "node:assert/strict";
import test from "node:test";
import { processFollowUpWebhook } from "../src/followUpSync";
import type { Conversation } from "../src/types";

function conversation(lastSeenPartId = "part-1", status: "open" | "closed" | "" = "open"): Conversation {
  return {
    conversationId: "conversation-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    playerName: "Player",
    playerLevel: 1,
    userId: "user-1",
    createdBy: "Agent",
    routingTags: [],
    followUpSync: { threadId: "thread-1", lastSeenPartId, status },
    messages: [
      { partId: "part-1", role: "user", text: "My reward is missing.", timestamp: "2026-01-01T00:00:00.000Z" },
      { partId: "part-2", role: "agent", text: "Please share the game ID.", timestamp: "2026-01-01T00:01:00.000Z" },
      { partId: "part-3", role: "user", text: "The game ID is game-123.", timestamp: "2026-01-01T00:02:00.000Z" }
    ]
  };
}

test("material customer updates post one delta and advance the seen part marker", async () => {
  const updates: Array<Record<string, string>> = [];
  const posts: string[] = [];

  await processFollowUpWebhook("customerReply", "conversation-1", {
    fetchConversation: async () => conversation(),
    updateState: async (_id, update) => updates.push(update as Record<string, string>),
    classifyCustomerUpdate: async (_ticket, messages) => {
      assert.deepEqual(messages.map((message) => message.partId), ["part-3"]);
      return {
        shouldPost: true,
        delta: "Customer supplied game ID game-123 for the missing reward.",
        relatedToPreviousUpdate: false
      };
    },
    getLatestCustomerUpdate: async () => "",
    postCustomerUpdate: async (_threadId, update) => posts.push(update.delta),
    closeThread: async () => assert.fail("close should not run"),
    reopenThread: async () => assert.fail("reopen should not run")
  });

  assert.deepEqual(posts, ["Customer supplied game ID game-123 for the missing reward."]);
  assert.deepEqual(updates, [{ lastSeenPartId: "part-3" }]);
});

test("non-material customer updates advance the marker without posting", async () => {
  const updates: Array<Record<string, string>> = [];

  await processFollowUpWebhook("customerReply", "conversation-1", {
    fetchConversation: async () => conversation(),
    updateState: async (_id, update) => updates.push(update as Record<string, string>),
    classifyCustomerUpdate: async () => ({ shouldPost: false, delta: "", relatedToPreviousUpdate: false }),
    getLatestCustomerUpdate: async () => "",
    postCustomerUpdate: async () => assert.fail("non-material update should not post"),
    closeThread: async () => assert.fail("close should not run"),
    reopenThread: async () => assert.fail("reopen should not run")
  });

  assert.deepEqual(updates, [{ lastSeenPartId: "part-3" }]);
});

test("close and reopen events only change threads when their state changes", async () => {
  const events: string[] = [];
  let current = conversation("part-3", "open");
  const dependencies = {
    fetchConversation: async () => current,
    updateState: async (_id: string, update: { status?: "open" | "closed" }) => {
      events.push(`state:${update.status}`);
      current = { ...current, followUpSync: { ...current.followUpSync!, status: update.status ?? "" } };
    },
    classifyCustomerUpdate: async () => ({ shouldPost: false, delta: "", relatedToPreviousUpdate: false }),
    getLatestCustomerUpdate: async () => "",
    postCustomerUpdate: async () => assert.fail("customer update should not post"),
    closeThread: async () => events.push("close"),
    reopenThread: async () => events.push("reopen")
  };

  await processFollowUpWebhook("closed", "conversation-1", dependencies);
  await processFollowUpWebhook("closed", "conversation-1", dependencies);
  await processFollowUpWebhook("opened", "conversation-1", dependencies);
  await processFollowUpWebhook("opened", "conversation-1", dependencies);

  assert.deepEqual(events, ["close", "state:closed", "reopen", "state:open"]);
});
