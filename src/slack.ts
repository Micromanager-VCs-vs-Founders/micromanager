import { createHmac, timingSafeEqual } from 'node:crypto';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { WebClient } from '@slack/web-api';
import express, { Router } from 'express';
import { z } from 'zod';
import type { Dispatch } from './agent.js';

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
        try {
          const res = await client.chat.postMessage({ channel, text, thread_ts });
          console.log('slack post_message ok', { channel, ts: res.ts });
          return { content: [{ type: 'text', text: `posted (ts=${res.ts})` }] };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('slack post_message failed', { channel, error: msg });
          return { content: [{ type: 'text', text: `post failed: ${msg}` }] };
        }
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

export function slackRouter(opts: { signingSecret: string; dispatch: Dispatch }): Router {
  const router = Router();
  router.post('/webhooks/slack', express.raw({ type: '*/*' }), (req, res) => {
    const rawBody = (req.body as Buffer).toString('utf8');
    const timestamp = req.header('x-slack-request-timestamp') ?? '';
    const signature = req.header('x-slack-signature') ?? '';
    const retry = req.header('x-slack-retry-num');
    if (!verifySlackSignature(opts.signingSecret, timestamp, signature, rawBody)) {
      console.warn('slack webhook rejected: bad signature', {
        hasSignature: Boolean(signature),
        timestamp,
        retry,
      });
      res.status(401).send('bad signature');
      return;
    }

    const payload = JSON.parse(rawBody);
    if (payload.type === 'url_verification') {
      console.log('slack url_verification challenge answered');
      res.json({ challenge: payload.challenge });
      return;
    }

    res.sendStatus(200);
    if (payload.type === 'event_callback' && payload.event) {
      const event = payload.event;
      if (event.bot_id || event.subtype === 'bot_message') {
        console.log('slack event ignored (bot author)', { type: event.type });
        return; // never react to bots (incl. ourselves)
      }
      console.log('slack event dispatched', {
        type: event.type,
        user: event.user,
        channel: event.channel,
      });
      opts.dispatch({ source: 'slack', name: event.type ?? 'unknown', payload: event });
    } else {
      console.log('slack webhook received (no dispatch)', { type: payload.type });
    }
  });
  return router;
}
