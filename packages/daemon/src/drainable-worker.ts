// DrainableWorker pattern inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
// See: packages/shared/src/DrainableWorker.ts

export interface DrainableWorker<T> {
  /** Enqueue a work item. Processing starts immediately if idle. */
  enqueue(item: T): void;
  /** Resolves when queue is empty AND current item finished processing. */
  drain(): Promise<void>;
  /** Number of items currently queued (not including the one being processed). */
  readonly pending: number;
  /** Whether the worker is currently processing an item. */
  readonly processing: boolean;
  /** Shut down the worker. Rejects further enqueue calls. */
  shutdown(): void;
}

export function createDrainableWorker<T>(
  process: (item: T) => Promise<void>,
): DrainableWorker<T> {
  const queue: T[] = [];
  const drainResolvers: Array<() => void> = [];
  let isProcessing = false;
  let isShutdown = false;

  const resolveDrainsIfIdle = (): void => {
    if (isProcessing || queue.length > 0) {
      return;
    }

    const resolvers = drainResolvers.splice(0, drainResolvers.length);
    for (const resolve of resolvers) {
      resolve();
    }
  };

  const runNext = (): void => {
    if (isProcessing) {
      return;
    }

    if (queue.length === 0) {
      resolveDrainsIfIdle();
      return;
    }

    const item = queue.shift() as T;
    isProcessing = true;

    void (async () => {
      try {
        await process(item);
      } catch {
        // Keep draining even if an item-level handler fails.
      }

      isProcessing = false;

      if (queue.length > 0) {
        runNext();
      } else {
        resolveDrainsIfIdle();
      }
    })();
  };

  return {
    enqueue(item: T): void {
      if (isShutdown) {
        throw new Error("DrainableWorker is shut down");
      }

      queue.push(item);
      runNext();
    },

    drain(): Promise<void> {
      if (!isProcessing && queue.length === 0) {
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        drainResolvers.push(resolve);
      });
    },

    get pending(): number {
      return queue.length;
    },

    get processing(): boolean {
      return isProcessing;
    },

    shutdown(): void {
      isShutdown = true;
    },
  };
}
