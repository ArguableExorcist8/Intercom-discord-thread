import type { Conversation, FollowUpRoutingTag } from "./types";

const ROUTING_TAG_ORDER: FollowUpRoutingTag[] = [
  "vipPartner",
  "urgent",
  "bugBounty",
  "standard"
];

function includesAny(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase();

  return terms.some((term) => lower.includes(term.toLowerCase()));
}

function getConversationText(conversation: Conversation): string {
  return conversation.messages.map((message) => message.text).join(" ");
}

function isUrgentIssue(text: string): boolean {
  const hasGlobalImpact = includesAny(text, [
    "entire site down",
    "site is down",
    "production down",
    "outage",
    "database outage",
    "rpc outage",
    "payment provider outage",
    "everyone cannot log in",
    "everyone can't log in",
    "all users cannot log in",
    "all users can't log in",
    "login broken for everyone",
    "deposits failing globally",
    "withdrawals failing globally",
    "matchmaking completely broken",
    "widespread reward duplication",
    "balances changing incorrectly",
    "bets resolving incorrectly"
  ]);
  const hasActiveSecurityImpact =
    includesAny(text, ["active exploit", "production exploit", "smart contract exploit", "authentication bypass", "account takeover"]) ||
    (includesAny(text, ["exploit", "vulnerability"]) &&
      includesAny(text, ["active", "draining", "funds being stolen", "funds stolen"]));

  return hasGlobalImpact || hasActiveSecurityImpact;
}

function isBugBountyIssue(text: string): boolean {
  return includesAny(text, [
    "bug bounty",
    "security researcher",
    "researcher",
    "vulnerability",
    "potential exploit",
    "exploit requiring verification",
    "bug report",
    "reported bug",
    "gameplay bug",
    "visual bug",
    "ui bug",
    "logic bug",
    "incorrect calculation",
    "api bug",
    "glitch",
    "crash"
  ]);
}

export function classifyFollowUpRoutingTags(conversation: Conversation): FollowUpRoutingTag[] {
  const explicitTags = new Set(conversation.routingTags);
  const text = getConversationText(conversation);
  const hasVipPartner = explicitTags.has("vipPartner") || conversation.playerLevel >= 50;
  const hasUrgent = explicitTags.has("urgent") || isUrgentIssue(text);
  const hasBugBounty = explicitTags.has("bugBounty") || isBugBountyIssue(text);
  const hasStandard = !hasUrgent && !hasBugBounty;
  const matches = new Set<FollowUpRoutingTag>();

  if (hasVipPartner) {
    matches.add("vipPartner");
  }

  if (hasUrgent) {
    matches.add("urgent");
  }

  if (hasBugBounty) {
    matches.add("bugBounty");
  }

  if (hasStandard) {
    matches.add("standard");
  }

  return ROUTING_TAG_ORDER.filter((tag) => matches.has(tag));
}
