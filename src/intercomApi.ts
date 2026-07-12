import { resolveCreatedByName } from "./people";
import { normalizeRoutingTags } from "./intercom";
import type { Conversation, SupportMessage, SupportRole } from "./types";
import { AppError, truncate } from "./utils";

type JsonRecord = Record<string, unknown>;

const INTERCOM_API_BASE_URL = "https://api.intercom.io";
const DEFAULT_INTERCOM_VERSION = "2.14";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return "";
}

function readNumber(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value.trim());

      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return 0;
}

function readBoolean(...values: unknown[]): boolean {
  return values.some((value) => {
    if (value === true) {
      return true;
    }

    return typeof value === "string" && ["true", "yes", "1", "partner", "vip"].includes(value.trim().toLowerCase());
  });
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readTimestamp(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 1_000_000_000_000 ? value * 1000 : value;

    return new Date(milliseconds).toISOString();
  }

  return fallback;
}

function readAuthorName(author: JsonRecord): string {
  return readString(
    author.name,
    author.display_name,
    author.full_name,
    author.email,
    author.id
  );
}

function normalizeRole(author: JsonRecord, fallback: unknown): SupportRole {
  const type = readString(author.type, fallback).toLowerCase();

  if (["admin", "teammate", "agent"].includes(type)) {
    return "agent";
  }

  if (["bot", "system", "operator"].includes(type)) {
    return "system";
  }

  return "user";
}

function readMessage(part: JsonRecord, fallbackTimestamp: string): SupportMessage | null {
  const author = isRecord(part.author) ? part.author : {};
  const text = stripHtml(
    readString(part.plain_text, part.plainText, part.body, part.text, part.message)
  );

  if (text.length === 0) {
    return null;
  }

  return {
    role: normalizeRole(author, part.author_type ?? part.type),
    text: truncate(text, 1800),
    timestamp: readTimestamp(part.created_at ?? part.updated_at, fallbackTimestamp),
    authorName: readAuthorName(author)
  };
}

function readConversationParts(raw: JsonRecord): JsonRecord[] {
  const parts = raw.conversation_parts;

  if (Array.isArray(parts)) {
    return parts.filter(isRecord);
  }

  if (isRecord(parts) && Array.isArray(parts.conversation_parts)) {
    return parts.conversation_parts.filter(isRecord);
  }

  return [];
}

function readMessages(raw: JsonRecord, fallbackTimestamp: string): SupportMessage[] {
  const source = isRecord(raw.source) ? readMessage(raw.source, fallbackTimestamp) : null;
  const partMessages = readConversationParts(raw)
    .map((part, index) => {
      const fallback = new Date(Date.now() + index).toISOString();

      return readMessage(part, fallback);
    })
    .filter((message): message is SupportMessage => message !== null);

  return source ? [source, ...partMessages] : partMessages;
}

function readContact(raw: JsonRecord): JsonRecord {
  const contacts = raw.contacts;

  if (isRecord(contacts) && Array.isArray(contacts.contacts)) {
    const firstContact = contacts.contacts.find(isRecord);

    if (firstContact) {
      return firstContact;
    }
  }

  return {};
}

function readSourceAuthor(raw: JsonRecord): JsonRecord {
  const source = isRecord(raw.source) ? raw.source : {};

  return isRecord(source.author) ? source.author : {};
}

function readPlayerName(raw: JsonRecord): string {
  const contact = readContact(raw);
  const sourceAuthor = readSourceAuthor(raw);

  return readString(
    contact.name,
    contact.email,
    sourceAuthor.name,
    sourceAuthor.email,
    "Unknown player"
  );
}

function readUserId(raw: JsonRecord): string {
  const contact = readContact(raw);
  const sourceAuthor = readSourceAuthor(raw);

  return readString(
    contact.external_id,
    contact.user_id,
    contact.id,
    sourceAuthor.external_id,
    sourceAuthor.user_id,
    sourceAuthor.id,
    "Unknown user"
  );
}

function readAssigneeId(raw: JsonRecord): string {
  const assignee = isRecord(raw.admin_assignee_id)
    ? raw.admin_assignee_id
    : isRecord(raw.assignee)
      ? raw.assignee
      : {};

  return readString(raw.admin_assignee_id, assignee.id, assignee.name);
}

function readPlayerLevel(raw: JsonRecord): number {
  const contact = readContact(raw);
  const customAttributes = isRecord(raw.custom_attributes) ? raw.custom_attributes : {};
  const contactAttributes = isRecord(contact.custom_attributes) ? contact.custom_attributes : {};
  const level = readNumber(
    contact.level,
    contact.player_level,
    contact.playerLevel,
    contactAttributes.level,
    contactAttributes.player_level,
    contactAttributes.playerLevel,
    customAttributes.level,
    customAttributes.player_level,
    customAttributes.playerLevel
  );

  return level;
}

function readRoutingTags(raw: JsonRecord): ReturnType<typeof normalizeRoutingTags> {
  const contact = readContact(raw);
  const contactAttributes = isRecord(contact.custom_attributes) ? contact.custom_attributes : {};
  const attributes = isRecord(raw.custom_attributes) ? raw.custom_attributes : {};
  const tags = normalizeRoutingTags(
    raw.tags,
    contact.tags,
    attributes.routing_tags,
    contactAttributes.routing_tags
  );

  if (readBoolean(contact.partner, attributes.partner, contactAttributes.partner) && !tags.includes("vipPartner")) {
    tags.push("vipPartner");
  }

  return tags;
}

async function fetchIntercomConversation(
  conversationId: string,
  timeoutMs: number
): Promise<JsonRecord> {
  const accessToken = process.env.INTERCOM_ACCESS_TOKEN?.trim();

  if (!accessToken) {
    throw new Error("INTERCOM_ACCESS_TOKEN is missing.");
  }

  const version = process.env.INTERCOM_VERSION?.trim() || DEFAULT_INTERCOM_VERSION;
  const url = new URL(`/conversations/${encodeURIComponent(conversationId)}`, INTERCOM_API_BASE_URL);

  url.searchParams.set("display_as", "plaintext");

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Intercom-Version": version
    },
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new AppError(500, "Internal server error.", "INTERCOM_FETCH_FAILED");
  }

  const payload = (await response.json()) as unknown;

  if (!isRecord(payload)) {
    throw new Error("Intercom conversation response was not an object.");
  }

  return payload;
}

export async function hydrateConversationFromIntercom(
  conversationId: string,
  timeoutMs: number
): Promise<Conversation> {
  try {
    const payload = await fetchIntercomConversation(conversationId, timeoutMs);
    const createdAt = readTimestamp(payload.created_at, new Date().toISOString());
    const messages = readMessages(payload, createdAt);
    const createdBy = readAssigneeId(payload);
    return {
      conversationId,
      createdAt,
      playerName: readPlayerName(payload),
      playerLevel: readPlayerLevel(payload),
      userId: readUserId(payload),
      createdBy: resolveCreatedByName(createdBy),
      routingTags: readRoutingTags(payload),
      messages: messages.length > 0
        ? messages
        : [{ role: "user", text: `Intercom conversation ${conversationId} needs follow-up.`, timestamp: createdAt }]
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(500, "Internal server error.", "INTERCOM_FETCH_FAILED");
  }
}
