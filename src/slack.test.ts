import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { slackRouter, verifySlackSignature } from './slack.js';
import type { WebhookEvent } from './agent.js';

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
