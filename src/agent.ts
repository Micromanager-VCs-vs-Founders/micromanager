import { createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';
import type { WebClient } from '@slack/web-api';
import type { Octokit } from 'octokit';
import { githubReadMcpServer, githubWriteTools } from './github.js';
import { slackTools } from './slack.js';

export interface WebhookEvent {
  source: 'slack' | 'github' | 'schedule';
  name: string;
  payload: unknown;
}

export type Dispatch = (event: WebhookEvent) => void;

export function createDispatcher(
  run: (event: WebhookEvent) => Promise<void>,
  maxConcurrent = 3,
): Dispatch {
  const queue: WebhookEvent[] = [];
  let inFlight = 0;

  function drain(): void {
    while (inFlight < maxConcurrent && queue.length > 0) {
      const event = queue.shift()!;
      inFlight++;
      Promise.resolve()
        .then(() => run(event)) // wrapper so a synchronously-throwing run is contained too
        .catch((err) => {
          console.error('agent run failed', { event, err });
        })
        .finally(() => {
          inFlight--;
          drain();
        });
    }
  }

  return (event) => {
    queue.push(event);
    drain();
  };
}

export interface AgentDeps {
  slack: WebClient;
  octokit: Octokit;
  githubToken: string;
}

const SYSTEM_PROMPT = `You are "micromanager", an agent that keeps a software team moving.
You receive one webhook event (from Slack or GitHub) per run. Decide whether it
warrants action. You may look things up with your GitHub read tools and Slack
read tools before acting. If action is warranted, act via slack post_message or
github comment. Be sparing: most events need no response. Never respond to
messages authored by bots (including yourself). When you act, be concise,
specific, and constructive. If no action is needed, simply end the run.

On "overdue_issue_sweep" events: the payload names the repos to check (and
optionally a Slack channel for nudges). Use your GitHub read tools to find
open issues that look overdue or stalled — e.g. no activity for a week or
more, past a stated due date or milestone, or blocking labels with no
assignee movement. For the few most important ones, kickstart progress: nudge
the assignee (issue comment) or post a short prioritized summary to the Slack
channel. If nothing is overdue, do nothing.`;

export async function runAgent(deps: AgentDeps, event: WebhookEvent): Promise<void> {
  const slackServer = createSdkMcpServer({
    name: 'slack',
    version: '1.0.0',
    tools: slackTools(deps.slack),
  });
  const githubWriteServer = createSdkMcpServer({
    name: 'github-write',
    version: '1.0.0',
    tools: githubWriteTools(deps.octokit),
  });

  const prompt = `Webhook event received.\nSource: ${event.source}\nEvent: ${event.name}\nPayload:\n${JSON.stringify(event.payload, null, 2)}`;

  for await (const message of query({
    prompt,
    options: {
      model: 'claude-sonnet-5',
      systemPrompt: SYSTEM_PROMPT,
      maxTurns: 10,
      tools: [],
      mcpServers: {
        slack: slackServer,
        'github-write': githubWriteServer,
        github: githubReadMcpServer(deps.githubToken),
      },
      allowedTools: [
        'mcp__slack__post_message',
        'mcp__slack__read_thread',
        'mcp__slack__channel_history',
        'mcp__github-write__comment',
        'mcp__github__*',
      ],
    },
  })) {
    if (message.type === 'result') {
      console.log('agent run finished', {
        event: `${event.source}:${event.name}`,
        subtype: message.subtype,
      });
    }
  }
}
