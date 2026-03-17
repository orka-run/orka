# Model List RPC Plan

## Problem

The dashboard needs a model picker for spawn. Currently Orka treats models as opaque strings — no validation, no discovery. Users must know valid model names out-of-band.

## Research: How Backends Expose Models

### Claude Code

- **No CLI command** to list models. `claude --model` accepts freeform strings; validation happens server-side.
- **Anthropic API** exposes `GET /v1/models` — returns paginated list of available models with metadata (id, display name, created_at). Requires API key + `anthropic-version` header.
- Claude Code itself uses aliases (`sonnet`, `opus`, `haiku`) that resolve to full model IDs internally. These aliases are not exposed programmatically.
- `claude auth status --json` returns org/subscription info but no model list.

### Codex (OpenAI)

- **No CLI command** to list models. `codex --model` / `-m` accepts freeform strings.
- **OpenAI API** exposes `GET /v1/models` — returns full model list. Requires API key.
- Codex config (`~/.codex/config.toml`) stores the chosen model but no available list.

### Summary

Neither CLI exposes a model-listing command. Both upstream APIs (`/v1/models`) do, but:
1. Orka daemon doesn't hold API keys — the agent CLIs manage auth independently.
2. API model lists are huge (OpenAI returns 100+ models, most irrelevant to code agents).
3. Model availability depends on the user's subscription/plan, not just the API.

## Proposed Design

### Approach: Curated Defaults + Config Override

Since programmatic discovery is impractical (no API keys in daemon, noisy results), use a **curated static list per backend** with optional config override.

#### 1. Core Types

```typescript
// core/types.ts
export interface ModelInfo {
  id: string;          // e.g. "claude-opus-4-6", "gpt-5.4"
  label: string;       // e.g. "Opus 4.6", "GPT-5.4"
  alias?: string;      // e.g. "opus", "o3" — shorthand accepted by CLI
  default?: boolean;   // true for the recommended model per backend
}
```

#### 2. RPC Method

```typescript
// core/service.ts — add to OrkaService interface
listModels(backend: BackendKind): Promise<ModelInfo[]>;
```

Returns the model list for the given backend. Order = recommended first.

#### 3. Daemon Implementation

```typescript
// daemon/src/models.ts
const CLAUDE_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-6",   label: "Opus 4.6",   alias: "opus",   default: true },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6",  alias: "sonnet" },
  { id: "claude-haiku-4-5",  label: "Haiku 4.5",   alias: "haiku" },
];

const CODEX_MODELS: ModelInfo[] = [
  { id: "gpt-5.4",  label: "GPT-5.4",  default: true },
  { id: "o3",       label: "o3" },
  { id: "o4-mini",  label: "o4-mini" },
];

export function getModels(backend: BackendKind, configOverrides?: ModelInfo[]): ModelInfo[] {
  if (configOverrides?.length) return configOverrides;
  return backend === "claude-code" ? CLAUDE_MODELS : CODEX_MODELS;
}
```

#### 4. Config Override (optional)

Allow `config.toml` to override the built-in list:

```toml
[[models.claude-code]]
id = "claude-opus-4-6"
label = "Opus 4.6"
alias = "opus"
default = true

[[models.codex]]
id = "gpt-5.4"
label = "GPT-5.4"
default = true
```

This lets users add new models before Orka ships an update.

#### 5. Dashboard Usage

```typescript
// dashboard store
const models = await svc.listModels(selectedBackend);
// → populate <select> with models, pre-select the default
```

## Implementation Steps

1. Add `ModelInfo` type and `listModels` to `core/types.ts` and `core/service.ts`
2. Add `models.ts` in daemon with curated lists
3. Wire into `LocalClient` and `RemoteClient` (JSON-RPC handler)
4. Add optional `[models.*]` config section
5. Dashboard: call `listModels` on backend change, populate model picker

## Alternatives Considered

| Approach | Pros | Cons |
|----------|------|------|
| **API discovery** (`/v1/models`) | Always up-to-date | Daemon has no API keys; noisy results; requires filtering heuristics |
| **Shell out to CLI** (`claude --list-models`) | Would be ideal | Neither CLI supports this |
| **Freeform text input only** | Zero maintenance | Bad UX; typo-prone; no discoverability |
| **Curated list + config** (chosen) | Good UX; works offline; overridable | Must update list when new models ship |

## Open Questions

- Should `listModels` also return the user's configured default (from `config.toml` `[defaults]` or `[defaults.<backend>]`)? Probably yes — mark it with `default: true` in the response.
- Should we validate `--model` against this list at spawn time? Probably not — allow freeform to support new models before list updates. The list is for UI hints, not enforcement.
