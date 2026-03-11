import { $ } from "bun";
import type { RunnerSession, SessionRunner } from "./runner";
import { withSpan } from "./tracing";

const ORKA_PREFIX = "orka-";

export type TmuxSession = RunnerSession;

export class TmuxRunner implements SessionRunner {
  /** Spawn a new tmux session running a script in `cwd`. */
  async spawn(
    sessionName: string,
    scriptPath: string,
    cwd: string,
  ): Promise<void> {
    await withSpan("orka.tmux.spawn", {
      "orka.tmux.name": sessionName,
      "orka.tmux.cwd": cwd,
    }, async () => {
      await $`tmux new-session -d -s ${sessionName} -c ${cwd} bash ${scriptPath}`.quiet();
    });
  }

  /** Kill a tmux session. */
  async kill(sessionName: string): Promise<void> {
    await withSpan("orka.tmux.kill", { "orka.tmux.name": sessionName }, async () => {
      await $`tmux kill-session -t ${sessionName}`.quiet();
    });
  }

  /** Check if a tmux session exists. */
  async has(sessionName: string): Promise<boolean> {
    return withSpan("orka.tmux.has", { "orka.tmux.name": sessionName }, async () => {
      try {
        await $`tmux has-session -t ${sessionName}`.quiet();
        return true;
      } catch {
        return false;
      }
    });
  }

  /** List orka-prefixed tmux sessions. */
  async list(): Promise<RunnerSession[]> {
    return withSpan("orka.tmux.list", {}, async (span) => {
      try {
        const result =
          await $`tmux list-sessions -F #{session_name}\t#{session_created}\t#{session_attached}\t#{session_width}\t#{session_height}`
            .quiet()
            .text();

        const sessions = result
          .trim()
          .split("\n")
          .filter((line) => line.startsWith(ORKA_PREFIX))
          .map((line) => {
            const [name, created, attached, width, height] = line.split("\t");
            return {
              name,
              created: parseInt(created, 10),
              attached: attached === "1",
              width: parseInt(width, 10),
              height: parseInt(height, 10),
            };
          });

        span.setAttribute("orka.tmux.count", sessions.length);
        return sessions;
      } catch {
        // tmux returns error if no server running
        span.addEvent("orka.tmux.list_failed");
        return [];
      }
    });
  }

  /** Capture the pane buffer contents. */
  async capture(
    sessionName: string,
    lines = 1000,
  ): Promise<string> {
    return withSpan("orka.tmux.capture", { "orka.tmux.name": sessionName }, async () => {
      const result =
        await $`tmux capture-pane -t ${sessionName} -p -S -${lines}`.quiet().text();
      return result;
    });
  }

  /** Send literal text to a tmux session (no Enter appended). */
  async sendKeys(
    sessionName: string,
    keys: string,
  ): Promise<void> {
    await withSpan("orka.tmux.sendKeys", { "orka.tmux.name": sessionName }, async () => {
      await $`tmux send-keys -t ${sessionName} -l ${keys}`.quiet();
    });
  }

  /** Send literal text followed by Enter to a tmux session. */
  async sendText(
    sessionName: string,
    text: string,
  ): Promise<void> {
    await withSpan("orka.tmux.sendText", { "orka.tmux.name": sessionName }, async () => {
      await $`tmux send-keys -t ${sessionName} -l ${text}`.quiet();
      await $`tmux send-keys -t ${sessionName} Enter`.quiet();
    });
  }

  /** Attach to a tmux session (replaces current process). */
  async attach(sessionName: string): Promise<void> {
    await withSpan("orka.tmux.attach", { "orka.tmux.name": sessionName }, async () => {
      const proc = Bun.spawn(["tmux", "attach-session", "-t", sessionName], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      await proc.exited;
    });
  }
}

export const defaultRunner: SessionRunner = new TmuxRunner();

// Backward-compatible function wrappers
export async function tmuxSpawn(sessionName: string, scriptPath: string, cwd: string): Promise<void> {
  return defaultRunner.spawn(sessionName, scriptPath, cwd);
}

export async function tmuxList(): Promise<TmuxSession[]> {
  return defaultRunner.list();
}

export async function tmuxHas(sessionName: string): Promise<boolean> {
  return defaultRunner.has(sessionName);
}

export async function tmuxCapture(sessionName: string, lines = 1000): Promise<string> {
  return defaultRunner.capture(sessionName, lines);
}

export async function tmuxSendKeys(sessionName: string, keys: string): Promise<void> {
  return defaultRunner.sendKeys(sessionName, keys);
}

export async function tmuxSendText(sessionName: string, text: string): Promise<void> {
  return defaultRunner.sendText(sessionName, text);
}

export async function tmuxKill(sessionName: string): Promise<void> {
  return defaultRunner.kill(sessionName);
}

export async function tmuxAttach(sessionName: string): Promise<void> {
  return defaultRunner.attach(sessionName);
}
