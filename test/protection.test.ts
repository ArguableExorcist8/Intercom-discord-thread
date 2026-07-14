import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRateLimiter, InMemoryTicketDeduplicator } from "../src/protection";
import { resolveAgentHandoff } from "../src/people";

test("rate limiter rejects requests over the configured limit", () => {
  const limiter = new InMemoryRateLimiter(1, 60_000);

  limiter.assertAllowed("127.0.0.1", 1);
  assert.throws(() => limiter.assertAllowed("127.0.0.1", 2), { statusCode: 429 });
});

test("ticket deduplicator shares in-flight work and caches successful results", async () => {
  const deduplicator = new InMemoryTicketDeduplicator<string>(60_000);
  let runs = 0;
  let resolveOperation: ((value: string) => void) | undefined;
  const operation = () => {
    runs += 1;
    return new Promise<string>((resolve) => {
      resolveOperation = resolve;
    });
  };

  const first = deduplicator.run("ticket-1", operation);
  const second = deduplicator.run("ticket-1", operation);
  resolveOperation?.("thread-1");

  assert.equal(await first, "thread-1");
  assert.equal(await second, "thread-1");
  assert.equal(runs, 1);
  assert.equal(await deduplicator.run("ticket-1", operation), "thread-1");
  assert.equal(runs, 1);
});

test("untrusted names cannot create implicit Discord mentions", () => {
  const handoff = resolveAgentHandoff("@everyone");

  assert.deepEqual(handoff.allowedMentions, { parse: [], users: [] });
});

test("agent aliases match a runner ID while preserving the supplied Intercom name", () => {
  const originalIntercomId = process.env.AGENT_ARG_INTERCOM_ID;
  const originalDiscordId = process.env.AGENT_ARG_DISCORD_ID;
  const originalAliases = process.env.AGENT_ARG_INTERCOM_ALIASES;
  process.env.AGENT_ARG_INTERCOM_ID = "9037398";
  process.env.AGENT_ARG_DISCORD_ID = "123456789012345678";
  process.env.AGENT_ARG_INTERCOM_ALIASES = "arg runner,Arg Exorcist";

  try {
    const byId = resolveAgentHandoff("Arg", ["9037398"]);
    const byAlias = resolveAgentHandoff("Arg Exorcist");
    const unknown = resolveAgentHandoff("New Teammate", ["other-admin"]);

    assert.equal(byId.content, "Created by Arg <@123456789012345678>");
    assert.equal(byAlias.content, "Created by Arg Exorcist <@123456789012345678>");
    assert.equal(unknown.content, "Created by New Teammate");
    assert.deepEqual(unknown.allowedMentions, { parse: [], users: [] });
  } finally {
    for (const [key, value] of Object.entries({
      AGENT_ARG_INTERCOM_ID: originalIntercomId,
      AGENT_ARG_DISCORD_ID: originalDiscordId,
      AGENT_ARG_INTERCOM_ALIASES: originalAliases
    })) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
