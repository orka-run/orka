import { createContext, useContext } from "react";
import type { WsTransport } from "./wsTransport";

export const TransportContext = createContext<WsTransport | null>(null);

export function useTransport(): WsTransport {
  const transport = useContext(TransportContext);
  if (!transport) {
    throw new Error("useTransport must be used within a TransportContext.Provider");
  }
  return transport;
}
