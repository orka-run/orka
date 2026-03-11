// Attribution: WsTransport design inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)

type PushEnvelope = {
  type: "push";
  channel: string;
  sequence: number;
  data: unknown;
};

type RpcResponseEnvelope = {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    message?: string;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  sent: boolean;
  payload: string;
  method: string;
};

export type PushHandler = (data: unknown, sequence: number) => void;
export type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting";

export class WsTransport {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private pushHandlers = new Map<string, Set<PushHandler>>();
  private latestPush = new Map<string, { data: unknown; sequence: number }>();
  private outbox: string[] = [];
  private state: ConnectionState = "disconnected";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 500;
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private shouldReconnect = false;

  constructor(
    private url: string,
    private options?: { timeout?: number; maxReconnectDelay?: number },
  ) {}

  connect(): void {
    this.shouldReconnect = true;

    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.state !== "reconnecting") {
      this.setState("connecting");
    }

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) {
        return;
      }

      this.reconnectDelay = 500;
      this.setState("connected");
      this.syncSubscriptions();
      this.flushOutbox();
    };

    ws.onmessage = (event) => {
      this.handleMessage(typeof event.data === "string" ? event.data : "");
    };

    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
      }
      this.handleClose();
    };

    ws.onerror = () => {
      // Browsers usually emit onclose after onerror for connection failures.
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const ws = this.ws;
    this.ws = null;

    if (ws) {
      ws.close();
    }

    this.outbox = [];
    this.rejectAllPending(new Error("Connection closed"));
    this.reconnectDelay = 500;
    this.setState("disconnected");
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    const id = ++this.requestId;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) {
          return;
        }

        this.pending.delete(id);
        this.outbox = this.outbox.filter((message) => message !== payload);
        reject(new Error(`Request timeout: ${method}`));
      }, this.options?.timeout ?? 60_000);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        sent: false,
        payload,
        method,
      });

      if (this.isOpen()) {
        this.sendRequestPayload(id, payload);
        return;
      }

      this.outbox.push(payload);
      if (!this.shouldReconnect) {
        this.connect();
      }
    });
  }

  subscribe(channel: string, handler: PushHandler): () => void {
    let handlers = this.pushHandlers.get(channel);
    const isFirstHandler = !handlers || handlers.size === 0;

    if (!handlers) {
      handlers = new Set<PushHandler>();
      this.pushHandlers.set(channel, handlers);
    }

    handlers.add(handler);

    if (isFirstHandler) {
      if (this.isOpen()) {
        this.sendControl("subscribe", [channel]);
      } else if (!this.shouldReconnect) {
        this.connect();
      }
    }

    const latest = this.latestPush.get(channel);
    if (latest) {
      handler(latest.data, latest.sequence);
    }

    return () => {
      const currentHandlers = this.pushHandlers.get(channel);
      if (!currentHandlers?.delete(handler)) {
        return;
      }

      if (currentHandlers.size > 0) {
        return;
      }

      this.pushHandlers.delete(channel);
      if (this.isOpen()) {
        this.sendControl("unsubscribe", [channel]);
      }
    };
  }

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (this.isPushEnvelope(parsed)) {
      const current = this.latestPush.get(parsed.channel);
      if (!current || parsed.sequence >= current.sequence) {
        this.latestPush.set(parsed.channel, {
          data: parsed.data,
          sequence: parsed.sequence,
        });
      }

      const handlers = this.pushHandlers.get(parsed.channel);
      if (!handlers) {
        return;
      }

      for (const handler of handlers) {
        handler(parsed.data, parsed.sequence);
      }
      return;
    }

    if (!this.isRpcResponseEnvelope(parsed)) {
      return;
    }

    const id = this.normalizeId(parsed.id);
    if (id === null) {
      return;
    }

    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (parsed.error) {
      pending.reject(new Error(parsed.error.message ?? `Request failed: ${pending.method}`));
      return;
    }

    pending.resolve(parsed.result);
  }

  private handleClose(): void {
    for (const [id, pending] of this.pending) {
      if (!pending.sent) {
        continue;
      }

      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error("Connection closed"));
    }

    if (!this.shouldReconnect) {
      this.setState("disconnected");
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    const delay = Math.min(this.reconnectDelay, this.options?.maxReconnectDelay ?? 8_000);
    this.setState("reconnecting");
    this.reconnectDelay = Math.min(delay * 2, this.options?.maxReconnectDelay ?? 8_000);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this.connect();
      }
    }, delay);
  }

  private flushOutbox(): void {
    const queued = this.outbox;
    this.outbox = [];

    for (const payload of queued) {
      const id = this.extractRequestId(payload);
      if (id === null || !this.pending.has(id)) {
        continue;
      }

      this.sendRequestPayload(id, payload);
    }
  }

  private syncSubscriptions(): void {
    const channels = [...this.pushHandlers.keys()];
    if (channels.length === 0) {
      return;
    }

    this.sendControl("subscribe", channels);
  }

  private sendRequestPayload(id: number, payload: string): void {
    if (!this.isOpen() || !this.ws) {
      this.outbox.push(payload);
      return;
    }

    this.ws.send(payload);
    const pending = this.pending.get(id);
    if (pending) {
      pending.sent = true;
    }
  }

  private sendControl(type: "subscribe" | "unsubscribe", channels: string[]): void {
    if (!this.isOpen() || !this.ws || channels.length === 0) {
      return;
    }

    this.ws.send(JSON.stringify({ type, channels }));
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private setState(nextState: ConnectionState): void {
    if (this.state === nextState) {
      return;
    }

    this.state = nextState;
    for (const listener of this.stateListeners) {
      listener(nextState);
    }
  }

  private extractRequestId(payload: string): number | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return null;
    }

    if (!this.isRpcResponseEnvelope(parsed)) {
      return null;
    }

    return this.normalizeId(parsed.id);
  }

  private normalizeId(id: number | string): number | null {
    if (typeof id === "number" && Number.isFinite(id)) {
      return id;
    }

    if (typeof id === "string" && id.trim() !== "") {
      const numericId = Number(id);
      if (Number.isFinite(numericId)) {
        return numericId;
      }
    }

    return null;
  }

  private isPushEnvelope(value: unknown): value is PushEnvelope {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Partial<PushEnvelope>;
    return (
      candidate.type === "push" &&
      typeof candidate.channel === "string" &&
      typeof candidate.sequence === "number"
    );
  }

  private isRpcResponseEnvelope(value: unknown): value is RpcResponseEnvelope {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Partial<RpcResponseEnvelope>;
    return candidate.jsonrpc === "2.0" && (typeof candidate.id === "number" || typeof candidate.id === "string");
  }
}
