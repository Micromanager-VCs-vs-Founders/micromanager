import type { Dispatch } from './agent.js';

export function startSweepScheduler(opts: {
  intervalMinutes: number;
  dispatch: Dispatch;
  repos: string[];
  slackChannel?: string;
}): () => void {
  if (opts.intervalMinutes <= 0) return () => {};

  const timer = setInterval(
    () => {
      opts.dispatch({
        source: 'schedule',
        name: 'overdue_issue_sweep',
        payload: { repos: opts.repos, slackChannel: opts.slackChannel },
      });
    },
    opts.intervalMinutes * 60 * 1000,
  );
  timer.unref?.(); // never keep the process alive just for sweeps
  return () => clearInterval(timer);
}
