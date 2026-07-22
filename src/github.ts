import { createHmac, timingSafeEqual } from 'node:crypto';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import express, { Router } from 'express';
import type { Octokit } from 'octokit';
import { z } from 'zod';
import type { Dispatch } from './agent.js';

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
    const payload = JSON.parse(rawBody);
    if (payload.sender?.type === 'Bot') return; // never react to bots (incl. our own comments)
    opts.dispatch({
      source: 'github',
      name: req.header('x-github-event') ?? 'unknown',
      payload,
    });
  });
  return router;
}
