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
  WsTransportOptions,
} from "./ws-transport";

export { ReconnectStrategy } from "./reconnect";

export { driveNoiseHandshake } from "./noise-handshake";
export type { NoiseHandshakeOptions } from "./noise-handshake";

export { appendAuthToken } from "./auth";

export { loadKnownHosts, saveKnownHost, lookupKnownHost } from "./known-hosts";
export type { KnownHostEntry } from "./known-hosts";
