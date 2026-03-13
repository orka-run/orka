import { RPC_METHOD_NOT_FOUND } from "./rpc";

/**
 * Thrown when the daemon responds with JSON-RPC -32601 (METHOD_NOT_FOUND).
 * Callers can catch this to degrade gracefully for optional methods
 * that may not exist on older daemon versions.
 */
export class MethodNotFoundError extends Error {
  readonly methodName: string;
  readonly code = RPC_METHOD_NOT_FOUND;

  constructor(methodName: string, message?: string) {
    super(message ?? `Method not found: ${methodName}`);
    this.name = "MethodNotFoundError";
    this.methodName = methodName;
  }
}

/**
 * Type guard: returns true if `err` is a MethodNotFoundError.
 */
export function isMethodNotFound(err: unknown): err is MethodNotFoundError {
  return err instanceof MethodNotFoundError;
}

/**
 * Methods that are known-optional and may not exist on older daemons.
 * Callers should degrade gracefully when these return METHOD_NOT_FOUND.
 */
export const OPTIONAL_RPC_METHODS = new Set([
  "backfillSession",
  "terminalOpen",
  "terminalWrite",
  "terminalResize",
  "terminalClose",
  "terminalList",
]);
