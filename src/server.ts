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
app.get('/healthz', (_req, res) => {
  res.send('ok');
});
app.use(slackRouter({ signingSecret: config.slackSigningSecret, dispatch }));
app.use(githubRouter({ webhookSecret: config.githubWebhookSecret, dispatch }));

app.listen(config.port, () => {
  console.log(`micromanager listening on :${config.port}`);
});
