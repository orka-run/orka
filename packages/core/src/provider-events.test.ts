import { describe, expect, test } from "bun:test";
import { createEvent } from "./provider-events";

describe("createEvent", () => {
  test("assigns version 1 to new provider runtime events", () => {
    expect(
      createEvent("session.started", "thread-1", {}, { createdAt: "2026-03-11T00:00:00.000Z" }),
    ).toMatchObject({
      v: 1,
      type: "session.started",
      threadId: "thread-1",
      createdAt: "2026-03-11T00:00:00.000Z",
    });
  });
});
