import type { CSSProperties } from "react";

export interface AnsiSpan {
  text: string;
  style: CSSProperties;
}

const ANSI_REGEX = /\x1b\[([0-9;]*)m/g;

const COLORS: Record<number, string> = {
  30: "#4e4e4e", // black
  31: "#e06c75", // red
  32: "#98c379", // green
  33: "#e5c07b", // yellow
  34: "#61afef", // blue
  35: "#c678dd", // magenta
  36: "#56b6c2", // cyan
  37: "#dcdfe4", // white
  90: "#7f848e", // bright black (gray)
  91: "#f44747", // bright red
  92: "#89d185", // bright green
  93: "#f5e960", // bright yellow
  94: "#6fc1ff", // bright blue
  95: "#d670d6", // bright magenta
  96: "#4ec9b0", // bright cyan
  97: "#ffffff", // bright white
};

const BG_COLORS: Record<number, string> = {
  40: "#4e4e4e",
  41: "#e06c75",
  42: "#98c379",
  43: "#e5c07b",
  44: "#61afef",
  45: "#c678dd",
  46: "#56b6c2",
  47: "#dcdfe4",
  100: "#7f848e",
  101: "#f44747",
  102: "#89d185",
  103: "#f5e960",
  104: "#6fc1ff",
  105: "#d670d6",
  106: "#4ec9b0",
  107: "#ffffff",
};

interface AnsiState {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  color: string | undefined;
  bgColor: string | undefined;
}

function defaultState(): AnsiState {
  return { bold: false, dim: false, italic: false, underline: false, color: undefined, bgColor: undefined };
}

function stateToStyle(state: AnsiState): CSSProperties {
  const style: CSSProperties = {};
  if (state.bold) style.fontWeight = "bold";
  if (state.dim) style.opacity = 0.6;
  if (state.italic) style.fontStyle = "italic";
  if (state.underline) style.textDecoration = "underline";
  if (state.color) style.color = state.color;
  if (state.bgColor) style.backgroundColor = state.bgColor;
  return style;
}

function applyCode(state: AnsiState, code: number): void {
  if (code === 0) {
    Object.assign(state, defaultState());
  } else if (code === 1) {
    state.bold = true;
  } else if (code === 2) {
    state.dim = true;
  } else if (code === 3) {
    state.italic = true;
  } else if (code === 4) {
    state.underline = true;
  } else if (code === 22) {
    state.bold = false;
    state.dim = false;
  } else if (code === 23) {
    state.italic = false;
  } else if (code === 24) {
    state.underline = false;
  } else if (code === 39) {
    state.color = undefined;
  } else if (code === 49) {
    state.bgColor = undefined;
  } else if (COLORS[code]) {
    state.color = COLORS[code];
  } else if (BG_COLORS[code]) {
    state.bgColor = BG_COLORS[code];
  }
}

/**
 * Parse a string containing ANSI escape codes into styled spans.
 * Strips non-SGR escape sequences.
 */
export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  const state = defaultState();
  let lastIndex = 0;

  // Strip non-SGR escape sequences (cursor movement, erase, etc.)
  const cleaned = input.replace(/\x1b\[[0-9;]*[A-HJKSTfhlnr]/g, "");

  ANSI_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ANSI_REGEX.exec(cleaned)) !== null) {
    // Text before this escape sequence
    if (match.index > lastIndex) {
      const text = cleaned.slice(lastIndex, match.index);
      if (text) {
        spans.push({ text, style: stateToStyle(state) });
      }
    }

    // Apply SGR codes
    const codes = match[1] ? match[1].split(";").map(Number) : [0];
    for (const code of codes) {
      applyCode(state, code);
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last escape
  if (lastIndex < cleaned.length) {
    const text = cleaned.slice(lastIndex);
    if (text) {
      spans.push({ text, style: stateToStyle(state) });
    }
  }

  return spans;
}
