import { describe, test, expect } from "bun:test";
import { createDrainableWorker } from "./drainable-worker";

describe("DrainableWorker", () => {
  test("processes items in FIFO order", async () => {
    const processed: number[] = [];
    const worker = createDrainableWorker(async (item: number) => {
      await Bun.sleep(10);
      processed.push(item);
    });

    worker.enqueue(1);
    worker.enqueue(2);
    worker.enqueue(3);

    await worker.drain();

    expect(processed).toEqual([1, 2, 3]);
  });

  test("drain resolves immediately when idle", async () => {
    const worker = createDrainableWorker(async () => {});
    await worker.drain();
  });

  test("drain waits for in-flight processing", async () => {
    let completed = false;
    const worker = createDrainableWorker(async () => {
      await Bun.sleep(50);
      completed = true;
    });

    worker.enqueue("work");

    await worker.drain();

    expect(completed).toBe(true);
  });

  test("multiple drain calls all resolve", async () => {
    const worker = createDrainableWorker(async () => {
      await Bun.sleep(20);
    });

    worker.enqueue("a");

    await Promise.all([
      worker.drain(),
      worker.drain(),
      worker.drain(),
    ]);
  });

  test("shutdown prevents further enqueue", () => {
    const worker = createDrainableWorker(async () => {});

    worker.shutdown();

    expect(() => worker.enqueue("x")).toThrow();
  });

  test("pending and processing reflect state", async () => {
    const worker = createDrainableWorker(async () => {
      await Bun.sleep(50);
    });

    expect(worker.pending).toBe(0);
    expect(worker.processing).toBe(false);

    worker.enqueue("a");
    worker.enqueue("b");

    await Bun.sleep(5);

    expect(worker.processing).toBe(true);
    expect(worker.pending).toBe(1);

    await worker.drain();

    expect(worker.pending).toBe(0);
    expect(worker.processing).toBe(false);
  });
});
