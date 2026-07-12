import assert from "node:assert/strict";
import test from "node:test";
import { classifyFollowUpRoutingTags } from "../src/routing";
import type { Conversation } from "../src/types";

function ticket(message: string, level = 1, routingTags: Conversation["routingTags"] = []): Conversation {
  return {
    conversationId: "conversation-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    playerName: "Player",
    playerLevel: level,
    userId: "user-1",
    createdBy: "Agent",
    routingTags,
    messages: [{ role: "user", text: message, timestamp: "2026-01-01T00:00:00.000Z" }]
  };
}

test("VIP tickets retain Standard when no emergency or bug investigation applies", () => {
  assert.deepEqual(
    classifyFollowUpRoutingTags(ticket("My XP is missing.", 62)),
    ["vipPartner", "standard"]
  );
});

test("VIP tickets combine with urgent emergencies", () => {
  assert.deepEqual(
    classifyFollowUpRoutingTags(ticket("A partner reports a production exploit.", 62)),
    ["vipPartner", "urgent"]
  );
});

test("non-active security submissions are Bug Bounty only", () => {
  assert.deepEqual(
    classifyFollowUpRoutingTags(ticket("A security researcher submitted a SQL injection vulnerability.")),
    ["bugBounty"]
  );
});

test("active exploits receive both Bug Bounty and Urgent", () => {
  assert.deepEqual(
    classifyFollowUpRoutingTags(ticket("Researcher reports an active exploit draining funds.")),
    ["urgent", "bugBounty"]
  );
});

test("single-user login problems remain Standard", () => {
  assert.deepEqual(
    classifyFollowUpRoutingTags(ticket("I cannot log in to my account.")),
    ["standard"]
  );
});
