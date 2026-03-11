import { describe, expect, test } from "bun:test";
import { GracefulShutdown } from "./graceful-shutdown";

describe("GracefulShutdown", () => {
  test("cleanup tasks run in order", async () => {
    const shutdown = new GracefulShutdown();
    const order: number[] = [];

    shutdown.onShutdown(async () => { order.push(1); });
    shutdown.onShutdown(async () => { order.push(2); });
    shutdown.onShutdown(async () => { order.push(3); });

    await shutdown.shutdown();

    expect(order).toEqual([1, 2, 3]);
  });

  test("shutdown resolves after all tasks complete", async () => {
    const shutdown = new GracefulShutdown();
    let completed = false;

    shutdown.onShutdown(async () => {
      await new Promise(r => setTimeout(r, 50));
      completed = true;
    });

    await shutdown.shutdown();

    expect(completed).toBe(true);
  });

  test("double shutdown returns same promise", async () => {
    const shutdown = new GracefulShutdown();
    let callCount = 0;

    shutdown.onShutdown(async () => { callCount++; });

    const p1 = shutdown.shutdown();
    const p2 = shutdown.shutdown();

    expect(p1).toBe(p2);
    await p1;
    expect(callCount).toBe(1);
  });

  test("shuttingDown flag is set", async () => {
    const shutdown = new GracefulShutdown();

    expect(shutdown.shuttingDown).toBe(false);

    const promise = shutdown.shutdown();
    expect(shutdown.shuttingDown).toBe(true);

    await promise;
    expect(shutdown.shuttingDown).toBe(true);
  });

  test("timeout triggers if cleanup takes too long", async () => {
    const shutdown = new GracefulShutdown();
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errors.push(String(args[1] ?? args[0])); };

    shutdown.onShutdown(async () => {
      await new Promise(r => setTimeout(r, 5000));
    });

    await shutdown.shutdown({ timeout: 50 });

    console.error = origError;
    expect(errors.some(e => e.includes("Shutdown timeout"))).toBe(true);
  });

  test("failed cleanup tasks don't block others", async () => {
    const shutdown = new GracefulShutdown();
    const executed: string[] = [];
    const origError = console.error;
    console.error = () => {};

    shutdown.onShutdown(async () => { executed.push("first"); });
    shutdown.onShutdown(async () => { throw new Error("boom"); });
    shutdown.onShutdown(async () => { executed.push("third"); });

    await shutdown.shutdown();

    console.error = origError;
    expect(executed).toEqual(["first", "third"]);
  });
});
