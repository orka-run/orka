/**
 * Noise NK transport handshake and encrypted frame handling.
 *
 * Implements the full connection lifecycle for both client (initiator) and
 * node (responder) sides of the Orka transport protocol:
 *
 *   1. Cleartext hello negotiation (client_hello / server_hello)
 *   2. Noise NK handshake (noise_1 / noise_2)
 *   3. Encrypted data frames (data)
 *
 * Client-side state machine:
 *   WS_OPEN → HELLO_SENT → HELLO_CONFIRMED → NOISE_1_SENT → SECURE → CLOSED
 *
 * Node-side state machine:
 *   WS_OPEN → HELLO_RCVD → HELLO_SENT → NOISE_2_SENT → SECURE → CLOSED
 */

import { sha256 } from "../crypto/hash";
import { toBase64url, fromBase64url, toHex } from "../crypto/encoding";
import {
  createInitiator,
  createResponder,
  type CipherState,
  type NoiseInitiator,
  type NoiseResponder,
  type X25519KeyPair,
} from "../crypto/noise";
import {
  type ClientHello,
  ClientHelloSchema,
  type DataFrame,
  DataFrameSchema,
  type Noise1,
  Noise1Schema,
  type Noise2,
  Noise2Schema,
  type ServerHello,
  ServerHelloSchema,
  type TransportError,
  type TransportMessage,
  type TransportPayload,
  TransportPayloadSchema,
  APP_PROTOCOL,
  DEFAULT_MAX_FRAME,
  NOISE_SUITE,
  computeTransportPrologue,
  negotiateTransport,
} from "../transport-protocol";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute key_id from a static public key: "sha256:" + hex(SHA-256(pubkey)). */
export function computeKeyId(publicKey: Uint8Array): string {
  const hash = sha256(publicKey);
  return "sha256:" + toHex(hash);
}

// ---------------------------------------------------------------------------
// Client state type
// ---------------------------------------------------------------------------

export type ClientState =
  | "WS_OPEN"
  | "HELLO_SENT"
  | "HELLO_CONFIRMED"
  | "NOISE_1_SENT"
  | "SECURE"
  | "CLOSED";

// ---------------------------------------------------------------------------
// Server state type
// ---------------------------------------------------------------------------

export type ServerState =
  | "WS_OPEN"
  | "HELLO_RCVD"
  | "HELLO_SENT"
  | "NOISE_2_SENT"
  | "SECURE"
  | "CLOSED";

// ---------------------------------------------------------------------------
// NoiseClientTransport
// ---------------------------------------------------------------------------

export interface NoiseClientTransportOpts {
  nodeId: string;
  expectedKeyId: string;
  remoteStaticPubkey: Uint8Array;
  relayOrigin: string;
}

/**
 * Client (initiator) side of the Noise NK transport.
 *
 * Usage:
 *   1. Call getClientHello() and send the result over the wire.
 *   2. For each incoming message, call processMessage(msg) and send all
 *      returned messages over the wire.
 *   3. Once state === "SECURE", use encryptRpc() / decryptData() for
 *      application-layer traffic.
 */
export class NoiseClientTransport {
  private _state: ClientState = "WS_OPEN";
  private _sessionId: Uint8Array | null = null;

  private sendCipher: CipherState | null = null;
  private recvCipher: CipherState | null = null;
  private initiator: NoiseInitiator | null = null;

  private clientHello: ClientHello | null = null;
  private serverHello: ServerHello | null = null;

  constructor(private readonly opts: NoiseClientTransportOpts) {}

  // -- Public getters -------------------------------------------------------

  get state(): ClientState {
    return this._state;
  }

  get sessionId(): Uint8Array | null {
    return this._sessionId;
  }

  get isSecure(): boolean {
    return this._state === "SECURE";
  }

  // -- Hello ----------------------------------------------------------------

  /** Build the client_hello message. Transitions WS_OPEN → HELLO_SENT. */
  getClientHello(): ClientHello {
    if (this._state !== "WS_OPEN") {
      throw new Error(
        `NoiseClientTransport: cannot send client_hello in state ${this._state}`,
      );
    }

    const hello: ClientHello = {
      t: "client_hello",
      v: 1,
      noise_suites: [NOISE_SUITE],
      node_id: this.opts.nodeId,
      expected_key_id: this.opts.expectedKeyId,
      app_protocols: [APP_PROTOCOL],
      features: [],
    };

    this.clientHello = hello;
    this._state = "HELLO_SENT";
    return hello;
  }

  // -- Message processing ---------------------------------------------------

  /**
   * Process an incoming wire message. Returns zero or more messages to send
   * back over the wire.
   */
  processMessage(msg: unknown): TransportMessage[] {
    if (this._state === "CLOSED") {
      throw new Error("NoiseClientTransport: transport is closed");
    }

    // Try to detect the message type from the `t` field.
    const parsed = msg as Record<string, unknown>;
    const t = parsed?.t;

    switch (t) {
      case "server_hello":
        return this.handleServerHello(parsed);
      case "transport_error":
        return this.handleTransportError(parsed);
      case "noise_2":
        return this.handleNoise2(parsed);
      default:
        throw new Error(
          `NoiseClientTransport: unexpected message type "${t}" in state ${this._state}`,
        );
    }
  }

  // -- Secure channel -------------------------------------------------------

  /** Encrypt an RPC payload into a data frame. Only valid in SECURE state. */
  encryptRpc(rpc: Record<string, unknown>): DataFrame {
    if (this._state !== "SECURE" || !this.sendCipher) {
      throw new Error(
        "NoiseClientTransport: cannot encrypt — transport is not in SECURE state",
      );
    }
    const payload: TransportPayload = { v: 1, kind: "rpc", rpc };
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ct = this.sendCipher.encrypt(plaintext);
    return { t: "data", ct: toBase64url(ct) };
  }

  /** Encrypt a push envelope into a data frame. Only valid in SECURE state. */
  encryptPush(push: Record<string, unknown>): DataFrame {
    if (this._state !== "SECURE" || !this.sendCipher) {
      throw new Error(
        "NoiseClientTransport: cannot encrypt — transport is not in SECURE state",
      );
    }
    const payload: TransportPayload = { v: 1, kind: "push", push };
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ct = this.sendCipher.encrypt(plaintext);
    return { t: "data", ct: toBase64url(ct) };
  }

  /** Encrypt a push control message into a data frame. Only valid in SECURE state. */
  encryptPushControl(pushControl: Record<string, unknown>): DataFrame {
    if (this._state !== "SECURE" || !this.sendCipher) {
      throw new Error(
        "NoiseClientTransport: cannot encrypt — transport is not in SECURE state",
      );
    }
    const payload: TransportPayload = { v: 1, kind: "push_control", push_control: pushControl };
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ct = this.sendCipher.encrypt(plaintext);
    return { t: "data", ct: toBase64url(ct) };
  }

  /** Decrypt an incoming data frame and return the full transport payload. Only valid in SECURE state. */
  decryptFrame(frame: DataFrame): TransportPayload {
    if (this._state !== "SECURE" || !this.recvCipher) {
      throw new Error(
        "NoiseClientTransport: cannot decrypt — transport is not in SECURE state",
      );
    }
    const ct = fromBase64url(frame.ct);
    const plaintext = this.recvCipher.decrypt(ct);
    const decoded = JSON.parse(new TextDecoder().decode(plaintext));
    return TransportPayloadSchema.parse(decoded);
  }

  /** Decrypt an incoming data frame containing an RPC payload. Only valid in SECURE state. */
  decryptData(frame: DataFrame): Record<string, unknown> {
    const payload = this.decryptFrame(frame);
    if (payload.kind !== "rpc") {
      throw new Error(`Expected RPC payload, got ${payload.kind}`);
    }
    return payload.rpc;
  }

  // -- Internal handlers ----------------------------------------------------

  private handleServerHello(
    raw: Record<string, unknown>,
  ): TransportMessage[] {
    if (this._state !== "HELLO_SENT") {
      throw new Error(
        `NoiseClientTransport: unexpected server_hello in state ${this._state}`,
      );
    }

    const serverHello = ServerHelloSchema.parse(raw);
    this.serverHello = serverHello;
    this._state = "HELLO_CONFIRMED";

    // Compute prologue
    const prologue = computeTransportPrologue(
      this.clientHello!,
      serverHello,
      this.opts.relayOrigin,
    );

    // Create Noise initiator
    this.initiator = createInitiator(prologue, this.opts.remoteStaticPubkey);

    // Write noise_1
    const msg1 = this.initiator.writeMessage1();
    const noise1: Noise1 = {
      t: "noise_1",
      msg: toBase64url(msg1),
    };

    this._state = "NOISE_1_SENT";
    return [noise1];
  }

  private handleTransportError(
    raw: Record<string, unknown>,
  ): TransportMessage[] {
    this._state = "CLOSED";
    const err = raw as TransportError;
    throw new Error(
      `NoiseClientTransport: server rejected handshake: ${err.code}`,
    );
  }

  private handleNoise2(raw: Record<string, unknown>): TransportMessage[] {
    if (this._state !== "NOISE_1_SENT") {
      throw new Error(
        `NoiseClientTransport: unexpected noise_2 in state ${this._state}`,
      );
    }
    if (!this.initiator) {
      throw new Error("NoiseClientTransport: no initiator available");
    }

    const noise2 = Noise2Schema.parse(raw);
    const msg2Bytes = fromBase64url(noise2.msg);
    const { result } = this.initiator.readMessage2(msg2Bytes);

    this.sendCipher = result.sendCipher;
    this.recvCipher = result.recvCipher;
    this._sessionId = result.handshakeHash;
    this._state = "SECURE";

    return [];
  }
}

// ---------------------------------------------------------------------------
// NoiseServerTransport
// ---------------------------------------------------------------------------

export interface NoiseServerTransportOpts {
  nodeId: string;
  keyId: string;
  staticKeypair: X25519KeyPair;
  relayOrigin: string;
  supportedSuites?: string[];
  supportedProtocols?: string[];
  maxFrame?: number;
}

/**
 * Node (responder) side of the Noise NK transport.
 *
 * Usage:
 *   1. For each incoming message, call processMessage(msg) and send all
 *      returned messages over the wire.
 *   2. Once state === "SECURE", use encryptRpc() / decryptData() for
 *      application-layer traffic.
 */
export class NoiseServerTransport {
  private _state: ServerState = "WS_OPEN";
  private _sessionId: Uint8Array | null = null;

  private sendCipher: CipherState | null = null;
  private recvCipher: CipherState | null = null;
  private responder: NoiseResponder | null = null;

  private clientHello: ClientHello | null = null;
  private serverHello: ServerHello | null = null;

  private readonly supportedSuites: string[];
  private readonly supportedProtocols: string[];
  private readonly maxFrame: number;

  constructor(private readonly opts: NoiseServerTransportOpts) {
    this.supportedSuites = opts.supportedSuites ?? [NOISE_SUITE];
    this.supportedProtocols = opts.supportedProtocols ?? [APP_PROTOCOL];
    this.maxFrame = opts.maxFrame ?? DEFAULT_MAX_FRAME;
  }

  // -- Public getters -------------------------------------------------------

  get state(): ServerState {
    return this._state;
  }

  get sessionId(): Uint8Array | null {
    return this._sessionId;
  }

  get isSecure(): boolean {
    return this._state === "SECURE";
  }

  // -- Message processing ---------------------------------------------------

  /**
   * Process an incoming wire message. Returns zero or more messages to send
   * back over the wire.
   */
  processMessage(msg: unknown): TransportMessage[] {
    if (this._state === "CLOSED") {
      throw new Error("NoiseServerTransport: transport is closed");
    }

    // In SECURE state, unexpected processMessage calls should close
    if (this._state === "SECURE") {
      this._state = "CLOSED";
      throw new Error(
        "NoiseServerTransport: processMessage not valid in SECURE state — use encryptRpc/decryptData",
      );
    }

    const parsed = msg as Record<string, unknown>;
    const t = parsed?.t;

    switch (t) {
      case "client_hello":
        return this.handleClientHello(parsed);
      case "noise_1":
        return this.handleNoise1(parsed);
      default:
        // Unexpected frame in cleartext phase → transport_error + close (spec §2.6)
        this._state = "CLOSED";
        return [{ t: "transport_error", code: "protocol_error" } as TransportError];
    }
  }

  // -- Secure channel -------------------------------------------------------

  /** Encrypt an RPC payload into a data frame. Only valid in SECURE state. */
  encryptRpc(rpc: Record<string, unknown>): DataFrame {
    if (this._state !== "SECURE" || !this.sendCipher) {
      throw new Error(
        "NoiseServerTransport: cannot encrypt — transport is not in SECURE state",
      );
    }
    const payload: TransportPayload = { v: 1, kind: "rpc", rpc };
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ct = this.sendCipher.encrypt(plaintext);
    return { t: "data", ct: toBase64url(ct) };
  }

  /** Encrypt a push envelope into a data frame. Only valid in SECURE state. */
  encryptPush(push: Record<string, unknown>): DataFrame {
    if (this._state !== "SECURE" || !this.sendCipher) {
      throw new Error(
        "NoiseServerTransport: cannot encrypt — transport is not in SECURE state",
      );
    }
    const payload: TransportPayload = { v: 1, kind: "push", push };
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ct = this.sendCipher.encrypt(plaintext);
    return { t: "data", ct: toBase64url(ct) };
  }

  /** Encrypt a push control message into a data frame. Only valid in SECURE state. */
  encryptPushControl(pushControl: Record<string, unknown>): DataFrame {
    if (this._state !== "SECURE" || !this.sendCipher) {
      throw new Error(
        "NoiseServerTransport: cannot encrypt — transport is not in SECURE state",
      );
    }
    const payload: TransportPayload = { v: 1, kind: "push_control", push_control: pushControl };
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ct = this.sendCipher.encrypt(plaintext);
    return { t: "data", ct: toBase64url(ct) };
  }

  /** Decrypt an incoming data frame and return the full transport payload. Only valid in SECURE state. */
  decryptFrame(frame: DataFrame): TransportPayload {
    if (this._state !== "SECURE" || !this.recvCipher) {
      throw new Error(
        "NoiseServerTransport: cannot decrypt — transport is not in SECURE state",
      );
    }
    const ct = fromBase64url(frame.ct);
    const plaintext = this.recvCipher.decrypt(ct);
    const decoded = JSON.parse(new TextDecoder().decode(plaintext));
    return TransportPayloadSchema.parse(decoded);
  }

  /** Decrypt an incoming data frame containing an RPC payload. Only valid in SECURE state. */
  decryptData(frame: DataFrame): Record<string, unknown> {
    const payload = this.decryptFrame(frame);
    if (payload.kind !== "rpc") {
      throw new Error(`Expected RPC payload, got ${payload.kind}`);
    }
    return payload.rpc;
  }

  // -- Internal handlers ----------------------------------------------------

  private handleClientHello(
    raw: Record<string, unknown>,
  ): TransportMessage[] {
    if (this._state !== "WS_OPEN") {
      this._state = "CLOSED";
      return [{ t: "transport_error", code: "protocol_error" } as TransportError];
    }

    const clientHello = ClientHelloSchema.parse(raw);
    this.clientHello = clientHello;
    this._state = "HELLO_RCVD";

    // Negotiate
    const result = negotiateTransport(clientHello, {
      nodeId: this.opts.nodeId,
      keyId: this.opts.keyId,
      supportedSuites: this.supportedSuites,
      supportedProtocols: this.supportedProtocols,
      maxFrame: this.maxFrame,
    });

    if (result.t === "transport_error") {
      this._state = "CLOSED";
      return [result];
    }

    this.serverHello = result;
    this._state = "HELLO_SENT";
    return [result];
  }

  private handleNoise1(raw: Record<string, unknown>): TransportMessage[] {
    if (this._state !== "HELLO_SENT") {
      this._state = "CLOSED";
      return [{ t: "transport_error", code: "protocol_error" } as TransportError];
    }

    const noise1 = Noise1Schema.parse(raw);
    const msg1Bytes = fromBase64url(noise1.msg);

    // Compute prologue
    const prologue = computeTransportPrologue(
      this.clientHello!,
      this.serverHello!,
      this.opts.relayOrigin,
    );

    // Create Noise responder
    this.responder = createResponder(prologue, this.opts.staticKeypair);

    // Read message 1
    this.responder.readMessage1(msg1Bytes);

    // Write message 2
    const { msg: msg2Bytes, result } = this.responder.writeMessage2();

    this.sendCipher = result.sendCipher;
    this.recvCipher = result.recvCipher;
    this._sessionId = result.handshakeHash;

    const noise2: Noise2 = {
      t: "noise_2",
      msg: toBase64url(msg2Bytes),
    };

    this._state = "NOISE_2_SENT";
    // Transition immediately to SECURE since the handshake is complete
    // after sending noise_2 on the responder side.
    this._state = "SECURE";

    return [noise2];
  }
}
