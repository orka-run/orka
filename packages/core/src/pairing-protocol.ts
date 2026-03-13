/**
 * Pairing wire protocol schemas (protocol spec section 1.5).
 *
 * Defines all pairing message types as zod schemas for validating
 * client-node pairing handshake messages over WebSocket.
 */

import { z } from "zod/v4";
import { canonicalJson } from "./crypto/canonical-json";

// --- Constants ---

export const PAIR_SUITE = "SPAKE2-edwards25519-SHA256-HKDF-HMAC";
export const PAIR_PROTOCOL_PREFIX = "orka-pair/v1";

// --- Hello phase (section 1.5.1) ---

/** C -> N: Client hello initiating pairing */
export const PairClientHelloSchema = z.object({
  t: z.literal("pair_client_hello"),
  v: z.literal(1),
  pair_suites: z.array(z.string()),
  client_instance_id: z.string(),
  features: z.array(z.string()),
});
export type PairClientHello = z.infer<typeof PairClientHelloSchema>;

/** N -> C: Server hello response with selected suite */
export const PairServerHelloSchema = z.object({
  t: z.literal("pair_server_hello"),
  v: z.literal(1),
  pair_suite: z.string(),
  enroll_id: z.string(),
  expires_in_sec: z.number(),
  features: z.array(z.string()),
});
export type PairServerHello = z.infer<typeof PairServerHelloSchema>;

// --- SPAKE2 exchange (section 1.5.2) ---

/** C -> N: SPAKE2 public value */
export const PairInitSchema = z.object({
  t: z.literal("pair_init"),
  pA: z.string(),
});
export type PairInit = z.infer<typeof PairInitSchema>;

/** N -> C: SPAKE2 public value */
export const PairRespSchema = z.object({
  t: z.literal("pair_resp"),
  pB: z.string(),
});
export type PairResp = z.infer<typeof PairRespSchema>;

/** C -> N: SPAKE2 confirmation MAC */
export const PairConfirm1Schema = z.object({
  t: z.literal("pair_confirm1"),
  mac: z.string(),
});
export type PairConfirm1 = z.infer<typeof PairConfirm1Schema>;

/** N -> C: SPAKE2 confirmation MAC */
export const PairConfirm2Schema = z.object({
  t: z.literal("pair_confirm2"),
  mac: z.string(),
});
export type PairConfirm2 = z.infer<typeof PairConfirm2Schema>;

// --- Bootstrap (section 1.5.3) ---

/** N -> C: Encrypted bootstrap payload */
export const PairBootstrapSchema = z.object({
  t: z.literal("pair_bootstrap"),
  ct: z.string(),
});
export type PairBootstrap = z.infer<typeof PairBootstrapSchema>;

/** Plaintext payload inside PairBootstrap.ct after decryption */
export const PairBootstrapPayloadSchema = z.object({
  node_id: z.string(),
  node_name: z.string(),
  noise_suite: z.string(),
  noise_static_pubkey: z.string(),
  noise_key_id: z.string(),
  node_paths: z.array(z.string()),
  rpc: z.array(z.string()),
});
export type PairBootstrapPayload = z.infer<typeof PairBootstrapPayloadSchema>;

// --- Completion ---

/** C -> N: Pairing complete */
export const PairDoneSchema = z.object({
  t: z.literal("pair_done"),
});
export type PairDone = z.infer<typeof PairDoneSchema>;

// --- Errors (section 1.7) ---

export const PairErrorCodeSchema = z.enum([
  "expired",
  "not_found",
  "attempts_exhausted",
  "bad_version",
  "bad_suite",
  "protocol_error",
]);
export type PairErrorCode = z.infer<typeof PairErrorCodeSchema>;

export const PairErrorSchema = z.object({
  t: z.literal("pair_error"),
  code: PairErrorCodeSchema,
});
export type PairError = z.infer<typeof PairErrorSchema>;

// --- Discriminated union of all pairing messages ---

export const PairMessageSchema = z.discriminatedUnion("t", [
  PairClientHelloSchema,
  PairServerHelloSchema,
  PairInitSchema,
  PairRespSchema,
  PairConfirm1Schema,
  PairConfirm2Schema,
  PairBootstrapSchema,
  PairDoneSchema,
  PairErrorSchema,
]);
export type PairMessage =
  | PairClientHello
  | PairServerHello
  | PairInit
  | PairResp
  | PairConfirm1
  | PairConfirm2
  | PairBootstrap
  | PairDone
  | PairError;

// --- Derived values ---

const encoder = new TextEncoder();

/**
 * Compute pair_context = CanonicalJSON(pair_client_hello) || CanonicalJSON(pair_server_hello)
 *
 * Both hello messages are serialized using deterministic canonical JSON
 * and concatenated to form a unique context binding for the pairing session.
 */
export function computePairContext(
  clientHello: PairClientHello,
  serverHello: PairServerHello,
): Uint8Array {
  const clientBytes = encoder.encode(canonicalJson(clientHello));
  const serverBytes = encoder.encode(canonicalJson(serverHello));

  const result = new Uint8Array(clientBytes.length + serverBytes.length);
  result.set(clientBytes, 0);
  result.set(serverBytes, clientBytes.length);
  return result;
}

/**
 * Compute pair_aad = "orka-pair/v1" || relay_origin || pair_context
 *
 * The AAD (Additional Authenticated Data) binds the pairing session
 * to the protocol version, relay origin, and hello exchange context.
 */
export function computePairAad(
  relayOrigin: string,
  pairContext: Uint8Array,
): Uint8Array {
  const prefixBytes = encoder.encode(PAIR_PROTOCOL_PREFIX);
  const originBytes = encoder.encode(relayOrigin);

  const result = new Uint8Array(
    prefixBytes.length + originBytes.length + pairContext.length,
  );
  result.set(prefixBytes, 0);
  result.set(originBytes, prefixBytes.length);
  result.set(pairContext, prefixBytes.length + originBytes.length);
  return result;
}
