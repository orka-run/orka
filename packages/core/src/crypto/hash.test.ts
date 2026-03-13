import { describe, expect, test } from "bun:test";
import { blake3, blake3Truncated, sha256, concatBytes } from "./hash";

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function textToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

describe("blake3", () => {
  test("returns 32 bytes for empty input", () => {
    const result = blake3(new Uint8Array(0));
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32);
  });

  test("empty string known test vector", () => {
    // BLAKE3 hash of empty input
    // Official test vector from https://github.com/BLAKE3-team/BLAKE3
    const result = blake3(new Uint8Array(0));
    const hex = hexEncode(result);
    expect(hex).toBe(
      "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
    );
  });

  test("hash of 'abc'", () => {
    const result = blake3(textToBytes("abc"));
    expect(result.length).toBe(32);
    // Should be deterministic
    const result2 = blake3(textToBytes("abc"));
    expect(hexEncode(result)).toBe(hexEncode(result2));
  });

  test("different inputs produce different hashes", () => {
    const h1 = blake3(textToBytes("hello"));
    const h2 = blake3(textToBytes("world"));
    expect(hexEncode(h1)).not.toBe(hexEncode(h2));
  });
});

describe("blake3Truncated", () => {
  test("returns correct length for 8 bytes", () => {
    const result = blake3Truncated(textToBytes("test"), 8);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(8);
  });

  test("returns correct length for 16 bytes", () => {
    const result = blake3Truncated(textToBytes("test"), 16);
    expect(result.length).toBe(16);
  });

  test("truncated output is prefix of full hash", () => {
    const data = textToBytes("some data");
    const full = blake3(data);
    const truncated = blake3Truncated(data, 8);
    // The truncated result should be the first 8 bytes of the full hash
    expect(hexEncode(truncated)).toBe(hexEncode(full.slice(0, 8)));
  });

  test("enroll_id derivation: 8 bytes from prefix + secret", () => {
    const prefix = textToBytes("orka/pair/v1/enroll-id");
    const secret = textToBytes("my-secret-value");
    const combined = concatBytes(prefix, secret);
    const enrollId = blake3Truncated(combined, 8);
    expect(enrollId.length).toBe(8); // 64 bits
    // Should be deterministic
    const enrollId2 = blake3Truncated(concatBytes(prefix, secret), 8);
    expect(hexEncode(enrollId)).toBe(hexEncode(enrollId2));
  });

  test("returns 1 byte when requested", () => {
    const result = blake3Truncated(textToBytes("x"), 1);
    expect(result.length).toBe(1);
  });

  test("returns full 32 bytes when requested", () => {
    const data = textToBytes("data");
    const truncated = blake3Truncated(data, 32);
    const full = blake3(data);
    expect(hexEncode(truncated)).toBe(hexEncode(full));
  });
});

describe("sha256", () => {
  test("returns 32 bytes", () => {
    const result = sha256(new Uint8Array(0));
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32);
  });

  test("empty string known test vector", () => {
    const result = sha256(new Uint8Array(0));
    const hex = hexEncode(result);
    expect(hex).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("hash of 'abc'", () => {
    const result = sha256(textToBytes("abc"));
    const hex = hexEncode(result);
    // Known SHA-256 test vector for "abc"
    expect(hex).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("deterministic output", () => {
    const data = textToBytes("hello world");
    const h1 = sha256(data);
    const h2 = sha256(data);
    expect(hexEncode(h1)).toBe(hexEncode(h2));
  });

  test("different inputs produce different hashes", () => {
    const h1 = sha256(textToBytes("foo"));
    const h2 = sha256(textToBytes("bar"));
    expect(hexEncode(h1)).not.toBe(hexEncode(h2));
  });
});

describe("concatBytes", () => {
  test("concatenates two arrays", () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5, 6]);
    const result = concatBytes(a, b);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("concatenates zero arrays", () => {
    const result = concatBytes();
    expect(result.length).toBe(0);
  });

  test("concatenates single array", () => {
    const a = new Uint8Array([1, 2]);
    const result = concatBytes(a);
    expect(Array.from(result)).toEqual([1, 2]);
  });

  test("concatenates three arrays", () => {
    const a = new Uint8Array([1]);
    const b = new Uint8Array([2]);
    const c = new Uint8Array([3]);
    const result = concatBytes(a, b, c);
    expect(Array.from(result)).toEqual([1, 2, 3]);
  });

  test("handles empty arrays in the mix", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array(0);
    const c = new Uint8Array([3]);
    const result = concatBytes(a, b, c);
    expect(Array.from(result)).toEqual([1, 2, 3]);
  });
});
