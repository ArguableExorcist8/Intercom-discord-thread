import type { FollowUpConfig, FollowUpRoutingTag } from "./types";

export interface RuntimeConfig {
  port: number;
  connectorSecret: string;
  webhookClientSecret: string;
  webhookProcessingTimeoutMs: number;
  outboundTimeoutMs: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  deduplicationTtlMs: number;
  trustProxyHops: number;
}

export function readEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function requiredEnv(name: string): string {
  const value = readEnv(name);

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = readEnv(name);

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}; expected an integer between ${min} and ${max}.`);
  }

  return value;
}

function assertDiscordSnowflake(name: string, required = false): void {
  const value = required ? requiredEnv(name) : readEnv(name);

  if (value && !/^\d{17,20}$/.test(value)) {
    throw new Error(`Invalid ${name}; expected a Discord snowflake ID.`);
  }
}

export function getFollowUpConfig(): FollowUpConfig {
  return {
    channelId: readEnv("FOLLOWUP_CHANNEL_ID"),
    routingTagIds: {
      urgent: readEnv("FOLLOWUP_TAG_URGENT_ID"),
      vipPartner: readEnv("FOLLOWUP_TAG_VIP_PARTNER_ID"),
      bugBounty: readEnv("FOLLOWUP_TAG_BUG_BOUNTY_ID"),
      standard: readEnv("FOLLOWUP_TAG_STANDARD_ID")
    } satisfies Record<FollowUpRoutingTag, string>
  };
}

export function loadRuntimeConfig(): RuntimeConfig {
  requiredEnv("DISCORD_TOKEN");
  const connectorSecret = requiredEnv("INTERCOM_CONNECTOR_SECRET");
  const webhookClientSecret = requiredEnv("INTERCOM_WEBHOOK_CLIENT_SECRET");
  requiredEnv("INTERCOM_ACCESS_TOKEN");
  requiredEnv("DEEPSEEK_API_KEY");

  assertDiscordSnowflake("FOLLOWUP_CHANNEL_ID", true);
  assertDiscordSnowflake("FOLLOWUP_TAG_URGENT_ID", true);
  assertDiscordSnowflake("FOLLOWUP_TAG_VIP_PARTNER_ID", true);
  assertDiscordSnowflake("FOLLOWUP_TAG_BUG_BOUNTY_ID", true);
  assertDiscordSnowflake("FOLLOWUP_TAG_STANDARD_ID", true);

  for (const name of [
    "AGENT_ARG_DISCORD_ID",
    "AGENT_SWATCH_DISCORD_ID",
    "AGENT_VMONEY_DISCORD_ID",
    "AGENT_MARU_DISCORD_ID",
    "AGENT_DEM_DISCORD_ID",
    "DEV_OOP_DISCORD_ID",
    "DEV_NIKITA_DISCORD_ID"
  ]) {
    assertDiscordSnowflake(name);
  }

  return {
    port: readInteger("PORT", 3000, 1, 65535),
    connectorSecret,
    webhookClientSecret,
    webhookProcessingTimeoutMs: readInteger("INTERCOM_WEBHOOK_PROCESSING_TIMEOUT_MS", 4_000, 1_000, 4_900),
    outboundTimeoutMs: readInteger("OUTBOUND_TIMEOUT_MS", 15_000, 1_000, 60_000),
    rateLimitMax: readInteger("INTERCOM_RATE_LIMIT_MAX", 30, 1, 1_000),
    rateLimitWindowMs: readInteger("INTERCOM_RATE_LIMIT_WINDOW_MS", 60_000, 1_000, 3_600_000),
    deduplicationTtlMs: readInteger("INTERCOM_DEDUPLICATION_TTL_MS", 600_000, 1_000, 3_600_000),
    trustProxyHops: readInteger("TRUST_PROXY_HOPS", 0, 0, 10)
  };
}
