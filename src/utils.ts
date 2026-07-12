import { EmbedBuilder } from "discord.js";
import type { Conversation, ConversationSummary } from "./types";

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(statusCode: number, message: string, code = "APP_ERROR") {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function logEvent(
  level: "info" | "warn" | "error",
  event: string,
  details: Record<string, string | number | boolean> = {}
): void {
  // Keep logs structured and intentionally limited to non-sensitive operational data.
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details });

  if (level === "error") {
    console.error(entry);
    return;
  }

  if (level === "warn") {
    console.warn(entry);
    return;
  }

  console.log(entry);
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function clampFieldValue(value: string, maxLength = 1024): string {
  return truncate(value, maxLength);
}

function formatDiscordTimestamp(timestamp: string): string {
  const date = new Date(timestamp);

  if (Number.isNaN(date.getTime())) {
    return clampFieldValue(timestamp);
  }

  return `<t:${Math.floor(date.getTime() / 1000)}:f>`;
}

export function buildFollowUpThreadName(
  conversation: Conversation,
  summary: ConversationSummary
): string {
  const issue = summary.topic.replace(/[.?!]+$/, "").trim();
  const baseName =
    issue.length > 0
      ? `${issue} - ${conversation.playerName}`
      : `Follow-up - ${conversation.playerName}`;

  return truncate(baseName, 100);
}

export function buildIntercomConversationUrl(conversationId: string): string {
  return `https://app.intercom.com/a/inbox/d0omojfl/inbox/shared/all/conversation/${encodeURIComponent(conversationId)}?view=List`;
}

export function buildTicketEmbed(ticketUrl: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Ticket")
    .setURL(ticketUrl);
}

export function createEmbed(
  conversation: Conversation,
  summary: ConversationSummary
): EmbedBuilder {
  const createdAtDate = new Date(conversation.createdAt);
  const timestampDate = Number.isNaN(createdAtDate.getTime())
    ? new Date()
    : createdAtDate;

  return new EmbedBuilder()
    .setColor(0x2f80ed)
    .setTitle("Follow-up Required")
    .addFields(
      { name: "Player Name", value: clampFieldValue(conversation.playerName), inline: true },
      {
        name: "Player Level",
        value: clampFieldValue(String(conversation.playerLevel)),
        inline: true
      },
      { name: "User ID", value: clampFieldValue(conversation.userId), inline: true },
      {
        name: "Conversation ID",
        value: clampFieldValue(conversation.conversationId),
        inline: true
      },
      {
        name: "Messages Sent",
        value: clampFieldValue(String(conversation.messages.length)),
        inline: true
      },
      { name: "Topic", value: clampFieldValue(summary.topic), inline: false },
      {
        name: "Created At",
        value: formatDiscordTimestamp(conversation.createdAt),
        inline: true
      },
      { name: "Problem", value: clampFieldValue(summary.problem), inline: false },
      { name: "Request", value: clampFieldValue(summary.request), inline: false },
      {
        name: "Recommended Solution",
        value: clampFieldValue(summary.recommendedSolution),
        inline: false
      },
      { name: "Priority", value: clampFieldValue(summary.priority), inline: true },
      { name: "Category", value: clampFieldValue(summary.category), inline: true }
    )
    .setFooter({ text: "Ticket created in Intercom" })
    .setTimestamp(timestampDate);
}
