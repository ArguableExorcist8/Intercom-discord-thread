import { Client, GatewayIntentBits } from "discord.js";
import type { DiscordServiceState } from "./types";
import { logEvent } from "./utils";

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const state: DiscordServiceState = {
  tokenConfigured: false,
  ready: false,
  lastError: null
};

let loginPromise: Promise<void> | null = null;
let listenersRegistered = false;

function markError(message: string): void {
  state.ready = false;
  state.lastError = message;
}

function markReady(): void {
  state.ready = true;
  state.lastError = null;
}

export function getDiscordClient(): Client {
  return client;
}

export function getDiscordState(): DiscordServiceState {
  return { ...state };
}

export async function initializeDiscordBot(): Promise<void> {
  const token = process.env.DISCORD_TOKEN?.trim() ?? "";
  state.tokenConfigured = token.length > 0;

  if (!state.tokenConfigured) {
    markError("Discord configuration is invalid.");
    throw new Error("DISCORD_TOKEN is missing.");
  }

  if (state.ready) {
    return;
  }

  if (loginPromise) {
    await loginPromise;
    return;
  }

  if (!listenersRegistered) {
    client.on("ready", () => {
      markReady();
      logEvent("info", "discord_ready");
    });

    client.on("shardReady", () => {
      markReady();
      logEvent("info", "discord_gateway_ready");
    });

    client.on("shardResume", () => {
      markReady();
      logEvent("info", "discord_gateway_resumed");
    });

    client.on("shardDisconnect", () => {
      markError("Discord gateway disconnected.");
      logEvent("warn", "discord_gateway_disconnected");
    });

    client.on("error", () => {
      markError("Discord client error.");
      logEvent("error", "discord_client_error");
    });

    client.on("shardError", () => {
      markError("Discord shard error.");
      logEvent("error", "discord_shard_error");
    });

    listenersRegistered = true;
  }

  loginPromise = (async (): Promise<void> => {
    try {
      await client.login(process.env.DISCORD_TOKEN);
    } catch {
      markError("Discord login failed.");
      logEvent("error", "discord_login_failed");
      throw new Error("Discord login failed.");
    }
  })().finally(() => {
    loginPromise = null;
  });

  await loginPromise;
}
