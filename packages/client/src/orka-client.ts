import type {
  ChatEntry,
  NodeInfo,
  OrchestrationEvent,
  OrkaService,
  SessionDetailResponse,
  SessionListResponse,
  Task,
  SpawnRequest,
  SpawnResult,
  SessionFilters,
  PruneOptions,
  PruneResult,
  DiffResult,
  MergeResult,
  SessionResult,
  TimelineParams,
  TimelineResponse,
  UsageSummary,
  ApprovalRequest,
  ApprovalDecision,
  PushChannel,
  DataFrame,
  StartPairingParams,
  StartPairingResult,
} from "@orka/core";
import { trace } from "@opentelemetry/api";
import { RPC_METHOD_NOT_FOUND, MethodNotFoundError, parseWireEvent, canonicalTransportOrigin } from "@orka/core";
import type { NoiseKeyInfo } from "@orka/core/crypto";
import type { NoiseClientTransport } from "@orka/core/transport/noise-transport";
import { withSpan, injectSpanContext } from "./tracing";
import { ReconnectStrategy } from "./reconnect";
import { driveNoiseHandshake } from "./noise-handshake";

export interface OrkaClientOptions {
  /** WebSocket URL of the daemon or relay */
  url: string;
  /** Noise transport key info for the server. If provided, uses Noise NK encryption. */
  noiseServerKey?: NoiseKeyInfo;
  /** Node ID for Noise transport. Required when using noiseServerKey. */
  nodeId?: string;
  /** Relay origin for Noise transport prologue binding. Defaults to "". */
  relayOrigin?: string;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

class OrkaClient implements OrkaService {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private url: string;
  private connectPromise: Promise<void> | null = null;
  private noiseServerKey: NoiseKeyInfo | undefined;
  private nodeId: string | undefined;
  private relayOrigin: string;
  private noiseTransport: NoiseClientTransport | null = null;
  private backoff = new ReconnectStrategy();

  constructor(opts: OrkaClientOptions) {
    this.url = opts.url;
    this.noiseServerKey = opts.noiseServerKey;
    this.nodeId = opts.nodeId;
    this.relayOrigin = canonicalTransportOrigin(opts.relayOrigin);
  }

  private get useNoise(): boolean {
    return !!this.noiseServerKey;
  }

  private async connect(): Promise<void> {
    return withSpan("orka.rpc.connect", {}, async () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Already connected. If Noise, ensure handshake is done.
        if (this.useNoise && this.noiseTransport?.isSecure) return;
        if (!this.useNoise) return;
      }
      if (this.connectPromise) return this.connectPromise;

      this.connectPromise = new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(this.url);
        ws.onopen = () => {
          this.ws = ws;
          this.connectPromise = null;
          this.backoff.reset();

          if (this.useNoise) {
            // Start Noise handshake
            this.performNoiseHandshake(ws).then(resolve).catch(reject);
          } else {
            resolve();
          }
        };
        ws.onerror = () => {
          this.connectPromise = null;
          reject(new Error(`WebSocket connection failed: ${this.url}`));
        };
        ws.onclose = () => {
          this.ws = null;
          this.connectPromise = null;
          this.noiseTransport = null;
          // Reject all pending requests
          for (const [id, p] of this.pending) {
            clearTimeout(p.timer);
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

  private performNoiseHandshake(ws: WebSocket): Promise<void> {
    return withSpan("orka.rpc.noise_handshake", {
      "orka.transport.side": "client",
    }, async (span) => {
      if (!this.noiseServerKey) {
        throw new Error("Noise server key not configured");
      }

      span.addEvent("noise.client_hello_sent");

      this.noiseTransport = await driveNoiseHandshake(ws, {
        nodeId: this.nodeId ?? "",
        serverKey: this.noiseServerKey,
        relayOrigin: this.relayOrigin,
      });

      span.addEvent("noise.handshake_complete");
    });
  }

  private handleMessage(raw: string): void {
    let resp: unknown;
    try {
      resp = JSON.parse(raw);
    } catch {
      return;
    }

    // Noise transport: decrypt data frames
    if (this.noiseTransport?.isSecure) {
      const frame = resp as Record<string, unknown>;
      if (frame["t"] === "data" && typeof frame["ct"] === "string") {
        try {
          resp = this.noiseTransport.decryptData(frame as DataFrame);
        } catch {
          // Decryption failed — record the error and drop the frame
          const activeSpan = trace.getActiveSpan();
          if (activeSpan) {
            activeSpan.addEvent("noise.decrypt_error", {
              "orka.transport.side": "client",
            });
          }
          return;
        }
      } else {
        // Not a data frame in Noise mode — ignore
        return;
      }
    }
    if (!isRecord(resp) || typeof resp["id"] !== "string") {
      return;
    }

    const p = this.pending.get(resp["id"]);
    if (!p) return;
    this.pending.delete(resp["id"]);
    clearTimeout(p.timer);

    const error = isRecord(resp["error"]) ? resp["error"] : undefined;
    if (error) {
      if (error["code"] === RPC_METHOD_NOT_FOUND) {
        p.reject(new MethodNotFoundError(p.method, typeof error["message"] === "string" ? error["message"] : undefined));
      } else {
        p.reject(new Error(typeof error["message"] === "string" ? error["message"] : "RPC request failed"));
      }
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
        const timer = setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new Error(`Request timeout: ${method}`));
          }
        }, 30_000);
        timer.unref();

        this.pending.set(id, { resolve, reject, timer, method });

        let req: any = {
          jsonrpc: "2.0",
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        };
        const traceCarrier: { traceparent?: string } = {};
        injectSpanContext(span, traceCarrier);
        if (traceCarrier.traceparent) {
          req.traceparent = traceCarrier.traceparent;
        }

        // Noise transport: encrypt entire RPC message
        if (this.noiseTransport?.isSecure) {
          const frame = this.noiseTransport.encryptRpc(req);
          this.ws!.send(JSON.stringify(frame));
          return;
        }

        this.ws!.send(JSON.stringify(req));
      });
    });
  }

  close(): void {
    this.ws?.close();
    this.noiseTransport = null;
  }

  // --- OrkaService ---

  async spawn(req: SpawnRequest): Promise<SpawnResult> {
    return this.call("spawn", req);
  }

  async stop(sessionId: string): Promise<void> {
    return this.call("stop", { sessionId });
  }

  async reap(): Promise<number> {
    return this.call("reap");
  }

  async getSession(id: string): Promise<SessionDetailResponse | null> {
    return this.call("getSession", { id });
  }

  async listSessions(filters?: SessionFilters): Promise<SessionListResponse[]> {
    return this.call("listSessions", { filters });
  }

  async getChildSessions(sessionId: string): Promise<SessionListResponse[]> {
    return this.call("getChildSessions", { sessionId });
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

  async getSessionTimeline(params: TimelineParams): Promise<TimelineResponse> {
    const raw: any = await this.call("getSessionTimeline", params);
    const rawEvents: unknown[] = Array.isArray(raw?.events) ? raw.events : [];
    const events: OrchestrationEvent[] = [];
    for (const item of rawEvents) {
      const event = parseWireEvent(item);
      if (event) events.push(event);
    }
    return { events, total: typeof raw?.total === "number" ? raw.total : events.length };
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

  async sendTurn(sessionId: string, text: string): Promise<void> {
    return this.call("sendTurn", { sessionId, text });
  }

  async startPairing(params: StartPairingParams): Promise<StartPairingResult> {
    return this.call("startPairing", params);
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

  async archiveSession(sessionId: string): Promise<void> {
    return this.call("archiveSession", { sessionId });
  }

  async unarchiveSession(sessionId: string): Promise<void> {
    return this.call("unarchiveSession", { sessionId });
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

  async backfillSession(sessionId: string): Promise<{ eventsReplayed: number }> {
    return this.call("backfillSession", { sessionId });
  }

  async getMetrics(): Promise<Record<string, unknown> | null> {
    return this.call("getMetrics", {});
  }

  async queryTraces(query?: {
    service?: string;
    errorsOnly?: boolean;
    namePattern?: string;
    limit?: number;
    since?: string;
  }): Promise<Array<Record<string, unknown>>> {
    return this.call("queryTraces", query ?? {});
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

  async listNodes(): Promise<NodeInfo[]> {
    return this.call("listNodes");
  }
}

export function createOrkaClient(urlOrOpts: string | OrkaClientOptions): OrkaClient {
  const opts = typeof urlOrOpts === "string" ? { url: urlOrOpts } : urlOrOpts;
  return new OrkaClient(opts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
