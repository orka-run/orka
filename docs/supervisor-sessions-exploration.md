# Supervisor Sessions — Meta-Agent Orchestration for Orka

## 1. Vision

### What is a Supervisor?

A supervisor is an agent session that doesn't write code itself but orchestrates other agents that do. It understands the project at a high level, breaks tasks into subtasks, spawns worker agents, monitors their progress, reviews their results, handles failures, and coordinates parallel work — all through Orka's existing APIs.

Think: tech lead who reads the codebase, writes tickets, assigns work to ICs, reviews PRs, resolves conflicts, and ships the feature.

### User Stories

**US-1: Feature Implementation**
> "I want to tell Orka 'implement OAuth2 login' and have it decompose the work into backend routes, frontend components, database migrations, and tests — spawn agents for each, coordinate their worktrees, merge results in order, and give me a final PR."

**US-2: Codebase-Wide Refactor**
> "I have 40 files that need to migrate from lodash to native JS. I want a supervisor that spawns 8 parallel agents, each handling 5 files, monitors for conflicts, retries failures, and merges everything cleanly."

**US-3: Incident Response**
> "Production is returning 500s on the /api/users endpoint. I want a supervisor that spawns one agent to analyze logs, one to reproduce locally, one to draft a fix, and one to write regression tests — coordinating them so each builds on the previous agent's findings."

**US-4: Multi-Repo Coordination**
> "I'm upgrading our shared protobuf schema. I need agents that update the schema repo, then fan out to update 4 downstream services, running their tests against the new schema."

**US-5: Continuous Integration Agent**
> "I want a supervisor that watches a branch, runs tests when PRs merge, spawns fix agents when tests fail, and posts results to Slack."

**US-6: Junior Developer Mentoring**
> "I'm onboarding a new dev. Set up a supervisor that reviews their PRs automatically: spawns agents to check style, test coverage, security issues, and architecture alignment, then synthesizes a single review comment."

---

## 2. What Orka Already Has

The supervisor pattern doesn't require a ground-up redesign. Orka's existing architecture provides most of the building blocks:

### Existing Primitives

| Primitive | Status | How Supervisors Use It |
|-----------|--------|----------------------|
| `parentSessionId` on SpawnRequest | Implemented | Supervisor spawns children with `--parent <own-id>` |
| `getChildSessions(id)` API | Implemented | Supervisor queries its children's statuses |
| `sendTurn(id, text)` | Implemented | Supervisor sends follow-up instructions to running agents |
| `getResult(id)` | Implemented | Supervisor reads worker output when done |
| `getDiff(id)` | Implemented | Supervisor reviews worker code changes |
| `merge(id)` | Implemented | Supervisor merges successful work |
| `stop(id)` | Implemented | Supervisor kills misbehaving workers |
| `captureOutput(id)` | Implemented | Supervisor reads live output |
| `listSessions(filters)` | Implemented | Supervisor monitors fleet state |
| `getSessionTimeline(params)` | Implemented | Supervisor inspects worker event history |
| Event broadcasting (PushHub) | Implemented | Real-time status updates for all sessions |
| Worktree isolation | Implemented | Each worker gets its own branch/worktree |
| Approval system | Implemented | Supervisor could auto-approve worker requests |
| Idle/hibernate lifecycle | Implemented | Workers auto-hibernate when waiting; resume on input |
| Config limits (max_concurrent) | Implemented | Prevents runaway spawning |
| Tags | Implemented | Group related worker sessions |

### The Gap

What's missing is not the API surface — it's the **agent-side integration**. Today's agents run inside Claude Code or Codex, which have no awareness of Orka. A supervisor needs:

1. **Access to Orka APIs** from within an agent session
2. **A prompt framework** that teaches the agent how to be a supervisor
3. **Safety rails** against runaway spawning, infinite loops, and budget overruns
4. **Result aggregation** — structured way to collect and synthesize worker outputs

---

## 3. Architecture Options

### Option A: CLI-in-Path (Zero Infrastructure)

The simplest approach: the supervisor is a normal agent session that happens to have the `orka` CLI in its PATH. It calls `orka spawn`, `orka wait`, `orka result`, etc. as bash commands.

```
┌─────────────────────────────────────┐
│         Supervisor Session          │
│  (Claude Code / Codex agent)        │
│                                     │
│  Agent uses Bash tool to run:       │
│    orka spawn --parent $SELF ...    │
│    orka wait sess-xxx sess-yyy      │
│    orka result sess-xxx             │
│    orka diff sess-xxx               │
│    orka merge sess-xxx              │
│    orka send sess-xxx "fix the bug" │
│                                     │
│  System prompt teaches supervisor   │
│  patterns and best practices        │
└──────────────┬──────────────────────┘
               │ Bash: orka <cmd>
               ▼
┌──────────────────────────────────────┐
│           Daemon (RPC)               │
│  Handles spawn, wait, result, etc.  │
│  Tracks parent-child relationships  │
└──────────┬──────────┬───────────────┘
           │          │
     ┌─────▼──┐  ┌───▼─────┐
     │Worker 1│  │Worker 2 │  ...
     │(agent) │  │(agent)  │
     └────────┘  └─────────┘
```

**Pros:**
- Zero new code (supervisor is just a well-prompted session)
- Works today — the orka CLI is available in worktrees
- Uses battle-tested CLI semantics
- Agents already know how to use bash commands
- Full feature set via CLI (spawn, wait, diff, merge, send, result, ps)

**Cons:**
- CLI invocation overhead (~100ms per command, spawns new process)
- No streaming/push — supervisor polls with `orka ps` or blocks on `orka wait`
- Error messages are text, not structured
- Supervisor needs `ORKA_SESSION_ID` env var to know its own ID for `--parent`
- No type safety — supervisor constructs CLI strings

**Implementation cost:** ~50 LOC (env var injection + system prompt template)

### Option B: MCP Server (Structured Tool Access)

Expose Orka's OrkaService as an MCP (Model Context Protocol) server. Claude Code natively supports MCP tools, so the supervisor agent sees Orka operations as first-class tools alongside Bash, Read, Edit, etc.

```
┌─────────────────────────────────────┐
│         Supervisor Session          │
│  (Claude Code agent)                │
│                                     │
│  Agent uses MCP tools:              │
│    orka_spawn(prompt, backend, ...) │
│    orka_wait(ids)                   │
│    orka_result(id)                  │
│    orka_diff(id)                    │
│    orka_merge(id)                   │
│    orka_send(id, text)              │
│    orka_ps(status, tag)             │
│                                     │
└──────────────┬──────────────────────┘
               │ MCP (stdio/SSE)
               ▼
┌──────────────────────────────────────┐
│         MCP Server (orka)            │
│  Thin wrapper over OrkaService      │
│  Structured inputs/outputs          │
│  Auto-sets parentSessionId          │
└──────────────┬───────────────────────┘
               │ WS JSON-RPC
               ▼
┌──────────────────────────────────────┐
│           Daemon (RPC)               │
└──────────┬──────────┬───────────────┘
           │          │
     ┌─────▼──┐  ┌───▼─────┐
     │Worker 1│  │Worker 2 │  ...
     └────────┘  └─────────┘
```

**Pros:**
- Structured input/output (JSON, not CLI text parsing)
- Auto-inject parentSessionId — no env var needed
- Can expose richer operations (e.g., stream results, batch operations)
- Works with Claude Code's native MCP tool calling
- Better error handling (structured error types vs exit codes)
- Can rate-limit or gate operations at the MCP layer

**Cons:**
- Requires implementing an MCP server (~500-800 LOC)
- Only works with Claude Code (Codex has no MCP support)
- MCP tool definitions need careful schema design
- Another process to manage (though could be stdio-based, launched by Claude Code)
- MCP is still evolving — API surface may change

**Implementation cost:** ~800 LOC (MCP server + tool definitions + daemon client)

### Option C: Supervisor Adapter (Native Provider)

Create a new `ProviderAdapter` implementation (`SupervisorAdapter`) that runs a purpose-built orchestration loop rather than delegating to Claude Code or Codex. The supervisor is Orka-native.

```
┌──────────────────────────────────────┐
│      Supervisor Session (native)     │
│                                      │
│  Orchestration loop:                 │
│    1. Analyze prompt → plan          │
│    2. For each subtask:              │
│       spawn worker, track state      │
│    3. Wait for workers               │
│    4. Evaluate results               │
│    5. Merge / retry / escalate       │
│    6. Synthesize final result        │
│                                      │
│  Uses LLM for decisions (via API)    │
│  Uses OrkaService for operations     │
└──────────┬──────────┬───────────────┘
           │          │
     ┌─────▼──┐  ┌───▼─────┐
     │Worker 1│  │Worker 2 │  ...
     │(claude)│  │(codex)  │
     └────────┘  └─────────┘
```

**Pros:**
- Full control over orchestration logic
- Can implement sophisticated strategies (dependency graphs, rollback, checkpoints)
- Direct access to OrkaService — no CLI overhead, no MCP layer
- Can use different LLMs for planning vs execution
- Can implement custom retry/escalation logic
- Tightest possible integration with Orka's event system

**Cons:**
- Most code to write (~2000-3000 LOC)
- Reinvents agent reasoning (prompt engineering, tool calling, context management)
- Harder to debug — custom orchestration loop vs well-understood agent
- Tightly coupled to Orka — can't benefit from Claude Code improvements
- New adapter = new testing surface

**Implementation cost:** ~2500 LOC (adapter + orchestration loop + LLM client + prompt templates)

### Option D: Hybrid — CLI-in-Path + Supervisor System Prompt (Recommended)

Start with Option A (CLI-in-Path) but invest in a rich system prompt and a thin env/context layer. This gets 80% of the value for 10% of the cost, and the system prompt can evolve independently.

```
┌──────────────────────────────────────────┐
│          Supervisor Session              │
│  (Claude Code agent with orka in PATH)   │
│                                          │
│  Env vars:                               │
│    ORKA_SESSION_ID=sess-abc123           │
│    ORKA_ROLE=supervisor                  │
│    ORKA_MAX_CHILDREN=10                  │
│    ORKA_BUDGET_USD=5.00                  │
│                                          │
│  System prompt:                          │
│    - Supervisor role & responsibilities  │
│    - orka CLI reference (spawn, wait...) │
│    - Patterns: fan-out, pipeline, map    │
│    - Safety rules (depth, budget, loops) │
│    - Result evaluation guidelines        │
│                                          │
│  Workflow:                               │
│    1. Read project, understand task      │
│    2. Plan subtasks                      │
│    3. orka spawn --parent $SELF ...      │
│    4. orka wait <ids>                    │
│    5. orka result <id> / orka diff <id>  │
│    6. Evaluate, retry or merge           │
│    7. Report summary                     │
└──────────────┬──────────────────────────┘
               │ Bash: orka <cmd>
               ▼
┌──────────────────────────────────────┐
│           Daemon (RPC)               │
│  + supervisor safety checks:         │
│    - max children per parent         │
│    - max depth (no supervisor→sup)   │
│    - budget tracking per tree        │
└──────────┬──────────┬───────────────┘
           │          │
     ┌─────▼──┐  ┌───▼─────┐
     │Worker 1│  │Worker 2 │  ...
     └────────┘  └─────────┘
```

**Pros:**
- Minimal code — mostly system prompt engineering
- Leverages Claude Code's full capabilities (file reading, git, tests)
- Supervisor can also write code when appropriate (hybrid role)
- Easy to iterate on behavior by editing prompts
- MCP server (Option B) can be added later as an optimization
- Works today with existing infrastructure

**Cons:**
- CLI overhead per operation
- Relies on agent following prompt instructions (no hard enforcement)
- System prompt can be large (increases cost per turn)
- No structured result types — agent parses CLI output

**Implementation cost:** ~200 LOC (env injection + safety checks) + system prompt template

### Comparison Matrix

| Dimension | A: CLI Raw | B: MCP | C: Native | D: Hybrid |
|-----------|:----------:|:------:|:---------:|:---------:|
| Implementation cost | ~50 LOC | ~800 LOC | ~2500 LOC | ~200 LOC |
| Time to first demo | 1 hour | 1 week | 2-3 weeks | 1 day |
| Structured I/O | No | Yes | Yes | No |
| Works with Codex | Yes | No | N/A | Yes |
| Safety enforcement | None | Medium | High | Medium |
| Debugging | Easy (bash) | Medium | Hard | Easy |
| Extensibility | Low | High | Highest | Medium |
| Prompt dependency | High | Medium | Low | High |

---

## 4. Unique Features Orka Can Offer

These are capabilities that emerge from Orka's architecture that competitors can't easily replicate:

### 4.1 Worktree-Isolated Parallelism

Every worker agent gets its own git worktree with a named branch. Workers can make commits, run tests, and modify files without interfering with each other. The supervisor merges results in dependency order.

**Why this matters:** CrewAI, AutoGen, and Swarm all share a single filesystem. Two agents editing the same file creates race conditions. Orka's worktree model eliminates this entirely.

**Supervisor pattern:**
```
Supervisor: "Implement OAuth2"
  ├── Worker 1 (orka/sess-aaa): database migration     → branch: orka/sess-aaa
  ├── Worker 2 (orka/sess-bbb): backend routes          → branch: orka/sess-bbb
  ├── Worker 3 (orka/sess-ccc): frontend components     → branch: orka/sess-ccc
  └── Worker 4 (orka/sess-ddd): integration tests       → branch: orka/sess-ddd

Merge order: 1 → 2 → 3 → 4 (respecting dependencies)
```

### 4.2 Mid-Flight Steering

`sendTurn()` lets the supervisor send instructions to a **running** worker. Not just "start over" but "adjust your approach while you work."

**Example:**
```bash
# Supervisor notices Worker 2 is using JWT tokens
# but the architecture decision is to use opaque tokens
orka send sess-bbb "Stop — use opaque tokens, not JWTs. See docs/auth-decisions.md"
```

**Why this matters:** Most multi-agent systems treat tasks as fire-and-forget. Once spawned, you wait for completion or kill. Mid-flight correction reduces wasted work and token spend.

### 4.3 Live Output Monitoring

The supervisor can stream worker output via `orka logs -f <id>` or read it via `captureOutput()`. This enables the supervisor to detect problems early — before the worker finishes.

**Pattern: Early termination**
```bash
# Supervisor watches Worker 3's output
output=$(orka logs sess-ccc 2>&1)
if echo "$output" | grep -q "FAIL.*test"; then
  orka stop sess-ccc
  # Spawn replacement with adjusted prompt
  orka spawn --parent $ORKA_SESSION_ID "Implement frontend OAuth component.
    NOTE: Previous attempt failed tests. Error was: ..."
fi
```

### 4.4 Conflict Detection Before Merge

The supervisor can check `orka diff` on multiple workers before merging, detecting conflicts proactively. If Worker 2 and Worker 3 both modified `src/auth/types.ts`, the supervisor can:
1. Merge Worker 2 first
2. Send Worker 3 a message: "Rebase on the latest; Worker 2 already modified types.ts"
3. Wait for Worker 3 to resolve, then merge

**Why this matters:** No other multi-agent system has built-in conflict detection because none use git worktrees for isolation.

### 4.5 Cost-Aware Orchestration

`orka result <id>` returns `costUsd`, `inputTokens`, `outputTokens`. The supervisor can track cumulative spend and make budget-aware decisions:

```
Budget: $10.00
├── Worker 1: $0.82 (completed)
├── Worker 2: $1.45 (completed)
├── Worker 3: $2.10 (running, estimated $3.50 based on similar tasks)
└── Remaining: $4.13
    → "Enough for 1 more Opus worker or 3 Sonnet workers"
    → Supervisor chooses Sonnet for remaining tasks
```

### 4.6 Heterogeneous Workers

The supervisor can spawn workers on different backends and models based on task complexity:

```bash
# Complex architecture work → Opus
orka spawn --backend claude-code --model opus "Design the auth middleware"

# Repetitive file updates → Sonnet
orka spawn --backend claude-code --model sonnet "Update imports in src/utils/*.ts"

# Fast, parallel tests → Codex
orka spawn --backend codex --reasoning-effort high "Run and fix failing tests in packages/api"
```

### 4.7 Fleet-Aware Scheduling

In multi-machine mode, the supervisor can route tasks to specific nodes:

```bash
# GPU-intensive ML work → GPU node
orka spawn --node gpu-node-1 "Train the classifier on the new dataset"

# Standard code work → any node (auto-scheduled)
orka spawn "Refactor the API endpoints"
```

### 4.8 Approval Delegation

In supervised mode, the supervisor can auto-approve worker requests based on its understanding of the task, reducing human approval burden. Worker asks "Can I run `npm install`?" → Supervisor evaluates the context and approves via `resolveApproval()`.

This is a natural extension of the existing approval system. The supervisor acts as a middle layer between human oversight and agent autonomy.

### 4.9 Session Continuation for Iterative Refinement

Orka supports session resume (`sendTurn` to hibernated/completed sessions). A supervisor can:
1. Spawn Worker A for initial implementation
2. Read Worker A's result
3. Send Worker A a follow-up: "Good, but add error handling for X"
4. Worker A resumes with full context of its previous work

This is more efficient than spawning a new worker, because the continued session retains its conversation history and file context.

### 4.10 Event-Sourced Observability

Every worker's lifecycle is captured as orchestration events (turn.started, item.completed, session.exited). The supervisor — or a human reviewing later — can reconstruct exactly what happened, in what order, and why.

**Post-mortem pattern:** If a supervisor run fails at step 4 of 7, a human can:
1. `orka show <supervisor-id>` — see the supervisor's state
2. `orka result <supervisor-id>` — read what the supervisor decided
3. For each child: `orka result <child-id>` — see what each worker produced
4. Timeline reconstruction via `getSessionTimeline()` — full event log

---

## 5. Interaction with Existing Features

### 5.1 Workspaces

Supervisors and their workers should all belong to the same workspace. When workspace-level system prompts exist (Approach C from workspaces analysis), the supervisor inherits workspace context automatically.

**Integration points:**
- Supervisor inherits workspace defaults (backend, model, permission mode)
- Workspace budget caps apply to the supervisor's entire tree (supervisor + all children)
- Workspace system prompt is prepended to supervisor's context

### 5.2 Permissions

Three natural modes for supervisor permissions:

| Mode | Supervisor | Workers | Use Case |
|------|-----------|---------|----------|
| Full bypass | bypass | bypass | Trusted automated pipeline |
| Supervised | supervised | bypass | Human approves supervisor decisions; workers execute freely |
| Full supervised | supervised | supervised | Human approves everything (maximum safety) |

The "Supervised supervisor + bypass workers" model is particularly interesting: the human trusts the supervisor's judgment about what to spawn, and the workers execute without interruption. This is the "manager approval" pattern.

### 5.3 Fleet / Multi-Node

A supervisor session runs on one node but can spawn workers on any node in the fleet. The relay routes RPC transparently. The supervisor doesn't need to know which node a worker runs on — `orka wait` works across nodes.

**Consideration:** A fleet-level supervisor managing work across multiple repos would need to specify `--project` for each spawn, pointing to different project paths on potentially different nodes.

### 5.4 Tags

Tags provide the grouping mechanism for supervisor workflows:

```bash
# Supervisor tags all its workers
orka spawn --parent $SELF --tag "oauth-refactor" --tag "backend" "Implement routes..."
orka spawn --parent $SELF --tag "oauth-refactor" --tag "frontend" "Implement components..."

# Query grouped sessions
orka ps --tag "oauth-refactor"
```

### 5.5 Auto-Merge

The supervisor should generally NOT use `--auto-merge` for workers. Instead, the supervisor controls merge order to handle dependencies:

```bash
# Don't auto-merge — supervisor controls order
orka spawn --parent $SELF "Implement database migration"
orka wait sess-xxx
orka merge sess-xxx  # merge migration first

orka spawn --parent $SELF "Implement API routes (migration already merged)"
orka wait sess-yyy
orka merge sess-yyy  # then routes
```

### 5.6 Config Limits

The existing `max_concurrent` limit applies globally. For supervisors, we need:

```toml
[limits]
max_concurrent = 10
max_children_per_session = 5      # NEW: prevent supervisor spawning too many
max_session_depth = 3             # NEW: prevent supervisor→supervisor→supervisor chains
supervisor_budget_usd = 20.0      # NEW: total spend cap for a supervisor tree
```

---

## 6. Safety & Risks

### 6.1 Infinite Spawning

**Risk:** Supervisor spawns workers that spawn sub-supervisors that spawn more workers, exponentially.

**Mitigations:**
- `max_session_depth`: Track depth via parent chain. Refuse spawn when depth exceeds limit.
- `max_children_per_session`: Hard cap on children per parent.
- `max_concurrent`: Global ceiling (already exists).
- Depth tracking: Add `depth` field to session, computed as `parent.depth + 1` at spawn time.

### 6.2 Runaway Costs

**Risk:** Supervisor spawns 20 Opus workers, each running for 30 minutes. $200 bill.

**Mitigations:**
- Per-supervisor budget cap (env var `ORKA_BUDGET_USD`)
- Supervisor checks `orka result <id>` for cost after each worker
- Daemon-side: track cumulative cost for a parent tree, reject spawn when over budget
- System prompt instructs supervisor to prefer cheaper models for simple tasks

### 6.3 Deadlocks

**Risk:** Supervisor waits for Worker A, which waits for Worker B, which is blocked on approval from the supervisor (which is blocked waiting).

**Mitigations:**
- Workers should run in bypass mode (no approval waits) when supervised by an agent
- `orka wait` has timeout support (could be added)
- Supervisor system prompt should include anti-deadlock patterns
- Session-level timeout (`session_timeout_minutes` already exists)

### 6.4 Merge Conflicts

**Risk:** Two parallel workers modify the same file, causing merge failure.

**Mitigations:**
- Supervisor checks `orka diff` before merging to detect overlaps
- Supervisor serializes merges (one at a time, in dependency order)
- If conflict detected: supervisor sends follow-up to second worker to rebase
- System prompt teaches supervisors to partition work by file/module to minimize overlap

### 6.5 Context Pollution

**Risk:** Supervisor's context window fills up with verbose worker outputs, degrading its reasoning.

**Mitigations:**
- `orka result` returns structured summary (not full logs)
- Supervisor should read `orka diff` (compact) rather than `orka logs` (verbose)
- System prompt instructs supervisor to be selective about what it reads
- For large outputs: supervisor can write worker results to files and read selectively

### 6.6 Orphaned Workers

**Risk:** Supervisor crashes or is stopped, leaving workers running with no coordinator.

**Mitigations:**
- `stopWithChildren()` already exists — stops parent and all children
- Workers with `parentSessionId` can be listed and stopped manually
- `idle_timeout_minutes` will hibernate abandoned workers
- Daemon can implement "cascade stop" — when a supervisor exits, stop its children

Cascade stop behavior options:
1. **Kill children immediately** — fast cleanup, but loses in-progress work
2. **Let children finish, don't merge** — workers complete but results are unmerged
3. **Let children finish, auto-merge** — risky, may merge bad work unsupervised
4. Recommendation: **Option 2** (let finish, don't merge). Human reviews later.

### 6.7 Security / Prompt Injection

**Risk:** A worker's output contains instructions that the supervisor interprets as commands (indirect prompt injection).

**Mitigations:**
- Supervisor reads structured results (`orka result --json`), not raw output
- System prompt instructs supervisor to treat worker output as untrusted data
- Supervisor should verify worker claims by checking `orka diff` (actual code changes)
- Don't pass raw worker output into subsequent worker prompts verbatim

---

## 7. Supervisor Patterns

### 7.1 Fan-Out / Fan-In

Spawn N workers in parallel, wait for all, aggregate results.

```
Supervisor
  ├── spawn Worker 1 (task A)
  ├── spawn Worker 2 (task B)
  ├── spawn Worker 3 (task C)
  │
  ├── orka wait sess-1 sess-2 sess-3
  │
  ├── orka result sess-1  →  evaluate
  ├── orka result sess-2  →  evaluate
  ├── orka result sess-3  →  evaluate
  │
  ├── merge in order: 1, 2, 3
  └── report summary
```

**Best for:** Independent tasks (update 20 files, run tests across modules).

### 7.2 Pipeline

Sequential tasks where each depends on the previous.

```
Supervisor
  ├── spawn Worker 1 (design)
  ├── orka wait sess-1
  ├── orka result sess-1 → extract design decisions
  ├── orka merge sess-1
  │
  ├── spawn Worker 2 (implement, using design from Worker 1)
  ├── orka wait sess-2
  ├── orka merge sess-2
  │
  ├── spawn Worker 3 (test, against implementation from Worker 2)
  ├── orka wait sess-3
  ├── orka merge sess-3
  └── report summary
```

**Best for:** Tasks with natural ordering (design → implement → test → deploy).

### 7.3 Map-Reduce

Split work across N workers, then reduce/aggregate.

```
Supervisor
  ├── Analyze: identify 30 files needing migration
  ├── Partition: 6 batches of 5 files each
  │
  ├── Map phase: spawn 6 workers, each handles a batch
  ├── orka wait --all (or specific IDs)
  │
  ├── Reduce phase: check all results
  │   ├── 5 succeeded → merge
  │   └── 1 failed → retry with adjusted prompt
  │
  ├── Final: spawn integration test worker
  └── Report: "Migrated 28/30 files, 2 need manual attention"
```

**Best for:** Repetitive transformations across many files/modules.

### 7.4 Iterative Refinement

Single worker, multiple rounds of feedback.

```
Supervisor
  ├── spawn Worker 1 (initial implementation)
  ├── orka wait sess-1
  ├── orka result sess-1 → review
  │
  ├── "Good, but missing error handling for X"
  ├── orka send sess-1 "Add error handling for NetworkError and TimeoutError"
  ├── orka wait sess-1  (worker resumes with context)
  ├── orka result sess-1 → review
  │
  ├── "Now add tests"
  ├── orka send sess-1 "Write tests for the error handling you just added"
  ├── orka wait sess-1
  │
  ├── orka diff sess-1 → final review
  ├── orka merge sess-1
  └── Done
```

**Best for:** Complex tasks that benefit from feedback loops.

### 7.5 Competitive / Best-of-N

Spawn multiple workers for the same task, pick the best result.

```
Supervisor
  ├── spawn Worker 1 (opus, approach A prompt)
  ├── spawn Worker 2 (opus, approach B prompt)
  ├── spawn Worker 3 (sonnet, approach A prompt)
  │
  ├── orka wait sess-1 sess-2 sess-3
  │
  ├── orka diff sess-1 → evaluate
  ├── orka diff sess-2 → evaluate
  ├── orka diff sess-3 → evaluate
  │
  ├── Pick best: sess-2
  ├── orka merge sess-2
  ├── orka stop sess-1 sess-3 (cleanup losers)
  └── Done
```

**Best for:** Critical code where correctness matters more than cost.

### 7.6 Supervisor Hierarchy

Supervisor spawns sub-supervisors for complex decomposition.

```
Lead Supervisor (depth=0)
  ├── Sub-Supervisor: Backend (depth=1)
  │   ├── Worker: Database (depth=2)
  │   ├── Worker: API Routes (depth=2)
  │   └── Worker: Auth Middleware (depth=2)
  │
  ├── Sub-Supervisor: Frontend (depth=1)
  │   ├── Worker: Components (depth=2)
  │   ├── Worker: State Management (depth=2)
  │   └── Worker: Styles (depth=2)
  │
  └── Worker: Integration Tests (depth=1)
      (waits for both sub-supervisors)
```

**Best for:** Large features crossing module boundaries. Requires `max_session_depth >= 3`.

---

## 8. Comparison with Competitors

### 8.1 vs. OpenAI Swarm / Agents SDK

Swarm uses function-calling handoffs: Agent A returns a `handoff(agent_b)` call to transfer control. This is **synchronous and single-threaded** — only one agent runs at a time.

**Orka advantage:** True parallelism via worktree isolation. Multiple agents run simultaneously on different branches. Swarm agents share a conversation context; Orka agents share a repo.

### 8.2 vs. CrewAI

CrewAI has explicit Manager/Worker roles with task graphs. The manager is a specialized agent type with delegation tools.

**Orka advantage:** No custom framework needed — Claude Code (or any agent) becomes a supervisor by having CLI access. CrewAI managers can only delegate tasks defined in their crew; Orka supervisors can dynamically decide what to spawn based on what they discover in the codebase.

**CrewAI advantage:** More structured task definitions with explicit input/output schemas. Orka supervisors communicate via text prompts.

### 8.3 vs. AutoGPT

AutoGPT demonstrated that recursive self-spawning without bounds leads to exponential cost and drift. Their task decomposition was purely LLM-driven with no external grounding.

**Orka advantage:** Git worktrees provide concrete, inspectable intermediate state. The supervisor can `orka diff` to verify what actually happened, not just read the agent's self-report. Concrete limits (depth, children, budget) prevent runaway behavior.

### 8.4 vs. Devin

Devin uses an inner/outer loop where the outer loop plans and the inner loop executes. Planning is sequential — one step completes before the next starts.

**Orka advantage:** Parallel execution with independent worktrees. Devin's single-agent model means it can only do one thing at a time. An Orka supervisor can spawn 5 workers and wait for all simultaneously.

**Devin advantage:** Tighter integration between planning and execution (same agent, same context). Orka supervisors lose context when switching between workers.

### 8.5 vs. LangGraph

LangGraph uses a state machine model with a pre-defined graph. Nodes are agents, edges are tool calls or conditionals. The graph is deterministic and inspectable.

**Orka advantage:** Dynamic graph construction. The supervisor decides at runtime what to spawn based on what it discovers. LangGraph requires the graph to be defined before execution. Orka also provides real filesystem isolation (worktrees) rather than shared state dicts.

**LangGraph advantage:** Deterministic execution, better debugging, explicit state management. Orka supervisors make decisions in unstructured text.

### 8.6 vs. Microsoft AutoGen

AutoGen's group chat model allows multiple agents to converse in a shared context, with a chat manager deciding who speaks next.

**Orka advantage:** Isolation. AutoGen agents share a conversation context, which means agent A's verbose output fills agent B's context window. Orka agents have independent context windows and communicate only through structured results.

**AutoGen advantage:** Real-time inter-agent communication. Orka workers can't talk to each other directly (only through the supervisor).

### Summary: Orka's Differentiators

1. **Git-native isolation** — worktrees, not shared memory
2. **True parallelism** — multiple agents, multiple branches, simultaneously
3. **Mid-flight correction** — steer running agents without restarting
4. **Cost observability** — per-session cost tracking, budget-aware decisions
5. **Heterogeneous backends** — mix Opus, Sonnet, Codex in one workflow
6. **Fleet scheduling** — distribute work across machines
7. **Post-mortem traceability** — event-sourced timeline for every session

---

## 9. Phased Implementation Roadmap

### Phase 0: Proof of Concept (1 day)

**Goal:** Demonstrate supervisor pattern with zero code changes.

**What:**
1. Write a supervisor system prompt that teaches Claude Code how to use `orka` CLI
2. Manually spawn a session with the system prompt and `ORKA_SESSION_ID` env var
3. Give it a multi-part task and watch it spawn/coordinate workers

**Validates:** Is the pattern viable? Does Claude Code follow the supervisor instructions? Where does it break?

**Deliverable:** Working demo + findings doc

### Phase 1: First-Class Support (1-2 days)

**Goal:** `orka spawn --role supervisor` works end-to-end with safety rails.

**Changes:**

1. **Env injection** (~30 LOC in orchestrator.ts):
   - Set `ORKA_SESSION_ID` on all sessions (useful beyond supervisors)
   - Set `ORKA_ROLE=supervisor` when spawned with `--role supervisor`
   - Set `ORKA_MAX_CHILDREN` and `ORKA_BUDGET_USD` from config

2. **Supervisor system prompt** (~200 lines, in a template file):
   - Role description: you are a supervisor, you coordinate work
   - CLI reference: spawn, wait, result, diff, merge, send, ps, stop
   - Patterns: fan-out, pipeline, map-reduce, iterative
   - Safety rules: check budget, limit depth, handle failures
   - Anti-patterns: don't spawn supervisors, don't read full logs

3. **CLI flag** (~20 LOC in cli/index.ts):
   ```
   orka spawn --role supervisor "Implement OAuth2 for the application"
   ```
   Maps to: `SpawnRequest.systemPrompt = supervisorPromptTemplate`

4. **Depth tracking** (~50 LOC in orchestrator.ts):
   - Compute session depth from parent chain at spawn time
   - Reject spawn if `depth > max_session_depth`
   - Store `depth` in session metadata

5. **Children limit** (~20 LOC in orchestrator.ts):
   - Count children of parent via `getChildSessions()`
   - Reject spawn if `count >= max_children_per_session`

6. **Config additions** (~10 LOC in config.ts):
   ```toml
   [limits]
   max_children_per_session = 10
   max_session_depth = 3
   ```

**Total: ~330 LOC**

### Phase 2: Observability & Control (1 week)

**Goal:** Dashboard support for supervisor workflows.

**Changes:**

1. **Session tree view**: Display parent-child relationships in dashboard
2. **Supervisor detail view**: Show supervisor + all children statuses, costs, diffs
3. **Tree cost rollup**: Sum costs across a supervisor's entire tree
4. **Cascade stop button**: "Stop supervisor and all children"
5. **Child spawn notifications**: Push events when a supervisor spawns a child

### Phase 3: MCP Server (1-2 weeks)

**Goal:** Structured tool access for supervisors via MCP.

**Changes:**

1. **MCP server** (`packages/mcp/`): Expose OrkaService operations as MCP tools
2. **Auto-configure**: When `--role supervisor`, inject MCP server config into Claude Code
3. **Structured results**: MCP tools return JSON, not CLI text
4. **Batch operations**: `orka_wait_and_result([id1, id2])` — wait + get results in one call

### Phase 4: Advanced Orchestration (2-4 weeks)

**Goal:** Sophisticated supervisor capabilities.

**Changes:**

1. **Budget enforcement**: Daemon-side tree cost tracking and spawn rejection
2. **Dependency DAG**: Supervisor declares task dependencies, daemon schedules accordingly
3. **Checkpoint/rollback**: Save supervisor state; resume from checkpoint after failure
4. **Approval delegation**: Supervisor auto-approves worker tool requests based on policy
5. **Result caching**: If a worker task is identical to a previous run, reuse the result
6. **Conflict detection API**: `orka conflicts sess-1 sess-2` — check if two workers' diffs conflict

### Phase 5: Fleet Supervisors (future)

**Goal:** Supervisors that manage work across multiple machines.

**Changes:**

1. **Node-aware scheduling**: Supervisor specifies node affinity for workers
2. **Cross-repo coordination**: Supervisor manages sessions across multiple project paths
3. **Resource-aware scheduling**: Route to nodes based on current load and capability
4. **Supervisor failover**: If supervisor's node goes down, resume on another node

---

## 10. Open Questions

### Q1: Should supervisors be able to spawn other supervisors?

**Pro:** Hierarchical decomposition is natural for large projects (lead supervisor → module supervisors → workers).

**Con:** Exponential complexity risk. Every additional level multiplies cost and coordination overhead.

**Recommendation:** Allow with strict depth limits (`max_session_depth = 3`). Default to 2 (supervisor + workers only). Document when hierarchy is appropriate (projects with >20 subtasks spanning multiple modules).

### Q2: Should workers know they have a supervisor?

**Pro:** Workers could report progress, ask questions, or flag blockers to the supervisor.

**Con:** Adds complexity. Workers should be simple — do the task, commit, exit.

**Recommendation:** Workers should NOT know about their supervisor. They receive a prompt, execute it, and exit. The supervisor observes via `result`, `diff`, and `logs`. If the supervisor needs to intervene, it uses `sendTurn`. This keeps worker prompts simple and reduces token spend.

### Q3: How should the supervisor handle partial failures?

Options:
- **Fail fast:** Stop all workers if any one fails
- **Best effort:** Continue with successful workers, report failures
- **Retry:** Re-spawn failed workers with adjusted prompts (N retries max)
- **Escalate:** Ask human for guidance on failures

**Recommendation:** Default to "retry once, then best effort with escalation." System prompt should teach this pattern. Make it configurable per supervisor.

### Q4: Should supervisor state be persisted separately?

A supervisor's plan (task decomposition, dependency graph, progress tracking) is valuable state. Should it be stored in the session's conversation context (ephemeral) or in a structured store (persistent)?

**Recommendation:** Start with conversation context (Phase 1-2). If supervisors hit context limits or need resumability, add structured state storage (Phase 4). The orchestration event timeline already captures most of this implicitly.

### Q5: What's the right default model for supervisors vs workers?

Supervisors need strong reasoning for planning and evaluation. Workers need to follow instructions and write code.

**Recommendation:**
- Supervisors: Opus (best reasoning, worth the cost for coordination)
- Workers: Configurable per task. Default to Sonnet for simple tasks, Opus for complex ones.
- Let the supervisor decide model per worker in its planning phase.

### Q6: How does this interact with the upcoming workspace entity?

If workspaces (Approach B from the entity analysis) are implemented first, supervisors benefit from:
- Workspace-level defaults (less config per spawn)
- Workspace-level budget (automatic cost cap for the entire supervisor tree)
- Workspace-level system prompt (shared context for all sessions)

**Recommendation:** Workspaces and supervisors are independent features that compose well. Neither blocks the other. Implement in whichever order makes sense for user needs.

### Q7: Can a human act as the supervisor?

The dashboard already lets humans spawn sessions, monitor results, and merge. A "supervisor mode" in the dashboard could provide the same workflow without an agent — the human clicks "spawn worker" and "merge result" instead of the agent running CLI commands.

**Recommendation:** Yes. The supervisor system prompt patterns should be usable by both agents and humans. The dashboard's session tree view (Phase 2) enables this naturally.

### Q8: Should we build an `orka plan` command?

A dedicated `orka plan` command could generate a task decomposition from a high-level prompt, output it as structured JSON, and let the user review before spawning. The supervisor would call `orka plan` first, present the plan, then execute it.

```bash
orka plan "Implement OAuth2 login"
# Output: JSON with tasks, dependencies, estimated costs, suggested models
# User reviews and approves
orka execute plan.json  # spawns all tasks per plan
```

**Recommendation:** Interesting but premature. The supervisor agent already does planning in its reasoning. A structured `plan` command adds value when supervisors are mature enough to benefit from reproducible plans. Consider for Phase 4+.

### Q9: How do we test supervisors?

Integration testing for supervisors is challenging because they spawn real agent sessions.

Options:
- **Mock provider:** Supervisor spawns sessions with a mock adapter that returns canned results instantly
- **Dry-run mode:** `orka spawn --dry-run` records what would be spawned without actually running
- **Replay:** Record a supervisor run, replay it deterministically

**Recommendation:** Start with manual testing (Phase 0-1). Add mock provider for CI (Phase 3). Replay is a Phase 5 luxury.

### Q10: What about inter-worker communication?

Currently workers can't talk to each other — only to the supervisor. Should Worker A be able to read Worker B's output directly?

**Recommendation:** No. The supervisor is the communication hub. Direct worker-to-worker communication creates coordination complexity that defeats the purpose of the supervisor pattern. If Worker A needs Worker B's output, the supervisor reads it and includes relevant parts in Worker A's prompt.
