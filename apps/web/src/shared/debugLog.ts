type DebugEvent =
  | "replay-load"
  | "replay-seek"
  | "observer-event"
  | "observer-snapshot"
  | "observer-snapshot-request"
  | "collab-generated"
  | "collab-local-persisted"
  | "collab-send-attempt"
  | "collab-send-failed"
  | "collab-durable-ack"
  | "collab-remote-apply";
type DebugOutcome =
  | "started"
  | "applied"
  | "buffered"
  | "superseded"
  | "hash-mismatch"
  | "send-called"
  | "send-failed"
  | "failed";
export type DebugLogRecord = {
  event: DebugEvent;
  outcome: DebugOutcome;
  packageGeneration?: number;
  seekGeneration?: number;
  targetMs?: number;
  timelineTimeMs?: number;
  seq?: number;
  expectedSeq?: number;
  lastAppliedSeq?: number;
  snapshotSeq?: number;
  epoch?: number;
  persistedRevision?: number;
  updateBytes?: number;
  pendingUpdateCount?: number;
  roomId?: string;
  recordingSessionId?: string;
  updateId?: string;
  connectionId?: string;
};
export type DebugLogOptions = { enabled?: boolean; sink?: (record: DebugLogRecord) => void };
const EVENTS = new Set<DebugEvent>([
  "replay-load",
  "replay-seek",
  "observer-event",
  "observer-snapshot",
  "observer-snapshot-request",
  "collab-generated",
  "collab-local-persisted",
  "collab-send-attempt",
  "collab-send-failed",
  "collab-durable-ack",
  "collab-remote-apply",
]);
const OUTCOMES = new Set<DebugOutcome>([
  "started",
  "applied",
  "buffered",
  "superseded",
  "hash-mismatch",
  "send-called",
  "send-failed",
  "failed",
]);
const NUMBERS = [
  "packageGeneration",
  "seekGeneration",
  "targetMs",
  "timelineTimeMs",
  "seq",
  "expectedSeq",
  "lastAppliedSeq",
  "snapshotSeq",
  "epoch",
  "persistedRevision",
  "updateBytes",
  "pendingUpdateCount",
] as const;

/** Opt-in diagnosis only; no payloads, URLs, credentials or persistent telemetry. */
export function createDebugLog(options: DebugLogOptions = {}) {
  const enabled = options.enabled ?? import.meta.env?.VITE_CODE_TAPE_DEBUG_ENABLED === "true";
  const sink = options.sink ?? ((record) => console.debug("[code-tape-debug]", record));
  return (record: DebugLogRecord) => {
    if (!enabled || !EVENTS.has(record.event) || !OUTCOMES.has(record.outcome)) return;
    const safe: DebugLogRecord = { event: record.event, outcome: record.outcome };
    for (const key of NUMBERS) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) safe[key] = value;
    }
    for (const key of ["roomId", "recordingSessionId", "updateId", "connectionId"] as const) {
      const value = record[key];
      if (typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value)) safe[key] = value;
    }
    try {
      sink(safe);
    } catch {
      /* Diagnostics cannot interrupt playback or synchronization. */
    }
  };
}
