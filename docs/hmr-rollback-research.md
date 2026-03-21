# HMR Resilience When Agents Edit Dashboard Source

## Problem

When an orka-spawned agent edits files in `packages/dashboard/src/`, Vite HMR picks up changes immediately. If the agent introduces a syntax error or runtime crash mid-edit, the dashboard breaks — the user loses their UI while the agent is still working.

## Current State

The dashboard already has some resilience:

- **ErrorBoundary** (`src/components/ErrorBoundary.tsx`) — catches React render errors and unhandled rejections, shows error UI with retry/reload. Already filters out `@vite/client` WebSocket noise.
- **Vite error overlay** — enabled by default, catches compile/transform errors (syntax errors), shows overlay with auto-dismiss on fix.
- **React Fast Refresh** — via `@vitejs/plugin-react`. Preserves component state across HMR for syntax errors and non-render runtime errors. Remounts on render errors (error boundaries catch these).
- **No explicit HMR config** — default chokidar watcher, no debouncing, no `awaitWriteFinish`.
- **No service worker** — dashboard requires live daemon connection, no offline support.

## Findings

### 1. Can Vite HMR buffer/batch changes and only apply when valid?

**No built-in option.** Vite's `server.hmr` options control protocol/overlay/port — no `debounce` or `batch` field. However:

- **chokidar `awaitWriteFinish`** can be set via `server.watch` to delay file-change events until file size stabilizes. Prevents triggering HMR on half-written files but does not validate content.
- **`handleHotUpdate` plugin hook** (or `hotUpdate` in Vite 6+) can intercept HMR, return `[]` to suppress, or delay/batch updates. This is the correct extension point for custom validation.

### 2. Can we snapshot module state and rollback on HMR error?

**No automatic rollback.** Behavior differs by error type:

- **Syntax errors**: New module never loads. Old module stays in memory. Vite shows error overlay. App is intact. Auto-recovers when fixed.
- **Runtime errors during render**: React Fast Refresh remounts the subtree. Error boundaries catch these. State lost for errored subtree only.
- **Runtime errors outside render** (event handlers etc.): Component state preserved, error in overlay, auto-recovers.
- **Module-level errors** (top-level throws): Most dangerous. Module evaluated, side effects run, app may break. No rollback.

`import.meta.hot.data` persists across updates and `dispose()` allows cleanup, but building a general rollback is impractical — you'd need to reverse arbitrary side effects.

### 3. Does Vite's error overlay + ErrorBoundary already handle this well enough?

**Mostly yes for syntax errors, no for runtime errors.**

- Vite overlay catches compile/transform errors only (syntax, import resolution). App stays intact behind the overlay. Auto-dismisses on fix.
- ErrorBoundary catches React render errors. Shows error UI with retry.
- **Gap**: Runtime errors in non-component files (stores, utilities) are not caught by either. The Vite overlay does not catch runtime errors (long-standing feature request: [vitejs/vite#2076](https://github.com/vitejs/vite/issues/2076)).
- **Gap**: Rapid agent edits cause overlay flashing ([vitejs/vite#13220](https://github.com/vitejs/vite/issues/13220)).

### 4. Could a service worker serve the last-known-good bundle?

**Not practical for dev mode.**

- Vite serves unbundled ES modules with timestamp query params for cache-busting (`?t=123456`). A service worker would need to understand this protocol.
- Caching some modules but not others (during multi-file edits) causes version mismatches worse than the original error.
- Service workers interfere with HMR in practice (reported by Turbopack/Next.js users).
- No existing implementation of this pattern for any dev server.

**Verdict: Do not pursue.**

### 5. Could we debounce HMR with a validation step?

**Yes — this is the most promising approach.**

The `handleHotUpdate` hook provides file path, content (`read()`), and affected modules. A plugin can:

1. Read file content via `ctx.read()`
2. Parse with esbuild (`esbuild.transform(code, { loader: 'tsx' })`) — ~1-5ms per file
3. Return `[]` to suppress HMR on syntax error
4. Return `ctx.modules` to proceed on valid code
5. Optionally debounce (accumulate changes for N ms, validate batch, then trigger)

```typescript
// Sketch — not production code
{
  name: 'hmr-gate',
  async handleHotUpdate(ctx) {
    if (!ctx.file.match(/\.(tsx?|jsx?)$/)) return;
    const code = await ctx.read();
    try {
      await esbuild.transform(code, { loader: inferLoader(ctx.file) });
      return ctx.modules; // valid → proceed
    } catch {
      ctx.server.ws.send({ type: 'custom', event: 'hmr:gated', data: { file: ctx.file } });
      return []; // invalid → suppress
    }
  }
}
```

**Limitations:**
- Catches syntax errors only, not type errors or semantic errors (type-checking too slow for HMR hot path).
- For non-component files (stores), even valid code can reset state on full reload.
- Debouncing adds latency to normal development (mitigate by only enabling when an agent session is active on the dashboard project).

### 6. What do other tools do?

| Bundler | Error Resilience |
|---------|-----------------|
| **Webpack** | More explicit HMR error hooks (`module.hot.accept(errorHandler)`), formal status system (`idle`/`check`/`apply`/`fail`), but no automatic rollback |
| **Turbopack** | Relies on React Fast Refresh. Known issues with stale module factories after HMR errors |
| **Rspack** | Follows webpack HMR API. Known bug where HMR fails after recovering from errors in lazy compilation |

**No bundler has built-in "keep the app working when source files are broken."** This is universally left to the developer.

### 7. Is there a Vite plugin that does this?

**No.** Searched npm, GitHub, and the Vite plugin ecosystem. Closest related plugins:

| Plugin | What it does | Blocks HMR? |
|--------|-------------|-------------|
| `vite-plugin-checker` | TypeScript/ESLint errors in overlay + terminal | No — runs async, HMR already applied by the time errors are reported |
| `@visulima/vite-overlay` | Rich error display with source maps | No — display only |
| `@hiogawa/vite-runtime-error-overlay` | Runtime errors in Vite's overlay | No — display only |

A custom plugin is required.

## Recommended Approach

**Layered defense — three layers, increasing effort:**

### Layer 1: `awaitWriteFinish` (30 min)

Add to `vite.config.ts`:

```typescript
server: {
  watch: {
    awaitWriteFinish: {
      stabilityThreshold: 200,
      pollInterval: 50,
    }
  }
}
```

Prevents HMR from triggering on half-written files. Low-effort, no downsides at 200ms threshold. Catches the "agent's write syscall hasn't flushed yet" case.

### Layer 2: HMR gate plugin with syntax validation (2-4 hours)

Custom Vite plugin using `handleHotUpdate` that:
1. Parses changed files with esbuild before allowing HMR
2. Suppresses HMR on syntax errors (returns `[]`)
3. Sends a custom WebSocket event so the dashboard can show "agent editing, waiting for valid code..." indicator
4. Debounces rapid changes (300ms window) to avoid flashing
5. Optionally: only activate when an orka agent session has the dashboard project as its `projectPath` (query daemon via RPC)

This is the highest-impact change and covers the primary failure mode (syntax errors from mid-edit saves).

### Layer 3: Strengthen ErrorBoundary for runtime errors (1-2 hours)

- Add `@hiogawa/vite-runtime-error-overlay` or equivalent to surface runtime errors in the Vite overlay (not just the console)
- Ensure ErrorBoundary wraps all route-level components, not just the root
- Add retry-on-HMR: listen for `vite:afterUpdate` custom event and auto-retry the error boundary when fresh code arrives

### What NOT to do

- **Service worker caching** — impractical for Vite's unbundled dev mode, causes more problems than it solves
- **Full module state snapshots** — no framework support, would require reversing arbitrary side effects
- **`vite-plugin-checker` to block HMR** — it runs async and cannot block the HMR pipeline
- **Switching bundlers** — no bundler handles this better

## Alternative Approaches Considered

### A. Disable HMR entirely when agent is editing

Set `server.hmr: false` dynamically via the daemon when a session targets the dashboard project. Re-enable on session completion, then trigger a full reload.

- **Pro**: Zero risk of mid-edit breakage
- **Con**: User loses live updates entirely during agent work. No gradual feedback. Must manually reload after.
- **Effort**: 1-2 hours (daemon RPC + Vite plugin to toggle)

### B. Run agent on a separate Vite dev server

Agent edits a worktree copy. Dashboard dev server watches the main copy. Agent's changes only reach the dashboard after merge.

- **Pro**: Complete isolation. Dashboard never sees intermediate states.
- **Con**: Already how background sessions work (worktrees). Only applies if someone runs an agent against the main working copy. Doesn't help for interactive/foreground sessions.

### C. iframe-based hot reload sandbox

Load the dashboard in an iframe. On HMR error, keep the parent frame's last-known-good iframe visible and retry in a hidden iframe.

- **Pro**: True visual rollback
- **Con**: High complexity. Breaks WebSocket connections, React Query cache, routing. Doubles memory usage.
- **Effort**: 8-16 hours, fragile

## References

- [Vite HMR API](https://vite.dev/guide/api-hmr)
- [Vite Plugin API — handleHotUpdate](https://vite.dev/guide/api-plugin)
- [Vite Server Options](https://vite.dev/config/server-options)
- [Vite hotUpdate hook (Vite 6+)](https://vite.dev/changes/hotupdate-hook)
- [chokidar `awaitWriteFinish`](https://github.com/paulmillr/chokidar)
- [vite-plugin-checker](https://github.com/fi3ework/vite-plugin-checker)
- [Vite error overlay — runtime errors request (Issue #2076)](https://github.com/vitejs/vite/issues/2076)
- [Vite error overlay — auto-save flashing (Issue #13220)](https://github.com/vitejs/vite/issues/13220)
- [webpack HMR API](https://webpack.js.org/api/hot-module-replacement/)
- [React Fast Refresh architecture (Next.js docs)](https://nextjs.org/docs/architecture/fast-refresh)
- [@hiogawa/vite-runtime-error-overlay](https://www.npmjs.com/package/@hiogawa/vite-runtime-error-overlay)
