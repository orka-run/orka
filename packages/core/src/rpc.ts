// JSON-RPC 2.0 over WebSocket — envelope types for orka daemon ↔ CLI

export interface RpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: any;
  /** Routing hint for relay — ignored by direct server. */
  node?: string;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: any;
  error?: RpcError;
}

export interface RpcError {
  code: number;
  message: string;
  data?: any;
}

// Standard JSON-RPC error codes
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;
// Application error codes (positive)
export const RPC_NOT_FOUND = 404;
export const RPC_CONFLICT = 409;
