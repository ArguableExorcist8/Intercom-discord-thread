import type { Conversation, FollowUpSyncState, SupportMessage } from "./types";
import type { MaterialConversationUpdate } from "./summary";

export const FOLLOW_UP_WEBHOOK_TOPICS = [
  "conversation.user.replied",
  "conversation.admin.closed",
  "conversation.admin.opened",
  "ticket.contact.replied",
  "ticket.closed",
  "ticket.resolved",
  "ticket.state.updated"
] as const;

const TICKET_FOLLOW_UP_WEBHOOK_TOPICS = [
  "ticket.contact.replied",
  "ticket.closed",
  "ticket.resolved",
  "ticket.state.updated"
] as const;

export type FollowUpWebhookTopic = (typeof FOLLOW_UP_WEBHOOK_TOPICS)[number];
export type FollowUpSyncEvent = "customerReply" | "closed" | "opened";

export interface FollowUpSyncDependencies {
  fetchConversation: (conversationId: string) => Promise<Conversation>;
  updateState: (
    conversationId: string,
    update: {
      threadId?: string;
      lastSeenPartId?: string;
      status?: "open" | "closed";
    }
  ) => Promise<void>;
  classifyCustomerUpdate: (
    conversation: Conversation,
    newMessages: SupportMessage[],
    previousUpdate: string
  ) => Promise<MaterialConversationUpdate>;
  getLatestCustomerUpdate: (threadId: string) => Promise<string>;
  postCustomerUpdate: (threadId: string, update: MaterialConversationUpdate) => Promise<void>;
  closeThread: (threadId: string) => Promise<void>;
  reopenThread: (threadId: string) => Promise<void>;
}

export function isFollowUpWebhookTopic(value: string): value is FollowUpWebhookTopic {
  return FOLLOW_UP_WEBHOOK_TOPICS.includes(value as FollowUpWebhookTopic);
}

export function isTicketFollowUpWebhookTopic(value: string): boolean {
  return TICKET_FOLLOW_UP_WEBHOOK_TOPICS.includes(value as typeof TICKET_FOLLOW_UP_WEBHOOK_TOPICS[number]);
}

export function getFollowUpSyncEvent(
  topic: FollowUpWebhookTopic,
  state?: string
): FollowUpSyncEvent | null {
  if (topic === "conversation.user.replied" || topic === "ticket.contact.replied") {
    return "customerReply";
  }

  if (topic === "conversation.admin.closed" || topic === "ticket.closed" || topic === "ticket.resolved") {
    return "closed";
  }

  if (topic === "conversation.admin.opened") {
    return "opened";
  }

  if (topic === "ticket.state.updated") {
    return state === "closed" ? "closed" : "opened";
  }

  return null;
}

export function getLatestCustomerPartId(messages: SupportMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message.role === "user" && message.partId) {
      return message.partId;
    }
  }

  return "";
}

export function getUnseenCustomerMessages(
  messages: SupportMessage[],
  lastSeenPartId: string
): SupportMessage[] {
  const startIndex = lastSeenPartId
    ? messages.findIndex((message) => message.partId === lastSeenPartId)
    : -1;

  return messages
    .slice(startIndex + 1)
    .filter((message) => message.role === "user");
}

export async function processFollowUpWebhook(
  event: FollowUpSyncEvent,
  conversationId: string,
  dependencies: FollowUpSyncDependencies
): Promise<void> {
  const conversation = await dependencies.fetchConversation(conversationId);
  const state = conversation.followUpSync;

  if (!state?.threadId) {
    return;
  }

  if (event === "closed") {
    if (state.status !== "closed") {
      await dependencies.closeThread(state.threadId);
      await dependencies.updateState(conversationId, { status: "closed" });
    }

    return;
  }

  if (event === "opened") {
    if (state.status !== "open") {
      await dependencies.reopenThread(state.threadId);
      await dependencies.updateState(conversationId, { status: "open" });
    }

    return;
  }

  if (state.status === "closed") {
    await dependencies.reopenThread(state.threadId);
    await dependencies.updateState(conversationId, { status: "open" });
  }

  const newMessages = getUnseenCustomerMessages(conversation.messages, state.lastSeenPartId);

  if (newMessages.length === 0) {
    return;
  }

  const latestPartId = getLatestCustomerPartId(newMessages);

  if (!latestPartId) {
    throw new Error("Intercom customer update is missing a conversation-part ID.");
  }

  const previousUpdate = await dependencies.getLatestCustomerUpdate(state.threadId);
  const update = await dependencies.classifyCustomerUpdate(conversation, newMessages, previousUpdate);

  if (update.shouldPost) {
    await dependencies.postCustomerUpdate(state.threadId, update);
  }

  await dependencies.updateState(conversationId, { lastSeenPartId: latestPartId });
}
