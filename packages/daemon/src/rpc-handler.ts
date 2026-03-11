import type { OrkaService, RpcRequest, RpcResponse } from "@orka/core";
import { RPC_METHOD_NOT_FOUND, RPC_INTERNAL_ERROR, RPC_PARSE_ERROR } from "@orka/core";

/**
 * Dispatch a JSON-RPC request to the OrkaService implementation.
 * Returns a JSON-RPC response. Never throws.
 */
export async function handleRpcRequest(
  svc: OrkaService,
  raw: string,
): Promise<string> {
  let req: RpcRequest;
  try {
    req = JSON.parse(raw);
  } catch {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: RPC_PARSE_ERROR, message: "Parse error" },
    });
  }

  const id = req.id;
  try {
    const result = await dispatch(svc, req.method, req.params ?? {});
    return JSON.stringify({ jsonrpc: "2.0", id, result } as RpcResponse);
  } catch (e: any) {
    const code = e.rpcCode ?? RPC_INTERNAL_ERROR;
    return JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message: e.message },
    } as RpcResponse);
  }
}

async function dispatch(svc: OrkaService, method: string, params: any): Promise<any> {
  switch (method) {
    case "spawn":
      return svc.spawn(params);
    case "stop":
      return svc.stop(params.sessionId);
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
    case "deleteSessions":
      svc.deleteSessions(params.ids);
      return null;
    case "pruneSessions":
      return svc.pruneSessions(params);
    default: {
      const err = new Error(`Method not found: ${method}`);
      (err as any).rpcCode = RPC_METHOD_NOT_FOUND;
      throw err;
    }
  }
}
