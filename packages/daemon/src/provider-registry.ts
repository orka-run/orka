import type { BackendKind, ProviderAdapter } from "@orka/core";
import { withSpanSync } from "./tracing";

export class ProviderAdapterRegistry {
  private adapters = new Map<BackendKind, ProviderAdapter>();

  register(kind: BackendKind, adapter: ProviderAdapter): void {
    withSpanSync("orka.provider.register", { "orka.backend": kind }, () => {
      if (adapter.kind !== kind) {
        throw new Error(`Provider adapter kind mismatch: expected "${kind}", received "${adapter.kind}"`);
      }

      this.adapters.set(kind, adapter);
    });
  }

  get(kind: BackendKind): ProviderAdapter {
    return withSpanSync("orka.provider.get", { "orka.backend": kind }, () => {
      const adapter = this.adapters.get(kind);
      if (!adapter) {
        throw new Error(`No provider adapter registered for backend "${kind}"`);
      }

      return adapter;
    });
  }

  has(kind: BackendKind): boolean {
    return withSpanSync("orka.provider.has", { "orka.backend": kind }, () => this.adapters.has(kind));
  }

  list(): BackendKind[] {
    return withSpanSync("orka.provider.list", {}, () => Array.from(this.adapters.keys()));
  }
}
