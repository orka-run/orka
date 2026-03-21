import { describe, test, expect, beforeEach } from "bun:test";
import { PairingRouter } from "./pairing";
import type { ServerWebSocket } from "bun";
import type { AnySocketData } from "./state";
// --- Mock WebSocket ---

interface MockWsOpts {
  enrollId?: string;
  side?: "registrant" | "joiner";
  accountId?: string;
}

interface MockPairingWs extends ServerWebSocket<AnySocketData> {
  readonly _sent: (string | Buffer)[];
  readonly _closed: boolean;
  readonly _closeCode: number | undefined;
  readonly _closeReason: string | undefined;
}

function mockPairingWs(opts?: MockWsOpts): MockPairingWs {
  const sent: (string | Buffer)[] = [];
  let closed = false;
  let closeCode: number | undefined;
  let closeReason: string | undefined;

  return {
    data: {
      role: "pairing" as const,
      enrollId: opts?.enrollId ?? "test-enroll",
      side: opts?.side ?? "registrant",
      accountId: opts?.accountId ?? "acc-1",
    },
    send(data: string | Buffer) {
      if (closed) throw new Error("WebSocket is closed");
      sent.push(data);
    },
    close(code?: number, reason?: string) {
      closed = true;
      closeCode = code;
      closeReason = reason;
    },
    // Test helpers
    get _sent() { return sent; },
    get _closed() { return closed; },
    get _closeCode() { return closeCode; },
    get _closeReason() { return closeReason; },
  } as unknown as MockPairingWs;
}

// --- Tests ---

describe("PairingRouter", () => {
  let router: PairingRouter;

  beforeEach(() => {
    router = new PairingRouter({ maxSlots: 5, defaultTtlMs: 600_000 });
  });

  // --- Validation ---

  describe("validateEnrollId", () => {
    test("accepts valid enroll_id", () => {
      expect(router.validateEnrollId("abc-123_DEF")).toBeNull();
    });

    test("rejects empty enroll_id", () => {
      expect(router.validateEnrollId("")).toBe("Empty enroll_id");
    });

    test("rejects too-long enroll_id", () => {
      const long = "a".repeat(129);
      expect(router.validateEnrollId(long)).toBe("enroll_id too long (max 128 characters)");
    });

    test("rejects invalid characters", () => {
      expect(router.validateEnrollId("abc def")).not.toBeNull();
      expect(router.validateEnrollId("abc/def")).not.toBeNull();
      expect(router.validateEnrollId("abc.def")).not.toBeNull();
    });

    test("accepts max-length enroll_id", () => {
      const maxLen = "a".repeat(128);
      expect(router.validateEnrollId(maxLen)).toBeNull();
    });
  });

  // --- Connection handling ---

  describe("handleConnection", () => {
    test("first connection creates slot and waits", () => {
      const ws = mockPairingWs({ enrollId: "abc" });
      const result = router.handleConnection("abc", ws);

      expect(result.accepted).toBe(true);
      expect(router.slotCount).toBe(1);
      expect(router.isPaired("abc")).toBe(false);
    });

    test("second connection pairs the slot", () => {
      const ws1 = mockPairingWs({ enrollId: "abc", side: "registrant" });
      const ws2 = mockPairingWs({ enrollId: "abc", side: "joiner" });

      router.handleConnection("abc", ws1);
      const result = router.handleConnection("abc", ws2);

      expect(result.accepted).toBe(true);
      expect(router.isPaired("abc")).toBe(true);
    });

    test("third connection to same enroll_id is rejected", () => {
      const ws1 = mockPairingWs({ enrollId: "abc" });
      const ws2 = mockPairingWs({ enrollId: "abc" });
      const ws3 = mockPairingWs({ enrollId: "abc" });

      router.handleConnection("abc", ws1);
      router.handleConnection("abc", ws2);
      const result = router.handleConnection("abc", ws3);

      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.reason).toBe("Pairing slot already full");
      }
    });

    test("max slots reached rejects new registrations", () => {
      // Fill up all 5 slots
      for (let i = 0; i < 5; i++) {
        const ws = mockPairingWs({ enrollId: `enroll-${i}` });
        const r = router.handleConnection(`enroll-${i}`, ws);
        expect(r.accepted).toBe(true);
      }

      expect(router.slotCount).toBe(5);

      // 6th should be rejected
      const ws = mockPairingWs({ enrollId: "enroll-5" });
      const result = router.handleConnection("enroll-5", ws);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.reason).toBe("Maximum pairing slots reached");
      }
    });
  });

  // --- Message forwarding ---

  describe("handleMessage", () => {
    test("forwards message from first to second after pairing", () => {
      const ws1 = mockPairingWs({ enrollId: "abc" });
      const ws2 = mockPairingWs({ enrollId: "abc" });

      router.handleConnection("abc", ws1);
      router.handleConnection("abc", ws2);

      router.handleMessage(ws1, "hello from side 1");
      expect(ws2._sent).toEqual(["hello from side 1"]);
      expect(ws1._sent).toEqual([]);
    });

    test("forwards message from second to first after pairing", () => {
      const ws1 = mockPairingWs({ enrollId: "abc" });
      const ws2 = mockPairingWs({ enrollId: "abc" });

      router.handleConnection("abc", ws1);
      router.handleConnection("abc", ws2);

      router.handleMessage(ws2, "hello from side 2");
      expect(ws1._sent).toEqual(["hello from side 2"]);
      expect(ws2._sent).toEqual([]);
    });

    test("bidirectional forwarding works", () => {
      const ws1 = mockPairingWs({ enrollId: "abc" });
      const ws2 = mockPairingWs({ enrollId: "abc" });

      router.handleConnection("abc", ws1);
      router.handleConnection("abc", ws2);

      router.handleMessage(ws1, "msg-A");
      router.handleMessage(ws2, "msg-B");
      router.handleMessage(ws1, "msg-C");

      expect(ws2._sent).toEqual(["msg-A", "msg-C"]);
      expect(ws1._sent).toEqual(["msg-B"]);
    });

    test("drops message before pairing (only one side connected)", () => {
      const ws1 = mockPairingWs({ enrollId: "abc" });
      router.handleConnection("abc", ws1);

      // Message from registrant with no joiner yet — should be silently dropped
      router.handleMessage(ws1, "premature message");
      // No crash, no error — just dropped
      expect(ws1._sent).toEqual([]);
    });

    test("forwards binary data as-is", () => {
      const ws1 = mockPairingWs({ enrollId: "abc" });
      const ws2 = mockPairingWs({ enrollId: "abc" });

      router.handleConnection("abc", ws1);
      router.handleConnection("abc", ws2);

      const binary = Buffer.from([0x01, 0x02, 0x03]);
      router.handleMessage(ws1, binary);
      expect(ws2._sent).toEqual([binary]);
    });

    test("ignores message from unknown ws", () => {
      const unknownWs = mockPairingWs({ enrollId: "unknown" });
      // No connection registered — should be a no-op
      router.handleMessage(unknownWs, "orphan message");
    });
  });

  // --- Disconnect cleanup ---

  describe("handleClose", () => {
    test("first side disconnect closes second side and removes slot", () => {
      const ws1 = mockPairingWs({ enrollId: "abc" });
      const ws2 = mockPairingWs({ enrollId: "abc" });

      router.handleConnection("abc", ws1);
      router.handleConnection("abc", ws2);

      router.handleClose(ws1);

      expect(ws2._closed).toBe(true);
      expect(ws2._closeReason).toBe("Pairing peer disconnected");
      expect(router.slotCount).toBe(0);
    });

    test("second side disconnect closes first side and removes slot", () => {
      const ws1 = mockPairingWs({ enrollId: "abc" });
      const ws2 = mockPairingWs({ enrollId: "abc" });

      router.handleConnection("abc", ws1);
      router.handleConnection("abc", ws2);

      router.handleClose(ws2);

      expect(ws1._closed).toBe(true);
      expect(ws1._closeReason).toBe("Pairing peer disconnected");
      expect(router.slotCount).toBe(0);
    });

    test("registrant disconnect before pairing removes slot", () => {
      const ws1 = mockPairingWs({ enrollId: "abc" });
      router.handleConnection("abc", ws1);

      router.handleClose(ws1);
      expect(router.slotCount).toBe(0);
    });

    test("close from unknown ws is a no-op", () => {
      const unknownWs = mockPairingWs({ enrollId: "unknown" });
      router.handleClose(unknownWs);
      expect(router.slotCount).toBe(0);
    });

    test("slot can be reused after cleanup", () => {
      const ws1 = mockPairingWs({ enrollId: "abc" });
      const ws2 = mockPairingWs({ enrollId: "abc" });

      router.handleConnection("abc", ws1);
      router.handleConnection("abc", ws2);
      router.handleClose(ws1);

      expect(router.slotCount).toBe(0);

      // Now create a new slot with the same enroll_id
      const ws3 = mockPairingWs({ enrollId: "abc" });
      const result = router.handleConnection("abc", ws3);
      expect(result.accepted).toBe(true);
      expect(router.slotCount).toBe(1);
    });
  });

  // --- TTL expiry ---

  describe("TTL expiry", () => {
    test("slot expires after TTL and closes both connections", async () => {
      const shortRouter = new PairingRouter({ maxSlots: 5, defaultTtlMs: 100 });

      const ws1 = mockPairingWs({ enrollId: "abc" });
      const ws2 = mockPairingWs({ enrollId: "abc" });

      shortRouter.handleConnection("abc", ws1);
      shortRouter.handleConnection("abc", ws2);

      // Wait for TTL to expire
      await Bun.sleep(200);

      expect(ws1._closed).toBe(true);
      expect(ws1._closeReason).toBe("Pairing TTL expired");
      expect(ws2._closed).toBe(true);
      expect(ws2._closeReason).toBe("Pairing TTL expired");
      expect(shortRouter.slotCount).toBe(0);
    });

    test("unpaired slot expires after TTL", async () => {
      const shortRouter = new PairingRouter({ maxSlots: 5, defaultTtlMs: 100 });

      const ws1 = mockPairingWs({ enrollId: "abc" });
      shortRouter.handleConnection("abc", ws1);

      await Bun.sleep(200);

      expect(ws1._closed).toBe(true);
      expect(ws1._closeReason).toBe("Pairing TTL expired");
      expect(shortRouter.slotCount).toBe(0);
    });
  });

  // --- Shutdown ---

  describe("shutdown", () => {
    test("closes all connections and clears state", () => {
      const ws1 = mockPairingWs({ enrollId: "abc" });
      const ws2 = mockPairingWs({ enrollId: "abc" });
      const ws3 = mockPairingWs({ enrollId: "def" });

      router.handleConnection("abc", ws1);
      router.handleConnection("abc", ws2);
      router.handleConnection("def", ws3);

      expect(router.slotCount).toBe(2);

      router.shutdown();

      expect(ws1._closed).toBe(true);
      expect(ws2._closed).toBe(true);
      expect(ws3._closed).toBe(true);
      expect(ws1._closeReason).toBe("Relay shutting down");
      expect(router.slotCount).toBe(0);
    });
  });

  // --- Multiple independent slots ---

  describe("isolation", () => {
    test("different enroll_ids are independent", () => {
      const wsA1 = mockPairingWs({ enrollId: "aaa" });
      const wsA2 = mockPairingWs({ enrollId: "aaa" });
      const wsB1 = mockPairingWs({ enrollId: "bbb" });
      const wsB2 = mockPairingWs({ enrollId: "bbb" });

      router.handleConnection("aaa", wsA1);
      router.handleConnection("aaa", wsA2);
      router.handleConnection("bbb", wsB1);
      router.handleConnection("bbb", wsB2);

      router.handleMessage(wsA1, "msg-for-A2");
      router.handleMessage(wsB1, "msg-for-B2");

      expect(wsA2._sent).toEqual(["msg-for-A2"]);
      expect(wsB2._sent).toEqual(["msg-for-B2"]);
      expect(wsA1._sent).toEqual([]);
      expect(wsB1._sent).toEqual([]);
    });

    test("closing one slot does not affect others", () => {
      const wsA1 = mockPairingWs({ enrollId: "aaa" });
      const wsA2 = mockPairingWs({ enrollId: "aaa" });
      const wsB1 = mockPairingWs({ enrollId: "bbb" });

      router.handleConnection("aaa", wsA1);
      router.handleConnection("aaa", wsA2);
      router.handleConnection("bbb", wsB1);

      router.handleClose(wsA1);

      expect(wsA2._closed).toBe(true);
      expect(wsB1._closed).toBe(false);
      expect(router.slotCount).toBe(1);
    });
  });
});
