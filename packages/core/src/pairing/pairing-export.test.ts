import { describe, expect, test } from "bun:test";

describe("pairing module exports", () => {
  test("PairingClient is importable from @orka/core/pairing", async () => {
    const mod = await import("@orka/core/pairing");
    expect(typeof mod.PairingClient).toBe("function");
  });

  test("PairingClient can be constructed", async () => {
    const { PairingClient } = await import("@orka/core/pairing");
    const secret = new Uint8Array(10);
    const client = new PairingClient({
      secret,
      relayOrigin: "wss://relay.example.com",
      onSend: () => {},
    });
    expect(client.state).toBe("INIT");
    expect(client.completed).toBe(false);
    expect(typeof client.enrollId).toBe("string");
  });
});
