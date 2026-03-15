# Config Layering

Orka resolves spawn defaults from four layers, highest priority first:

| Priority | Layer | Source |
|----------|-------|--------|
| 0 | CLI flags | `--backend`, `--model`, `--mode`, etc. |
| 1 | Environment variables | `ORKA_BACKEND`, `ORKA_MODEL`, `ORKA_MODE` |
| 2 | Project config | `.orka.toml` in the repo root |
| 3 | User config | `~/.orka/config.toml` |

## Project config (`.orka.toml`)

Checked into the repo, shared with the team. Same TOML schema as `~/.orka/config.toml`.

```toml
[defaults]
backend = "claude-code"
model = "opus"
mode = "background"
system_prompt = "You are working on the Foo project. Follow CONTRIBUTING.md."
tags = ["foo-project"]

[defaults.codex]
model = "gpt-5.4"
reasoning_effort = "high"

[defaults.claude-code]
model = "opus"

[limits]
max_concurrent = 3

[hooks]
post_worktree_create = "bun install"
```

## Per-backend defaults

Nested tables under `[defaults.<backend>]` override base defaults when that backend is selected. Supported fields: `model`, `reasoning_effort`, `system_prompt`, `tags`.

```toml
[defaults]
backend = "claude-code"
model = "sonnet"          # base default

[defaults.codex]
model = "gpt-5.4"         # overrides model when --backend codex
reasoning_effort = "high"

[defaults.claude-code]
model = "opus"             # overrides model when --backend claude-code
```

Running `orka spawn --backend codex "do stuff"` resolves model to `gpt-5.4` and reasoning-effort to `high`.

## Environment variables

| Variable | Overrides |
|----------|-----------|
| `ORKA_BACKEND` | `defaults.backend` |
| `ORKA_MODEL` | `defaults.model` |
| `ORKA_MODE` | `defaults.mode` |

Env vars sit between CLI flags and config files in priority.

## Merge rules

- **Scalar fields** (backend, mode, model, system-prompt, reasoning-effort): higher-priority layer wins. A value equal to the schema default (e.g., empty string for model) is treated as "not set" and does not override a lower layer.
- **Tags**: merged as a set union across all layers (user + project + per-backend + CLI). Duplicates removed.
- **Limits**: project overrides user when non-zero.
- **Hooks**: project overrides user when non-empty.
- **Per-backend defaults**: merged per-backend — project fields override user fields for the same backend; backends only in user config are preserved.

## Resolution flow

```
User config (~/.orka/config.toml)
  └─ merge with ─→ Project config (.orka.toml)
                      └─ apply per-backend defaults for selected backend
                           └─ apply env var overrides (ORKA_BACKEND, ORKA_MODEL, ORKA_MODE)
                                └─ apply CLI flags (always win)
```

## Implementation

- `loadConfig(orkaHome)` — loads `~/.orka/config.toml` (unchanged)
- `loadProjectConfig(projectPath)` — loads `.orka.toml`, returns `null` if missing
- `mergeConfigs(userConfig, projectConfig)` — merges two `OrkaConfig` objects
- `resolveDefaults(config, backend, envOverrides)` — applies per-backend + env, returns `ResolvedDefaults`

All functions are in `packages/daemon/src/config.ts`.

## What's NOT included (future work)

- Node-level config for remote nodes
- Config inheritance between projects
- `orka config` CLI command for inspecting effective config
