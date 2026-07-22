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
