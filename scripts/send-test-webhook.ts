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
