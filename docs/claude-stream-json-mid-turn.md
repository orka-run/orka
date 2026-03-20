# Claude Code stream-json Mid-Turn Input Behavior

> Research date: 2026-03-20
> Claude Code version: 2.1.80
> Extends: [mid-turn-input-research.md](mid-turn-input-research.md) (2026-03-19)

## Summary

This document records empirical experiments on how Claude Code handles stdin input during an active turn in `--input-format stream-json` mode. The prior research doc theorized about pipe buffering; this doc tests what actually happens.

**Key corrections to prior research:**

1. ~~"It reads the next message only after the current turn completes"~~ — **Wrong.** Claude Code reads stdin continuously. Mid-turn messages are consumed during the turn, not buffered for later.
2. ~~"Data written to stdin while Claude Code is busy processing a turn simply accumulates in the pipe buffer"~~ — **Partially wrong.** Data does accumulate in the pipe buffer, but Claude Code reads it *during* the turn and delivers it to the model alongside the tool result.
3. The prior doc's recommendation (queue at orchestrator level) is **correct** but for different reasons than stated.

---

## Protocol Recap

Claude Code is invoked with:
```
claude -p --verbose --output-format stream-json --input-format stream-json \
  --permission-mode bypassPermissions
```

Input messages are newline-delimited JSON:
```json
{"type":"user","message":{"role":"user","content":"..."},"parent_tool_use_id":null}
```

Each turn produces: `system:init` → `assistant` events → `result` event.

---

## Experiment Results

### 1. Between-Turns Messaging (stdin open)

**Setup:** Send msg1, wait for result, send msg2. stdin stays open.

**Result:** Both messages processed as separate turns. Each gets `init` → `assistant` → `result`.

```
07:29:24 >>> SEND: "Say exactly: BETWEEN_TURN_1"
07:29:24 system:init
07:29:25 assistant:text "BETWEEN_TURN_1"
07:29:25 result: subtype=success turns=1
07:29:26 >>> SEND: "Say exactly: BETWEEN_TURN_2"
07:29:26 system:init
07:29:28 assistant:text "BETWEEN_TURN_2"
07:29:28 result: subtype=success turns=1
```

**Finding:** Multi-turn works correctly between turns. Each message = separate turn with its own init/result cycle. Process waits for more input after each result (stdin open).

### 2. Pre-Queued Messages (both in buffer before processing)

**Setup:** Send two messages immediately, then close stdin.

**Result:** Both processed sequentially as separate turns.

```
07:26:34 >>> SEND: "Say exactly: QUEUED_MSG_1"
07:26:34 >>> SEND: "Say exactly: QUEUED_MSG_2"
>>> CLOSE STDIN
07:26:46 system:init
07:26:46 assistant:text "QUEUED_MSG_1"
07:26:46 result: subtype=success turns=1
07:26:46 system:init
07:26:46 assistant:text "QUEUED_MSG_2"
07:26:46 result: subtype=success turns=1
```

**Finding:** Messages queued in the pipe buffer are consumed one at a time, each as a separate turn. Works regardless of whether stdin is open or closed.

### 3. Pre-Queued Messages (stdin stays open)

**Setup:** Send two messages immediately, stdin stays open.

**Result:** Same as #2 — both processed sequentially.

```
07:30:25 >>> SEND: "Say exactly: PREQUEUE_C_1"
07:30:25 >>> SEND: "Say exactly: PREQUEUE_C_2"
07:30:26 system:init
07:30:28 assistant:text "PREQUEUE_C_1"
07:30:28 result: subtype=success turns=1
07:30:28 system:init
07:30:31 assistant:text "PREQUEUE_C_2"
07:30:31 result: subtype=success turns=1
```

**Finding:** stdin open vs closed doesn't matter for pre-queued messages. Both are processed.

### 4. Mid-Turn Message During Tool Execution (stdin OPEN) — THE CRITICAL TEST

**Setup:** Send task requiring `sleep 8`, wait for `tool_use` event, then send user message while Bash is sleeping. stdin stays open.

**Result:** Mid-turn message is absorbed into the current turn. NOT queued for a separate turn.

```
07:36:09 >>> SEND: "Run: sleep 8 && echo TASK_E_DONE"
07:36:09 system:init
07:36:12 assistant:tool_use Bash(sleep 8 && echo TASK_E_DONE)
07:36:14 >>> SEND: "IMPORTANT: Say exactly MIDTURN_E_RECEIVED"  [during sleep]
07:36:20 user: "tool_result(TASK_E_DONE)"  [sleep finished after 8s]
07:36:22 assistant:text "Command completed successfully, outputting TASK_E_DONE."
07:36:22 result: subtype=success turns=2
[process exits — mid-turn message NEVER became a separate turn]
```

**Finding:** The tool ran to completion (full 8 seconds). Only 1 result event. The mid-turn message was consumed but NOT processed as a separate turn. The model's response only mentions the tool output, not the mid-turn message.

### 5. Mid-Turn Message Verified with --replay-user-messages — SMOKING GUN

**Setup:** Same as #4 but with `--replay-user-messages` flag, which echoes consumed stdin messages back on stdout.

**Result:** Proves the mid-turn message IS read by Claude Code and delivered to the model:

```
07:39:45 >>> SEND: "Run: sleep 6 && echo TASK_G_DONE"
07:39:45 system:init
07:39:48 user: "Run: sleep 6 && echo TASK_G_DONE"    ← initial msg echoed
07:39:48 assistant:tool_use Bash(sleep 6 && echo TASK_G_DONE)
07:39:50 >>> SEND: "Say exactly: MIDTURN_G_RECEIVED"  [during sleep]
07:39:54 user: "tool_result(TASK_G_DONE)"             ← tool result
07:39:54 user: "Say exactly: MIDTURN_G_RECEIVED"      ← mid-turn msg echoed AT SAME TIME as tool result
07:39:56 assistant:text "Command completed successfully, outputting TASK_G_DONE."
07:39:56 result: subtype=success turns=2
```

**Finding:** The mid-turn message is echoed back **at the exact same time** as the tool result. Claude Code reads it from stdin during tool execution, then delivers both the tool result and the user message to the model in the same API call. The model sees both but focuses on the tool result. The message is **consumed** — it never becomes a separate turn.

### 6. Mid-Turn Message During Model Generation (before tool_use)

**Setup:** Send task, then immediately (500ms) send mid-turn message before the model emits tool_use.

**Result:** Same behavior as #4 — message absorbed into current turn.

```
07:37:59 >>> SEND: "Run: sleep 6 && echo TASK_F_DONE"
07:37:59 system:init
07:37:59 >>> SEND: "OVERRIDE: Say exactly MIDTURN_F_RECEIVED"  [during model generation]
07:38:02 assistant:tool_use Bash(sleep 6 && echo TASK_F_DONE)
07:38:09 user: "tool_result(TASK_F_DONE)"
07:38:11 assistant:text "Command completed successfully, outputting TASK_F_DONE."
07:38:11 result: subtype=success turns=2
```

**Finding:** Mid-turn messages sent during model generation (before tool_use) are also absorbed. The model ignores them in favor of the tool execution path.

### 7. Mid-Turn Message + stdin Close

**Setup:** Send task, wait for tool_use, send mid-turn message, close stdin immediately after.

**Result:** Different behavior — tool appears to be backgrounded, mid-turn message processed as separate turn.

```
07:30:08 assistant:tool_use Bash(sleep 6)
07:30:08 system:task_started              ← task tracking event (50ms after tool_use!)
07:30:08 user: "tool_result"              ← empty tool result (tool hasn't finished)
07:30:08 >>> SEND: mid-turn msg
07:30:08 >>> STDIN CLOSED
07:30:13 assistant: "Running in the background..."
07:30:13 result: turns=2                  ← first turn done
07:30:13 system:init                      ← new turn
07:30:19 assistant: "MID_TURN_B_RECEIVED" ← mid-turn msg processed!
07:30:19 result: turns=1                  ← second turn done
07:30:19 system:task_notification         ← background task completed
07:30:19 system:init                      ← new turn
07:30:25 assistant: "TASK_B_DONE"         ← background result reported
07:30:25 result: turns=1                  ← third turn done
```

**Finding:** When stdin closes after a mid-turn message during tool execution, Claude Code may background the running tool, emit a partial/empty tool result, let the model respond, then process the mid-turn message as a separate turn. When the backgrounded tool completes, it triggers another turn. This produced **3 result events** vs 1 in experiments #4/#5. However, this behavior was only observed once and may depend on exact timing or be non-deterministic.

### 8. SIGINT During Tool Execution

**Setup:** Send task, wait for tool_use, send SIGINT 4s into tool execution.

**Result:** Immediately aborts the current turn. Process exits.

```
07:22:22 >>> SEND: "Run: sleep 10 && echo SHOULD_NOT_SEE_THIS"
07:22:23 system:init
07:22:26 >>> SIGINT
07:22:26 user: (tool result, likely partial/error)
07:22:26 result: subtype=error_during_execution is_error=false turns=3
[process exits immediately]
```

**Finding:** SIGINT kills the Bash subprocess, the model gets an interrupted tool result, emits a result with `subtype=error_during_execution`, and the process exits. The `turns=3` suggests the model may have attempted recovery internally before giving up.

### 9. SIGINT + Follow-Up Message

**Setup:** Send task, SIGINT at 4s, send follow-up message at 8s, close stdin.

**Result:** Follow-up message NOT processed. Process exits after SIGINT result.

```
07:31:01 >>> SEND: "Run: sleep 15"
07:31:04 assistant:tool_use Bash
07:31:05 >>> SIGINT
07:31:05 result: subtype=error_during_execution
07:31:05 >>> SEND: "POST_SIGINT_D" (to dead/exiting process)
[process already exited]
```

**Finding:** After SIGINT, the process exits immediately. It does NOT drain the stdin queue. Follow-up messages are lost.

### 10. {type:"interrupt"} and {type:"cancel"} Messages

**Setup:** Send task, wait for tool_use, then send `{"type":"interrupt"}` or `{"type":"cancel"}`.

**Result:** Completely ignored. Tool continues executing normally.

```
# interrupt:
07:23:21 system:init
07:23:24 >>> SEND: {"type":"interrupt"}
07:23:25 assistant:tool_use Bash(sleep 10)
07:23:35 tool completes normally
07:23:36 result: subtype=success

# cancel:
07:23:45 system:init
07:23:48 >>> SEND: {"type":"cancel"}
07:23:49 assistant:tool_use Bash(sleep 10)
07:23:59 tool completes normally
07:24:01 result: subtype=success
```

**Finding:** Claude Code only recognizes `{type:"user"}` messages on stdin. `{type:"interrupt"}` and `{type:"cancel"}` are silently ignored. There is no stdin-based interruption mechanism.

### 11. Closing stdin (EOF) Without User Message, During Tool Execution

**Setup:** Send task, close stdin 4s into tool execution (no user message).

**Result:** Tool continues to completion. Process exits after result.

```
07:24:09 >>> SEND: "Run: sleep 10 && echo EOF_TEST"
07:24:09 system:init
07:24:13 >>> CLOSE STDIN (4s into tool execution)
07:24:14 assistant:tool_use Bash(sleep 10)
07:24:24 user: tool_result (10s later — tool ran to completion)
07:24:29 assistant: "Output: EOF_TEST"
07:24:29 result: subtype=success
```

**Finding:** EOF (stdin close) alone does NOT interrupt tool execution. The tool runs to completion, the model responds, and then the process exits (no more input to read).

### 12. --replay-user-messages Flag

**Setup:** Send simple message with `--replay-user-messages` flag.

**Result:** User message is echoed back on stdout before the assistant response.

```
07:26:49 system:init
07:26:49 user: "Say exactly: REPLAY_TEST"   ← echoed
07:26:49 assistant:text "REPLAY_TEST"
07:26:49 result: subtype=success
```

**Finding:** `--replay-user-messages` causes Claude Code to emit consumed user messages as `{type:"user"}` events on stdout. This is essential for debugging — it reveals exactly when and how messages are consumed by Claude Code.

---

## Behavioral Model

Based on all experiments, Claude Code's stdin handling works as follows:

### Message Reading

Claude Code has an internal stdin reader that continuously reads newline-delimited JSON from the pipe. Messages are consumed from the buffer as soon as they're complete (newline-terminated).

### During a Turn

When a turn is active (model generating or tool executing):
1. User messages arriving on stdin are **read immediately** from the pipe buffer
2. They are held in an internal queue
3. When the next model API call happens (e.g., after tool result), **all pending user messages are included** in that API call alongside the tool result
4. The model sees both the tool result and the user messages, but typically prioritizes the tool result
5. The user message is **consumed** — it does NOT become a separate turn

### Between Turns

When the previous turn has completed (result event emitted):
1. Claude Code reads the next message from stdin
2. If a message is available, it starts a new turn (init → assistant → result)
3. If stdin is closed (EOF) and no messages remain, the process exits
4. If stdin is open and no messages are available, the process waits for more input

### SIGINT

SIGINT is the only interruption mechanism:
1. Kills any running tool subprocess
2. The model gets an interrupted/error tool result
3. Model may attempt internal recovery (observed turns=3 in results)
4. Emits `result` with `subtype=error_during_execution`
5. Process exits immediately — stdin queue is NOT drained

### stdin Close (EOF)

When stdin closes during a turn:
- If no user messages are pending: tool continues to completion, then process exits
- If user messages are pending: behavior is complex and may involve backgrounding the current tool (observed once in experiment #7, not consistently reproduced)

---

## Implications for Orka

### Current Design is Correct

The orchestrator's approach of queuing at the Orka level (not writing to stdin mid-turn) is the **right design**, but for different reasons than previously documented:

**Previously thought:** "Messages buffer in the OS pipe and get consumed at the next turn boundary."
**Actually:** Messages are consumed mid-turn and absorbed into the current turn's context. They do NOT become separate turns.

If Orka wrote to stdin mid-turn:
- The message would be silently absorbed into the model's current context
- The model would likely ignore it (focusing on tool results)
- The message would be consumed — no second turn would be created
- The user's intent (a new follow-up question) would be lost

### SIGINT for Turn Cancellation

`interruptTurn()` in the adapter correctly uses `proc.kill("SIGINT")`. However:
- After SIGINT, the process exits — it cannot process follow-up messages
- If we want to cancel a turn AND continue the session, we'd need to restart the process
- The adapter's `sendTurn()` method would need a new process after SIGINT

### No stdin-Based Cancel Protocol

There is no `{type:"interrupt"}` or `{type:"cancel"}` message type. These are silently ignored. The only cancellation mechanism is SIGINT.

### Agent SDK Priority Field

The SDK's `SDKUserMessage` has a `priority` field (`"now" | "next" | "later"`). This hints at future protocol support for prioritized delivery. Currently:
- `"now"` might eventually support true mid-turn injection (like Codex's `turn/steer`)
- The current CLI implementation does not appear to honor this field

### Potential Future: True Mid-Turn Injection

To truly inject a message mid-turn (not just absorb it), we'd need either:
1. **Agent SDK V2 API** with explicit mid-turn support
2. **Codex's `turn/steer`** method (already exists, not yet in Orka)
3. **Claude Code protocol update** adding an interrupt/steer message type

---

## Experiment Script

All experiments were run with Bun scripts spawning Claude Code as a subprocess. The test scripts are at:
- `/tmp/mid-turn-experiment.ts` (round 1: basic mid-turn, SIGINT, message types, EOF)
- `/tmp/mid-turn-exp2.ts` (round 2: without -p, pre-queued, replay-user-messages)
- `/tmp/mid-turn-exp3.ts` (round 3: between-turns, mid-turn+close, pre-queued+open, SIGINT+follow-up)
- `/tmp/mid-turn-exp4.ts` (round 4: tool execution vs model generation, --replay-user-messages proof)

### Quick Reproduction

```bash
# Verify mid-turn absorption (experiment G):
bun -e '
const p = Bun.spawn(["claude","-p","--verbose","--output-format","stream-json",
  "--input-format","stream-json","--replay-user-messages",
  "--permission-mode","bypassPermissions","--tools","Bash","--no-session-persistence"],
  {stdin:"pipe",stdout:"pipe",stderr:"pipe",cwd:"/tmp",
   env:{...process.env,CLAUDECODE:undefined}});
// Send task
p.stdin.write(JSON.stringify({type:"user",message:{role:"user",content:"Run: sleep 5 && echo DONE"},parent_tool_use_id:null})+"\n");
// Wait for tool to start, then send mid-turn
setTimeout(()=>{
  p.stdin.write(JSON.stringify({type:"user",message:{role:"user",content:"MIDTURN_TEST"},parent_tool_use_id:null})+"\n");
},4000);
// Close stdin after tool should finish
setTimeout(()=>p.stdin.end(),15000);
const r=p.stdout.getReader(),d=new TextDecoder();
(async()=>{let b="";while(true){const{value,done}=await r.read();if(done)break;b+=d.decode(value,{stream:true});
while(b.includes("\\n")){const i=b.indexOf("\\n");const l=b.slice(0,i).trim();b=b.slice(i+1);
if(l)try{const j=JSON.parse(l);if(j.type==="user")console.log("USER:",JSON.stringify(j.message?.content).slice(0,80));
if(j.type==="result")console.log("RESULT:",j.subtype,j.num_turns);}catch{}}}})()'
```

---

## Summary Table

| Scenario | Behavior | Result Events | Mid-Turn Msg Processed? |
|----------|----------|---------------|------------------------|
| Between turns | Separate turn | 1 per message | ✅ As new turn |
| Pre-queued (before init) | Sequential turns | 1 per message | ✅ As new turn |
| Mid-turn, stdin open | Absorbed into current turn | 1 total | ❌ Consumed, lost |
| Mid-turn, stdin closed | May background tool | 3 total | ✅ As new turn (flaky) |
| SIGINT | Abort + exit | 1 (error) | N/A |
| SIGINT + follow-up | Abort + exit | 1 (error) | ❌ Process already exited |
| {type:"interrupt"} | Ignored | 1 (normal) | ❌ Not recognized |
| {type:"cancel"} | Ignored | 1 (normal) | ❌ Not recognized |
| EOF during tool | Tool continues | 1 | N/A |
| --replay-user-messages | Echoes consumed msgs | N/A | Debug tool |
