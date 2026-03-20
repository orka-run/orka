# Spawn Dialog UX Research

## Problem Statement

The current `DraftChatView` merged the old modal into a chat view with collapsible advanced options (see `spawn-ux-plan.md`). While functional, it's still heavy:

- **SpawnAdvancedPanel** renders large permission-mode cards with multi-line descriptions
- Header has workspace pill + MiniPills + model dropdown — visually busy
- Advanced panel is a form section bolted onto a chat view, not a natural chat experience
- The collapsed/expanded toggle feels like a form, not like composing a message

**Goal**: Make spawn feel like typing a message with a few quick settings, not filling out a form.

---

## Competitor Analysis

### T3Code (new thread UI)

**Layout**: Sidebar (threads) | Main (messages + composer) | Optional diff panel.

**Key patterns**:
- No "new thread" dialog or form — threads created implicitly on navigation
- Composer is always visible at bottom, same component for new + existing threads
- **Rounded container** (`rounded-[20px]`) with `focus-within:border-ring/45` — feels like a chat bubble
- Rich Lexical editor with `@file` mention chips inline
- **Footer toolbar below input** with inline controls in a single row:
  ```
  [Provider/Model ▾] | [Reasoning] [FastMode] | [Chat/Plan] | [Supervised/FullAccess] | [Plan sidebar]
  ```
- At <620px, everything collapses into a single `⋯` menu
- No separate "advanced options" drawer — all controls are always one click away in the toolbar
- Pending states (approval, user input) render as contextual panels *above* the input
- Draft text + model/mode settings persisted per-thread in localStorage

**Takeaways**:
- The toolbar-below-input pattern eliminates the need for a collapsible panel
- Settings are **adjacent to the input, not above/around it** — low cognitive overhead
- Responsive collapse to `⋯` menu means the compact case is handled gracefully
- No form semantics anywhere — everything is buttons and dropdowns

### ChatGPT

**Key patterns**:
- Single centered textarea, grows vertically
- Model selector is a **pill/chip above the input** (or in header)
- Attachments as preview chips below the input
- No visible "advanced options" — model is the only setting
- "Temporary chat" toggle is a small switch, not a form field
- Send button embedded in the input container (bottom-right)
- Web search, image generation, etc. are tool icons **inside** the input container

**Takeaways**:
- Extreme simplicity — one input, one model selector, done
- All chrome is inside or adjacent to the input container
- Progressive disclosure via tool icons, not a settings panel

### Cursor (AI code editor)

**Key patterns**:
- Chat panel is a sidebar (not main content)
- Input at bottom with `@` mention support for files/symbols
- Model selector as a small dropdown **next to the send button**
- "Agent" / "Ask" / "Manual" mode tabs above the input
- No form fields — everything is inline controls
- Compact by necessity (sidebar width constraint)

**Takeaways**:
- Model selection belongs near the action button (send)
- Mode selection (analogous to backend/permission) works as segmented tabs
- Sidebar constraint forces compact design — a good forcing function

### Slack (compose box)

**Key patterns**:
- Rich editor with toolbar below: formatting, emoji, mentions, attachments
- Channel/recipient is context (selected before composing), not a field in the composer
- No "settings" in the compose flow — destination is the only config
- Shift+Enter for newline, Enter to send

**Takeaways**:
- The "context is already set" pattern — workspace/project selection happens before the composer, not in it
- Toolbar is for content actions, not config

---

## Current Orka Layout vs. Proposed

### Current DraftChatView

```
┌─ Header ─────────────────────────────────────────────┐
│ [Workspace pill] [claude-code|codex] [model ▾]       │
│                                        [Options ▾]   │
├─ SpawnAdvancedPanel (if expanded) ───────────────────┤
│ Title: [________]    Tags: [________]                │
│                                                       │
│ Permission mode:                                      │
│ ┌─────────────┐ ┌────────────┐ ┌───────────────┐    │
│ │ Supervised  │ │   Auto     │ │   Bypass      │    │
│ │ (3 lines    │ │ (3 lines   │ │ (3 lines      │    │
│ │  of text)   │ │  of text)  │ │  of text)     │    │
│ └─────────────┘ └────────────┘ └───────────────┘    │
│                                                       │
│ [x] Auto-merge  [ ] Run in-place                     │
│ System prompt: [________________________]            │
│ Node: [auto] [node-1] [node-2]                       │
├──────────────────────────────────────────────────────┤
│                                                       │
│           (empty state placeholder)                   │
│                                                       │
├──────────────────────────────────────────────────────┤
│ [Describe the work...                      ] [Send]  │
└──────────────────────────────────────────────────────┘
```

**Problems**:
1. Header has 3 controls competing for attention
2. Advanced panel is 200+px tall — pushes input off-screen on short viewports
3. Permission mode cards are beautiful but huge — overkill for a spawn flow
4. "Options ▾" toggle is a form pattern, not a chat pattern
5. Model is a native `<select>` — looks out of place next to styled pills

### Proposed: Compact Chat Composer

```
┌──────────────────────────────────────────────────────┐
│                                                       │
│                                                       │
│           (empty state — centered)                    │
│                                                       │
│              ┌───────────────────┐                    │
│              │   💬 New session  │                    │
│              │ Send a message    │                    │
│              │ to start          │                    │
│              └───────────────────┘                    │
│                                                       │
│                                                       │
│  ┌────────────────────────────────────────────────┐  │
│  │                                                 │  │
│  │  Describe the work...                           │  │
│  │                                                 │  │
│  ├─────────────────────────────────────────────────┤  │
│  │ [Claude⌄] [opus-4-6⌄] [supervised⌄]   [Send ➤]│  │
│  └─────────────────────────────────────────────────┘  │
│                                                       │
└──────────────────────────────────────────────────────┘
```

**Expanded (click `⋯` or a "more" affordance):**

```
  ┌────────────────────────────────────────────────┐
  │                                                 │
  │  Describe the work...                           │
  │                                                 │
  ├─────────────────────────────────────────────────┤
  │ Title: [optional title_____________]            │
  │ Tags:  [tag1, tag2_________________]            │
  │ System prompt: [___________________]            │
  │ [x] Auto-merge  [ ] No worktree                │
  │ Node: [auto ▾] (only if multi-node)            │
  ├─────────────────────────────────────────────────┤
  │ [Claude⌄] [opus-4-6⌄] [supervised⌄] [⋯] [➤]  │
  └─────────────────────────────────────────────────┘
```

---

## Design Principles

1. **Input-first**: The textarea is the primary element. Everything else is secondary.
2. **Single container**: All controls live inside or on the border of the composer container. No separate header bar.
3. **Footer toolbar**: Backend, model, permission mode as compact dropdowns in a toolbar below the input — following T3Code's pattern.
4. **Progressive disclosure via `⋯`**: Advanced options (title, tags, system prompt, checkboxes) expand *between* the input and the footer toolbar. Not a separate panel.
5. **Workspace context is ambient**: The workspace name can appear as a subtle label above the composer or in the sidebar, not as a control in the spawn flow.
6. **No large cards**: Permission mode is a dropdown with 3 options, not 3 cards. Tooltips or a small description line on hover/select for explanation.
7. **Responsive collapse**: Below ~500px, backend+model+permission collapse into a single `[Settings⌄]` dropdown.

---

## Component Breakdown

### 1. `SpawnComposer` (replaces DraftChatView)

The full-page view for the draft/new-session state.

```
Props:
  projectPath: string
  nodes: NodeInfo[]
  workspace?: WorkspaceInfo
  onSpawned: (id: string) => void

State:
  (all spawn options managed internally or via composerDraftStore)
```

**Responsibilities**:
- Render empty-state placeholder centered above the composer
- Render `ComposerBox` pinned to bottom
- Show pending message bubble while spawning
- Transition to session view on success

### 2. `ComposerBox` (new)

The rounded input container with embedded controls.

```
┌─────────────────────────────────────────┐
│ [Lexical editor — multi-line input]     │
├─ AdvancedFields (if expanded) ──────────┤
│ Title / Tags / SystemPrompt / toggles   │
├─ ComposerToolbar ───────────────────────┤
│ [Backend⌄] [Model⌄] [Permission⌄] [⋯] [Send] │
└─────────────────────────────────────────┘
```

**Styling**: `rounded-2xl border bg-card focus-within:border-ring/40 shadow-sm`

This is a **single visual container** — input, options, toolbar are all inside the same rounded box. No visual separation between "input area" and "controls area" except a subtle divider.

### 3. `ComposerToolbar` (new)

Horizontal bar at the bottom of ComposerBox.

```
Props:
  backend, onBackendChange
  model, onModelChange
  permissionMode, onPermissionModeChange
  isAdvancedOpen, onToggleAdvanced
  onSend
  canSend: boolean

Layout (wide):
  [BackendPill⌄] [ModelPill⌄] [PermissionPill⌄]  ···  [⋯] [Send]

Layout (narrow):
  [Settings⌄]  ···  [Send]
```

Each pill is a `DropdownMenu` trigger (Radix/shadcn). Not native `<select>`.

**BackendPill**: Shows icon + "Claude" or "Codex". Dropdown lists backends.
**ModelPill**: Shows short model name ("opus-4-6"). Dropdown lists available models for selected backend.
**PermissionPill**: Shows "supervised" / "auto" / "bypass" with a colored dot indicator. Dropdown lists modes with one-line descriptions.

### 4. `AdvancedFields` (new, replaces SpawnAdvancedPanel)

Lightweight inline fields that expand between input and toolbar.

```
Props:
  title, tags, systemPrompt, autoMerge, noWorktree, nodeId
  nodes: NodeInfo[]
  onChange: (field, value) => void
```

**Layout**: Compact grid. No permission mode cards. No colored borders.
- Row 1: `Title [__________]  Tags [__________]`
- Row 2: `System prompt [_________________________]`
- Row 3: `[x] Auto-merge  [ ] No worktree  Node: [auto⌄]`

All fields are small, single-line inputs. System prompt is a single-row input that can expand on focus. Node selector only renders if `nodes.length > 1`.

**Animation**: Slide-down with `max-height` transition or Radix `Collapsible`.

### 5. Existing `ComposerEditor` (reuse)

The Lexical-based text editor — already exists in the codebase as part of `ChatInputComposer`. Extract and reuse. No changes needed to the editor itself.

### 6. `SendButton` (new or extracted)

Circular or rounded-square button. States:
- **Ready**: accent color, arrow-up icon, enabled when input non-empty
- **Spawning**: spinner, disabled
- **Error**: red outline, shows error tooltip/popover on hover

---

## Interaction Details

### Keyboard

| Key | Action |
|---|---|
| `Enter` | Send (spawn) |
| `Shift+Enter` | Newline |
| `Cmd+Enter` | Send (always, even if Shift+Enter configured) |
| `Tab` | From input, focus first toolbar pill |
| `Escape` | Close advanced fields if open |

### Dropdowns

- All pill dropdowns use Radix `DropdownMenu` for consistent behavior
- Dropdowns open upward (since toolbar is at bottom of screen)
- Keyboard navigation within dropdowns (arrow keys, enter to select)
- Each dropdown item: icon + label + optional description line

### Draft Persistence

- Same as current: save to `chatUiStore` per session ("draft" key)
- Extend to persist backend/model/permission selection per workspace
- Advanced fields (title, tags, etc.) are NOT persisted — they're per-spawn

### Error Handling

- Spawn errors appear as a dismissible banner *above* the ComposerBox
- Not inside it — keeps the input usable for retry
- Auto-dismiss on next input change

---

## Migration Path

1. **Create `ComposerBox` + `ComposerToolbar`** with the new layout
2. **Move backend/model/permission from header to toolbar**
3. **Replace `SpawnAdvancedPanel` with `AdvancedFields`** (compact inline fields)
4. **Remove header controls** — workspace shown in sidebar or as subtle label
5. **Delete `SpawnAdvancedPanel.tsx`** and `MiniPills` (replaced by dropdown pills)
6. **Update `DraftChatView`** to use new components (or rename to `SpawnComposer`)

### Files to Create

| File | Purpose |
|---|---|
| `ComposerBox.tsx` | Rounded container with input + toolbar + advanced fields |
| `ComposerToolbar.tsx` | Bottom bar with pill dropdowns + send button |
| `AdvancedFields.tsx` | Collapsible inline fields (title, tags, etc.) |

### Files to Modify

| File | Change |
|---|---|
| `DraftChatView.tsx` | Gut and rebuild around `ComposerBox` |
| `ChatInputComposer.tsx` | May extract editor portion for reuse |

### Files to Delete

| File | Reason |
|---|---|
| `SpawnAdvancedPanel.tsx` | Replaced by `AdvancedFields` |

---

## Open Questions

1. **Workspace indicator**: Should workspace name appear as a subtle label above the composer, in the sidebar header, or not at all in the spawn flow?
2. **Permission mode education**: With cards gone, how do new users learn what "supervised" vs "bypass" means? Tooltip? First-time popover? Link to docs?
3. **System prompt UX**: Single-line input that expands, or always a textarea? Most users won't use this — should it be behind the `⋯` toggle even in the advanced fields?
4. **Model list source**: Currently hardcoded. Should the toolbar fetch available models from the daemon? (Relevant if models change per-backend.)
5. **Reuse for send-to-running**: The same `ComposerBox` pattern could replace `ChatInputComposer` in active sessions (minus the spawn-specific fields). Worth designing for now?
