import { describe, test, expect } from "bun:test";
import {
  PairClientHelloSchema,
  PairServerHelloSchema,
  PairInitSchema,
  PairRespSchema,
  PairConfirm1Schema,
  PairConfirm2Schema,
  PairBootstrapSchema,
  PairBootstrapPayloadSchema,
  PairDoneSchema,
  PairErrorSchema,
  PairMessageSchema,
  computePairContext,
  computePairAad,
  PAIR_SUITE,
  PAIR_PROTOCOL_PREFIX,
  type PairClientHello,
  type PairServerHello,
} from "./pairing-protocol";
import { canonicalJson } from "./crypto/canonical-json";

const enc = new TextEncoder();

// --- Test fixtures ---

const validClientHello: PairClientHello = {
  t: "pair_client_hello",
  v: 1,
  pair_suites: [PAIR_SUITE],
  client_instance_id: "dGVzdC1pbnN0YW5jZS1pZA",
  features: ["fast-forward"],
};

const validServerHello: PairServerHello = {
  t: "pair_server_hello",
  v: 1,
  pair_suite: PAIR_SUITE,
  enroll_id: "ZW5yb2xsLWlk",
  expires_in_sec: 300,
  features: [],
};

// --- Schema validation ---

describe("PairClientHelloSchema", () => {
  test("validates correct input", () => {
    const result = PairClientHelloSchema.safeParse(validClientHello);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.t).toBe("pair_client_hello");
      expect(result.data.v).toBe(1);
      expect(result.data.pair_suites).toEqual([PAIR_SUITE]);
      expect(result.data.client_instance_id).toBe("dGVzdC1pbnN0YW5jZS1pZA");
      expect(result.data.features).toEqual(["fast-forward"]);
    }
  });

  test("rejects missing fields", () => {
    expect(PairClientHelloSchema.safeParse({ t: "pair_client_hello" }).success).toBe(false);
    expect(PairClientHelloSchema.safeParse({ t: "pair_client_hello", v: 1 }).success).toBe(false);
    expect(
      PairClientHelloSchema.safeParse({
        t: "pair_client_hello",
        v: 1,
        pair_suites: [PAIR_SUITE],
      }).success,
    ).toBe(false);
  });

  test("rejects wrong type for t", () => {
    expect(
      PairClientHelloSchema.safeParse({ ...validClientHello, t: "pair_server_hello" }).success,
    ).toBe(false);
  });

  test("rejects wrong version", () => {
    expect(PairClientHelloSchema.safeParse({ ...validClientHello, v: 2 }).success).toBe(false);
  });

  test("rejects wrong field types", () => {
    expect(
      PairClientHelloSchema.safeParse({ ...validClientHello, pair_suites: "not-an-array" })
        .success,
    ).toBe(false);
    expect(
      PairClientHelloSchema.safeParse({ ...validClientHello, client_instance_id: 123 }).success,
    ).toBe(false);
    expect(
      PairClientHelloSchema.safeParse({ ...validClientHello, features: "not-an-array" }).success,
    ).toBe(false);
  });

  test("accepts empty arrays for pair_suites and features", () => {
    const result = PairClientHelloSchema.safeParse({
      ...validClientHello,
      pair_suites: [],
      features: [],
    });
    expect(result.success).toBe(true);
  });
});

describe("PairServerHelloSchema", () => {
  test("validates correct input", () => {
    const result = PairServerHelloSchema.safeParse(validServerHello);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.t).toBe("pair_server_hello");
      expect(result.data.pair_suite).toBe(PAIR_SUITE);
      expect(result.data.enroll_id).toBe("ZW5yb2xsLWlk");
      expect(result.data.expires_in_sec).toBe(300);
    }
  });

  test("rejects missing fields", () => {
    expect(PairServerHelloSchema.safeParse({ t: "pair_server_hello" }).success).toBe(false);
    expect(
      PairServerHelloSchema.safeParse({ t: "pair_server_hello", v: 1, pair_suite: PAIR_SUITE })
        .success,
    ).toBe(false);
  });

  test("rejects wrong type for t", () => {
    expect(
      PairServerHelloSchema.safeParse({ ...validServerHello, t: "pair_client_hello" }).success,
    ).toBe(false);
  });

  test("rejects wrong field types", () => {
    expect(
      PairServerHelloSchema.safeParse({ ...validServerHello, expires_in_sec: "300" }).success,
    ).toBe(false);
    expect(
      PairServerHelloSchema.safeParse({ ...validServerHello, features: "not-an-array" }).success,
    ).toBe(false);
  });
});

describe("PairInitSchema", () => {
  test("validates correct input", () => {
    const result = PairInitSchema.safeParse({ t: "pair_init", pA: "c3Bha2UyLXB1YmxpYy12YWx1ZQ" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.t).toBe("pair_init");
      expect(result.data.pA).toBe("c3Bha2UyLXB1YmxpYy12YWx1ZQ");
    }
  });

  test("rejects missing pA", () => {
    expect(PairInitSchema.safeParse({ t: "pair_init" }).success).toBe(false);
  });

  test("rejects wrong type", () => {
    expect(PairInitSchema.safeParse({ t: "pair_init", pA: 123 }).success).toBe(false);
  });
});

describe("PairRespSchema", () => {
  test("validates correct input", () => {
    const result = PairRespSchema.safeParse({ t: "pair_resp", pB: "c3Bha2UyLXJlc3BvbnNl" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pB).toBe("c3Bha2UyLXJlc3BvbnNl");
    }
  });

  test("rejects missing pB", () => {
    expect(PairRespSchema.safeParse({ t: "pair_resp" }).success).toBe(false);
  });

  test("rejects wrong type", () => {
    expect(PairRespSchema.safeParse({ t: "pair_resp", pB: 42 }).success).toBe(false);
  });
});

describe("PairConfirm1Schema", () => {
  test("validates correct input", () => {
    const result = PairConfirm1Schema.safeParse({ t: "pair_confirm1", mac: "bWFjLXZhbHVl" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mac).toBe("bWFjLXZhbHVl");
    }
  });

  test("rejects missing mac", () => {
    expect(PairConfirm1Schema.safeParse({ t: "pair_confirm1" }).success).toBe(false);
  });
});

describe("PairConfirm2Schema", () => {
  test("validates correct input", () => {
    const result = PairConfirm2Schema.safeParse({ t: "pair_confirm2", mac: "bWFjLXZhbHVl" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mac).toBe("bWFjLXZhbHVl");
    }
  });

  test("rejects missing mac", () => {
    expect(PairConfirm2Schema.safeParse({ t: "pair_confirm2" }).success).toBe(false);
  });
});

describe("PairBootstrapSchema", () => {
  test("validates correct input", () => {
    const result = PairBootstrapSchema.safeParse({
      t: "pair_bootstrap",
      ct: "ZW5jcnlwdGVkLXBheWxvYWQ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ct).toBe("ZW5jcnlwdGVkLXBheWxvYWQ");
    }
  });

  test("rejects missing ct", () => {
    expect(PairBootstrapSchema.safeParse({ t: "pair_bootstrap" }).success).toBe(false);
  });
});

describe("PairBootstrapPayloadSchema", () => {
  test("validates correct payload structure", () => {
    const payload = {
      node_id: "node-1",
      node_name: "My Node",
      noise_suite: "Noise_NK_25519_ChaChaPoly_SHA256",
      noise_static_pubkey: "cHVia2V5LTMyLWJ5dGVz",
      noise_key_id: "sha256:abc123",
      node_paths: ["ws://relay.example.com:7390/ws"],
      rpc: ["jsonrpc-2.0"],
    };

    const result = PairBootstrapPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.node_id).toBe("node-1");
      expect(result.data.node_name).toBe("My Node");
      expect(result.data.noise_suite).toBe("Noise_NK_25519_ChaChaPoly_SHA256");
      expect(result.data.noise_static_pubkey).toBe("cHVia2V5LTMyLWJ5dGVz");
      expect(result.data.noise_key_id).toBe("sha256:abc123");
      expect(result.data.node_paths).toEqual(["ws://relay.example.com:7390/ws"]);
      expect(result.data.rpc).toEqual(["jsonrpc-2.0"]);
    }
  });

  test("rejects missing required fields", () => {
    expect(PairBootstrapPayloadSchema.safeParse({}).success).toBe(false);
    expect(
      PairBootstrapPayloadSchema.safeParse({ node_id: "x", node_name: "y" }).success,
    ).toBe(false);
  });

  test("rejects wrong field types", () => {
    expect(
      PairBootstrapPayloadSchema.safeParse({
        node_id: 123,
        node_name: "x",
        noise_suite: "x",
        noise_static_pubkey: "x",
        noise_key_id: "x",
        node_paths: "not-array",
        rpc: ["jsonrpc-2.0"],
      }).success,
    ).toBe(false);
  });
});

describe("PairDoneSchema", () => {
  test("validates correct input", () => {
    const result = PairDoneSchema.safeParse({ t: "pair_done" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.t).toBe("pair_done");
    }
  });

  test("rejects wrong type value", () => {
    expect(PairDoneSchema.safeParse({ t: "pair_error" }).success).toBe(false);
  });
});

describe("PairErrorSchema", () => {
  test("all error codes are accepted", () => {
    const codes = [
      "expired",
      "not_found",
      "attempts_exhausted",
      "bad_version",
      "bad_suite",
      "protocol_error",
    ] as const;

    for (const code of codes) {
      const result = PairErrorSchema.safeParse({ t: "pair_error", code });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.code).toBe(code);
      }
    }
  });

  test("rejects unknown error codes", () => {
    expect(
      PairErrorSchema.safeParse({ t: "pair_error", code: "unknown_code" }).success,
    ).toBe(false);
  });

  test("rejects missing code", () => {
    expect(PairErrorSchema.safeParse({ t: "pair_error" }).success).toBe(false);
  });
});

// --- Discriminated union ---

describe("PairMessageSchema", () => {
  test("correctly identifies pair_client_hello", () => {
    const result = PairMessageSchema.safeParse(validClientHello);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.t).toBe("pair_client_hello");
    }
  });

  test("correctly identifies pair_server_hello", () => {
    const result = PairMessageSchema.safeParse(validServerHello);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.t).toBe("pair_server_hello");
    }
  });

  test("correctly identifies pair_init", () => {
    const result = PairMessageSchema.safeParse({ t: "pair_init", pA: "dGVzdA" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.t).toBe("pair_init");
    }
  });

  test("correctly identifies pair_resp", () => {
    const result = PairMessageSchema.safeParse({ t: "pair_resp", pB: "dGVzdA" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.t).toBe("pair_resp");
    }
  });

  test("correctly identifies pair_confirm1", () => {
    const result = PairMessageSchema.safeParse({ t: "pair_confirm1", mac: "dGVzdA" });
    expect(result.success).toBe(true);
  });

  test("correctly identifies pair_confirm2", () => {
    const result = PairMessageSchema.safeParse({ t: "pair_confirm2", mac: "dGVzdA" });
    expect(result.success).toBe(true);
  });

  test("correctly identifies pair_bootstrap", () => {
    const result = PairMessageSchema.safeParse({ t: "pair_bootstrap", ct: "dGVzdA" });
    expect(result.success).toBe(true);
  });

  test("correctly identifies pair_done", () => {
    const result = PairMessageSchema.safeParse({ t: "pair_done" });
    expect(result.success).toBe(true);
  });

  test("correctly identifies pair_error", () => {
    const result = PairMessageSchema.safeParse({ t: "pair_error", code: "expired" });
    expect(result.success).toBe(true);
  });

  test("rejects unknown message type", () => {
    const result = PairMessageSchema.safeParse({ t: "pair_unknown", data: "x" });
    expect(result.success).toBe(false);
  });

  test("rejects empty object", () => {
    const result = PairMessageSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// --- Derived values ---

describe("computePairContext", () => {
  test("returns concatenation of canonical JSONs", () => {
    const context = computePairContext(validClientHello, validServerHello);

    const expectedClientJson = canonicalJson(validClientHello);
    const expectedServerJson = canonicalJson(validServerHello);
    const expectedBytes = enc.encode(expectedClientJson + expectedServerJson);

    expect(Buffer.from(context).toString("hex")).toBe(
      Buffer.from(expectedBytes).toString("hex"),
    );
  });

  test("different hellos produce different contexts", () => {
    const ctx1 = computePairContext(validClientHello, validServerHello);

    const altClientHello: PairClientHello = {
      ...validClientHello,
      client_instance_id: "YWx0ZXJuYXRlLWlk",
    };
    const ctx2 = computePairContext(altClientHello, validServerHello);

    expect(Buffer.from(ctx1).toString("hex")).not.toBe(
      Buffer.from(ctx2).toString("hex"),
    );
  });

  test("context is deterministic for same inputs", () => {
    const ctx1 = computePairContext(validClientHello, validServerHello);
    const ctx2 = computePairContext(validClientHello, validServerHello);

    expect(Buffer.from(ctx1).toString("hex")).toBe(
      Buffer.from(ctx2).toString("hex"),
    );
  });

  test("key order in objects does not affect output (canonical JSON sorts keys)", () => {
    // Create objects with different key insertion order
    const hello1: PairClientHello = {
      t: "pair_client_hello",
      v: 1,
      pair_suites: [PAIR_SUITE],
      client_instance_id: "aWQ",
      features: [],
    };

    // Same data, constructed differently (object spread reorders)
    const hello2 = {
      features: [] as string[],
      client_instance_id: "aWQ",
      pair_suites: [PAIR_SUITE],
      v: 1 as const,
      t: "pair_client_hello" as const,
    };

    const ctx1 = computePairContext(hello1, validServerHello);
    const ctx2 = computePairContext(hello2, validServerHello);

    expect(Buffer.from(ctx1).toString("hex")).toBe(
      Buffer.from(ctx2).toString("hex"),
    );
  });
});

describe("computePairAad", () => {
  test("returns correct prefix + origin + context", () => {
    const context = computePairContext(validClientHello, validServerHello);
    const relayOrigin = "wss://relay.example.com:7390";
    const aad = computePairAad(relayOrigin, context);

    const expectedPrefix = enc.encode(PAIR_PROTOCOL_PREFIX);
    const expectedOrigin = enc.encode(relayOrigin);
    const expectedTotal = new Uint8Array(
      expectedPrefix.length + expectedOrigin.length + context.length,
    );
    expectedTotal.set(expectedPrefix, 0);
    expectedTotal.set(expectedOrigin, expectedPrefix.length);
    expectedTotal.set(context, expectedPrefix.length + expectedOrigin.length);

    expect(Buffer.from(aad).toString("hex")).toBe(
      Buffer.from(expectedTotal).toString("hex"),
    );
  });

  test("different relay origins produce different AADs", () => {
    const context = computePairContext(validClientHello, validServerHello);

    const aad1 = computePairAad("wss://relay1.example.com", context);
    const aad2 = computePairAad("wss://relay2.example.com", context);

    expect(Buffer.from(aad1).toString("hex")).not.toBe(
      Buffer.from(aad2).toString("hex"),
    );
  });

  test("different contexts produce different AADs", () => {
    const ctx1 = computePairContext(validClientHello, validServerHello);

    const altServerHello: PairServerHello = {
      ...validServerHello,
      enroll_id: "ZGlmZmVyZW50",
    };
    const ctx2 = computePairContext(validClientHello, altServerHello);

    const aad1 = computePairAad("wss://relay.example.com", ctx1);
    const aad2 = computePairAad("wss://relay.example.com", ctx2);

    expect(Buffer.from(aad1).toString("hex")).not.toBe(
      Buffer.from(aad2).toString("hex"),
    );
  });

  test("starts with the protocol prefix bytes", () => {
    const context = computePairContext(validClientHello, validServerHello);
    const aad = computePairAad("wss://relay.example.com", context);

    const prefixBytes = enc.encode(PAIR_PROTOCOL_PREFIX);
    const aadPrefix = aad.slice(0, prefixBytes.length);

    expect(Buffer.from(aadPrefix).toString("hex")).toBe(
      Buffer.from(prefixBytes).toString("hex"),
    );
  });
});

// --- Round-trip tests ---

describe("round-trip serialization", () => {
  test("PairClientHello round-trips through JSON", () => {
    const serialized = JSON.stringify(validClientHello);
    const parsed = PairClientHelloSchema.parse(JSON.parse(serialized));
    expect(parsed).toEqual(validClientHello);
  });

  test("PairServerHello round-trips through JSON", () => {
    const serialized = JSON.stringify(validServerHello);
    const parsed = PairServerHelloSchema.parse(JSON.parse(serialized));
    expect(parsed).toEqual(validServerHello);
  });

  test("PairInit round-trips through JSON", () => {
    const original = { t: "pair_init" as const, pA: "c3Bha2UyLXB1YmxpYy12YWx1ZQ" };
    const serialized = JSON.stringify(original);
    const parsed = PairInitSchema.parse(JSON.parse(serialized));
    expect(parsed).toEqual(original);
  });

  test("PairResp round-trips through JSON", () => {
    const original = { t: "pair_resp" as const, pB: "c3Bha2UyLXJlc3BvbnNl" };
    const serialized = JSON.stringify(original);
    const parsed = PairRespSchema.parse(JSON.parse(serialized));
    expect(parsed).toEqual(original);
  });

  test("PairConfirm1 round-trips through JSON", () => {
    const original = { t: "pair_confirm1" as const, mac: "bWFjLXZhbHVl" };
    const serialized = JSON.stringify(original);
    const parsed = PairConfirm1Schema.parse(JSON.parse(serialized));
    expect(parsed).toEqual(original);
  });

  test("PairConfirm2 round-trips through JSON", () => {
    const original = { t: "pair_confirm2" as const, mac: "bWFjLXZhbHVl" };
    const serialized = JSON.stringify(original);
    const parsed = PairConfirm2Schema.parse(JSON.parse(serialized));
    expect(parsed).toEqual(original);
  });

  test("PairBootstrap round-trips through JSON", () => {
    const original = { t: "pair_bootstrap" as const, ct: "ZW5jcnlwdGVk" };
    const serialized = JSON.stringify(original);
    const parsed = PairBootstrapSchema.parse(JSON.parse(serialized));
    expect(parsed).toEqual(original);
  });

  test("PairDone round-trips through JSON", () => {
    const original = { t: "pair_done" as const };
    const serialized = JSON.stringify(original);
    const parsed = PairDoneSchema.parse(JSON.parse(serialized));
    expect(parsed).toEqual(original);
  });

  test("PairError round-trips through JSON", () => {
    const original = { t: "pair_error" as const, code: "expired" as const };
    const serialized = JSON.stringify(original);
    const parsed = PairErrorSchema.parse(JSON.parse(serialized));
    expect(parsed).toEqual(original);
  });

  test("all message types round-trip through PairMessageSchema", () => {
    const messages = [
      validClientHello,
      validServerHello,
      { t: "pair_init" as const, pA: "dGVzdA" },
      { t: "pair_resp" as const, pB: "dGVzdA" },
      { t: "pair_confirm1" as const, mac: "dGVzdA" },
      { t: "pair_confirm2" as const, mac: "dGVzdA" },
      { t: "pair_bootstrap" as const, ct: "dGVzdA" },
      { t: "pair_done" as const },
      { t: "pair_error" as const, code: "protocol_error" as const },
    ];

    for (const msg of messages) {
      const serialized = JSON.stringify(msg);
      const parsed = PairMessageSchema.parse(JSON.parse(serialized));
      expect(parsed).toEqual(msg);
    }
  });
});

// --- Forward compatibility ---

describe("forward compatibility", () => {
  test("PairClientHello accepts extra fields", () => {
    const result = PairClientHelloSchema.safeParse({
      ...validClientHello,
      future_field: "some-value",
      another_field: 42,
    });
    expect(result.success).toBe(true);
  });

  test("PairServerHello accepts extra fields", () => {
    const result = PairServerHelloSchema.safeParse({
      ...validServerHello,
      extra: true,
    });
    expect(result.success).toBe(true);
  });

  test("PairInit accepts extra fields", () => {
    const result = PairInitSchema.safeParse({
      t: "pair_init",
      pA: "dGVzdA",
      extra_data: "ignored",
    });
    expect(result.success).toBe(true);
  });

  test("PairResp accepts extra fields", () => {
    const result = PairRespSchema.safeParse({
      t: "pair_resp",
      pB: "dGVzdA",
      version_hint: 2,
    });
    expect(result.success).toBe(true);
  });

  test("PairConfirm1 accepts extra fields", () => {
    const result = PairConfirm1Schema.safeParse({
      t: "pair_confirm1",
      mac: "dGVzdA",
      nonce: "abc",
    });
    expect(result.success).toBe(true);
  });

  test("PairConfirm2 accepts extra fields", () => {
    const result = PairConfirm2Schema.safeParse({
      t: "pair_confirm2",
      mac: "dGVzdA",
      counter: 1,
    });
    expect(result.success).toBe(true);
  });

  test("PairBootstrap accepts extra fields", () => {
    const result = PairBootstrapSchema.safeParse({
      t: "pair_bootstrap",
      ct: "dGVzdA",
      algo: "aes-256-gcm",
    });
    expect(result.success).toBe(true);
  });

  test("PairDone accepts extra fields", () => {
    const result = PairDoneSchema.safeParse({
      t: "pair_done",
      timestamp: 1234567890,
    });
    expect(result.success).toBe(true);
  });

  test("PairError accepts extra fields", () => {
    const result = PairErrorSchema.safeParse({
      t: "pair_error",
      code: "expired",
      message: "Session expired after 300 seconds",
    });
    expect(result.success).toBe(true);
  });

  test("PairBootstrapPayload accepts extra fields", () => {
    const result = PairBootstrapPayloadSchema.safeParse({
      node_id: "node-1",
      node_name: "My Node",
      noise_suite: "Noise_NK_25519_ChaChaPoly_SHA256",
      noise_static_pubkey: "cHVia2V5",
      noise_key_id: "sha256:abc",
      node_paths: [],
      rpc: ["jsonrpc-2.0"],
      future_capability: true,
    });
    expect(result.success).toBe(true);
  });

  test("PairMessageSchema accepts extra fields on discriminated variants", () => {
    const result = PairMessageSchema.safeParse({
      ...validClientHello,
      unknown_extension: [1, 2, 3],
    });
    expect(result.success).toBe(true);
  });
});

// --- Constants ---

describe("constants", () => {
  test("PAIR_SUITE has expected value", () => {
    expect(PAIR_SUITE).toBe("SPAKE2-edwards25519-SHA256-HKDF-HMAC");
  });

  test("PAIR_PROTOCOL_PREFIX has expected value", () => {
    expect(PAIR_PROTOCOL_PREFIX).toBe("orka-pair/v1");
  });
});
