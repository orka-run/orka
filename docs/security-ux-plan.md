# Security UX Plan: Permission Modes

**Date**: 2026-03-17
**Status**: Proposal
**Related**: [Production Readiness Audit (S2)](production-readiness-audit.md), [Supervised Permissions Research](supervised-permissions-research.md)

---

## 1. Current State Analysis

### 1.1 Spawn Entry Points

| Entry Point | Default Mode | User Can Change? | Warning Shown? |
|-------------|-------------|-------------------|---------------|
| CLI `orka spawn` (background) | `bypassPermissions` | Only via `--supervised` flag | No |
| CLI `orka spawn` (interactive) | `auto` | Only via `--supervised` flag | No |
| Dashboard DraftChatView | `supervised` | Yes, via SpawnAdvancedPanel | No |
| Codex adapter (any mode) | `--dangerously-bypass-approvals-and-sandbox` | No — hardcoded | No |

### 1.2 Detailed Flow Traces

**CLI** (`packages/cli/src/index.ts:804-806`):
- `--supervised` flag → `permissionMode: "supervised"`
- No flag + no config → `permissionMode: undefined`
- `undefined` falls through to `mapClaudePermissionMode()` (`claude-adapter.ts:962-977`) which defaults to `bypassPermissions` for background, `auto` for interactive
- **No `--bypass` flag exists** — bypass is the implicit default for background sessions
- **No `--auto` flag exists** either
- Config can set `[defaults] permission_mode = "bypass"` but the default is empty string

**Dashboard** (`packages/dashboard/src/components/DraftChatView.tsx:52`):
- `useState<PermissionMode>("supervised")` — defaults to supervised
- SpawnAdvancedPanel (`SpawnAdvancedPanel.tsx:5-11`) shows three radio options: bypass, supervised, auto
- All options presented identically — no visual differentiation, no warning text
- No consent dialog, no localStorage consent tracking
- Switching to bypass requires a single click with no confirmation

**Codex adapter** (`packages/daemon/src/adapters/codex-adapter.ts:205`):
- Always uses `--dangerously-bypass-approvals-and-sandbox`
- `permissionMode` field is completely ignored
- No way to run Codex in supervised mode

### 1.3 Risk Assessment: What Can a Bypass Session Do?

A session running with `bypassPermissions` has **unrestricted access** to:

| Capability | Examples |
|-----------|----------|
| **Filesystem** | Read/write/delete any file the daemon user can access |
| **Network** | `curl` to external services, exfiltrate data, download malware |
| **Commands** | `rm -rf`, `git push --force`, install packages, modify system config |
| **Secrets** | Read `~/.ssh/*`, `~/.aws/credentials`, `.env` files, Git tokens |
| **Processes** | Kill processes, start services, modify cron jobs |
| **Environment** | Full daemon env is inherited (S2 in audit) — API keys, DB creds, etc. |

**Blast radius**: A single malicious or confused prompt can compromise the entire user account on the machine. In multi-machine relay mode, a compromised daemon exposes all connected nodes.

### 1.4 Existing Precedents

| Tool | Privileged Mode | UX Treatment |
|------|----------------|--------------|
| Docker `--privileged` | Full host access | Documented as dangerous, not default, requires explicit flag |
| `sudo` | Root access | Requires password, logs usage, configurable via sudoers |
| Claude Code (interactive) | `bypassPermissions` | User explicitly selects in TUI, shown as "Bypass all permission checks" |
| VS Code Workspace Trust | Arbitrary code execution | Trust dialog on first open, per-workspace, revocable |
| GitHub Actions | Runner access | Permissions block in YAML, principle of least privilege |

**Common patterns**: (1) explicit opt-in, (2) first-time consent, (3) visual differentiation of dangerous state, (4) revocable.

---

## 2. Proposed Changes

### 2.1 First-Time Bypass Consent

**Goal**: Ensure users understand what bypass mode means before they first use it.

#### CLI Consent Flow

On first `orka spawn` that would result in bypass mode (either explicit or default):

```
⚠  Bypass Permission Mode

  Bypass mode gives the agent unrestricted access to your system:
  • Read, write, and delete any file
  • Execute arbitrary commands
  • Access network and environment variables

  This is powerful but dangerous. Only use bypass for trusted prompts.

  Do you want to enable bypass mode? [y/N]
```

If accepted:
- Write `bypass_consent = true` under `[permissions]` in `~/.orka/config.toml`
- Subsequent bypass spawns skip the dialog
- Still print a one-line warning (see 2.3)

If declined:
- Fall back to `supervised` mode
- Print: `Running in supervised mode. Use --supervised explicitly or set [permissions] bypass_consent = true in config.`

**Skip conditions** (no dialog shown):
- `bypass_consent = true` already in config
- `--yes` / `-y` flag passed to `orka spawn`
- Stdin is not a TTY (piped input / CI)
- The effective mode is not `bypass` (e.g., `--supervised` was passed)

#### Dashboard Consent Flow

On first selection of "bypass" in SpawnAdvancedPanel:

1. Show a modal dialog:
   - Title: "Enable Bypass Mode?"
   - Body: Same risk explanation as CLI
   - Checkbox: "I understand that bypass mode gives the agent unrestricted system access"
   - Buttons: [Cancel] [Enable Bypass]
   - Checkbox must be checked before [Enable Bypass] is clickable
2. On confirm: set `localStorage.setItem("orka-bypass-consent", "accepted")`
3. Subsequent selections skip the dialog
4. Revocable: settings page can clear consent

**Implementation**:
- New component: `BypassConsentDialog.tsx`
- SpawnAdvancedPanel checks localStorage before allowing bypass selection
- DraftChatView checks consent before spawning if mode is bypass

### 2.2 Visual Indicators

#### Dashboard Session List

| Mode | Badge | Color |
|------|-------|-------|
| supervised | "Supervised" | Green (`bg-green-500/10 text-green-400`) |
| auto | "Auto" | Blue (`bg-blue-500/10 text-blue-400`) |
| bypass | "Bypass" | Red/amber (`bg-red-500/10 text-red-400`) |

- Badge appears on each session card in the session list
- Badge appears in session detail view header

#### Dashboard Global Banner

When any session is running with bypass mode, show a persistent banner at the top of the dashboard:

```
⚠ N session(s) running with bypass permissions — agents have unrestricted system access
```

- Amber/yellow background, dismissible per-page-load but returns on refresh
- Links to the running bypass sessions
- Only shown when there are active (running) bypass sessions

#### SpawnAdvancedPanel Visual Differentiation

Current state: all three modes look identical. Proposed:

```
┌─────────────────────────────────────────────┐
│ ○ Supervised                                │
│   Approve agent actions from dashboard      │
│   Recommended for untrusted prompts         │
├─────────────────────────────────────────────┤
│ ○ Auto                                      │
│   Agent auto-approves safe operations       │
│   Read-only tools run freely, writes ask    │
├─────────────────────────────────────────────┤
│ ○ Bypass                              ⚠     │
│   Agent runs without permission checks      │
│   Full filesystem, network, and command     │
│   access — use for trusted prompts only     │
└─────────────────────────────────────────────┘
```

- Bypass option has amber/red left border and warning icon
- Supervised option has green left border
- Auto option has blue left border (neutral)

### 2.3 CLI Safety

#### Explicit `--bypass` Flag

Currently there is no `--bypass` flag — bypass is the implicit default for background sessions. This is the most dangerous UX pattern: the unsafe option requires zero effort.

**Change**: Add `--bypass` and `--auto` flags alongside existing `--supervised`:

```
orka spawn --bypass "do the thing"       # Explicit bypass
orka spawn --supervised "do the thing"   # Supervised mode
orka spawn --auto "do the thing"         # Auto mode
orka spawn "do the thing"                # Uses config default (see below)
```

**New default resolution** (replace current logic at `cli/src/index.ts:804-806`):

```typescript
const effectivePermissionMode: PermissionMode =
  args.bypass ? "bypass" :
  args.supervised ? "supervised" :
  args.auto ? "auto" :
  (cfg.permissionMode as PermissionMode) || "auto";  // Changed: default is "auto", not undefined→bypass
```

**Breaking change**: Background sessions that previously defaulted to bypass will now default to `auto`. Users who want bypass must either:
- Pass `--bypass` explicitly
- Set `[defaults] permission_mode = "bypass"` in config

#### Warning on Bypass Spawn

Every bypass spawn (CLI) prints a warning line to stderr:

```
⚠  Running with bypass permissions — agent has full system access
```

This prints even after consent is given. It's a single line, not a blocking dialog. Suppressible via `--quiet` / `-q` flag or `[defaults] quiet_bypass_warning = true` in config.

#### `mapClaudePermissionMode` Default Change

In `claude-adapter.ts:962-977`, change the default case:

```typescript
default:
  // Default: auto for both background and interactive
  return "auto";
```

This ensures that omitting `permissionMode` no longer silently grants bypass.

### 2.4 Config Persistence

#### ~/.orka/config.toml

Extend the existing `[permissions]` section:

```toml
[permissions]
# Whether the user has acknowledged bypass mode risks (set by first-time dialog)
bypass_consent = false

# Default permission mode when no flag is passed
# Values: "auto", "supervised", "bypass"
# mode = "auto"   # already exists in schema

# Auto-approve patterns for supervised mode (existing)
# auto_approve = ["Read", "Glob", "Grep"]
# always_deny = ["Bash:rm *"]
```

The existing `PermissionsSchema` at `config.ts:42-45` already has `mode`, `autoApprove`, `alwaysDeny`, `approvalTimeout`. Add `bypassConsent: z.boolean().default(false)`.

#### Dashboard localStorage

```
orka-bypass-consent: "accepted" | absent
```

Single key. Cleared by settings page or browser devtools.

#### Per-Project Override

Support `.orka.toml` in project root:

```toml
[permissions]
mode = "supervised"  # Force supervised for this project
```

This overrides the global default but does NOT override an explicit CLI flag. Project config should be able to restrict (force supervised) but not escalate (force bypass when user hasn't consented).

**Resolution order**:
1. CLI flag (`--bypass`, `--supervised`, `--auto`) — highest priority
2. Project `.orka.toml` `[permissions] mode`
3. User `~/.orka/config.toml` `[defaults] permission_mode`
4. Hardcoded default: `"auto"`

### 2.5 Codex Adapter

Currently Codex always uses `--dangerously-bypass-approvals-and-sandbox` regardless of `permissionMode`. This should be documented as a known limitation:

- **Short term**: Add a CLI warning when spawning Codex sessions: `⚠  Codex backend always runs with full bypass — supervised mode not supported`
- **Long term**: Investigate Codex sandbox support (tracked as C5 in audit)

---

## 3. Implementation Scope

### Phase 1: Visual Indicators + CLI Flags (Low risk, high impact)

1. Add `--bypass` and `--auto` flags to CLI spawn command
2. Change default from `undefined→bypass` to `"auto"` in CLI and adapter
3. Add warning line on bypass spawn (CLI stderr)
4. Add permission mode badge to dashboard session list and detail views
5. Add visual differentiation to SpawnAdvancedPanel (colors, warning text)
6. Add `bypassConsent` to config schema

**Files changed**:
- `packages/cli/src/index.ts` — new flags, default change, warning
- `packages/daemon/src/adapters/claude-adapter.ts` — default change in `mapClaudePermissionMode`
- `packages/daemon/src/config.ts` — `bypassConsent` field
- `packages/dashboard/src/components/SpawnAdvancedPanel.tsx` — visual redesign
- `packages/dashboard/src/components/SessionCard.tsx` (or equivalent) — badge

### Phase 2: Consent Dialogs (Medium effort)

7. CLI first-time consent dialog (interactive TTY check + config write)
8. Dashboard BypassConsentDialog component
9. Dashboard global bypass banner
10. Dashboard settings page: consent revocation

**Files changed**:
- `packages/cli/src/index.ts` — consent check before spawn
- `packages/dashboard/src/components/BypassConsentDialog.tsx` — new
- `packages/dashboard/src/components/DraftChatView.tsx` — consent check
- `packages/dashboard/src/components/Layout.tsx` (or equivalent) — global banner

### Phase 3: Project-Level Config (Small scope)

11. Support `.orka.toml` in project root
12. Merge project config into resolution chain
13. CLI reads project config from `projectPath`

**Files changed**:
- `packages/daemon/src/config.ts` — project config loading
- `packages/daemon/src/orchestrator.ts` — merge project config into spawn

---

## 4. Migration Notes

### Breaking Change: Default Permission Mode

The default for background CLI sessions changes from `bypass` to `auto`. This means:
- Agents may encounter permission denials for write operations
- Users must explicitly opt into bypass with `--bypass` or config

**Migration path**:
- Users who always want bypass: `orka config set default-permission bypass` (or edit config.toml)
- Users who want per-command bypass: `orka spawn --bypass "..."`
- No change needed for `--supervised` users

### Codex Users

Codex sessions are unaffected — they always bypass regardless of config. A warning is added but behavior doesn't change.

---

## 5. Open Questions

1. **Should `auto` mode work for Codex?** Codex's `--dangerously-bypass-approvals-and-sandbox` is all-or-nothing. Removing it may break Codex entirely.
2. **Should relay-connected sessions require bypass consent per-node?** A client could connect to a remote node and spawn bypass sessions on hardware they don't own.
3. **Audit logging**: Should bypass sessions generate audit events in a separate log? Would help with incident investigation.
4. **Rate limiting bypass sessions**: Should there be a separate concurrent limit for bypass vs supervised sessions?
