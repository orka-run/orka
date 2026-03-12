// PTY management inspired by pingdotgg/t3code (MIT, Copyright 2026 T3 Tools Inc.)

import type { IPty } from "node-pty";
import { generateId } from "@orka/core";

const MAX_HISTORY_BYTES = 100 * 1024; // 100KB

export interface TerminalSession {
  id: string;
  sessionId: string;
  pty: IPty;
  history: string;
  cols: number;
  rows: number;
  createdAt: string;
}

export interface TerminalOpenOpts {
  cols?: number;
  rows?: number;
  cwd?: string;
  shell?: string;
}

export interface TerminalInfo {
  id: string;
  cols: number;
  rows: number;
}

/**
 * Manages PTY sessions for web-accessible terminal streaming.
 * Requires node-pty native module (install with: bun add node-pty).
 */
export class TerminalManager {
  private terminals = new Map<string, TerminalSession>();
  private dataHandlers = new Map<string, Set<(data: string) => void>>();

  /** Spawn function — injectable for testing */
  private ptySpawn: typeof import("node-pty").spawn;

  constructor(ptySpawn?: typeof import("node-pty").spawn) {
    if (ptySpawn) {
      this.ptySpawn = ptySpawn;
    } else {
      // Lazy-load node-pty at runtime so the module can be imported
      // even when node-pty isn't compiled (e.g. in test environments)
      try {
        this.ptySpawn = require("node-pty").spawn;
      } catch {
        throw new Error(
          "node-pty is not available. Install it with: bun add node-pty " +
          "(requires native compilation tools: make, gcc/g++)",
        );
      }
    }
  }

  /** Open a new PTY for a session */
  open(sessionId: string, opts: TerminalOpenOpts = {}): TerminalSession {
    const id = generateId("term");
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 30;

    const pty = this.ptySpawn(opts.shell ?? "bash", [], {
      name: "xterm-256color",
      cols,
      rows,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });

    const session: TerminalSession = {
      id,
      sessionId,
      pty,
      history: "",
      cols,
      rows,
      createdAt: new Date().toISOString(),
    };

    // Capture output to history buffer (capped at MAX_HISTORY_BYTES)
    pty.onData((data: string) => {
      session.history += data;
      if (session.history.length > MAX_HISTORY_BYTES) {
        session.history = session.history.slice(-MAX_HISTORY_BYTES);
      }

      // Notify registered handlers
      const handlers = this.dataHandlers.get(id);
      if (handlers) {
        for (const handler of handlers) {
          handler(data);
        }
      }
    });

    this.terminals.set(id, session);
    return session;
  }

  /** Write data to terminal */
  write(termId: string, data: string): void {
    const term = this.terminals.get(termId);
    if (!term) throw new Error(`Terminal not found: ${termId}`);
    term.pty.write(data);
  }

  /** Resize terminal */
  resize(termId: string, cols: number, rows: number): void {
    const term = this.terminals.get(termId);
    if (!term) throw new Error(`Terminal not found: ${termId}`);
    term.pty.resize(cols, rows);
    term.cols = cols;
    term.rows = rows;
  }

  /** Get terminal by ID */
  get(termId: string): TerminalSession | null {
    return this.terminals.get(termId) ?? null;
  }

  /** List terminals for a session */
  listForSession(sessionId: string): TerminalSession[] {
    const result: TerminalSession[] = [];
    for (const term of this.terminals.values()) {
      if (term.sessionId === sessionId) {
        result.push(term);
      }
    }
    return result;
  }

  /** Close terminal */
  close(termId: string): void {
    const term = this.terminals.get(termId);
    if (!term) throw new Error(`Terminal not found: ${termId}`);
    term.pty.kill();
    this.terminals.delete(termId);
    this.dataHandlers.delete(termId);
  }

  /** Close all terminals for a session */
  closeAll(sessionId: string): void {
    for (const [id, term] of this.terminals) {
      if (term.sessionId === sessionId) {
        term.pty.kill();
        this.terminals.delete(id);
        this.dataHandlers.delete(id);
      }
    }
  }

  /** Register data handler (for streaming to WS clients). Returns unsubscribe function. */
  onData(termId: string, handler: (data: string) => void): () => void {
    if (!this.terminals.has(termId)) {
      throw new Error(`Terminal not found: ${termId}`);
    }

    let handlers = this.dataHandlers.get(termId);
    if (!handlers) {
      handlers = new Set();
      this.dataHandlers.set(termId, handlers);
    }
    handlers.add(handler);

    return () => {
      handlers!.delete(handler);
    };
  }
}
