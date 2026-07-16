import type { FollowUpRoutingTag } from "./types";
import { AppError } from "./utils";

type JsonRecord = Record<string, unknown>;

export interface IntercomTicketRequest {
  conversationId?: string;
  ticketId?: string;
  playerLevel?: number;
  partnerStatus?: boolean;
}

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

function readBoolean(value: unknown): boolean | undefined {
  if (value === true || value === false) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (normalized === "true") {
      return true;
    }

    if (normalized === "false") {
      return false;
    }
  }

  return undefined;
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
      normalized.includes("bounty")
    ) {
      routingTags.add("bugBounty");
    } else if (normalized.includes("standard")) {
      routingTags.add("standard");
    }
  }

  return Array.from(routingTags);
}

export function parseIntercomTicketRequest(body: unknown): IntercomTicketRequest {
  if (!isRecord(body)) {
    throw new AppError(400, "Invalid Intercom ticket payload.");
  }

  const keys = Object.keys(body);

  if (
    keys.length === 0 ||
    keys.some((key) => key !== "conversation_id" && key !== "ticket_id" && key !== "player_level" && key !== "partner_status")
  ) {
    throw new AppError(400, "Request body may contain only ticket_id, conversation_id, player_level, and partner_status.");
  }

  const conversationId = readString(body.conversation_id);
  const ticketId = readString(body.ticket_id);

  if (ticketId && !/^[A-Za-z0-9_-]{1,128}$/.test(ticketId)) {
    throw new AppError(400, "ticket_id is invalid.");
  }

  if (conversationId && !/^[A-Za-z0-9_-]{1,128}$/.test(conversationId)) {
    throw new AppError(400, "conversation_id is invalid.");
  }

  if (!ticketId && !conversationId) {
    throw new AppError(400, "ticket_id is required.");
  }

  let playerLevel: number | undefined;

  if (body.player_level !== undefined && body.player_level !== null && body.player_level !== "") {
    playerLevel = typeof body.player_level === "number"
      ? body.player_level
      : typeof body.player_level === "string"
        ? Number(body.player_level.trim())
        : Number.NaN;

    if (!Number.isFinite(playerLevel) || playerLevel < 0 || playerLevel > 1_000_000) {
      throw new AppError(400, "player_level must be a non-negative number.");
    }
  }

  const hasPartnerStatus = body.partner_status !== undefined && body.partner_status !== null && body.partner_status !== "";
  const partnerStatus = hasPartnerStatus ? readBoolean(body.partner_status) : undefined;

  if (hasPartnerStatus && partnerStatus === undefined) {
    throw new AppError(400, "partner_status must be true or false.");
  }

  const overrides = {
    ...(playerLevel === undefined ? {} : { playerLevel }),
    ...(partnerStatus === undefined ? {} : { partnerStatus })
  };

  return ticketId
    ? { ticketId, ...(conversationId ? { conversationId } : {}), ...overrides }
    : { conversationId, ...overrides };
}
