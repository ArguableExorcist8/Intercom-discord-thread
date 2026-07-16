import { resolveCreatedByName } from "./people";
import { normalizeRoutingTags } from "./intercom";
import type { Conversation, FollowUpSyncState, SupportMessage, SupportRole } from "./types";
import { AppError, truncate } from "./utils";

type JsonRecord = Record<string, unknown>;

const INTERCOM_API_BASE_URL = "https://api.intercom.io";
const DEFAULT_INTERCOM_VERSION = "2.14";

export const FOLLOW_UP_THREAD_ID_ATTRIBUTE = "discord_followup_thread_id";
export const FOLLOW_UP_LAST_SEEN_PART_ID_ATTRIBUTE = "discord_followup_last_seen_part_id";
export const FOLLOW_UP_STATUS_ATTRIBUTE = "discord_followup_status";

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

function readAttribute(record: JsonRecord, attributeName: string): unknown {
  const normalizedAttributeName = attributeName.trim().toLowerCase();

  for (const [key, value] of Object.entries(record)) {
    if (key.trim().toLowerCase() === normalizedAttributeName) {
      return value;
    }
  }

  return undefined;
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

function readAttachmentLabels(part: JsonRecord): string[] {
  const attachments = part.attachments;

  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .filter(isRecord)
    .map((attachment) => readString(attachment.name, attachment.filename, attachment.content_type, "attachment"))
    .filter(Boolean)
    .slice(0, 10);
}

function readMessage(part: JsonRecord, fallbackTimestamp: string): SupportMessage | null {
  const author = isRecord(part.author) ? part.author : {};
  const messageText = stripHtml(
    readString(part.plain_text, part.plainText, part.body, part.text, part.message)
  );
  const attachmentLabels = readAttachmentLabels(part);
  const text = [
    messageText,
    ...(attachmentLabels.length > 0 ? [`Attachments: ${attachmentLabels.join(", ")}`] : [])
  ].filter(Boolean).join("\n");

  if (text.length === 0) {
    return null;
  }

  return {
    partId: readString(part.id),
    role: normalizeRole(author, part.author_type ?? part.type),
    text: truncate(text, 1800),
    timestamp: readTimestamp(part.created_at ?? part.updated_at, fallbackTimestamp),
    authorName: readAuthorName(author)
  };
}

function readFollowUpSyncState(raw: JsonRecord): FollowUpSyncState | undefined {
  const attributes = isRecord(raw.ticket_attributes)
    ? raw.ticket_attributes
    : isRecord(raw.custom_attributes)
      ? raw.custom_attributes
      : {};
  const threadId = readString(attributes[FOLLOW_UP_THREAD_ID_ATTRIBUTE]);

  if (!threadId) {
    return undefined;
  }

  const status = readString(attributes[FOLLOW_UP_STATUS_ATTRIBUTE]).toLowerCase();

  return {
    threadId,
    lastSeenPartId: readString(attributes[FOLLOW_UP_LAST_SEEN_PART_ID_ATTRIBUTE]),
    status: status === "closed" ? "closed" : status === "open" ? "open" : ""
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

function readTicketParts(raw: JsonRecord): JsonRecord[] {
  const parts = raw.ticket_parts;

  if (Array.isArray(parts)) {
    return parts.filter(isRecord);
  }

  if (isRecord(parts) && Array.isArray(parts.ticket_parts)) {
    return parts.ticket_parts.filter(isRecord);
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

function readTicketMessages(raw: JsonRecord, fallbackTimestamp: string): SupportMessage[] {
  return readTicketParts(raw)
    .map((part, index) => readMessage(part, new Date(Date.now() + index).toISOString()))
    .filter((message): message is SupportMessage => message !== null);
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

  return readString(assignee.name, raw.admin_assignee_id, assignee.id);
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

  if (
    readBoolean(
      readAttribute(contact, "partner"),
      readAttribute(attributes, "partner"),
      readAttribute(contactAttributes, "partner")
    ) &&
    !tags.includes("vipPartner")
  ) {
    tags.push("vipPartner");
  }

  return tags;
}

export interface FollowUpSyncStateUpdate {
  threadId?: string;
  lastSeenPartId?: string;
  status?: "open" | "closed";
}

export async function updateFollowUpSyncState(
  conversationId: string,
  update: FollowUpSyncStateUpdate,
  timeoutMs: number
): Promise<void> {
  const accessToken = process.env.INTERCOM_ACCESS_TOKEN?.trim();

  if (!accessToken) {
    throw new Error("INTERCOM_ACCESS_TOKEN is missing.");
  }

  const customAttributes: Record<string, string> = {};

  if (update.threadId !== undefined) {
    customAttributes[FOLLOW_UP_THREAD_ID_ATTRIBUTE] = update.threadId;
  }

  if (update.lastSeenPartId !== undefined) {
    customAttributes[FOLLOW_UP_LAST_SEEN_PART_ID_ATTRIBUTE] = update.lastSeenPartId;
  }

  if (update.status !== undefined) {
    customAttributes[FOLLOW_UP_STATUS_ATTRIBUTE] = update.status;
  }

  if (Object.keys(customAttributes).length === 0) {
    return;
  }

  const version = process.env.INTERCOM_VERSION?.trim() || DEFAULT_INTERCOM_VERSION;
  const url = new URL(`/conversations/${encodeURIComponent(conversationId)}`, INTERCOM_API_BASE_URL);
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Intercom-Version": version
    },
    body: JSON.stringify({ custom_attributes: customAttributes }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new AppError(500, "Internal server error.", "INTERCOM_SYNC_STATE_UPDATE_FAILED");
  }
}

export async function updateFollowUpTicketSyncState(
  ticketId: string,
  update: FollowUpSyncStateUpdate,
  timeoutMs: number
): Promise<void> {
  const accessToken = process.env.INTERCOM_ACCESS_TOKEN?.trim();

  if (!accessToken) {
    throw new Error("INTERCOM_ACCESS_TOKEN is missing.");
  }

  const ticket = await fetchIntercomResource(`/tickets/${encodeURIComponent(ticketId)}`, timeoutMs);
  const ticketAttributes: Record<string, unknown> = isRecord(ticket.ticket_attributes)
    ? { ...ticket.ticket_attributes }
    : {};

  if (update.threadId !== undefined) {
    ticketAttributes[FOLLOW_UP_THREAD_ID_ATTRIBUTE] = update.threadId;
  }

  if (update.lastSeenPartId !== undefined) {
    ticketAttributes[FOLLOW_UP_LAST_SEEN_PART_ID_ATTRIBUTE] = update.lastSeenPartId;
  }

  if (update.status !== undefined) {
    ticketAttributes[FOLLOW_UP_STATUS_ATTRIBUTE] = update.status;
  }

  const version = process.env.INTERCOM_VERSION?.trim() || DEFAULT_INTERCOM_VERSION;
  const response = await fetch(new URL(`/tickets/${encodeURIComponent(ticketId)}`, INTERCOM_API_BASE_URL), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Intercom-Version": version
    },
    body: JSON.stringify({ ticket_attributes: ticketAttributes }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new AppError(500, "Internal server error.", "INTERCOM_TICKET_SYNC_STATE_UPDATE_FAILED");
  }
}

async function fetchIntercomResource(
  path: string,
  timeoutMs: number
): Promise<JsonRecord> {
  const accessToken = process.env.INTERCOM_ACCESS_TOKEN?.trim();

  if (!accessToken) {
    throw new Error("INTERCOM_ACCESS_TOKEN is missing.");
  }

  const version = process.env.INTERCOM_VERSION?.trim() || DEFAULT_INTERCOM_VERSION;
  const url = new URL(path, INTERCOM_API_BASE_URL);
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
    throw new Error("Intercom API response was not an object.");
  }

  return payload;
}

export interface IntercomAdmin {
  id: string;
  name: string;
}

export async function getIntercomAdmin(adminId: string, timeoutMs: number): Promise<IntercomAdmin> {
  try {
    const admin = await fetchIntercomResource(`/admins/${encodeURIComponent(adminId)}`, timeoutMs);

    return {
      id: adminId,
      name: readString(admin.name, admin.email, adminId)
    };
  } catch {
    return { id: adminId, name: adminId };
  }
}

async function fetchIntercomConversation(
  conversationId: string,
  timeoutMs: number
): Promise<JsonRecord> {
  const url = new URL(`/conversations/${encodeURIComponent(conversationId)}`, INTERCOM_API_BASE_URL);

  url.searchParams.set("display_as", "plaintext");
  return fetchIntercomResource(`${url.pathname}${url.search}`, timeoutMs);
}

function readLinkedConversationId(ticket: JsonRecord, fallbackConversationId = ""): string {
  const linkedObjects = isRecord(ticket.linked_objects) ? ticket.linked_objects : {};
  const linkedData = Array.isArray(linkedObjects.data) ? linkedObjects.data : [];

  for (const linked of linkedData) {
    if (!isRecord(linked)) {
      continue;
    }

    const type = readString(linked.type, linked.object).toLowerCase();

    if (type === "conversation") {
      return readString(linked.id, linked.conversation_id);
    }

    const nestedConversation = isRecord(linked.conversation) ? linked.conversation : {};
    const nestedId = readString(nestedConversation.id, linked.conversation_id);

    if (nestedId) {
      return nestedId;
    }
  }

  return readString(ticket.conversation_id, fallbackConversationId);
}

function buildConversation(
  raw: JsonRecord,
  conversationId: string,
  messages: SupportMessage[]
): Conversation {
  const createdAt = readTimestamp(raw.created_at, new Date().toISOString());
  const createdBy = readAssigneeId(raw);

  return {
    conversationId,
    createdAt,
    playerName: readPlayerName(raw),
    playerLevel: readPlayerLevel(raw),
    userId: readUserId(raw),
    createdBy: resolveCreatedByName(createdBy),
    routingTags: readRoutingTags(raw),
    state: readString(raw.state),
    followUpSync: readFollowUpSyncState(raw),
    messages: messages.length > 0
      ? messages
      : [{ role: "user", text: `Intercom conversation ${conversationId} needs follow-up.`, timestamp: createdAt }]
  };
}

export async function hydrateConversationFromIntercom(
  conversationId: string,
  timeoutMs: number
): Promise<Conversation> {
  try {
    const payload = await fetchIntercomConversation(conversationId, timeoutMs);
    const createdAt = readTimestamp(payload.created_at, new Date().toISOString());
    return buildConversation(payload, conversationId, readMessages(payload, createdAt));
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(500, "Internal server error.", "INTERCOM_FETCH_FAILED");
  }
}

export async function hydrateTicketFromIntercom(
  ticketId: string,
  timeoutMs: number,
  fallbackConversationId = ""
): Promise<Conversation | null> {
  try {
    const ticket = await fetchIntercomResource(`/tickets/${encodeURIComponent(ticketId)}`, timeoutMs);
    const conversationId = readLinkedConversationId(ticket, fallbackConversationId);

    if (!conversationId) {
      return null;
    }

    const conversation = await fetchIntercomConversation(conversationId, timeoutMs);
    const ticketCreatedAt = readTimestamp(ticket.created_at, new Date().toISOString());
    const hydrated = buildConversation(
      conversation,
      conversationId,
      readTicketMessages(ticket, ticketCreatedAt)
    );

    return {
      ...hydrated,
      ticketId: readString(ticket.id, ticketId),
      ticketDisplayId: readString(ticket.ticket_id),
      followUpSync: readFollowUpSyncState(ticket),
      state: readBoolean(ticket.open) ? "open" : "closed"
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(500, "Internal server error.", "INTERCOM_TICKET_FETCH_FAILED");
  }
}
