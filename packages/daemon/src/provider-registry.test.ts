import { describe, expect, test } from "bun:test";
import type { ProviderAdapter, ProviderRuntimeEvent } from "@orka/core";
import { ProviderAdapterRegistry } from "./provider-registry";

function createEvents(): AsyncIterable<ProviderRuntimeEvent> {
  return (async function* () {})();
}

function createAdapter(kind: ProviderAdapter["kind"]): ProviderAdapter {
  return {
    kind,
    async startSession(input) {
      return {
        threadId: input.threadId,
        provider: kind,
        events: createEvents(),
        meta: {},
      };
    },
    async sendTurn(_handle, _input) {},
    async interruptTurn(_handle) {},
    async stopSession(_handle) {},
    async respondToRequest(_handle, _requestId, _decision) {},
  };
}

describe("ProviderAdapterRegistry", () => {
  test("registers and returns adapters by backend kind", () => {
    const registry = new ProviderAdapterRegistry();
    const adapter = createAdapter("codex");

    registry.register("codex", adapter);

    expect(registry.has("codex")).toBe(true);
    expect(registry.get("codex")).toBe(adapter);
  });

  test("lists registered backends in insertion order", () => {
    const registry = new ProviderAdapterRegistry();

    registry.register("claude-code", createAdapter("claude-code"));
    registry.register("codex", createAdapter("codex"));

    expect(registry.list()).toEqual(["claude-code", "codex"]);
  });

  test("throws when adapter kind does not match registration key", () => {
    const registry = new ProviderAdapterRegistry();

    expect(() => registry.register("claude-code", createAdapter("codex"))).toThrow(
      'Provider adapter kind mismatch: expected "claude-code", received "codex"',
    );
  });

  test("throws when backend is missing", () => {
    const registry = new ProviderAdapterRegistry();

    expect(() => registry.get("claude-code")).toThrow(
      'No provider adapter registered for backend "claude-code"',
    );
  });
});
