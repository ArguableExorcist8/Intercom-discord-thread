import type { FollowUpRoutingTag } from "./types";
import { AppError } from "./utils";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return "";
}

function readStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (isRecord(item)) {
        return readString(item.name ?? item.id ?? item.value);
      }

      return readString(item);
    }).filter(Boolean);
  }

  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }

  if (isRecord(value)) {
    return readStringList(value.tags ?? value.data ?? value.values);
  }

  return [];
}

export function normalizeRoutingTags(...values: unknown[]): FollowUpRoutingTag[] {
  const routingTags = new Set<FollowUpRoutingTag>();

  for (const tag of values.flatMap(readStringList)) {
    const normalized = tag.toLowerCase().replace(/[^a-z0-9]/g, "");

    if (normalized.includes("urgent") || normalized.includes("critical")) {
      routingTags.add("urgent");
    } else if (
      normalized.includes("vip") ||
      normalized.includes("partner") ||
      normalized.includes("highvalue")
    ) {
      routingTags.add("vipPartner");
    } else if (
      normalized.includes("bugbounty") ||
      normalized.includes("bounty") ||
      normalized.includes("bug") ||
      normalized.includes("crash")
    ) {
      routingTags.add("bugBounty");
    } else if (normalized.includes("standard")) {
      routingTags.add("standard");
    }
  }

  return Array.from(routingTags);
}

export function parseIntercomTicketRequest(body: unknown): string {
  if (!isRecord(body)) {
    throw new AppError(400, "Invalid Intercom ticket payload.");
  }

  const keys = Object.keys(body);

  if (keys.length !== 1 || keys[0] !== "conversation_id") {
    throw new AppError(400, "Request body must contain only conversation_id.");
  }

  const conversationId = readString(body.conversation_id);

  if (!/^[A-Za-z0-9_-]{1,128}$/.test(conversationId)) {
    throw new AppError(400, "conversation_id is required.");
  }

  return conversationId;
}
