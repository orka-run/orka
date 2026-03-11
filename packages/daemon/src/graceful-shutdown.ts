export class GracefulShutdown {
  private isShuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private cleanupTasks: Array<() => Promise<void>> = [];

  /** Register a cleanup task to run on shutdown */
  onShutdown(task: () => Promise<void>): void {
    this.cleanupTasks.push(task);
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
      try {
        await task();
      } catch (err) {
        console.error("Cleanup task failed:", err);
      }
    }
  }
}
