# OpenTelemetry Auto-Instrumentation Research

_Date: 2026-03-22_

## Executive Summary

We currently have 278 manual `withSpan`/`withSpanSync` calls across 48 files — but 98% of spans are root spans (no parent-child relationships), making traces nearly useless for debugging request flows. The biggest wins come from **fixing trace context propagation** (not adding more spans) and **adding browser auto-instrumentation** (zero-code traces for every fetch call and page load).

---

## 1. Auto-Instrumentation Packages: What Exists

### Browser (Dashboard)

| Package | What It Does | Works with React/Vite? | Recommendation |
|---------|-------------|----------------------|----------------|
| `@opentelemetry/sdk-trace-web` | Browser-specific `WebTracerProvider` | **Yes** — already installed | Already using |
| `@opentelemetry/instrumentation-fetch` | Auto-traces every `fetch()` call with HTTP method, URL, status, duration | **Yes** | **Must add** — traces every RPC call for free |
| `@opentelemetry/instrumentation-document-load` | Navigation timing, resource loading, DOMContentLoaded, LCP | **Yes** | **Add** — free page load metrics |
| `@opentelemetry/instrumentation-user-interaction` | Spans for click/input events on DOM elements | **Yes** | Nice-to-have — links user clicks to resulting fetch calls |
| `@opentelemetry/instrumentation-xml-http-request` | Auto-traces `XMLHttpRequest` | Yes but irrelevant | **Skip** — dashboard only uses `fetch` |
| `@opentelemetry/auto-instrumentations-web` | Meta-package bundling all four above | Yes | Can use instead of individual packages |
| `@opentelemetry/context-zone` | `ZoneContextManager` — Zone.js-based async context tracking in browser | Yes (adds ~50KB) | **Required** for linking fetch spans to parent user-interaction spans |

**Key insight from OTel demo**: The demo frontend uses `@opentelemetry/auto-instrumentations-web` with `ZoneContextManager` and `propagateTraceHeaderCorsUrls: /.*/` to inject `traceparent` headers on ALL outbound fetch requests. This is what connects frontend traces to backend traces automatically.

### Server/Daemon (Bun)

| Package | What It Does | Works with Bun? | Recommendation |
|---------|-------------|----------------|----------------|
| `@opentelemetry/instrumentation-http` | Auto-traces `node:http` server/client | **Partially** — Bun's HTTP server doesn't use `node:http`, so server-side instrumentation doesn't work. Client-side (outgoing `http.request`) may work but Bun uses its own fetch implementation. | **Skip** — Bun doesn't use `node:http` for serving |
| `@opentelemetry/instrumentation-undici` | Auto-traces `undici` fetch via `diagnostics_channel` | **Unknown/unlikely** — relies on Node's `diagnostics_channel` API which Bun may not fully implement | **Skip** — risky compatibility |
| `@onreza/opentelemetry-instrumentation-fetch-bun` | Community package for Bun's fetch API | **Probably** — Bun-specific, but zero npm dependents (very niche) | **Evaluate** — test if it works, but don't depend on it |
| `@opentelemetry/auto-instrumentations-node` | Meta-package for Node.js server auto-instrumentation | **No** — relies on monkey-patching `node:http`, `node:net`, etc. which Bun doesn't use | **Skip** |
| No official `@opentelemetry/instrumentation-bun` | Doesn't exist | N/A | Bun has no official OTel instrumentation package |

**Key finding on Bun compatibility**: Bun's HTTP server and fetch() implementation are native (not using `node:http` or `undici`), so Node.js auto-instrumentation packages that monkey-patch these modules **do not work**. Known issues: [oven-sh/bun#3775](https://github.com/oven-sh/bun/issues/3775), [oven-sh/bun#26536](https://github.com/oven-sh/bun/issues/26536). The official Bun team has discussed OTel but there's no official provider yet ([bun#7185](https://github.com/oven-sh/bun/discussions/7185)).

**What DOES work with Bun**:
- `@opentelemetry/api` — fully works (global tracer, context, propagation)
- `@opentelemetry/sdk-trace-base` — fully works (BasicTracerProvider, SpanProcessors, exporters)
- `@opentelemetry/sdk-metrics` — fully works
- `@opentelemetry/core` — W3CTraceContextPropagator works
- Manual instrumentation via `withSpan` — works perfectly
- `AsyncLocalStorage` — **works in Bun** (required for `context.active()` propagation)

**Can we auto-instrument bun:sqlite?** No. There's no OTel instrumentation for `bun:sqlite`. However, we already have 49 `withSpanSync` calls in `db.ts` covering all DB operations — this is well-covered manually.

**Can we auto-instrument Bun.spawn?** No. No instrumentation exists. We could write a thin wrapper around `Bun.spawn` that creates spans, but this is low priority since our adapter code already instruments session lifecycle.

### Summary: Auto-Instrumentation Applicability

| Layer | Auto-instrumentation viable? | Best approach |
|-------|------------------------------|---------------|
| **Dashboard (browser)** | **Yes — high value** | Add `@opentelemetry/auto-instrumentations-web` + `ZoneContextManager` |
| **Daemon (Bun server)** | **No** | Continue manual `withSpan` — already 278 instrumentation points |
| **Relay (Bun server)** | **No** | Continue manual instrumentation |
| **CLI** | **No** | Continue manual instrumentation |

---

## 2. The 98% Root Span Problem: Diagnosis and Fix

### Why 98% of Spans Are Roots

The trace context propagation chain has **three breaks**:

#### Break 1: Dashboard → Daemon (ALREADY FIXED)
- `WsTransport` injects `traceparent` into outgoing RPC requests ✅
- `rpc-handler.ts` extracts `traceparent` and creates child spans ✅
- Tests verify this works ✅

#### Break 2: RPC Handler → LocalClient (PARTIALLY BROKEN)
- `rpc-handler.ts` line 53 starts `orka.rpc.handle` span with the extracted parent context ✅
- `dispatch()` at line 105 calls `withSpan("orka.rpc.dispatch", ...)` which uses `context.active()` — this **should** chain because `startActiveSpan` sets the span as active ✅
- But the actual service calls (e.g., `svc.spawn(params)` at line 112) happen inside the `withSpan` callback, so they should inherit the active context...
- **IF `AsyncLocalStorage` works correctly across async boundaries in Bun** ⚠️

#### Break 3: LocalClient → Orchestrator (MOSTLY WORKING)
- `LocalClient` methods use `withSpan` which uses `context.active()` — should chain if async context works ✅
- Orchestrator methods also use `withSpan` with `context.active()` ✅

### Root Cause: Likely AsyncLocalStorage Issues in Bun

Bun supports `AsyncLocalStorage` but has had historical issues with context loss across certain async patterns:
- `Bun.spawn` callbacks may not preserve async context
- Some `setTimeout`/`setInterval` patterns can lose context
- WebSocket message handlers may start with fresh context (not inheriting from the connection setup)

**The most likely culprit**: When the daemon's WebSocket server receives an RPC message via Bun's WS `message` handler, the handler starts with a fresh async context (no parent). Even though `rpc-handler.ts` extracts `traceparent` from the message and creates a child span, the `startActiveSpan` sets up context correctly — but any async operations inside may lose it if Bun's `AsyncLocalStorage` doesn't propagate through certain code paths.

### Fix: Explicit Context Propagation (3 changes)

Instead of relying on `context.active()` (which depends on `AsyncLocalStorage` working perfectly), explicitly pass context through the call chain:

**Change 1: Pass context from dispatch to service methods**

The `dispatch` function already receives `parentContext` and creates a span. The span context should be explicitly passed to LocalClient methods:

```typescript
// rpc-handler.ts dispatch — current
case "spawn":
  return svc.spawn(params);

// rpc-handler.ts dispatch — fixed
case "spawn":
  return svc.spawn(params, { traceContext: context.active() });
```

This requires adding an optional `traceContext` parameter to OrkaService methods (or using a context object).

**Change 2: Thread context in LocalClient**

```typescript
// local-client.ts — current
async spawn(params: SpawnParams): Promise<SpawnResult> {
  return withSpan("orka.local.spawn", { ... }, async (span) => {
    // ...
  });
}

// local-client.ts — fixed
async spawn(params: SpawnParams, opts?: { traceContext?: Context }): Promise<SpawnResult> {
  return withSpan("orka.local.spawn", { ... }, async (span) => {
    // ...
  }, opts?.traceContext);
}
```

**Change 3: Alternative — inject context at the WS message handler level**

Instead of modifying every service method signature, set the async context at the WS message boundary:

```typescript
// server.ts — wrap message handler
import { context, trace } from "@opentelemetry/api";

ws.on("message", (raw: string) => {
  // Extract traceparent from message, set as active context
  const req = JSON.parse(raw);
  const parentCtx = req.traceparent
    ? propagation.extract(ROOT_CONTEXT, { traceparent: req.traceparent })
    : ROOT_CONTEXT;

  // Run entire RPC handling within this context
  context.with(parentCtx, () => {
    handleRpcRequest(ctx, svc, raw);
  });
});
```

This is the **cleanest fix** — wrap the message handler with `context.with()` so ALL downstream code inherits the correct parent via `context.active()`. No signature changes needed.

**Effort estimate**: ~2 hours for Change 3 (WS message handler context injection). This single change should fix most root span issues for CLI→daemon traces.

---

## 3. Dashboard Auto-Instrumentation Plan

### Current State

The dashboard has a `WebTracerProvider` configured but only 6 spans in 37k total traces — effectively untraced. The existing setup in `packages/dashboard/src/lib/tracing.ts`:
- Creates a `WebTracerProvider` with OTLP exporter ✅
- Registers it globally ✅
- Provides `withDashboardSpan` wrapper ✅
- **Does NOT register auto-instrumentations** ❌
- **Does NOT use `ZoneContextManager`** ❌ (uses default `StackContextManager` which doesn't propagate across async boundaries in browsers)

### Recommended Changes

**Step 1: Add dependencies**

```bash
bun add @opentelemetry/auto-instrumentations-web @opentelemetry/context-zone-peer-dep zone.js
```

(`context-zone-peer-dep` lets you control the Zone.js version separately)

**Step 2: Update `initDashboardTracing()`**

```typescript
import { ZoneContextManager } from "@opentelemetry/context-zone-peer-dep";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { getWebAutoInstrumentations } from "@opentelemetry/auto-instrumentations-web";

export function initDashboardTracing(): void {
  if (provider) return;

  provider = new WebTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "orka-dashboard",
    }),
    spanProcessors: [
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: TRACE_EXPORT_URL }),
        { scheduledDelayMillis: 500 }
      ),
    ],
  });

  provider.register({
    contextManager: new ZoneContextManager(),
    propagator: new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  });

  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      getWebAutoInstrumentations({
        "@opentelemetry/instrumentation-fetch": {
          propagateTraceHeaderCorsUrls: /.*/,
          clearTimingResources: true,
        },
        "@opentelemetry/instrumentation-xml-http-request": {
          enabled: false, // Dashboard only uses fetch
        },
      }),
    ],
  });
}
```

**What this gives us for free (zero additional code)**:
- Every `fetch()` call from the dashboard creates a span with: HTTP method, URL, status code, duration
- `traceparent` headers are automatically injected into all fetch requests → daemon RPC handler picks them up → **full CLI/dashboard → daemon trace chains**
- Page load timing spans: `documentFetch`, `documentLoad`, `resourceFetch`
- User interaction spans: click events linked to resulting fetch calls
- All spans properly parented via `ZoneContextManager`

**Effort estimate**: ~1 hour. Most of this is adding packages and updating the init function.

**Size impact**: Zone.js adds ~50KB gzipped to the bundle. This is the only significant cost. If bundle size is critical, you can skip Zone.js and use `StackContextManager` (default) — you lose parent-child linking between user interactions and fetch calls, but the fetch auto-instrumentation still works.

---

## 4. Trace Context Propagation: Current State

### What's Already Working

| Path | Status | Mechanism |
|------|--------|-----------|
| Dashboard → Daemon (RPC) | ✅ Working | `WsTransport` injects `traceparent` into JSON-RPC requests |
| CLI → Daemon (RPC) | ✅ Working | Same `WsTransport` mechanism (shared `@orka/client`) |
| Daemon RPC → Handler | ✅ Working | `rpc-handler.ts` extracts `traceparent`, creates child span |
| RPC Handler → Dispatch | ✅ Working | `startActiveSpan` sets active context, `dispatch` uses `context.active()` |

### What's Broken

| Path | Status | Fix |
|------|--------|-----|
| WS message handler → RPC | ⚠️ Context may be lost | Wrap WS `message` handler with `context.with()` |
| Daemon → Dashboard (push events) | ❌ No context | Add `traceparent` to push event envelopes |
| Cross-session traces | ❌ No context | Not applicable — sessions are independent |

### What's NOT Needed

- **RPC response traceparent**: Client already has its own span for the RPC call. The client span is the parent; the server span is the child. Response doesn't need to carry context back.
- **`tracestate` propagation**: Only needed for vendor-specific routing (Jaeger baggage, etc.). `traceparent` alone is sufficient for trace linking.

---

## 5. Collector + Visualization

### Current State

Spans are written to `~/.orka/traces.jsonl` (FileSpanExporter). OTLP/HTTP export is supported but not configured by default (`OTEL_EXPORTER_OTLP_ENDPOINT` env var).

### Option A: Jaeger All-in-One (Recommended for Development)

Minimal setup — single container, includes UI, collector, and in-memory storage:

```yaml
# docker-compose.otel.yml
services:
  jaeger:
    image: jaegertracing/jaeger:2
    ports:
      - "16686:16686"  # Jaeger UI
      - "4318:4318"    # OTLP HTTP receiver
    environment:
      COLLECTOR_OTLP_ENABLED: "true"
```

Start: `docker compose -f docker-compose.otel.yml up -d`

Configure daemon: `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 orka serve`

Open traces: `http://localhost:16686`

**Pros**: Single container, ~100MB RAM, built-in UI with trace waterfall, service graph, comparison view.
**Cons**: In-memory storage by default (traces lost on restart). Can use Badger/Cassandra/Elasticsearch for persistence.

### Option B: Grafana Tempo + Grafana

Heavier but integrates with metrics/logs in a single Grafana dashboard:

```yaml
services:
  tempo:
    image: grafana/tempo:latest
    ports:
      - "4318:4318"   # OTLP HTTP
    volumes:
      - ./tempo-config.yaml:/etc/tempo/config.yaml
    command: ["-config.file=/etc/tempo/config.yaml"]

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3001:3000"
    environment:
      GF_AUTH_ANONYMOUS_ENABLED: "true"
      GF_AUTH_ANONYMOUS_ORG_ROLE: "Admin"
    volumes:
      - ./grafana-datasources.yaml:/etc/grafana/provisioning/datasources/datasources.yaml
```

**Pros**: Full Grafana ecosystem (metrics + traces + logs correlated).
**Cons**: Two containers, more configuration, overkill for development.

### Option C: In-Browser Trace Viewer (Embedded in Dashboard)

Options for embedding trace visualization directly in the dashboard:

1. **AgentPrism** (`@evilmartians/agent-prism`) — React components specifically designed for visualizing AI agent traces. Shows hierarchical timelines with LLM calls, tool executions, and agent workflows. Built on the OTel data model. UI distributed as copyable source (shadcn-style). This is the strongest candidate for our use case since we're tracing agent sessions. ([GitHub](https://github.com/evilmartians/agent-prism))

2. **`jaeger-react-trace-component`** — Community package extracting the Jaeger TraceTimelineViewer as a standalone React component. Older project; the official Jaeger UI has not been published as embeddable npm components ([jaeger-ui#248](https://github.com/jaegertracing/jaeger-ui/issues/248)).

3. **Custom minimal viewer** — Render `traces.jsonl` data as a timeline using a custom canvas/SVG component. We already have `queryTraceLog()` and `TraceLogEntry` types with `traceId`/`spanId`/`parentSpanId`/`startTime`/`endTime` — everything needed to build a span tree and render a waterfall.

4. **Grafana embedded panel** — If using Option B, you could embed a Grafana trace panel via iframe.

**Recommendation**: Start with Jaeger (Option A) for development — zero-effort once the docker-compose is up. For dashboard-embedded traces, evaluate AgentPrism first since it's purpose-built for AI agent trace visualization. We could expose `queryTraceLog()` via RPC and feed the results to AgentPrism components — no external backend needed.

### OpenTelemetry Collector

**Not needed for our setup.** The Collector is useful when you need to:
- Fan-out traces to multiple backends
- Sample/filter traces before export
- Transform span attributes
- Buffer/retry failed exports

Our daemon already exports OTLP directly to the backend. Adding a Collector would just be another container between daemon and Jaeger with no real benefit at our scale.

---

## 6. Priority-Ordered Action Items

### P0: Fix Root Span Problem (2 hours)

**The single highest-value change.** Goes from 98% root spans to proper trace trees.

1. Wrap the WS `message` handler in `server.ts` with `context.with(extractedContext, ...)` so all downstream code inherits the trace context from the incoming RPC request.
2. Verify with a test: spawn a session from CLI, check `traces.jsonl` — the `orka.cli.spawn` → `orka.rpc.handle` → `orka.rpc.dispatch` → `orka.local.spawn` → `orka.orchestrator.spawn` chain should all share one `traceId`.

### P1: Dashboard Auto-Instrumentation (1 hour)

Add `@opentelemetry/auto-instrumentations-web` + `ZoneContextManager` to the dashboard. This gives us:
- Every WS RPC call traced automatically (no manual code needed)
- Page load timing
- User interaction → fetch linking
- Dashboard spans properly linked to daemon spans via `traceparent` injection

### P2: Add Jaeger docker-compose for Development (30 min)

Add `docker-compose.otel.yml` with Jaeger all-in-one. Update CLAUDE.md with the startup command. This lets any developer see trace waterfalls in a web UI.

### P3: Add Trace Link to Dashboard (2 hours)

When the dashboard shows a session or operation, include a link to view the trace in Jaeger. Requires knowing the `traceId` — the auto-instrumented fetch spans will have this.

### P4: Instrument Push Event Context (1 hour)

Add `traceparent` to push event envelopes so dashboard can link incoming push events to the daemon operation that generated them. Currently push events are fire-and-forget with no trace context.

### P5: Wrap Bun.spawn for Provider Processes (1 hour)

Create a thin wrapper around `Bun.spawn` in the adapter code that creates a span for the child process lifecycle. Low priority since we already instrument the adapter methods.

---

## What NOT to Do

1. **Don't use `@opentelemetry/auto-instrumentations-node`** — it relies on monkey-patching `node:http`, `node:net`, etc. which Bun doesn't use. It will silently do nothing or break.

2. **Don't use `@opentelemetry/instrumentation-http` for the daemon** — Bun's HTTP server is native, not `node:http`. The instrumentation won't intercept anything.

3. **Don't add more manual `withSpan` calls before fixing context propagation** — adding more root spans makes the problem worse, not better. Fix the 98% root span issue first.

4. **Don't add an OTel Collector** — unnecessary complexity at our scale. Direct OTLP export to Jaeger is simpler and sufficient.

5. **Don't try to auto-instrument `bun:sqlite`** — no instrumentation exists, and we already have 49 manual span calls covering all DB operations.

---

## Appendix: OTel Demo Frontend Configuration (Reference)

The OpenTelemetry demo app (`opentelemetry.io/docs/demo/services/frontend/`) uses this pattern:

```typescript
// Key configuration choices:
provider.register({
  contextManager: new ZoneContextManager(),  // Zone.js for browser async context
  propagator: new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  }),
});

registerInstrumentations({
  instrumentations: [
    getWebAutoInstrumentations({
      "@opentelemetry/instrumentation-fetch": {
        propagateTraceHeaderCorsUrls: /.*/,  // Inject traceparent on ALL fetch requests
        clearTimingResources: true,           // Prevent Performance API memory leak
      },
    }),
  ],
});
```

**Key takeaway**: The demo does NOT instrument React components or hooks. All instrumentation is at the platform level (fetch, document load, user clicks). This is the recommended approach — instrument I/O boundaries, not the render cycle.

## Appendix: Bun + OTel Compatibility Matrix

| OTel Component | Bun Compat | Notes |
|---------------|-----------|-------|
| `@opentelemetry/api` | ✅ Full | Global tracer, context, propagation all work |
| `@opentelemetry/sdk-trace-base` | ✅ Full | BasicTracerProvider, all processors/exporters |
| `@opentelemetry/sdk-metrics` | ✅ Full | MeterProvider, all readers/exporters |
| `@opentelemetry/core` | ✅ Full | W3CTraceContextPropagator works |
| `@opentelemetry/resources` | ✅ Full | Resource detection works |
| `@opentelemetry/exporter-trace-otlp-http` | ✅ Full | Uses `fetch()` internally |
| `AsyncLocalStorage` | ✅ Works | Bun supports Node.js `async_hooks` API |
| `@opentelemetry/instrumentation-http` | ❌ No | Bun doesn't use `node:http` for serving |
| `@opentelemetry/instrumentation-undici` | ❌ Unlikely | Bun may not implement `diagnostics_channel` fully |
| `@opentelemetry/auto-instrumentations-node` | ❌ No | Depends on `node:http` monkey-patching |
| `@opentelemetry/sdk-trace-web` | ✅ Full | Browser-only, already using |
| `@opentelemetry/auto-instrumentations-web` | ✅ Full | Browser-only, recommended |
| `@opentelemetry/context-zone` | ✅ Full | Browser-only, recommended |
