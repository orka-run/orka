/**
 * Pairing Router — transparent bidirectional WebSocket forwarding for SPAKE2 bootstrap.
 *
 * Route: /v1/pair/<enroll_id>
 *
 * Flow (Option B):
 *   1. First WS connects → becomes "registrant" (waits in slot)
 *   2. Second WS connects → becomes "joiner" (triggers pairing)
 *   3. Relay forwards all messages between the two sockets as-is (opaque)
 *   4. On disconnect or TTL expiry, both sides are closed and slot is cleaned up
 *
 * The relay does NOT parse or understand the pairing protocol — it just
 * forwards raw WebSocket frames between the two matched parties.
 */

import type { ServerWebSocket } from "bun";
import type { AnySocketData } from "./state";

// --- Types ---

export interface PairingSlot {
  enrollId: string;
  firstWs: ServerWebSocket<AnySocketData>;
  secondWs?: ServerWebSocket<AnySocketData>;
  createdAt: number;
  ttlMs: number;
  timeoutId: Timer;
}

export interface PairingRouterOptions {
  /** Maximum concurrent pairing slots (default 100) */
  maxSlots?: number;
  /** TTL per slot in milliseconds (default 600_000 = 10 minutes) */
  defaultTtlMs?: number;
}

// --- Pairing Router ---

export class PairingRouter {
  private slots = new Map<string, PairingSlot>();
  /** Reverse lookup: ws → enrollId */
  private wsBySocket = new Map<ServerWebSocket<AnySocketData>, string>();

  private maxSlots: number;
  private defaultTtlMs: number;

  constructor(opts?: PairingRouterOptions) {
    this.maxSlots = opts?.maxSlots ?? 100;
    this.defaultTtlMs = opts?.defaultTtlMs ?? 600_000;
  }

  /**
   * Validate an enroll_id. Returns an error message if invalid, or null if OK.
   */
  validateEnrollId(enrollId: string): string | null {
    if (!enrollId || enrollId.length === 0) {
      return "Empty enroll_id";
    }
    if (enrollId.length > 128) {
      return "enroll_id too long (max 128 characters)";
    }
    // Allow alphanumeric, dash, underscore
    if (!/^[a-zA-Z0-9_-]+$/.test(enrollId)) {
      return "Invalid enroll_id format (alphanumeric, dash, underscore only)";
    }
    return null;
  }

  /**
   * Called when a WebSocket is opened for /v1/pair/<enroll_id>.
   * Returns { accepted: true } if the WS was accepted, or { accepted: false, reason: string }
   * if it was rejected (caller should close the WS with that reason).
   */
  handleConnection(
    enrollId: string,
    ws: ServerWebSocket<AnySocketData>,
  ): { accepted: true } | { accepted: false; reason: string } {
    const existing = this.slots.get(enrollId);

    if (existing) {
      // Slot exists — this is the second connection (joiner)
      if (existing.secondWs) {
        // Already paired — third connection rejected
        return { accepted: false, reason: "Pairing slot already full" };
      }

      existing.secondWs = ws;
      this.wsBySocket.set(ws, enrollId);
      return { accepted: true };
    }

    // No slot yet — this is the first connection (registrant)
    if (this.slots.size >= this.maxSlots) {
      return { accepted: false, reason: "Maximum pairing slots reached" };
    }

    const timeoutId = setTimeout(() => {
      this.expireSlot(enrollId);
    }, this.defaultTtlMs);
    timeoutId.unref();

    const slot: PairingSlot = {
      enrollId,
      firstWs: ws,
      createdAt: Date.now(),
      ttlMs: this.defaultTtlMs,
      timeoutId,
    };

    this.slots.set(enrollId, slot);
    this.wsBySocket.set(ws, enrollId);
    return { accepted: true };
  }

  /**
   * Forward a message from one side to the other.
   * Messages are opaque — relay does not parse them.
   */
  handleMessage(ws: ServerWebSocket<AnySocketData>, data: string | Buffer): void {
    const enrollId = this.wsBySocket.get(ws);
    if (!enrollId) return;

    const slot = this.slots.get(enrollId);
    if (!slot) return;

    // Determine the peer
    const peer = ws === slot.firstWs ? slot.secondWs : slot.firstWs;
    if (!peer) return; // Not yet paired, drop the message

    try {
      peer.send(data);
    } catch {
      // Peer gone — will be cleaned up via close handler
    }
  }

  /**
   * Clean up when one side disconnects. Closes the other side and removes the slot.
   */
  handleClose(ws: ServerWebSocket<AnySocketData>): void {
    const enrollId = this.wsBySocket.get(ws);
    if (!enrollId) return;

    this.wsBySocket.delete(ws);

    const slot = this.slots.get(enrollId);
    if (!slot) return;

    // Close the peer
    const peer = ws === slot.firstWs ? slot.secondWs : slot.firstWs;
    if (peer) {
      this.wsBySocket.delete(peer);
      try {
        peer.close(1000, "Pairing peer disconnected");
      } catch {
        // Already closed
      }
    }

    // Clean up slot
    clearTimeout(slot.timeoutId);
    this.slots.delete(enrollId);
  }

  /**
   * Expire a slot after TTL. Closes both WebSockets.
   */
  private expireSlot(enrollId: string): void {
    const slot = this.slots.get(enrollId);
    if (!slot) return;

    const closeWs = (ws: ServerWebSocket<AnySocketData> | undefined) => {
      if (!ws) return;
      this.wsBySocket.delete(ws);
      try {
        ws.close(1000, "Pairing TTL expired");
      } catch {
        // Already closed
      }
    };

    closeWs(slot.firstWs);
    closeWs(slot.secondWs);
    this.slots.delete(enrollId);
  }

  /**
   * Get the number of active pairing slots.
   */
  get slotCount(): number {
    return this.slots.size;
  }

  /**
   * Check if a slot exists and is paired (both sides connected).
   */
  isPaired(enrollId: string): boolean {
    const slot = this.slots.get(enrollId);
    return !!slot?.secondWs;
  }

  /**
   * Shutdown: clear all slots and close all connections.
   */
  shutdown(): void {
    for (const [, slot] of this.slots) {
      clearTimeout(slot.timeoutId);
      const closeWs = (ws: ServerWebSocket<AnySocketData> | undefined) => {
        if (!ws) return;
        this.wsBySocket.delete(ws);
        try {
          ws.close(1000, "Relay shutting down");
        } catch {
          // Already closed
        }
      };
      closeWs(slot.firstWs);
      closeWs(slot.secondWs);
    }
    this.slots.clear();
    this.wsBySocket.clear();
  }
}
