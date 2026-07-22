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
