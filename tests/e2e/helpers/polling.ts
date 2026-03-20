/**
 * Polling helpers for E2E tests.
 * Replace fixed Bun.sleep() waits with event-driven polling.
 */

/** Poll until predicate returns true, or timeout. */
export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  { timeoutMs = 5000, intervalMs = 50 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/**
 * Poll relay /health until the given node appears in the authenticated nodes list.
 * Replaces `await Bun.sleep(500)` after relay registration.
 */
export async function waitForRelayNode(
  relayPort: number,
  nodeId: string,
  apiKey: string,
  timeoutMs = 5000,
): Promise<void> {
  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${relayPort}/health`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return false;
      const body = await res.json() as { account?: { nodes?: Array<{ id: string }> } };
      return body.account?.nodes?.some((n) => n.id === nodeId) ?? false;
    } catch {
      return false;
    }
  }, { timeoutMs });
}

/**
 * Poll daemon /health until it responds 200.
 * Replaces `await Bun.sleep(500)` after daemon startup.
 */
export async function waitForDaemonHealth(
  port: number,
  timeoutMs = 5000,
): Promise<void> {
  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }, { timeoutMs });
}
