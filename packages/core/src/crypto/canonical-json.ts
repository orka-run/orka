/**
 * Deterministic JSON serialization with sorted keys.
 *
 * Used for computing `pair_context` and transport `prologue` where
 * both sides must arrive at the exact same byte representation.
 *
 * Rules:
 *   - Object keys are sorted lexicographically (recursive)
 *   - Arrays preserve element order
 *   - No extra whitespace
 *   - Numbers: no trailing zeros, no leading plus, `-0` becomes `0`
 *   - Strings: only required chars escaped (via JSON.stringify on primitives)
 *   - null, true, false pass through as-is
 */

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    // Normalize -0 to 0
    if (Object.is(value, -0)) {
      return "0";
    }
    // JSON.stringify handles the rest: no trailing zeros, no leading plus,
    // Infinity/NaN become "null" per JSON spec
    if (!isFinite(value)) {
      return "null";
    }
    return JSON.stringify(value);
  }

  if (typeof value === "string") {
    // JSON.stringify escapes only required characters and produces
    // a deterministic output for any given string
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalJson(item));
    return "[" + items.join(",") + "]";
  }

  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys.map(
      (key) =>
        JSON.stringify(key) +
        ":" +
        canonicalJson((value as Record<string, unknown>)[key]),
    );
    return "{" + pairs.join(",") + "}";
  }

  // Functions, symbols, etc. — treat as undefined → null
  return "null";
}
