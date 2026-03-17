import { Database } from "bun:sqlite";
import { z } from "zod/v4";
import {
  getAccount,
  getAccountByEmail,
  listAccounts,
  updateAccountStatus,
  updateAccountTier,
  updateRateLimits,
  listApiKeys,
  revokeApiKey,
  getAccountUsage,
  getAccountCount,
  getRateLimits,
  insertApiKey,
} from "./db";
import { generateApiKey, extractApiKey, type AuthManager } from "./auth";
import type { RelayConfig } from "./config";
import type { RelayState } from "./state";
import { withSpan } from "./tracing";

// --- Input Schemas ---

const SignupSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200),
});

const CreateKeySchema = z.object({
  label: z.string().min(1).max(100).optional(),
  permissions: z.enum(["client", "node"]).optional(),
});

const UpdateAccountSchema = z.object({
  status: z.enum(["active", "suspended"]).optional(),
  tier: z.enum(["free", "pro", "enterprise"]).optional(),
  rateLimits: z.object({
    requestsPerMinute: z.number().optional(),
    requestsPerHour: z.number().optional(),
    concurrentConnections: z.number().optional(),
    maxMessageBytes: z.number().optional(),
  }).optional(),
});

const UsageQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  granularity: z.enum(["hour", "day"]).optional(),
});

// --- Signup Rate Limiter ---

const SIGNUP_WINDOW = 3_600_000; // 1 hour
const SIGNUP_MAX_PER_IP = 5;

/**
 * Per-IP rate limiter for signup endpoint.
 * Create one per relay instance.
 */
export class SignupRateLimiter {
  private readonly attempts = new Map<string, { count: number; windowStart: number }>();
  private readonly cleanupTimer: Timer;

  constructor() {
    this.cleanupTimer = setInterval(() => {
      const cutoff = Date.now() - SIGNUP_WINDOW;
      for (const [ip, entry] of this.attempts) {
        if (entry.windowStart < cutoff) this.attempts.delete(ip);
      }
    }, 60_000);
    if (typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      (this.cleanupTimer as any).unref();
    }
  }

  check(ip: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(ip);
    if (!entry || now - entry.windowStart > SIGNUP_WINDOW) {
      this.attempts.set(ip, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= SIGNUP_MAX_PER_IP) return false;
    entry.count++;
    return true;
  }

  shutdown(): void {
    clearInterval(this.cleanupTimer);
  }
}

// --- Helper ---

function json(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(message: string, status: number): Response {
  return json({ error: { code: status, message } }, status);
}

function getClientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? req.headers.get("x-real-ip")
    ?? "unknown";
}

// --- Route Handler ---

export async function handleApiRequest(
  req: Request,
  url: URL,
  db: Database,
  config: RelayConfig,
  authManager: AuthManager,
  signupRateLimiter: SignupRateLimiter,
  state?: RelayState,
): Promise<Response | null> {
  return withSpan("orka.relay.api.handle", {
    "orka.method": req.method,
    "orka.url": new URL(req.url).pathname,
  }, async () => {
    const path = url.pathname;
    const method = req.method;

    // POST /v1/signup — public, rate limited by IP
    if (path === "/v1/signup" && method === "POST") {
      if (!config.auth.signupEnabled) {
        return error("Signup is disabled", 403);
      }

      const ip = getClientIp(req);
      if (!signupRateLimiter.check(ip)) {
        return error("Too many signup attempts. Try again later.", 429);
      }

      let body: any;
      try {
        body = await req.json();
      } catch {
        return error("Invalid JSON body", 400);
      }

      const parsed = SignupSchema.safeParse(body);
      if (!parsed.success) {
        return error(`Validation error: ${parsed.error.issues[0]?.message ?? "invalid input"}`, 400);
      }

      // Check email uniqueness
      const existing = getAccountByEmail(db, parsed.data.email);
      if (existing) {
        return error("Email already registered", 409);
      }

      const { account, apiKey } = authManager.signup(parsed.data.email, parsed.data.name);
      return json({ accountId: account.id, apiKey }, 201);
    }

    // --- All other endpoints require authentication ---
    const key = extractApiKey(req);
    if (!key) return error("Missing API key", 401);
    const auth = authManager.authenticate(key);
    if (!auth.success || !auth.ctx) return error(auth.error ?? "Unauthorized", auth.code ?? 401);

    const ctx = auth.ctx;

    // --- Admin endpoints ---
    if (path.startsWith("/v1/admin/")) {
      const adminToken = config.auth.adminToken;

      // Admin requires either admin permission or admin token
      if (ctx.permissions !== "admin" && (!adminToken || key !== adminToken)) {
        return error("Admin access required", 403);
      }

      if (path === "/v1/admin/accounts" && method === "GET") {
        const accounts = listAccounts(db);
        return json({ accounts });
      }

      const accountMatch = path.match(/^\/v1\/admin\/accounts\/([^/]+)$/);
      if (accountMatch && method === "PATCH") {
        const accountId = accountMatch[1];
        if (!accountId) {
          return error("Invalid account id", 400);
        }
        let body: any;
        try { body = await req.json(); } catch { return error("Invalid JSON body", 400); }

        const parsed = UpdateAccountSchema.safeParse(body);
        if (!parsed.success) return error("Validation error", 400);

        if (parsed.data.status) updateAccountStatus(db, accountId, parsed.data.status);
        if (parsed.data.tier) updateAccountTier(db, accountId, parsed.data.tier);
        if (parsed.data.rateLimits) {
          updateRateLimits(db, accountId, {
            ...(parsed.data.rateLimits.requestsPerMinute !== undefined
              ? { requestsPerMinute: parsed.data.rateLimits.requestsPerMinute }
              : {}),
            ...(parsed.data.rateLimits.requestsPerHour !== undefined
              ? { requestsPerHour: parsed.data.rateLimits.requestsPerHour }
              : {}),
            ...(parsed.data.rateLimits.concurrentConnections !== undefined
              ? { concurrentConnections: parsed.data.rateLimits.concurrentConnections }
              : {}),
            ...(parsed.data.rateLimits.maxMessageBytes !== undefined
              ? { maxMessageBytes: parsed.data.rateLimits.maxMessageBytes }
              : {}),
          });
        }

        const updated = getAccount(db, accountId);
        return json({ account: updated });
      }

      if (path === "/v1/admin/stats" && method === "GET") {
        const stats = state?.getGlobalStats() ?? { totalNodes: 0, totalClients: 0, totalTransportBindings: 0, accounts: 0 };
        return json({
          accountCount: getAccountCount(db),
          ...stats,
        });
      }

      if (path === "/v1/admin/health" && method === "GET") {
        const stats = state?.getGlobalStats() ?? { totalNodes: 0, totalClients: 0, totalTransportBindings: 0, accounts: 0 };
        const accounts = listAccounts(db);
        const accountDetails = accounts.map((a) => {
          const acctStats = state?.getAccountStats(a.id) ?? { nodes: 0, clients: 0, transportBindings: 0 };
          const limits = getRateLimits(db, a.id);
          return {
            id: a.id,
            email: a.email,
            name: a.name,
            status: a.status,
            tier: a.tier,
            ...acctStats,
            rateLimits: limits,
          };
        });

        return json({
          status: "ok",
          version: "0.2.0",
          global: {
            accountCount: getAccountCount(db),
            ...stats,
          },
          accounts: accountDetails,
          config: {
            signupEnabled: config.auth.signupEnabled,
            rateLimits: config.rateLimits,
            abuse: config.abuse,
          },
        });
      }

      return error("Not found", 404);
    }

    // --- Account endpoints ---

    // GET /v1/account
    if (path === "/v1/account" && method === "GET") {
      return json({
        id: ctx.account.id,
        email: ctx.account.email,
        name: ctx.account.name,
        status: ctx.account.status,
        tier: ctx.account.tier,
        createdAt: ctx.account.createdAt,
      });
    }

    // POST /v1/keys
    if (path === "/v1/keys" && method === "POST") {
      const existingKeys = listApiKeys(db, ctx.accountId);
      if (existingKeys.length >= config.abuse.maxKeysPerAccount) {
        return error(`Maximum ${config.abuse.maxKeysPerAccount} API keys per account`, 400);
      }

      let body: any = {};
      try { body = await req.json(); } catch { /* empty body is OK */ }

      const parsed = CreateKeySchema.safeParse(body);
      if (!parsed.success) return error("Validation error", 400);

      const { key: newKey, record } = generateApiKey(ctx.accountId, {
        ...(parsed.data.label ? { label: parsed.data.label } : {}),
        ...(parsed.data.permissions ? { permissions: parsed.data.permissions } : {}),
      });
      insertApiKey(db, record);

      return json({ keyId: record.id, apiKey: newKey, prefix: record.keyPrefix }, 201);
    }

    // GET /v1/keys
    if (path === "/v1/keys" && method === "GET") {
      const keys = listApiKeys(db, ctx.accountId);
      return json({
        keys: keys.map((k) => ({
          id: k.id,
          prefix: k.keyPrefix,
          label: k.label,
          permissions: k.permissions,
          status: k.status,
          lastUsedAt: k.lastUsedAt,
          createdAt: k.createdAt,
        })),
      });
    }

    // DELETE /v1/keys/:id
    const keyMatch = path.match(/^\/v1\/keys\/([^/]+)$/);
    if (keyMatch && method === "DELETE") {
      const keyId = keyMatch[1];
      if (!keyId) return error("Invalid key id", 400);
      const revoked = revokeApiKey(db, keyId, ctx.accountId);
      if (!revoked) return error("Key not found", 404);
      return json({ revoked: true });
    }

    // GET /v1/usage
    if (path === "/v1/usage" && method === "GET") {
      const params = Object.fromEntries(url.searchParams);
      const parsed = UsageQuerySchema.safeParse(params);
      if (!parsed.success) return error("Invalid query parameters", 400);

      const now = new Date();
      const from = parsed.data?.from ?? new Date(now.getTime() - 24 * 3_600_000).toISOString();
      const to = parsed.data?.to ?? now.toISOString();
      const granularity = parsed.data?.granularity ?? "hour";

      const buckets = getAccountUsage(db, ctx.accountId, from, to, granularity);
      return json({ buckets });
    }

    return null; // Not an API route
  });
}
