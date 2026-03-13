/**
 * Transport-level hello negotiation and prologue binding (§2.3).
 *
 * This module defines the cleartext handshake messages exchanged before the
 * Noise handshake, as well as the encrypted transport frames used after the
 * Noise session is established.
 *
 * Flow:
 *   1. C → N: client_hello   (cleartext)
 *   2. N → C: server_hello   (cleartext, or transport_error)
 *   3. Both sides compute prologue from the transcript
 *   4. Noise NK handshake (noise_1, noise_2)
 *   5. Encrypted data frames (data)
 */

import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The only Noise suite currently supported. */
export const NOISE_SUITE = "Noise_NK_25519_ChaChaPoly_SHA256";

/** Prefix used when computing the transport prologue. */
export const TRANSPORT_PROTOCOL_PREFIX = "orka-transport/v1";

/** The only application protocol currently supported. */
export const APP_PROTOCOL = "jsonrpc-2.0";

/** Default maximum encrypted frame size in bytes. */
export const DEFAULT_MAX_FRAME = 1_048_576;

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

/**
 * Produce a canonical JSON serialization of a value.
 *
 * Rules (subset of RFC 8785 / JCS):
 *   - Object keys are sorted lexicographically (Unicode code-point order).
 *   - No whitespace.
 *   - Recursively applied to nested objects/arrays.
 *
 * This is used to build the prologue transcript so both sides derive the same
 * bytes regardless of insertion order.
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys.map(
      (k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k]),
    );
    return "{" + pairs.join(",") + "}";
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Schemas — hello negotiation messages
// ---------------------------------------------------------------------------

/** C → N: client hello — proposes suites, protocols, and expected server identity. */
export const ClientHelloSchema = z.object({
  t: z.literal("client_hello"),
  v: z.number(),
  noise_suites: z.array(z.string()),
  node_id: z.string(),
  expected_key_id: z.string(),
  app_protocols: z.array(z.string()),
  features: z.array(z.string()),
}).passthrough();

export type ClientHello = z.infer<typeof ClientHelloSchema>;

/** N → C: server hello — confirms selected suite, protocol, and identity. */
export const ServerHelloSchema = z.object({
  t: z.literal("server_hello"),
  v: z.number(),
  noise_suite: z.string(),
  node_id: z.string(),
  key_id: z.string(),
  app_protocol: z.string(),
  features: z.array(z.string()),
  max_frame: z.number(),
}).passthrough();

export type ServerHello = z.infer<typeof ServerHelloSchema>;

/** Transport error — sent instead of server_hello when negotiation fails. */
export const TransportErrorSchema = z.object({
  t: z.literal("transport_error"),
  code: z.string(),
}).passthrough();

export type TransportError = z.infer<typeof TransportErrorSchema>;

// ---------------------------------------------------------------------------
// Schemas — Noise handshake frames (§2.4)
// ---------------------------------------------------------------------------

/** Noise handshake message 1 (initiator → responder). */
export const Noise1Schema = z.object({
  t: z.literal("noise_1"),
  msg: z.string(),
}).passthrough();

export type Noise1 = z.infer<typeof Noise1Schema>;

/** Noise handshake message 2 (responder → initiator). */
export const Noise2Schema = z.object({
  t: z.literal("noise_2"),
  msg: z.string(),
}).passthrough();

export type Noise2 = z.infer<typeof Noise2Schema>;

// ---------------------------------------------------------------------------
// Schemas — encrypted transport frames (§2.5)
// ---------------------------------------------------------------------------

/** Encrypted data frame carrying a Noise transport ciphertext. */
export const DataFrameSchema = z.object({
  t: z.literal("data"),
  ct: z.string(),
}).passthrough();

export type DataFrame = z.infer<typeof DataFrameSchema>;

// ---------------------------------------------------------------------------
// Schemas — transport payload (plaintext inside data frame)
// ---------------------------------------------------------------------------

/** Plaintext payload carried inside a data frame after decryption. */
export const TransportPayloadSchema = z.object({
  v: z.literal(1),
  kind: z.literal("rpc"),
  rpc: z.record(z.string(), z.unknown()),
}).passthrough();

export type TransportPayload = z.infer<typeof TransportPayloadSchema>;

// ---------------------------------------------------------------------------
// Discriminated union of all transport messages
// ---------------------------------------------------------------------------

export const TransportMessageSchema = z.discriminatedUnion("t", [
  ClientHelloSchema,
  ServerHelloSchema,
  TransportErrorSchema,
  Noise1Schema,
  Noise2Schema,
  DataFrameSchema,
]);

export type TransportMessage = z.infer<typeof TransportMessageSchema>;

// ---------------------------------------------------------------------------
// Negotiation logic
// ---------------------------------------------------------------------------

export interface ServerCapabilities {
  nodeId: string;
  keyId: string;
  supportedSuites: string[];
  supportedProtocols: string[];
  maxFrame: number;
}

/**
 * Server-side negotiation: given a client_hello and the server's capabilities,
 * returns either a server_hello or a transport_error.
 *
 * Negotiation rules (evaluated in order):
 *   1. If v != 1 → unsupported_version
 *   2. If no common suite → unsupported_suite
 *   3. If node_id doesn't match → no_such_node
 *   4. If expected_key_id doesn't match keyId → key_id_mismatch
 *   5. If no common app protocol → protocol_error
 *   6. Otherwise → server_hello with first matching suite and protocol
 */
export function negotiateTransport(
  clientHello: ClientHello,
  serverCapabilities: ServerCapabilities,
): ServerHello | TransportError {
  // 1. Version check
  if (clientHello.v !== 1) {
    return { t: "transport_error", code: "unsupported_version" };
  }

  // 2. Suite negotiation — find first client-offered suite that the server supports
  const selectedSuite = clientHello.noise_suites.find((s) =>
    serverCapabilities.supportedSuites.includes(s),
  );
  if (!selectedSuite) {
    return { t: "transport_error", code: "unsupported_suite" };
  }

  // 3. Node ID check
  if (clientHello.node_id !== serverCapabilities.nodeId) {
    return { t: "transport_error", code: "no_such_node" };
  }

  // 4. Key ID check
  if (clientHello.expected_key_id !== serverCapabilities.keyId) {
    return { t: "transport_error", code: "key_id_mismatch" };
  }

  // 5. App protocol negotiation — first client-offered protocol that the server supports
  const selectedProtocol = clientHello.app_protocols.find((p) =>
    serverCapabilities.supportedProtocols.includes(p),
  );
  if (!selectedProtocol) {
    return { t: "transport_error", code: "protocol_error" };
  }

  // 6. Success
  return {
    t: "server_hello",
    v: 1,
    noise_suite: selectedSuite,
    node_id: serverCapabilities.nodeId,
    key_id: serverCapabilities.keyId,
    app_protocol: selectedProtocol,
    features: [],
    max_frame: serverCapabilities.maxFrame,
  };
}

// ---------------------------------------------------------------------------
// Prologue computation (§2.3)
// ---------------------------------------------------------------------------

/**
 * Compute the transport prologue that binds the Noise handshake to the hello
 * negotiation transcript and relay origin.
 *
 *   prologue = TRANSPORT_PROTOCOL_PREFIX || relayOrigin || CanonicalJSON(clientHello) || CanonicalJSON(serverHello)
 *
 * Both sides compute this independently and feed it into the Noise handshake.
 * If either side has a different view of the negotiation, the Noise handshake
 * will fail with an authentication error.
 */
export function computeTransportPrologue(
  clientHello: ClientHello,
  serverHello: ServerHello,
  relayOrigin: string,
): Uint8Array {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(TRANSPORT_PROTOCOL_PREFIX);
  const origin = encoder.encode(relayOrigin);
  const clientTranscript = encoder.encode(canonicalJson(clientHello));
  const serverTranscript = encoder.encode(canonicalJson(serverHello));

  const totalLen =
    prefix.length + origin.length + clientTranscript.length + serverTranscript.length;
  const result = new Uint8Array(totalLen);
  let offset = 0;

  result.set(prefix, offset);
  offset += prefix.length;
  result.set(origin, offset);
  offset += origin.length;
  result.set(clientTranscript, offset);
  offset += clientTranscript.length;
  result.set(serverTranscript, offset);

  return result;
}
