import {
  buildInitialReplayStateFromRecordStart,
  cloneReplayStableState,
  replayReducer,
  STABLE_EVENT_TYPES,
  type RecordingEvent,
  type RecordingSnapshot,
  type ReplayStableState,
} from "@/shared/recording-schema";
import { generateId } from "@/shared/util/ids";

const PERIODIC_SNAPSHOT_MS = 5_000;
const STABLE_EVENTS_PER_SNAPSHOT = 50;
const SEMANTIC_SNAPSHOT_TYPES = new Set<RecordingEvent["type"]>([
  "record-pause",
  "record-resume",
  "language-change",
  "run-start",
  "run-output",
  "run-error",
]);

export type SnapshotBuilder = {
  apply(event: RecordingEvent): void;
  getSnapshots(): RecordingSnapshot[];
  finalize(): RecordingSnapshot[];
  reset(): void;
};

export function createSnapshotBuilder(options: { beforeCapture?: () => void } = {}): SnapshotBuilder {
  let state: ReplayStableState | null = null;
  let lastEvent: RecordingEvent | null = null;
  let lastSnapshotTimestampMs = -Infinity;
  let lastSnapshotSeq = 0;
  let stableEventsSinceSnapshot = 0;
  const snapshots: RecordingSnapshot[] = [];
  let capturePending = false;
  let preparingCapture = false;
  let generation = 0;

  const capture = (event: RecordingEvent) => {
    if (!state || lastSnapshotSeq === event.seq) return;
    snapshots.push({
      id: generateId("snap"),
      timestampMs: event.timestampMs,
      eventSeq: event.seq,
      state: cloneReplayStableState(state),
    });
    lastSnapshotTimestampMs = event.timestampMs;
    lastSnapshotSeq = event.seq;
    stableEventsSinceSnapshot = 0;
  };
  const getSnapshots = () =>
    snapshots.map((snapshot) => ({
      ...snapshot,
      state: cloneReplayStableState(snapshot.state),
    }));
  const captureConsistentState = () => {
    if (preparingCapture) return;
    capturePending = false;
    preparingCapture = true;
    try {
      options.beforeCapture?.();
      if (lastEvent) capture(lastEvent);
    } finally { preparingCapture = false; }
  };
  const requestCapture = (event: RecordingEvent) => {
    if (!options.beforeCapture) { capture(event); return; }
    if (capturePending || preparingCapture) return;
    capturePending = true;
    const requestedGeneration = generation;
    // Wait until every EventBus subscriber received the triggering event.
    // Flushing inside apply() would deliver seq N+1 before N to later listeners.
    queueMicrotask(() => {
      if (capturePending && requestedGeneration === generation) captureConsistentState();
    });
  };

  return {
    apply(event) {
      lastEvent = event;
      if (event.type === "record-start") {
        state = buildInitialReplayStateFromRecordStart(event.payload);
        requestCapture(event);
        return;
      }
      if (!state) return;

      if (STABLE_EVENT_TYPES.has(event.type)) {
        state = replayReducer(state, event);
        stableEventsSinceSnapshot += 1;
      }

      if (
        event.timestampMs - lastSnapshotTimestampMs >= PERIODIC_SNAPSHOT_MS ||
        stableEventsSinceSnapshot >= STABLE_EVENTS_PER_SNAPSHOT ||
        SEMANTIC_SNAPSHOT_TYPES.has(event.type)
      ) {
        requestCapture(event);
      }
    },
    getSnapshots() {
      return getSnapshots();
    },
    finalize() {
      if (options.beforeCapture) captureConsistentState();
      else if (lastEvent) capture(lastEvent);
      return getSnapshots();
    },
    reset() {
      generation += 1;
      capturePending = false;
      state = null;
      lastEvent = null;
      lastSnapshotTimestampMs = -Infinity;
      lastSnapshotSeq = 0;
      stableEventsSinceSnapshot = 0;
      snapshots.length = 0;
    },
  };
}
