/**
 * ESLint/oxlint plugin: dashboard
 *
 * Rules:
 *   - no-raw-transport: Ban raw transport.request() — use typed RPC client
 */

const noRawTransport = {
  meta: {
    type: "problem",
    docs: {
      description: "Ban raw transport.request() calls — use typed RPC client instead.",
    },
    messages: {
      noRawTransport:
        "Use typed RPC client instead of raw transport.request(). Import useRpcClient from lib/transportContext.",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.() ?? "";
    // Skip excluded files
    if (
      filename.endsWith(".test.ts") ||
      filename.endsWith(".test.tsx") ||
      filename.includes("rpcClient.ts") ||
      filename.includes("wsTransport.ts")
    ) {
      return {};
    }

    return {
      // Match: transport.request(...)
      "CallExpression[callee.type='MemberExpression'][callee.property.name='request']"(node) {
        if (
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === "transport"
        ) {
          context.report({ node, messageId: "noRawTransport" });
        }
      },
    };
  },
};

export default {
  meta: { name: "dashboard" },
  rules: {
    "no-raw-transport": noRawTransport,
  },
};
