import type { WsTransport } from "@orka/client";
import { RpcClient } from "./rpcClient";

declare const transport: WsTransport;

const client = new RpcClient(transport);
type HasStopSession = RpcClient extends { stopSession: unknown } ? true : false;
type HasRetrySession = RpcClient extends { retrySession: unknown } ? true : false;

void client.stop("sess-123");
const hasStopSession: HasStopSession = false;
const hasRetrySession: HasRetrySession = false;
void hasStopSession;
void hasRetrySession;
