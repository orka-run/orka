# Encrypted Config & Key Storage on Relay Server — Design Plan

## 1. Threat Model

| Adversary | Capability | Protection |
|-----------|-----------|------------|
| **Curious relay operator** | Full DB access, can read all stored rows | All config/key blobs are client-side encrypted with keys the relay never sees. Relay stores opaque ciphertext. |
| **DB breach / SQL injection** | Exfiltrate all relay.db data | Same as above — stolen ciphertext is useless without the user's master key. |
| **Network eavesdropper** | Observe WS traffic between CLI and relay | Already mitigated by Noise NK E2E encryption and TLS. Config API calls also go through the encrypted transport. |
| **Compromised relay process (memory)** | Can read RAM of running relay | Config blobs remain encrypted in memory. The relay never has the decryption key. Only session metadata (access-control metadata fields) is in plaintext. |
| **Compromised client device** | Access to `~/.orka/` on one machine | Limits blast radius to that device's cached configs. Master key is derived from password, not stored at rest. A hardware security key or passphrase protects the vault. |
| **Teammate with read access** | Can read shared config blobs | Per-blob ACLs control who can decrypt. Team shared configs use a group key wrapped per-member. Revoking a member re-wraps the group key. |

**What we do NOT protect against:**
- A user who loses their master password (no recovery without backup)
- A fully compromised client with an unlocked vault session (the vault key is in memory during use)
- Side-channel attacks on the relay process (out of scope for an application-layer design)

**Explicitly out of scope for v1:**
- Hardware security module (HSM) integration
- Multi-party computation for key management
- Post-quantum cryptography

## 2. Encryption Scheme

**Key hierarchy (envelope encryption with 3 layers):**

```
Master Password (user-memorized, never stored)
    │
    ├── HKDF-SHA256("orka/vault/v1/master") ──► Master Key (MK) [256-bit]
    │       │
    │       └── Encrypt ──► Vault Key (VK) [256-bit, stored on relay as "vault_key" blob]
    │                           │
    │                           ├── Per-blob Data Encryption Keys (DEK) [256-bit, random]
    │                           │       └── Encrypt config blob content
    │                           │
    │                           └── Team Wrapping: VK is wrapped per-team-member with their MK
    │
    └── HKDF-SHA256("orka/vault/v1/auth-tag") ──► Auth Tag (sent to relay to prove identity without revealing MK)
```

**Key derivation from password:**
- Use Argon2id (memory-hard KDF) with per-account salt stored on the relay.
  - Parameters: `m=65536 (64 MiB), t=3, p=4`
  - Salt: 32 random bytes, generated at vault creation, stored plaintext on relay alongside the account.
- Argon2id output (64 bytes) is split:
  - First 32 bytes: `masterKey` (MK) — used to wrap/unwrap the Vault Key
  - Last 32 bytes: `authKey` — sent to the relay as proof of vault ownership (relay stores SHA-256(authKey) for verification)

**Why Argon2id instead of OPAQUE/SRP:**
- OPAQUE and SRP are designed for server-authenticated password logins where the server validates the password. Here, the relay explicitly should NOT know the password — it just stores opaque blobs. The auth tag derived from Argon2id serves as a bearer credential that proves vault ownership without giving the relay the ability to brute-force offline.
- OPAQUE would add substantial protocol complexity (3-message flow) for minimal benefit since the relay is already untrusted-by-design.

**Vault Key (VK):**
- A random 256-bit symmetric key generated client-side at vault creation.
- Stored on the relay encrypted under MK using XChaCha20-Poly1305 (24-byte nonce eliminates nonce reuse risk with random nonces).
- All per-blob DEKs are encrypted under VK.
- Key rotation: generate new VK, re-wrap all DEKs under new VK, re-encrypt VK under MK. The actual blob ciphertexts do not change (only the DEK wrappers change).

**Per-blob encryption:**
- Each config blob gets a random 256-bit DEK.
- Blob content is encrypted with XChaCha20-Poly1305 using the DEK.
- The DEK is then wrapped (encrypted) under the VK and stored alongside the ciphertext.
- Blob metadata (namespace, key name, version, ACL list) is stored plaintext for relay-side access control.

**Wire format for a stored blob:**

```typescript
interface EncryptedBlob {
  /** Plaintext metadata (relay can read for routing/ACL) */
  namespace: string;       // e.g. "fleet/nodes", "fleet/routing", "keys/noise"
  key: string;             // e.g. "node-list", "default-spawn-opts"
  version: number;         // monotonically increasing per key

  /** Encrypted payload (relay cannot read) */
  wrapped_dek: string;     // base64url(XChaCha20-Poly1305(VK, DEK))
  ciphertext: string;      // base64url(XChaCha20-Poly1305(DEK, plaintext))
  nonce_dek: string;       // 24-byte nonce for DEK wrapping
  nonce_ct: string;        // 24-byte nonce for content encryption

  /** Integrity */
  content_hash: string;    // SHA-256 of plaintext (allows client to verify round-trip)
}
```

## 3. API Design — REST Endpoints on Relay

All endpoints require authentication via API key (existing auth system). Vault operations additionally require the auth tag from Argon2id.

```
POST   /v1/vault/init         — Create vault (salt, wrapped VK, auth tag hash)
POST   /v1/vault/unlock       — Verify auth tag, return vault metadata (salt, wrapped VK)
POST   /v1/vault/rotate       — Rotate VK: upload new wrapped VK + re-wrapped DEKs

GET    /v1/vault/blobs                    — List blob metadata (namespace, key, version)
GET    /v1/vault/blobs/:namespace/:key    — Get blob (wrapped DEK + ciphertext)
PUT    /v1/vault/blobs/:namespace/:key    — Create/update blob
DELETE /v1/vault/blobs/:namespace/:key    — Delete blob

GET    /v1/vault/blobs/:namespace         — List all blobs in a namespace

POST   /v1/vault/share                    — Share vault access with another account
DELETE /v1/vault/share/:account_id        — Revoke shared access
GET    /v1/vault/shares                   — List accounts with shared access
```

**Request/response flow for reading a config blob:**

1. Client calls `POST /v1/vault/unlock` with `{ auth_tag: base64url(authKey) }`.
2. Relay verifies `SHA-256(authKey) == stored_auth_hash`. Returns `{ salt, wrapped_vk, nonce_vk }`.
3. Client derives MK from password + salt, decrypts VK.
4. Client calls `GET /v1/vault/blobs/fleet/nodes`.
5. Relay returns `{ wrapped_dek, ciphertext, nonce_dek, nonce_ct }`.
6. Client unwraps DEK using VK, decrypts ciphertext using DEK.

**Tier gating:**
- `POST /v1/vault/init` checks `account.tier != "free"`. Returns 402 for free accounts.
- All `/v1/vault/*` endpoints check tier. If account was downgraded, existing data is still readable (GET) but not writable (PUT/POST/DELETE return 402).

## 4. Data Model — Relay DB Schema

New migration in `packages/relay/src/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS vaults (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  argon2_salt TEXT NOT NULL,          -- base64url, 32 bytes
  auth_hash TEXT NOT NULL,            -- hex(SHA-256(authKey))
  wrapped_vk TEXT NOT NULL,           -- base64url(encrypted VK)
  nonce_vk TEXT NOT NULL,             -- base64url, 24-byte nonce for VK wrapping
  version INTEGER NOT NULL DEFAULT 1, -- incremented on VK rotation
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_blobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  wrapped_dek TEXT NOT NULL,
  nonce_dek TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  nonce_ct TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, namespace, key)
);

CREATE INDEX IF NOT EXISTS idx_vault_blobs_account_ns
  ON vault_blobs(account_id, namespace);

CREATE TABLE IF NOT EXISTS vault_shares (
  vault_owner_id TEXT NOT NULL REFERENCES accounts(id),
  shared_with_id TEXT NOT NULL REFERENCES accounts(id),
  wrapped_vk TEXT NOT NULL,           -- VK wrapped under shared_with's MK
  nonce_vk TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT 'read', -- 'read' or 'readwrite'
  created_at TEXT NOT NULL,
  PRIMARY KEY (vault_owner_id, shared_with_id)
);
```

## 5. Client-Side Implementation

**New module: `packages/core/src/vault.ts`**

Pure library with no I/O — callers provide the ciphertext and keys.

Key functions:
- `deriveVaultKeys(password: string, salt: Uint8Array): { masterKey, authKey }` — Argon2id
- `createVault(password: string): { salt, wrappedVk, nonceVk, authHash, vk }` — generate new vault
- `unlockVault(password: string, salt, wrappedVk, nonceVk): vk` — decrypt VK from relay response
- `encryptBlob(vk, plaintext): { wrappedDek, nonceDek, ciphertext, nonceCt, contentHash }` — encrypt a config blob
- `decryptBlob(vk, wrappedDek, nonceDek, ciphertext, nonceCt): Uint8Array` — decrypt a config blob
- `rotateVaultKey(oldVk, newPassword, blobDeks): { newWrappedVk, reWrappedDeks }` — VK rotation

**New module: `packages/client/src/vault-client.ts`**

Wraps the vault API calls and integrates with the encryption library:
- `VaultClient` class with methods: `init()`, `unlock(password)`, `getConfig(namespace, key)`, `putConfig(namespace, key, data)`, `listConfigs(namespace)`, `rotateKey(oldPassword, newPassword)`
- Caches the unlocked VK in memory for the session duration (no persistence to disk of VK).

**CLI integration:**

New subcommand group: `orka vault`
- `orka vault init` — Create vault (prompts for password)
- `orka vault unlock` — Unlock and cache vault key for the session
- `orka vault config get <namespace>/<key>` — Read a config blob
- `orka vault config set <namespace>/<key> [--file path | --value json]` — Write a config blob
- `orka vault config list [namespace]` — List blobs
- `orka vault keys sync` — Sync local Noise keys to vault
- `orka vault keys pull` — Pull Noise keys from vault to local
- `orka vault rotate` — Rotate vault key (prompts for old and new passwords)
- `orka vault share <email> [--write]` — Share vault with another account

## 6. Key Management

**Master key backup and recovery:**
- At vault creation, generate a 24-word BIP-39 mnemonic recovery phrase from the Argon2id-derived master key. Display once; user must write it down.
- Recovery: `orka vault recover` accepts the 24-word phrase, derives MK, re-wraps VK under a new password.
- There is no server-side recovery. If both password and recovery phrase are lost, all vault data is permanently inaccessible. This is an explicit design choice for zero-knowledge security.

**Device sync:**
- On a new device, user runs `orka vault unlock` with their password. The relay returns the encrypted VK, which is decrypted locally.
- No key material is synced between devices — only the password travels (in the user's memory).

**Noise node key storage in vault:**
- Namespace `keys/noise/<node-id>` stores `{ publicKey, privateKey }` encrypted.
- On `orka vault keys pull`, the CLI decrypts and writes to `~/.orka/keys/`.
- On `orka vault keys sync`, the CLI reads from `~/.orka/keys/` and uploads encrypted.

**Key rotation without re-encrypting all blobs:**
- Generate new VK.
- Re-wrap VK under MK (one XChaCha20-Poly1305 operation).
- For each blob: decrypt DEK with old VK, re-encrypt DEK with new VK (one operation per blob, the actual ciphertext stays the same).
- Upload new wrapped VK + all re-wrapped DEKs in a single `POST /v1/vault/rotate` call.
- Server atomically replaces `vaults.wrapped_vk` and all `vault_blobs.wrapped_dek` in a transaction.

## 7. Access Control

**Per-account isolation:**
- Each account has exactly one vault.
- `vault_blobs` are scoped by `account_id` — the relay enforces that a request can only read/write blobs for the authenticated account (or shared vaults).

**Team/org sharing:**
- Account A shares with Account B via `POST /v1/vault/share`.
  - A's client encrypts A's VK under B's public MK-derived wrapping key.
  - B receives the wrapped VK and can decrypt all of A's blobs.
- Read vs read-write permissions on the share.
- Revoking a share: delete the `vault_shares` row + A rotates VK, re-wrapping all DEKs.

**Namespace-level ACLs (future v2):**
- For v1, sharing is all-or-nothing (share entire vault).
- v2 could add per-namespace share grants with finer-grained control.

## 8. Migration Path: Local-Only Config to Server-Stored

**Phase 1 — Local config remains primary:**
- `~/.orka/config.toml` and `.orka.toml` continue to work as-is.
- The vault is an additional, optional storage layer for fleet-wide config.
- No breaking changes to existing users.

**Phase 2 — Config resolution with vault:**
- Add a new config layer in the resolution chain:
  ```
  CLI flags > env vars > project config (.orka.toml) > vault config > user config (~/.orka/config.toml)
  ```
- Vault config sits between project config and user config in priority.

**Phase 3 — Fleet push:**
- `orka vault config set fleet/defaults '{"backend":"claude-code","model":"opus"}'`
- All nodes connected to the same relay account automatically pick up vault config on next spawn.
- Node-specific overrides: `orka vault config set fleet/nodes/<node-id>/overrides '...'`

**Migration CLI:**
- `orka vault import-local` — reads `~/.orka/config.toml`, encrypts, and uploads to vault.
- `orka vault export-local` — downloads and decrypts vault config, writes to `~/.orka/config.toml`.

## 9. SaaS Tier Gating

**Tier check:** All `/v1/vault/*` endpoints check `account.tier` via `AuthContext.tier`.
- Free: 402 Payment Required
- Pro: max 100 blobs, max 1 MB per blob, 100 MB total
- Enterprise: max 10,000 blobs, max 10 MB per blob, 1 GB total

**Downgrade behavior:**
- GET operations still work (read-only access).
- PUT/POST/DELETE return 402.
- Existing data NOT deleted (30-day grace period, with email warning).

## 10. Offline Fallback

**Local vault cache:**
- After decrypting vault blobs, CLI optionally caches to `~/.orka/vault-cache/` (encrypted with session-derived key tied to machine).
- Cache used when relay is unreachable. TTL: 24 hours (configurable).
- Relay is always the source of truth when available.

## 11. Interaction with Existing Noise NK Encryption

- **Noise NK** protects live sessions (CLI to daemon traffic). Keys are per-node X25519 keypairs.
- **Vault** protects at-rest config and key storage on the relay. Uses symmetric XChaCha20-Poly1305 derived from user password.
- **Integration:** Noise node public keys can be synced to the vault, so a new device can pull them without re-pairing.
- **No conflict:** If `--encrypt` is used, vault API traffic is double-encrypted (Noise session wraps vault API payloads, which contain client-side-encrypted blobs).

## 12. Proposed Task Breakdown

```
[EPIC]: Encrypted config & key storage on relay (SaaS tier)
├── .1: [P1] Core vault crypto library (packages/core/src/vault.ts)
│     Argon2id KDF, XChaCha20-Poly1305 envelope encryption, VK wrapping,
│     blob encrypt/decrypt, key rotation. Unit tests with known test vectors.
│
├── .2: [P1] Relay DB schema + migration for vault tables
│     vaults, vault_blobs, vault_shares tables. Migration, row schemas, mappers.
│
├── .3: [P1] Relay vault API endpoints
│     CRUD for /v1/vault/*. Tier gating. Input validation (zod).
│     Dependencies: .2
│
├── .4: [P1] Vault client library (packages/client/src/vault-client.ts)
│     VaultClient class + client-side encrypt/decrypt. VK session caching.
│     Dependencies: .1, .3
│
├── .5: [P1] CLI `orka vault` command group
│     Subcommands: init, unlock, config get/set/list, keys sync/pull, rotate, share.
│     Dependencies: .4
│
├── .6: [P2] E2E tests for vault lifecycle
│     Dependencies: .3, .4
│
├── .7: [P2] Config resolution with vault layer
│     Dependencies: .4
│
├── .8: [P2] Noise key sync to vault
│     Dependencies: .5
│
├── .9: [P3] Offline vault cache
│     Dependencies: .4
│
├── .10: [P3] Vault migration CLI (import/export local config)
│     Dependencies: .5
│
└── .11: [P3] Recovery phrase + vault recovery flow
      Dependencies: .5
```

**Critical path:** .1 + .2 (parallel) → .3 → .4 → .5 + .6 (parallel) → rest

## Key Architectural Decisions

1. **XChaCha20-Poly1305 over AES-GCM** — aligns with existing Noise NK usage, 24-byte nonce safe for random generation
2. **Argon2id over PBKDF2/bcrypt** — memory-hard, resists GPU/ASIC attacks
3. **3-layer key hierarchy** — enables rotation without re-encrypting blob content
4. **Auth tag instead of OPAQUE** — relay is untrusted-by-design, simpler protocol
5. **All-or-nothing sharing for v1** — fine-grained ACLs deferred to v2
