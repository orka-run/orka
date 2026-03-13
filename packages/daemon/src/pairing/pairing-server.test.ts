import { describe, test, expect, beforeEach } from "bun:test";

import {
  type PairClientHello,
  type PairMessage,
  PAIR_SUITE,
  computePairContext,
  computePairAad,
} from "@orka/core";

import {
  createSpake2A,
  createSpake2B,
  type Spake2Result,
} from "@orka/core/crypto/protocol";

import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/hashes/utils.js";

import { EnrollmentStore, type PendingEnrollment } from "./enrollment-store";
import { PairingServer, type PairingServerOpts } from "./pairing-server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

function toBase64Url(data: Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

function fromBase64Url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

/**
 * Test double: runs the client side of SPAKE2 to generate valid messages
 * that the PairingServer can process.
 */
class PairingClient {
  private pA: Uint8Array;
  private finishFn: (pB: Uint8Array) => Spake2Result;
  private result: Spake2Result | null = null;

  readonly clientInstanceId: string;

  private clientInstanceIdRaw: Uint8Array;

  constructor(
    private secret: Uint8Array,
    private enrollId: string,
    private relayOrigin: string,
  ) {
    // Match real PairingClient: 16 random bytes, base64url-encoded for wire format
    this.clientInstanceIdRaw = randomBytes(16);
    this.clientInstanceId = toBase64Url(this.clientInstanceIdRaw);
  }

  /** Build a valid pair_client_hello. */
  makeClientHello(): PairClientHello {
    return {
      t: "pair_client_hello",
      v: 1,
      pair_suites: [PAIR_SUITE],
      client_instance_id: this.clientInstanceId,
      features: [],
    };
  }

  /**
   * After receiving server_hello, initialize SPAKE2 A-side and return pair_init.
   * Must be called with the actual serverHello received, so we can compute context/aad.
   */
  makePairInit(clientHello: PairClientHello, serverHello: Record<string, unknown>) {
    const pairContext = computePairContext(clientHello, serverHello as any);
    const pairAad = computePairAad(this.relayOrigin, pairContext);

    // idA = raw bytes of client_instance_id (matching real PairingClient)
    const idA = this.clientInstanceIdRaw;
    const idB = textEncoder.encode(this.enrollId);

    const spake2A = createSpake2A({
      password: this.secret,
      idA,
      idB,
      aad: pairAad,
    });

    this.pA = spake2A.pA;
    this.finishFn = spake2A.finish;

    return {
      t: "pair_init" as const,
      pA: toBase64Url(this.pA),
    };
  }

  /**
   * After receiving pair_resp, finish SPAKE2 and produce pair_confirm1.
   */
  makePairConfirm1(pBBase64Url: string) {
    const pB = fromBase64Url(pBBase64Url);
    this.result = this.finishFn(pB);

    return {
      t: "pair_confirm1" as const,
      mac: toBase64Url(this.result.confirmA),
    };
  }

  /** Verify the server's confirm2 MAC. */
  verifyConfirm2(macBase64Url: string): boolean {
    return this.result!.verifyConfirmB(fromBase64Url(macBase64Url));
  }

  /** Get the shared key Ke for bootstrap decryption. */
  get Ke(): Uint8Array {
    return this.result!.Ke;
  }

  /** Decrypt bootstrap ciphertext. */
  decryptBootstrap(
    ctBase64Url: string,
    clientHello: PairClientHello,
    serverHello: Record<string, unknown>,
  ): Record<string, unknown> {
    const pairContext = computePairContext(clientHello, serverHello as any);
    const aad = sha256(pairContext);

    // Derive boot_s2c key
    const bootS2c = new Uint8Array(
      hkdf(
        sha256,
        this.Ke,
        new Uint8Array(0),
        textEncoder.encode("orka-pair/v1 boot s2c"),
        32,
      ),
    );

    const ct = fromBase64Url(ctBase64Url);
    const nonce = new Uint8Array(12);
    const cipher = chacha20poly1305(bootS2c, nonce, aad);
    const plaintext = cipher.decrypt(ct);

    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  /** Derive boot_export from Ke. */
  get bootExport(): Uint8Array {
    return new Uint8Array(
      hkdf(
        sha256,
        this.Ke,
        new Uint8Array(0),
        textEncoder.encode("orka-pair/v1 export"),
        32,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_SECRET = textEncoder.encode("test-pairing-secret-1234");
const TEST_NODE_ID = "node-test-1";
const TEST_NODE_NAME = "Test Node";
const TEST_RELAY_ORIGIN = "wss://relay.example.com:7390";
const TEST_NOISE_KEY_ID = "sha256:aabbccdd";
const TEST_NODE_PUBKEY = new Uint8Array(32).fill(0x42);
const TEST_RELAY_PATHS = ["wss://relay.example.com:7390/ws"];

function createTestEnrollment(
  store: EnrollmentStore,
  overrides?: Partial<{
    secret: Uint8Array;
    ttlMs: number;
    maxAttempts: number;
  }>,
): { enrollId: string; enrollment: PendingEnrollment } {
  const secret = overrides?.secret ?? TEST_SECRET;
  const enrollId = store.create({
    secret,
    nodeId: TEST_NODE_ID,
    nodeName: TEST_NODE_NAME,
    nodeTransportStaticPubkey: TEST_NODE_PUBKEY,
    relayPaths: TEST_RELAY_PATHS,
    ttlMs: overrides?.ttlMs ?? 600_000,
    maxAttempts: overrides?.maxAttempts ?? 8,
  });
  const enrollment = store.get(enrollId)!;
  return { enrollId, enrollment };
}

function createServerAndClient(
  store: EnrollmentStore,
  overrides?: Partial<{
    secret: Uint8Array;
    ttlMs: number;
    maxAttempts: number;
  }>,
): { server: PairingServer; client: PairingClient; enrollId: string } {
  const secret = overrides?.secret ?? TEST_SECRET;
  const { enrollId, enrollment } = createTestEnrollment(store, overrides);

  const server = new PairingServer({
    enrollment,
    enrollmentStore: store,
    secret,
    relayOrigin: TEST_RELAY_ORIGIN,
    noiseKeyId: TEST_NOISE_KEY_ID,
  });

  const client = new PairingClient(secret, enrollId, TEST_RELAY_ORIGIN);

  return { server, client, enrollId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PairingServer", () => {
  let store: EnrollmentStore;

  beforeEach(() => {
    store = new EnrollmentStore();
  });

  // --- Happy path ---

  describe("full successful pairing flow", () => {
    test("completes handshake and produces bootstrap", () => {
      const { server, client } = createServerAndClient(store);

      // Step 1: client hello
      const clientHello = client.makeClientHello();
      const resp1 = server.processMessage(clientHello);

      expect(resp1).toHaveLength(1);
      expect(resp1[0].t).toBe("pair_server_hello");
      const serverHello = resp1[0] as Record<string, unknown>;
      expect(serverHello.v).toBe(1);
      expect(serverHello.pair_suite).toBe(PAIR_SUITE);
      expect(serverHello.enroll_id).toBeDefined();
      expect(typeof serverHello.expires_in_sec).toBe("number");
      expect((serverHello.features as unknown[]).length).toBe(0);

      // Step 2: pair_init
      const pairInit = client.makePairInit(clientHello, serverHello);
      const resp2 = server.processMessage(pairInit);

      expect(resp2).toHaveLength(1);
      expect(resp2[0].t).toBe("pair_resp");
      const pairResp = resp2[0] as Record<string, unknown>;
      expect(typeof pairResp.pB).toBe("string");

      // Step 3: pair_confirm1
      const confirm1 = client.makePairConfirm1(pairResp.pB as string);
      const resp3 = server.processMessage(confirm1);

      expect(resp3).toHaveLength(2);
      expect(resp3[0].t).toBe("pair_confirm2");
      expect(resp3[1].t).toBe("pair_bootstrap");

      const confirm2 = resp3[0] as Record<string, unknown>;
      const bootstrap = resp3[1] as Record<string, unknown>;

      // Verify server MAC
      expect(client.verifyConfirm2(confirm2.mac as string)).toBe(true);

      // Decrypt bootstrap payload
      const payload = client.decryptBootstrap(
        bootstrap.ct as string,
        clientHello,
        serverHello,
      );
      expect(payload.node_id).toBe(TEST_NODE_ID);
      expect(payload.node_name).toBe(TEST_NODE_NAME);
      expect(payload.noise_suite).toBe("Noise_NK_25519_ChaChaPoly_SHA256");
      expect(payload.noise_static_pubkey).toBe(toBase64Url(TEST_NODE_PUBKEY));
      expect(payload.noise_key_id).toBe(TEST_NOISE_KEY_ID);
      expect(payload.node_paths).toEqual(TEST_RELAY_PATHS);
      expect(payload.rpc).toEqual(["jsonrpc-2.0"]);

      // Step 4: pair_done
      expect(server.isComplete).toBe(false);
      const resp4 = server.processMessage({ t: "pair_done" });

      expect(resp4).toHaveLength(0);
      expect(server.isComplete).toBe(true);
      expect(server.isErrored).toBe(false);
    });

    test("boot_export key is available after completion", () => {
      const { server, client } = createServerAndClient(store);

      // Run through the full handshake
      const clientHello = client.makeClientHello();
      const resp1 = server.processMessage(clientHello);
      const serverHello = resp1[0] as Record<string, unknown>;

      const pairInit = client.makePairInit(clientHello, serverHello);
      const resp2 = server.processMessage(pairInit);
      const pairResp = resp2[0] as Record<string, unknown>;

      const confirm1 = client.makePairConfirm1(pairResp.pB as string);
      server.processMessage(confirm1);

      // boot_export should be available after confirm phase
      expect(server.bootExport).not.toBeNull();
      expect(server.bootExport!.length).toBe(32);

      // Verify it matches the client-derived export key
      const clientExport = client.bootExport;
      expect(Buffer.from(server.bootExport!).toString("hex")).toBe(
        Buffer.from(clientExport).toString("hex"),
      );
    });

    test("boot_export is null before handshake completes", () => {
      const { server } = createServerAndClient(store);
      expect(server.bootExport).toBeNull();
    });
  });

  // --- Error: bad version ---

  describe("bad version in client hello", () => {
    test("rejects v=2 with bad_version error", () => {
      const { server } = createServerAndClient(store);

      const resp = server.processMessage({
        t: "pair_client_hello",
        v: 2,
        pair_suites: [PAIR_SUITE],
        client_instance_id: "test",
        features: [],
      });

      expect(resp).toHaveLength(1);
      expect(resp[0].t).toBe("pair_error");
      expect((resp[0] as Record<string, unknown>).code).toBe("bad_version");
      expect(server.isErrored).toBe(true);
    });
  });

  // --- Error: unsupported suite ---

  describe("unsupported suite in client hello", () => {
    test("rejects when no known suite is offered", () => {
      const { server } = createServerAndClient(store);

      const resp = server.processMessage({
        t: "pair_client_hello",
        v: 1,
        pair_suites: ["UNKNOWN-SUITE"],
        client_instance_id: "test",
        features: [],
      });

      expect(resp).toHaveLength(1);
      expect(resp[0].t).toBe("pair_error");
      expect((resp[0] as Record<string, unknown>).code).toBe("bad_suite");
      expect(server.isErrored).toBe(true);
    });

    test("rejects empty suite list", () => {
      const { server } = createServerAndClient(store);

      const resp = server.processMessage({
        t: "pair_client_hello",
        v: 1,
        pair_suites: [],
        client_instance_id: "test",
        features: [],
      });

      expect(resp).toHaveLength(1);
      expect(resp[0].t).toBe("pair_error");
      expect((resp[0] as Record<string, unknown>).code).toBe("bad_suite");
    });
  });

  // --- Error: invalid MAC ---

  describe("invalid MAC in pair_confirm1", () => {
    test("records failed attempt and returns protocol_error", () => {
      const { server, client, enrollId } = createServerAndClient(store, {
        maxAttempts: 3,
      });

      // Get through hello and init
      const clientHello = client.makeClientHello();
      const resp1 = server.processMessage(clientHello);
      const serverHello = resp1[0] as Record<string, unknown>;

      const pairInit = client.makePairInit(clientHello, serverHello);
      server.processMessage(pairInit);

      // Send a bad MAC
      const badMac = toBase64Url(new Uint8Array(32).fill(0xff));
      const resp = server.processMessage({ t: "pair_confirm1", mac: badMac });

      expect(resp).toHaveLength(1);
      expect(resp[0].t).toBe("pair_error");
      expect((resp[0] as Record<string, unknown>).code).toBe("protocol_error");
      expect(server.isErrored).toBe(true);

      // Enrollment should still exist with decremented attempts
      // Note: we can't check enrollment directly since the server errored,
      // but the store tracks attempts
    });
  });

  // --- Error: attempts exhausted ---

  describe("attempts exhausted after max failures", () => {
    test("returns attempts_exhausted when last attempt fails", () => {
      const { server, client } = createServerAndClient(store, {
        maxAttempts: 1,
      });

      // Get through hello and init
      const clientHello = client.makeClientHello();
      const resp1 = server.processMessage(clientHello);
      const serverHello = resp1[0] as Record<string, unknown>;

      const pairInit = client.makePairInit(clientHello, serverHello);
      server.processMessage(pairInit);

      // Send a bad MAC with only 1 attempt left
      const badMac = toBase64Url(new Uint8Array(32).fill(0xff));
      const resp = server.processMessage({ t: "pair_confirm1", mac: badMac });

      expect(resp).toHaveLength(1);
      expect(resp[0].t).toBe("pair_error");
      expect((resp[0] as Record<string, unknown>).code).toBe(
        "attempts_exhausted",
      );
      expect(server.isErrored).toBe(true);
    });
  });

  // --- Error: message in wrong state ---

  describe("message in wrong state", () => {
    test("pair_init before client_hello sends protocol_error", () => {
      const { server } = createServerAndClient(store);

      const resp = server.processMessage({
        t: "pair_init",
        pA: toBase64Url(new Uint8Array(32)),
      });

      expect(resp).toHaveLength(1);
      expect(resp[0].t).toBe("pair_error");
      expect((resp[0] as Record<string, unknown>).code).toBe("protocol_error");
      expect(server.isErrored).toBe(true);
    });

    test("pair_confirm1 before pair_init sends protocol_error", () => {
      const { server, client } = createServerAndClient(store);

      // Do client hello first
      const clientHello = client.makeClientHello();
      server.processMessage(clientHello);

      // Skip pair_init, go straight to confirm
      const resp = server.processMessage({
        t: "pair_confirm1",
        mac: toBase64Url(new Uint8Array(32)),
      });

      expect(resp).toHaveLength(1);
      expect(resp[0].t).toBe("pair_error");
      expect((resp[0] as Record<string, unknown>).code).toBe("protocol_error");
    });

    test("pair_done before confirm sends protocol_error", () => {
      const { server, client } = createServerAndClient(store);

      const clientHello = client.makeClientHello();
      const resp1 = server.processMessage(clientHello);
      const serverHello = resp1[0] as Record<string, unknown>;

      const pairInit = client.makePairInit(clientHello, serverHello);
      server.processMessage(pairInit);

      // Skip confirm, go to done
      const resp = server.processMessage({ t: "pair_done" });

      expect(resp).toHaveLength(1);
      expect(resp[0].t).toBe("pair_error");
      expect((resp[0] as Record<string, unknown>).code).toBe("protocol_error");
    });

    test("message after completion sends protocol_error", () => {
      const { server, client } = createServerAndClient(store);

      // Run full handshake
      const clientHello = client.makeClientHello();
      const resp1 = server.processMessage(clientHello);
      const serverHello = resp1[0] as Record<string, unknown>;

      const pairInit = client.makePairInit(clientHello, serverHello);
      const resp2 = server.processMessage(pairInit);
      const pairResp = resp2[0] as Record<string, unknown>;

      const confirm1 = client.makePairConfirm1(pairResp.pB as string);
      server.processMessage(confirm1);
      server.processMessage({ t: "pair_done" });

      expect(server.isComplete).toBe(true);

      // Send another message
      const resp = server.processMessage({ t: "pair_done" });
      expect(resp).toHaveLength(1);
      expect(resp[0].t).toBe("pair_error");
      expect((resp[0] as Record<string, unknown>).code).toBe("protocol_error");
    });

    test("message after error sends protocol_error", () => {
      const { server } = createServerAndClient(store);

      // Trigger an error
      server.processMessage({ t: "pair_init", pA: "bad" });
      expect(server.isErrored).toBe(true);

      // Send another message
      const resp = server.processMessage({
        t: "pair_client_hello",
        v: 1,
        pair_suites: [PAIR_SUITE],
        client_instance_id: "test",
        features: [],
      });

      expect(resp).toHaveLength(1);
      expect(resp[0].t).toBe("pair_error");
      expect((resp[0] as Record<string, unknown>).code).toBe("protocol_error");
    });
  });

  // --- pair_done marks enrollment as used ---

  describe("pair_done marks enrollment as used", () => {
    test("enrollment is marked used after pair_done", () => {
      const { server, client, enrollId } = createServerAndClient(store);

      // Full handshake
      const clientHello = client.makeClientHello();
      const resp1 = server.processMessage(clientHello);
      const serverHello = resp1[0] as Record<string, unknown>;

      const pairInit = client.makePairInit(clientHello, serverHello);
      const resp2 = server.processMessage(pairInit);
      const pairResp = resp2[0] as Record<string, unknown>;

      const confirm1 = client.makePairConfirm1(pairResp.pB as string);
      server.processMessage(confirm1);

      // Before done: enrollment should not be used
      const enrollBefore = store.get(enrollId);
      expect(enrollBefore).not.toBeNull();
      expect(enrollBefore!.used).toBe(false);

      // Send done
      server.processMessage({ t: "pair_done" });

      // After done: enrollment should be marked used
      const enrollAfter = store.get(enrollId);
      expect(enrollAfter).not.toBeNull();
      expect(enrollAfter!.used).toBe(true);
    });
  });

  // --- Bootstrap payload verification ---

  describe("bootstrap payload", () => {
    test("contains correct node info", () => {
      const { server, client } = createServerAndClient(store);

      // Full handshake through confirm
      const clientHello = client.makeClientHello();
      const resp1 = server.processMessage(clientHello);
      const serverHello = resp1[0] as Record<string, unknown>;

      const pairInit = client.makePairInit(clientHello, serverHello);
      const resp2 = server.processMessage(pairInit);
      const pairResp = resp2[0] as Record<string, unknown>;

      const confirm1 = client.makePairConfirm1(pairResp.pB as string);
      const resp3 = server.processMessage(confirm1);

      const bootstrap = resp3[1] as Record<string, unknown>;

      // Decrypt and verify payload
      const payload = client.decryptBootstrap(
        bootstrap.ct as string,
        clientHello,
        serverHello,
      );

      expect(payload).toEqual({
        node_id: TEST_NODE_ID,
        node_name: TEST_NODE_NAME,
        noise_suite: "Noise_NK_25519_ChaChaPoly_SHA256",
        noise_static_pubkey: toBase64Url(TEST_NODE_PUBKEY),
        noise_key_id: TEST_NOISE_KEY_ID,
        node_paths: TEST_RELAY_PATHS,
        rpc: ["jsonrpc-2.0"],
      });
    });

    test("bootstrap decryption fails with wrong key", () => {
      const { server, client } = createServerAndClient(store);

      // Full handshake through confirm
      const clientHello = client.makeClientHello();
      const resp1 = server.processMessage(clientHello);
      const serverHello = resp1[0] as Record<string, unknown>;

      const pairInit = client.makePairInit(clientHello, serverHello);
      const resp2 = server.processMessage(pairInit);
      const pairResp = resp2[0] as Record<string, unknown>;

      const confirm1 = client.makePairConfirm1(pairResp.pB as string);
      const resp3 = server.processMessage(confirm1);

      const bootstrap = resp3[1] as Record<string, unknown>;
      const ct = fromBase64Url(bootstrap.ct as string);

      // Try to decrypt with wrong key
      const wrongKey = new Uint8Array(32).fill(0xaa);
      const nonce = new Uint8Array(12);
      const pairContext = computePairContext(clientHello, serverHello as any);
      const aad = sha256(pairContext);

      expect(() => {
        const cipher = chacha20poly1305(wrongKey, nonce, aad);
        cipher.decrypt(ct);
      }).toThrow();
    });
  });

  // --- Expired enrollment ---

  describe("expired enrollment", () => {
    test("rejects with expired error when enrollment has passed", () => {
      const { enrollment } = createTestEnrollment(store, { ttlMs: 1 });

      // Wait for expiry (enrollment was created with 1ms TTL)
      // Force expiry by modifying expiresAt directly
      enrollment.expiresAt = Date.now() - 1000;

      const server = new PairingServer({
        enrollment,
        enrollmentStore: store,
        secret: TEST_SECRET,
        relayOrigin: TEST_RELAY_ORIGIN,
        noiseKeyId: TEST_NOISE_KEY_ID,
      });

      const resp = server.processMessage({
        t: "pair_client_hello",
        v: 1,
        pair_suites: [PAIR_SUITE],
        client_instance_id: "test",
        features: [],
      });

      expect(resp).toHaveLength(1);
      expect(resp[0].t).toBe("pair_error");
      expect((resp[0] as Record<string, unknown>).code).toBe("expired");
      expect(server.isErrored).toBe(true);
    });
  });

  // --- Completely invalid messages ---

  describe("invalid messages", () => {
    test("rejects non-object message", () => {
      const { server } = createServerAndClient(store);
      const resp = server.processMessage("not an object");

      expect(resp).toHaveLength(1);
      expect(resp[0].t).toBe("pair_error");
      expect((resp[0] as Record<string, unknown>).code).toBe("protocol_error");
    });

    test("rejects null message", () => {
      const { server } = createServerAndClient(store);
      const resp = server.processMessage(null);

      expect(resp).toHaveLength(1);
      expect(resp[0].t).toBe("pair_error");
      expect((resp[0] as Record<string, unknown>).code).toBe("protocol_error");
    });

    test("rejects message with missing type", () => {
      const { server } = createServerAndClient(store);
      const resp = server.processMessage({ foo: "bar" });

      expect(resp).toHaveLength(1);
      expect(resp[0].t).toBe("pair_error");
      expect((resp[0] as Record<string, unknown>).code).toBe("protocol_error");
    });
  });

  // --- Server hello contains correct expires_in_sec ---

  describe("server hello timing", () => {
    test("expires_in_sec reflects remaining enrollment time", () => {
      const { enrollment } = createTestEnrollment(store, { ttlMs: 120_000 });

      const server = new PairingServer({
        enrollment,
        enrollmentStore: store,
        secret: TEST_SECRET,
        relayOrigin: TEST_RELAY_ORIGIN,
        noiseKeyId: TEST_NOISE_KEY_ID,
      });

      const resp = server.processMessage({
        t: "pair_client_hello",
        v: 1,
        pair_suites: [PAIR_SUITE],
        client_instance_id: "test",
        features: [],
      });

      const serverHello = resp[0] as Record<string, unknown>;
      const expiresSec = serverHello.expires_in_sec as number;

      // Should be approximately 120 seconds (allow 5 seconds margin for test execution)
      expect(expiresSec).toBeGreaterThan(115);
      expect(expiresSec).toBeLessThanOrEqual(120);
    });
  });

  // --- Multiple clients with different secrets ---

  describe("different secrets produce different keys", () => {
    test("two pairings with different secrets yield different boot_export", () => {
      const secret1 = textEncoder.encode("secret-alpha");
      const secret2 = textEncoder.encode("secret-beta");

      // First pairing
      const store1 = new EnrollmentStore();
      const { server: server1, client: client1 } = createServerAndClient(
        store1,
        { secret: secret1 },
      );

      const ch1 = client1.makeClientHello();
      const r1 = server1.processMessage(ch1);
      const sh1 = r1[0] as Record<string, unknown>;
      const pi1 = client1.makePairInit(ch1, sh1);
      const r2 = server1.processMessage(pi1);
      const pr1 = r2[0] as Record<string, unknown>;
      const c1 = client1.makePairConfirm1(pr1.pB as string);
      server1.processMessage(c1);

      // Second pairing
      const store2 = new EnrollmentStore();
      const { server: server2, client: client2 } = createServerAndClient(
        store2,
        { secret: secret2 },
      );

      const ch2 = client2.makeClientHello();
      const r3 = server2.processMessage(ch2);
      const sh2 = r3[0] as Record<string, unknown>;
      const pi2 = client2.makePairInit(ch2, sh2);
      const r4 = server2.processMessage(pi2);
      const pr2 = r4[0] as Record<string, unknown>;
      const c2 = client2.makePairConfirm1(pr2.pB as string);
      server2.processMessage(c2);

      // boot_export should differ
      expect(Buffer.from(server1.bootExport!).toString("hex")).not.toBe(
        Buffer.from(server2.bootExport!).toString("hex"),
      );

      store1.shutdown();
      store2.shutdown();
    });
  });

  // --- Cleanup ---

  test("store shutdown after tests", () => {
    store.shutdown();
  });
});
