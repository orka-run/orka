# Event Rendering Audit — Dashboard ChatView

Audit of all orchestration event types, tool calls, subagent types, and content streams
against dashboard rendering in `ChatView.tsx`, `ToolCallDetails.tsx`, and related components.

Data source: 63,043 orchestration events across ~50 recent sessions (Claude Code + Codex backends).

---

## Section 1: Complete Event Catalog

### Orchestration Event Types

| Event Type | Count | Rendered As | Status |
|---|---|---|---|
| `content.delta` | 42,254 | Assistant text (accumulated) | Partial — see gaps |
| `item.started` | 10,200 | ToolEntry (if no matching completed) | OK |
| `item.completed` | 9,823 | ToolEntry (enriched from started meta) | OK |
| `session.started` | 174 | Skipped (noisy) | OK |
| `turn.started` | 172 | Skipped (noisy) | OK |
| `turn.completed` | 158 | System entry with cost/tokens | OK |
| `session.completed` | 129 | System entry "Session completed" | OK |
| `session.state.changed` | 108 | **Not rendered** | Gap |
| `session.failed` | 15 | Error entry "Session failed" | OK |
| `session.cancelled` | 10 | System entry "Session cancelled" | OK |
| `user.input` | 4 | User message entry | OK |
| `runtime.error` | 1 | Error entry "Runtime error" | OK |
| `runtime.warning` | 0 (schema exists) | System entry "Warning" | OK |
| `request.opened` | 0 (schema exists) | ApprovalCard | OK |
| `request.resolved` | 0 (schema exists) | Skipped (processed in first pass) | OK |
| `event.passthrough` | 0 (schema exists) | System entry with originalType | OK |
| `session.created` | 0 (skipped by ingestion) | Skipped (noisy) | OK |
| `tool.progress` | 0 (schema exists) | **Not rendered** | Gap |
| `item.updated` | 0 (schema exists) | Skipped | OK |

### Item Types (from item.started + item.completed)

| Item Type | Count | Icon | Rendered | Notes |
|---|---|---|---|---|
| `command_execution` | 6,653 | `command` (TerminalSquare) | OK | Title shows command |
| `file_read` | 4,208 | `read` (Eye) | OK | Title shows file path |
| `file_change` | 3,013 | `file` (FileCode2) | OK | Title shows "Edit/Write path" |
| `reasoning` | 2,404 | `command` (default fallback) | Poor | No dedicated icon, appears as tool call |
| `search` | 1,586 | `search` (Search) | OK | Grep/Glob tool calls |
| `assistant_message` | 1,179 | `command` (default fallback) | Poor | Should not be shown as tool entry |
| `unknown` | 696 | `command` (default fallback) | Poor | Includes TodoWrite, Grep, Glob, etc. |
| `agent` | 174 | `agent` (Bot) | Partial | Title shows but no subagent details |
| `user_message` | 86 | `command` (default fallback) | Poor | Should not be shown as tool entry |
| `web` | 24 | `web` (Globe) | OK | Title shows URL |
| `mcp_tool_call` | 0 (schema exists) | `command` (default fallback) | No icon | Would fall through to default |
| `error` | 0 (schema exists) | `command` (default fallback) | No icon | Would fall through to default |

### Content Stream Kinds (content.delta)

| Stream Kind | Count | Rendered | Notes |
|---|---|---|---|
| `assistant_text` | 40,016 | Accumulated into assistant message | OK |
| `command_output` | 1,989 | **Silently dropped** | Gap — not shown anywhere |
| `file_change_output` | 249 | **Silently dropped** | Gap — not shown anywhere |
| `reasoning_text` | 0 (from Codex) | Accumulated into assistant message | Mixed with assistant text |
| `unknown` | 0 | Not handled | Would be silently dropped |

### Session States (session.state.changed)

| State | Count | Rendered | Notes |
|---|---|---|---|
| `running` | 43 | Not rendered | Event silently dropped |
| `ready` | 36 | Not rendered | Event silently dropped |
| `stopped` | 28 | Not rendered | Event silently dropped |
| `error` | 1 | Not rendered | Event silently dropped |

### Raw Claude Code Event Types (from .raw.jsonl)

| Raw Type | Count | Mapped? | Notes |
|---|---|---|---|
| `assistant` (tool_use) | ~5,000 | Yes → item.started | OK |
| `assistant` (text) | ~2,000 | Yes → content.delta | OK |
| `assistant` (thinking) | ~13 blocks | **Not mapped** | Thinking blocks are lost |
| `user` (tool_result) | ~5,546 | **Not mapped** | Tool output is lost |
| `system/init` | 98 | Yes → session.started | OK |
| `system/task_started` | 88 | **Not mapped** | Subagent start lost |
| `system/task_progress` | 2,121 | **Not mapped** | Subagent progress lost |
| `system/task_notification` | 88 | **Not mapped** | Subagent completion lost |
| `system/hook_started` | 99 | **Not mapped** | Hook events lost |
| `system/hook_response` | 99 | **Not mapped** | Hook events lost |
| `system/status` | 8 | **Not mapped** | Compaction status lost |
| `system/compact_boundary` | 4 | **Not mapped** | Compaction boundary lost |
| `rate_limit_event` | 93 | **Not mapped** | Rate limit info lost |
| `result/success` | 93 | Yes → turn.completed + session.exited | OK |

### Raw Codex Event Types (from .raw.jsonl)

| Raw Method | Count | Mapped? | Notes |
|---|---|---|---|
| `item/agentMessage/delta` | 808 | Yes → content.delta | OK |
| `item/started` | 109 | Yes → item.started | OK |
| `item/completed` | 105 | Yes → item.completed | OK |
| `item/commandExecution/outputDelta` | 5 | Yes → content.delta (command_output) | But then dropped in dashboard |
| `item/commandExecution/terminalInteraction` | 2 | **Not mapped** | Interactive stdin lost |
| `turn/plan/updated` | 2 | **Not mapped** | Agent plan/steps lost |
| `thread/tokenUsage/updated` | 20 | Stored in meta, not emitted | Usage integrated into turn.completed |
| `codex/event/*` | ~1,800 | Skipped (duplicate Codex internal events) | OK — intentional |

### Claude Code Tool Names (from raw logs)

| Tool Name | Count | Maps to itemType | Notes |
|---|---|---|---|
| Read | 2,146 | `file_read` | OK |
| Bash | 1,228 | `command_execution` | OK |
| Edit | 830 | `file_change` | OK |
| Grep | 568 | `search` | OK |
| Glob | 229 | `search` | OK |
| Write | 148 | `file_change` | OK |
| Agent | 88 | `agent` | OK |
| TodoWrite | 81 | `unknown` | Gap — no dedicated mapping |
| ToolSearch | 15 | `unknown` | Gap — no dedicated mapping |
| AskUserQuestion | 12 | `unknown` | Gap — no dedicated mapping |
| WebFetch | 12 | `web` | OK |
| TaskOutput | 2 | `unknown` | Gap — no dedicated mapping |

---

## Section 2: Rendering Status

### Event Types

| Type | Status | Notes |
|---|---|---|
| `content.delta` (assistant_text) | ✅ Rendered well | Accumulated, markdown-rendered |
| `content.delta` (reasoning_text) | ⚠️ Needs improvement | Mixed into assistant text, no visual distinction |
| `content.delta` (command_output) | ❌ Not rendered | Silently dropped — real-time command output lost |
| `content.delta` (file_change_output) | ❌ Not rendered | Silently dropped — edit confirmation lost |
| `item.started` / `item.completed` | ✅ Rendered well | Tool cards with icons, grouping, expand/collapse |
| `item.started` (reasoning) | ⚠️ Poor rendering | Shows as "Reasoning" tool card with terminal icon |
| `item.started` (assistant_message) | ⚠️ Poor rendering | Shows as tool card instead of being invisible |
| `item.started` (user_message) | ⚠️ Poor rendering | Shows as tool card instead of being invisible |
| `item.started` (unknown → TodoWrite) | ⚠️ Poor rendering | Shows with generic terminal icon |
| `item.started` (unknown → AskUserQuestion) | ⚠️ Poor rendering | No dedicated rendering |
| `item.started` (agent) | ⚠️ Needs improvement | Shows agent title but no subagent details |
| `turn.completed` | ✅ Rendered well | Cost and token usage shown |
| `session.completed` | ✅ Rendered well | Clean completion message |
| `session.failed` | ✅ Rendered well | Error styling with details |
| `session.cancelled` | ✅ Rendered well | Cancellation message |
| `session.state.changed` | ❌ Not rendered | Silently dropped by default case |
| `tool.progress` | ❌ Not rendered | Silently dropped by default case |
| `runtime.error` | ✅ Rendered well | Error card with message |
| `runtime.warning` | ✅ Rendered well | Warning system entry |
| `request.opened` | ✅ Rendered well | Approval card with approve/deny |
| `event.passthrough` | ✅ Rendered (basic) | Shows raw JSON payload |
| `user.input` | ✅ Rendered well | User message bubble |

### Tool Call Details

| Detail Kind | Status | Notes |
|---|---|---|
| Read (file content) | ✅ Good | Line numbers parsed, path shown |
| Edit (file changes) | ✅ Good | Diff detection, color-coded lines |
| Command (bash output) | ✅ Good | Command + output separated |
| Search (grep/glob) | ✅ Good | Query + results parsed |
| Web (fetch results) | ⚠️ Basic | Falls through to default rendering |
| Agent (subagent) | ⚠️ No details | No subagent output/progress shown |
| Args display | ✅ Good | Key-value pairs with expandable long values |

### Markdown Rendering

| Feature | Status | Notes |
|---|---|---|
| Headers (h1-h4) | ✅ Styled | Different sizes and weights |
| Lists (ul/ol) | ✅ Styled | Proper indentation and markers |
| Code blocks | ✅ Syntax highlighted | rehype-highlight with github theme |
| Inline code | ✅ Styled | Border + background |
| Links | ✅ Styled | Accent color with underline |
| Tables | ✅ Styled | Border-collapse with dividers |
| Blockquotes | ✅ Styled | Left border + italic |
| Images | ✅ Basic | max-width:100% |

---

## Section 3: Gap Analysis

### GAP-1: command_output and file_change_output streams silently dropped
**Priority: HIGH | Complexity: S**

`content.delta` events with `streamKind` of `"command_output"` (1,989 events) and `"file_change_output"` (249 events) are silently dropped. The `eventsToEntries()` function at line 280 only processes `assistant_text` and `reasoning_text` stream kinds.

**What's available:** Real-time output from command execution and file change operations streamed as deltas.

**Impact:** During a running session, users cannot see live command output or file change confirmations. They only see the final tool result (if captured in item.completed detail).

**Proposed fix:** Accumulate `command_output` deltas into the corresponding in-progress tool entry, showing a live output preview. For `file_change_output`, append to the tool entry's summary.

### GAP-2: Bug — terminal state tool cleanup uses wrong type string
**Priority: HIGH | Complexity: S**

Line 497 in `ChatView.tsx` checks `entry.type === "tool_group"` (underscore) but the actual ChatEntry type is `"tool-group"` (hyphen). This means the loop at lines 492-503 that clears `inProgress` flags when a session reaches terminal state **never matches any entries**.

**Impact:** Tool entries from crashed/cancelled sessions permanently show spinning loaders.

**Fix:** Change `"tool_group"` to `"tool-group"` on line 497.

### GAP-3: reasoning items rendered as tool cards
**Priority: MEDIUM | Complexity: S**

Codex emits `item.started`/`item.completed` with `itemType: "reasoning"` (2,404 events). These are rendered as tool cards with the default terminal icon. Reasoning is an internal model process, not a tool invocation.

**What's available:** Item title "Reasoning", status transitions.

**Proposed fix:** Either filter out reasoning items entirely (they don't add user value as tool cards), or show a subtle "thinking" indicator with a brain/sparkle icon instead of a tool card. The reasoning _content_ already flows through `content.delta` with `streamKind: "reasoning_text"`.

### GAP-4: assistant_message and user_message items rendered as tool cards
**Priority: MEDIUM | Complexity: S**

Codex emits `item.started`/`item.completed` with `itemType: "assistant_message"` (1,179 events) and `"user_message"` (86 events). These show as tool cards with terminal icons, but they represent messages, not tool calls.

**What's available:** Title "Assistant message" / "User message".

**Proposed fix:** Filter these out in `eventsToEntries()`. The actual message content arrives via `content.delta` and `user.input` events.

### GAP-5: unknown itemType for TodoWrite, Grep, Glob, AskUserQuestion, ToolSearch
**Priority: MEDIUM | Complexity: M**

696 items have `itemType: "unknown"`. Breakdown from item.started titles:
- TodoWrite: 79 events
- Grep: 64 events (should be `search`)
- Glob: 21+ events (should be `search`)
- AskUserQuestion: 12 events
- ToolSearch: 15 events
- Agent: 1 event (should be `agent`)
- Others with null titles: 487 (item.completed without matching started metadata)

**Root cause:** The Claude Code adapter's `mapClaudeToolItemType()` function only maps specific tool names. When Codex emits items or when item.completed arrives without matching item.started, the type falls to "unknown".

**Additionally:** 487 `item.completed` events have `itemType: "unknown"` and null title. These are completions for tools where the started event had a different itemType (e.g., `file_change`). The enrichment on line 321 tries to recover from started metadata, but sometimes the started event isn't available (e.g., events from before the dashboard connected).

**Proposed fix:**
1. In the adapter: add mappings for `TodoWrite` → `unknown` (or new `task` type), `AskUserQuestion` → new `user_input` type, `ToolSearch` → `search`, `TaskOutput` → `unknown`
2. In the dashboard: for `unknown` items with a title, infer the type from the title text (e.g., title starts with "Grep" → search icon)

### GAP-6: Subagent details not shown
**Priority: MEDIUM | Complexity: M**

Agent tool calls (174 events) show the agent title (e.g., "Agent: Explore dashboard structure") but provide no visibility into what the subagent did.

**What's available in raw logs:**
- `system/task_started`: subagent ID, description, prompt, tool_use_id
- `system/task_progress`: subagent tool usage, last_tool_name, running token/tool counts
- `system/task_notification`: subagent completion status, summary, final usage stats

**None of these are mapped to orchestration events.** The adapter only sees the `assistant` event with Agent tool_use and the `tool` event with the result.

**Proposed fix:**
1. **Short-term:** Show the agent `args` (which includes `prompt`, `subagent_type`, `description`) in the tool details pane
2. **Long-term:** Map `system/task_*` events to new orchestration events (e.g., `agent.started`, `agent.progress`, `agent.completed`) and render as nested timeline

### GAP-7: Claude Code thinking blocks not captured
**Priority: MEDIUM | Complexity: M**

Claude Code raw output includes `thinking` content blocks (with `type: "thinking"`, `thinking: "..."`, `signature: "..."`). These are present in ~13 raw events in the sampled session. The adapter does not extract or map these.

**What's available:** Extended reasoning text that Claude produces before responding. This is different from Codex's `reasoning_text` stream kind.

**Impact:** Users cannot see Claude's reasoning process in the dashboard.

**Proposed fix:** In the Claude adapter, when processing `assistant` messages, check for `thinking` content blocks and emit either:
- `content.delta` with `streamKind: "reasoning_text"`, or
- `item.started`/`item.completed` with `itemType: "reasoning"`

Then in the dashboard, render reasoning as a collapsible section (like a thinking bubble) rather than inline assistant text.

### GAP-8: reasoning_text mixed into assistant text
**Priority: LOW | Complexity: S**

When `content.delta` has `streamKind: "reasoning_text"`, it's accumulated into the same assistant message as `assistant_text` (line 280). There's no visual distinction between reasoning and final output.

**Proposed fix:** Maintain separate accumulators for reasoning vs assistant text. Render reasoning in a collapsible "Thinking" section with muted styling, separate from the main assistant response.

### GAP-9: tool.progress events not rendered
**Priority: LOW | Complexity: S**

The `tool.progress` event type exists in the schema (with `toolName`, `summary`, `elapsedSeconds`) but is never emitted by current adapters and has no rendering in the dashboard (silently falls through the default case at line 482).

**Impact:** None currently, but when progress events are emitted in the future, they'll be silently dropped.

**Proposed fix:** When `tool.progress` events arrive, update the matching in-progress tool entry's summary with the progress information. Could show elapsed time and progress description.

### GAP-10: session.state.changed not rendered
**Priority: LOW | Complexity: S**

108 `session.state.changed` events are silently dropped. These indicate transitions like `running → ready → stopped`.

**Impact:** The session header already shows status. However, state transitions within the chat timeline could be useful for debugging (e.g., seeing when the agent entered "waiting" state).

**Proposed fix:** Optionally render as subtle system entries showing state transitions. Could be behind a "verbose" toggle.

### GAP-11: Codex plan updates not captured
**Priority: LOW | Complexity: M**

Codex emits `turn/plan/updated` notifications with structured plan data including step-by-step plans with status tracking. These are not mapped to orchestration events.

**What's available:**
```json
{
  "explanation": "Context is loaded. Making the protocol/types change first...",
  "plan": [
    {"step": "Add protocol version types", "status": "in_progress"},
    {"step": "Wire daemon health payloads", "status": "pending"}
  ]
}
```

**Proposed fix:** Map to a new `turn.plan` orchestration event. Render as a plan card showing steps with checkmarks/status indicators.

### GAP-12: Rate limit events not captured
**Priority: LOW | Complexity: S**

93 `rate_limit_event` events in raw Claude Code logs are not mapped. They contain rate limit status, reset time, and overage information.

**What's available:** `rate_limit_info.status`, `resetsAt`, `rateLimitType`, `overageStatus`.

**Proposed fix:** Map to `runtime.warning` when rate-limited, or a new event type. Show as a system warning entry.

### GAP-13: Single-tool cards have no expandable details
**Priority: LOW | Complexity: S**

When a tool group has exactly 1 tool (line 1001-1012), it renders as a flat card with just the title — no expand/collapse for details. Multi-tool groups (2+) have expandable `<details>` elements per tool.

**Impact:** Users can't see tool input args or output details for standalone tool calls.

**Proposed fix:** Add a `<details>` element to single-tool cards that expands to show `ToolCallDetails`.

### GAP-14: Hook events not captured
**Priority: LOW | Complexity: S**

Claude Code emits `system/hook_started` and `system/hook_response` events (99 each). These show custom hooks running during the session (e.g., "SessionStart:startup").

**Proposed fix:** Map to system entries or a dedicated hook event type. Useful for debugging hook issues.

### GAP-15: Compaction events not captured
**Priority: LOW | Complexity: S**

Claude Code emits `system/status` (status: "compacting") and `system/compact_boundary` events when context compaction occurs. These are not mapped.

**Impact:** Users can't see when context was compacted, which affects understanding of agent behavior (context loss).

**Proposed fix:** Map to system entries showing "Context compacted" with pre-compaction token count.

---

## Section 4: Recommendations (Ordered by Impact)

### Immediate Fixes (1 session)

1. **GAP-2: Fix tool_group → tool-group typo** (line 497)
   - Bug fix, 1 character change
   - Fixes permanently-spinning tool loaders on terminal sessions

2. **GAP-4: Filter out assistant_message and user_message items**
   - Add itemType check in eventsToEntries() to skip these
   - Removes 1,265 meaningless tool cards

3. **GAP-3: Filter out or restyle reasoning items**
   - Skip `itemType === "reasoning"` in tool entry creation
   - Removes 2,404 redundant "Reasoning" tool cards

4. **GAP-13: Add expandable details to single-tool cards**
   - Wrap single-tool card in `<details>` element
   - Consistent UX with multi-tool groups

### Short-term Improvements (2-3 sessions)

5. **GAP-1: Render command_output and file_change_output streams**
   - Accumulate into tool entry detail or separate output section
   - Gives live feedback during tool execution

6. **GAP-5: Fix unknown itemType mappings**
   - Add adapter mappings for TodoWrite, AskUserQuestion, ToolSearch
   - Add dashboard title-based type inference as fallback
   - Better icons and labels for all tool types

7. **GAP-8: Separate reasoning_text from assistant_text**
   - Dual accumulator with collapsible "Thinking" section
   - Clearer distinction between reasoning and response

### Medium-term Improvements (dedicated effort)

8. **GAP-6: Subagent visibility**
   - Map system/task_* events to orchestration events
   - Nested timeline or expandable subagent section
   - Show subagent type, prompt summary, tool usage, and result

9. **GAP-7: Claude Code thinking blocks**
   - Adapter change to extract thinking blocks
   - Dashboard rendering with collapsible thinking section

10. **GAP-11: Codex plan updates**
    - New orchestration event type
    - Plan card with step tracking

### Low-priority (backlog)

11. **GAP-10: session.state.changed rendering** — optional verbose mode
12. **GAP-12: Rate limit events** — warning entry when rate-limited
13. **GAP-9: tool.progress** — future-proofing
14. **GAP-14: Hook events** — debugging aid
15. **GAP-15: Compaction events** — context debugging aid
