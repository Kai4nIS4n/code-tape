import { describe, expect, it, vi } from "vitest";
import { createDebugLog } from "../debugLog";

describe("opt-in safe frontend diagnosis", () => {
  it("is disabled by default and discards non-allowlisted fields when enabled", () => {
    const sink = vi.fn();
    const record = {
      event: "replay-seek" as const,
      outcome: "applied" as const,
      packageGeneration: 2,
      seekGeneration: 3,
      targetMs: 1000,
      code: "SECRET SOURCE",
      token: "secret-token",
      url: "https://private.example/asset",
    };
    createDebugLog({ enabled: false, sink })(record);
    expect(sink).not.toHaveBeenCalled();
    createDebugLog({ enabled: true, sink })(record);
    expect(sink).toHaveBeenCalledWith({
      event: "replay-seek",
      outcome: "applied",
      packageGeneration: 2,
      seekGeneration: 3,
      targetMs: 1000,
    });
    expect(JSON.stringify(sink.mock.calls)).not.toMatch(/SECRET|secret-token|private\.example/u);
  });
  it("drops unsafe identifiers/numbers and isolates a throwing diagnostic sink", () => {
    const sink = vi.fn();
    createDebugLog({ enabled: true, sink })({
      event: "observer-event",
      outcome: "buffered",
      roomId: "room-1",
      recordingSessionId: "https://private/token",
      seq: 3,
      expectedSeq: Number.NaN,
      lastAppliedSeq: -1,
    });
    expect(sink).toHaveBeenCalledWith({
      event: "observer-event",
      outcome: "buffered",
      roomId: "room-1",
      seq: 3,
    });
    expect(() =>
      createDebugLog({
        enabled: true,
        sink: () => {
          throw new Error("sink failure");
        },
      })({ event: "replay-load", outcome: "applied" }),
    ).not.toThrow();
  });
});
