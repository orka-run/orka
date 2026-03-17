import type { Server } from "bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type OrkaService } from "@orka/core";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonContext, type DaemonContext } from "./daemon-context";
import { startServer } from "./server";

const originalOrkaHome = process.env["ORKA_HOME"];

let testHome = "";
let ctx: DaemonContext;
let server: Server<unknown> | null = null;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "orka-server-test-"));
  // Tracing module uses ORKA_HOME for trace file location (global by design)
  process.env["ORKA_HOME"] = testHome;
  ctx = createDaemonContext(testHome);
});

afterEach(() => {
  server?.stop(true);
  server = null;
  ctx.db.close();
  rmSync(testHome, { recursive: true, force: true });
  if (originalOrkaHome === undefined) {
    delete process.env["ORKA_HOME"];
  } else {
    process.env["ORKA_HOME"] = originalOrkaHome;
  }
});

describe("startServer", () => {
  test("returns protocol metadata and capabilities from /health", async () => {
    writeFileSync(join(testHome, "config.toml"), ["[limits]", "max_concurrent = 4"].join("\n"), "utf8");
    // Recreate ctx to pick up the new config
    ctx.db.close();
    ctx = createDaemonContext(testHome);

    ({ server } = await startServer(ctx, {} as OrkaService, {
      port: 0,
      hostname: "127.0.0.1",
      encrypt: true,
    }));

    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(response.status).toBe(200);

    const body = await response.json() as {
      status: string;
      protocolVersion: number;
      publicKey?: string;
      capabilities: Record<string, unknown>;
    };

    expect(body).toMatchObject({
      status: "ok",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        resume: false,
        encryption: "noise-nk",
        multiTurn: true,
        adapters: ["claude-code", "codex"],
        maxConcurrent: 4,
        terminal: true,
      },
    });
    // Noise transport: publicKey is base64url raw X25519 public key
    expect(body.publicKey).toEqual(expect.any(String));
    // key_id is "sha256:<hex>"
    expect((body as any).keyId).toEqual(expect.stringMatching(/^sha256:[0-9a-f]{64}$/));
    // nodeId is exposed
    expect((body as any).nodeId).toEqual(expect.any(String));
  });

  test("pushes protocol metadata and capabilities in server.welcome", async () => {
    const svc = {
      listSessions: async () => [{ id: "sess-1" }, { id: "sess-2" }],
    } as OrkaService;

    ({ server } = await startServer(ctx, svc, {
      port: 0,
      hostname: "127.0.0.1",
    }));

    const message = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server!.port}`);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Timed out waiting for server.welcome"));
      }, 2_000);

      ws.onmessage = (event) => {
        clearTimeout(timeout);
        ws.close();
        resolve(typeof event.data === "string" ? event.data : "");
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        ws.close();
        reject(new Error("WebSocket connection failed"));
      };
    });

    expect(JSON.parse(message)).toMatchObject({
      type: "push",
      channel: "server.welcome",
      sequence: 1,
      data: {
        serverVersion: expect.any(String),
        sessionCount: 2,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          resume: false,
          encryption: false,
          multiTurn: true,
          adapters: ["claude-code", "codex"],
          maxConcurrent: 5,
          terminal: true,
        },
      },
    });
  });

  test("accepts OTLP JSON spans on /v1/traces", async () => {
    ({ server } = await startServer(ctx, {} as OrkaService, {
      port: 0,
      hostname: "127.0.0.1",
    }));

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/traces`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [
                {
                  key: "service.name",
                  value: { stringValue: "orka-cli" },
                },
              ],
            },
            scopeSpans: [
              {
                scope: {
                  name: "orka",
                  version: "0.1.0",
                },
                spans: [
                  {
                    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                    spanId: "00f067aa0ba902b7",
                    name: "orka.cli.ps",
                    kind: 1,
                    startTimeUnixNano: "1741680000000000000",
                    endTimeUnixNano: "1741680001000000000",
                    attributes: [
                      {
                        key: "orka.command",
                        value: { stringValue: "ps" },
                      },
                    ],
                    status: { code: 1 },
                  },
                ],
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);

    const traceFile = join(testHome, "traces.jsonl");
    expect(existsSync(traceFile)).toBe(true);

    const lines = readFileSync(traceFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      name: "orka.cli.ps",
      attributes: { "orka.command": "ps" },
      resourceAttributes: { "service.name": "orka-cli" },
    });
  });
});
