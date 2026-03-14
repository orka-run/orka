# Pairing Protocol

Pairing is the process by which a client securely discovers a node.
The result: the client obtains the node's Noise static public key and saves it
for future connections.

Pairing is **not** a working transport. It does exactly three things:

1. Proves that both client and node know the same one-time code.
2. Securely delivers the node's Noise static public key to the client.
3. Forces the client to verify that key via a real Noise handshake
   before saving the node to config.

---

## Pairing Code

The node operator runs `orka node pair start` and receives a code:

```
Q7ND-M4KP-2X9F-T6RW-8BHC
```

Under the hood this is Crockford Base32 of the structure
`[version: 1 byte | secret: 10 bytes | checksum: 2 bytes]`.

- `secret` — 80 random bits, the primary bootstrap secret.
- `checksum` — CRC-16/CCITT-FALSE, typo protection only.
- `version` — format version (currently `1`).

Both sides derive `enroll_id` from the secret:

```
enroll_id = hex(trunc64(BLAKE3("orka/pair/v1/enroll-id" || secret)))
```

This is a 16-character hex identifier used for routing through the relay.

---

## Overall Sequence

```
Client                          Relay                           Node
  |                               |                               |
  | WS -> /v1/pair/<enroll_id>    |                               |
  |------------------------------>|    (bidirectional forwarding)  |
  |                               |<------------------------------|
  |                               |                               |
  |  pair_client_hello -----------------------------------------> |
  | <------------------------------------------ pair_server_hello |
  |                               |                               |
  |  pair_init (pA) ----------------------------------------------->
  | <------------------------------------------------ pair_resp (pB)
  |                               |                               |
  |  pair_confirm1 (MAC) ------------------------------------------>
  | <------------------------- pair_confirm2 (MAC) + pair_bootstrap |
  |                               |                               |
  |  [client decrypts bootstrap, obtains Noise pubkey]            |
  |  [client opens Noise connection and verifies key]             |
  |                               |                               |
  |  pair_done -------------------------------------------------->|
  |                               |         [enrollment consumed] |
```

---

## Protocol Phases

### 1. Hello (cleartext negotiation)

The first two messages are plaintext. They negotiate the version and cipher suite
and form a transcript that is cryptographically bound to SPAKE2.

**Client -> Node:**

```json
{
  "t": "pair_client_hello",
  "v": 1,
  "pair_suites": ["SPAKE2-edwards25519-SHA256-HKDF-HMAC"],
  "client_instance_id": "<16 random bytes, base64url>",
  "features": []
}
```

**Node -> Client:**

```json
{
  "t": "pair_server_hello",
  "v": 1,
  "pair_suite": "SPAKE2-edwards25519-SHA256-HKDF-HMAC",
  "enroll_id": "<base64url>",
  "expires_in_sec": 600,
  "features": []
}
```

Both sides compute the context used as AAD in SPAKE2:

```
pair_context = CanonicalJSON(pair_client_hello) || CanonicalJSON(pair_server_hello)
pair_aad    = "orka-pair/v1" || relay_origin || pair_context
```

Canonical JSON is JSON without whitespace with object keys sorted
lexicographically (a subset of RFC 8785).

### 2. SPAKE2 Exchange (RFC 9382)

SPAKE2 is a balanced PAKE (Password-Authenticated Key Exchange).
Both sides know the same password (the pairing code secret) and prove this
to each other without revealing the password to the relay or any observer.

**Parameters:**

```
Password = secret (10 bytes from pairing code)
A (client identity) = client_instance_id
B (node identity) = enroll_id
AAD = pair_aad
Group: Edwards25519
```

**Public value exchange:**

```
Client:  pA = x*G + w*M    (x = random scalar, w = derived from password)
Node:    pB = y*G + w*N    (y = random scalar)
```

M and N are fixed Edwards25519 points from RFC 9382.
`w = derivePasswordScalar(password)` — via HKDF, then reduced modulo group order.

Both sides compute the shared secret:

```
Client: K = x * (pB - w*N)
Node:   K = y * (pA - w*M)
```

From K the following are derived:

```
TT = Transcript(idA, idB, pA, pB, K, w, aad)
hash = SHA-256(TT)
Ka = hash[0:16],  Ke = hash[16:32]

KcA, KcB = HKDF-Expand(HKDF-Extract(Ka), "ConfirmationKeys", 64)
  KcA = first 32 bytes
  KcB = second 32 bytes

confirmA = HMAC-SHA256(KcA, pB)   <- client sends
confirmB = HMAC-SHA256(KcB, pA)   <- node sends
```

**Messages:**

| Message | Direction | Content |
|---------|-----------|---------|
| `pair_init` | C -> N | `{ t, pA }` — base64url point |
| `pair_resp` | N -> C | `{ t, pB }` — base64url point |
| `pair_confirm1` | C -> N | `{ t, mac }` — base64url confirmA |
| `pair_confirm2` | N -> C | `{ t, mac }` — base64url confirmB |

If the MAC is invalid, the node decrements the attempt counter and responds with `pair_error`.

### 3. Bootstrap (encrypted channel)

After confirmation, both sides derive encryption keys:

```
boot_c2s    = HKDF(Ke, salt=nil, "orka-pair/v1 boot c2s", 32)
boot_s2c    = HKDF(Ke, salt=nil, "orka-pair/v1 boot s2c", 32)
boot_export = HKDF(Ke, salt=nil, "orka-pair/v1 export", 32)
```

The node encrypts its information:

```
plaintext = JSON({
  node_id, node_name,
  noise_suite: "Noise_NK_25519_ChaChaPoly_SHA256",
  noise_static_pubkey: "<base64url 32 bytes>",
  noise_key_id: "sha256:...",
  node_paths: ["wss://relay.example.com/v1/node/node-123"],
  rpc: ["jsonrpc-2.0"]
})

ciphertext = ChaCha20-Poly1305(key=boot_s2c, nonce=12 zero bytes, AAD=SHA256(pair_context), plaintext)
```

Sent as:

```json
{ "t": "pair_bootstrap", "ct": "<base64url ciphertext>" }
```

### 4. Noise Verification and pair_done

The client **does not consider pairing complete** after receiving the bootstrap.
It must:

1. Extract `noise_static_pubkey` from the bootstrap payload.
2. Open a transport connection to `node_paths[0]`.
3. Perform a real Noise_NK handshake with this key.
4. Confirm the handshake succeeded (the node owns the corresponding private key).

Only then does the client call `confirmNoiseVerified()` and send `pair_done`:

```json
{ "t": "pair_done" }
```

The node marks the enrollment as `used` and zeroes the secret.

---

## State Machine: Client (PairingClient)

```
INIT
  | start()  ->  sends pair_client_hello
  v
AWAIT_SERVER_HELLO
  | receives pair_server_hello  ->  computes SPAKE2-A
  v
AWAIT_PAIR_RESP
  | receives pair_resp (pB)  ->  finishes SPAKE2, computes MAC
  v
AWAIT_PAIR_CONFIRM2
  | receives pair_confirm2  ->  verifies node MAC, derives bootstrap keys
  v
AWAIT_PAIR_BOOTSTRAP
  | receives pair_bootstrap  ->  decrypts, returns result
  v
AWAIT_NOISE_VERIFY
  | caller performs Noise handshake
  | calls confirmNoiseVerified()  ->  sends pair_done
  v
COMPLETE
```

## State Machine: Node (PairingServer)

```
AWAIT_CLIENT_HELLO
  | receives pair_client_hello  ->  sends pair_server_hello
  v
AWAIT_PAIR_INIT
  | receives pair_init (pA)  ->  computes SPAKE2-B, sends pair_resp
  v
AWAIT_PAIR_CONFIRM
  | receives pair_confirm1  ->  verifies MAC
  | if OK: sends pair_confirm2 + pair_bootstrap
  | if not: sends pair_error, decrements attempts_left
  v
AWAIT_PAIR_DONE
  | receives pair_done  ->  enrollment consumed
  v
COMPLETE
```

---

## Enrollment (node-side state)

The node holds pending enrollments in memory:

| Field | Description |
|-------|-------------|
| `enrollId` | 16 hex characters, derived from secret |
| `secret` | 10 bytes (zeroed after use/expiry) |
| `secretHash` | BLAKE3(secret), 32 bytes |
| `expiresAt` | Unix ms, default +10 minutes |
| `attemptsLeft` | Default 8, decremented on invalid MAC |
| `used` | Set after pair_done |
| `nodeTransportStaticPubkey` | 32 bytes — Noise public key |
| `nodeId`, `nodeName` | Node identification |
| `relayPaths` | Connection paths (wss://...) |

Every 30 seconds: expired enrollments are removed and secrets zeroed.

---

## Errors

```json
{ "t": "pair_error", "code": "<code>" }
```

| Code | Description |
|------|-------------|
| `expired` | Enrollment TTL exceeded |
| `not_found` | Enrollment does not exist |
| `attempts_exhausted` | Too many failed attempts (wrong pairing code) |
| `bad_version` | Unsupported protocol version |
| `bad_suite` | Unsupported cipher suite |
| `protocol_error` | Unexpected message or invalid format |

---

## Security Properties

- **PAKE**: SPAKE2 does not reveal the password to the relay or any MITM observer.
- **Downgrade protection**: The hello transcript is included in AAD — modifying hello causes MAC failure.
- **Brute-force protection**: Maximum 8 attempts, then the enrollment is deleted.
- **Relay transparency**: The relay forwards raw bytes; it knows nothing about the secret, SPAKE2, or Noise.
- **Key verification**: The client must verify a Noise handshake before saving the key.
  Without this, a MITM-supplied key could be trusted.

---

## Source Files

| File | Contents |
|------|----------|
| `packages/core/src/pairing-protocol.ts` | Types and zod schemas for all pairing messages |
| `packages/core/src/crypto/spake2.ts` | SPAKE2 on Edwards25519 (RFC 9382) |
| `packages/core/src/crypto/pairing-code.ts` | Pairing code generation/parsing (Crockford Base32 + CRC-16) |
| `packages/core/src/pairing/pairing-client.ts` | Client state machine |
| `packages/daemon/src/pairing/pairing-server.ts` | Server state machine |
| `packages/daemon/src/pairing/enrollment-store.ts` | Pending enrollment management |
| `packages/relay/src/pairing.ts` | Relay pairing router (transparent forwarding) |
