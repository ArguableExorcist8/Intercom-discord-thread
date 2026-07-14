import assert from "node:assert/strict";
import test from "node:test";
import { loadRuntimeConfig } from "../src/config";

const configKeys = [
  "DISCORD_TOKEN",
  "INTERCOM_CONNECTOR_SECRET",
  "INTERCOM_WEBHOOK_CLIENT_SECRET",
  "INTERCOM_ACCESS_TOKEN",
  "DEEPSEEK_API_KEY",
  "FOLLOWUP_CHANNEL_ID",
  "FOLLOWUP_TAG_URGENT_ID",
  "FOLLOWUP_TAG_VIP_PARTNER_ID",
  "FOLLOWUP_TAG_BUG_BOUNTY_ID",
  "FOLLOWUP_TAG_STANDARD_ID",
  "PORT",
  "OUTBOUND_TIMEOUT_MS",
  "INTERCOM_RATE_LIMIT_MAX",
  "INTERCOM_RATE_LIMIT_WINDOW_MS",
  "INTERCOM_DEDUPLICATION_TTL_MS",
  "INTERCOM_WEBHOOK_PROCESSING_TIMEOUT_MS",
  "TRUST_PROXY_HOPS",
  "AGENT_ARG_DISCORD_ID",
  "AGENT_SWATCH_DISCORD_ID",
  "AGENT_VMONEY_DISCORD_ID",
  "AGENT_MARU_DISCORD_ID",
  "AGENT_DEM_DISCORD_ID",
  "DEV_OOP_DISCORD_ID",
  "DEV_NIKITA_DISCORD_ID"
];

const validEnvironment: Record<string, string> = {
  DISCORD_TOKEN: "token",
  INTERCOM_CONNECTOR_SECRET: "secret",
  INTERCOM_WEBHOOK_CLIENT_SECRET: "webhook-secret",
  INTERCOM_ACCESS_TOKEN: "token",
  DEEPSEEK_API_KEY: "key",
  FOLLOWUP_CHANNEL_ID: "12345678901234567",
  FOLLOWUP_TAG_URGENT_ID: "12345678901234568",
  FOLLOWUP_TAG_VIP_PARTNER_ID: "12345678901234569",
  FOLLOWUP_TAG_BUG_BOUNTY_ID: "12345678901234570",
  FOLLOWUP_TAG_STANDARD_ID: "12345678901234571"
};

function withEnvironment(callback: () => void): void {
  const original = new Map(configKeys.map((key) => [key, process.env[key]]));

  try {
    for (const key of configKeys) {
      delete process.env[key];
    }
    Object.assign(process.env, validEnvironment);
    callback();
  } finally {
    for (const key of configKeys) {
      const value = original.get(key);

      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("validates required production configuration at startup", () => {
  withEnvironment(() => {
    const config = loadRuntimeConfig();
    assert.equal(config.port, 3000);
    assert.equal(config.outboundTimeoutMs, 15_000);
    assert.equal(config.webhookProcessingTimeoutMs, 4_000);
  });
});

test("rejects missing secrets and malformed Discord IDs", () => {
  withEnvironment(() => {
    delete process.env.INTERCOM_CONNECTOR_SECRET;
    assert.throws(() => loadRuntimeConfig(), /INTERCOM_CONNECTOR_SECRET/);

    process.env.INTERCOM_CONNECTOR_SECRET = "secret";
    delete process.env.INTERCOM_WEBHOOK_CLIENT_SECRET;
    assert.throws(() => loadRuntimeConfig(), /INTERCOM_WEBHOOK_CLIENT_SECRET/);

    process.env.INTERCOM_WEBHOOK_CLIENT_SECRET = "webhook-secret";
    process.env.FOLLOWUP_CHANNEL_ID = "not-a-discord-id";
    assert.throws(() => loadRuntimeConfig(), /FOLLOWUP_CHANNEL_ID/);
  });
});
