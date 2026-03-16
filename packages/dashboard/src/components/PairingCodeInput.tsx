import { useId } from "react";

// Crockford Base32 charset (uppercase, no I/L/O/U)
const CROCKFORD_RE = /[^0-9A-HJKMNP-TV-Z]/gi;

function formatPairingCode(raw: string): string {
  const clean = raw
    .replace(CROCKFORD_RE, "")
    .toUpperCase()
    .slice(0, 21);
  const groups = [
    clean.slice(0, 4),
    clean.slice(4, 8),
    clean.slice(8, 12),
    clean.slice(12, 16),
    clean.slice(16, 21),
  ].filter(Boolean);
  return groups.join("-");
}

function stripDashes(code: string): string {
  return code.replace(/-/g, "");
}

export function isValidPairingCode(code: string): boolean {
  const stripped = stripDashes(code);
  if (stripped.length < 20) return false;
  return !CROCKFORD_RE.test(stripped);
}

interface PairingCodeInputProps {
  value: string;
  onChange: (formatted: string) => void;
  disabled?: boolean;
  error?: string | null;
  label?: string;
}

export function PairingCodeInput({
  value,
  onChange,
  disabled,
  error,
  label = "Pairing Code",
}: PairingCodeInputProps) {
  const inputId = useId();

  function handleChange(raw: string) {
    onChange(formatPairingCode(raw));
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text");
    onChange(formatPairingCode(pasted));
  }

  return (
    <div>
      <label htmlFor={inputId} className="mb-1 block text-[11px] font-medium text-ink-secondary">
        {label}
      </label>
      <input
        id={inputId}
        type="text"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onPaste={handlePaste}
        placeholder="XXXX-XXXX-XXXX-XXXX-XXXXX"
        disabled={disabled}
        className={`w-full rounded-sm border bg-surface-alt px-2 py-1.5 font-mono text-[12px] tracking-wider text-ink outline-none transition placeholder:text-ink-muted focus:border-accent disabled:opacity-50 ${
          error ? "border-status-error" : "border-border"
        }`}
      />
      {error && (
        <p className="mt-0.5 text-[10px] text-status-error">{error}</p>
      )}
    </div>
  );
}
