# Bot API Reference

This service receives an authenticated Intercom Data Connector request, fetches the ticket directly from Intercom, creates an AI summary with DeepSeek, and posts a Discord forum thread.

## Base URL

Deploy behind an HTTPS reverse proxy. The service listens on `PORT` (default `3000`) and must not be exposed directly to the public internet without TLS.

## Endpoints

### `GET /healthz`

Public liveness endpoint. It intentionally does not reveal Discord, Intercom, DeepSeek, model, or secret configuration state.

```json
{
  "ok": true
}
```

### `POST /intercom/ticket`

Creates a Discord follow-up thread for one Intercom ticket.

#### Authentication

`INTERCOM_CONNECTOR_SECRET` is mandatory. Send it in exactly one of the following forms:

```text
X-Intercom-Connector-Secret: <secret>
```

```text
Authorization: Bearer <secret>
```

The comparison is constant-time. Requests without valid credentials receive `401 Unauthorized`.

#### Request

`Content-Type: application/json` is required. The request body should contain the ticket's internal API ID and its conversation ID:

```json
{
  "ticket_id": "{{ticket.id}}",
  "conversation_id": "{{conversation.id}}",
  "partner_status": "{{custom_data.partner}}"
}
```

Use `{{ticket.id}}`, not the Inbox display number (for example, `#116575854`); the display `ticket_id` cannot be retrieved through the Ticket API. `conversation_id` is used for the Intercom link (`.../conversation/{conversation_id}`) and as a fallback when resolving the ticket's linked conversation. `partner_status` is optional, must resolve to `true` or `false`, and adds the `VIP/Partner` tag when true. Contact details, messages, tags, assignee data, and other routing inputs are fetched directly from Intercom; connector-supplied transcripts, tags, and mention IDs are rejected.

#### Success response

```json
{
  "success": true,
  "conversationId": "123456789",
  "thread": {
    "threadId": "123456789012345678",
    "threadUrl": "https://discord.com/channels/..."
  }
}
```

Responses include an `X-Request-Id` header for safe operational support. Do not put customer data or secrets in support requests that reference this ID.

### `HEAD /intercom/webhook`

Returns `200 OK`. Intercom uses this endpoint to validate the configured webhook URL.

### `POST /intercom/webhook`

Receives lifecycle notifications for Intercom conversations already linked to a Discord thread. The raw request body must carry a valid `X-Hub-Signature` generated with `INTERCOM_WEBHOOK_CLIENT_SECRET`; unsigned or invalid requests receive `401 Unauthorized`.

The service handles these conversation topics:

- `conversation.user.replied`: the bot refetches the conversation and posts a concise AI delta only if the new customer information materially advances the issue.
- `conversation.admin.closed`: the linked Discord thread receives a closure note, then is archived and locked.
- `conversation.admin.opened`: the linked Discord thread is unarchived and unlocked.

It also handles ticket topics for tickets linked to an Intercom conversation carrying the bot-owned Discord thread attributes:

- `ticket.contact.replied`: runs the same material-update filter against ticket replies.
- `ticket.closed` and `ticket.resolved`: archive and lock the linked Discord thread.
- `ticket.state.updated`: restores the thread if the ticket is open, or closes it if the ticket is closed.

For a successful `data_connector.execution.completed` notification with a conversation and an executing Intercom teammate, the service replaces the routing card's temporary creator with that teammate's exact Intercom name. This covers direct Inbox runs and other agent-triggered sources such as macros. Configure their Intercom ID, comma-separated aliases, and Discord ID in the corresponding `AGENT_*` environment variables to replace the card with a fresh Discord message: the runner is tagged inside the card and receives a real notification. Unmapped teammates are shown by name without a tag.

Unsupported valid topics return `204 No Content`. The endpoint does not create a new Discord thread; it ignores conversations, tickets without a linked conversation, and linked conversations without the bot-owned `discord_followup_thread_id` custom attribute.

## Errors And Limits

All error responses use this shape:

```json
{
  "success": false,
  "error": "Human-readable safe message"
}
```

| Status | Meaning |
| --- | --- |
| `400` | Invalid JSON, missing/invalid `conversation_id`, or fields other than `conversation_id` were sent. |
| `401` | Connector credentials are missing or invalid. |
| `413` | Request body exceeds 8 KB. |
| `415` | `Content-Type` is not `application/json`. |
| `429` | Per-IP request limit exceeded. Defaults to 30 requests per 60 seconds. |
| `500` | A provider or internal operation failed. The response does not expose provider details. |

Successful requests for the same conversation ID are coalesced while processing and cached for 10 minutes by default. This prevents duplicate Discord threads from connector retries. Rate limiting and duplicate protection are in-memory and apply to a single service instance only.

## Data Flow And Privacy

1. The connector sends only the conversation ID.
2. The bot retrieves the conversation from Intercom using `INTERCOM_ACCESS_TOKEN`.
3. The full conversation context is sent to DeepSeek to generate the summary.
4. The thread title and Discord embed include selected Intercom details: player name, user ID, conversation ID, timestamps, and AI summary fields.
5. The bot writes the Discord thread ID and last processed customer part ID to bot-owned Intercom conversation custom attributes. Webhooks use that state to keep the existing thread current.

DeepSeek and Discord are third-party processors of this data. Restrict the Discord forum to authorised staff, use vendor accounts approved for customer data, and ensure the applicable privacy notices, agreements, and retention settings are in place.

## Discord Effects

Each successful request creates one thread in `FOLLOWUP_CHANNEL_ID`, applies every matching routing tag, posts the summary embed, posts the created-by handoff, posts the routing handoff, and posts the Intercom ticket link.

Discord mentions are disabled by default. Only configured Discord user IDs for known agents or developers can be mentioned; customer or model text cannot trigger `@everyone`, role, or arbitrary-user mentions.

## Routing And Forum Tags

A Discord forum thread can have multiple tags. Tags are evaluated and applied in this fixed order: `VIP/Partner`, `URGENT`, `Bug Bounty`, then `Standard`.

| Tag | Condition | Automatic action |
| --- | --- | --- |
| `VIP/Partner` | `contact.partner` is true or `contact.level >= 50`. | Priority handling; may be combined with another tag. |
| `URGENT` | An active production, security, data, or infrastructure emergency requiring normal work to stop. | Applies `URGENT` and pings configured oop and nikita Discord IDs. |
| `Bug Bounty` | An intentional security disclosure or bounty submission: the user reports a vulnerability, exploit, or technical security flaw for review, or explicitly mentions bug bounty, bounty, responsible disclosure, CVE, or a proof of concept. | Applies `Bug Bounty`; no automatic developer ping. |
| `Standard` | Account-specific support and everything else, including a bug that the user wants fixed for their own account (XP, RugPass, deposits, withdrawals, rewards, referrals, crashes, and wallet issues). | Applies only when the ticket is neither `URGENT` nor `Bug Bounty`. |

Examples:

- A level 62 player with missing XP receives `VIP/Partner` + `Standard`.
- A level 71 player whose RugPass challenge did not complete receives `VIP/Partner` + `Standard`, even if the cause is a gameplay bug.
- A partner reporting a production exploit receives `VIP/Partner` + `URGENT`.
- A researcher reporting SQL injection without active exploitation receives `Bug Bounty`.
- An active exploit draining funds receives `URGENT` + `Bug Bounty`.

## Required Environment Variables

- `DISCORD_TOKEN`
- `INTERCOM_CONNECTOR_SECRET`
- `INTERCOM_WEBHOOK_CLIENT_SECRET`
- `INTERCOM_WEBHOOK_PROCESSING_TIMEOUT_MS` (optional; defaults to `4000`)
- `INTERCOM_ACCESS_TOKEN`
- `DEEPSEEK_API_KEY`
- `FOLLOWUP_CHANNEL_ID`
- `FOLLOWUP_TAG_URGENT_ID`
- `FOLLOWUP_TAG_VIP_PARTNER_ID`
- `FOLLOWUP_TAG_BUG_BOUNTY_ID`
- `FOLLOWUP_TAG_STANDARD_ID`

Optional runtime controls:

- `PORT` - listener port, default `3000`.
- `TRUST_PROXY_HOPS` - number of trusted reverse proxies, default `0`.
- `OUTBOUND_TIMEOUT_MS` - Intercom and DeepSeek request timeout, default `15000`.
- `INTERCOM_RATE_LIMIT_MAX` - requests allowed per rate-limit window, default `30`.
- `INTERCOM_RATE_LIMIT_WINDOW_MS` - rate-limit window, default `60000`.
- `INTERCOM_DEDUPLICATION_TTL_MS` - duplicate result cache duration, default `600000`.
- `INTERCOM_VERSION` and `DEEPSEEK_MODEL` - provider settings.

Configured Discord IDs must be valid Discord snowflakes. Invalid or missing required configuration prevents startup.
