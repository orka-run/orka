import { createContext, useContext } from "react";
import type { WsTransport } from "./wsTransport";
import type { RpcClient } from "./rpcClient";

export const TransportContext = createContext<WsTransport | null>(null);
export const RpcClientContext = createContext<RpcClient | null>(null);

export function useTransport(): WsTransport {
  const transport = useContext(TransportContext);
  if (!transport) {
    throw new Error("useTransport must be used within a TransportContext.Provider");
  }
  return transport;
}

export function useRpcClient(): RpcClient {
  const client = useContext(RpcClientContext);
  if (!client) {
    throw new Error("useRpcClient must be used within a RpcClientContext.Provider");
  }
  return client;
}
