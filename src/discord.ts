import { ChannelType, ForumChannel } from "discord.js";

import { getDiscordClient, getDiscordState } from "./bot";
import { getFollowUpConfig } from "./config";
import { buildRoutingHandoffMessage, resolveAgentHandoff } from "./people";
import { classifyFollowUpRoutingTags } from "./routing";

import type {
  Conversation,
  ConversationSummary,
  DiscordThreadResult,
  FollowUpRoutingTag
} from "./types";

import {
  AppError,
  buildFollowUpThreadName,
  buildIntercomConversationUrl,
  buildTicketEmbed,
  createEmbed
} from "./utils";

function assertBotReady(): void {
  const state = getDiscordState();

  if (!state.tokenConfigured) {
    throw new AppError(500, "Missing DISCORD_TOKEN.");
  }

  if (!state.ready) {
    throw new AppError(
      503,
      state.lastError ?? "Discord bot is not logged in yet.",
      "DISCORD_NOT_READY"
    );
  }
}

function assertFollowUpConfig(): void {
  const followUpConfig = getFollowUpConfig();

  if (!followUpConfig.channelId) {
    throw new AppError(500, "Missing FOLLOWUP_CHANNEL_ID.");
  }

  const missingTagIds = Object.entries(followUpConfig.routingTagIds)
    .filter(([, value]) => value.length === 0)
    .map(([key]) => key);

  if (missingTagIds.length > 0) {
    throw new AppError(
      500,
      `Missing follow-up tag IDs for: ${missingTagIds.join(", ")}.`
    );
  }
}

function resolveAppliedTagIds(routingTags: FollowUpRoutingTag[]): string[] {
  const followUpConfig = getFollowUpConfig();

  return routingTags.map((tag) => {
    const tagId = followUpConfig.routingTagIds[tag];

    if (!tagId) {
      throw new AppError(500, "Internal server error.", "DISCORD_TAG_NOT_CONFIGURED");
    }

    return tagId;
  });
}

export async function createFollowUpThread(
  conversation: Conversation,
  summary: ConversationSummary
): Promise<DiscordThreadResult> {
  assertBotReady();
  assertFollowUpConfig();

  const client = getDiscordClient();
  const channelId = getFollowUpConfig().channelId;
  const fetched = await client.channels.fetch(channelId);

  if (!fetched) {
    throw new AppError(404, "Discord follow-up channel not found.");
  }

  if (fetched.type !== ChannelType.GuildForum) {
    throw new AppError(
      400,
      `FOLLOWUP_CHANNEL_ID must point to a forum channel, got ${fetched.type}.`
    );
  }

  const forum = fetched as ForumChannel;
  const embed = createEmbed(conversation, summary);
  const threadName = buildFollowUpThreadName(conversation, summary);
  const routingTags = classifyFollowUpRoutingTags(conversation);
  const appliedTags = resolveAppliedTagIds(routingTags);

  const thread = await forum.threads.create({
    name: threadName,
    appliedTags,
    message: {
      embeds: [embed]
    },
    reason: "Intercom Follow-up Prototype"
  });

  await thread.send(resolveAgentHandoff(conversation.createdBy));

  await thread.send(buildRoutingHandoffMessage(routingTags));

  const threadUrl = `https://discord.com/channels/${thread.guildId}/${thread.parentId}/${thread.id}`;
  const ticketUrl = buildIntercomConversationUrl(conversation.conversationId);

  await thread.send({
    embeds: [buildTicketEmbed(ticketUrl)]
  });

  return {
    threadId: thread.id,
    threadUrl
  };
}
