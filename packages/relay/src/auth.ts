import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
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
import type { RelayConfig } from "./config";
import { withSpanSync } from "./tracing";

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
  return withSpanSync("orka.relay.auth.generateApiKey", {
    "orka.account.id": accountId,
    "orka.permissions": opts?.permissions ?? "client",
  }, () => {
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
  });
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

// --- Auth Cache (internal) ---

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

// --- Auth Result ---

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

// --- AuthManager ---

/**
 * AuthManager encapsulates all auth state: cache, last-used flush queue, and prune timer.
 * Create one per relay instance. Call shutdown() to clean up timers.
 */
export class AuthManager {
  private readonly db: Database;
  private readonly config: RelayConfig;
  private readonly cache = new AuthCache();
  private readonly lastUsedQueue = new Set<string>();
  private lastUsedFlushTimer: Timer | null = null;
  private readonly pruneTimer: Timer;

  constructor(db: Database, config: RelayConfig) {
    this.db = db;
    this.config = config;

    // Periodic cache pruning
    this.pruneTimer = setInterval(() => this.cache.prune(), 60_000);
    if (typeof this.pruneTimer === "object" && "unref" in this.pruneTimer) {
      (this.pruneTimer as any).unref();
    }
  }

  /**
   * Authenticate a request by API key.
   * Extracts key from Authorization header or ?token= query param.
   * Returns AuthContext on success, error on failure.
   */
  authenticate(key: string): AuthResult {
    return withSpanSync("orka.relay.auth.authenticate", {
      "orka.auth.key_prefix": key.slice(0, 16),
    }, (span) => {
      if (!key) {
        return { success: false, error: "Missing API key", code: 401 };
      }

      const keyHash = hashKey(key);

      // Check cache first
      const cached = this.cache.get(keyHash);
      if (cached) {
        span.setAttribute("orka.auth.cache_hit", true);
        this.queueLastUsedUpdate(keyHash);
        return { success: true, ctx: cached } as AuthResult;
      }
      span.setAttribute("orka.auth.cache_hit", false);

      // DB lookup
      const keyRecord = getApiKeyByHash(this.db, keyHash);
      if (!keyRecord) {
        return { success: false, error: "Invalid API key", code: 401 } as AuthResult;
      }

      if (keyRecord.status !== "active") {
        return { success: false, error: "API key revoked", code: 403 } as AuthResult;
      }

      // Load account
      const account = getAccount(this.db, keyRecord.accountId);
      if (!account) {
        return { success: false, error: "Account not found", code: 403 } as AuthResult;
      }

      if (account.status === "suspended") {
        return { success: false, error: "Account suspended", code: 403 } as AuthResult;
      }
      if (account.status === "deleted") {
        return { success: false, error: "Account deleted", code: 403 } as AuthResult;
      }

      // Load rate limits
      const rateLimits = getRateLimits(this.db, keyRecord.accountId) ?? { ...DEFAULT_RATE_LIMITS, accountId: keyRecord.accountId };

      const ctx: AuthContext = {
        accountId: keyRecord.accountId,
        account,
        permissions: keyRecord.permissions,
        tier: account.tier,
        rateLimits,
        keyHash,
      };

      span.setAttribute("orka.account.id", ctx.accountId);
      this.cache.set(keyHash, ctx);
      this.queueLastUsedUpdate(keyHash);

      return { success: true, ctx } as AuthResult;
    });
  }

  /**
   * Create an account and its first API key.
   * Returns both the account and the raw API key (shown only once).
   */
  signup(email: string, name: string): { account: Account; apiKey: string } {
    const account = createAccount(this.db, email, name);
    const { key, record } = generateApiKey(account.id);
    insertApiKey(this.db, record);
    return { account, apiKey: key };
  }

  /** Flush any pending last_used_at updates immediately. */
  flushAuthUpdates(): void {
    withSpanSync("orka.relay.auth.flush", {}, () => {
      this.flushLastUsed();
    });
  }

  /** Shutdown: clear timers, flush pending updates. */
  shutdown(): void {
    clearInterval(this.pruneTimer);
    if (this.lastUsedFlushTimer) {
      clearTimeout(this.lastUsedFlushTimer);
      this.lastUsedFlushTimer = null;
    }
    this.flushLastUsed();
  }

  // --- Internal ---

  private queueLastUsedUpdate(keyHash: string): void {
    this.lastUsedQueue.add(keyHash);
    if (!this.lastUsedFlushTimer) {
      this.lastUsedFlushTimer = setTimeout(() => this.flushLastUsed(), 10_000);
      if (typeof this.lastUsedFlushTimer === "object" && "unref" in (this.lastUsedFlushTimer as any)) {
        (this.lastUsedFlushTimer as any).unref();
      }
    }
  }

  private flushLastUsed(): void {
    this.lastUsedFlushTimer = null;
    for (const kh of this.lastUsedQueue) {
      try { updateApiKeyLastUsed(this.db, kh); } catch { /* best effort */ }
    }
    this.lastUsedQueue.clear();
  }
}

// --- extractApiKey (stateless, no manager needed) ---

/**
 * Extract API key from request.
 * Checks Authorization header first, then ?token= query param.
 */
export function extractApiKey(req: Request): string | null {
  return withSpanSync("orka.relay.auth.extractApiKey", {
    "orka.method": req.method,
  }, () => {
    // Authorization: Bearer <key>
    const authHeader = req.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      return authHeader.slice(7);
    }

    // ?token=<key> query param
    const url = new URL(req.url);
    return url.searchParams.get("token");
  });
}
