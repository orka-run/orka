/**
 * PairingClient — Client-side pairing protocol state machine (spec §1.5 + §1.6).
 *
 * Drives the full SPAKE2-based pairing handshake from the client (CLI) side.
 * The caller provides a transport layer (onSend callback) and feeds incoming
 * WebSocket messages through handleMessage().
 *
 * State machine:
 *   INIT → AWAIT_SERVER_HELLO → AWAIT_PAIR_RESP → AWAIT_PAIR_CONFIRM2
 *     → AWAIT_PAIR_BOOTSTRAP → COMPLETE
 *
 * After receiving the PairingClientResult, the caller MUST:
 *   1. Open a Noise_NK transport to nodePaths[0]
 *   2. Perform a real handshake with noiseStaticPubkey
 *   3. Call confirmNoiseVerified() — this sends pair_done and transitions to COMPLETE
 *   4. Only then save the trust record
 *
 * The client stays in AWAIT_NOISE_VERIFY until the caller confirms.
 */

import { randomBytes } from "@noble/hashes/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

import { createSpake2A, type Spake2Result } from "../crypto/spake2";
import { blake3Truncated, concatBytes, sha256 } from "../crypto/hash";
import { toBase64url, fromBase64url, toHex } from "../crypto/encoding";
import {
  PAIR_SUITE,
  PairServerHelloSchema,
  PairRespSchema,
  PairConfirm2Schema,
  PairBootstrapSchema,
  PairBootstrapPayloadSchema,
  PairErrorSchema,
  computePairContext,
  computePairAad,
  type PairClientHello,
  type PairError,
} from "../pairing-protocol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PairingClientOpts {
  /** The shared secret from the parsed pairing code. */
  secret: Uint8Array;
  /** The relay origin URL, e.g. "wss://relay.example.com". */
  relayOrigin: string;
  /** Callback to send a JSON message over the WebSocket. */
  onSend: (msg: object) => void;
}

export interface PairingClientResult {
  nodeId: string;
  nodeName: string;
  noiseSuite: string;
  noiseStaticPubkey: Uint8Array;
  noiseKeyId: string;
  nodePaths: string[];
  rpc: string[];
  bootExport: Uint8Array;
}

export type PairingClientState =
  | "INIT"
  | "AWAIT_SERVER_HELLO"
  | "AWAIT_PAIR_RESP"
  | "AWAIT_PAIR_CONFIRM2"
  | "AWAIT_PAIR_BOOTSTRAP"
  | "AWAIT_NOISE_VERIFY"
  | "COMPLETE"
  | "FAILED";

export class PairingError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "PairingError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/**
 * Derive the enroll_id from the pairing secret.
 *
 * enroll_id = hex(trunc64(BLAKE3("orka/pair/v1/enroll-id" || secret)))
 */
function deriveEnrollId(secret: Uint8Array): string {
  const prefix = encoder.encode("orka/pair/v1/enroll-id");
  const input = concatBytes(prefix, secret);
  const truncated = blake3Truncated(input, 8);
  return toHex(truncated);
}

// ---------------------------------------------------------------------------
// PairingClient
// ---------------------------------------------------------------------------

export class PairingClient {
  private _state: PairingClientState = "INIT";
  private readonly _secret: Uint8Array;
  private readonly _relayOrigin: string;
  private readonly _onSend: (msg: object) => void;
  private readonly _enrollId: string;

  // Generated at start()
  private _clientInstanceId!: string;
  private _clientInstanceIdRaw!: Uint8Array;
  private _clientHello!: PairClientHello;

  // Populated during handshake
  private _pairContext: Uint8Array | null = null;
  private _pairAad: Uint8Array | null = null;
  private _spake2Finish: ((pB: Uint8Array) => Spake2Result) | null = null;
  private _spake2Result: Spake2Result | null = null;
  private _bootS2c: Uint8Array | null = null;
  private _bootExport: Uint8Array | null = null;
  private _result: PairingClientResult | null = null;
  private _error: PairingError | null = null;

  constructor(opts: PairingClientOpts) {
    this._secret = opts.secret;
    this._relayOrigin = opts.relayOrigin;
    this._onSend = opts.onSend;
    this._enrollId = deriveEnrollId(opts.secret);
  }

  /** The enroll_id derived from the secret, used to connect to the relay. */
  get enrollId(): string {
    return this._enrollId;
  }

  /** Current state of the pairing state machine. */
  get state(): PairingClientState {
    return this._state;
  }

  /** Whether pairing completed successfully. */
  get completed(): boolean {
    return this._state === "COMPLETE";
  }

  /** The error if pairing failed. */
  get error(): PairingError | null {
    return this._error;
  }

  /**
   * Start the pairing flow.
   * Generates a client_instance_id and sends pair_client_hello.
   */
  start(): void {
    if (this._state !== "INIT") {
      throw new PairingError("Cannot start: already started");
    }

    // Generate 16 random bytes, base64url encoded for wire format
    const instanceIdBytes = randomBytes(16);
    this._clientInstanceIdRaw = instanceIdBytes;
    this._clientInstanceId = toBase64url(instanceIdBytes);

    this._clientHello = {
      t: "pair_client_hello",
      v: 1,
      pair_suites: [PAIR_SUITE],
      client_instance_id: this._clientInstanceId,
      features: [],
    };

    this._onSend(this._clientHello);
    this._state = "AWAIT_SERVER_HELLO";
  }

  /**
   * Feed an incoming message from the WebSocket.
   * Returns PairingClientResult when bootstrap is received and verified,
   * or null if the handshake is still in progress.
   *
   * @throws PairingError on protocol violations or verification failures
   */
  async handleMessage(raw: string): Promise<PairingClientResult | null> {
    const parsed = JSON.parse(raw);

    // Handle pair_error at any state
    const errorResult = PairErrorSchema.safeParse(parsed);
    if (errorResult.success) {
      const err = errorResult.data as PairError;
      this._state = "FAILED";
      this._error = new PairingError(
        `Server error: ${err.code}`,
        err.code,
      );
      throw this._error;
    }

    switch (this._state) {
      case "AWAIT_SERVER_HELLO":
        return this._handleServerHello(parsed);
      case "AWAIT_PAIR_RESP":
        return this._handlePairResp(parsed);
      case "AWAIT_PAIR_CONFIRM2":
        return this._handlePairConfirm2(parsed);
      case "AWAIT_PAIR_BOOTSTRAP":
        return this._handlePairBootstrap(parsed);
      default:
        throw new PairingError(
          `Unexpected message in state ${this._state}`,
        );
    }
  }

  /**
   * Confirm that the Noise_NK handshake with the bootstrapped key succeeded.
   * Sends pair_done to the server and transitions to COMPLETE.
   *
   * The caller MUST call this only after a successful Noise_NK handshake
   * using the noiseStaticPubkey from the PairingClientResult.
   */
  confirmNoiseVerified(): void {
    if (this._state !== "AWAIT_NOISE_VERIFY") {
      throw new PairingError(
        `Cannot confirm Noise: expected AWAIT_NOISE_VERIFY, got ${this._state}`,
      );
    }

    this._onSend({ t: "pair_done" });
    this._state = "COMPLETE";
  }

  /**
   * Handle server disconnect.
   */
  handleClose(): void {
    if (this._state !== "COMPLETE") {
      this._state = "FAILED";
      this._error = new PairingError("Connection closed before pairing completed");
    }
  }

  // -----------------------------------------------------------------------
  // State handlers
  // -----------------------------------------------------------------------

  private _handleServerHello(parsed: unknown): null {
    const result = PairServerHelloSchema.safeParse(parsed);
    if (!result.success) {
      this._fail("Invalid pair_server_hello message");
      throw this._error!;
    }

    const serverHello = result.data;

    // Validate version
    if (serverHello.v !== 1) {
      this._fail("Unsupported protocol version");
      throw this._error!;
    }

    // Validate selected suite
    if (serverHello.pair_suite !== PAIR_SUITE) {
      this._fail(`Unsupported pairing suite: ${serverHello.pair_suite}`);
      throw this._error!;
    }

    // Compute pair_context and pair_aad
    this._pairContext = computePairContext(this._clientHello, serverHello);
    this._pairAad = computePairAad(this._relayOrigin, this._pairContext);

    // Compute SPAKE2 client side
    // idA = client_instance_id raw bytes (16 random bytes)
    // idB = enroll_id as UTF-8 encoded bytes of the string
    const idA = this._clientInstanceIdRaw;
    const idB = encoder.encode(serverHello.enroll_id);

    const spake2 = createSpake2A({
      password: this._secret,
      idA,
      idB,
      aad: this._pairAad,
    });

    this._spake2Finish = spake2.finish;

    // Send pair_init with pA
    this._onSend({
      t: "pair_init",
      pA: toBase64url(spake2.pA),
    });

    this._state = "AWAIT_PAIR_RESP";
    return null;
  }

  private _handlePairResp(parsed: unknown): null {
    const result = PairRespSchema.safeParse(parsed);
    if (!result.success) {
      this._fail("Invalid pair_resp message");
      throw this._error!;
    }

    const pBBytes = fromBase64url(result.data.pB);

    // Finish SPAKE2 exchange
    try {
      this._spake2Result = this._spake2Finish!(pBBytes);
    } catch (e) {
      this._fail("SPAKE2 exchange failed");
      throw this._error!;
    }

    // Send pair_confirm1 with confirmA MAC
    this._onSend({
      t: "pair_confirm1",
      mac: toBase64url(this._spake2Result.confirmA),
    });

    this._state = "AWAIT_PAIR_CONFIRM2";
    return null;
  }

  private _handlePairConfirm2(parsed: unknown): null {
    const result = PairConfirm2Schema.safeParse(parsed);
    if (!result.success) {
      this._fail("Invalid pair_confirm2 message");
      throw this._error!;
    }

    const macBytes = fromBase64url(result.data.mac);

    // Verify confirmB MAC
    if (!this._spake2Result!.verifyConfirmB(macBytes)) {
      this._fail("SPAKE2 confirmation failed: wrong password or tampered exchange");
      throw this._error!;
    }

    // Derive bootstrap keys via HKDF
    const Ke = this._spake2Result!.Ke;
    const info_c2s = encoder.encode("orka-pair/v1 boot c2s");
    const info_s2c = encoder.encode("orka-pair/v1 boot s2c");
    const info_export = encoder.encode("orka-pair/v1 export");

    hkdf(nobleSha256, Ke, new Uint8Array(0), info_c2s, 32);
    this._bootS2c = new Uint8Array(
      hkdf(nobleSha256, Ke, new Uint8Array(0), info_s2c, 32),
    );
    this._bootExport = new Uint8Array(
      hkdf(nobleSha256, Ke, new Uint8Array(0), info_export, 32),
    );

    this._state = "AWAIT_PAIR_BOOTSTRAP";
    return null;
  }

  private _handlePairBootstrap(parsed: unknown): PairingClientResult {
    const result = PairBootstrapSchema.safeParse(parsed);
    if (!result.success) {
      this._fail("Invalid pair_bootstrap message");
      throw this._error!;
    }

    const ct = fromBase64url(result.data.ct);

    // Decrypt with ChaCha20-Poly1305 under boot_s2c
    const nonce = new Uint8Array(12); // zeros
    const aad = sha256(this._pairContext!);

    let plaintext: Uint8Array;
    try {
      const cipher = chacha20poly1305(this._bootS2c!, nonce, aad);
      plaintext = cipher.decrypt(ct);
    } catch (e) {
      this._fail("Bootstrap decryption failed: tampered ciphertext or wrong keys");
      throw this._error!;
    }

    // Parse the decrypted bootstrap payload
    let payloadJson: unknown;
    try {
      payloadJson = JSON.parse(new TextDecoder().decode(plaintext));
    } catch (e) {
      this._fail("Bootstrap payload is not valid JSON");
      throw this._error!;
    }

    const payloadResult = PairBootstrapPayloadSchema.safeParse(payloadJson);
    if (!payloadResult.success) {
      this._fail("Bootstrap payload has invalid structure");
      throw this._error!;
    }

    const payload = payloadResult.data;

    this._result = {
      nodeId: payload.node_id,
      nodeName: payload.node_name,
      noiseSuite: payload.noise_suite,
      noiseStaticPubkey: fromBase64url(payload.noise_static_pubkey),
      noiseKeyId: payload.noise_key_id,
      nodePaths: payload.node_paths,
      rpc: payload.rpc,
      bootExport: this._bootExport!,
    };

    this._state = "AWAIT_NOISE_VERIFY";
    return this._result;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private _fail(message: string): void {
    this._state = "FAILED";
    this._error = new PairingError(message);
  }
}
