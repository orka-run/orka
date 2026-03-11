/**
 * Exponential backoff with jitter for WebSocket reconnection.
 * Used by both daemon (node → relay) and CLI (client → relay/daemon).
 */
export class ReconnectStrategy {
  private attempt = 0;
  private readonly maxDelay: number;
  private readonly baseDelay: number;
  private readonly jitterFactor: number;

  constructor(opts?: { baseDelay?: number; maxDelay?: number; jitterFactor?: number }) {
    this.baseDelay = opts?.baseDelay ?? 1_000;
    this.maxDelay = opts?.maxDelay ?? 60_000;
    this.jitterFactor = opts?.jitterFactor ?? 0.3;
  }

  /** Get the next delay in milliseconds and increment the attempt counter. */
  nextDelay(): number {
    const delay = Math.min(this.baseDelay * Math.pow(2, this.attempt), this.maxDelay);
    const jitter = delay * this.jitterFactor * (Math.random() * 2 - 1);
    this.attempt++;
    return Math.max(100, Math.round(delay + jitter));
  }

  /** Reset the attempt counter (call on successful connection). */
  reset(): void {
    this.attempt = 0;
  }

  /** Current attempt number. */
  get attempts(): number {
    return this.attempt;
  }
}
