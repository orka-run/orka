import { OrkaClient, type RequestOptions } from "@orka/client";

export class RpcClient extends OrkaClient {
  reportClientError(report: unknown, options?: RequestOptions): Promise<void> {
    return this.request("reportClientError", report, options);
  }
}
