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
