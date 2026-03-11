import { createHash, randomBytes } from "node:crypto";
import { generateId } from "@orka/core";
import {
  type ApiKeyRecord,
  type RateLimitConfig,
  type Account,
  createAccount,
  getApiKeyByHash,
  getAccount,
  getRateLimits,
  insertApiKey,
  updateApiKeyLastUsed,
} from "./db";
import { getRelayConfig } from "./config";

// --- API Key Generation ---

/** Base62 alphabet for key generation */
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomBase62(length: number): string {
  const bytes = randomBytes(length);
  let result = "";
  for (const byte of bytes) {
    result += BASE62[byte % 62];
  }
  return result;
}

export interface GeneratedKey {
  /** The full API key (only returned once, never stored) */
  key: string;
  /** The key record to store in DB */
  record: ApiKeyRecord;
}

/** Generate a new API key. The full key is returned only once. */
export function generateApiKey(
  accountId: string,
  opts?: { label?: string; permissions?: "client" | "node" | "admin" },
): GeneratedKey {
  const secret = randomBase62(32);
  const key = `ork_live_${secret}`;
  const keyHash = hashKey(key);
  const keyPrefix = key.slice(0, 16); // "ork_live_" + first 7 chars of secret

  const record: ApiKeyRecord = {
    id: generateId("key"),
    accountId,
    keyHash,
    keyPrefix,
    label: opts?.label ?? "default",
    permissions: opts?.permissions ?? "client",
    status: "active",
    lastUsedAt: null,
    createdAt: new Date().toISOString(),
  };

  return { key, record };
}

/** Hash an API key for storage/lookup. */
export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

// --- Auth Context ---

export interface AuthContext {
  accountId: string;
  account: Account;
  permissions: "client" | "node" | "admin";
  tier: string;
  rateLimits: RateLimitConfig;
  keyHash: string;
}

// --- Auth Cache ---

interface CacheEntry {
  ctx: AuthContext;
  expiresAt: number;
}

const AUTH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const AUTH_CACHE_MAX = 10_000;

class AuthCache {
  private cache = new Map<string, CacheEntry>();

  get(keyHash: string): AuthContext | null {
    const entry = this.cache.get(keyHash);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(keyHash);
      return null;
    }
    // Refresh TTL on access
    entry.expiresAt = Date.now() + AUTH_CACHE_TTL;
    return entry.ctx;
  }

  set(keyHash: string, ctx: AuthContext): void {
    // Evict oldest if at capacity
    if (this.cache.size >= AUTH_CACHE_MAX) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(keyHash, { ctx, expiresAt: Date.now() + AUTH_CACHE_TTL });
  }

  evict(keyHash: string): void {
    this.cache.delete(keyHash);
  }

  /** Remove expired entries */
  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) this.cache.delete(key);
    }
  }
}

const authCache = new AuthCache();

// Periodic cache pruning — unref'd so it doesn't keep the process alive
const _pruneTimer = setInterval(() => authCache.prune(), 60_000);
if (typeof _pruneTimer === "object" && "unref" in _pruneTimer) {
  (_pruneTimer as any).unref();
}

// --- Batch last_used_at updates ---

const lastUsedQueue = new Set<string>();
let lastUsedFlushTimer: Timer | null = null;

function queueLastUsedUpdate(keyHash: string): void {
  lastUsedQueue.add(keyHash);
  if (!lastUsedFlushTimer) {
    lastUsedFlushTimer = setTimeout(flushLastUsed, 10_000);
  }
}

function flushLastUsed(): void {
  lastUsedFlushTimer = null;
  for (const kh of lastUsedQueue) {
    try { updateApiKeyLastUsed(kh); } catch { /* best effort */ }
  }
  lastUsedQueue.clear();
}

export function flushAuthUpdates(): void {
  flushLastUsed();
}

// --- Authentication ---

export interface AuthResult {
  success: boolean;
  ctx?: AuthContext;
  error?: string;
  code?: number; // HTTP status code
}

const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  accountId: "",
  requestsPerMinute: 60,
  requestsPerHour: 1000,
  concurrentConnections: 10,
  maxMessageBytes: 1_048_576,
};

/**
 * Authenticate a request by API key.
 * Extracts key from Authorization header or ?token= query param.
 * Returns AuthContext on success, error on failure.
 */
export function authenticate(key: string): AuthResult {
  if (!key) {
    return { success: false, error: "Missing API key", code: 401 };
  }

  const keyHash = hashKey(key);

  // Check cache first
  const cached = authCache.get(keyHash);
  if (cached) {
    queueLastUsedUpdate(keyHash);
    return { success: true, ctx: cached };
  }

  // DB lookup
  const keyRecord = getApiKeyByHash(keyHash);
  if (!keyRecord) {
    // Check legacy token
    const config = getRelayConfig();
    if (config.auth.legacyToken && key === config.auth.legacyToken) {
      // Legacy token: create a synthetic auth context
      const ctx: AuthContext = {
        accountId: "__legacy__",
        account: {
          id: "__legacy__",
          email: "legacy@localhost",
          name: "Legacy Token",
          status: "active",
          tier: "pro",
          createdAt: "",
          updatedAt: "",
        },
        permissions: "client",
        tier: "pro",
        rateLimits: DEFAULT_RATE_LIMITS,
        keyHash,
      };
      authCache.set(keyHash, ctx);
      return { success: true, ctx };
    }
    return { success: false, error: "Invalid API key", code: 401 };
  }

  if (keyRecord.status !== "active") {
    return { success: false, error: "API key revoked", code: 403 };
  }

  // Load account
  const account = getAccount(keyRecord.accountId);
  if (!account) {
    return { success: false, error: "Account not found", code: 403 };
  }

  if (account.status === "suspended") {
    return { success: false, error: "Account suspended", code: 403 };
  }
  if (account.status === "deleted") {
    return { success: false, error: "Account deleted", code: 403 };
  }

  // Load rate limits
  const rateLimits = getRateLimits(keyRecord.accountId) ?? { ...DEFAULT_RATE_LIMITS, accountId: keyRecord.accountId };

  const ctx: AuthContext = {
    accountId: keyRecord.accountId,
    account,
    permissions: keyRecord.permissions,
    tier: account.tier,
    rateLimits,
    keyHash,
  };

  authCache.set(keyHash, ctx);
  queueLastUsedUpdate(keyHash);

  return { success: true, ctx };
}

/**
 * Extract API key from request.
 * Checks Authorization header first, then ?token= query param.
 */
export function extractApiKey(req: Request): string | null {
  // Authorization: Bearer <key>
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // ?token=<key> query param
  const url = new URL(req.url);
  return url.searchParams.get("token");
}

/**
 * Create an account and its first API key.
 * Returns both the account and the raw API key (shown only once).
 */
export function signup(email: string, name: string): { account: Account; apiKey: string } {
  const account = createAccount(email, name);
  const { key, record } = generateApiKey(account.id);
  insertApiKey(record);
  return { account, apiKey: key };
}
