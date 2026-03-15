// Re-export WsTransport from @orka/client with dashboard-specific rpcLatencyStore integration.
import { WsTransport as ClientWsTransport, type WsTransportOptions } from "@orka/client";
import { rpcLatencyStore } from "./rpcLatencyStore";

export class WsTransport extends ClientWsTransport {
  constructor(url: string, options?: WsTransportOptions) {
    super(url, {
      ...options,
      onRpcComplete: options?.onRpcComplete ?? rpcLatencyStore.onRpcComplete,
    });
  }
}

export type {
  RpcCompletionInfo,
  PushDataTransform,
  PushHandler,
  ConnectionState,
  ConnectionStatusSnapshot,
  ProtocolMismatchKind,
  ProtocolMismatchInfo,
  ProtocolMismatchHandler,
  WsTransportOptions,
} from "@orka/client";
