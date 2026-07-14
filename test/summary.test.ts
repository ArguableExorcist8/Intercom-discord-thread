import assert from "node:assert/strict";
import test from "node:test";
import { generateMaterialConversationUpdate, generateSummary } from "../src/summary";
import type { Conversation } from "../src/types";

const conversation: Conversation = {
  conversationId: "conversation-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  playerName: "Player",
  playerLevel: 1,
  userId: "user-1",
  createdBy: "Agent",
  routingTags: [],
  messages: [{ role: "user", text: "My reward is missing.", timestamp: "2026-01-01T00:00:00.000Z" }]
};

test("retries a valid but incomplete DeepSeek JSON response", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  const originalModel = process.env.DEEPSEEK_MODEL;
  const requestBodies: Array<Record<string, unknown>> = [];
  let calls = 0;

  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.DEEPSEEK_MODEL = "deepseek-v4-flash";
  globalThis.fetch = (async (_url, init) => {
    calls += 1;
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const content = calls === 1
      ? JSON.stringify({ topic: "Missing reward", problem: "A reward is missing.", category: "Rewards", developerRequired: false, confidence: 0.9 })
      : JSON.stringify({ topic: "Missing reward", problem: "A reward is missing.", request: "Restore the reward.", recommendedSolution: "Check the reward grant and restore it if needed.", category: "Rewards", developerRequired: false, confidence: 0.9 });

    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as typeof fetch;

  try {
    const summary = await generateSummary(conversation, 1_000);

    assert.equal(calls, 2);
    assert.equal(summary.recommendedSolution, "Check the reward grant and restore it if needed.");
    assert.deepEqual(requestBodies[0].thinking, { type: "disabled" });
  } finally {
    globalThis.fetch = originalFetch;

    if (originalKey === undefined) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = originalKey;
    }

    if (originalModel === undefined) {
      delete process.env.DEEPSEEK_MODEL;
    } else {
      process.env.DEEPSEEK_MODEL = originalModel;
    }
  }
});

test("returns a material update decision from DeepSeek", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ shouldPost: true, delta: "Customer provided game ID game-123.", relatedToPreviousUpdate: false }) } }]
  }), { status: 200 })) as typeof fetch;

  try {
    const update = await generateMaterialConversationUpdate(
      conversation,
      [{ partId: "part-2", role: "user", text: "The game ID is game-123.", timestamp: "2026-01-01T00:01:00.000Z" }],
      1_000
    );

    assert.deepEqual(update, {
      shouldPost: true,
      delta: "Customer provided game ID game-123.",
      relatedToPreviousUpdate: false
    });
  } finally {
    globalThis.fetch = originalFetch;

    if (originalKey === undefined) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = originalKey;
    }
  }
});
