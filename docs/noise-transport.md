# Noise Transport Protocol

After pairing, the client knows the node's Noise static public key.
All subsequent connections use Noise_NK to establish an encrypted channel
over which JSON-RPC travels.

---

## Overall Sequence

```
Client                          Relay                           Node
  |                               |                               |
  | WS -> /v1/node/<node_id>     |                               |
  |------------------------------>|       (opaque forwarding)     |
  |                               |------------------------------>|
  |                               |                               |
  |  client_hello ------------------------------------------------>
  | <------------------------------------------------ server_hello |
  |                               |                               |
  |  noise_1 ----------------------------------------------------->
  | <----------------------------------------------------- noise_2 |
  |                               |                               |
  |          ======= SECURE CHANNEL ESTABLISHED =======           |
  |                               |                               |
  |  data { ct: encrypted RPC } ---------------------------------->
  | <---------------------------------------- data { ct: response }|
```

---

## Protocol Phases

### 1. Hello Negotiation (cleartext)

Before the Noise handshake, both sides exchange hello messages in plaintext.
The result is bound to Noise via the prologue — a mismatch in hello
on either side causes the handshake to fail.

**Client -> Node:**

```json
{
  "t": "client_hello",
  "v": 1,
  "noise_suites": ["Noise_NK_25519_ChaChaPoly_SHA256"],
  "node_id": "node-123",
  "expected_key_id": "sha256:abcdef...",
  "app_protocols": ["jsonrpc-2.0"],
  "features": []
}
```

- `noise_suites` — cipher suites supported by the client (priority: first).
- `expected_key_id` — hash of the expected Noise pubkey (obtained during pairing).
- `app_protocols` — application protocols on top of the encrypted channel.

**Node -> Client:**

```json
{
  "t": "server_hello",
  "v": 1,
  "noise_suite": "Noise_NK_25519_ChaChaPoly_SHA256",
  "node_id": "node-123",
  "key_id": "sha256:abcdef...",
  "app_protocol": "jsonrpc-2.0",
  "features": [],
  "max_frame": 1048576
}
```

- `key_id` — actual key ID of the node. If `expected_key_id != key_id`,
  the node responds with `transport_error(key_id_mismatch)`.

### 2. Prologue Binding

Both sides compute the prologue — data that Noise mixes into the handshake state:

```
transcript = CanonicalJSON(client_hello) || CanonicalJSON(server_hello)
prologue   = "orka-transport/v1" || relay_origin || transcript
```

If a MITM tampered with hello (downgrade attack), the prologue will differ,
and Noise authentication will fail.

### 3. Noise NK Handshake

The NK pattern from the Noise Protocol Framework:

```
Pre-message:  <- s           (client knows the node's static pubkey in advance)
Message 1:    -> e, es       (client -> node)
Message 2:    <- e, ee       (node -> client)
```

**Message 1 (client -> node):**

```json
{ "t": "noise_1", "msg": "<base64url>" }
```

The client generates an ephemeral keypair, computes DH(ephemeral, server_static),
and mixes the result into the Noise symmetric state.

**Message 2 (node -> client):**

```json
{ "t": "noise_2", "msg": "<base64url>" }
```

The node generates its own ephemeral keypair, computes DH(ephemeral, client_ephemeral).
After this, both sides call `Split()` and obtain two CipherStates —
one for each direction.

### 4. Secure Transport

After the handshake, all messages are transmitted encrypted:

**Wire frame:**

```json
{ "t": "data", "ct": "<base64url ciphertext>" }
```

**Plaintext inside ct (after decryption):**

```json
{
  "v": 1,
  "kind": "rpc",
  "rpc": {
    "jsonrpc": "2.0",
    "id": "42",
    "method": "spawn",
    "params": { ... }
  }
}
```

The entire application message is encrypted as a whole. The nonce is not
transmitted on the wire — both sides maintain a synchronized counter
(WebSocket guarantees ordering).

---

## State Machines

### Client (NoiseClientTransport)

```
WS_OPEN
  | getClientHello()  ->  sends client_hello
  v
HELLO_SENT
  | receives server_hello  ->  validates negotiation, computes prologue
  v
HELLO_CONFIRMED
  | writeMessage1()  ->  sends noise_1
  v
NOISE_1_SENT
  | receives noise_2  ->  readMessage2(), Split() -> transport keys
  v
SECURE  (encryptRpc / decryptData available)
  | close()
  v
CLOSED
```

### Node (NoiseServerTransport)

```
WS_OPEN
  | receives client_hello  ->  negotiateTransport()  ->  sends server_hello
  v
HELLO_SENT
  | receives noise_1  ->  readMessage1(), writeMessage2(), Split() -> transport keys
  v
SECURE  (encryptRpc / decryptData available)
  | close()
  v
CLOSED
```

---

## Cryptographic Details

### Noise_NK_25519_ChaChaPoly_SHA256

| Component | Algorithm |
|-----------|-----------|
| DH | X25519 (Curve25519) |
| Cipher | ChaCha20-Poly1305 (AEAD) |
| Hash | SHA-256 |
| KDF | HKDF-SHA256 |

### Symmetric State

```
InitializeSymmetric(protocol_name):
  h = SHA256(protocol_name)  (or zero-padded if <= 32 bytes)
  ck = h
  cipher = NULL

mixHash(data):
  h = SHA256(h || data)

mixKey(dh_output):
  ck, temp_k = HKDF(ck, dh_output)
  cipher.key = temp_k

split():
  k1, k2 = HKDF(ck, EMPTY)
  return [CipherState(k1), CipherState(k2)]
```

### CipherState

Each CipherState maintains a nonce counter:

```
nonce = [4 zero bytes] || [8-byte little-endian counter]
```

The counter increments by 1 after each message.
Overflow -> panic (practical limit: 2^53 due to JS number constraints).

### Key ID

```
key_id = "sha256:" + hex(SHA-256(publicKey))
```

### Session ID

```
session_id = GetHandshakeHash()    // 32-byte SHA-256
```

Can be used for channel binding — tying auth tokens to a specific session.

---

## Errors (cleartext, before SECURE)

```json
{ "t": "transport_error", "code": "<code>" }
```

| Code | Description |
|------|-------------|
| `unsupported_version` | Protocol version not supported |
| `unsupported_suite` | No common Noise suite |
| `no_such_node` | node_id not found |
| `key_id_mismatch` | expected_key_id does not match actual key |
| `protocol_error` | Unexpected message or invalid format |

After transitioning to SECURE, all errors travel as JSON-RPC errors inside encrypted `data` frames.

---

## Reconnect and Rekey

In v1 the policy is simple:

- One WS connection = one Noise session.
- Reconnect = entirely new handshake.
- No in-session rekey.

Noise supports `Rekey()`, but this is deferred to future versions.

---

## Security Properties

- **Forward Secrecy**: Ephemeral DH in every handshake. Compromising the static key
  does not allow decryption of past sessions.
- **Server Authentication**: NK pattern — the client knows the node's static key
  in advance (from pairing). A MITM cannot impersonate the node without the private key.
- **Downgrade Protection**: The hello transcript is bound to Noise via the prologue.
- **Replay Protection**: Ephemeral keys are unique to each handshake.
- **Relay Transparency**: The relay forwards opaque frames and never sees plaintext.

---

## Source Files

| File | Contents |
|------|----------|
| `packages/core/src/crypto/noise.ts` | Noise NK: DH, CipherState, SymmetricState, initiator/responder |
| `packages/core/src/transport/noise-transport.ts` | NoiseClientTransport, NoiseServerTransport (state machines) |
| `packages/core/src/transport-protocol.ts` | Hello messages, prologue, data frames, zod schemas |
| `packages/core/src/crypto.ts` | Noise keypair generation, storage, and loading |
| `packages/daemon/src/server.ts` | Server integration: Noise handshake on WS connection |
| `packages/daemon/src/remote-client.ts` | Client integration: handshake driver, encrypt/decrypt RPC |
