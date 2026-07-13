import type { FollowUpRoutingTag } from "./types";

interface PersonReference {
  key: string;
  displayName: string;
  discordUsername: string;
  discordIdEnv: string;
  intercomIdEnv: string;
  defaultAliases: string[];
}

interface PersonResolution {
  displayName: string;
  discordUsername: string;
  discordUserId: string;
}

interface HandoffMessage {
  content: string;
  allowedMentions: { parse: []; users: string[] };
}

const AGENTS: PersonReference[] = [
  {
    key: "arg",
    displayName: "Arg",
    discordUsername: "argexorcist8",
    discordIdEnv: "AGENT_ARG_DISCORD_ID",
    intercomIdEnv: "AGENT_ARG_INTERCOM_ID",
    defaultAliases: ["arg", "argexorcist8", "argexorcist 8"]
  },
  {
    key: "swatch",
    displayName: "swatch",
    discordUsername: "swatch",
    discordIdEnv: "AGENT_SWATCH_DISCORD_ID",
    intercomIdEnv: "AGENT_SWATCH_INTERCOM_ID",
    defaultAliases: ["swatch"]
  },
  {
    key: "vmoney",
    displayName: "vmoney",
    discordUsername: "vmoney",
    discordIdEnv: "AGENT_VMONEY_DISCORD_ID",
    intercomIdEnv: "AGENT_VMONEY_INTERCOM_ID",
    defaultAliases: ["vmoney"]
  },
  {
    key: "maru",
    displayName: "maru",
    discordUsername: "maru",
    discordIdEnv: "AGENT_MARU_DISCORD_ID",
    intercomIdEnv: "AGENT_MARU_INTERCOM_ID",
    defaultAliases: ["maru"]
  },
  {
    key: "dem",
    displayName: "Dem",
    discordUsername: "dem",
    discordIdEnv: "AGENT_DEM_DISCORD_ID",
    intercomIdEnv: "AGENT_DEM_INTERCOM_ID",
    defaultAliases: ["dem"]
  }
];

const DEVS: PersonReference[] = [
  {
    key: "oop",
    displayName: "oop",
    discordUsername: "oop",
    discordIdEnv: "DEV_OOP_DISCORD_ID",
    intercomIdEnv: "DEV_OOP_ALIASES",
    defaultAliases: ["oop"]
  },
  {
    key: "nikita",
    displayName: "nikita",
    discordUsername: "nikita",
    discordIdEnv: "DEV_NIKITA_DISCORD_ID",
    intercomIdEnv: "DEV_NIKITA_ALIASES",
    defaultAliases: ["nikita"]
  }
];

const URGENT_DEV_KEYS = ["oop", "nikita"];

function readEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function normalizeAlias(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getAliases(person: PersonReference): string[] {
  return [
    person.key,
    person.displayName,
    person.discordUsername,
    ...person.defaultAliases,
    ...parseList(readEnv(person.intercomIdEnv))
  ];
}

function resolvePerson(
  value: string,
  people: PersonReference[]
): PersonResolution | null {
  const normalizedValue = normalizeAlias(value);

  if (!normalizedValue) {
    return null;
  }

  const person = people.find((candidate) =>
    getAliases(candidate).some((alias) => normalizeAlias(alias) === normalizedValue)
  );

  if (!person) {
    return null;
  }

  return {
    displayName: person.displayName,
    discordUsername: person.discordUsername,
    discordUserId: readEnv(person.discordIdEnv)
  };
}

function getDevByKey(key: string): PersonResolution | null {
  const person = DEVS.find((candidate) => candidate.key === key);

  if (!person) {
    return null;
  }

  return {
    displayName: person.displayName,
    discordUsername: person.discordUsername,
    discordUserId: readEnv(person.discordIdEnv)
  };
}

function buildMentionMessage(prefix: string, people: PersonResolution[]): HandoffMessage {
  const userIds = Array.from(
    new Set(people.map((person) => person.discordUserId).filter((id) => id.length > 0))
  );

  if (userIds.length > 0) {
    return {
      content: `${prefix} ${userIds.map((id) => `<@${id}>`).join(" ")}`,
      allowedMentions: { parse: [], users: userIds }
    };
  }

  const names = people
    .map((person) => person.displayName || person.discordUsername)
    .filter((name) => name.length > 0);

  return {
    content: names.length > 0 ? `${prefix} ${names.join(", ")}` : prefix,
    allowedMentions: { parse: [], users: [] }
  };
}

export function resolveAgentHandoff(
  rawCreatedBy: string
): HandoffMessage {
  const agent = resolvePerson(rawCreatedBy, AGENTS);
  const fallbackName = agent?.displayName ?? (rawCreatedBy.trim() || "Unknown agent");
  const userIds = Array.from(
    new Set([
      ...(agent?.discordUserId ? [agent.discordUserId] : [])
    ])
  );

  if (userIds.length > 0) {
    return {
      content: `Created by ${fallbackName} ${userIds.map((id) => `<@${id}>`).join(" ")}`,
      allowedMentions: { parse: [], users: userIds }
    };
  }

  return {
    content: `Created by ${fallbackName}`,
    allowedMentions: { parse: [], users: [] }
  };
}

export function resolveCreatedByName(
  rawCreatedBy: string,
  fallbackName = "Agent"
): string {
  const agent = resolvePerson(rawCreatedBy, AGENTS);

  if (agent) {
    return agent.displayName;
  }

  const trimmed = rawCreatedBy.trim();

  if (trimmed.length === 0 || normalizeAlias(trimmed) === "intercom") {
    return fallbackName.trim() || "Agent";
  }

  return trimmed;
}

export function buildRoutingHandoffMessage(routingTags: FollowUpRoutingTag[]): HandoffMessage {
  if (routingTags.includes("urgent")) {
    const devs = URGENT_DEV_KEYS
      .map(getDevByKey)
      .filter((person): person is PersonResolution => person !== null);

    return buildMentionMessage("URGENT: immediate dev review required:", devs);
  }

  if (routingTags.includes("bugBounty")) {
    return {
      content: "Bug Bounty: developer investigation required. Agent should assign the developer in charge.",
      allowedMentions: { parse: [], users: [] }
    };
  }

  return {
    content: "Agent should assign this to the dev in charge if dev follow-up is required.",
    allowedMentions: { parse: [], users: [] }
  };
}
