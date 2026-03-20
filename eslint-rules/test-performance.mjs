/**
 * ESLint plugin: test-perf
 *
 * Rules for test performance and isolation:
 *   - no-disk-sqlite:   Ban openDb() in tests (use openTestDb for in-memory)
 *   - no-long-sleep:    Ban Bun.sleep(N) and setTimeout(_, N) where N > 200ms
 *   - no-env-mutation:  Ban process.env["ORKA_HOME"] = / process.env["ORKA_RELAY_DATA"] =
 */

/**
 * Check whether an AST node (function body) contains a reject() call or
 * a throw statement — indicating it is a timeout guard, not a sleep.
 */
function containsRejectOrThrow(node) {
  if (!node) return false;

  if (node.type === "CallExpression") {
    // reject(...)
    if (node.callee.type === "Identifier" && node.callee.name === "reject") {
      return true;
    }
  }

  if (node.type === "ThrowStatement") {
    return true;
  }

  // Walk all child nodes
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const child = node[key];
    if (child && typeof child === "object") {
      if (Array.isArray(child)) {
        for (const item of child) {
          if (item && typeof item.type === "string" && containsRejectOrThrow(item)) {
            return true;
          }
        }
      } else if (typeof child.type === "string") {
        if (containsRejectOrThrow(child)) {
          return true;
        }
      }
    }
  }

  return false;
}

/** Rule 1: no-disk-sqlite */
const noDiskSqlite = {
  meta: {
    type: "problem",
    docs: {
      description: "Ban openDb() calls in test files — use openTestDb() for in-memory SQLite.",
    },
    messages: {
      noDiskSqlite:
        "Use openTestDb() for in-memory SQLite instead of openDb() in tests.",
    },
    schema: [],
  },
  create(context) {
    return {
      "CallExpression[callee.name='openDb']"(node) {
        context.report({ node, messageId: "noDiskSqlite" });
      },
    };
  },
};

/** Rule 2: no-long-sleep */
const noLongSleep = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban Bun.sleep(N) and setTimeout(_, N) where N > 200ms in test files.",
    },
    messages: {
      noLongSleep:
        "Sleep/timeout of {{ms}}ms exceeds 200ms limit. Use polling, setSystemTime, or fake timers.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;

        // --- Bun.sleep(N) ---
        if (
          callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          callee.object.name === "Bun" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "sleep"
        ) {
          const arg = node.arguments[0];
          if (arg && arg.type === "Literal" && typeof arg.value === "number" && arg.value > 200) {
            context.report({
              node,
              messageId: "noLongSleep",
              data: { ms: String(arg.value) },
            });
          }
          return;
        }

        // --- setTimeout(callback, N) ---
        if (
          callee.type === "Identifier" &&
          callee.name === "setTimeout"
        ) {
          const delayArg = node.arguments[1];
          if (
            delayArg &&
            delayArg.type === "Literal" &&
            typeof delayArg.value === "number" &&
            delayArg.value > 200
          ) {
            // Check if the callback is a timeout guard (contains reject() or throw)
            const callback = node.arguments[0];
            if (callback && containsRejectOrThrow(callback)) {
              return; // skip timeout guards
            }

            context.report({
              node,
              messageId: "noLongSleep",
              data: { ms: String(delayArg.value) },
            });
          }
        }
      },
    };
  },
};

/** Rule 3: no-env-mutation — ban ANY process.env mutation in tests */
const noEnvMutation = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Ban all process.env mutations in test files (assignment and delete).",
    },
    messages: {
      noEnvMutation:
        "Do not mutate process.env in tests — use DI (function parameters) instead.",
    },
    schema: [],
  },
  create(context) {
    function isProcessEnv(node) {
      return (
        node.type === "MemberExpression" &&
        node.object.type === "Identifier" &&
        node.object.name === "process" &&
        node.property.type === "Identifier" &&
        node.property.name === "env"
      );
    }

    return {
      // process.env[...] = ... or process.env.FOO = ...
      AssignmentExpression(node) {
        const left = node.left;
        if (left.type === "MemberExpression" && isProcessEnv(left.object)) {
          context.report({ node, messageId: "noEnvMutation" });
        }
      },
      // delete process.env[...] or delete process.env.FOO
      UnaryExpression(node) {
        if (node.operator !== "delete") return;
        const arg = node.argument;
        if (arg.type === "MemberExpression" && isProcessEnv(arg.object)) {
          context.report({ node, messageId: "noEnvMutation" });
        }
      },
    };
  },
};

/** Plugin export */
export default {
  rules: {
    "no-disk-sqlite": noDiskSqlite,
    "no-long-sleep": noLongSleep,
    "no-env-mutation": noEnvMutation,
  },
};
