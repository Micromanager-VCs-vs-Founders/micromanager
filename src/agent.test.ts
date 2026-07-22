import { describe, expect, it } from 'vitest';
import { createDispatcher, type WebhookEvent } from './agent.js';

function event(name: string): WebhookEvent {
  return { source: 'slack', name, payload: {} };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

async function tick() {
  await new Promise((r) => setImmediate(r));
}

describe('createDispatcher', () => {
  it('runs events as they arrive, up to the cap', async () => {
    const running: string[] = [];
    const gate = deferred();
    const dispatch = createDispatcher(async (e) => {
      running.push(e.name);
      await gate.promise;
    }, 2);

    dispatch(event('a'));
    dispatch(event('b'));
    dispatch(event('c'));
    await tick();
    expect(running).toEqual(['a', 'b']); // c is queued, cap is 2

    gate.resolve();
    await tick();
    expect(running).toEqual(['a', 'b', 'c']); // c drained from queue
  });

  it('continues past a failed run and still drains the queue', async () => {
    const done: string[] = [];
    const dispatch = createDispatcher(async (e) => {
      if (e.name === 'boom') throw new Error('boom');
      done.push(e.name);
    }, 1);

    dispatch(event('boom'));
    dispatch(event('ok'));
    await tick();
    await tick();
    expect(done).toEqual(['ok']);
  });

  it('contains a run that throws synchronously and still drains the queue', async () => {
    const done: string[] = [];
    const dispatch = createDispatcher((e) => {
      if (e.name === 'sync-boom') throw new Error('sync-boom');
      return Promise.resolve().then(() => {
        done.push(e.name);
      });
    }, 1);

    expect(() => dispatch(event('sync-boom'))).not.toThrow();
    dispatch(event('ok'));
    await tick();
    await tick();
    expect(done).toEqual(['ok']);
  });
});
