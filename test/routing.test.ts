import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRoutingTags } from "../src/intercom";
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

test("RugPass completion support requests remain Standard, even when caused by a bug", () => {
  assert.deepEqual(
    classifyFollowUpRoutingTags(ticket("I hit the 5x target, but my RugPass challenge is not completing. Please credit it.")),
    ["standard"]
  );
});

test("VIP account-specific bug reports retain Standard", () => {
  assert.deepEqual(
    classifyFollowUpRoutingTags(ticket("My XP was not credited after a gameplay bug. Please fix this for me.", 71)),
    ["vipPartner", "standard"]
  );
});

test("technical security findings with disclosure intent are Bug Bounty", () => {
  assert.deepEqual(
    classifyFollowUpRoutingTags(ticket("I found an authentication bypass and would like to submit this for review.")),
    ["bugBounty"]
  );
});

test("ordinary Intercom bug and crash labels do not force Bug Bounty", () => {
  assert.deepEqual(normalizeRoutingTags("Gameplay Bug", "Crash Report"), []);
  assert.deepEqual(normalizeRoutingTags("Bug Bounty"), ["bugBounty"]);
});
