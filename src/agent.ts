export interface WebhookEvent {
  source: 'slack' | 'github';
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
