// Re-export WsTransport from @orka/client with dashboard-specific defaults.
import { WsTransport, type WsTransportOptions } from "@orka/client";
import { rpcLatencyStore } from "./rpcLatencyStore";

export function createDashboardTransport(url: string, options?: WsTransportOptions): WsTransport {
  return new WsTransport(url, {
    ...options,
    onRpcComplete: options?.onRpcComplete ?? rpcLatencyStore.onRpcComplete,
  });
}

export { WsTransport };

export type {
  RpcCompletionInfo,
  PushDataTransform,
  PushHandler,
  ConnectionState,
  ConnectionStatusSnapshot,
  ProtocolMismatchKind,
  ProtocolMismatchInfo,
  ProtocolMismatchHandler,
  NoiseConfig,
  RequestOptions,
  WsTransportOptions,
} from "@orka/client";
