import type {
  ChatEntry,
  OrchestrationEvent,
  OrkaService,
  Session,
  Task,
  SpawnRequest,
  SessionFilters,
  PruneOptions,
  PruneResult,
  DiffResult,
  MergeResult,
  SessionResult,
  UsageSummary,
  KeyPair,
  ApprovalRequest,
  ApprovalDecision,
  PushChannel,
} from "@orka/core";
import { context, propagation, trace } from "@opentelemetry/api";
import { encryptRequest, decryptResponse, deriveSessionKey, ReconnectStrategy } from "@orka/core";
import { withSpan } from "./tracing";

export interface RemoteClientOptions {
  /** WebSocket URL of the daemon or relay */
  url: string;
  /** Client keypair for E2E encryption. If provided with serverPublicKey, enables encryption. */
  keyPair?: KeyPair;
  /** Server/node public key (base64). Required for E2E encryption. */
  serverPublicKey?: string;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

class RemoteClient implements OrkaService {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private url: string;
  private connectPromise: Promise<void> | null = null;
  private encKey: Buffer | null = null;
  private keyPair: KeyPair | undefined;
  private serverPublicKey: string | undefined;
  private backoff = new ReconnectStrategy();

  constructor(opts: RemoteClientOptions) {
    this.url = opts.url;
    this.keyPair = opts.keyPair;
    this.serverPublicKey = opts.serverPublicKey;
  }

  private async connect(): Promise<void> {
    return withSpan("orka.rpc.connect", {}, async () => {
      if (this.ws?.readyState === WebSocket.OPEN) return;
      if (this.connectPromise) return this.connectPromise;

      // Derive encryption key if E2E is configured
      if (this.keyPair && this.serverPublicKey && !this.encKey) {
        this.encKey = await deriveSessionKey(
          this.keyPair.privateKey,
          this.serverPublicKey,
          // Use a fixed salt derived from both public keys for deterministic key derivation
          Buffer.from(this.keyPair.publicKey + this.serverPublicKey).toString("base64").slice(0, 44),
        );
      }

      // Append client public key to URL for server-side key derivation
      let connectUrl = this.url;
      if (this.keyPair) {
        const sep = connectUrl.includes("?") ? "&" : "?";
        connectUrl += `${sep}pubkey=${encodeURIComponent(this.keyPair.publicKey)}`;
      }

      this.connectPromise = new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(connectUrl);
        ws.onopen = () => {
          this.ws = ws;
          this.connectPromise = null;
          this.backoff.reset();
          resolve();
        };
        ws.onerror = () => {
          this.connectPromise = null;
          reject(new Error(`WebSocket connection failed: ${this.url}`));
        };
        ws.onclose = () => {
          this.ws = null;
          this.connectPromise = null;
          // Reject all pending requests
          for (const [id, p] of this.pending) {
            p.reject(new Error("Connection closed"));
            this.pending.delete(id);
          }
        };
        ws.onmessage = (event) => {
          this.handleMessage(typeof event.data === "string" ? event.data : "");
        };
      });

      return this.connectPromise;
    });
  }

  private handleMessage(raw: string): void {
    let resp: unknown;
    try {
      resp = JSON.parse(raw);
    } catch {
      return;
    }

    // Decrypt response if encrypted
    if (this.encKey && isRecord(resp) && resp["_enc"]) {
      try {
        resp = decryptResponse(this.encKey, resp);
      } catch {
        // Decryption failed — treat as error
        const respId = isRecord(resp) ? resp["id"] : undefined;
        const pendingId = typeof respId === "string" ? respId : "";
        const p = this.pending.get(pendingId);
        if (p) {
          this.pending.delete(pendingId);
          p.reject(new Error("E2E decryption failed"));
        }
        return;
      }
    }

    if (!isRecord(resp) || typeof resp["id"] !== "string") {
      return;
    }

    const p = this.pending.get(resp["id"]);
    if (!p) return;
    this.pending.delete(resp["id"]);

    const error = isRecord(resp["error"]) ? resp["error"] : undefined;
    if (error) {
      p.reject(new Error(typeof error["message"] === "string" ? error["message"] : "RPC request failed"));
    } else {
      p.resolve(resp["result"]);
    }
  }

  private async call(method: string, params?: any): Promise<any> {
    return withSpan("orka.rpc.request", {
      "orka.method": method,
    }, async (span) => {
      await this.connect();
      const id = String(this.nextId++);

      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });

        let req: any = {
          jsonrpc: "2.0",
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        };
        const traceCarrier: { traceparent?: string } = {};
        propagation.inject(trace.setSpan(context.active(), span), traceCarrier);
        if (traceCarrier.traceparent) {
          req.traceparent = traceCarrier.traceparent;
        }

        // Encrypt params if E2E is enabled
        if (this.encKey && req.params) {
          req = encryptRequest(this.encKey, req);
        }

        this.ws!.send(JSON.stringify(req));

        setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`Request timeout: ${method}`));
          }
        }, 30_000);
      });
    });
  }

  close(): void {
    this.ws?.close();
  }

  // --- OrkaService ---

  async spawn(req: SpawnRequest): Promise<Session> {
    return this.call("spawn", req);
  }

  async stop(sessionId: string): Promise<void> {
    return this.call("stop", { sessionId });
  }

  async reap(): Promise<number> {
    return this.call("reap");
  }

  async getSession(id: string): Promise<Session | null> {
    return this.call("getSession", { id });
  }

  async listSessions(filters?: SessionFilters): Promise<Session[]> {
    return this.call("listSessions", { filters });
  }

  async getTask(id: string): Promise<Task | null> {
    return this.call("getTask", { id });
  }

  async setKept(sessionId: string, kept: boolean): Promise<void> {
    return this.call("setKept", { sessionId, kept });
  }

  async getTags(sessionId: string): Promise<string[]> {
    return this.call("getTags", { sessionId });
  }

  async getResult(sessionId: string): Promise<SessionResult | null> {
    return this.call("getResult", { sessionId });
  }

  async getSessionTimeline(sessionId: string): Promise<OrchestrationEvent[]> {
    return this.call("getSessionTimeline", { sessionId });
  }

  async getChatMessages(sessionId: string): Promise<ChatEntry[]> {
    return this.call("getChatMessages", { sessionId });
  }

  async getUsage(opts?: { sessionId?: string; since?: string; backend?: string }): Promise<UsageSummary> {
    return this.call("getUsage", opts ?? {});
  }

  async captureOutput(sessionId: string): Promise<string> {
    return this.call("captureOutput", { sessionId });
  }

  async getLogContent(sessionId: string): Promise<string | null> {
    return this.call("getLogContent", { sessionId });
  }

  async isAlive(sessionId: string): Promise<boolean> {
    return this.call("isAlive", { sessionId });
  }

  async sendInput(sessionId: string, text: string): Promise<void> {
    return this.call("sendInput", { sessionId, text });
  }

  async getDiff(sessionId: string): Promise<DiffResult> {
    return this.call("getDiff", { sessionId });
  }

  async merge(sessionId: string, cleanup?: boolean): Promise<MergeResult> {
    return this.call("merge", { sessionId, cleanup });
  }

  async deleteSessions(ids: string[]): Promise<void> {
    return this.call("deleteSessions", { ids });
  }

  async pruneSessions(opts: PruneOptions): Promise<PruneResult> {
    return this.call("pruneSessions", {
      maxAgeMs: opts.maxAgeMs,
      projectPath: opts.projectPath,
      confirm: opts.confirm,
      purgeLogs: opts.purgeLogs,
      purgeDb: opts.purgeDb,
    });
  }

  async getPendingApprovals(sessionId?: string): Promise<ApprovalRequest[]> {
    return this.call("getPendingApprovals", { sessionId });
  }

  async resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    return this.call("resolveApproval", { requestId, decision });
  }

  async reportEventGap(channel: PushChannel, expectedSeq: number, gotSeq: number): Promise<void> {
    return this.call("reportEventGap", { channel, expectedSeq, gotSeq });
  }

  async terminalOpen(sessionId: string, opts?: { cols?: number; rows?: number }): Promise<{ termId: string }> {
    return this.call("terminalOpen", { sessionId, opts });
  }

  async terminalWrite(termId: string, data: string): Promise<void> {
    return this.call("terminalWrite", { termId, data });
  }

  async terminalResize(termId: string, cols: number, rows: number): Promise<void> {
    return this.call("terminalResize", { termId, cols, rows });
  }

  async terminalClose(termId: string): Promise<void> {
    return this.call("terminalClose", { termId });
  }

  async terminalList(sessionId: string): Promise<Array<{ id: string; cols: number; rows: number }>> {
    return this.call("terminalList", { sessionId });
  }
}

export function createRemoteClient(urlOrOpts: string | RemoteClientOptions): RemoteClient {
  const opts = typeof urlOrOpts === "string" ? { url: urlOrOpts } : urlOrOpts;
  return new RemoteClient(opts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
