export type SupportRole = "user" | "agent" | "system";
export type FollowUpRoutingTag =
  | "urgent"
  | "vipPartner"
  | "bugBounty"
  | "standard";
export type FollowUpRoutingBucket = FollowUpRoutingTag;

export interface SupportMessage {
  partId?: string;
  role: SupportRole;
  timestamp: string;
  text: string;
  authorName?: string;
}

export interface FollowUpSyncState {
  threadId: string;
  lastSeenPartId: string;
  status: "open" | "closed" | "";
}

export interface Conversation {
  conversationId: string;
  ticketId?: string;
  ticketDisplayId?: string;
  createdAt: string;
  playerName: string;
  playerLevel: number;
  userId: string;
  createdBy: string;
  routingTags: FollowUpRoutingTag[];
  messages: SupportMessage[];
  state?: string;
  followUpSync?: FollowUpSyncState;
}

export type Priority = "Low" | "Medium" | "High" | "Urgent";

export interface ConversationSummary {
  topic: string;
  problem: string;
  request: string;
  recommendedSolution: string;
  category: string;
  priority: Priority;
  developerRequired: boolean;
  confidence: number;
}

export interface DiscordThreadResult {
  threadId: string;
  threadUrl: string;
}

export interface DiscordServiceState {
  tokenConfigured: boolean;
  ready: boolean;
  lastError: string | null;
}

export interface FollowUpConfig {
  channelId: string;
  routingTagIds: Record<FollowUpRoutingTag, string>;
}
