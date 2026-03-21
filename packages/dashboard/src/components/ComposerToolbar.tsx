import { useState, useRef, useEffect, useCallback } from "react";
import {
  ArrowUp,
  LoaderCircle,
  ChevronUp,
  AlertTriangle,
  Terminal,
  Bot,
  GitBranch,
  Shield,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import type { BackendKind, PermissionMode } from "@orka/core";

interface ComposerToolbarProps {
  backend: BackendKind;
  onBackendChange: (v: BackendKind) => void;
  model: string;
  onModelChange: (v: string) => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (v: PermissionMode) => void;
  noWorktree?: boolean;
  onNoWorktreeChange?: (v: boolean) => void;
  onSend: () => void;
  canSend: boolean;
  isSending: boolean;
}

const BACKENDS: { value: BackendKind; label: string; icon: typeof Bot }[] = [
  { value: "claude-code", label: "Claude", icon: Terminal },
  { value: "codex", label: "Codex", icon: Bot },
];

const MODELS_BY_BACKEND: Record<BackendKind, { value: string; label: string }[]> = {
  "claude-code": [
    { value: "", label: "Default" },
    { value: "claude-opus-4-6", label: "opus-4-6" },
    { value: "claude-sonnet-4-6", label: "sonnet-4-6" },
    { value: "claude-haiku-4-5-20251001", label: "haiku-4-5" },
  ],
  codex: [
    { value: "", label: "Default" },
    { value: "gpt-5.4", label: "gpt-5.4" },
    { value: "gpt-5", label: "gpt-5" },
  ],
};

const PERMISSION_MODES: {
  value: PermissionMode;
  label: string;
  description: string;
  dot: string;
  icon: typeof Shield;
}[] = [
  {
    value: "supervised",
    label: "Supervised",
    description: "Approve actions from dashboard",
    dot: "bg-emerald-500",
    icon: ShieldCheck,
  },
  {
    value: "auto",
    label: "Auto",
    description: "Safe ops auto-approved, writes ask",
    dot: "bg-blue-500",
    icon: Shield,
  },
  {
    value: "bypass",
    label: "Bypass",
    description: "No permission checks — trusted only",
    dot: "bg-red-500",
    icon: ShieldOff,
  },
];

function useClickOutside(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ref, onClose]);
}

function PillDropdown<T extends string>({
  value,
  onChange,
  options,
  renderTrigger,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; description?: string; icon?: typeof Bot; dot?: string }[];
  renderTrigger: (selectedLabel: string, isOpen: boolean) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close);

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-ink-secondary transition hover:bg-surface-hover hover:text-ink"
      >
        {renderTrigger(selected?.label ?? value, open)}
        <ChevronUp className={`h-3 w-3 transition-transform ${open ? "" : "rotate-180"}`} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 min-w-[180px] rounded-lg border border-border bg-surface shadow-lg">
          {options.map((opt) => {
            const isSelected = opt.value === value;
            const Icon = opt.icon;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition first:rounded-t-lg last:rounded-b-lg ${
                  isSelected
                    ? "bg-accent/10 text-accent-strong"
                    : "text-ink-secondary hover:bg-surface-alt"
                }`}
              >
                {opt.dot && <span className={`h-2 w-2 shrink-0 rounded-full ${opt.dot}`} />}
                {Icon && !opt.dot && <Icon className="h-3.5 w-3.5 shrink-0" />}
                <span className="flex-1">
                  <span className="font-medium">{opt.label}</span>
                  {opt.description && (
                    <span className="ml-1.5 text-ink-muted">{opt.description}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ComposerToolbar({
  backend,
  onBackendChange,
  model,
  onModelChange,
  permissionMode,
  onPermissionModeChange,
  noWorktree,
  onNoWorktreeChange,
  onSend,
  canSend,
  isSending,
}: ComposerToolbarProps) {
  const models = MODELS_BY_BACKEND[backend];
  const permConfig = PERMISSION_MODES.find((p) => p.value === permissionMode) ?? PERMISSION_MODES[0]!;

  return (
    <div className="border-t border-border/50 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <PillDropdown
          value={backend}
          onChange={onBackendChange}
          options={BACKENDS}
          renderTrigger={(label) => {
            const cfg = BACKENDS.find((b) => b.value === backend);
            const Icon = cfg?.icon ?? Terminal;
            return (
              <>
                <Icon className="h-3.5 w-3.5" />
                <span>{label}</span>
              </>
            );
          }}
        />

        <PillDropdown
          value={model}
          onChange={onModelChange}
          options={models}
          renderTrigger={(label) => <span>{label}</span>}
        />

        <PillDropdown
          value={permissionMode}
          onChange={(v) => {
            if (v === "bypass") {
              const consented = localStorage.getItem("orka-bypass-consent");
              if (!consented) {
                localStorage.setItem("orka-bypass-consent", "accepted");
              }
            }
            onPermissionModeChange(v);
          }}
          options={PERMISSION_MODES}
          renderTrigger={() => (
            <>
              <span className={`h-2 w-2 rounded-full ${permConfig.dot}`} />
              <span>{permConfig.label}</span>
              {permissionMode === "bypass" && (
                <AlertTriangle className="h-3 w-3 text-red-400" />
              )}
            </>
          )}
        />

        {onNoWorktreeChange && (
          <button
            type="button"
            onClick={() => onNoWorktreeChange(!noWorktree)}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition ${
              noWorktree
                ? "text-amber-500 hover:bg-surface-hover"
                : "text-ink-secondary hover:bg-surface-hover hover:text-ink"
            }`}
            title={noWorktree ? "Running in-place (no worktree)" : "Running in isolated worktree"}
          >
            <GitBranch className="h-3.5 w-3.5" />
            <span>{noWorktree ? "in-place" : "worktree"}</span>
          </button>
        )}

        <div className="flex-1" />

        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          aria-label="Send message"
          className={`inline-flex h-8 min-w-[36px] items-center justify-center rounded-lg text-white transition ${
            canSend
              ? "bg-accent-strong hover:bg-accent"
              : "cursor-not-allowed bg-surface-hover text-ink-muted"
          }`}
        >
          {isSending ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <ArrowUp className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  );
}
