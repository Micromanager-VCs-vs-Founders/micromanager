# micromanager — design

**Date:** 2026-07-22
**Status:** Approved

## Mission

A webhook-driven agent. Slack and GitHub webhooks hit an Express server; each
event kicks off an Anthropic Agent SDK run that can act back on Slack and
GitHub. v1 behavior is prompt-driven triage — the agent receives the event,
reasons about it, and decides whether/how to act using its tools. No hardcoded
behaviors; the prompt is where personality lives.

## Stack

- TypeScript, Node, Express
- `@anthropic-ai/claude-agent-sdk` — agent runtime (`query()`)
- `@slack/web-api` — Slack writes/reads inside custom tools
- `octokit` — GitHub writes inside custom tools
- Env config via `.env` (not committed): `ANTHROPIC_API_KEY`,
  `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `GITHUB_TOKEN`,
  `GITHUB_WEBHOOK_SECRET`, `PORT`

## Webhook layer

Two endpoints. Each verifies authenticity before doing anything else, acks
`200` immediately, and hands the event to the agent asynchronously. Agent runs
must never block the HTTP response (Slack retries deliveries not acked within
3 seconds).

- `POST /webhooks/slack`
  - Signing-secret verification (v0 signature: HMAC-SHA256 over
    `v0:{timestamp}:{raw body}`, timestamp freshness check to block replays).
  - Handles the `url_verification` challenge handshake.
  - Ignores `event_callback`s from the bot itself (avoid self-trigger loops).
- `POST /webhooks/github`
  - HMAC-SHA256 verification of `X-Hub-Signature-256` against the raw body,
    constant-time comparison.

Raw request bodies must be preserved for signature verification (express raw
body capture before/instead of JSON parsing on these routes).

Dispatch is fire-and-forget with an in-process concurrency cap (3 concurrent
agent runs; excess events queue in memory). No queue,
no persistence, no delivery dedupe in v1 (dedupe via in-memory event-id cache
is a known future need if retry storms bite).

## Agent layer

Single entrypoint `runAgent(event)` wrapping the SDK's `query()`:

- **No built-in tools** — `tools: []` strips filesystem/bash entirely. The
  agent sees only the tools we hand it.
- **Writes — custom in-process typed tools** (zod schemas, in-process MCP
  server via `tool()` + `createSdkMcpServer()`):
  - `slack_post_message` (channel, text, optional thread_ts)
  - `github_comment` (owner, repo, issue/PR number, body)
- **Reads:**
  - GitHub: official remote GitHub MCP server
    (`type: "http"`, `https://api.githubcopilot.com/mcp/`, PAT bearer auth)
    for broad read access.
  - Slack: custom typed tools `slack_read_thread`, `slack_channel_history`.
    (The official Slack MCP server is archived; custom tools chosen over a
    community server dependency.)
- `allowedTools` limited to the above MCP tool names.
- `maxTurns` capped (start at 10). Model: `claude-sonnet-5`.
- System prompt: team micromanager persona; given a webhook event, decide
  whether action is warranted; act via tools or do nothing; be sparing.

## Layout

Colocated by concept:

- `src/slack.ts` — signature verification, webhook route, Slack tools
- `src/github.ts` — signature verification, webhook route, GitHub write tool,
  GitHub MCP server config
- `src/agent.ts` — `runAgent()`, system prompt, tool/MCP assembly
- `src/server.ts` — Express app assembly, config loading

## Error handling

- Webhook endpoints always ack (bad signatures get 401; everything else 200).
- Failed agent runs are logged with the triggering event payload. No retries.

## Testing

- Unit tests for both signature verifiers (valid, invalid, replay/stale
  timestamp for Slack).
- Agent loop verified manually end-to-end with a real delivered event.

## Out of scope (v1)

- Delivery dedupe / retry handling
- Durable queue or run persistence
- Specific micromanagement behaviors (prompt iteration comes after the
  skeleton works)
- Slack Socket Mode, GitHub App auth (PAT + webhook secret is enough for v1)
