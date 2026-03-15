export { createOrkaClient } from "./orka-client";
export type { OrkaClientOptions } from "./orka-client";

export { WsTransport } from "./ws-transport";
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
} from "./ws-transport";

export { ReconnectStrategy } from "./reconnect";

export { driveNoiseHandshake } from "./noise-handshake";
export type { NoiseHandshakeOptions } from "./noise-handshake";

export { appendAuthToken } from "./auth";

// known-hosts uses node:fs/node:path — import directly from "@orka/client/known-hosts" in Node.js contexts
// NOT re-exported here to keep the barrel browser-safe
