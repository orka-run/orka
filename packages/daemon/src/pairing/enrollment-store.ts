/**
 * Pending enrollment management for node-side pairing.
 *
 * When a node operator runs `orka node pair start`, the daemon creates a pending
 * enrollment. This enrollment record lives in memory (not in the database) and
 * has a short TTL. The pairing client connects via relay, completes SPAKE2
 * handshake, and the enrollment is consumed.
 */

import { blake3, blake3Truncated, concatBytes } from "@orka/core/crypto/protocol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingEnrollment {
  enrollId: string;
  /** Raw SPAKE2 password. Cleared (zeroed) on consume/expiry. */
  secret: Uint8Array;
  secretHash: Uint8Array;
  expiresAt: number;
  attemptsLeft: number;
  used: boolean;
  nodeTransportStaticPubkey: Uint8Array;
  nodeId: string;
  nodeName: string;
  relayPaths: string[];
}

export interface CreateEnrollmentOpts {
  secret: Uint8Array;
  nodeId: string;
  nodeName: string;
  nodeTransportStaticPubkey: Uint8Array;
  relayPaths: string[];
  ttlMs?: number;
  maxAttempts?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENROLL_ID_PREFIX = "orka/pair/v1/enroll-id";
const DEFAULT_TTL_MS = 600_000; // 10 minutes
const DEFAULT_MAX_ATTEMPTS = 8;
const CLEANUP_INTERVAL_MS = 30_000; // 30 seconds
const ENROLL_ID_BYTES = 8; // 8 bytes = 16 hex chars

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

function deriveEnrollId(secret: Uint8Array): string {
  const input = concatBytes(textEncoder.encode(ENROLL_ID_PREFIX), secret);
  const hash = blake3Truncated(input, ENROLL_ID_BYTES);
  return Buffer.from(hash).toString("hex");
}

function computeSecretHash(secret: Uint8Array): Uint8Array {
  return blake3(secret);
}

// ---------------------------------------------------------------------------
// EnrollmentStore
// ---------------------------------------------------------------------------

export class EnrollmentStore {
  private readonly enrollments = new Map<string, PendingEnrollment>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  /**
   * Create a new pending enrollment.
   * Returns the enrollId (8-byte hex string).
   */
  create(opts: CreateEnrollmentOpts): string {
    const enrollId = deriveEnrollId(opts.secret);
    const secretHash = computeSecretHash(opts.secret);
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    // Copy the secret so the caller can't mutate our internal state
    const secret = new Uint8Array(opts.secret);

    const enrollment: PendingEnrollment = {
      enrollId,
      secret,
      secretHash,
      expiresAt: Date.now() + ttlMs,
      attemptsLeft: maxAttempts,
      used: false,
      nodeTransportStaticPubkey: opts.nodeTransportStaticPubkey,
      nodeId: opts.nodeId,
      nodeName: opts.nodeName,
      relayPaths: opts.relayPaths,
    };

    this.enrollments.set(enrollId, enrollment);
    return enrollId;
  }

  /**
   * Look up enrollment by enrollId.
   * Returns null if not found or expired.
   */
  get(enrollId: string): PendingEnrollment | null {
    const enrollment = this.enrollments.get(enrollId);
    if (!enrollment) return null;
    if (Date.now() >= enrollment.expiresAt) {
      enrollment.secret.fill(0);
      this.enrollments.delete(enrollId);
      return null;
    }
    return enrollment;
  }

  /**
   * Record a failed attempt.
   * Returns remaining attempts. Destroys enrollment if 0.
   */
  recordFailedAttempt(enrollId: string): number {
    const enrollment = this.enrollments.get(enrollId);
    if (!enrollment) return 0;

    enrollment.attemptsLeft--;
    if (enrollment.attemptsLeft <= 0) {
      enrollment.secret.fill(0);
      this.enrollments.delete(enrollId);
      return 0;
    }
    return enrollment.attemptsLeft;
  }

  /**
   * Mark enrollment as used (successful pairing).
   */
  markUsed(enrollId: string): void {
    const enrollment = this.enrollments.get(enrollId);
    if (enrollment) {
      enrollment.used = true;
      // Zero out the raw secret — no longer needed after successful pairing
      enrollment.secret.fill(0);
    }
  }

  /**
   * Remove an enrollment.
   */
  remove(enrollId: string): void {
    const enrollment = this.enrollments.get(enrollId);
    if (enrollment) {
      enrollment.secret.fill(0);
      this.enrollments.delete(enrollId);
    }
  }

  /**
   * Get count of active (non-expired) enrollments.
   */
  get activeCount(): number {
    const now = Date.now();
    let count = 0;
    for (const enrollment of this.enrollments.values()) {
      if (now < enrollment.expiresAt) {
        count++;
      }
    }
    return count;
  }

  /**
   * Cleanup expired enrollments.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [id, enrollment] of this.enrollments) {
      if (now >= enrollment.expiresAt) {
        enrollment.secret.fill(0);
        this.enrollments.delete(id);
      }
    }
  }

  /**
   * Shutdown: clear cleanup interval and remove all enrollments.
   */
  shutdown(): void {
    clearInterval(this.cleanupTimer);
    for (const enrollment of this.enrollments.values()) {
      enrollment.secret.fill(0);
    }
    this.enrollments.clear();
  }
}
