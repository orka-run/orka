/**
 * Node-side pairing server for the SPAKE2 pairing protocol (spec section 1.5).
 *
 * Handles one pairing session as an async state machine:
 *
 *   AWAIT_CLIENT_HELLO -> AWAIT_PAIR_INIT -> AWAIT_PAIR_CONFIRM -> AWAIT_PAIR_DONE -> COMPLETE
 *
 * Each call to processMessage() takes a raw parsed JSON message, validates it
 * against the expected schema for the current state, and returns an array of
 * messages to send back.
 */

import {
  type PairClientHello,
  type PairServerHello,
  type PairMessage,
  PairClientHelloSchema,
  PairInitSchema,
  PairConfirm1Schema,
  PairDoneSchema,
  PAIR_SUITE,
  computePairContext,
  computePairAad,
} from "@orka/core";

import {
  createSpake2B,
  type Spake2Result,
} from "@orka/core/crypto/protocol";

import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

import { trace } from "@opentelemetry/api";
import type { PendingEnrollment, EnrollmentStore } from "./enrollment-store";
import { withSpanSync } from "../tracing";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const enum State {
  AWAIT_CLIENT_HELLO = "AWAIT_CLIENT_HELLO",
  AWAIT_PAIR_INIT = "AWAIT_PAIR_INIT",
  AWAIT_PAIR_CONFIRM = "AWAIT_PAIR_CONFIRM",
  AWAIT_PAIR_DONE = "AWAIT_PAIR_DONE",
  COMPLETE = "COMPLETE",
  ERRORED = "ERRORED",
}

export interface PairingServerOpts {
  enrollment: PendingEnrollment;
  enrollmentStore: EnrollmentStore;
  secret: Uint8Array;
  relayOrigin: string;
  noiseKeyId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOISE_SUITE = "Noise_NK_25519_ChaChaPoly_SHA256";
const BOOT_C2S_INFO = "orka-pair/v1 boot c2s";
const BOOT_S2C_INFO = "orka-pair/v1 boot s2c";
const BOOT_EXPORT_INFO = "orka-pair/v1 export";

const textEncoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBase64Url(data: Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

function fromBase64Url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

/**
 * Derive a 32-byte key from Ke using HKDF-SHA256.
 * ikm = Ke, salt = empty, info = label string.
 */
function deriveBootstrapKey(Ke: Uint8Array, info: string): Uint8Array {
  return new Uint8Array(
    hkdf(sha256, Ke, new Uint8Array(0), textEncoder.encode(info), 32),
  );
}

/**
 * Encrypt plaintext with ChaCha20-Poly1305.
 * nonce = 12 zero bytes, AAD = SHA256(pair_context).
 */
function encryptBootstrap(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  const nonce = new Uint8Array(12); // all zeros
  const cipher = chacha20poly1305(key, nonce, aad);
  return cipher.encrypt(plaintext);
}

// ---------------------------------------------------------------------------
// PairingServer
// ---------------------------------------------------------------------------

export class PairingServer {
  private state: State = State.AWAIT_CLIENT_HELLO;
  private readonly enrollment: PendingEnrollment;
  private readonly enrollmentStore: EnrollmentStore;
  private readonly secret: Uint8Array;
  private readonly relayOrigin: string;
  private readonly noiseKeyId: string;

  // Populated during the handshake
  private clientHello: PairClientHello | null = null;
  private serverHello: PairServerHello | null = null;
  private spake2Result: Spake2Result | null = null;
  private _bootExport: Uint8Array | null = null;

  constructor(opts: PairingServerOpts) {
    this.enrollment = opts.enrollment;
    this.enrollmentStore = opts.enrollmentStore;
    this.secret = opts.secret;
    this.relayOrigin = opts.relayOrigin;
    this.noiseKeyId = opts.noiseKeyId;
  }

  /** Whether the pairing is complete. */
  get isComplete(): boolean {
    return this.state === State.COMPLETE;
  }

  /** Whether the pairing has errored. */
  get isErrored(): boolean {
    return this.state === State.ERRORED;
  }

  /** Get the boot_export key (available after completion). */
  get bootExport(): Uint8Array | null {
    return this._bootExport;
  }

  /**
   * Process an incoming message.
   * Returns an array of outgoing messages to send to the client.
   */
  processMessage(msg: unknown): PairMessage[] {
    return withSpanSync("orka.pairing.server.message", {
      "orka.pairing.state": this.state,
    }, (span) => {
      let result: PairMessage[];
      switch (this.state) {
        case State.AWAIT_CLIENT_HELLO:
          result = this.handleClientHello(msg);
          break;
        case State.AWAIT_PAIR_INIT:
          result = this.handlePairInit(msg);
          break;
        case State.AWAIT_PAIR_CONFIRM:
          result = this.handlePairConfirm(msg);
          break;
        case State.AWAIT_PAIR_DONE:
          result = this.handlePairDone(msg);
          break;
        case State.COMPLETE:
        case State.ERRORED:
          result = this.protocolError();
          break;
      }
      span.addEvent("pairing.state_transition", {
        "orka.pairing.new_state": this.state,
      });
      return result;
    });
  }

  // --- State handlers ---

  private handleClientHello(msg: unknown): PairMessage[] {
    // Validate the message as a pair_client_hello
    const parsed = PairClientHelloSchema.safeParse(msg);
    if (!parsed.success) {
      // Could be wrong version or completely invalid
      // Check if it has the right type field to distinguish bad_version vs protocol_error
      const raw = msg as Record<string, unknown> | null;
      if (raw && typeof raw === "object" && raw.t === "pair_client_hello") {
        // It has the right type, but validation failed - check version
        if (raw.v !== 1) {
          return this.errorAndClose("bad_version");
        }
      }
      return this.protocolError();
    }

    const clientHello = parsed.data;

    // Check version
    if (clientHello.v !== 1) {
      return this.errorAndClose("bad_version");
    }

    // Check suite support
    if (!clientHello.pair_suites.includes(PAIR_SUITE)) {
      return this.errorAndClose("bad_suite");
    }

    // Check enrollment expiry
    if (Date.now() >= this.enrollment.expiresAt) {
      trace.getActiveSpan()?.addEvent("pairing.enrollment_expired", {
        "orka.pairing.enroll_id": this.enrollment.enrollId,
      });
      return this.errorAndClose("expired");
    }

    this.clientHello = clientHello;

    // Build server hello
    const remainingSec = Math.max(
      0,
      Math.floor((this.enrollment.expiresAt - Date.now()) / 1000),
    );

    const serverHello: PairServerHello = {
      t: "pair_server_hello",
      v: 1,
      pair_suite: PAIR_SUITE,
      enroll_id: this.enrollment.enrollId,
      expires_in_sec: remainingSec,
      features: [],
    };

    this.serverHello = serverHello;
    this.state = State.AWAIT_PAIR_INIT;

    return [serverHello];
  }

  private handlePairInit(msg: unknown): PairMessage[] {
    const parsed = PairInitSchema.safeParse(msg);
    if (!parsed.success) {
      return this.protocolError();
    }

    // Check it's actually pair_init type
    const raw = msg as Record<string, unknown>;
    if (raw.t !== "pair_init") {
      return this.protocolError();
    }

    const pABytes = fromBase64Url(parsed.data.pA);

    // Compute pair_context and pair_aad for SPAKE2
    const pairContext = computePairContext(
      this.clientHello!,
      this.serverHello!,
    );
    const pairAad = computePairAad(this.relayOrigin, pairContext);

    // Run SPAKE2 B-side
    // idA = raw bytes of client_instance_id (decoded from base64url wire format)
    const idA = fromBase64Url(this.clientHello!.client_instance_id);
    const idB = textEncoder.encode(this.enrollment.enrollId);

    const spake2B = createSpake2B({
      password: this.secret,
      idA,
      idB,
      aad: pairAad,
    });

    // Finish with pA to derive shared secret
    this.spake2Result = spake2B.finish(pABytes);

    this.state = State.AWAIT_PAIR_CONFIRM;

    return [
      {
        t: "pair_resp",
        pB: toBase64Url(spake2B.pB),
      },
    ];
  }

  private handlePairConfirm(msg: unknown): PairMessage[] {
    const parsed = PairConfirm1Schema.safeParse(msg);
    if (!parsed.success) {
      return this.protocolError();
    }

    const raw = msg as Record<string, unknown>;
    if (raw.t !== "pair_confirm1") {
      return this.protocolError();
    }

    const clientMac = fromBase64Url(parsed.data.mac);

    // Verify client MAC
    if (!this.spake2Result!.verifyConfirmA(clientMac)) {
      // Bad MAC - record failed attempt
      const remaining = this.enrollmentStore.recordFailedAttempt(
        this.enrollment.enrollId,
      );
      trace.getActiveSpan()?.addEvent("pairing.mac_verification_failed", {
        "orka.pairing.remaining_attempts": remaining,
        "orka.pairing.enroll_id": this.enrollment.enrollId,
      });
      if (remaining === 0) {
        return this.errorAndClose("attempts_exhausted");
      }
      return this.errorAndClose("protocol_error");
    }

    // MAC verified - derive bootstrap keys
    const Ke = this.spake2Result!.Ke;
    const bootS2c = deriveBootstrapKey(Ke, BOOT_S2C_INFO);
    deriveBootstrapKey(Ke, BOOT_C2S_INFO); // derive but server doesn't use it directly
    this._bootExport = deriveBootstrapKey(Ke, BOOT_EXPORT_INFO);

    // Build bootstrap payload
    const bootstrapPayload = {
      node_id: this.enrollment.nodeId,
      node_name: this.enrollment.nodeName,
      noise_suite: NOISE_SUITE,
      noise_static_pubkey: toBase64Url(
        this.enrollment.nodeTransportStaticPubkey,
      ),
      noise_key_id: this.noiseKeyId,
      node_paths: this.enrollment.relayPaths,
      rpc: ["jsonrpc-2.0"],
    };

    const plaintext = textEncoder.encode(JSON.stringify(bootstrapPayload));

    // AAD = SHA256(pair_context)
    const pairContext = computePairContext(
      this.clientHello!,
      this.serverHello!,
    );
    const aad = sha256(pairContext);

    const ct = encryptBootstrap(bootS2c, plaintext, aad);

    this.state = State.AWAIT_PAIR_DONE;

    return [
      {
        t: "pair_confirm2",
        mac: toBase64Url(this.spake2Result!.confirmB),
      },
      {
        t: "pair_bootstrap",
        ct: toBase64Url(ct),
      },
    ];
  }

  private handlePairDone(msg: unknown): PairMessage[] {
    const parsed = PairDoneSchema.safeParse(msg);
    if (!parsed.success) {
      return this.protocolError();
    }

    const raw = msg as Record<string, unknown>;
    if (raw.t !== "pair_done") {
      return this.protocolError();
    }

    // Mark enrollment as used
    this.enrollmentStore.markUsed(this.enrollment.enrollId);

    this.state = State.COMPLETE;
    return [];
  }

  // --- Error helpers ---

  private protocolError(): PairMessage[] {
    this.state = State.ERRORED;
    return [{ t: "pair_error", code: "protocol_error" }];
  }

  private errorAndClose(
    code:
      | "expired"
      | "not_found"
      | "attempts_exhausted"
      | "bad_version"
      | "bad_suite"
      | "protocol_error",
  ): PairMessage[] {
    this.state = State.ERRORED;
    return [{ t: "pair_error", code }];
  }
}
