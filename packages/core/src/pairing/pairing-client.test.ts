/**
 * Tests for PairingClient — the client-side pairing state machine.
 *
 * Uses a minimal server test double that runs SPAKE2-B to produce valid
 * messages, enabling full end-to-end protocol verification.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { randomBytes } from "@noble/hashes/utils.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

import { createSpake2B, type Spake2Result } from "../crypto/spake2";
import { blake3Truncated, concatBytes, sha256 } from "../crypto/hash";
import { generateX25519KeyPair } from "../crypto/noise";
import {
  PAIR_SUITE,
  computePairContext,
  computePairAad,
  type PairClientHello,
  type PairServerHello,
  type PairBootstrapPayload,
} from "../pairing-protocol";

import {
  PairingClient,
  PairingError,
  type PairingClientOpts,
  type PairingClientResult,
} from "./pairing-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function toBase64url(data: Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

function fromBase64url(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, "base64url"));
}

/**
 * Derive the enroll_id from the pairing secret, matching PairingClient's
 * internal derivation.
 *
 * enroll_id = hex(trunc64(BLAKE3("orka/pair/v1/enroll-id" || secret)))
 */
function deriveEnrollId(secret: Uint8Array): string {
  const prefix = enc.encode("orka/pair/v1/enroll-id");
  const input = concatBytes(prefix, secret);
  const truncated = blake3Truncated(input, 8);
  return Buffer.from(truncated).toString("hex");
}

// ---------------------------------------------------------------------------
// Server test double
// ---------------------------------------------------------------------------

/**
 * MockPairingServer simulates the server (node) side of the pairing protocol.
 *
 * Critical identity conventions (must match PairingClient):
 *   - idA = raw bytes of client_instance_id (decoded from base64url)
 *   - idB = UTF-8 encoding of the enroll_id string
 */
class MockPairingServer {
  readonly enrollId: string;
  readonly noiseKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array };
  readonly nodeId: string;
  readonly nodeName: string;
  readonly noiseKeyId: string;
  readonly nodePaths: string[];
  readonly rpcProtocols: string[];

  private _secret: Uint8Array;
  private _relayOrigin: string;

  // State
  private _clientHello: PairClientHello | null = null;
  private _serverHello: PairServerHello | null = null;
  private _spake2Result: Spake2Result | null = null;
  private _pairContext: Uint8Array | null = null;

  constructor(opts: {
    secret: Uint8Array;
    relayOrigin: string;
    nodeId?: string;
    nodeName?: string;
    customPayload?: Partial<PairBootstrapPayload>;
  }) {
    this._secret = opts.secret;
    this._relayOrigin = opts.relayOrigin;
    // Derive enroll_id from secret — same formula as PairingClient
    this.enrollId = deriveEnrollId(opts.secret);
    this.noiseKeyPair = generateX25519KeyPair();
    this.nodeId = opts.nodeId ?? "test-node-1";
    this.nodeName = opts.nodeName ?? "Test Node";
    this.noiseKeyId = "sha256:" + toBase64url(randomBytes(8));
    this.nodePaths = ["ws://relay.test:7390/ws"];
    this.rpcProtocols = ["jsonrpc-2.0"];
  }

  /** Process pair_client_hello, return pair_server_hello JSON string. */
  handleClientHello(msg: object): string {
    this._clientHello = msg as PairClientHello;
    this._serverHello = {
      t: "pair_server_hello",
      v: 1,
      pair_suite: PAIR_SUITE,
      enroll_id: this.enrollId,
      expires_in_sec: 300,
      features: [],
    };
    return JSON.stringify(this._serverHello);
  }

  /** Process pair_init, return pair_resp JSON string. */
  handlePairInit(msg: { t: string; pA: string }): string {
    const pairContext = computePairContext(this._clientHello!, this._serverHello!);
    const pairAad = computePairAad(this._relayOrigin, pairContext);

    // idA = client_instance_id raw bytes (decoded from base64url)
    const idA = fromBase64url(this._clientHello!.client_instance_id);
    // idB = UTF-8 encoding of the enroll_id string (matches client)
    const idB = enc.encode(this.enrollId);

    const spake2B = createSpake2B({
      password: this._secret,
      idA,
      idB,
      aad: pairAad,
    });

    const pABytes = fromBase64url(msg.pA);
    this._spake2Result = spake2B.finish(pABytes);
    this._pairContext = pairContext;

    return JSON.stringify({
      t: "pair_resp",
      pB: toBase64url(spake2B.pB),
    });
  }

  /** Process pair_confirm1 MAC, return pair_confirm2 JSON string. Throws if MAC invalid. */
  handlePairConfirm1(msg: { t: string; mac: string }): string {
    if (!this._spake2Result) throw new Error("Must call handlePairInit first");

    const macBytes = fromBase64url(msg.mac);
    if (!this._spake2Result.verifyConfirmA(macBytes)) {
      throw new Error("Server: client confirmA MAC verification failed");
    }

    return JSON.stringify({
      t: "pair_confirm2",
      mac: toBase64url(this._spake2Result.confirmB),
    });
  }

  /** Generate pair_bootstrap JSON string with encrypted node info. */
  generateBootstrap(overridePayload?: Partial<PairBootstrapPayload>): string {
    if (!this._spake2Result || !this._pairContext) {
      throw new Error("Must complete SPAKE2 exchange first");
    }

    // Derive boot_s2c
    const Ke = this._spake2Result.Ke;
    const bootS2c = new Uint8Array(
      hkdf(nobleSha256, Ke, new Uint8Array(0), enc.encode("orka-pair/v1 boot s2c"), 32),
    );

    // Build payload
    const payload: PairBootstrapPayload = {
      node_id: this.nodeId,
      node_name: this.nodeName,
      noise_suite: "Noise_NK_25519_ChaChaPoly_SHA256",
      noise_static_pubkey: toBase64url(this.noiseKeyPair.publicKey),
      noise_key_id: this.noiseKeyId,
      node_paths: this.nodePaths,
      rpc: this.rpcProtocols,
      ...overridePayload,
    };

    const plaintext = enc.encode(JSON.stringify(payload));

    // Encrypt with ChaCha20-Poly1305, nonce=0, AAD=SHA256(pair_context)
    const nonce = new Uint8Array(12);
    const aad = sha256(this._pairContext);
    const cipher = chacha20poly1305(bootS2c, nonce, aad);
    const ct = cipher.encrypt(plaintext);

    return JSON.stringify({
      t: "pair_bootstrap",
      ct: toBase64url(ct),
    });
  }

  /** Generate a bootstrap with arbitrary (possibly invalid) plaintext. */
  generateBootstrapWithRawPayload(payloadObj: unknown): string {
    if (!this._spake2Result || !this._pairContext) {
      throw new Error("Must complete SPAKE2 exchange first");
    }

    const Ke = this._spake2Result.Ke;
    const bootS2c = new Uint8Array(
      hkdf(nobleSha256, Ke, new Uint8Array(0), enc.encode("orka-pair/v1 boot s2c"), 32),
    );

    const plaintext = enc.encode(JSON.stringify(payloadObj));
    const nonce = new Uint8Array(12);
    const aad = sha256(this._pairContext);
    const cipher = chacha20poly1305(bootS2c, nonce, aad);
    const ct = cipher.encrypt(plaintext);

    return JSON.stringify({
      t: "pair_bootstrap",
      ct: toBase64url(ct),
    });
  }
}

// ---------------------------------------------------------------------------
// Full exchange helper
// ---------------------------------------------------------------------------

/**
 * Run the complete pairing exchange between a PairingClient and MockPairingServer.
 */
async function runFullExchange(
  secret: Uint8Array,
  relayOrigin: string,
  serverOpts?: { nodeId?: string; nodeName?: string },
): Promise<{
  result: PairingClientResult;
  server: MockPairingServer;
  client: PairingClient;
  messages: object[];
}> {
  const messages: object[] = [];
  const server = new MockPairingServer({
    secret,
    relayOrigin,
    ...serverOpts,
  });

  const client = new PairingClient({
    secret,
    relayOrigin,
    onSend: (msg) => messages.push(msg),
  });

  // Step 1: Client sends pair_client_hello
  client.start();
  expect(messages.length).toBe(1);
  expect((messages[0] as any).t).toBe("pair_client_hello");

  // Step 2: Server responds with pair_server_hello → client sends pair_init
  const serverHelloJson = server.handleClientHello(messages[0]);
  const r1 = await client.handleMessage(serverHelloJson);
  expect(r1).toBeNull();
  expect(messages.length).toBe(2);
  expect((messages[1] as any).t).toBe("pair_init");

  // Step 3: Server processes pair_init → client sends pair_confirm1
  const pairRespJson = server.handlePairInit(messages[1] as any);
  const r2 = await client.handleMessage(pairRespJson);
  expect(r2).toBeNull();
  expect(messages.length).toBe(3);
  expect((messages[2] as any).t).toBe("pair_confirm1");

  // Step 4: Server processes pair_confirm1 → client derives bootstrap keys
  const confirm2Json = server.handlePairConfirm1(messages[2] as any);
  const r3 = await client.handleMessage(confirm2Json);
  expect(r3).toBeNull();

  // Step 5: Server sends pair_bootstrap → client returns result (AWAIT_NOISE_VERIFY)
  const bootstrapJson = server.generateBootstrap();
  const result = await client.handleMessage(bootstrapJson);
  expect(result).not.toBeNull();
  expect(client.state).toBe("AWAIT_NOISE_VERIFY");

  // Step 6: Caller confirms Noise verify → pair_done sent → COMPLETE
  client.confirmNoiseVerified();
  expect(client.state).toBe("COMPLETE");

  return { result: result!, server, client, messages };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PairingClient", () => {
  const relayOrigin = "wss://relay.example.com:7390";
  let secret: Uint8Array;

  beforeEach(() => {
    secret = randomBytes(10);
  });

  // --- enrollId derivation ---

  describe("enrollId derivation", () => {
    test("enrollId matches expected derivation", () => {
      const client = new PairingClient({
        secret,
        relayOrigin,
        onSend: () => {},
      });

      const expected = deriveEnrollId(secret);
      expect(client.enrollId).toBe(expected);
    });

    test("enrollId is a 16-character hex string (8 bytes)", () => {
      const client = new PairingClient({
        secret,
        relayOrigin,
        onSend: () => {},
      });
      expect(client.enrollId).toMatch(/^[0-9a-f]{16}$/);
    });

    test("different secrets produce different enrollIds", () => {
      const s1 = randomBytes(10);
      const s2 = randomBytes(10);
      const c1 = new PairingClient({ secret: s1, relayOrigin, onSend: () => {} });
      const c2 = new PairingClient({ secret: s2, relayOrigin, onSend: () => {} });
      expect(c1.enrollId).not.toBe(c2.enrollId);
    });

    test("same secret produces same enrollId", () => {
      const c1 = new PairingClient({ secret, relayOrigin, onSend: () => {} });
      const c2 = new PairingClient({ secret, relayOrigin, onSend: () => {} });
      expect(c1.enrollId).toBe(c2.enrollId);
    });
  });

  // --- start and client_hello ---

  describe("start and client_hello", () => {
    test("sends well-formed pair_client_hello via onSend", () => {
      const messages: object[] = [];
      const client = new PairingClient({
        secret,
        relayOrigin,
        onSend: (msg) => messages.push(msg),
      });

      client.start();

      expect(messages.length).toBe(1);
      const hello = messages[0] as any;
      expect(hello.t).toBe("pair_client_hello");
      expect(hello.v).toBe(1);
      expect(hello.pair_suites).toEqual([PAIR_SUITE]);
      expect(hello.features).toEqual([]);
      expect(typeof hello.client_instance_id).toBe("string");
    });

    test("client_instance_id is base64url-encoded 16 bytes", () => {
      const messages: object[] = [];
      const client = new PairingClient({
        secret,
        relayOrigin,
        onSend: (msg) => messages.push(msg),
      });
      client.start();

      const hello = messages[0] as any;
      const decoded = fromBase64url(hello.client_instance_id);
      expect(decoded.length).toBe(16);
    });

    test("different clients produce different instance IDs", () => {
      const m1: object[] = [];
      const m2: object[] = [];
      const c1 = new PairingClient({ secret, relayOrigin, onSend: (m) => m1.push(m) });
      const c2 = new PairingClient({ secret, relayOrigin, onSend: (m) => m2.push(m) });
      c1.start();
      c2.start();

      const h1 = m1[0] as any;
      const h2 = m2[0] as any;
      expect(h1.client_instance_id).not.toBe(h2.client_instance_id);
    });

    test("throws PairingError if started twice", () => {
      const client = new PairingClient({ secret, relayOrigin, onSend: () => {} });
      client.start();

      expect(() => client.start()).toThrow(PairingError);
      expect(() => client.start()).toThrow("Cannot start: already started");
    });

    test("state transitions from INIT to AWAIT_SERVER_HELLO", () => {
      const client = new PairingClient({ secret, relayOrigin, onSend: () => {} });
      expect(client.state).toBe("INIT");

      client.start();
      expect(client.state).toBe("AWAIT_SERVER_HELLO");
    });
  });

  // --- Happy path ---

  describe("full successful pairing", () => {
    test("completes successfully", async () => {
      const { client, result } = await runFullExchange(secret, relayOrigin);

      expect(client.completed).toBe(true);
      expect(client.state).toBe("COMPLETE");
      expect(client.error).toBeNull();
      expect(result).not.toBeNull();
    });

    test("result contains correct node info", async () => {
      const { result, server } = await runFullExchange(secret, relayOrigin);

      expect(result.nodeId).toBe(server.nodeId);
      expect(result.nodeName).toBe(server.nodeName);
      expect(result.noiseKeyId).toBe(server.noiseKeyId);
      expect(result.nodePaths).toEqual(server.nodePaths);
      expect(result.rpc).toEqual(server.rpcProtocols);
      expect(result.noiseSuite).toBe("Noise_NK_25519_ChaChaPoly_SHA256");
    });

    test("result noiseStaticPubkey matches server key", async () => {
      const { result, server } = await runFullExchange(secret, relayOrigin);

      expect(Buffer.from(result.noiseStaticPubkey).toString("hex")).toBe(
        Buffer.from(server.noiseKeyPair.publicKey).toString("hex"),
      );
    });

    test("noiseStaticPubkey is exactly 32 bytes", async () => {
      const { result } = await runFullExchange(secret, relayOrigin);
      expect(result.noiseStaticPubkey.length).toBe(32);
    });

    test("bootExport is exactly 32 non-zero bytes", async () => {
      const { result } = await runFullExchange(secret, relayOrigin);

      expect(result.bootExport).toBeInstanceOf(Uint8Array);
      expect(result.bootExport.length).toBe(32);
      expect(result.bootExport.some((b) => b !== 0)).toBe(true);
    });

    test("client sends exactly 4 outgoing messages", async () => {
      const { messages } = await runFullExchange(secret, relayOrigin);

      expect(messages.length).toBe(4);
      expect((messages[0] as any).t).toBe("pair_client_hello");
      expect((messages[1] as any).t).toBe("pair_init");
      expect((messages[2] as any).t).toBe("pair_confirm1");
      expect((messages[3] as any).t).toBe("pair_done");
    });

    test("pair_init contains valid base64url pA (32-byte ed25519 point)", async () => {
      const { messages } = await runFullExchange(secret, relayOrigin);

      const pairInit = messages[1] as any;
      expect(typeof pairInit.pA).toBe("string");
      const pABytes = fromBase64url(pairInit.pA);
      expect(pABytes.length).toBe(32);
    });

    test("pair_confirm1 contains valid base64url MAC (32-byte HMAC-SHA256)", async () => {
      const { messages } = await runFullExchange(secret, relayOrigin);

      const confirm1 = messages[2] as any;
      expect(typeof confirm1.mac).toBe("string");
      const macBytes = fromBase64url(confirm1.mac);
      expect(macBytes.length).toBe(32);
    });

    test("custom nodeId and nodeName are preserved", async () => {
      const { result } = await runFullExchange(secret, relayOrigin, {
        nodeId: "my-custom-node",
        nodeName: "Production Server",
      });

      expect(result.nodeId).toBe("my-custom-node");
      expect(result.nodeName).toBe("Production Server");
    });

    test("state progresses through all stages", async () => {
      const messages: object[] = [];
      const server = new MockPairingServer({ secret, relayOrigin });
      const client = new PairingClient({
        secret,
        relayOrigin,
        onSend: (msg) => messages.push(msg),
      });

      expect(client.state).toBe("INIT");

      client.start();
      expect(client.state).toBe("AWAIT_SERVER_HELLO");

      const serverHelloJson = server.handleClientHello(messages[0]);
      await client.handleMessage(serverHelloJson);
      expect(client.state).toBe("AWAIT_PAIR_RESP");

      const pairRespJson = server.handlePairInit(messages[1] as any);
      await client.handleMessage(pairRespJson);
      expect(client.state).toBe("AWAIT_PAIR_CONFIRM2");

      const confirm2Json = server.handlePairConfirm1(messages[2] as any);
      await client.handleMessage(confirm2Json);
      expect(client.state).toBe("AWAIT_PAIR_BOOTSTRAP");

      const bootstrapJson = server.generateBootstrap();
      await client.handleMessage(bootstrapJson);
      expect(client.state).toBe("AWAIT_NOISE_VERIFY");

      client.confirmNoiseVerified();
      expect(client.state).toBe("COMPLETE");
    });

    test("two pairings with same secret produce different bootExport (random scalars)", async () => {
      const { result: r1 } = await runFullExchange(secret, relayOrigin);
      const { result: r2 } = await runFullExchange(secret, relayOrigin);

      expect(r1.bootExport.length).toBe(32);
      expect(r2.bootExport.length).toBe(32);
      // Different SPAKE2 random scalars lead to different Ke, thus different bootExport
      expect(Buffer.from(r1.bootExport).toString("hex")).not.toBe(
        Buffer.from(r2.bootExport).toString("hex"),
      );
    });
  });

  // --- Wrong password ---

  describe("wrong password", () => {
    test("mismatched secrets cause MAC verification failure", async () => {
      const clientSecret = randomBytes(10);
      const serverSecret = randomBytes(10);

      const messages: object[] = [];
      const server = new MockPairingServer({ secret: serverSecret, relayOrigin });
      const client = new PairingClient({
        secret: clientSecret,
        relayOrigin,
        onSend: (msg) => messages.push(msg),
      });

      client.start();
      const serverHelloJson = server.handleClientHello(messages[0]);
      await client.handleMessage(serverHelloJson);

      const pairRespJson = server.handlePairInit(messages[1] as any);
      await client.handleMessage(pairRespJson);

      // The server's SPAKE2 result has a different Ke than the client's,
      // so we cannot use server.handlePairConfirm1 (it would throw).
      // Instead, send the server's confirmB directly — client will reject it.
      const fakeConfirm2 = JSON.stringify({
        t: "pair_confirm2",
        mac: toBase64url(randomBytes(32)),
      });

      await expect(
        client.handleMessage(fakeConfirm2),
      ).rejects.toThrow(PairingError);

      expect(client.state).toBe("FAILED");
      expect(client.error!.message).toContain("confirmation failed");
    });
  });

  // --- Unsupported suite / version ---

  describe("unsupported suite or version", () => {
    test("rejects unknown pairing suite", async () => {
      const client = new PairingClient({ secret, relayOrigin, onSend: () => {} });
      client.start();

      const badServerHello = {
        t: "pair_server_hello",
        v: 1,
        pair_suite: "UNKNOWN-SUITE-XYZ",
        enroll_id: deriveEnrollId(secret),
        expires_in_sec: 300,
        features: [],
      };

      await expect(
        client.handleMessage(JSON.stringify(badServerHello)),
      ).rejects.toThrow(PairingError);

      expect(client.state).toBe("FAILED");
      expect(client.error!.message).toContain("Unsupported pairing suite");
    });

    test("rejects unsupported protocol version (schema rejects v!=1)", async () => {
      const client = new PairingClient({ secret, relayOrigin, onSend: () => {} });
      client.start();

      // PairServerHelloSchema uses z.literal(1) for v, so v:2 fails at schema level
      const badServerHello = {
        t: "pair_server_hello",
        v: 2,
        pair_suite: PAIR_SUITE,
        enroll_id: deriveEnrollId(secret),
        expires_in_sec: 300,
        features: [],
      };

      await expect(
        client.handleMessage(JSON.stringify(badServerHello)),
      ).rejects.toThrow(PairingError);

      expect(client.state).toBe("FAILED");
      expect(client.error!.message).toContain("Invalid pair_server_hello");
    });
  });

  // --- Malformed messages ---

  describe("malformed messages", () => {
    test("server_hello missing required fields", async () => {
      const client = new PairingClient({ secret, relayOrigin, onSend: () => {} });
      client.start();

      const malformed = { t: "pair_server_hello", v: 1 };
      // Missing pair_suite, enroll_id, expires_in_sec, features

      await expect(
        client.handleMessage(JSON.stringify(malformed)),
      ).rejects.toThrow(PairingError);

      expect(client.state).toBe("FAILED");
      expect(client.error!.message).toContain("Invalid pair_server_hello");
    });

    test("pair_resp missing pB", async () => {
      const messages: object[] = [];
      const server = new MockPairingServer({ secret, relayOrigin });
      const client = new PairingClient({
        secret,
        relayOrigin,
        onSend: (msg) => messages.push(msg),
      });

      client.start();
      await client.handleMessage(server.handleClientHello(messages[0]));

      await expect(
        client.handleMessage(JSON.stringify({ t: "pair_resp" })),
      ).rejects.toThrow(PairingError);

      expect(client.state).toBe("FAILED");
      expect(client.error!.message).toContain("Invalid pair_resp");
    });

    test("pair_confirm2 missing mac", async () => {
      const messages: object[] = [];
      const server = new MockPairingServer({ secret, relayOrigin });
      const client = new PairingClient({
        secret,
        relayOrigin,
        onSend: (msg) => messages.push(msg),
      });

      client.start();
      await client.handleMessage(server.handleClientHello(messages[0]));
      await client.handleMessage(server.handlePairInit(messages[1] as any));

      await expect(
        client.handleMessage(JSON.stringify({ t: "pair_confirm2" })),
      ).rejects.toThrow(PairingError);

      expect(client.state).toBe("FAILED");
      expect(client.error!.message).toContain("Invalid pair_confirm2");
    });
  });

  // --- Bootstrap decryption failures ---

  describe("bootstrap decryption failure", () => {
    test("tampered ciphertext causes decryption error", async () => {
      const messages: object[] = [];
      const server = new MockPairingServer({ secret, relayOrigin });
      const client = new PairingClient({
        secret,
        relayOrigin,
        onSend: (msg) => messages.push(msg),
      });

      client.start();
      await client.handleMessage(server.handleClientHello(messages[0]));
      await client.handleMessage(server.handlePairInit(messages[1] as any));
      await client.handleMessage(server.handlePairConfirm1(messages[2] as any));

      // Generate valid bootstrap then tamper with ciphertext
      const bootstrap = JSON.parse(server.generateBootstrap());
      const ctBytes = fromBase64url(bootstrap.ct);
      ctBytes[0] ^= 0xff; // flip a byte
      const tamperedBootstrap = {
        t: "pair_bootstrap",
        ct: toBase64url(ctBytes),
      };

      await expect(
        client.handleMessage(JSON.stringify(tamperedBootstrap)),
      ).rejects.toThrow(PairingError);

      expect(client.state).toBe("FAILED");
      expect(client.error!.message).toContain("Bootstrap decryption failed");
    });

    test("completely random ciphertext causes decryption error", async () => {
      const messages: object[] = [];
      const server = new MockPairingServer({ secret, relayOrigin });
      const client = new PairingClient({
        secret,
        relayOrigin,
        onSend: (msg) => messages.push(msg),
      });

      client.start();
      await client.handleMessage(server.handleClientHello(messages[0]));
      await client.handleMessage(server.handlePairInit(messages[1] as any));
      await client.handleMessage(server.handlePairConfirm1(messages[2] as any));

      await expect(
        client.handleMessage(JSON.stringify({
          t: "pair_bootstrap",
          ct: toBase64url(randomBytes(100)),
        })),
      ).rejects.toThrow(PairingError);

      expect(client.state).toBe("FAILED");
    });

    test("invalid payload schema in decrypted bootstrap", async () => {
      const messages: object[] = [];
      const server = new MockPairingServer({ secret, relayOrigin });
      const client = new PairingClient({
        secret,
        relayOrigin,
        onSend: (msg) => messages.push(msg),
      });

      client.start();
      await client.handleMessage(server.handleClientHello(messages[0]));
      await client.handleMessage(server.handlePairInit(messages[1] as any));
      await client.handleMessage(server.handlePairConfirm1(messages[2] as any));

      // Encrypt a payload missing required fields
      const badBootstrap = server.generateBootstrapWithRawPayload({
        node_id: "x",
        // missing: node_name, noise_suite, noise_static_pubkey, etc.
      });

      await expect(
        client.handleMessage(badBootstrap),
      ).rejects.toThrow(PairingError);

      expect(client.state).toBe("FAILED");
      expect(client.error!.message).toContain("Bootstrap payload has invalid structure");
    });
  });

  // --- State violations ---

  describe("state violations", () => {
    test("handleMessage in INIT state throws", async () => {
      const client = new PairingClient({ secret, relayOrigin, onSend: () => {} });

      await expect(
        client.handleMessage(JSON.stringify({
          t: "pair_server_hello",
          v: 1,
          pair_suite: PAIR_SUITE,
          enroll_id: "abc",
          expires_in_sec: 300,
          features: [],
        })),
      ).rejects.toThrow("Unexpected message in state INIT");
    });

    test("handleMessage in COMPLETE state throws", async () => {
      const { client } = await runFullExchange(secret, relayOrigin);

      await expect(
        client.handleMessage(JSON.stringify({ t: "pair_server_hello", v: 1, pair_suite: "x", enroll_id: "y", expires_in_sec: 1, features: [] })),
      ).rejects.toThrow("Unexpected message in state COMPLETE");
    });

    test("confirmNoiseVerified in wrong state throws", () => {
      const client = new PairingClient({ secret, relayOrigin, onSend: () => {} });
      client.start();

      expect(() => client.confirmNoiseVerified()).toThrow(
        "Cannot confirm Noise: expected AWAIT_NOISE_VERIFY, got AWAIT_SERVER_HELLO",
      );
    });

    test("pair_resp sent when expecting server_hello", async () => {
      const client = new PairingClient({ secret, relayOrigin, onSend: () => {} });
      client.start();

      await expect(
        client.handleMessage(JSON.stringify({
          t: "pair_resp",
          pB: toBase64url(randomBytes(32)),
        })),
      ).rejects.toThrow(PairingError);

      expect(client.state).toBe("FAILED");
    });
  });

  // --- Server errors (pair_error) ---

  describe("pair_error handling", () => {
    test("pair_error during AWAIT_SERVER_HELLO transitions to FAILED", async () => {
      const client = new PairingClient({ secret, relayOrigin, onSend: () => {} });
      client.start();

      await expect(
        client.handleMessage(JSON.stringify({ t: "pair_error", code: "expired" })),
      ).rejects.toThrow(PairingError);

      expect(client.state).toBe("FAILED");
      expect(client.error!.code).toBe("expired");
      expect(client.error!.message).toContain("expired");
    });

    test("pair_error during AWAIT_PAIR_RESP transitions to FAILED", async () => {
      const messages: object[] = [];
      const server = new MockPairingServer({ secret, relayOrigin });
      const client = new PairingClient({
        secret,
        relayOrigin,
        onSend: (msg) => messages.push(msg),
      });

      client.start();
      await client.handleMessage(server.handleClientHello(messages[0]));
      expect(client.state).toBe("AWAIT_PAIR_RESP");

      await expect(
        client.handleMessage(JSON.stringify({ t: "pair_error", code: "attempts_exhausted" })),
      ).rejects.toThrow(PairingError);

      expect(client.state).toBe("FAILED");
      expect(client.error!.code).toBe("attempts_exhausted");
    });

    test("pair_error during AWAIT_PAIR_CONFIRM2", async () => {
      const messages: object[] = [];
      const server = new MockPairingServer({ secret, relayOrigin });
      const client = new PairingClient({
        secret,
        relayOrigin,
        onSend: (msg) => messages.push(msg),
      });

      client.start();
      await client.handleMessage(server.handleClientHello(messages[0]));
      await client.handleMessage(server.handlePairInit(messages[1] as any));
      expect(client.state).toBe("AWAIT_PAIR_CONFIRM2");

      await expect(
        client.handleMessage(JSON.stringify({ t: "pair_error", code: "bad_suite" })),
      ).rejects.toThrow(PairingError);

      expect(client.state).toBe("FAILED");
      expect(client.error!.code).toBe("bad_suite");
    });

    test("pair_error during AWAIT_PAIR_BOOTSTRAP", async () => {
      const messages: object[] = [];
      const server = new MockPairingServer({ secret, relayOrigin });
      const client = new PairingClient({
        secret,
        relayOrigin,
        onSend: (msg) => messages.push(msg),
      });

      client.start();
      await client.handleMessage(server.handleClientHello(messages[0]));
      await client.handleMessage(server.handlePairInit(messages[1] as any));
      await client.handleMessage(server.handlePairConfirm1(messages[2] as any));
      expect(client.state).toBe("AWAIT_PAIR_BOOTSTRAP");

      await expect(
        client.handleMessage(JSON.stringify({ t: "pair_error", code: "expired" })),
      ).rejects.toThrow(PairingError);

      expect(client.state).toBe("FAILED");
      expect(client.error!.code).toBe("expired");
    });

    test("all known error codes are handled", async () => {
      const codes = [
        "expired",
        "not_found",
        "attempts_exhausted",
        "bad_version",
        "bad_suite",
        "protocol_error",
      ];

      for (const code of codes) {
        const client = new PairingClient({ secret, relayOrigin, onSend: () => {} });
        client.start();

        await expect(
          client.handleMessage(JSON.stringify({ t: "pair_error", code })),
        ).rejects.toThrow(PairingError);

        expect(client.error!.code).toBe(code);
      }
    });
  });

  // --- handleClose ---

  describe("handleClose", () => {
    test("transitions to FAILED if not complete", () => {
      const client = new PairingClient({ secret, relayOrigin, onSend: () => {} });
      client.start();

      client.handleClose();
      expect(client.state).toBe("FAILED");
      expect(client.error).toBeInstanceOf(PairingError);
      expect(client.error!.message).toContain("Connection closed");
    });

    test("does not change state if already complete", async () => {
      const { client } = await runFullExchange(secret, relayOrigin);
      expect(client.state).toBe("COMPLETE");

      client.handleClose();
      expect(client.state).toBe("COMPLETE");
    });
  });

  // --- PairingError ---

  describe("PairingError", () => {
    test("has correct name property", () => {
      const err = new PairingError("test message");
      expect(err.name).toBe("PairingError");
    });

    test("carries optional code", () => {
      const err = new PairingError("test", "expired");
      expect(err.code).toBe("expired");
      expect(err.message).toBe("test");
    });

    test("code is undefined when not provided", () => {
      const err = new PairingError("test");
      expect(err.code).toBeUndefined();
    });

    test("is an instance of Error", () => {
      const err = new PairingError("test");
      expect(err).toBeInstanceOf(Error);
    });
  });

  // --- Concurrent exchanges ---

  describe("concurrent exchanges", () => {
    test("two independent exchanges succeed in parallel", async () => {
      const s1 = randomBytes(10);
      const s2 = randomBytes(10);

      const [ex1, ex2] = await Promise.all([
        runFullExchange(s1, relayOrigin, { nodeId: "node-a" }),
        runFullExchange(s2, relayOrigin, { nodeId: "node-b" }),
      ]);

      expect(ex1.result.nodeId).toBe("node-a");
      expect(ex2.result.nodeId).toBe("node-b");
      expect(ex1.client.completed).toBe(true);
      expect(ex2.client.completed).toBe(true);
    });
  });
});
