import { OrkaClient, type RequestOptions } from "@orka/client";

export class RpcClient extends OrkaClient {
  retrySession(sessionId: string, options?: RequestOptions): Promise<void> {
    return this.request("retrySession", { sessionId }, options);
  }

  reportClientError(report: unknown, options?: RequestOptions): Promise<void> {
    return this.request("reportClientError", report, options);
  }
}
