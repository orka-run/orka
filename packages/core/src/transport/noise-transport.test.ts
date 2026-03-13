import { describe, expect, it } from "bun:test";
import { generateX25519KeyPair } from "../crypto/noise";
import { sha256 } from "../crypto/hash";
import { NOISE_SUITE, APP_PROTOCOL } from "../transport-protocol";
import {
  NoiseClientTransport,
  NoiseServerTransport,
  computeKeyId,
} from "./noise-transport";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServerKeypairAndId() {
  const keypair = generateX25519KeyPair();
  const keyId = computeKeyId(keypair.publicKey);
  return { keypair, keyId };
}

const NODE_ID = "test-node";
const RELAY_ORIGIN = "ws://relay.test:7390";

/**
 * Run a full handshake between a client and server transport.
 * Returns both transports in SECURE state.
 */
function performHandshake(opts?: {
  nodeId?: string;
  clientNodeId?: string;
  expectedKeyId?: string;
  clientExpectedKeyId?: string;
  serverKeyId?: string;
  relayOrigin?: string;
  serverSuites?: string[];
  serverProtocols?: string[];
  serverMaxFrame?: number;
  clientHelloVersion?: number;
}) {
  const { keypair, keyId } = makeServerKeypairAndId();
  const nodeId = opts?.nodeId ?? NODE_ID;
  const relayOrigin = opts?.relayOrigin ?? RELAY_ORIGIN;

  const server = new NoiseServerTransport({
    nodeId,
    keyId: opts?.serverKeyId ?? keyId,
    staticKeypair: keypair,
    relayOrigin,
    supportedSuites: opts?.serverSuites,
    supportedProtocols: opts?.serverProtocols,
    maxFrame: opts?.serverMaxFrame,
  });

  const client = new NoiseClientTransport({
    nodeId: opts?.clientNodeId ?? nodeId,
    expectedKeyId: opts?.clientExpectedKeyId ?? opts?.expectedKeyId ?? keyId,
    remoteStaticPubkey: keypair.publicKey,
    relayOrigin,
  });

  // Step 1: Client sends client_hello
  const clientHello = client.getClientHello();

  // Step 2: Server processes client_hello, returns server_hello
  const serverResponses = server.processMessage(clientHello);

  // Step 3: Client processes server_hello (or transport_error), returns noise_1
  const clientResponses: unknown[] = [];
  for (const resp of serverResponses) {
    const msgs = client.processMessage(resp);
    clientResponses.push(...msgs);
  }

  // Step 4: Server processes noise_1, returns noise_2
  const serverResponses2: unknown[] = [];
  for (const resp of clientResponses) {
    const msgs = server.processMessage(resp);
    serverResponses2.push(...msgs);
  }

  // Step 5: Client processes noise_2
  for (const resp of serverResponses2) {
    client.processMessage(resp);
  }

  return { client, server, keypair, keyId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NoiseTransport", () => {
  describe("key_id derivation", () => {
    it("computes key_id as sha256:<hex>", () => {
      const keypair = generateX25519KeyPair();
      const keyId = computeKeyId(keypair.publicKey);

      expect(keyId.startsWith("sha256:")).toBe(true);

      // Verify the hex portion matches SHA-256 of the public key
      const expectedHash = sha256(keypair.publicKey);
      const expectedHex = Buffer.from(expectedHash).toString("hex");
      expect(keyId).toBe("sha256:" + expectedHex);
    });

    it("produces a 71-character string (sha256: + 64 hex chars)", () => {
      const keypair = generateX25519KeyPair();
      const keyId = computeKeyId(keypair.publicKey);
      // "sha256:" = 7 chars, 32 bytes = 64 hex chars → 71 total
      expect(keyId.length).toBe(71);
    });

    it("different keys produce different key_ids", () => {
      const k1 = generateX25519KeyPair();
      const k2 = generateX25519KeyPair();
      expect(computeKeyId(k1.publicKey)).not.toBe(computeKeyId(k2.publicKey));
    });
  });

  describe("full handshake", () => {
    it("completes a full client-server handshake", () => {
      const { client, server } = performHandshake();

      expect(client.state).toBe("SECURE");
      expect(server.state).toBe("SECURE");
      expect(client.isSecure).toBe(true);
      expect(server.isSecure).toBe(true);
    });

    it("session_id is non-null after handshake", () => {
      const { client, server } = performHandshake();

      expect(client.sessionId).not.toBeNull();
      expect(server.sessionId).not.toBeNull();
    });

    it("session_id matches on both sides", () => {
      const { client, server } = performHandshake();

      expect(client.sessionId).not.toBeNull();
      expect(server.sessionId).not.toBeNull();
      expect(Buffer.from(client.sessionId!).toString("hex")).toBe(
        Buffer.from(server.sessionId!).toString("hex"),
      );
    });

    it("session_id is 32 bytes (SHA-256 handshake hash)", () => {
      const { client } = performHandshake();
      expect(client.sessionId!.length).toBe(32);
    });
  });

  describe("encrypted RPC exchange", () => {
    it("client can send encrypted RPC to server", () => {
      const { client, server } = performHandshake();

      const rpc = { jsonrpc: "2.0", method: "ps", id: 1, params: {} };
      const frame = client.encryptRpc(rpc);

      expect(frame.t).toBe("data");
      expect(typeof frame.ct).toBe("string");

      const decrypted = server.decryptData(frame);
      expect(decrypted).toEqual(rpc);
    });

    it("server can send encrypted RPC to client", () => {
      const { client, server } = performHandshake();

      const rpc = {
        jsonrpc: "2.0",
        id: 1,
        result: { sessions: [] },
      };
      const frame = server.encryptRpc(rpc);
      const decrypted = client.decryptData(frame);
      expect(decrypted).toEqual(rpc);
    });

    it("bidirectional exchange works", () => {
      const { client, server } = performHandshake();

      // Client → Server
      const req = { jsonrpc: "2.0", method: "spawn", id: 42, params: { backend: "claude" } };
      const reqFrame = client.encryptRpc(req);
      expect(server.decryptData(reqFrame)).toEqual(req);

      // Server → Client
      const resp = { jsonrpc: "2.0", id: 42, result: { sessionId: "sess-abc" } };
      const respFrame = server.encryptRpc(resp);
      expect(client.decryptData(respFrame)).toEqual(resp);
    });

    it("multiple messages can be encrypted/decrypted (nonce increments)", () => {
      const { client, server } = performHandshake();

      // Send 10 messages in each direction to exercise nonce incrementing
      for (let i = 0; i < 10; i++) {
        const rpc = { jsonrpc: "2.0", method: "ping", id: i, params: { seq: i } };
        const frame = client.encryptRpc(rpc);
        const decrypted = server.decryptData(frame);
        expect(decrypted).toEqual(rpc);
      }

      for (let i = 0; i < 10; i++) {
        const rpc = { jsonrpc: "2.0", id: i, result: { pong: i } };
        const frame = server.encryptRpc(rpc);
        const decrypted = client.decryptData(frame);
        expect(decrypted).toEqual(rpc);
      }
    });

    it("ciphertext differs for identical plaintext (different nonce)", () => {
      const { client } = performHandshake();

      const rpc = { jsonrpc: "2.0", method: "test", id: 1 };
      const frame1 = client.encryptRpc(rpc);
      const frame2 = client.encryptRpc(rpc);

      expect(frame1.ct).not.toBe(frame2.ct);
    });

    it("cross-side decryption fails (wrong cipher state)", () => {
      const { client, server } = performHandshake();

      // Client encrypts a message
      const rpc = { jsonrpc: "2.0", method: "test", id: 1 };
      const frame = client.encryptRpc(rpc);

      // Trying to decrypt with client's own decryptData should fail because
      // the client's recvCipher expects messages encrypted with the server's
      // sendCipher. We need to consume a message from server first to match
      // nonces, but even so the keys differ.
      expect(() => client.decryptData(frame)).toThrow();
    });
  });

  describe("negotiation errors", () => {
    it("version mismatch produces transport_error", () => {
      const { keypair, keyId } = makeServerKeypairAndId();

      const server = new NoiseServerTransport({
        nodeId: NODE_ID,
        keyId,
        staticKeypair: keypair,
        relayOrigin: RELAY_ORIGIN,
      });

      // Manually craft a client_hello with wrong version
      const badHello = {
        t: "client_hello",
        v: 99,
        noise_suites: [NOISE_SUITE],
        node_id: NODE_ID,
        expected_key_id: keyId,
        app_protocols: [APP_PROTOCOL],
        features: [],
      };

      const responses = server.processMessage(badHello);
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        t: "transport_error",
        code: "unsupported_version",
      });
      expect(server.state).toBe("CLOSED");
    });

    it("suite mismatch produces transport_error", () => {
      const { keypair, keyId } = makeServerKeypairAndId();

      const server = new NoiseServerTransport({
        nodeId: NODE_ID,
        keyId,
        staticKeypair: keypair,
        relayOrigin: RELAY_ORIGIN,
        supportedSuites: ["Noise_IK_448_AESGCM_BLAKE2b"],
      });

      const client = new NoiseClientTransport({
        nodeId: NODE_ID,
        expectedKeyId: keyId,
        remoteStaticPubkey: keypair.publicKey,
        relayOrigin: RELAY_ORIGIN,
      });

      const clientHello = client.getClientHello();
      const responses = server.processMessage(clientHello);

      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        t: "transport_error",
        code: "unsupported_suite",
      });
      expect(server.state).toBe("CLOSED");
    });

    it("key_id mismatch produces transport_error", () => {
      const { keypair, keyId } = makeServerKeypairAndId();

      const server = new NoiseServerTransport({
        nodeId: NODE_ID,
        keyId,
        staticKeypair: keypair,
        relayOrigin: RELAY_ORIGIN,
      });

      const client = new NoiseClientTransport({
        nodeId: NODE_ID,
        expectedKeyId: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        remoteStaticPubkey: keypair.publicKey,
        relayOrigin: RELAY_ORIGIN,
      });

      const clientHello = client.getClientHello();
      const responses = server.processMessage(clientHello);

      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        t: "transport_error",
        code: "key_id_mismatch",
      });
      expect(server.state).toBe("CLOSED");
    });

    it("client throws on transport_error from server", () => {
      const { keypair, keyId } = makeServerKeypairAndId();

      const server = new NoiseServerTransport({
        nodeId: NODE_ID,
        keyId,
        staticKeypair: keypair,
        relayOrigin: RELAY_ORIGIN,
        supportedSuites: ["Noise_IK_448_AESGCM_BLAKE2b"],
      });

      const client = new NoiseClientTransport({
        nodeId: NODE_ID,
        expectedKeyId: keyId,
        remoteStaticPubkey: keypair.publicKey,
        relayOrigin: RELAY_ORIGIN,
      });

      const clientHello = client.getClientHello();
      const responses = server.processMessage(clientHello);

      // Client should throw when it receives the transport_error
      expect(() => client.processMessage(responses[0])).toThrow(
        /server rejected handshake.*unsupported_suite/,
      );
      expect(client.state).toBe("CLOSED");
    });

    it("node_id mismatch produces transport_error (no_such_node)", () => {
      const { keypair, keyId } = makeServerKeypairAndId();

      const server = new NoiseServerTransport({
        nodeId: "actual-node",
        keyId,
        staticKeypair: keypair,
        relayOrigin: RELAY_ORIGIN,
      });

      const clientHello = {
        t: "client_hello",
        v: 1,
        noise_suites: [NOISE_SUITE],
        node_id: "wrong-node",
        expected_key_id: keyId,
        app_protocols: [APP_PROTOCOL],
        features: [],
      };

      const responses = server.processMessage(clientHello);
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        t: "transport_error",
        code: "no_such_node",
      });
    });

    it("protocol mismatch produces transport_error", () => {
      const { keypair, keyId } = makeServerKeypairAndId();

      const server = new NoiseServerTransport({
        nodeId: NODE_ID,
        keyId,
        staticKeypair: keypair,
        relayOrigin: RELAY_ORIGIN,
        supportedProtocols: ["grpc"],
      });

      const clientHello = {
        t: "client_hello",
        v: 1,
        noise_suites: [NOISE_SUITE],
        node_id: NODE_ID,
        expected_key_id: keyId,
        app_protocols: [APP_PROTOCOL],
        features: [],
      };

      const responses = server.processMessage(clientHello);
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        t: "transport_error",
        code: "protocol_error",
      });
    });
  });

  describe("state enforcement", () => {
    it("client: cannot call getClientHello twice", () => {
      const { keypair, keyId } = makeServerKeypairAndId();
      const client = new NoiseClientTransport({
        nodeId: NODE_ID,
        expectedKeyId: keyId,
        remoteStaticPubkey: keypair.publicKey,
        relayOrigin: RELAY_ORIGIN,
      });

      client.getClientHello();
      expect(() => client.getClientHello()).toThrow(/cannot send client_hello/);
    });

    it("client: cannot encrypt before handshake", () => {
      const { keypair, keyId } = makeServerKeypairAndId();
      const client = new NoiseClientTransport({
        nodeId: NODE_ID,
        expectedKeyId: keyId,
        remoteStaticPubkey: keypair.publicKey,
        relayOrigin: RELAY_ORIGIN,
      });

      expect(() => client.encryptRpc({ test: true })).toThrow(
        /not in SECURE state/,
      );
    });

    it("client: cannot decrypt before handshake", () => {
      const { keypair, keyId } = makeServerKeypairAndId();
      const client = new NoiseClientTransport({
        nodeId: NODE_ID,
        expectedKeyId: keyId,
        remoteStaticPubkey: keypair.publicKey,
        relayOrigin: RELAY_ORIGIN,
      });

      expect(() =>
        client.decryptData({ t: "data", ct: "AAAA" }),
      ).toThrow(/not in SECURE state/);
    });

    it("server: cannot encrypt before handshake", () => {
      const { keypair, keyId } = makeServerKeypairAndId();
      const server = new NoiseServerTransport({
        nodeId: NODE_ID,
        keyId,
        staticKeypair: keypair,
        relayOrigin: RELAY_ORIGIN,
      });

      expect(() => server.encryptRpc({ test: true })).toThrow(
        /not in SECURE state/,
      );
    });

    it("server: cannot decrypt before handshake", () => {
      const { keypair, keyId } = makeServerKeypairAndId();
      const server = new NoiseServerTransport({
        nodeId: NODE_ID,
        keyId,
        staticKeypair: keypair,
        relayOrigin: RELAY_ORIGIN,
      });

      expect(() =>
        server.decryptData({ t: "data", ct: "AAAA" }),
      ).toThrow(/not in SECURE state/);
    });

    it("client: unexpected message type throws", () => {
      const { keypair, keyId } = makeServerKeypairAndId();
      const client = new NoiseClientTransport({
        nodeId: NODE_ID,
        expectedKeyId: keyId,
        remoteStaticPubkey: keypair.publicKey,
        relayOrigin: RELAY_ORIGIN,
      });
      client.getClientHello();

      expect(() =>
        client.processMessage({ t: "noise_1", msg: "AAAA" }),
      ).toThrow(/unexpected message type/);
    });

    it("server: unexpected message type returns transport_error", () => {
      const { keypair, keyId } = makeServerKeypairAndId();
      const server = new NoiseServerTransport({
        nodeId: NODE_ID,
        keyId,
        staticKeypair: keypair,
        relayOrigin: RELAY_ORIGIN,
      });

      const result = server.processMessage({ t: "noise_2", msg: "AAAA" });
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ t: "transport_error", code: "protocol_error" });
      expect(server.state).toBe("CLOSED");
    });

    it("server: client_hello in wrong state returns transport_error", () => {
      const { keypair, keyId } = makeServerKeypairAndId();
      const server = new NoiseServerTransport({
        nodeId: NODE_ID,
        keyId,
        staticKeypair: keypair,
        relayOrigin: RELAY_ORIGIN,
      });

      // Send first client_hello — works
      const hello = {
        t: "client_hello",
        v: 1,
        noise_suites: [NOISE_SUITE],
        node_id: NODE_ID,
        expected_key_id: keyId,
        app_protocols: [APP_PROTOCOL],
        features: [],
      };
      server.processMessage(hello);

      // Send second client_hello — should return transport_error
      const result = server.processMessage(hello);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ t: "transport_error", code: "protocol_error" });
      expect(server.state).toBe("CLOSED");
    });

    it("client: noise_2 in wrong state throws", () => {
      const { keypair, keyId } = makeServerKeypairAndId();
      const client = new NoiseClientTransport({
        nodeId: NODE_ID,
        expectedKeyId: keyId,
        remoteStaticPubkey: keypair.publicKey,
        relayOrigin: RELAY_ORIGIN,
      });
      client.getClientHello();

      // noise_2 before server_hello should fail (state is HELLO_SENT, not NOISE_1_SENT)
      expect(() =>
        client.processMessage({ t: "noise_2", msg: "AAAA" }),
      ).toThrow(/unexpected noise_2/);
    });

    it("client: processMessage on closed transport throws", () => {
      const { keypair, keyId } = makeServerKeypairAndId();

      const server = new NoiseServerTransport({
        nodeId: NODE_ID,
        keyId,
        staticKeypair: keypair,
        relayOrigin: RELAY_ORIGIN,
        supportedSuites: ["Noise_IK_448_AESGCM_BLAKE2b"],
      });

      const client = new NoiseClientTransport({
        nodeId: NODE_ID,
        expectedKeyId: keyId,
        remoteStaticPubkey: keypair.publicKey,
        relayOrigin: RELAY_ORIGIN,
      });

      const clientHello = client.getClientHello();
      const responses = server.processMessage(clientHello);

      // This throws and sets state to CLOSED
      try {
        client.processMessage(responses[0]);
      } catch {
        // expected
      }

      // Now try again — should get "transport is closed"
      expect(() =>
        client.processMessage({ t: "server_hello" }),
      ).toThrow(/transport is closed/);
    });

    it("server: processMessage on closed transport throws", () => {
      const { keypair, keyId } = makeServerKeypairAndId();

      const server = new NoiseServerTransport({
        nodeId: NODE_ID,
        keyId,
        staticKeypair: keypair,
        relayOrigin: RELAY_ORIGIN,
      });

      // Send a version-mismatched hello to close the transport
      const badHello = {
        t: "client_hello",
        v: 99,
        noise_suites: [NOISE_SUITE],
        node_id: NODE_ID,
        expected_key_id: keyId,
        app_protocols: [APP_PROTOCOL],
        features: [],
      };
      server.processMessage(badHello);
      expect(server.state).toBe("CLOSED");

      expect(() =>
        server.processMessage({ t: "client_hello" }),
      ).toThrow(/transport is closed/);
    });
  });

  describe("initial state", () => {
    it("client starts in WS_OPEN state", () => {
      const { keypair, keyId } = makeServerKeypairAndId();
      const client = new NoiseClientTransport({
        nodeId: NODE_ID,
        expectedKeyId: keyId,
        remoteStaticPubkey: keypair.publicKey,
        relayOrigin: RELAY_ORIGIN,
      });

      expect(client.state).toBe("WS_OPEN");
      expect(client.isSecure).toBe(false);
      expect(client.sessionId).toBeNull();
    });

    it("server starts in WS_OPEN state", () => {
      const { keypair, keyId } = makeServerKeypairAndId();
      const server = new NoiseServerTransport({
        nodeId: NODE_ID,
        keyId,
        staticKeypair: keypair,
        relayOrigin: RELAY_ORIGIN,
      });

      expect(server.state).toBe("WS_OPEN");
      expect(server.isSecure).toBe(false);
      expect(server.sessionId).toBeNull();
    });
  });

  describe("different handshake sessions produce different session_ids", () => {
    it("two independent handshakes yield different session_ids", () => {
      const { client: c1 } = performHandshake();
      const { client: c2 } = performHandshake();

      expect(Buffer.from(c1.sessionId!).toString("hex")).not.toBe(
        Buffer.from(c2.sessionId!).toString("hex"),
      );
    });
  });

  describe("large payload", () => {
    it("encrypts and decrypts a large RPC payload", () => {
      const { client, server } = performHandshake();

      // Build a large RPC payload (~100KB)
      const largeData: Record<string, unknown> = {
        jsonrpc: "2.0",
        method: "bulkData",
        id: 999,
        params: { data: "x".repeat(100_000) },
      };

      const frame = client.encryptRpc(largeData);
      const decrypted = server.decryptData(frame);
      expect(decrypted).toEqual(largeData);
    });
  });
});
