import type { Conversation, ConversationSummary, Priority } from "./types";
import { AppError, logEvent } from "./utils";

type JsonRecord = Record<string, unknown>;

const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-pro";

const SUMMARY_SYSTEM_PROMPT = `You are an AI support triage assistant.
Analyze the full customer conversation and return ONLY valid JSON.

Determine:
- topic (2-5 words)
- problem (1 concise paragraph)
- request (what the user is asking for)
- recommendedSolution (what the developer or support team should do next)
- category (e.g. Account, Wallet, Withdrawal, Deposit, Rewards, XP, Referral, Gameplay, Bug, Performance, UI, Payments, Security, Partnership, Feature Request, General)
- priority
- developerRequired (boolean)
- confidence (0-1)

Rules:
- Base your answer only on the conversation.
- Do not invent missing information.
- Ignore standalone macro/action labels such as "Other" when more specific customer messages are present.
- Distinguish leaderboard/user visibility issues from lag or performance issues. If users or players are not showing on a leaderboard, use a topic like "Leaderboard Display Issue" and category "UI" or "Gameplay", not "Performance", unless the customer clearly mentions lag, latency, freezing, stuttering, or slowness.
- Keep responses concise and professional.
- Keep every JSON string value on one line.
- Keep problem, request, and recommendedSolution under 45 words each.
- If the issue is a question or can be resolved by support, set developerRequired to false.
- Return JSON only, with no markdown or explanation.

Example JSON:
{
  "topic": "Withdrawal Delay",
  "problem": "The player says a withdrawal has been pending longer than expected and wants to know why it has not cleared.",
  "request": "The player wants the withdrawal reviewed and completed.",
  "recommendedSolution": "Check the payout status, confirm whether any verification or compliance step is blocking the transfer, and update the player with the next step.",
  "category": "Withdrawal",
  "priority": "High",
  "developerRequired": false,
  "confidence": 0.92
}`;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (["true", "1", "yes"].includes(normalized)) {
      return true;
    }

    if (["false", "0", "no"].includes(normalized)) {
      return false;
    }
  }

  return null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function pickRandomPriority(): Priority {
  const priorities: Priority[] = ["Low", "Medium", "High", "Urgent"];
  const index = Math.floor(Math.random() * priorities.length);

  return priorities[index];
}

function normalizeTopic(topic: string): string {
  const normalized = topic.replace(/\s+/g, " ").replace(/[.?!]+$/g, "").trim();

  if (!normalized) {
    throw new Error("DeepSeek summary is missing topic.");
  }

  const words = normalized.split(" ").filter(Boolean);

  if (words.length === 1) {
    return `${normalized} issue`;
  }

  if (words.length === 0) {
    throw new Error("DeepSeek summary is missing topic.");
  }

  const topicWords = words.slice(0, 5);

  while (
    topicWords.length > 2 &&
    ["and", "or", "not", "to", "for", "of", "the"].includes(
      topicWords[topicWords.length - 1].toLowerCase()
    )
  ) {
    topicWords.pop();
  }

  return topicWords.join(" ");
}

function refineTopic(topic: string, category: string): string {
  const lowerTopic = topic.toLowerCase();
  const lowerCategory = category.toLowerCase();

  if (
    lowerTopic.includes("leaderboard") &&
    (lowerTopic.includes("referral") ||
      lowerTopic.includes("earning") ||
      lowerCategory.includes("referral"))
  ) {
    return "Referral Leaderboard Issue";
  }

  return topic;
}

function normalizeConfidence(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    throw new Error("DeepSeek summary is missing confidence.");
  }

  return Math.min(1, Math.max(0, value));
}

function normalizeCategory(value: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error("DeepSeek summary is missing category.");
  }

  return trimmed;
}

function normalizeText(value: string, fieldName: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();

  if (trimmed.length === 0) {
    throw new Error(`DeepSeek summary is missing ${fieldName}.`);
  }

  return trimmed;
}

function readFirstString(raw: JsonRecord, keys: string[]): string {
  for (const key of keys) {
    const value = readString(raw[key]);

    if (value.length > 0) {
      return value;
    }
  }

  return "";
}

function parseSummaryJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");

    if (start >= 0 && end > start) {
      return JSON.parse(content.slice(start, end + 1));
    }

    throw error;
  }
}

function buildConversationTranscript(conversation: Conversation): string {
  return conversation.messages
    .map((message, index) => {
      const label =
        message.role === "agent" ? "Agent" : message.role === "system" ? "System" : "User";
      const speaker = message.authorName?.trim().length
        ? `${label} (${message.authorName.trim()})`
        : label;

      return `${index + 1}. ${speaker}: ${message.text.trim()}`;
    })
    .join("\n");
}

function buildTranscriptPrompt(conversation: Conversation): string {
  const transcript = buildConversationTranscript(conversation);

  return [
    `Conversation ID: ${conversation.conversationId}`,
    `Player: ${conversation.playerName}`,
    `Message count: ${conversation.messages.length}`,
    "",
    "Transcript:",
    transcript.length > 0 ? transcript : "No messages were provided."
  ].join("\n");
}

function parseModelSummary(raw: unknown): ConversationSummary {
  if (!isRecord(raw)) {
    throw new Error("DeepSeek summary JSON was not an object.");
  }

  const category = normalizeCategory(readString(raw.category));
  const topic = refineTopic(
    normalizeTopic(
      readFirstString(raw, ["topic", "summary", "threadTopic", "thread_topic"])
    ),
    category
  );
  const problem = normalizeText(readString(raw.problem), "problem");
  const request = normalizeText(readString(raw.request), "request");
  const recommendedSolution = normalizeText(
    readFirstString(raw, ["recommendedSolution", "recommended_solution"]),
    "recommendedSolution"
  );
  const developerRequired =
    readBoolean(raw.developerRequired);
  const confidence = normalizeConfidence(readNumber(raw.confidence));

  if (developerRequired === null) {
    throw new Error("DeepSeek summary is missing developerRequired.");
  }

  return {
    topic,
    problem,
    request,
    recommendedSolution,
    category,
    priority: pickRandomPriority(),
    developerRequired,
    confidence
  };
}

async function generateDeepSeekSummary(
  conversation: Conversation,
  timeoutMs: number
): Promise<ConversationSummary> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();

  if (!apiKey) {
    throw new AppError(500, "Internal server error.", "DEEPSEEK_NOT_CONFIGURED");
  }

  const model = process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL;

  const requestSummaryContent = async (retryInstruction?: string): Promise<string> => {
    const response = await fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: SUMMARY_SYSTEM_PROMPT
          },
          ...(retryInstruction
            ? [
                {
                  role: "system",
                  content: retryInstruction
                }
              ]
            : []),
          {
            role: "user",
            content: buildTranscriptPrompt(conversation)
          }
        ],
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
        max_tokens: 1200,
        temperature: 0.1,
        stream: false
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      throw new AppError(500, "Internal server error.", "DEEPSEEK_REQUEST_FAILED");
    }

    const payload = (await response.json()) as JsonRecord;
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    const message = isRecord(choice) ? choice.message : null;
    const content = isRecord(message) ? message.content : null;

    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("DeepSeek response did not include summary JSON.");
    }

    return content;
  };

  const parseSummary = (content: string): ConversationSummary =>
    parseModelSummary(parseSummaryJson(content));

  try {
    return parseSummary(await requestSummaryContent());
  } catch {
    logEvent("warn", "deepseek_invalid_summary_retry");
    const retryContent = await requestSummaryContent(
      "Your previous response was invalid or incomplete. Return one compact valid JSON object only with exactly these fields: topic, problem, request, recommendedSolution, category, developerRequired, confidence. All text fields must be non-empty strings, developerRequired must be boolean, confidence must be a number from 0 to 1, and all text values must remain on one line."
    );

    try {
      return parseSummary(retryContent);
    } catch {
      throw new AppError(500, "Internal server error.", "DEEPSEEK_RESPONSE_INVALID");
    }
  }
}

export async function generateSummary(
  conversation: Conversation,
  timeoutMs: number
): Promise<ConversationSummary> {
  try {
    return await generateDeepSeekSummary(conversation, timeoutMs);
  } catch (error: unknown) {
    logEvent("error", "deepseek_summary_failed", {
      code: error instanceof AppError ? error.code : "DEEPSEEK_SUMMARY_FAILED"
    });

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(500, "Internal server error.", "DEEPSEEK_SUMMARY_FAILED");
  }
}
