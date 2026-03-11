import { $ } from "bun";
import { withSpan } from "./tracing";

const ORKA_PREFIX = "orka-";

export interface TmuxSession {
  name: string;
  created: number;
  attached: boolean;
  width: number;
  height: number;
}

/** Spawn a new tmux session running a script in `cwd`. */
export async function tmuxSpawn(
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

/** List orka-prefixed tmux sessions. */
export async function tmuxList(): Promise<TmuxSession[]> {
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

/** Check if a tmux session exists. */
export async function tmuxHas(sessionName: string): Promise<boolean> {
  try {
    await $`tmux has-session -t ${sessionName}`.quiet();
    return true;
  } catch {
    return false;
  }
}

/** Capture the pane buffer contents. */
export async function tmuxCapture(
  sessionName: string,
  lines = 1000,
): Promise<string> {
  const result =
    await $`tmux capture-pane -t ${sessionName} -p -S -${lines}`.quiet().text();
  return result;
}

/** Send literal text to a tmux session (no Enter appended). */
export async function tmuxSendKeys(
  sessionName: string,
  keys: string,
): Promise<void> {
  await $`tmux send-keys -t ${sessionName} -l ${keys}`.quiet();
}

/** Send literal text followed by Enter to a tmux session. */
export async function tmuxSendText(
  sessionName: string,
  text: string,
): Promise<void> {
  await $`tmux send-keys -t ${sessionName} -l ${text}`.quiet();
  await $`tmux send-keys -t ${sessionName} Enter`.quiet();
}

/** Kill a tmux session. */
export async function tmuxKill(sessionName: string): Promise<void> {
  await withSpan("orka.tmux.kill", { "orka.tmux.name": sessionName }, async () => {
    await $`tmux kill-session -t ${sessionName}`.quiet();
  });
}

/** Attach to a tmux session (replaces current process). */
export async function tmuxAttach(sessionName: string): Promise<void> {
  const proc = Bun.spawn(["tmux", "attach-session", "-t", sessionName], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}
