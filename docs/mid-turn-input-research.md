# Mid-Turn Input Research

> Research date: 2026-03-19

## Question

What happens when a user sends input to an agent session that is currently mid-turn (actively processing)? How do Claude Code and Codex handle this at the protocol level, and what should the dashboard UX look like?

---

## 1. Claude Code: stdin Behavior During Active Turn

### Protocol

Claude Code runs with `--input-format stream-json --output-format stream-json`. Input is written to stdin as newline-delimited JSON:

```json
{"type":"user","message":{"role":"user","content":"message text"},"parent_tool_use_id":null}
```

### How Orka writes to stdin

In `claude-adapter.ts`, `sendTurn()` (lines 220-233) writes directly to the process stdin pipe — no buffering, no state checks:

```typescript
async sendTurn(handle, input) {
  const meta = getClaudeHandleMeta(handle);
  meta.turnId = generateId("turn");
  const msg = JSON.stringify({ type: "user", message: { role: "user", content: input.input ?? "" }, parent_tool_use_id: null }) + "\n";
  meta.rawEvents.push({ direction: "in", data: msg.trimEnd(), ts: new Date().toISOString() });
  await Promise.resolve(meta.stdinWriter.write(msg));
}
```

**However, Orka's orchestrator never calls this during an active turn.** When the session status is `running`, the orchestrator queues the message in memory instead (see Section 3).

### What Claude Code does with stdin data mid-turn

Claude Code reads stdin in a loop, consuming one JSON message at a time. **It reads the next message only after the current turn completes.** The stdin pipe is an OS-level buffer (typically 64KB on Linux). Data written to stdin while Claude Code is busy processing a turn simply accumulates in the pipe buffer until Claude Code reads it.

This means:
- **Writing to stdin mid-turn is safe** — it won't crash or error.
- **The message is not processed until the current turn finishes** — it sits in the pipe buffer.
- **If multiple messages are written, they queue in pipe order** and are consumed one at a time.

The Agent SDK's `SDKUserMessage` type includes a `priority` field (`"now" | "next" | "later"`) that hints at future protocol support for prioritized message delivery, but the current CLI implementation processes messages sequentially.

### Turn boundary detection

Claude Code emits a `result` event at the end of each turn. On the next stdin read, it emits a new `system:init` event, which Orka maps to `session.started` → `turn.started`. The adapter detects this re-init pattern (lines 733-761) and generates new turn IDs automatically.

### Key insight

**Claude Code's stdin is a dumb pipe.** There is no handshake, no acknowledgment, no rejection. If you write during a turn, the data buffers in the OS pipe and gets consumed at the next turn boundary. Orka doesn't rely on this — it queues at the orchestrator level instead — but the underlying mechanism is safe.

---

## 2. Codex: `turn/start` During Active Turn

### Protocol

Codex runs as a JSON-RPC 2.0 server (`codex app-server`) over stdio. Multi-turn is via `turn/start` requests:

```json
{"id":"codex-rpc-2","method":"turn/start","params":{"threadId":"...","input":[{"type":"text","text":"...","text_elements":[]}]}}
```

### What happens if `turn/start` is called during an active turn

Codex's app-server is a request/response JSON-RPC server. Calling `turn/start` while a turn is active returns a **JSON-RPC error response**:

```json
{"id":"codex-rpc-2","error":{"code":-32000,"message":"Turn already active"}}
```

The `CodexAdapter.startTurn()` method (lines 380-403) sends the request and awaits the response. If Codex rejects, the promise rejects, and the error propagates up.

**Orka's orchestrator prevents this** by queuing messages when status is `running` (see Section 3).

### `turn/steer`: Mid-turn injection (not yet implemented)

Codex has a dedicated `turn/steer` method for injecting input during an active turn:

```json
{"id":"codex-rpc-3","method":"turn/steer","params":{"threadId":"...","input":[{"type":"text","text":"...","text_elements":[]}],"expectedTurnId":"..."}}
```

This is a first-class mid-turn input mechanism:
- `expectedTurnId` must match the currently active turn (prevents races)
- The input is injected into the agent's context immediately
- The agent sees the new input and can adjust its behavior mid-turn

**Orka does not currently use `turn/steer`.** It could be wired up for a "truly immediate" send mode, but the queuing approach works for now.

### Key insight

**Codex has two distinct paths:**
- `turn/start` — new turn, rejected if one is active
- `turn/steer` — mid-turn injection, first-class protocol support

---

## 3. Orka Orchestrator: The Queuing Layer

### How `sendTurnToSession()` works

In `orchestrator.ts` (lines 697-754), `sendTurnToSession()` branches on session status:

| Status | Behavior |
|--------|----------|
| `running` | **Queue** message in `ctx.sessionRuntime.pendingMessages`, emit `user.input` event with `queued: true` |
| `idle` | **Send immediately** via `providerService.sendTurn()`, emit `user.input` event |
| `rate_limited` / `hibernated` / `completed` / `failed` / `cancelled` | **Resume** session (spawn new process), then send |
| `preparing` / `queued` | **Reject** — throw error |

### Queue storage

```typescript
// daemon-context.ts
interface SessionRuntimeState {
  pendingMessages: Map<string, string[]>;  // sessionId → queued messages
}
```

### Queue delivery

When a turn completes, the consumer callback `deliverPendingMessages` fires (`consumer.ts` lines 49-50, 253):

1. Check if `pendingMessages[sessionId]` has entries
2. Join all queued messages with `"\n\n"` separator
3. Send as a single `providerService.sendTurn()` call
4. Clear the queue
5. Transition session back to `running`
6. Skip auto-merge (the session is continuing)

### Event emission

```typescript
function emitUserInputEvent(ctx, sessionId, text, provider, queued = false) {
  const event = {
    type: "user.input",
    sessionId,
    text,
    timestamp: new Date().toISOString(),
    ...(queued ? { queued: true } : {}),
  };
  ctx.db.insertOrchestrationEvent({ ...event, provider, eventId: generateId("evt") });
  ctx.pushHub.broadcast("orchestration.event", event);
}
```

**Queued messages get a `user.input` event immediately** (persisted to SQLite and broadcast via WebSocket), but with `queued: true` flag.

---

## 4. Dashboard: Current Queued Message UX

### How queued messages appear today

In `eventsToEntries.ts` (lines 646-658):
- `user.input` events become `UserEntry` objects in the timeline
- If `event.queued`, the entry gets `queued: true`
- These entries are tracked in `pendingQueuedEntryIds` set

In `MessageEntry.tsx` (lines 27-31):
- Queued entries show a subtitle: *"Queued - will be delivered when agent finishes current task"*
- They appear in the timeline at their creation timestamp (i.e., when the user sent them)

### When the queued flag is cleared

In `eventsToEntries.ts` (lines 342-358, 405-420, 615-618):
1. On `turn.completed`, set `queuedMessagesReadyForDelivery = true`
2. On next activity event (`turn.started`, `content.delta`, `item.started`, etc.), clear `queued` flag from all pending entries
3. The message then renders as a normal user message without the "Queued" subtitle

### Input state derivation

`useInputState.ts` derives the input composer state from `allowedActions` and event timeline:

| State | Condition | UX |
|-------|-----------|-----|
| `not_started` | No events yet, `sendTurn` not allowed | Placeholder: "Session is starting..." |
| `disabled` | `sendTurn` not in `allowedActions` | Placeholder: "Session completed" |
| `busy` | `sendTurn` allowed, turn is open | Placeholder: "Send a message..." (editable) |
| `waiting` | `sendTurn` allowed, no open turn | Placeholder: "Send a follow-up message..." |

**Users CAN type and send while agent is `busy`** — the input is editable in both `busy` and `waiting` states. The placeholder changes to signal the state, but input is always enabled.

---

## 5. The UX Problem: Queued Messages in Timeline

### The issue

When a user sends a message while the agent is busy:
1. The message appears **immediately in the timeline** as a `user.input` entry
2. It has a "Queued" subtitle, but visually it's mixed in with the agent's ongoing work
3. The agent hasn't seen this message yet — it's sitting in Orka's queue
4. This creates a false impression that the agent received and is considering the message

### How messaging apps handle this

**Slack, Discord, iMessage, WhatsApp** — all show messages in the timeline immediately. Messages are always "sent" (delivered to server) as soon as the user hits enter. There's no concept of "queued for later delivery."

But the analogy doesn't apply cleanly:
- In chat apps, the server delivers the message immediately to the recipient
- In Orka, the daemon received the message, but the agent process won't consume it until the current turn finishes
- The "recipient" (agent) genuinely hasn't seen it yet

**Email** is a closer analogy: you send an email, it shows in "Sent", but the recipient hasn't read it. Email clients don't mix sent-but-unread emails into the recipient's response thread.

### Options

#### Option A: Keep current behavior (messages in timeline with "Queued" badge)

**Pros:**
- Chronological timeline is preserved
- User can see what they sent and when
- Simple implementation (current state)

**Cons:**
- Visually confusing — message appears mid-stream of agent output
- Looks like the agent is ignoring the message
- The "Queued" subtitle is small and easy to miss

#### Option B: Show queued messages above the input (pending queue)

Display queued messages in a separate area between the timeline and the input composer — like a "drafts shelf" or "pending messages" section.

```
┌─────────────────────────────┐
│ Timeline                     │
│ [agent output streaming...]  │
│                              │
├─────────────────────────────┤
│ Pending (1 message)          │
│ ┌───────────────────────┐   │
│ │ "Fix the tests too"   │ ✕ │
│ └───────────────────────┘   │
├─────────────────────────────┤
│ [input composer]             │
└─────────────────────────────┘
```

**Pros:**
- Clear visual separation between "delivered" and "pending"
- User can cancel pending messages before delivery
- No confusion about agent seeing the message

**Cons:**
- New UI component needed
- Messages jump from pending area into timeline when delivered — jarring transition
- More complex state management

#### Option C: Show in timeline only when delivered

Queue message in memory, don't add to timeline. When the turn completes and the message is delivered, then insert the `user.input` entry into the timeline.

**Pros:**
- Timeline only shows messages the agent has actually received
- Clean, no visual noise during agent's turn
- No confusing "queued" state in timeline

**Cons:**
- User has no visual confirmation that their message was received by the daemon
- If they close the tab and come back, queued messages are invisible
- Feels like the send button did nothing
- Need separate feedback for "message queued" (toast? composer state?)

#### Option D: Hybrid — toast confirmation + timeline on delivery

1. User sends message while agent is busy
2. Toast notification: "Message queued — will be delivered when agent finishes"
3. Composer clears, returns to editable state
4. Message does NOT appear in timeline yet
5. When turn completes and message is delivered, it appears in timeline as a normal user message

**Pros:**
- Clear feedback loop (toast = acknowledged, timeline = delivered)
- Timeline stays clean and truthful
- No jumping messages between UI areas

**Cons:**
- Toast is ephemeral — miss it and you might not know your message is queued
- Extra implementation (toast system)

#### Option E: Timeline with delivery state (recommended)

Keep messages in timeline (Option A) but improve the visual treatment:

1. Queued messages render with a distinct visual style — muted/dimmed, smaller, with a visible "clock" icon and "Queued" badge
2. A thin separator line above queued messages: `── Pending delivery ──`
3. When delivered, the message transitions to full-opacity normal style
4. The separator disappears

```
┌─────────────────────────────┐
│ [agent output streaming...]  │
│                              │
│ ── Queued ─────────────────  │
│ ░░ "Fix the tests too"   ░░ │ (dimmed/muted style)
│                              │
│ [input composer]             │
└─────────────────────────────┘
```

**Pros:**
- Messages are in the timeline (chronological truth)
- Visual separation makes queued state obvious at a glance
- No jumping between UI areas
- Smooth transition: dimmed → full on delivery
- Works with persistent storage (queued messages are already in DB)
- No new UI components needed — just CSS styling + separator

**Cons:**
- Still appears in the timeline stream, which some might find confusing
- Need to handle the transition animation

---

## 6. Recommendations

### For the adapter layer

**No changes needed.** Both adapters work correctly:
- Claude Code: stdin pipe buffers safely, but the orchestrator queues instead of writing mid-turn
- Codex: `turn/start` would reject mid-turn, but orchestrator queues instead

### For mid-turn injection (future)

Codex's `turn/steer` provides a genuine mid-turn injection mechanism. If we want "immediate delivery" (not queued), we could:
1. Add `steerTurn(handle, input)` to the `ProviderAdapter` interface
2. Implement it for Codex using `turn/steer`
3. For Claude Code, write to stdin (it buffers in pipe, picked up at next read point — not truly immediate but fast)
4. Add a `--immediate` flag to `orka send` that uses steer instead of queue

This is a separate feature from the queuing UX question.

### For dashboard UX

**Recommend Option E (timeline with delivery state):**
- Keeps messages in the timeline for persistence and chronological ordering
- Uses strong visual separation (dimmed style + separator) to indicate "pending"
- Smooth transition to normal style on delivery
- No new UI areas or components — just enhanced rendering in `MessageEntry.tsx`

Implementation would touch:
- `MessageEntry.tsx` — conditional styling for `entry.queued`
- `eventsToEntries.ts` — already tracks `pendingQueuedEntryIds`, add separator entry
- CSS — dimmed/muted treatment for queued messages

---

## 7. Summary Table

| Aspect | Claude Code | Codex |
|--------|------------|-------|
| Mid-turn write | Safe (OS pipe buffer) | Rejected (`turn/start` errors) |
| Mid-turn injection | Not supported | `turn/steer` (not yet in Orka) |
| Orka handling | Orchestrator queues, delivers after turn | Same |
| Multiple queued messages | Joined with `\n\n`, sent as one turn | Same |
| Event emission | Immediate `user.input` with `queued: true` | Same |
| Agent sees message | After current turn completes | After current turn completes |
