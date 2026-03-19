import { describe, expect, test } from "bun:test";
import { canonicalJson } from "./canonical-json";

describe("canonicalJson", () => {
  test("empty object", () => {
    expect(canonicalJson({})).toBe("{}");
  });

  test("sorts object keys alphabetically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  test("sorts nested object keys recursively", () => {
    const input = { z: { b: 1, a: 2 }, a: { d: 3, c: 4 } };
    expect(canonicalJson(input)).toBe('{"a":{"c":4,"d":3},"z":{"a":2,"b":1}}');
  });

  test("deeply nested objects", () => {
    const input = { c: { b: { a: 1 } } };
    expect(canonicalJson(input)).toBe('{"c":{"b":{"a":1}}}');
  });

  test("arrays preserve element order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  test("arrays of objects have sorted keys", () => {
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  test("empty array", () => {
    expect(canonicalJson([])).toBe("[]");
  });

  test("null", () => {
    expect(canonicalJson(null)).toBe("null");
  });

  test("undefined becomes null", () => {
    expect(canonicalJson(undefined)).toBe("null");
  });

  test("true", () => {
    expect(canonicalJson(true)).toBe("true");
  });

  test("false", () => {
    expect(canonicalJson(false)).toBe("false");
  });

  // Number handling
  test("integer", () => {
    expect(canonicalJson(42)).toBe("42");
  });

  test("negative integer", () => {
    expect(canonicalJson(-7)).toBe("-7");
  });

  test("float with no trailing zeros", () => {
    // 1.5 should stay as 1.5
    expect(canonicalJson(1.5)).toBe("1.5");
  });

  test("1.0 becomes 1 (no trailing zero)", () => {
    // In JS, 1.0 === 1, so JSON.stringify(1.0) is "1"
    expect(canonicalJson(1.0)).toBe("1");
  });

  test("-0 becomes 0", () => {
    expect(canonicalJson(-0)).toBe("0");
  });

  test("Infinity becomes null", () => {
    expect(canonicalJson(Infinity)).toBe("null");
  });

  test("-Infinity becomes null", () => {
    expect(canonicalJson(-Infinity)).toBe("null");
  });

  test("NaN becomes null", () => {
    expect(canonicalJson(NaN)).toBe("null");
  });

  test("very small float", () => {
    expect(canonicalJson(0.000001)).toBe("0.000001");
  });

  test("scientific notation number", () => {
    // 1e-7 in JS is 1e-7 when stringified
    expect(canonicalJson(1e-7)).toBe("1e-7");
  });

  // String handling
  test("simple string", () => {
    expect(canonicalJson("hello")).toBe('"hello"');
  });

  test("string with quotes", () => {
    expect(canonicalJson('say "hi"')).toBe('"say \\"hi\\""');
  });

  test("string with backslash", () => {
    expect(canonicalJson("a\\b")).toBe('"a\\\\b"');
  });

  test("string with newline", () => {
    expect(canonicalJson("line1\nline2")).toBe('"line1\\nline2"');
  });

  test("string with tab", () => {
    expect(canonicalJson("a\tb")).toBe('"a\\tb"');
  });

  test("string with unicode", () => {
    const result = canonicalJson("\u0000");
    expect(result).toBe('"\\u0000"');
  });

  test("empty string", () => {
    expect(canonicalJson("")).toBe('""');
  });

  // Mixed/complex structures
  test("object with mixed value types", () => {
    const input = { s: "hello", n: 42, b: true, nil: null, a: [1, 2] };
    expect(canonicalJson(input)).toBe(
      '{"a":[1,2],"b":true,"n":42,"nil":null,"s":"hello"}',
    );
  });

  test("no whitespace in output", () => {
    const result = canonicalJson({ a: 1, b: [2, 3], c: { d: 4 } });
    expect(result).not.toContain(" ");
    expect(result).not.toContain("\n");
    expect(result).not.toContain("\t");
  });

  test("deterministic: same input always produces same output", () => {
    const input = { z: 1, a: 2, m: { x: 3, b: 4 } };
    const result1 = canonicalJson(input);
    const result2 = canonicalJson(input);
    expect(result1).toBe(result2);
  });

  test("deterministic: different key insertion order produces same output", () => {
    const obj1: Record<string, number> = {};
    obj1["b"] = 1;
    obj1["a"] = 2;

    const obj2: Record<string, number> = {};
    obj2["a"] = 2;
    obj2["b"] = 1;

    expect(canonicalJson(obj1)).toBe(canonicalJson(obj2));
  });

  test("object with undefined value omits key (JS semantics)", () => {
    // In JS objects, keys with undefined values are included by Object.keys
    // but canonicalJson serializes undefined as "null"
    const input = { a: 1, b: undefined };
    expect(canonicalJson(input)).toBe('{"a":1,"b":null}');
  });

  test("nested array in object", () => {
    expect(canonicalJson({ items: [{ z: 1, a: 2 }] })).toBe(
      '{"items":[{"a":2,"z":1}]}',
    );
  });
});
