import type { OrkaService, RpcRequest, RpcResponse } from "@orka/core";
import { RPC_METHOD_NOT_FOUND, RPC_INTERNAL_ERROR, RPC_PARSE_ERROR } from "@orka/core";
import { decryptRequest, encryptResponse } from "@orka/core";
import { pushHub } from "./push";
import { withSpan } from "./tracing";

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
  return withSpan("orka.rpc.handle", { "orka.method": "unknown" }, async (span) => {
    let req: any;
    try {
      req = JSON.parse(raw);
      span.setAttribute("orka.method", req?.method ?? "unknown");
    } catch {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: RPC_PARSE_ERROR, message: "Parse error" },
      });
    }

    const id = req.id;
    const isEncrypted = !!req._enc;

    // Decrypt request if encrypted
    if (isEncrypted && encKey) {
      try {
        req = decryptRequest(encKey, req);
        span.setAttribute("orka.method", req?.method ?? "unknown");
      } catch {
        return JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: RPC_PARSE_ERROR, message: "E2E decryption failed" },
        });
      }
    }

    try {
      const result = await dispatch(svc, req.method, req.params ?? {});
      let response: any = { jsonrpc: "2.0", id, result };

      // Encrypt response if request was encrypted
      if (isEncrypted && encKey) {
        response = encryptResponse(encKey, response);
      }

      return JSON.stringify(response);
    } catch (e: any) {
      const code = e.rpcCode ?? RPC_INTERNAL_ERROR;
      return JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code, message: e.message },
      } as RpcResponse);
    }
  });
}

async function dispatch(svc: OrkaService, method: string, params: any): Promise<any> {
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
    case "getUsage":
      return svc.getUsage(params);
    case "captureOutput":
      return svc.captureOutput(params.sessionId);
    case "getLogContent":
      return svc.getLogContent(params.sessionId);
    case "isAlive":
      return svc.isAlive(params.sessionId);
    case "sendInput":
      await svc.sendInput(params.sessionId, params.text);
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
    case "getPendingApprovals":
      return svc.getPendingApprovals(params.sessionId);
    case "resolveApproval":
      await svc.resolveApproval(params.requestId, params.decision);
      return null;
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
    default: {
      const err = new Error(`Method not found: ${method}`);
      (err as any).rpcCode = RPC_METHOD_NOT_FOUND;
      throw err;
    }
  }
}
