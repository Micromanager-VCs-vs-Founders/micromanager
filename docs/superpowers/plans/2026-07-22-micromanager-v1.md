# micromanager v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Express server that receives verified Slack/GitHub webhooks and dispatches each event to an Anthropic Agent SDK agent that can read/write Slack and GitHub.

**Architecture:** Two webhook endpoints verify signatures, ack immediately, and hand events to a concurrency-capped dispatcher. The dispatcher calls `runAgent(event)`, which runs the Agent SDK `query()` with built-in tools stripped, custom in-process typed tools for Slack (read+write) and GitHub writes, and the official remote GitHub MCP server for broad GitHub reads.

**Tech Stack:** TypeScript (ESM), Express 5, `@anthropic-ai/claude-agent-sdk`, `@slack/web-api`, `octokit`, `zod@^3`, vitest + supertest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-22-micromanager-design.md` — read it before starting any task.
- ESM project (`"type": "module"`, tsconfig `module: "NodeNext"`): every relative import MUST end in `.js` (e.g. `import { x } from './agent.js'`) even though the source file is `.ts`.
- `zod` must be v3 (`zod@^3`) — the Agent SDK's `tool()` expects zod v3 schemas.
- Agent model: `claude-sonnet-5`. `maxTurns: 10`. Built-in tools stripped with `tools: []`.
- Concurrency cap: 3 concurrent agent runs, excess events FIFO-queued in memory.
- Webhook routes must operate on the RAW request body (Buffer) for signature verification; JSON-parse only after verification succeeds.
- All signature comparisons use `crypto.timingSafeEqual`.
- Env vars (see `.env.example`): `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `PORT`.
- Commands: `npm test` (vitest run), `npm run typecheck` (tsc --noEmit), `npm run dev` (tsx src/server.ts).

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`, `src/server.ts` (stub)

**Interfaces:**
- Consumes: nothing
- Produces: a repo where `npm test` and `npm run typecheck` pass; later tasks add files under `src/` and `src/*.test.ts`.

- [ ] **Step 1: Init package and install dependencies**

```bash
npm init -y
npm pkg set type=module
npm pkg set scripts.dev="tsx src/server.ts" scripts.build="tsc" scripts.typecheck="tsc --noEmit" scripts.test="vitest run"
npm install express @anthropic-ai/claude-agent-sdk @slack/web-api octokit zod@^3 dotenv
npm install -D typescript tsx vitest supertest @types/supertest @types/express @types/node
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write .gitignore and .env.example**

`.gitignore`:
```
node_modules/
dist/
.env
```

`.env.example`:
```
ANTHROPIC_API_KEY=
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=
GITHUB_TOKEN=ghp_...
GITHUB_WEBHOOK_SECRET=
PORT=3000
```

- [ ] **Step 4: Write stub src/server.ts**

```typescript
console.log('micromanager: not wired up yet');
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck` — Expected: exit 0, no errors.
Run: `npm test` — Expected: vitest exits 0 or reports "No test files found" (passWithNoTests not needed; if vitest exits non-zero on no tests, run `npm pkg set scripts.test="vitest run --passWithNoTests"` and re-run).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold TypeScript/Express project"
```

---

### Task 2: Slack signature verification

**Files:**
- Create: `src/slack.ts`, `src/slack.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `verifySlackSignature(signingSecret: string, timestamp: string, signature: string, rawBody: string, nowSeconds?: number): boolean` exported from `src/slack.ts`. Later tasks add `slackRouter` and `slackTools` to this same file.

Slack's scheme: `signature` header is `v0=` + hex HMAC-SHA256 of `v0:{timestamp}:{rawBody}` keyed by the signing secret. Reject if `|now - timestamp| > 300` seconds (replay guard). `nowSeconds` defaults to `Date.now()/1000`; it's a parameter so tests are deterministic.

- [ ] **Step 1: Write the failing tests**

`src/slack.test.ts`:
```typescript
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifySlackSignature } from './slack.js';

const SECRET = 'test-signing-secret';

function sign(timestamp: string, body: string, secret = SECRET): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(`v0:${timestamp}:${body}`);
  return `v0=${hmac.digest('hex')}`;
}

describe('verifySlackSignature', () => {
  const now = 1_800_000_000;
  const ts = String(now);
  const body = '{"type":"event_callback"}';

  it('accepts a valid signature', () => {
    expect(verifySlackSignature(SECRET, ts, sign(ts, body), body, now)).toBe(true);
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(verifySlackSignature(SECRET, ts, sign(ts, body, 'wrong'), body, now)).toBe(false);
  });

  it('rejects a tampered body', () => {
    expect(verifySlackSignature(SECRET, ts, sign(ts, body), body + 'x', now)).toBe(false);
  });

  it('rejects a stale timestamp (replay)', () => {
    const staleTs = String(now - 301);
    expect(verifySlackSignature(SECRET, staleTs, sign(staleTs, body), body, now)).toBe(false);
  });

  it('rejects a malformed signature header', () => {
    expect(verifySlackSignature(SECRET, ts, 'garbage', body, now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/slack.test.ts`
Expected: FAIL — `Cannot find module './slack.js'` (or export missing).

- [ ] **Step 3: Implement**

`src/slack.ts`:
```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AGE_SECONDS = 300;

export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  signature: string,
  rawBody: string,
  nowSeconds: number = Date.now() / 1000,
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAX_AGE_SECONDS) return false;

  const hmac = createHmac('sha256', signingSecret);
  hmac.update(`v0:${timestamp}:${rawBody}`);
  const expected = Buffer.from(`v0=${hmac.digest('hex')}`);
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/slack.test.ts` — Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/slack.ts src/slack.test.ts
git commit -m "feat: Slack webhook signature verification"
```

---

### Task 3: GitHub signature verification

**Files:**
- Create: `src/github.ts`, `src/github.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `verifyGithubSignature(secret: string, rawBody: string, signatureHeader: string): boolean` exported from `src/github.ts`. Later tasks add `githubRouter`, `githubWriteTools`, `githubReadMcpServer` to this same file.

GitHub's scheme: `X-Hub-Signature-256` header is `sha256=` + hex HMAC-SHA256 of the raw body keyed by the webhook secret.

- [ ] **Step 1: Write the failing tests**

`src/github.test.ts`:
```typescript
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyGithubSignature } from './github.js';

const SECRET = 'test-webhook-secret';

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifyGithubSignature', () => {
  const body = '{"action":"opened"}';

  it('accepts a valid signature', () => {
    expect(verifyGithubSignature(SECRET, body, sign(body))).toBe(true);
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(verifyGithubSignature(SECRET, body, sign(body, 'wrong'))).toBe(false);
  });

  it('rejects a tampered body', () => {
    expect(verifyGithubSignature(SECRET, body + 'x', sign(body))).toBe(false);
  });

  it('rejects a missing/malformed header', () => {
    expect(verifyGithubSignature(SECRET, body, '')).toBe(false);
    expect(verifyGithubSignature(SECRET, body, 'sha1=abcdef')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/github.test.ts`
Expected: FAIL — `Cannot find module './github.js'`.

- [ ] **Step 3: Implement**

`src/github.ts`:
```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyGithubSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string,
): boolean {
  if (!signatureHeader.startsWith('sha256=')) return false;
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
  );
  const actual = Buffer.from(signatureHeader);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/github.test.ts` — Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/github.ts src/github.test.ts
git commit -m "feat: GitHub webhook signature verification"
```

---

### Task 4: Event type and concurrency-capped dispatcher

**Files:**
- Create: `src/agent.ts`, `src/agent.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces, exported from `src/agent.ts`:
  - `interface WebhookEvent { source: 'slack' | 'github'; name: string; payload: unknown; }`
  - `type Dispatch = (event: WebhookEvent) => void;`
  - `createDispatcher(run: (event: WebhookEvent) => Promise<void>, maxConcurrent?: number): Dispatch` — fire-and-forget, at most `maxConcurrent` (default 3) runs in flight, excess FIFO-queued, run errors caught and logged (never unhandled rejections).

Task 5 adds `runAgent` to this same file.

- [ ] **Step 1: Write the failing tests**

`src/agent.test.ts`:
```typescript
import { describe, expect, it } from 'vitest';
import { createDispatcher, type WebhookEvent } from './agent.js';

function event(name: string): WebhookEvent {
  return { source: 'slack', name, payload: {} };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function tick() {
  await new Promise((r) => setImmediate(r));
}

describe('createDispatcher', () => {
  it('runs events as they arrive, up to the cap', async () => {
    const running: string[] = [];
    const gate = deferred();
    const dispatch = createDispatcher(async (e) => {
      running.push(e.name);
      await gate.promise;
    }, 2);

    dispatch(event('a'));
    dispatch(event('b'));
    dispatch(event('c'));
    await tick();
    expect(running).toEqual(['a', 'b']); // c is queued, cap is 2

    gate.resolve();
    await tick();
    expect(running).toEqual(['a', 'b', 'c']); // c drained from queue
  });

  it('continues past a failed run and still drains the queue', async () => {
    const done: string[] = [];
    const dispatch = createDispatcher(async (e) => {
      if (e.name === 'boom') throw new Error('boom');
      done.push(e.name);
    }, 1);

    dispatch(event('boom'));
    dispatch(event('ok'));
    await tick();
    await tick();
    expect(done).toEqual(['ok']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agent.test.ts`
Expected: FAIL — `Cannot find module './agent.js'`.

- [ ] **Step 3: Implement**

`src/agent.ts`:
```typescript
export interface WebhookEvent {
  source: 'slack' | 'github';
  name: string;
  payload: unknown;
}

export type Dispatch = (event: WebhookEvent) => void;

export function createDispatcher(
  run: (event: WebhookEvent) => Promise<void>,
  maxConcurrent = 3,
): Dispatch {
  const queue: WebhookEvent[] = [];
  let inFlight = 0;

  function drain(): void {
    while (inFlight < maxConcurrent && queue.length > 0) {
      const event = queue.shift()!;
      inFlight++;
      run(event)
        .catch((err) => {
          console.error('agent run failed', { event, err });
        })
        .finally(() => {
          inFlight--;
          drain();
        });
    }
  }

  return (event) => {
    queue.push(event);
    drain();
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/agent.test.ts` — Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts src/agent.test.ts
git commit -m "feat: webhook event type and concurrency-capped dispatcher"
```

---

### Task 5: Agent tools and runAgent

**Files:**
- Modify: `src/slack.ts` (append `slackTools`)
- Modify: `src/github.ts` (append `githubWriteTools`, `githubReadMcpServer`)
- Modify: `src/agent.ts` (append `runAgent`)

**Interfaces:**
- Consumes: `WebhookEvent` from Task 4.
- Produces:
  - `slackTools(client: WebClient)` from `src/slack.ts` — array of SDK `tool()` definitions: `post_message`, `read_thread`, `channel_history`.
  - `githubWriteTools(octokit: Octokit)` from `src/github.ts` — array with `comment`.
  - `githubReadMcpServer(token: string)` from `src/github.ts` — remote MCP server config object.
  - `runAgent(deps: AgentDeps, event: WebhookEvent): Promise<void>` from `src/agent.ts`, where `interface AgentDeps { slack: WebClient; octokit: Octokit; githubToken: string; }`.

No unit tests for this task (network-bound glue; the spec assigns it manual end-to-end verification in Task 7). The gate is `npm run typecheck`.

- [ ] **Step 1: Append slackTools to src/slack.ts**

```typescript
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { WebClient } from '@slack/web-api';
import { z } from 'zod';
```
(merge with existing imports at top of file)

```typescript
export function slackTools(client: WebClient) {
  return [
    tool(
      'post_message',
      'Post a message to a Slack channel, or to a thread if thread_ts is given.',
      {
        channel: z.string().describe('Channel ID, e.g. C0123456789'),
        text: z.string(),
        thread_ts: z.string().optional().describe('Parent message ts to reply in-thread'),
      },
      async ({ channel, text, thread_ts }) => {
        const res = await client.chat.postMessage({ channel, text, thread_ts });
        return { content: [{ type: 'text', text: `posted (ts=${res.ts})` }] };
      },
    ),
    tool(
      'read_thread',
      'Read all replies in a Slack thread.',
      {
        channel: z.string(),
        thread_ts: z.string().describe('ts of the thread parent message'),
      },
      async ({ channel, thread_ts }) => {
        const res = await client.conversations.replies({ channel, ts: thread_ts, limit: 50 });
        const lines = (res.messages ?? []).map((m) => `[${m.user ?? m.bot_id}] ${m.text}`);
        return { content: [{ type: 'text', text: lines.join('\n') || '(empty thread)' }] };
      },
    ),
    tool(
      'channel_history',
      'Read recent messages in a Slack channel (newest first).',
      {
        channel: z.string(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      async ({ channel, limit }) => {
        const res = await client.conversations.history({ channel, limit });
        const lines = (res.messages ?? []).map((m) => `[${m.user ?? m.bot_id}] ${m.text}`);
        return { content: [{ type: 'text', text: lines.join('\n') || '(no messages)' }] };
      },
    ),
  ];
}
```

- [ ] **Step 2: Append GitHub tool + MCP config to src/github.ts**

```typescript
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { Octokit } from 'octokit';
import { z } from 'zod';
```
(merge with existing imports)

```typescript
export function githubWriteTools(octokit: Octokit) {
  return [
    tool(
      'comment',
      'Comment on a GitHub issue or pull request.',
      {
        owner: z.string(),
        repo: z.string(),
        issue_number: z.number().int().describe('Issue or PR number'),
        body: z.string(),
      },
      async ({ owner, repo, issue_number, body }) => {
        const res = await octokit.rest.issues.createComment({ owner, repo, issue_number, body });
        return { content: [{ type: 'text', text: `commented: ${res.data.html_url}` }] };
      },
    ),
  ];
}

export function githubReadMcpServer(token: string) {
  return {
    type: 'http' as const,
    url: 'https://api.githubcopilot.com/mcp/',
    headers: { Authorization: `Bearer ${token}` },
  };
}
```

- [ ] **Step 3: Append runAgent to src/agent.ts**

```typescript
import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';
import type { WebClient } from '@slack/web-api';
import type { Octokit } from 'octokit';
import { githubReadMcpServer, githubWriteTools } from './github.js';
import { slackTools } from './slack.js';
```
(merge with existing imports; note `slack.ts`/`github.ts` must NOT import values from `agent.ts` — only `import type` — to keep the cycle type-only)

```typescript
export interface AgentDeps {
  slack: WebClient;
  octokit: Octokit;
  githubToken: string;
}

const SYSTEM_PROMPT = `You are "micromanager", an agent that keeps a software team moving.
You receive one webhook event (from Slack or GitHub) per run. Decide whether it
warrants action. You may look things up with your GitHub read tools and Slack
read tools before acting. If action is warranted, act via slack post_message or
github comment. Be sparing: most events need no response. Never respond to
messages authored by bots (including yourself). When you act, be concise,
specific, and constructive. If no action is needed, simply end the run.`;

export async function runAgent(deps: AgentDeps, event: WebhookEvent): Promise<void> {
  const slackServer = createSdkMcpServer({
    name: 'slack',
    version: '1.0.0',
    tools: slackTools(deps.slack),
  });
  const githubWriteServer = createSdkMcpServer({
    name: 'github-write',
    version: '1.0.0',
    tools: githubWriteTools(deps.octokit),
  });

  const prompt = `Webhook event received.\nSource: ${event.source}\nEvent: ${event.name}\nPayload:\n${JSON.stringify(event.payload, null, 2)}`;

  for await (const message of query({
    prompt,
    options: {
      model: 'claude-sonnet-5',
      systemPrompt: SYSTEM_PROMPT,
      maxTurns: 10,
      tools: [],
      mcpServers: {
        slack: slackServer,
        'github-write': githubWriteServer,
        github: githubReadMcpServer(deps.githubToken),
      },
      allowedTools: [
        'mcp__slack__post_message',
        'mcp__slack__read_thread',
        'mcp__slack__channel_history',
        'mcp__github-write__comment',
        'mcp__github__*',
      ],
    },
  })) {
    if (message.type === 'result') {
      console.log('agent run finished', {
        event: `${event.source}:${event.name}`,
        subtype: message.subtype,
      });
    }
  }
}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — Expected: exit 0.
If the SDK's actual option names differ from the above (`tools`, `systemPrompt`, `mcpServers`, `allowedTools`), consult `node_modules/@anthropic-ai/claude-agent-sdk/` type declarations and adapt — the *intent* (no built-in tools, restricted allowlist, these three servers) is the requirement.
Run: `npm test` — Expected: all previous tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/slack.ts src/github.ts src/agent.ts
git commit -m "feat: agent tools and runAgent over the Agent SDK"
```

---

### Task 6: Webhook routers

**Files:**
- Modify: `src/slack.ts` (append `slackRouter`), `src/slack.test.ts` (append router tests)
- Modify: `src/github.ts` (append `githubRouter`), `src/github.test.ts` (append router tests)

**Interfaces:**
- Consumes: `verifySlackSignature`, `verifyGithubSignature`, `Dispatch`, `WebhookEvent`.
- Produces:
  - `slackRouter(opts: { signingSecret: string; dispatch: Dispatch }): Router` — handles `POST /webhooks/slack`.
  - `githubRouter(opts: { webhookSecret: string; dispatch: Dispatch }): Router` — handles `POST /webhooks/github`.
  - Both intended to be mounted at `/` by `server.ts`.

- [ ] **Step 1: Write the failing Slack router tests**

Append to `src/slack.test.ts`:
```typescript
import express from 'express';
import request from 'supertest';
import { slackRouter } from './slack.js';
import type { WebhookEvent } from './agent.js';

function slackApp(dispatched: WebhookEvent[]) {
  const app = express();
  app.use(slackRouter({ signingSecret: SECRET, dispatch: (e) => dispatched.push(e) }));
  return app;
}

function slackHeaders(body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  return { 'x-slack-request-timestamp': ts, 'x-slack-signature': sign(ts, body) };
}

describe('slackRouter', () => {
  it('rejects an unsigned request with 401 and dispatches nothing', async () => {
    const dispatched: WebhookEvent[] = [];
    await request(slackApp(dispatched))
      .post('/webhooks/slack')
      .set('content-type', 'application/json')
      .send('{"type":"event_callback"}')
      .expect(401);
    expect(dispatched).toEqual([]);
  });

  it('answers the url_verification challenge', async () => {
    const dispatched: WebhookEvent[] = [];
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const res = await request(slackApp(dispatched))
      .post('/webhooks/slack')
      .set(slackHeaders(body))
      .set('content-type', 'application/json')
      .send(body)
      .expect(200);
    expect(res.body).toEqual({ challenge: 'abc123' });
    expect(dispatched).toEqual([]);
  });

  it('acks and dispatches a valid event_callback', async () => {
    const dispatched: WebhookEvent[] = [];
    const body = JSON.stringify({
      type: 'event_callback',
      event: { type: 'app_mention', user: 'U1', text: 'hi' },
    });
    await request(slackApp(dispatched))
      .post('/webhooks/slack')
      .set(slackHeaders(body))
      .set('content-type', 'application/json')
      .send(body)
      .expect(200);
    expect(dispatched).toEqual([
      { source: 'slack', name: 'app_mention', payload: { type: 'app_mention', user: 'U1', text: 'hi' } },
    ]);
  });

  it('does not dispatch bot-authored events (self-trigger guard)', async () => {
    const dispatched: WebhookEvent[] = [];
    const body = JSON.stringify({
      type: 'event_callback',
      event: { type: 'message', bot_id: 'B99', text: 'I am a bot' },
    });
    await request(slackApp(dispatched))
      .post('/webhooks/slack')
      .set(slackHeaders(body))
      .set('content-type', 'application/json')
      .send(body)
      .expect(200);
    expect(dispatched).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/slack.test.ts`
Expected: FAIL — `slackRouter` not exported.

- [ ] **Step 3: Implement slackRouter in src/slack.ts**

```typescript
import express, { Router } from 'express';
import type { Dispatch } from './agent.js';
```
(merge with existing imports)

```typescript
export function slackRouter(opts: { signingSecret: string; dispatch: Dispatch }): Router {
  const router = Router();
  router.post('/webhooks/slack', express.raw({ type: '*/*' }), (req, res) => {
    const rawBody = (req.body as Buffer).toString('utf8');
    const timestamp = req.header('x-slack-request-timestamp') ?? '';
    const signature = req.header('x-slack-signature') ?? '';
    if (!verifySlackSignature(opts.signingSecret, timestamp, signature, rawBody)) {
      res.status(401).send('bad signature');
      return;
    }

    const payload = JSON.parse(rawBody);
    if (payload.type === 'url_verification') {
      res.json({ challenge: payload.challenge });
      return;
    }

    res.sendStatus(200);
    if (payload.type === 'event_callback' && payload.event) {
      const event = payload.event;
      if (event.bot_id || event.subtype === 'bot_message') return; // never react to bots (incl. ourselves)
      opts.dispatch({ source: 'slack', name: event.type ?? 'unknown', payload: event });
    }
  });
  return router;
}
```

- [ ] **Step 4: Run Slack tests**

Run: `npx vitest run src/slack.test.ts` — Expected: all pass (5 verifier + 4 router).

- [ ] **Step 5: Write the failing GitHub router tests**

Append to `src/github.test.ts`:
```typescript
import express from 'express';
import request from 'supertest';
import { githubRouter } from './github.js';
import type { WebhookEvent } from './agent.js';

function githubApp(dispatched: WebhookEvent[]) {
  const app = express();
  app.use(githubRouter({ webhookSecret: SECRET, dispatch: (e) => dispatched.push(e) }));
  return app;
}

describe('githubRouter', () => {
  it('rejects a bad signature with 401 and dispatches nothing', async () => {
    const dispatched: WebhookEvent[] = [];
    await request(githubApp(dispatched))
      .post('/webhooks/github')
      .set('x-hub-signature-256', 'sha256=deadbeef')
      .set('x-github-event', 'pull_request')
      .set('content-type', 'application/json')
      .send('{"action":"opened"}')
      .expect(401);
    expect(dispatched).toEqual([]);
  });

  it('acks and dispatches a valid delivery', async () => {
    const dispatched: WebhookEvent[] = [];
    const body = JSON.stringify({ action: 'opened', number: 7 });
    await request(githubApp(dispatched))
      .post('/webhooks/github')
      .set('x-hub-signature-256', sign(body))
      .set('x-github-event', 'pull_request')
      .set('content-type', 'application/json')
      .send(body)
      .expect(200);
    expect(dispatched).toEqual([
      { source: 'github', name: 'pull_request', payload: { action: 'opened', number: 7 } },
    ]);
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run src/github.test.ts`
Expected: FAIL — `githubRouter` not exported.

- [ ] **Step 7: Implement githubRouter in src/github.ts**

```typescript
import express, { Router } from 'express';
import type { Dispatch } from './agent.js';
```
(merge with existing imports)

```typescript
export function githubRouter(opts: { webhookSecret: string; dispatch: Dispatch }): Router {
  const router = Router();
  router.post('/webhooks/github', express.raw({ type: '*/*' }), (req, res) => {
    const rawBody = (req.body as Buffer).toString('utf8');
    const signature = req.header('x-hub-signature-256') ?? '';
    if (!verifyGithubSignature(opts.webhookSecret, rawBody, signature)) {
      res.status(401).send('bad signature');
      return;
    }

    res.sendStatus(200);
    opts.dispatch({
      source: 'github',
      name: req.header('x-github-event') ?? 'unknown',
      payload: JSON.parse(rawBody),
    });
  });
  return router;
}
```

- [ ] **Step 8: Run all tests**

Run: `npm test` — Expected: all pass.
Run: `npm run typecheck` — Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/slack.ts src/slack.test.ts src/github.ts src/github.test.ts
git commit -m "feat: verified webhook routes for Slack and GitHub"
```

---

### Task 7: Server assembly and end-to-end smoke

**Files:**
- Modify: `src/server.ts` (replace stub)
- Create: `scripts/send-test-webhook.ts`

**Interfaces:**
- Consumes: `slackRouter`, `githubRouter`, `createDispatcher`, `runAgent`, `AgentDeps`.
- Produces: running server (`npm run dev`); `GET /healthz` → 200 `ok`.

- [ ] **Step 1: Implement src/server.ts**

```typescript
import 'dotenv/config';
import express from 'express';
import { WebClient } from '@slack/web-api';
import { Octokit } from 'octokit';
import { createDispatcher, runAgent, type AgentDeps } from './agent.js';
import { githubRouter } from './github.js';
import { slackRouter } from './slack.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const config = {
  port: Number(process.env.PORT ?? 3000),
  slackBotToken: requireEnv('SLACK_BOT_TOKEN'),
  slackSigningSecret: requireEnv('SLACK_SIGNING_SECRET'),
  githubToken: requireEnv('GITHUB_TOKEN'),
  githubWebhookSecret: requireEnv('GITHUB_WEBHOOK_SECRET'),
};
requireEnv('ANTHROPIC_API_KEY'); // consumed by the Agent SDK directly

const deps: AgentDeps = {
  slack: new WebClient(config.slackBotToken),
  octokit: new Octokit({ auth: config.githubToken }),
  githubToken: config.githubToken,
};
const dispatch = createDispatcher((event) => runAgent(deps, event));

const app = express();
app.get('/healthz', (_req, res) => res.send('ok'));
app.use(slackRouter({ signingSecret: config.slackSigningSecret, dispatch }));
app.use(githubRouter({ webhookSecret: config.githubWebhookSecret, dispatch }));

app.listen(config.port, () => {
  console.log(`micromanager listening on :${config.port}`);
});
```

- [ ] **Step 2: Write scripts/send-test-webhook.ts**

A local sender that signs a sample payload the same way Slack/GitHub would, so the full path (signature → route → dispatcher → agent) can be exercised without public ingress:

```typescript
import 'dotenv/config';
import { createHmac } from 'node:crypto';

const kind = process.argv[2]; // 'slack' | 'github'
const base = `http://localhost:${process.env.PORT ?? 3000}`;

async function main() {
  if (kind === 'slack') {
    const body = JSON.stringify({
      type: 'event_callback',
      event: { type: 'app_mention', user: 'U_TEST', text: 'status update please', channel: process.env.TEST_SLACK_CHANNEL ?? 'C_TEST' },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac('sha256', process.env.SLACK_SIGNING_SECRET!).update(`v0:${ts}:${body}`).digest('hex')}`;
    const res = await fetch(`${base}/webhooks/slack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': sig },
      body,
    });
    console.log('slack webhook →', res.status);
  } else if (kind === 'github') {
    const body = JSON.stringify({ action: 'opened', number: 1, repository: { full_name: 'example/repo' } });
    const sig = `sha256=${createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET!).update(body).digest('hex')}`;
    const res = await fetch(`${base}/webhooks/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig, 'x-github-event': 'pull_request' },
      body,
    });
    console.log('github webhook →', res.status);
  } else {
    console.error('usage: tsx scripts/send-test-webhook.ts slack|github');
    process.exit(1);
  }
}
main();
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck` — Expected: exit 0 (note: `scripts/` is outside tsconfig `include`; typecheck it with `npx tsc --noEmit scripts/send-test-webhook.ts` or just confirm it runs).
Run: `npm test` — Expected: all pass.
With a populated `.env`: `npm run dev` in one terminal; `curl -s localhost:3000/healthz` → `ok`; `npx tsx scripts/send-test-webhook.ts github` → `github webhook → 200` and the server logs an agent run (requires valid `ANTHROPIC_API_KEY`; Slack/GitHub tool calls may fail with test IDs — that's acceptable for the smoke, the agent run starting and finishing is the gate). Without a populated `.env`, run typecheck+tests only and report that the live smoke needs credentials.

- [ ] **Step 4: Commit**

```bash
git add src/server.ts scripts/send-test-webhook.ts
git commit -m "feat: server assembly, healthz, and signed test-webhook sender"
```
