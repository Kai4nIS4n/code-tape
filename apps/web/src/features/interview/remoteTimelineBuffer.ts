import type { RecordingEvent } from "@/shared/recording-schema";

export type SnapshotRequestNeed = {
  reason: "gap-detected" | "hash-mismatch";
  expectedSeq: number;
  lastAppliedSeq: number;
};

export type RemoteTimelineBufferResult<TEvent = RecordingEvent> = {
  appliedEvents: TEvent[];
  expectedSeq: number;
  lastAppliedSeq: number;
  snapshotRequestNeeded: SnapshotRequestNeed | null;
};
export type RemoteTimelineBufferSnapshotResult<TEvent = RecordingEvent> =
  RemoteTimelineBufferResult<TEvent> & { snapshotAccepted: boolean };
export type RemoteTimelineBufferOptions = { initialExpectedSeq?: number };
export type RemoteTimelineBuffer<TEvent extends { seq: number } = RecordingEvent> = {
  pushRecordingEvent<TMessage extends { event: TEvent }>(
    message: TMessage,
  ): RemoteTimelineBufferResult<TEvent>;
  pushSnapshot<TMessage extends { snapshotSeq: number }>(
    message: TMessage,
  ): RemoteTimelineBufferSnapshotResult<TEvent>;
  state(): Omit<RemoteTimelineBufferResult<TEvent>, "appliedEvents">;
};

/** Both observer modes use the same ordering rules, not the same content state. */
export function createRemoteTimelineBuffer<TEvent extends { seq: number } = RecordingEvent>(
  options: RemoteTimelineBufferOptions = {},
): RemoteTimelineBuffer<TEvent> {
  let expectedSeq = options.initialExpectedSeq ?? 1;
  let lastAppliedSeq = expectedSeq - 1;
  const bufferedEvents = new Map<number, TEvent>();
  const currentState = () => ({
    expectedSeq,
    lastAppliedSeq,
    snapshotRequestNeeded:
      bufferedEvents.size > 0
        ? { reason: "gap-detected" as const, expectedSeq, lastAppliedSeq }
        : null,
  });
  const drainContiguousEvents = (): TEvent[] => {
    const appliedEvents: TEvent[] = [];
    while (bufferedEvents.has(expectedSeq)) {
      const next = bufferedEvents.get(expectedSeq);
      if (!next) break;
      bufferedEvents.delete(expectedSeq);
      appliedEvents.push(next);
      lastAppliedSeq = next.seq;
      expectedSeq = next.seq + 1;
    }
    return appliedEvents;
  };
  return {
    pushRecordingEvent({ event }) {
      if (event.seq <= lastAppliedSeq) return { appliedEvents: [], ...currentState() };
      if (event.seq >= expectedSeq && !bufferedEvents.has(event.seq))
        bufferedEvents.set(event.seq, event);
      return { appliedEvents: drainContiguousEvents(), ...currentState() };
    },
    pushSnapshot({ snapshotSeq }) {
      if (snapshotSeq < lastAppliedSeq)
        return { snapshotAccepted: false, appliedEvents: [], ...currentState() };
      for (const seq of bufferedEvents.keys()) {
        if (seq <= snapshotSeq) bufferedEvents.delete(seq);
      }
      lastAppliedSeq = snapshotSeq;
      expectedSeq = snapshotSeq + 1;
      return { snapshotAccepted: true, appliedEvents: drainContiguousEvents(), ...currentState() };
    },
    state: currentState,
  };
}
