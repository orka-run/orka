import { OrkaClient, type RequestOptions } from "@orka/client";
import type { RpcParams } from "@orka/core";

export class RpcClient extends OrkaClient {
  reportClientError(report: RpcParams<"reportClientError">, options?: RequestOptions): Promise<void> {
    return this.request("reportClientError", report, options);
  }
}
