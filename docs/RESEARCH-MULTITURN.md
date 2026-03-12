# Research: Multi-Turn Claude Code Sessions

## Summary

There are **three viable approaches** for multi-turn Claude Code conversations from a Bun/Node.js process, ranging from least to most effort. **Approach 1 (Agent SDK)** is the clear winner for our use case.

---

## Approach 1: `@anthropic-ai/claude-agent-sdk` (RECOMMENDED)

**Package**: `@anthropic-ai/claude-agent-sdk@0.2.74` (published 2026-03-11, same version as CLI)

The Agent SDK is a proper programmatic wrapper around Claude Code. It spawns Claude Code as a child process (using the bundled `cli.js`) and communicates via stdin/stdout using `stream-json` protocol internally.

### Key APIs

#### `query()` — V1 API (Stable)

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// Single-turn
const q = query({
  prompt: "Read all .ts files in src/",
  options: {
    cwd: "/path/to/project",
    permissionMode: "auto",
    model: "claude-sonnet-4-6",
    allowedTools: ["Read", "Glob", "Grep", "Bash", "Edit", "Write"],
    effort: "high",
    resume: "previous-session-uuid",     // Resume existing session
    sessionId: "pre-assigned-uuid",       // Pre-assign session ID
    maxTurns: 50,
    maxBudgetUsd: 5.0,
  }
});

// q is AsyncGenerator<SDKMessage, void>
for await (const msg of q) {
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        console.log("Session:", msg.session_id);
        console.log("Model:", msg.model);
      }
      break;
    case "assistant":
      // msg.message is a BetaMessage (Anthropic SDK type)
      break;
    case "result":
      console.log("Cost:", msg.total_cost_usd);
      console.log("Usage:", msg.usage);
      break;
  }
}
```

**Multi-turn with `query()`**: Use `resume` to chain sessions:

```typescript
// Turn 1
let sessionId: string;
for await (const msg of query({ prompt: "Analyze the auth module", options })) {
  if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
  if (msg.type === "result") break;
}

// Turn 2 — resumes with full context
for await (const msg of query({
  prompt: "Now refactor the parts you identified",
  options: { ...options, resume: sessionId }
})) { ... }
```

**Multi-turn with `streamInput()`**: The `Query` object has a `streamInput()` method for pushing messages without restarting the process:

```typescript
const q = query({
  prompt: "Initial prompt",
  options: { ... }
});

// Later, send follow-up messages
await q.streamInput(async function*() {
  yield {
    type: "user",
    message: { role: "user", content: "Follow-up question" },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}());
```

#### `unstable_v2_createSession()` — V2 API (Alpha, Multi-Turn Native)

```typescript
import { unstable_v2_createSession, unstable_v2_resumeSession } from "@anthropic-ai/claude-agent-sdk";

// Create a persistent session
const session = unstable_v2_createSession({
  model: "claude-sonnet-4-6",
  permissionMode: "auto",
  allowedTools: ["Read", "Glob", "Grep", "Bash", "Edit", "Write"],
});

// Send first message
await session.send("Analyze the auth module");

// Stream responses
for await (const msg of session.stream()) {
  // Process messages...
  if (msg.type === "result") break;
}

// Send follow-up — same process, full context preserved
await session.send("Now refactor the parts you identified");

for await (const msg of session.stream()) {
  if (msg.type === "result") break;
}

// Clean up
session.close();

// Resume later
const resumed = unstable_v2_resumeSession(session.sessionId, { model: "claude-sonnet-4-6" });
await resumed.send("Continue from where we left off");
```

### SDK Type: `SDKSession` (V2)

```typescript
interface SDKSession {
  readonly sessionId: string;
  send(message: string | SDKUserMessage): Promise<void>;
  stream(): AsyncGenerator<SDKMessage, void>;
  close(): void;
  [Symbol.asyncDispose](): Promise<void>;
}
```

### SDK Type: `Query` (V1) — Key Control Methods

```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  close(): void;
  // ... plus various MCP, hook, and introspection methods
}
```

### Pros
- **First-party, maintained by Anthropic** — same release cadence as CLI
- **Full event stream** — all SDKMessage types (assistant, tool_progress, result, etc.)
- **Session management built-in** — `resume`, `sessionId`, `listSessions()`, `getSessionMessages()`
- **Process lifecycle managed** — spawn, abort, kill handled internally
- **Permission callbacks** — `canUseTool` callback for programmatic approval/denial
- **Hook system** — full hook support for pre/post tool use, etc.
- **Custom MCP servers** — `createSdkMcpServer()` for in-process MCP tools
- **Custom spawn function** — `spawnClaudeCodeProcess` option for running in VMs/containers
- **Embeddable** — `@anthropic-ai/claude-agent-sdk/embed` for compiled Bun binaries

### Cons
- **V2 multi-turn API is `@alpha` / `UNSTABLE`** — may change
- **V1 `query()` multi-turn requires `resume` (separate process per turn)** — each turn spawns a new CLI process that replays the session from disk
- **56MB package** — includes full CLI binary, ripgrep, tree-sitter
- **Node 18+ required**
- **`zod/v4` peer dependency** (already in our stack)

### Compatibility with Orka

The SDK's `SpawnedProcess` interface matches Node.js ChildProcess. For Bun:
- `Bun.spawn()` returns a compatible-enough object
- The SDK's `spawnClaudeCodeProcess` option lets us override the spawn function entirely

### Key Insight: Process Model

The SDK spawns Claude Code CLI as a subprocess using `--input-format stream-json --output-format stream-json`. It communicates via stdin/stdout JSON lines. Each `query()` call is a separate process by default — but `streamInput()` and the V2 `SDKSession.send()` allow sending multiple messages to the same process without restarting.

---

## Approach 2: CLI `--resume` + `--output-format stream-json`

Use the CLI directly without the SDK, chaining sessions via `--resume`:

```bash
# Turn 1: Start session with explicit session-id
UNSET CLAUDECODE && claude -p "Analyze auth module" \
  --output-format stream-json \
  --session-id "550e8400-e29b-41d4-a716-446655440000" \
  --permission-mode auto \
  --verbose

# Turn 2: Resume with follow-up
UNSET CLAUDECODE && claude -p "Refactor what you found" \
  --output-format stream-json \
  --resume "550e8400-e29b-41d4-a716-446655440000" \
  --permission-mode auto \
  --verbose
```

Each turn spawns a separate `claude` process that reads the session from `~/.claude/projects/.../` and replays context.

### Pros
- **Zero dependencies** — just the CLI binary
- **Simple** — extend existing `ClaudeCodeAdapter` with resume flag
- **Compatible with current architecture** — minimal changes to orchestrator

### Cons
- **Each turn = new process + session replay** — startup cost per turn
- **Session state depends on `~/.claude/` filesystem** — coupling to Claude Code internals
- **No `streamInput()`** — can't send messages while a turn is in progress
- **Limited control** — no permission callbacks, no interrupt-and-continue

### Implementation Sketch

```typescript
// In ClaudeCodeAdapter:
async sendTurn(handle: ProviderSessionHandle, input: ProviderTurnInput): Promise<void> {
  const claudeSessionId = handle.meta.claudeSessionId; // UUID format
  const args = [
    "claude", "-p",
    "--verbose", "--output-format", "stream-json",
    "--permission-mode", "auto",
    "--resume", claudeSessionId,
    input.message,
  ];
  // Spawn new process, pipe events to same AsyncEventQueue
}
```

---

## Approach 3: `--input-format stream-json` (Single Long-Running Process)

Keep a single Claude Code process alive and send messages via stdin using `stream-json` input format:

```bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --permission-mode auto
```

Then write JSON messages to stdin:
```json
{"type":"user","message":{"role":"user","content":"First message"},"parent_tool_use_id":null,"session_id":"..."}
```

This is essentially what the SDK does internally with `streamInput()`.

### Pros
- **Single process** — no startup cost per turn
- **Real-time** — messages sent immediately
- **Full context** — no session replay needed

### Cons
- **Undocumented stdin protocol** — must reverse-engineer from SDK source (sdk.mjs)
- **Complex state management** — must track when agent is idle vs busy
- **Must handle control protocol** — permission requests, hook callbacks, etc.
- **Fragile** — protocol may change without notice

---

## Approach 4: Direct Anthropic API (No Claude Code)

Use `@anthropic-ai/sdk` directly with tool definitions, implementing our own tool execution loop.

### Pros
- **Full control** — complete ownership of the conversation loop
- **No external processes** — everything in-process
- **Predictable** — no CLI version skew issues

### Cons
- **Massive effort** — must re-implement all of Claude Code's tool execution
  - File editing (multi-step edit with context matching)
  - Glob/Grep (with ripgrep integration)
  - Bash execution (with sandboxing, timeout, etc.)
  - MCP server management
  - Permission system
  - Context management and compaction
- **No CLAUDE.md support** — would need to implement ourselves
- **No session persistence** — would need our own transcript format
- **Maintenance burden** — must track Anthropic API changes

**Verdict**: Not viable for our use case. We need Claude Code's tool ecosystem.

---

## Recommendation for Orka

### Short-term (Immediate): Approach 2 — CLI `--resume`

Modify `ClaudeCodeAdapter` to support `sendTurn()` by:
1. Store a Claude Code session UUID (mapped from Orka session ID)
2. On first `startSession()`, use `--session-id <uuid>`
3. On `sendTurn()`, spawn a new process with `--resume <uuid> --output-format stream-json`
4. Pipe events from new process into the existing `AsyncEventQueue`

This requires minimal changes to the existing adapter and orchestrator.

### Medium-term: Approach 1 — Agent SDK `query()` with `resume`

Replace the raw CLI spawn with the Agent SDK:
1. `npm install @anthropic-ai/claude-agent-sdk`
2. Use `query()` for initial turn with `sessionId` option
3. Use `query()` with `resume` option for follow-up turns
4. Use SDK's `canUseTool` callback for permission handling
5. Map `SDKMessage` events to `ProviderRuntimeEvent`

Benefits over raw CLI:
- Proper process lifecycle management
- Permission callback support
- Hook system integration
- Session management utilities (`listSessions`, `getSessionMessages`)

### Long-term: Approach 1 — Agent SDK V2 `SDKSession`

When the V2 API stabilizes:
1. Use `unstable_v2_createSession()` for new sessions
2. Use `session.send()` / `session.stream()` for multi-turn
3. Use `unstable_v2_resumeSession()` for recovering after daemon restart
4. Single process per session, no replay overhead

---

## Key Types for Integration

```typescript
// SDKMessage — the event stream (same as current stream-json output)
type SDKMessage =
  | SDKAssistantMessage    // Assistant response with BetaMessage
  | SDKUserMessage         // User input
  | SDKResultMessage       // Turn result (success or error) with cost/usage
  | SDKSystemMessage       // Init, status, hooks, tasks, etc.
  | SDKPartialAssistantMessage  // Streaming chunks (if includePartialMessages)
  | SDKToolProgressMessage      // Tool execution progress
  | SDKTaskNotificationMessage  // Background task status
  | SDKTaskProgressMessage      // Task progress with optional AI summary
  // ... plus rate limit, hook, compact, auth events

// User message format for streamInput / SDKSession.send()
type SDKUserMessage = {
  type: "user";
  message: MessageParam;           // { role: "user", content: string | ContentBlock[] }
  parent_tool_use_id: string | null;
  session_id: string;
  priority?: "now" | "next" | "later";
};

// Result message — always emitted at end of turn
type SDKResultSuccess = {
  type: "result";
  subtype: "success";
  result: string;
  total_cost_usd: number;
  usage: { input_tokens, output_tokens, cache_read_input_tokens, ... };
  modelUsage: Record<string, ModelUsage>;  // Per-model breakdown
  num_turns: number;
  duration_ms: number;
  session_id: string;
};
```

---

## Install

```bash
# In project root:
bun add @anthropic-ai/claude-agent-sdk
```

Note: The package is 19MB compressed / 56MB uncompressed (includes CLI binary, ripgrep, tree-sitter wasm). For the `embed` export (compiled Bun binaries), it extracts the CLI to a temp dir at runtime.

---

## References

- Package: https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
- Source: https://github.com/anthropics/claude-agent-sdk-typescript
- Docs: https://platform.claude.com/docs/en/agent-sdk/overview
- CLI docs: https://code.claude.com/docs/en/headless.md
- Types: `sdk.d.ts` (119KB, fully typed — see extracted copy in `package/sdk.d.ts`)
