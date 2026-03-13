import { ROOT_CONTEXT, propagation, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import type { OrkaService, RpcRequest, RpcResponse } from "@orka/core";
import { RPC_METHOD_NOT_FOUND, RPC_INTERNAL_ERROR, RPC_PARSE_ERROR, RPC_INVALID_REQUEST } from "@orka/core";
import { decryptRequest, encryptResponse } from "@orka/core/crypto";
import { pushHub } from "./push";
import { insertClientError, listClientErrors } from "./db";
import { getDaemonMetrics, getTracer, queryTraceLog, withSpan } from "./tracing";

const SLOW_RPC_THRESHOLD_MS = 1_000;

/**
 * Dispatch a JSON-RPC request to the OrkaService implementation.
 * Supports E2E encrypted payloads when encKey is provided.
 * Returns a JSON-RPC response string. Never throws.
 */
export async function handleRpcRequest(
  svc: OrkaService,
  raw: string,
  encKey?: Buffer | null,
): Promise<string> {
  const requestStartedAt = performance.now();
  let req: RpcRequest & { _enc?: unknown };
  try {
    req = JSON.parse(raw);
  } catch {
    recordRpcMetrics("unknown", performance.now() - requestStartedAt, true);
    return JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: RPC_PARSE_ERROR, message: "Parse error" },
    });
  }

  // Validate JSON-RPC 2.0 envelope before dispatch
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    recordRpcMetrics("unknown", performance.now() - requestStartedAt, true);
    return JSON.stringify({
      jsonrpc: "2.0",
      id: req.id ?? null,
      error: { code: RPC_INVALID_REQUEST, message: "Invalid Request: missing jsonrpc 2.0 or method" },
    });
  }

  const parentContext =
    typeof req.traceparent === "string" && req.traceparent.trim() !== ""
      ? propagation.extract(ROOT_CONTEXT, { traceparent: req.traceparent })
      : ROOT_CONTEXT;

  const tracer = getTracer();
  return tracer.startActiveSpan(
    "orka.rpc.handle",
    {
      attributes: {
        "orka.method": req.method ?? "unknown",
      },
    },
    parentContext,
    async (span) => {
      const id = req.id;
      const isEncrypted = !!req._enc;
      addPayloadEvent(span, "rpc.deserialize", raw);
      let method = req.method ?? "unknown";
      let isError = false;

      if (isEncrypted && encKey) {
        try {
          req = decryptRequest(encKey, req);
          method = req?.method ?? "unknown";
          span.setAttribute("orka.method", method);
        } catch {
          isError = true;
          span.setStatus({ code: SpanStatusCode.ERROR, message: "E2E decryption failed" });
          return serializeRpcResponse(span, {
            jsonrpc: "2.0",
            id,
            error: { code: RPC_PARSE_ERROR, message: "E2E decryption failed" },
          });
        }
      }

      try {
        const result = await dispatch(svc, req.method, req.params ?? {}, trace.setSpan(parentContext, span));
        let response: any = { jsonrpc: "2.0", id, result };

        if (isEncrypted && encKey) {
          response = encryptResponse(encKey, response);
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return serializeRpcResponse(span, response);
      } catch (error: any) {
        isError = true;
        const code = error.rpcCode ?? RPC_INTERNAL_ERROR;
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        span.recordException(error);
        return serializeRpcResponse(span, {
          jsonrpc: "2.0",
          id,
          error: { code, message: error.message },
        } as RpcResponse);
      } finally {
        const durationMs = performance.now() - requestStartedAt;
        applyRpcTiming(span, durationMs);
        recordRpcMetrics(method, durationMs, isError);
        span.end();
      }
    },
  );
}

async function dispatch(svc: OrkaService, method: string, params: any, parentContext = ROOT_CONTEXT): Promise<any> {
  return withSpan("orka.rpc.dispatch", { "orka.method": method }, async (span) => {
    const startedAt = performance.now();
    try {
      return await (async () => {
        switch (method) {
          case "spawn": {
            const session = await svc.spawn(params);
            // Keep these RPC-triggered broadcasts for tmux-backed sessions until all session types
            // are driven exclusively by orchestration engine events.
            pushHub.broadcast("orchestration.sessionUpdated", {
              sessionId: session.id,
              status: session.status,
            });
            return session;
          }
          case "stop": {
            await svc.stop(params.sessionId);
            const session = await svc.getSession(params.sessionId);
            if (session) {
              // Provider runtime sessions also emit through the orchestration engine, but tmux-backed
              // sessions still rely on this direct push.
              pushHub.broadcast("orchestration.sessionUpdated", {
                sessionId: session.id,
                status: session.status,
              });
            }
            return null;
          }
          case "reap":
            return svc.reap();
          case "getSession":
            return svc.getSession(params.id);
          case "listSessions":
            return svc.listSessions(params.filters);
          case "getChildSessions":
            return svc.getChildSessions(params.sessionId);
          case "getTask":
            return svc.getTask(params.id);
          case "setKept":
            svc.setKept(params.sessionId, params.kept);
            return null;
          case "getTags":
            return svc.getTags(params.sessionId);
          case "getResult":
            return svc.getResult(params.sessionId);
          case "getSessionTimeline":
            return svc.getSessionTimeline(params.sessionId);
          case "getChatMessages":
            return svc.getChatMessages(params.sessionId);
          case "getUsage":
            return svc.getUsage(params);
          case "captureOutput":
            return svc.captureOutput(params.sessionId);
          case "getLogContent":
            return svc.getLogContent(params.sessionId);
          case "isAlive":
            return svc.isAlive(params.sessionId);
          case "sendTurn":
            await svc.sendTurn(params.sessionId, params.text);
            return null;
          case "getDiff":
            return svc.getDiff(params.sessionId);
          case "merge":
            return svc.merge(params.sessionId, params.cleanup);
          case "deleteSessions": {
            const ids: string[] = params.ids;
            await svc.deleteSessions(ids);
            for (const id of ids) {
              // Keep the direct delete push until tmux-backed sessions are migrated to engine events.
              pushHub.broadcast("orchestration.sessionDeleted", { sessionId: id });
            }
            return null;
          }
          case "pruneSessions":
            return svc.pruneSessions({
              maxAgeMs: params.maxAgeMs,
              projectPath: params.projectPath,
              confirm: params.confirm,
              purgeLogs: params.purgeLogs,
              purgeDb: params.purgeDb,
            });
          case "archiveSession":
            await svc.archiveSession(params.sessionId);
            pushHub.broadcast("orchestration.sessionUpdated", { sessionId: params.sessionId, status: "archived" });
            return null;
          case "unarchiveSession": {
            await svc.unarchiveSession(params.sessionId);
            const unarchivedSession = await svc.getSession(params.sessionId);
            pushHub.broadcast("orchestration.sessionUpdated", {
              sessionId: params.sessionId,
              status: unarchivedSession?.status ?? "completed",
            });
            return null;
          }
          case "getPendingApprovals":
            return svc.getPendingApprovals(params.sessionId);
          case "resolveApproval":
            await svc.resolveApproval(params.requestId, params.decision);
            return null;
          case "reportEventGap":
            return withSpan(
              "orka.push.delivery_gap",
              {
                "orka.channel": params.channel,
                "orka.expected_sequence": params.expectedSeq,
                "orka.got_sequence": params.gotSeq,
              },
              async () => {
                await svc.reportEventGap(params.channel, params.expectedSeq, params.gotSeq);
                return null;
              },
            );
          case "terminalOpen":
            return svc.terminalOpen(params.sessionId, params.opts);
          case "terminalWrite":
            await svc.terminalWrite(params.termId, params.data);
            return null;
          case "terminalResize":
            await svc.terminalResize(params.termId, params.cols, params.rows);
            return null;
          case "terminalClose":
            await svc.terminalClose(params.termId);
            return null;
          case "terminalList":
            return svc.terminalList(params.sessionId);
          case "backfillSession":
            return svc.backfillSession(params.sessionId);
          case "reportClientError":
            insertClientError({
              error: params.error ?? "unknown",
              stack: params.stack,
              url: params.url ?? "",
              timestamp: params.timestamp ?? new Date().toISOString(),
            });
            return null;
          case "listClientErrors":
            return listClientErrors(params.limit ?? 50);
          case "getMetrics":
            return svc.getMetrics();
          case "queryTraces":
            return queryTraceLog({
              service: params.service,
              errorsOnly: params.errorsOnly,
              namePattern: params.namePattern,
              limit: params.limit,
              since: params.since,
            });
          default: {
            const err = new Error(`Method not found: ${method}`);
            (err as any).rpcCode = RPC_METHOD_NOT_FOUND;
            throw err;
          }
        }
      })();
    } finally {
      applyRpcTiming(span, performance.now() - startedAt);
    }
  }, parentContext);
}

function serializeRpcResponse(span: Span, response: RpcResponse | Record<string, unknown>): string {
  const payload = JSON.stringify(response);
  addPayloadEvent(span, "rpc.serialize", payload);
  return payload;
}

function addPayloadEvent(span: Span, name: string, payload: string): void {
  const size = Buffer.byteLength(payload, "utf8");
  span.addEvent(name, { size, "orka.rpc.size_bytes": size });
}

function applyRpcTiming(span: Span, durationMs: number): void {
  span.setAttribute("orka.rpc.duration_ms", durationMs);
  if (durationMs > SLOW_RPC_THRESHOLD_MS) {
    span.setAttribute("orka.rpc.slow", true);
    span.addEvent("rpc.warning", {
      severity: "warning",
      "orka.rpc.duration_ms": durationMs,
      "orka.rpc.slow_threshold_ms": SLOW_RPC_THRESHOLD_MS,
    });
  }
}

function recordRpcMetrics(method: string, durationMs: number, isError: boolean): void {
  const attributes = { method };
  const metrics = getDaemonMetrics();
  metrics.rpcRequests.add(1, attributes);
  if (isError) {
    metrics.rpcErrors.add(1, attributes);
  }
  metrics.rpcDuration.record(durationMs, attributes);
}
