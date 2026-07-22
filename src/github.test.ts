import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { githubRouter, verifyGithubSignature } from './github.js';
import type { WebhookEvent } from './agent.js';

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

  it('does not dispatch bot-sender deliveries (self-trigger guard)', async () => {
    const dispatched: WebhookEvent[] = [];
    const body = JSON.stringify({ action: 'created', sender: { login: 'micromanager[bot]', type: 'Bot' } });
    await request(githubApp(dispatched))
      .post('/webhooks/github')
      .set('x-hub-signature-256', sign(body))
      .set('x-github-event', 'issue_comment')
      .set('content-type', 'application/json')
      .send(body)
      .expect(200);
    expect(dispatched).toEqual([]);
  });

  it('does not dispatch issue_comment deliveries even from human senders (PAT echo guard)', async () => {
    const dispatched: WebhookEvent[] = [];
    const body = JSON.stringify({ action: 'created', sender: { login: 'hstanford', type: 'User' } });
    await request(githubApp(dispatched))
      .post('/webhooks/github')
      .set('x-hub-signature-256', sign(body))
      .set('x-github-event', 'issue_comment')
      .set('content-type', 'application/json')
      .send(body)
      .expect(200);
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
