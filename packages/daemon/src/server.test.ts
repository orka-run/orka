import type { Server } from "bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { OrkaService } from "@orka/core";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server";

const originalOrkaHome = process.env["ORKA_HOME"];

let testHome = "";
let server: Server<unknown> | null = null;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "orka-server-test-"));
  process.env["ORKA_HOME"] = testHome;
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(testHome, { recursive: true, force: true });
  if (originalOrkaHome === undefined) {
    delete process.env["ORKA_HOME"];
  } else {
    process.env["ORKA_HOME"] = originalOrkaHome;
  }
});

describe("startServer", () => {
  test("accepts OTLP JSON spans on /v1/traces", async () => {
    server = await startServer({} as OrkaService, {
      port: 0,
      hostname: "127.0.0.1",
    });

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
