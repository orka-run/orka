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
  ApprovalRequest,
  ApprovalDecision,
  PushChannel,
  DataFrame,
  StartPairingParams,
  StartPairingResult,
} from "@orka/core";
import { context, propagation, trace } from "@opentelemetry/api";
import { ReconnectStrategy, RPC_METHOD_NOT_FOUND, MethodNotFoundError, parseWireEvent, canonicalTransportOrigin } from "@orka/core";
import { type NoiseKeyInfo } from "@orka/core/crypto";
import { NoiseClientTransport } from "@orka/core/transport/noise-transport";
import { withSpan } from "./tracing";

export interface RemoteClientOptions {
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

class RemoteClient implements OrkaService {
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

  constructor(opts: RemoteClientOptions) {
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
            this.driveNoiseHandshake(ws).then(resolve).catch(reject);
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

  /**
   * Drive the Noise NK handshake to completion.
   * This sends client_hello and processes server responses until SECURE state.
   */
  private driveNoiseHandshake(ws: WebSocket): Promise<void> {
    return withSpan("orka.rpc.noise_handshake", {
      "orka.transport.side": "client",
    }, async (span) => {
      if (!this.noiseServerKey) {
        throw new Error("Noise server key not configured");
      }

      const transport = new NoiseClientTransport({
        nodeId: this.nodeId ?? "",
        expectedKeyId: this.noiseServerKey.keyId,
        remoteStaticPubkey: this.noiseServerKey.publicKey,
        relayOrigin: this.relayOrigin,
      });
      this.noiseTransport = transport;

      span.addEvent("noise.client_hello_sent");

      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Noise handshake timeout"));
        }, 10_000);
        timeout.unref();

        // Save original onmessage and replace with handshake handler
        const originalOnMessage = ws.onmessage;

        ws.onmessage = (event) => {
          const raw = typeof event.data === "string" ? event.data : "";
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            return;
          }

          // Skip non-handshake messages (e.g. push notifications like server.welcome)
          // during the handshake phase. Handshake messages have a "t" field.
          const msg = parsed as Record<string, unknown>;
          if (!msg || typeof msg["t"] !== "string") {
            return;
          }

          try {
            const responses = transport.processMessage(parsed);
            for (const resp of responses) {
              ws.send(JSON.stringify(resp));
            }

            if (transport.isSecure) {
              clearTimeout(timeout);
              span.addEvent("noise.handshake_complete");
              // Restore normal message handler
              ws.onmessage = originalOnMessage;
              resolve();
            }
          } catch (err) {
            clearTimeout(timeout);
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        };

        // Send client_hello
        const clientHello = transport.getClientHello();
        ws.send(JSON.stringify(clientHello));
      });
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
        propagation.inject(trace.setSpan(context.active(), span), traceCarrier);
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

  async getChildSessions(sessionId: string): Promise<Session[]> {
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

  async getSessionTimeline(sessionId: string): Promise<OrchestrationEvent[]> {
    const raw: unknown[] = await this.call("getSessionTimeline", { sessionId });
    if (!Array.isArray(raw)) return [];
    const events: OrchestrationEvent[] = [];
    for (const item of raw) {
      const event = parseWireEvent(item);
      if (event) events.push(event);
    }
    return events;
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
}

export function createRemoteClient(urlOrOpts: string | RemoteClientOptions): RemoteClient {
  const opts = typeof urlOrOpts === "string" ? { url: urlOrOpts } : urlOrOpts;
  return new RemoteClient(opts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
