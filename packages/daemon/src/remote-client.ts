import type {
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
  RpcRequest,
  RpcResponse,
} from "@orka/core";

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

  constructor(url: string) {
    this.url = url;
  }

  private async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.onopen = () => {
        this.ws = ws;
        this.connectPromise = null;
        resolve();
      };
      ws.onerror = () => {
        this.connectPromise = null;
        reject(new Error(`WebSocket connection failed: ${this.url}`));
      };
      ws.onclose = () => {
        this.ws = null;
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
  }

  private handleMessage(raw: string): void {
    let resp: RpcResponse;
    try {
      resp = JSON.parse(raw);
    } catch {
      return;
    }

    const p = this.pending.get(resp.id);
    if (!p) return;
    this.pending.delete(resp.id);

    if (resp.error) {
      p.reject(new Error(resp.error.message));
    } else {
      p.resolve(resp.result);
    }
  }

  private async call(method: string, params?: any): Promise<any> {
    await this.connect();
    const id = String(this.nextId++);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      const req: RpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      };

      this.ws!.send(JSON.stringify(req));

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 30_000);
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
    return this.call("pruneSessions", opts);
  }
}

export function createRemoteClient(url: string): RemoteClient {
  return new RemoteClient(url);
}
