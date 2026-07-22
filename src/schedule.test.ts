import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookEvent } from './agent.js';
import { startSweepScheduler } from './schedule.js';

describe('startSweepScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispatches a sweep event every interval with repos and channel in the payload', () => {
    const dispatched: WebhookEvent[] = [];
    startSweepScheduler({
      intervalMinutes: 30,
      dispatch: (e) => dispatched.push(e),
      repos: ['acme/api', 'acme/web'],
      slackChannel: 'C123',
    });

    expect(dispatched).toEqual([]); // nothing before the first interval elapses
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(dispatched).toEqual([
      {
        source: 'schedule',
        name: 'overdue_issue_sweep',
        payload: { repos: ['acme/api', 'acme/web'], slackChannel: 'C123' },
      },
    ]);
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(dispatched).toHaveLength(2);
  });

  it('does nothing when intervalMinutes is 0', () => {
    const dispatched: WebhookEvent[] = [];
    startSweepScheduler({ intervalMinutes: 0, dispatch: (e) => dispatched.push(e), repos: [] });
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(dispatched).toEqual([]);
  });

  it('stops dispatching after the stop function is called', () => {
    const dispatched: WebhookEvent[] = [];
    const stop = startSweepScheduler({
      intervalMinutes: 5,
      dispatch: (e) => dispatched.push(e),
      repos: [],
    });
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(dispatched).toHaveLength(1);
    stop();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(dispatched).toHaveLength(1);
  });
});
