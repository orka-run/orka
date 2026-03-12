interface CleanupTask {
  name: string;
  fn: () => Promise<void>;
}

export class GracefulShutdown {
  private isShuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private cleanupTasks: CleanupTask[] = [];

  /** Register a named cleanup task to run on shutdown */
  onShutdown(name: string, task: () => Promise<void>): void {
    this.cleanupTasks.push({ name, fn: task });
  }

  /** Check if shutdown is in progress */
  get shuttingDown(): boolean {
    return this.isShuttingDown;
  }

  /** Initiate graceful shutdown */
  shutdown(opts?: { timeout?: number }): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.isShuttingDown = true;

    const timeout = opts?.timeout ?? 30_000;

    this.shutdownPromise = Promise.race([
      this.runCleanup(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("Shutdown timeout")), timeout).unref()
      ),
    ]).catch(err => {
      console.error("Shutdown error:", err.message);
    });

    return this.shutdownPromise;
  }

  private async runCleanup(): Promise<void> {
    for (const task of this.cleanupTasks) {
      const start = Date.now();
      try {
        await task.fn();
      } catch (err) {
        console.error(`Shutdown task "${task.name}" failed:`, err);
      }
      const elapsed = Date.now() - start;
      if (elapsed > 500) {
        console.warn(`Shutdown task "${task.name}" took ${elapsed}ms`);
      }
    }
  }
}
