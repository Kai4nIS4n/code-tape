import {
  buildInitialReplayStateFromRecordStart,
  cloneReplayStableState,
  replayReducer,
  STABLE_EVENT_TYPES,
  type EventBus,
  type RecordingEvent,
  type ReplayStableState,
} from "@/shared/recording-schema";
import {
  createInterviewObserverPublisher,
  type InterviewObserverEventMessage,
  type InterviewObserverSnapshotMessage,
  type InterviewObserverPublisher,
} from "./interviewObserver";
export {
  createRemoteTimelineBuffer,
  type RemoteTimelineBuffer,
  type RemoteTimelineBufferOptions,
  type RemoteTimelineBufferResult,
  type RemoteTimelineBufferSnapshotResult,
  type SnapshotRequestNeed,
} from "./remoteTimelineBuffer";

export type InterviewRealtimeDataChannel = {
  readyState: "connecting" | "open" | "closing" | "closed";
  send(data: string): void;
};

export type InterviewRealtimeBaseMessage = {
  roomId: string;
  sessionId: string;
  messageId: string;
  sentAt: number;
};

export type InterviewRecordingEventMessage = InterviewRealtimeBaseMessage & {
  kind: "recording-event";
  event: RecordingEvent;
  stateVersion: number;
  contentHash?: string;
};

export type InterviewSnapshotMessage = InterviewRealtimeBaseMessage & {
  kind: "state-snapshot";
  snapshotSeq: number;
  snapshotTimeMs: number;
  stateVersion: number;
  state: ReplayStableState;
};

export type InterviewSnapshotRequestMessage = InterviewRealtimeBaseMessage & {
  kind: "snapshot-request";
  reason: "gap-timeout" | "hash-mismatch" | "manual-reconnect";
  expectedSeq: number;
  lastAppliedSeq: number;
};

export type InterviewControlMessage = InterviewRealtimeBaseMessage & {
  kind: "control";
  action: "recording-started" | "recording-paused" | "recording-resumed" | "interview-ended";
  reason?: string;
};

export type InterviewAckMessage = InterviewRealtimeBaseMessage & {
  kind: "ack";
  ackedMessageId: string;
  lastAppliedSeq: number;
};

export type InterviewRealtimeMessage =
  | InterviewRecordingEventMessage
  | InterviewSnapshotMessage
  | InterviewObserverEventMessage
  | InterviewObserverSnapshotMessage
  | InterviewSnapshotRequestMessage
  | InterviewControlMessage
  | InterviewAckMessage;

export type InterviewPublishResult =
  | { ok: true; message: InterviewRecordingEventMessage }
  | { ok: false; reason: "channel-not-open" | "send-failed" };

export type InterviewSnapshotPublishResult =
  | { ok: true; message: InterviewSnapshotMessage }
  | { ok: false; reason: "channel-not-open" | "send-failed" | "no-published-events" | "snapshot-in-progress" | "flush-failed" };

export type InterviewSyncPublisherOptions = {
  /** Legacy read-only observation still transmits full recording history. */
  mode?: "legacy" | "observer";
  channel: InterviewRealtimeDataChannel;
  roomId: string;
  sessionId: string;
  messageIdProvider?: () => string;
  nowProvider?: () => number;
  stateVersionProvider?: () => number;
  snapshotState?: ReplayStableState;
  snapshotEventInterval?: number;
  snapshotTimeIntervalMs?: number;
  /** Flush pending recorded text after the triggering event was published. */
  beforeSnapshot?: () => void;
};

export type InterviewSyncPublisher = {
  publishRecordingEvent(event: RecordingEvent): InterviewPublishResult;
  publishSnapshot(): InterviewSnapshotPublishResult;
  subscribeTo(
    bus: Pick<EventBus, "subscribe"> & Partial<Pick<EventBus, "peek">>,
    options?: InterviewSyncSubscribeOptions,
  ): () => void;
};

export type InterviewSyncSubscribeOptions = {
  includeBacklog?: boolean;
  shouldPublishEvent?: (event: RecordingEvent) => boolean;
  onPublishResult?: (event: RecordingEvent, result: InterviewPublishResult) => void;
};

export function createInterviewSyncPublisher(
  options: InterviewSyncPublisherOptions & { mode: "observer" },
): InterviewObserverPublisher;
export function createInterviewSyncPublisher(
  options: InterviewSyncPublisherOptions & { mode?: "legacy" },
): InterviewSyncPublisher;
export function createInterviewSyncPublisher(
  options: InterviewSyncPublisherOptions,
): InterviewSyncPublisher | InterviewObserverPublisher;
export function createInterviewSyncPublisher(
  options: InterviewSyncPublisherOptions,
): InterviewSyncPublisher | InterviewObserverPublisher {
  return options.mode === "observer"
    ? createInterviewObserverPublisher(options)
    : createLegacyInterviewSyncPublisher(options);
}

function createLegacyInterviewSyncPublisher(
  options: InterviewSyncPublisherOptions,
): InterviewSyncPublisher {
  const messageIdProvider = options.messageIdProvider ?? createMessageId;
  const nowProvider = options.nowProvider ?? (() => Date.now());
  const stateVersionProvider = options.stateVersionProvider ?? (() => 0);
  const snapshotEventInterval = options.snapshotEventInterval ?? DEFAULT_SNAPSHOT_EVENT_INTERVAL;
  const snapshotTimeIntervalMs =
    options.snapshotTimeIntervalMs ?? DEFAULT_SNAPSHOT_TIME_INTERVAL_MS;
  const tracksSnapshots = options.snapshotState !== undefined;

  let snapshotState = options.snapshotState
    ? cloneReplayStableState(options.snapshotState)
    : null;
  let lastPublishedSeq: number | null = null;
  let lastPublishedTimestampMs = 0;
  let stableEventsSinceSnapshot = 0;
  let lastSnapshotAtMs: number | null = null;
  let preparingSnapshot = false;

  const advanceSnapshotState = (event: RecordingEvent) => {
    if (snapshotState) {
      // record-start carries the candidate's actual initial setup (language,
      // font, theme); replayReducer leaves it unchanged, so seed from it
      // directly — otherwise snapshots would carry hard-coded defaults.
      snapshotState =
        event.type === "record-start"
          ? buildInitialReplayStateFromRecordStart(event.payload)
          : replayReducer(snapshotState, event);
    }
    lastPublishedSeq = event.seq;
    lastPublishedTimestampMs = event.timestampMs;
    if (STABLE_EVENT_TYPES.has(event.type)) {
      stableEventsSinceSnapshot += 1;
    }
  };

  const publishRecordingEvent = (event: RecordingEvent): InterviewPublishResult => {
    if (options.channel.readyState !== "open") {
      return { ok: false, reason: "channel-not-open" };
    }

    const message: InterviewRecordingEventMessage = {
      kind: "recording-event",
      roomId: options.roomId,
      sessionId: options.sessionId,
      messageId: messageIdProvider(),
      sentAt: nowProvider(),
      event,
      stateVersion: stateVersionProvider(),
      ...contentHashFor(event),
    };

    try {
      options.channel.send(JSON.stringify(message));
    } catch {
      return { ok: false, reason: "send-failed" };
    }

    advanceSnapshotState(event);
    return { ok: true, message };
  };

  const publishSnapshot = (): InterviewSnapshotPublishResult => {
    if (preparingSnapshot) return { ok: false, reason: "snapshot-in-progress" };
    if (options.channel.readyState !== "open") {
      return { ok: false, reason: "channel-not-open" };
    }
    preparingSnapshot = true;
    try {
      try { options.beforeSnapshot?.(); }
      catch { return { ok: false, reason: "flush-failed" }; }
      if (!snapshotState || lastPublishedSeq === null) {
        return { ok: false, reason: "no-published-events" };
      }
      const message: InterviewSnapshotMessage = {
        kind: "state-snapshot",
        roomId: options.roomId,
        sessionId: options.sessionId,
        messageId: messageIdProvider(),
        sentAt: nowProvider(),
        snapshotSeq: lastPublishedSeq,
        snapshotTimeMs: lastPublishedTimestampMs,
        stateVersion: stateVersionProvider(),
        state: cloneReplayStableState(snapshotState),
      };
      try { options.channel.send(JSON.stringify(message)); }
      catch { return { ok: false, reason: "send-failed" }; }
      stableEventsSinceSnapshot = 0;
      lastSnapshotAtMs = nowProvider();
      return { ok: true, message };
    } finally {
      preparingSnapshot = false;
    }
  };

  const maybeEmitSnapshot = () => {
    if (preparingSnapshot || !tracksSnapshots || lastPublishedSeq === null) return;
    const now = nowProvider();
    if (lastSnapshotAtMs === null) {
      lastSnapshotAtMs = now;
    }
    const dueByEvents = stableEventsSinceSnapshot >= snapshotEventInterval;
    const dueByTime = now - lastSnapshotAtMs >= snapshotTimeIntervalMs;
    if (dueByEvents || dueByTime) {
      publishSnapshot();
    }
  };

  return {
    publishRecordingEvent,
    publishSnapshot,
    subscribeTo(bus, subscribeOptions = {}) {
      const publishFromSubscription = (event: RecordingEvent) => {
        if (subscribeOptions.shouldPublishEvent?.(event) === false) {
          // Event was already published by a prior publisher (e.g. after a
          // DataChannel reopen). Still advance the running snapshot state and
          // re-check the snapshot threshold so a reopened channel can resync
          // from the reconstructed backlog even without new edits.
          advanceSnapshotState(event);
          maybeEmitSnapshot();
          return;
        }
        const result = publishRecordingEvent(event);
        subscribeOptions.onPublishResult?.(event, result);
        if (result.ok) {
          maybeEmitSnapshot();
        }
      };

      if (subscribeOptions.includeBacklog) {
        bus.peek?.().forEach(publishFromSubscription);
      }

      return bus.subscribe(publishFromSubscription);
    },
  };
}

const DEFAULT_SNAPSHOT_EVENT_INTERVAL = 50;
const DEFAULT_SNAPSHOT_TIME_INTERVAL_MS = 5000;

function contentHashFor(event: RecordingEvent): Pick<InterviewRecordingEventMessage, "contentHash"> {
  if (event.type !== "content-change") {
    return {};
  }
  return { contentHash: event.payload.contentHash };
}

export type BuildSnapshotRequestInput = {
  roomId: string;
  sessionId: string;
  reason: InterviewSnapshotRequestMessage["reason"];
  expectedSeq: number;
  lastAppliedSeq: number;
  messageIdProvider?: () => string;
  nowProvider?: () => number;
};

export function buildSnapshotRequestMessage(
  input: BuildSnapshotRequestInput,
): InterviewSnapshotRequestMessage {
  return {
    kind: "snapshot-request",
    roomId: input.roomId,
    sessionId: input.sessionId,
    messageId: (input.messageIdProvider ?? createMessageId)(),
    sentAt: (input.nowProvider ?? (() => Date.now()))(),
    reason: input.reason,
    expectedSeq: input.expectedSeq,
    lastAppliedSeq: input.lastAppliedSeq,
  };
}

export function parseSnapshotRequestMessage(data: unknown): InterviewSnapshotRequestMessage | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { kind?: unknown }).kind !== "snapshot-request"
  ) {
    return null;
  }
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.roomId !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.messageId !== "string" ||
    !isFiniteNumber(value.sentAt) ||
    !isSnapshotRequestReason(value.reason) ||
    !isFiniteNumber(value.expectedSeq) ||
    !isFiniteNumber(value.lastAppliedSeq)
  ) {
    return null;
  }
  return {
    kind: "snapshot-request",
    roomId: value.roomId,
    sessionId: value.sessionId,
    messageId: value.messageId,
    sentAt: value.sentAt,
    reason: value.reason,
    expectedSeq: value.expectedSeq,
    lastAppliedSeq: value.lastAppliedSeq,
  };
}

function isSnapshotRequestReason(
  value: unknown,
): value is InterviewSnapshotRequestMessage["reason"] {
  return value === "gap-timeout" || value === "hash-mismatch" || value === "manual-reconnect";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function createMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
