// Attribution: WsTransport design inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)
import type { PushEnvelope, RpcRequest, RpcResponse } from "@orka/core";
import type { Span } from "@opentelemetry/api";
import {
  finishDashboardSpan,
  injectSpanContext,
  startDashboardSpan,
} from "./tracing";
import { rpcLatencyStore } from "./rpcLatencyStore";

type RpcResponseEnvelope = RpcResponse;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  sent: boolean;
  payload: string;
  method: string;
  span: Span;
  startedAt: number;
  createdAt: number;
  sentAt: number | null;
};

export type PushHandler = (data: unknown, sequence: number) => void;
export type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting";

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export class WsTransport {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private pushHandlers = new Map<string, Set<PushHandler>>();
  private latestPush = new Map<string, { data: unknown; sequence: number }>();
  private lastSequenceByChannel = new Map<string, number>();
  private outbox: string[] = [];
  private state: ConnectionState = "disconnected";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 500;
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private shouldReconnect = false;
  private connectionSpan: Span | null = null;
  private connectionStartedAt = 0;

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

    this.beginConnectionSpan();
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) {
        return;
      }

      this.connectionSpan?.addEvent("ws.connected");
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
      this.connectionSpan?.addEvent("ws.closed");
      this.handleClose();
    };

    ws.onerror = () => {
      this.connectionSpan?.addEvent("ws.error");
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
      this.connectionSpan?.addEvent("ws.disconnect_requested");
      ws.close();
    }

    this.outbox = [];
    this.rejectAllPending(new Error("Connection closed"));
    this.endConnectionSpan("disconnected");
    this.reconnectDelay = 500;
    this.setState("disconnected");
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    const id = ++this.requestId;
    const { span, startedAt } = startDashboardSpan("orka.dashboard.rpc", {
      "orka.method": method,
    });
    const traceCarrier: { traceparent?: string } = {};
    injectSpanContext(span, traceCarrier);

    const request: RpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
      ...(traceCarrier.traceparent ? { traceparent: traceCarrier.traceparent } : {}),
    };
    const payload = JSON.stringify(request);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }

        this.pending.delete(id);
        this.outbox = this.outbox.filter((message) => message !== payload);
        const error = new Error(`Request timeout: ${method}`);
        this.recordRpcCompletion(pending, Date.now() - (pending.sentAt ?? pending.createdAt), false);
        finishDashboardSpan(pending.span, pending.startedAt, "timeout", error);
        reject(error);
      }, this.options?.timeout ?? 60_000);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        sent: false,
        payload,
        method,
        span,
        startedAt,
        createdAt: Date.now(),
        sentAt: null,
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
      const handledStartedAt = now();
      this.connectionSpan?.addEvent("push.received", {
        "orka.channel": parsed.channel,
        "orka.sequence": parsed.sequence,
      });

      const previousSequence = this.lastSequenceByChannel.get(parsed.channel);
      if (previousSequence !== undefined && parsed.sequence > previousSequence + 1) {
        this.connectionSpan?.addEvent("push.gap_detected", {
          "orka.channel": parsed.channel,
          "orka.expected_sequence": previousSequence + 1,
          "orka.got_sequence": parsed.sequence,
        });
        void this.request("reportEventGap", {
          channel: parsed.channel,
          expectedSeq: previousSequence + 1,
          gotSeq: parsed.sequence,
        }).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.connectionSpan?.addEvent("push.gap_report_failed", {
            "orka.channel": parsed.channel,
            "orka.expected_sequence": previousSequence + 1,
            "orka.got_sequence": parsed.sequence,
            "orka.error": message,
          });
        });
      }

      if (previousSequence === undefined || parsed.sequence > previousSequence) {
        this.lastSequenceByChannel.set(parsed.channel, parsed.sequence);
      }

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

      try {
        for (const handler of handlers) {
          handler(parsed.data, parsed.sequence);
        }
      } catch (error) {
        if (error instanceof Error) {
          this.connectionSpan?.recordException(error);
        }
        throw error;
      } finally {
        this.connectionSpan?.addEvent("push.handlers_completed", {
          "orka.channel": parsed.channel,
          "orka.sequence": parsed.sequence,
          "orka.duration_ms": Math.max(0, now() - handledStartedAt),
          "orka.handler_count": handlers.size,
        });
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
    const completedAt = Date.now();
    const duration = Math.max(0, completedAt - (pending.sentAt ?? pending.createdAt));

    if (parsed.error) {
      const error = new Error(parsed.error.message ?? `Request failed: ${pending.method}`);
      this.recordRpcCompletion(pending, duration, false, completedAt);
      finishDashboardSpan(pending.span, pending.startedAt, "error", error);
      pending.reject(error);
      return;
    }

    this.recordRpcCompletion(pending, duration, true, completedAt);
    finishDashboardSpan(pending.span, pending.startedAt, "ok");
    pending.resolve(parsed.result);
  }

  private handleClose(): void {
    for (const [id, pending] of this.pending) {
      if (!pending.sent) {
        continue;
      }

      clearTimeout(pending.timer);
      this.pending.delete(id);
      const error = new Error("Connection closed");
      this.recordRpcCompletion(pending, Date.now() - (pending.sentAt ?? pending.createdAt), false);
      finishDashboardSpan(pending.span, pending.startedAt, "disconnected", error);
      pending.reject(error);
    }

    if (!this.shouldReconnect) {
      this.endConnectionSpan("closed");
      this.setState("disconnected");
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    const delay = Math.min(this.reconnectDelay, this.options?.maxReconnectDelay ?? 8_000);
    this.connectionSpan?.addEvent("ws.reconnecting", {
      "orka.reconnect.delay_ms": delay,
    });
    this.endConnectionSpan("reconnecting");
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
      pending.sentAt ??= Date.now();
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
      this.recordRpcCompletion(pending, Date.now() - (pending.sentAt ?? pending.createdAt), false);
      finishDashboardSpan(pending.span, pending.startedAt, "error", error);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private recordRpcCompletion(
    pending: PendingRequest,
    duration: number,
    ok: boolean,
    timestamp = Date.now(),
  ): void {
    rpcLatencyStore.onRpcComplete({
      method: pending.method,
      duration: Math.max(0, duration),
      ok,
      timestamp,
    });
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

  private beginConnectionSpan(): void {
    this.endConnectionSpan("replaced");
    const { span, startedAt } = startDashboardSpan("orka.dashboard.ws", {
      "orka.transport.url": this.url,
    });
    this.connectionSpan = span;
    this.connectionStartedAt = startedAt;
    this.connectionSpan.addEvent("ws.connecting");
  }

  private endConnectionSpan(status: string): void {
    if (!this.connectionSpan) {
      return;
    }

    this.connectionSpan.setAttribute("orka.status", status);
    this.connectionSpan.setAttribute("orka.duration_ms", Math.max(0, now() - this.connectionStartedAt));
    this.connectionSpan.end();
    this.connectionSpan = null;
    this.connectionStartedAt = 0;
  }

  private extractRequestId(payload: string): number | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return null;
    }

    if (!this.isRpcRequestEnvelope(parsed)) {
      return null;
    }

    return this.normalizeId(parsed.id);
  }

  private normalizeId(id: number | string | null): number | null {
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

  private isRpcRequestEnvelope(value: unknown): value is RpcRequest {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Partial<RpcRequest>;
    return (
      candidate.jsonrpc === "2.0" &&
      (typeof candidate.id === "number" || typeof candidate.id === "string") &&
      typeof candidate.method === "string"
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
