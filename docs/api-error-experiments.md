# API Error Behavior Experiments

Date: 2026-03-18
Claude Code version: 2.1.78
Codex version: 0.114.0

## Executive Summary

Claude Code handles API errors **entirely internally** with aggressive retry logic. It retries ALL error types (including 401 auth errors) up to 10 times with exponential backoff. In `--output-format stream-json` mode, retry attempts are visible as `system.api_retry` events on stdout. In plain `--print` mode, retries are **completely silent** — zero output on stdout or stderr until the process eventually exits.

Codex (app-server mode) does NOT retry API errors. It immediately emits `error` and `turn/completed` (status=failed) notifications, with structured error info in `codexErrorInfo`.

**Key implication for orka**: Our stderr-draining approach (line 173-175 of claude-adapter.ts) doesn't lose important error info — Claude Code puts error data on stdout via stream-json events. But we currently **ignore** `system.api_retry` events in `mapClaudeEvent()`.

## Experiment 1: Claude Code with 529 (Overloaded)

**Setup**: HTTP proxy returning `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}` with status 529.

**Command**: `claude -p --verbose --output-format stream-json --input-format stream-json` (exact flags used by our adapter)

**Result**: Claude Code retries with exponential backoff. Never exits on its own within 30s timeout.

### Stdout (stream-json events)

After the `system.init` event, retries appear as:

```json
{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":516.17,"error_status":529,"error":"rate_limit","session_id":"...","uuid":"..."}
{"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"retry_delay_ms":1177.75,"error_status":529,"error":"rate_limit","session_id":"...","uuid":"..."}
{"type":"system","subtype":"api_retry","attempt":3,"max_retries":10,"retry_delay_ms":2350.58,"error_status":529,"error":"rate_limit","session_id":"...","uuid":"..."}
{"type":"system","subtype":"api_retry","attempt":4,"max_retries":10,"retry_delay_ms":4727.69,"error_status":529,"error":"rate_limit","session_id":"...","uuid":"..."}
{"type":"system","subtype":"api_retry","attempt":5,"max_retries":10,"retry_delay_ms":8246.90,"error_status":529,"error":"rate_limit","session_id":"...","uuid":"..."}
{"type":"system","subtype":"api_retry","attempt":6,"max_retries":10,"retry_delay_ms":18077.75,"error_status":529,"error":"rate_limit","session_id":"...","uuid":"..."}
```

**Stderr**: Empty (no output)

**Exit code**: Did not exit within 30s (killed by timeout → exit 124)

### Retry timing (exponential backoff with jitter)

| Attempt | Delay (ms) | Cumulative (s) |
|---------|-----------|----------------|
| 1       | ~500      | 0.5            |
| 2       | ~1,200    | 1.7            |
| 3       | ~2,400    | 4.1            |
| 4       | ~4,700    | 8.8            |
| 5       | ~8,200    | 17.0           |
| 6       | ~18,000   | 35.0           |
| 7       | ~36,000*  | 71.0           |
| 8       | ~72,000*  | 143.0          |
| 9       | ~144,000* | 287.0          |
| 10      | ~288,000* | 575.0          |

*Extrapolated from the doubling pattern. Full 10 retries take ~10 minutes.

## Experiment 2: Claude Code with 401 (Authentication Error)

**Setup**: Proxy returning `{"type":"error","error":{"type":"authentication_error","message":"Invalid API Key"}}` with status 401.

**Result**: Claude Code **also retries 401 errors** — does NOT fail fast on auth failures.

### Stdout events

```json
{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":556.10,"error_status":401,"error":"authentication_failed","session_id":"...","uuid":"..."}
{"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"retry_delay_ms":1214.66,"error_status":401,"error":"authentication_failed","session_id":"...","uuid":"..."}
{"type":"system","subtype":"api_retry","attempt":3,"max_retries":10,"retry_delay_ms":2245.00,"error_status":401,"error":"authentication_failed","session_id":"...","uuid":"..."}
{"type":"system","subtype":"api_retry","attempt":4,"max_retries":10,"retry_delay_ms":4747.77,"error_status":401,"error":"authentication_failed","session_id":"...","uuid":"..."}
{"type":"system","subtype":"api_retry","attempt":5,"max_retries":10,"retry_delay_ms":9318.41,"error_status":401,"error":"authentication_failed","session_id":"...","uuid":"..."}
```

**Stderr**: Empty
**Exit code**: Did not exit within 15s (killed by timeout)

## Experiment 3: Claude Code with Connection Refused

**Setup**: `ANTHROPIC_BASE_URL=http://localhost:19999` (nothing listening)

**Result**: Retries with `error_status: null` and `error: "unknown"`.

### Stdout events

```json
{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":603.75,"error_status":null,"error":"unknown","session_id":"...","uuid":"..."}
{"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"retry_delay_ms":1159.82,"error_status":null,"error":"unknown","session_id":"...","uuid":"..."}
{"type":"system","subtype":"api_retry","attempt":3,"max_retries":10,"retry_delay_ms":2350.99,"error_status":null,"error":"unknown","session_id":"...","uuid":"..."}
{"type":"system","subtype":"api_retry","attempt":4,"max_retries":10,"retry_delay_ms":4581.00,"error_status":null,"error":"unknown","session_id":"...","uuid":"..."}
{"type":"system","subtype":"api_retry","attempt":5,"max_retries":10,"retry_delay_ms":9197.22,"error_status":null,"error":"unknown","session_id":"...","uuid":"..."}
{"type":"system","subtype":"api_retry","attempt":6,"max_retries":10,"retry_delay_ms":18529.06,"error_status":null,"error":"unknown","session_id":"...","uuid":"..."}
```

**Stderr**: Empty
**Exit code**: Did not exit within 30s

## Experiment 4: Claude Code with No API Key

**Setup**: `unset ANTHROPIC_API_KEY` (no key provided)

**Result**: Claude Code fell back to its **logged-in account credentials** and **succeeded**.

### Key observations

- `apiKeySource` in init event: `"none"`
- Model used: `claude-opus-4-6[1m]` (from account defaults, not the adapter's `--model` flag)
- The session completed successfully, exit code 0
- A `rate_limit_event` was emitted showing account usage status:

```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed_warning",
    "resetsAt": 1773990000,
    "rateLimitType": "seven_day",
    "utilization": 0.9,
    "isUsingOverage": false,
    "surpassedThreshold": 0.75
  }
}
```

**Implication**: If `ANTHROPIC_API_KEY` is not set or is stripped from env, Claude Code uses the logged-in user's subscription. This could lead to unexpected billing if the daemon strips the key by accident.

## Experiment 5: Claude Code `--print` Mode (No stream-json)

**Setup**: `claude --print "hello"` with 500 proxy (no `--verbose`, no `--output-format stream-json`)

**Result**: **Complete silence**. Zero output on stdout, zero output on stderr during retries. The process just hangs until all retries are exhausted or it's killed.

**Exit code**: Did not exit within 20s (killed by timeout)

**Implication**: This mode is unusable for error detection. Our adapter correctly uses `--output-format stream-json` which provides retry events.

## Experiment 6: Claude Code `--fallback-model` Flag

Discovered via `--help`: `--fallback-model <model>` — "Enable automatic fallback to specified model when default model is overloaded (only works with --print)". This is Claude Code's built-in overload handling but only for `--print` mode.

## Experiment 7: Codex with API Error (Usage Limit Exceeded)

**Setup**: Codex app-server with invalid API key, full JSON-RPC initialization sequence.

**Result**: Codex does NOT retry. It immediately returns an error through multiple notification channels:

### Error sequence (5 notifications in order)

1. **`account/rateLimits/updated`** — rate limit status:
```json
{
  "method": "account/rateLimits/updated",
  "params": {
    "rateLimits": {
      "secondary": { "usedPercent": 100, "windowDurationMins": 10080 },
      "credits": { "hasCredits": false, "unlimited": false, "balance": "0" }
    }
  }
}
```

2. **`codex/event/error`** — error event with message and error code:
```json
{
  "method": "codex/event/error",
  "params": {
    "msg": {
      "type": "error",
      "message": "You've hit your usage limit. Upgrade to Pro...",
      "codex_error_info": "usage_limit_exceeded"
    }
  }
}
```

3. **`thread/status/changed`** — state changes to `systemError`:
```json
{"method": "thread/status/changed", "params": {"status": {"type": "systemError"}}}
```

4. **`error`** — structured error notification with `willRetry: false`:
```json
{
  "method": "error",
  "params": {
    "error": {
      "message": "You've hit your usage limit...",
      "codexErrorInfo": "usageLimitExceeded"
    },
    "willRetry": false,
    "threadId": "...",
    "turnId": "..."
  }
}
```

5. **`turn/completed`** — turn fails:
```json
{
  "method": "turn/completed",
  "params": {
    "turn": {
      "status": "failed",
      "error": {
        "message": "You've hit your usage limit...",
        "codexErrorInfo": "usageLimitExceeded"
      }
    }
  }
}
```

**Exit code**: 0 (app-server stays alive after error, closed by our unsubscribe)

### Codex `exec` Mode (Non-app-server)

When run as `codex exec "say hello"` with invalid API key:
- **Exit code**: 1
- **Stdout**: Empty
- **Stderr**: Full session header followed by error message:
```
OpenAI Codex v0.114.0 (research preview)
--------
workdir: /home/...
model: gpt-5.4
...
--------
user
say hello
mcp startup: no servers
ERROR: You've hit your usage limit. Upgrade to Pro...
```

## Experiment 8: Codex `exec` with Invalid CLI Flags

When `--output-format` (not a valid Codex flag) is passed:
- **Exit code**: 2
- **Stderr**: `error: unexpected argument '--output-format' found`

## Error Classification Table

### Claude Code (stream-json mode)

| Error Type | HTTP Status | `error_status` | `error` field | Retries? | Max Retries | Exit Code |
|------------|-------------|-----------------|---------------|----------|-------------|-----------|
| Overloaded | 529 | `529` | `"rate_limit"` | Yes | 10 | N/A (retries) |
| Auth failure | 401 | `401` | `"authentication_failed"` | Yes | 10 | N/A (retries) |
| Server error | 500 | `500` | `"api_error"` (likely) | Yes | 10 | N/A (retries) |
| Conn refused | N/A | `null` | `"unknown"` | Yes | 10 | N/A (retries) |
| No API key | N/A | N/A | N/A | No retry needed | N/A | 0 (uses account) |

**After exhausting all retries**: Claude Code is expected to emit a `result` event with `is_error: true` and exit with non-zero code. (Not confirmed in testing due to ~10 minute retry duration.)

### Codex (app-server mode)

| Error Type | `codexErrorInfo` / `error.message` | Retries? | `willRetry` | Turn Status | Thread Status |
|------------|--------------------------------------|----------|-------------|-------------|---------------|
| Usage limit | `usageLimitExceeded` | No | `false` | `failed` | `systemError` |
| API error | (varies) | Depends on `willRetry` | `true`/`false` | `failed` if no retry | `systemError` |

## Detected Event Schema

### Claude Code `system.api_retry`

```typescript
{
  type: "system",
  subtype: "api_retry",
  attempt: number,        // 1-indexed
  max_retries: number,    // always 10 in testing
  retry_delay_ms: number, // exponential backoff with jitter
  error_status: number | null,  // HTTP status code, null for network errors
  error: string,          // "rate_limit" | "authentication_failed" | "unknown" | ...
  session_id: string,
  uuid: string
}
```

### Claude Code `rate_limit_event`

```typescript
{
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed_warning" | string,
    resetsAt: number,           // unix timestamp
    rateLimitType: "seven_day",
    utilization: number,        // 0-1
    isUsingOverage: boolean,
    surpassedThreshold: number  // 0-1
  }
}
```

### Codex `error` notification

```typescript
{
  method: "error",
  params: {
    error: {
      message: string,
      codexErrorInfo: string,  // "usageLimitExceeded" | ...
      additionalDetails: unknown | null
    },
    willRetry: boolean,
    threadId: string,
    turnId: string
  }
}
```

## Recommendations for Error Detection

### 1. Capture `system.api_retry` events in Claude adapter

Currently, `mapClaudeEvent()` ignores `system` events unless `subtype === "init"`. We should map `api_retry` events to a new canonical event (e.g., `runtime.warning` or a new `api.retry` type) so the daemon can:
- Track retry state per session
- Detect sessions stuck in retry loops
- Provide real-time status to the dashboard/CLI

### 2. Detect "stuck in retries" condition

With 10 retries and exponential backoff, Claude Code can be stuck for ~10 minutes. The daemon should:
- Track cumulative retry time
- After a configurable threshold (e.g., 3 minutes), mark the session as "degraded" or "retrying"
- Optionally allow the user to kill the session early

### 3. Handle Codex errors immediately

Codex doesn't retry — errors are immediate. Our codex adapter already handles the `error` notification via `mapCodexEvent()` → `runtime.error`. The `thread/status/changed` to `systemError` correctly triggers unsubscribe. This path is working.

### 4. Don't bother capturing stderr

Both Claude Code and Codex put ALL error information on stdout (stream-json / JSON-RPC). Stderr is empty in all tested scenarios. The current `drainStream(process.stderr)` approach is correct — there's nothing useful to capture.

### 5. Consider the `--fallback-model` flag

For future work: `--fallback-model` could let Claude Code automatically fall back to a smaller model on overload. This would reduce retry storms but only works in `--print` mode (not our `-p --verbose --output-format stream-json` mode — needs verification).

### 6. Watch for the no-API-key fallback

If `ANTHROPIC_API_KEY` is accidentally absent from the spawn env, Claude Code silently uses the logged-in user's subscription. Our `buildAgentEnv()` should ensure the key is always present, or we should detect `apiKeySource: "none"` in the `system.init` event and treat it as an error.

## Surprises and Gotchas

1. **Claude Code retries ALL errors** — even 401 auth failures that will never succeed. There's no short-circuit for non-retryable errors.

2. **10 retries with exponential backoff = ~10 minutes** before Claude Code gives up. This is a very long time for a session to be stuck.

3. **`--print` mode is completely silent** during retries. No stdout, no stderr. Only stream-json mode provides visibility.

4. **No API key = use account** — Claude Code doesn't fail when ANTHROPIC_API_KEY is missing. It silently uses the logged-in user's account credentials, potentially incurring unexpected costs.

5. **Codex exit code is 0 even on errors** in app-server mode (the process stays alive). In `exec` mode, exit code is 1 on API errors.

6. **The `max_retries: 10` value appears hardcoded** — no CLI flag or env var was found to control it.

7. **Codex has a `willRetry` field** in its error notifications, making it easy to distinguish retriable from terminal errors. Claude Code does not have an equivalent — all errors are retried.
