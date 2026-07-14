import { ChannelType, EmbedBuilder, ForumChannel } from "discord.js";

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
import type { MaterialConversationUpdate } from "./summary";

import {
  AppError,
  buildFollowUpThreadName,
  buildIntercomConversationUrl,
  createEmbed,
  truncate
} from "./utils";

const USER_TICKET_UPDATE_TITLE = "User ticket update";

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
  const ticketUrl = buildIntercomConversationUrl(conversation.conversationId);
  const embed = createEmbed(conversation, summary, ticketUrl);
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

  const routingHandoff = buildRoutingHandoffMessage(routingTags);
  const createdByText = "Created by Intercom";
  const routingEmbed = (description: string) => new EmbedBuilder()
    .setColor(0x2f80ed)
    .setDescription(description);
  const routingMessage = {
    embeds: [routingEmbed(createdByText)]
  };

  if (routingHandoff.allowedMentions.users.length > 0) {
    await thread.send(routingMessage);
    await thread.send(routingHandoff);
  } else {
    await thread.send({
      ...routingMessage,
      embeds: [routingEmbed(`${createdByText}\n\n${routingHandoff.content}`)]
    });
  }

  const threadUrl = `https://discord.com/channels/${thread.guildId}/${thread.parentId}/${thread.id}`;

  return {
    threadId: thread.id,
    threadUrl
  };
}

async function fetchFollowUpThread(threadId: string) {
  assertBotReady();
  const thread = await getDiscordClient().channels.fetch(threadId);

  if (!thread || !thread.isThread()) {
    throw new AppError(404, "Discord follow-up thread not found.", "DISCORD_THREAD_NOT_FOUND");
  }

  return thread;
}

function buildUserTicketUpdateEmbed(description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x2f80ed)
    .setTitle(USER_TICKET_UPDATE_TITLE)
    .setDescription(truncate(description, 4096));
}

async function findLatestUserTicketUpdate(threadId: string) {
  const thread = await fetchFollowUpThread(threadId);
  const messages = await thread.messages.fetch({ limit: 100 });
  const botId = getDiscordClient().user?.id;

  const message = Array.from(messages.values())
    .filter((candidate) =>
      (!botId || candidate.author.id === botId) &&
      candidate.embeds.some((embed) => embed.title === USER_TICKET_UPDATE_TITLE)
    )
    .sort((left, right) => right.createdTimestamp - left.createdTimestamp)[0];

  return { thread, message };
}

export async function getLatestFollowUpCustomerUpdate(threadId: string): Promise<string> {
  const { message } = await findLatestUserTicketUpdate(threadId);
  const embed = message?.embeds.find((candidate) => candidate.title === USER_TICKET_UPDATE_TITLE);

  return embed?.description?.trim() ?? "";
}

export async function updateFollowUpCreatedBy(
  threadId: string,
  runner: { name: string; id: string }
): Promise<"updated" | "unchanged" | "routing_message_missing"> {
  const thread = await fetchFollowUpThread(threadId);
  const messages = await thread.messages.fetch({ limit: 100 });
  const routingMessage = Array.from(messages.values())
    .filter((message) => getDiscordClient().user?.id === message.author.id)
    .sort((left, right) => right.createdTimestamp - left.createdTimestamp)
    .find((message) => message.embeds.some((embed) => embed.description?.startsWith("Created by ")));
  const routingEmbed = routingMessage?.embeds.find((embed) => embed.description?.startsWith("Created by "));

  if (!routingMessage || !routingEmbed?.description) {
    return "routing_message_missing";
  }

  const createdBy = resolveAgentHandoff(runner.name, [runner.id]);
  const separator = routingEmbed.description.indexOf("\n\n");
  const routingText = separator >= 0 ? routingEmbed.description.slice(separator) : "";
  const createdByText = createdBy.content.replace(/\s*<@\d+>/g, "").trim();

  if (routingEmbed.description.slice(0, separator >= 0 ? separator : undefined) === createdByText) {
    return "unchanged";
  }

  const updatedEmbed = new EmbedBuilder()
    .setColor(routingEmbed.color ?? 0x2f80ed)
    .setDescription(`${createdByText}${routingText}`);

  if (createdBy.allowedMentions.users.length > 0) {
    const agentMention = createdBy.allowedMentions.users.map((id) => `<@${id}>`).join(" ");

    await thread.send({
      content: agentMention,
      allowedMentions: createdBy.allowedMentions,
      embeds: [updatedEmbed]
    });
    await routingMessage.delete();
    return "updated";
  }

  await routingMessage.edit({ content: "", embeds: [updatedEmbed] });

  return "updated";
}

export async function postFollowUpCustomerUpdate(
  threadId: string,
  update: MaterialConversationUpdate
): Promise<void> {
  const { thread, message } = await findLatestUserTicketUpdate(threadId);

  if (thread.archived) {
    await thread.setArchived(false, "Intercom customer update");
  }

  if (thread.locked) {
    await thread.setLocked(false, "Intercom customer update");
  }

  const previousEmbed = message?.embeds.find((candidate) => candidate.title === USER_TICKET_UPDATE_TITLE);

  if (update.relatedToPreviousUpdate && message && previousEmbed?.description) {
    const description = `${previousEmbed.description}\n\n${update.delta}`;
    await message.edit({ embeds: [buildUserTicketUpdateEmbed(description)] });
    return;
  }

  await thread.send({ embeds: [buildUserTicketUpdateEmbed(update.delta)] });
}

export async function closeFollowUpThread(threadId: string): Promise<void> {
  const thread = await fetchFollowUpThread(threadId);

  if (!thread.archived) {
    await thread.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x2f80ed)
          .setTitle("Solved")
          .setDescription("Intercom ticket closed. This follow-up is now archived and locked.")
      ]
    });
  }

  if (!thread.locked) {
    await thread.setLocked(true, "Intercom ticket closed");
  }

  if (!thread.archived) {
    await thread.setArchived(true, "Intercom ticket closed");
  }
}

export async function reopenFollowUpThread(threadId: string): Promise<void> {
  const thread = await fetchFollowUpThread(threadId);

  if (thread.archived) {
    await thread.setArchived(false, "Intercom ticket reopened");
  }

  if (thread.locked) {
    await thread.setLocked(false, "Intercom ticket reopened");
  }

  await thread.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x2f80ed)
        .setTitle("Ticket reopened")
        .setDescription("Intercom ticket reopened. This follow-up is active again.")
    ]
  });
}
