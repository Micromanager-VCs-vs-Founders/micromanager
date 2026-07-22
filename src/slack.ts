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
