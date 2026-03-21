import { describe, expect, test } from "bun:test";
import {
  ClientHelloSchema,
  ServerHelloSchema,
  TransportErrorSchema,
  Noise1Schema,
  Noise2Schema,
  DataFrameSchema,
  TransportPayloadSchema,
  TransportMessageSchema,
  negotiateTransport,
  computeTransportPrologue,
  canonicalTransportOrigin,
  NOISE_SUITE,
  APP_PROTOCOL,
  DEFAULT_MAX_FRAME,
  type ClientHello,
  type ServerHello,
  type TransportServerCapabilities,
} from "./transport-protocol";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeClientHello(overrides?: Partial<ClientHello>): ClientHello {
  return {
    t: "client_hello",
    v: 1,
    noise_suites: [NOISE_SUITE],
    node_id: "node-1",
    expected_key_id: "sha256:abc123",
    app_protocols: [APP_PROTOCOL],
    features: [],
    ...overrides,
  };
}

function makeServerCapabilities(overrides?: Partial<TransportServerCapabilities>): TransportServerCapabilities {
  return {
    nodeId: "node-1",
    keyId: "sha256:abc123",
    supportedSuites: [NOISE_SUITE],
    supportedProtocols: [APP_PROTOCOL],
    maxFrame: DEFAULT_MAX_FRAME,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Schema validation — each message type validates correct input
// ---------------------------------------------------------------------------

describe("schema validation", () => {
  test("ClientHelloSchema accepts valid input", () => {
    const ch = makeClientHello();
    const parsed = ClientHelloSchema.parse(ch);
    expect(parsed.t).toBe("client_hello");
    expect(parsed.v).toBe(1);
    expect(parsed.noise_suites).toEqual([NOISE_SUITE]);
    expect(parsed.node_id).toBe("node-1");
    expect(parsed.expected_key_id).toBe("sha256:abc123");
    expect(parsed.app_protocols).toEqual([APP_PROTOCOL]);
    expect(parsed.features).toEqual([]);
  });

  test("ServerHelloSchema accepts valid input", () => {
    const sh = {
      t: "server_hello" as const,
      v: 1,
      noise_suite: NOISE_SUITE,
      node_id: "node-1",
      key_id: "sha256:abc123",
      app_protocol: APP_PROTOCOL,
      features: [],
      max_frame: DEFAULT_MAX_FRAME,
    };
    const parsed = ServerHelloSchema.parse(sh);
    expect(parsed.t).toBe("server_hello");
    expect(parsed.max_frame).toBe(DEFAULT_MAX_FRAME);
  });

  test("TransportErrorSchema accepts valid input", () => {
    const te = { t: "transport_error" as const, code: "unsupported_version" };
    const parsed = TransportErrorSchema.parse(te);
    expect(parsed.t).toBe("transport_error");
    expect(parsed.code).toBe("unsupported_version");
  });

  test("Noise1Schema accepts valid input", () => {
    const n1 = { t: "noise_1" as const, msg: "dGVzdA" };
    const parsed = Noise1Schema.parse(n1);
    expect(parsed.t).toBe("noise_1");
    expect(parsed.msg).toBe("dGVzdA");
  });

  test("Noise2Schema accepts valid input", () => {
    const n2 = { t: "noise_2" as const, msg: "cmVzcG9uc2U" };
    const parsed = Noise2Schema.parse(n2);
    expect(parsed.t).toBe("noise_2");
    expect(parsed.msg).toBe("cmVzcG9uc2U");
  });

  test("DataFrameSchema accepts valid input", () => {
    const df = { t: "data" as const, ct: "Y2lwaGVydGV4dA" };
    const parsed = DataFrameSchema.parse(df);
    expect(parsed.t).toBe("data");
    expect(parsed.ct).toBe("Y2lwaGVydGV4dA");
  });

  test("TransportPayloadSchema accepts valid rpc input", () => {
    const tp = { v: 1 as const, kind: "rpc" as const, rpc: { jsonrpc: "2.0", method: "test" } };
    const parsed = TransportPayloadSchema.parse(tp);
    expect(parsed.v).toBe(1);
    expect(parsed.kind).toBe("rpc");
    if (parsed.kind === "rpc") {
      expect(parsed.rpc).toEqual({ jsonrpc: "2.0", method: "test" });
    }
  });

  test("TransportPayloadSchema accepts valid push input", () => {
    const tp = { v: 1 as const, kind: "push" as const, push: { type: "push", channel: "server.welcome", sequence: 1, data: {} } };
    const parsed = TransportPayloadSchema.parse(tp);
    expect(parsed.v).toBe(1);
    expect(parsed.kind).toBe("push");
    if (parsed.kind === "push") {
      expect(parsed.push).toEqual({ type: "push", channel: "server.welcome", sequence: 1, data: {} });
    }
  });

  test("TransportPayloadSchema accepts valid push_control input", () => {
    const tp = { v: 1 as const, kind: "push_control" as const, push_control: { type: "subscribe", channels: ["server.welcome"] } };
    const parsed = TransportPayloadSchema.parse(tp);
    expect(parsed.v).toBe(1);
    expect(parsed.kind).toBe("push_control");
    if (parsed.kind === "push_control") {
      expect(parsed.push_control).toEqual({ type: "subscribe", channels: ["server.welcome"] });
    }
  });

  test("TransportPayloadSchema rejects unknown kind", () => {
    expect(() => TransportPayloadSchema.parse({ v: 1, kind: "unknown", data: {} })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Schema rejection — rejects invalid input
// ---------------------------------------------------------------------------

describe("schema rejection", () => {
  test("ClientHelloSchema rejects wrong type literal", () => {
    expect(() =>
      ClientHelloSchema.parse({ ...makeClientHello(), t: "wrong" }),
    ).toThrow();
  });

  test("ClientHelloSchema rejects missing required field", () => {
    const { noise_suites, ...rest } = makeClientHello();
    expect(() => ClientHelloSchema.parse(rest)).toThrow();
  });

  test("ServerHelloSchema rejects missing max_frame", () => {
    expect(() =>
      ServerHelloSchema.parse({
        t: "server_hello",
        v: 1,
        noise_suite: NOISE_SUITE,
        node_id: "n",
        key_id: "k",
        app_protocol: APP_PROTOCOL,
        features: [],
        // max_frame missing
      }),
    ).toThrow();
  });

  test("TransportErrorSchema rejects missing code", () => {
    expect(() => TransportErrorSchema.parse({ t: "transport_error" })).toThrow();
  });

  test("Noise1Schema rejects missing msg", () => {
    expect(() => Noise1Schema.parse({ t: "noise_1" })).toThrow();
  });

  test("DataFrameSchema rejects wrong type", () => {
    expect(() => DataFrameSchema.parse({ t: "noise_1", ct: "abc" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. TransportMessageSchema — discriminated union correctly identifies type
// ---------------------------------------------------------------------------

describe("TransportMessageSchema discriminated union", () => {
  test("parses client_hello", () => {
    const msg = TransportMessageSchema.parse(makeClientHello());
    expect(msg.t).toBe("client_hello");
  });

  test("parses server_hello", () => {
    const msg = TransportMessageSchema.parse({
      t: "server_hello",
      v: 1,
      noise_suite: NOISE_SUITE,
      node_id: "n",
      key_id: "k",
      app_protocol: APP_PROTOCOL,
      features: [],
      max_frame: 65536,
    });
    expect(msg.t).toBe("server_hello");
  });

  test("parses transport_error", () => {
    const msg = TransportMessageSchema.parse({
      t: "transport_error",
      code: "unsupported_version",
    });
    expect(msg.t).toBe("transport_error");
  });

  test("parses noise_1", () => {
    const msg = TransportMessageSchema.parse({ t: "noise_1", msg: "abc" });
    expect(msg.t).toBe("noise_1");
  });

  test("parses noise_2", () => {
    const msg = TransportMessageSchema.parse({ t: "noise_2", msg: "def" });
    expect(msg.t).toBe("noise_2");
  });

  test("parses data frame", () => {
    const msg = TransportMessageSchema.parse({ t: "data", ct: "ciphertext" });
    expect(msg.t).toBe("data");
  });

  test("rejects unknown type discriminator", () => {
    expect(() => TransportMessageSchema.parse({ t: "unknown", foo: "bar" })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. negotiateTransport — happy path
// ---------------------------------------------------------------------------

describe("negotiateTransport", () => {
  test("happy path returns server_hello", () => {
    const ch = makeClientHello();
    const caps = makeServerCapabilities();
    const result = negotiateTransport(ch, caps);
    expect(result.t).toBe("server_hello");
    if (result.t === "server_hello") {
      expect(result.v).toBe(1);
      expect(result.noise_suite).toBe(NOISE_SUITE);
      expect(result.node_id).toBe("node-1");
      expect(result.key_id).toBe("sha256:abc123");
      expect(result.app_protocol).toBe(APP_PROTOCOL);
      expect(result.max_frame).toBe(DEFAULT_MAX_FRAME);
      expect(result.features).toEqual([]);
    }
  });

  test("selects first matching suite from client preference order", () => {
    const ch = makeClientHello({
      noise_suites: ["Noise_XX_FutureSuite", NOISE_SUITE],
    });
    const caps = makeServerCapabilities({
      supportedSuites: [NOISE_SUITE],
    });
    const result = negotiateTransport(ch, caps);
    expect(result.t).toBe("server_hello");
    if (result.t === "server_hello") {
      expect(result.noise_suite).toBe(NOISE_SUITE);
    }
  });

  test("selects first matching app protocol from client preference order", () => {
    const ch = makeClientHello({
      app_protocols: ["grpc", APP_PROTOCOL],
    });
    const caps = makeServerCapabilities({
      supportedProtocols: [APP_PROTOCOL],
    });
    const result = negotiateTransport(ch, caps);
    expect(result.t).toBe("server_hello");
    if (result.t === "server_hello") {
      expect(result.app_protocol).toBe(APP_PROTOCOL);
    }
  });

  // ---------------------------------------------------------------------------
  // 5. negotiateTransport — wrong version
  // ---------------------------------------------------------------------------

  test("wrong version returns unsupported_version", () => {
    const ch = makeClientHello({ v: 99 });
    const caps = makeServerCapabilities();
    const result = negotiateTransport(ch, caps);
    expect(result).toEqual({ t: "transport_error", code: "unsupported_version" });
  });

  // ---------------------------------------------------------------------------
  // 6. negotiateTransport — no matching suite
  // ---------------------------------------------------------------------------

  test("no matching suite returns unsupported_suite", () => {
    const ch = makeClientHello({ noise_suites: ["Noise_XX_Unknown"] });
    const caps = makeServerCapabilities();
    const result = negotiateTransport(ch, caps);
    expect(result).toEqual({ t: "transport_error", code: "unsupported_suite" });
  });

  // ---------------------------------------------------------------------------
  // 7. negotiateTransport — wrong node_id
  // ---------------------------------------------------------------------------

  test("wrong node_id returns no_such_node", () => {
    const ch = makeClientHello({ node_id: "wrong-node" });
    const caps = makeServerCapabilities();
    const result = negotiateTransport(ch, caps);
    expect(result).toEqual({ t: "transport_error", code: "no_such_node" });
  });

  // ---------------------------------------------------------------------------
  // 8. negotiateTransport — key ID mismatch
  // ---------------------------------------------------------------------------

  test("key ID mismatch returns key_id_mismatch", () => {
    const ch = makeClientHello({ expected_key_id: "sha256:wrong" });
    const caps = makeServerCapabilities();
    const result = negotiateTransport(ch, caps);
    expect(result).toEqual({ t: "transport_error", code: "key_id_mismatch" });
  });

  // ---------------------------------------------------------------------------
  // no matching app protocol
  // ---------------------------------------------------------------------------

  test("no matching app protocol returns protocol_error", () => {
    const ch = makeClientHello({ app_protocols: ["grpc"] });
    const caps = makeServerCapabilities();
    const result = negotiateTransport(ch, caps);
    expect(result).toEqual({ t: "transport_error", code: "protocol_error" });
  });

  // ---------------------------------------------------------------------------
  // error priority: version is checked first
  // ---------------------------------------------------------------------------

  test("error priority: version checked before suite", () => {
    const ch = makeClientHello({ v: 2, noise_suites: ["Noise_XX_Unknown"] });
    const caps = makeServerCapabilities();
    const result = negotiateTransport(ch, caps);
    expect(result).toEqual({ t: "transport_error", code: "unsupported_version" });
  });
});

// ---------------------------------------------------------------------------
// 9. computeTransportPrologue — correct format
// ---------------------------------------------------------------------------

describe("computeTransportPrologue", () => {
  test("correct format: prefix || origin || transcript", () => {
    const ch = makeClientHello();
    const sh: ServerHello = {
      t: "server_hello",
      v: 1,
      noise_suite: NOISE_SUITE,
      node_id: "node-1",
      key_id: "sha256:abc123",
      app_protocol: APP_PROTOCOL,
      features: [],
      max_frame: DEFAULT_MAX_FRAME,
    };
    const relayOrigin = "ws://relay.example.com:7390";

    const prologue = computeTransportPrologue(ch, sh, relayOrigin);

    // Decode and verify it starts with the prefix
    const decoder = new TextDecoder();
    const text = decoder.decode(prologue);
    expect(text.startsWith("orka-transport/v1")).toBe(true);
    expect(text.includes(relayOrigin)).toBe(true);
    // Verify it contains canonical JSON of both messages
    expect(text.includes('"t":"client_hello"')).toBe(true);
    expect(text.includes('"t":"server_hello"')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // 10. Prologue determinism — same inputs produce same output
  // ---------------------------------------------------------------------------

  test("determinism: same inputs produce identical output", () => {
    const ch = makeClientHello();
    const sh: ServerHello = {
      t: "server_hello",
      v: 1,
      noise_suite: NOISE_SUITE,
      node_id: "node-1",
      key_id: "sha256:abc123",
      app_protocol: APP_PROTOCOL,
      features: [],
      max_frame: DEFAULT_MAX_FRAME,
    };
    const origin = "ws://relay:7390";

    const p1 = computeTransportPrologue(ch, sh, origin);
    const p2 = computeTransportPrologue(ch, sh, origin);
    expect(p1).toEqual(p2);
  });

  test("different relay origin produces different prologue", () => {
    const ch = makeClientHello();
    const sh: ServerHello = {
      t: "server_hello",
      v: 1,
      noise_suite: NOISE_SUITE,
      node_id: "node-1",
      key_id: "sha256:abc123",
      app_protocol: APP_PROTOCOL,
      features: [],
      max_frame: DEFAULT_MAX_FRAME,
    };

    const p1 = computeTransportPrologue(ch, sh, "ws://relay-a:7390");
    const p2 = computeTransportPrologue(ch, sh, "ws://relay-b:7390");
    expect(p1).not.toEqual(p2);
  });

  test("canonical JSON ensures key order independence", () => {
    // Two objects with same data but different key insertion order
    const ch1 = {
      t: "client_hello" as const,
      v: 1,
      noise_suites: [NOISE_SUITE],
      node_id: "node-1",
      expected_key_id: "sha256:abc123",
      app_protocols: [APP_PROTOCOL],
      features: [],
    };
    const ch2 = {
      features: [],
      app_protocols: [APP_PROTOCOL],
      expected_key_id: "sha256:abc123",
      node_id: "node-1",
      noise_suites: [NOISE_SUITE],
      v: 1,
      t: "client_hello" as const,
    };

    const sh: ServerHello = {
      t: "server_hello",
      v: 1,
      noise_suite: NOISE_SUITE,
      node_id: "node-1",
      key_id: "sha256:abc123",
      app_protocol: APP_PROTOCOL,
      features: [],
      max_frame: DEFAULT_MAX_FRAME,
    };

    const p1 = computeTransportPrologue(ch1, sh, "ws://relay:7390");
    const p2 = computeTransportPrologue(ch2, sh, "ws://relay:7390");
    expect(p1).toEqual(p2);
  });
});

// ---------------------------------------------------------------------------
// 11. Round-trip — create, serialize, parse, equals
// ---------------------------------------------------------------------------

describe("round-trip", () => {
  test("client_hello round-trips through JSON", () => {
    const original = makeClientHello();
    const json = JSON.stringify(original);
    const parsed = ClientHelloSchema.parse(JSON.parse(json));
    expect(parsed).toEqual(original);
  });

  test("server_hello round-trips through JSON", () => {
    const original: ServerHello = {
      t: "server_hello",
      v: 1,
      noise_suite: NOISE_SUITE,
      node_id: "node-1",
      key_id: "sha256:abc",
      app_protocol: APP_PROTOCOL,
      features: ["stream"],
      max_frame: 65536,
    };
    const json = JSON.stringify(original);
    const parsed = ServerHelloSchema.parse(JSON.parse(json));
    expect(parsed).toEqual(original);
  });

  test("transport_error round-trips through JSON", () => {
    const original = { t: "transport_error" as const, code: "key_id_mismatch" };
    const json = JSON.stringify(original);
    const parsed = TransportErrorSchema.parse(JSON.parse(json));
    expect(parsed).toEqual(original);
  });

  test("noise_1 round-trips through JSON", () => {
    const original = { t: "noise_1" as const, msg: "aGVsbG8" };
    const json = JSON.stringify(original);
    const parsed = Noise1Schema.parse(JSON.parse(json));
    expect(parsed).toEqual(original);
  });

  test("data frame round-trips through JSON", () => {
    const original = { t: "data" as const, ct: "ZW5jcnlwdGVk" };
    const json = JSON.stringify(original);
    const parsed = DataFrameSchema.parse(JSON.parse(json));
    expect(parsed).toEqual(original);
  });

  test("TransportMessageSchema round-trips all message types", () => {
    const messages = [
      makeClientHello(),
      {
        t: "server_hello" as const,
        v: 1,
        noise_suite: NOISE_SUITE,
        node_id: "n",
        key_id: "k",
        app_protocol: APP_PROTOCOL,
        features: [],
        max_frame: 1024,
      },
      { t: "transport_error" as const, code: "unsupported_version" },
      { t: "noise_1" as const, msg: "abc" },
      { t: "noise_2" as const, msg: "def" },
      { t: "data" as const, ct: "ghi" },
    ];

    for (const msg of messages) {
      const json = JSON.stringify(msg);
      const parsed = TransportMessageSchema.parse(JSON.parse(json));
      expect(parsed).toEqual(msg);
    }
  });
});

// ---------------------------------------------------------------------------
// 12. Forward compatibility — extra fields accepted
// ---------------------------------------------------------------------------

describe("forward compatibility", () => {
  test("ClientHelloSchema accepts extra fields via passthrough", () => {
    const ch = { ...makeClientHello(), future_field: "hello", another: 42 };
    const parsed = ClientHelloSchema.parse(ch);
    expect(parsed.t).toBe("client_hello");
    expect((parsed as Record<string, unknown>)["future_field"]).toBe("hello");
    expect((parsed as Record<string, unknown>)["another"]).toBe(42);
  });

  test("ServerHelloSchema accepts extra fields via passthrough", () => {
    const sh = {
      t: "server_hello" as const,
      v: 1,
      noise_suite: NOISE_SUITE,
      node_id: "n",
      key_id: "k",
      app_protocol: APP_PROTOCOL,
      features: [],
      max_frame: 1024,
      experimental: true,
    };
    const parsed = ServerHelloSchema.parse(sh);
    expect((parsed as Record<string, unknown>)["experimental"]).toBe(true);
  });

  test("TransportErrorSchema accepts extra fields via passthrough", () => {
    const te = { t: "transport_error" as const, code: "unsupported_version", details: "v2 not supported" };
    const parsed = TransportErrorSchema.parse(te);
    expect((parsed as Record<string, unknown>)["details"]).toBe("v2 not supported");
  });

  test("Noise1Schema accepts extra fields via passthrough", () => {
    const n1 = { t: "noise_1" as const, msg: "abc", extra: "data" };
    const parsed = Noise1Schema.parse(n1);
    expect((parsed as Record<string, unknown>)["extra"]).toBe("data");
  });

  test("DataFrameSchema accepts extra fields via passthrough", () => {
    const df = { t: "data" as const, ct: "abc", seq: 42 };
    const parsed = DataFrameSchema.parse(df);
    expect((parsed as Record<string, unknown>)["seq"]).toBe(42);
  });

  test("TransportMessageSchema preserves extra fields through union", () => {
    const msg = { ...makeClientHello(), extensionV2: true };
    const parsed = TransportMessageSchema.parse(msg);
    expect(parsed.t).toBe("client_hello");
    expect((parsed as Record<string, unknown>)["extensionV2"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13. canonicalTransportOrigin — URL normalization for prologue binding
// ---------------------------------------------------------------------------

describe("canonicalTransportOrigin", () => {
  test("returns empty string for empty input", () => {
    expect(canonicalTransportOrigin("")).toBe("");
    expect(canonicalTransportOrigin(undefined)).toBe("");
  });

  test("returns empty string for whitespace-only input", () => {
    expect(canonicalTransportOrigin("   ")).toBe("");
    expect(canonicalTransportOrigin("\t\n")).toBe("");
  });

  test("returns empty string for invalid URL", () => {
    expect(canonicalTransportOrigin("not-a-url")).toBe("");
  });

  test("strips query parameters", () => {
    expect(canonicalTransportOrigin("ws://relay:7390?token=secret")).toBe("ws://relay:7390");
  });

  test("strips hash fragment", () => {
    expect(canonicalTransportOrigin("ws://relay:7390#section")).toBe("ws://relay:7390");
  });

  test("strips /ws client suffix", () => {
    expect(canonicalTransportOrigin("ws://relay:7390/ws")).toBe("ws://relay:7390");
  });

  test("strips /ws/ client suffix with trailing slash", () => {
    expect(canonicalTransportOrigin("ws://relay:7390/ws/")).toBe("ws://relay:7390");
  });

  test("strips trailing slashes", () => {
    expect(canonicalTransportOrigin("ws://relay:7390/")).toBe("ws://relay:7390");
    expect(canonicalTransportOrigin("ws://relay:7390///")).toBe("ws://relay:7390");
  });

  test("preserves port", () => {
    expect(canonicalTransportOrigin("ws://relay:7390")).toBe("ws://relay:7390");
    expect(canonicalTransportOrigin("wss://relay:8443")).toBe("wss://relay:8443");
  });

  test("default ports are stripped by URL constructor", () => {
    // 443 is default for wss, 80 is default for ws — URL normalizes these away
    expect(canonicalTransportOrigin("wss://relay:443")).toBe("wss://relay");
  });

  test("handles wss scheme", () => {
    expect(canonicalTransportOrigin("wss://secure.relay.com:8443/ws?token=abc")).toBe("wss://secure.relay.com:8443");
  });

  test("client and server URLs produce same canonical origin", () => {
    // Client typically has ws://relay:7390/ws, server has ws://relay:7390
    const clientUrl = "ws://relay:7390/ws";
    const serverUrl = "ws://relay:7390";
    expect(canonicalTransportOrigin(clientUrl)).toBe(canonicalTransportOrigin(serverUrl));
  });

  test("client URL with query and server bare URL match", () => {
    const clientUrl = "ws://relay:7390/ws?token=mysecret";
    const serverUrl = "ws://relay:7390";
    expect(canonicalTransportOrigin(clientUrl)).toBe(canonicalTransportOrigin(serverUrl));
  });

  test("direct connection: non-empty URL normalizes correctly", () => {
    expect(canonicalTransportOrigin("ws://host:7394")).toBe("ws://host:7394");
  });

  test("preserves non-ws paths that are not /ws suffix", () => {
    expect(canonicalTransportOrigin("ws://relay:7390/v1/pair/abc")).toBe("ws://relay:7390/v1/pair/abc");
  });
});
