import { describe, expect, test } from "bun:test";
import {
  RPC_PARSE_ERROR,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_INVALID_PARAMS,
  RPC_INTERNAL_ERROR,
  RPC_NOT_FOUND,
  RPC_CONFLICT,
} from "./rpc";

describe("RPC error codes", () => {
  test("standard JSON-RPC error codes are negative", () => {
    expect(RPC_PARSE_ERROR).toBe(-32700);
    expect(RPC_INVALID_REQUEST).toBe(-32600);
    expect(RPC_METHOD_NOT_FOUND).toBe(-32601);
    expect(RPC_INVALID_PARAMS).toBe(-32602);
    expect(RPC_INTERNAL_ERROR).toBe(-32603);
  });

  test("application error codes are positive HTTP-style", () => {
    expect(RPC_NOT_FOUND).toBe(404);
    expect(RPC_CONFLICT).toBe(409);
  });

  test("all error codes are unique", () => {
    const codes = [
      RPC_PARSE_ERROR,
      RPC_INVALID_REQUEST,
      RPC_METHOD_NOT_FOUND,
      RPC_INVALID_PARAMS,
      RPC_INTERNAL_ERROR,
      RPC_NOT_FOUND,
      RPC_CONFLICT,
    ];
    expect(new Set(codes).size).toBe(codes.length);
  });
});
