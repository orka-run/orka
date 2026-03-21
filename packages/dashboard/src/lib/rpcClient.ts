import { OrkaClient, type RequestOptions } from "@orka/client";
import type { RpcParams } from "@orka/core";

export class RpcClient extends OrkaClient {
  reportClientError(report: RpcParams<"reportClientError">, options?: RequestOptions): Promise<void> {
    return this.request("reportClientError", report, options);
  }

  retrySession(sessionId: string, options?: RequestOptions): Promise<void> {
    // "spawn" is not a typed RPC method on OrkaClient, so cast through unknown
    return (this.request as (method: string, params: unknown, options?: RequestOptions) => Promise<void>)(
      "spawn", { sessionId }, options,
    );
  }
}
