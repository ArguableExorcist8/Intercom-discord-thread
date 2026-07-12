export type SupportRole = "user" | "agent" | "system";
export type FollowUpRoutingTag =
  | "urgent"
  | "vipPartner"
  | "bugBounty"
  | "standard";
export type FollowUpRoutingBucket = FollowUpRoutingTag;

export interface SupportMessage {
  role: SupportRole;
  timestamp: string;
  text: string;
  authorName?: string;
}

export interface Conversation {
  conversationId: string;
  createdAt: string;
  playerName: string;
  playerLevel: number;
  userId: string;
  createdBy: string;
  routingTags: FollowUpRoutingTag[];
  messages: SupportMessage[];
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
