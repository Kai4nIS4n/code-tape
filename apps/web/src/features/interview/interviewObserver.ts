import {
  STABLE_EVENT_TYPES,
  type EventBus,
  type RecordingDocumentId,
  type RecordingEvent,
  type RecordingLanguage,
  type RecordingTheme,
  type ReplayStableState,
} from "@/shared/recording-schema";
import { createDebugLog, type DebugLogOptions } from "@/shared/debugLog";
import { createRemoteTimelineBuffer, type SnapshotRequestNeed } from "./remoteTimelineBuffer";
import type {
  InterviewRealtimeBaseMessage,
  InterviewSyncPublisherOptions,
  InterviewSyncSubscribeOptions,
} from "./interviewSync";

export type InterviewObserverView = {
  documentId: RecordingDocumentId;
  language: RecordingLanguage;
  fontSize: number;
  theme: RecordingTheme;
};
export type InterviewObserverRuntime = {
  status: "idle" | "running" | "success" | "error";
  stdout: string[];
  stderr: string[];
  previewHtml: string | null;
  errorMessage: string | null;
  activeRunId: string | null;
  inputDocumentsHash: string | null;
};
export type InterviewObserverState = {
  view: InterviewObserverView;
  recordingStatus: "idle" | "recording" | "paused" | "stopped";
  runtime: InterviewObserverRuntime;
};
export type ObserverState = InterviewObserverState;
type EventEnvelope = { seq: number; timestampMs: number };
type RunIdentity = { runId: string; inputDocumentsHash: string | null };
type RunResult = RunIdentity & { stdout: string[]; stderr: string[]; previewHtml: string | null };
export type InterviewObserverEvent = EventEnvelope &
  (
    | { type: "document-changed"; payload: { documentId: RecordingDocumentId; version: number } }
    | { type: "record-start" | "view-change"; payload: { view: InterviewObserverView } }
    | {
        type: "record-pause" | "record-resume" | "record-stop" | "noop";
        payload: Record<string, never>;
      }
    | {
        type: "resume-baseline";
        payload: { view: InterviewObserverView; runtime: InterviewObserverRuntime };
      }
    | { type: "run-start"; payload: RunIdentity }
    | { type: "run-output"; payload: RunResult }
    | { type: "run-error"; payload: RunResult & { errorMessage: string } }
  );
export type InterviewObserverEventMessage = InterviewRealtimeBaseMessage & {
  kind: "observer-event";
  event: InterviewObserverEvent;
  stateVersion: number;
};
export type InterviewObserverSnapshotMessage = InterviewRealtimeBaseMessage & {
  kind: "observer-snapshot";
  snapshotSeq: number;
  snapshotTimeMs: number;
  stateVersion: number;
  state: InterviewObserverState;
};
export type InterviewObserverPublishResult =
  | { ok: true; message: InterviewObserverEventMessage }
  | { ok: false; reason: "channel-not-open" | "send-failed" };
export type InterviewObserverSnapshotPublishResult =
  | { ok: true; message: InterviewObserverSnapshotMessage }
  | {
      ok: false;
      reason:
        | "channel-not-open"
        | "send-failed"
        | "no-published-events"
        | "snapshot-in-progress"
        | "flush-failed";
    };
export type InterviewObserverPublisher = {
  publishRecordingEvent(event: RecordingEvent): InterviewObserverPublishResult;
  publishSnapshot(): InterviewObserverSnapshotPublishResult;
  subscribeTo(
    bus: Pick<EventBus, "subscribe"> & Partial<Pick<EventBus, "peek">>,
    options?: Omit<InterviewSyncSubscribeOptions, "onPublishResult"> & {
      onPublishResult?: (event: RecordingEvent, result: InterviewObserverPublishResult) => void;
    },
  ): () => void;
};

/** Read metadata explicitly: never clone or retain the replay editor documents. */
export function buildInitialObserverState(
  source?: Pick<ReplayStableState, "editor">,
): InterviewObserverState {
  return {
    view: source
      ? observerView(source.editor)
      : { documentId: "source:typescript", language: "typescript", fontSize: 14, theme: "dark" },
    recordingStatus: "idle",
    runtime: {
      status: "idle",
      stdout: [],
      stderr: [],
      previewHtml: null,
      errorMessage: null,
      activeRunId: null,
      inputDocumentsHash: null,
    },
  };
}
function observerView(editor: ReplayStableState["editor"]): InterviewObserverView {
  return {
    documentId: `source:${editor.language}`,
    language: editor.language,
    fontSize: editor.fontSize,
    theme: editor.theme,
  };
}
function observerRuntime(runtime: ReplayStableState["runtime"]): InterviewObserverRuntime {
  return {
    status: runtime.status,
    stdout: [...runtime.stdout],
    stderr: [...runtime.stderr],
    previewHtml: runtime.previewHtml,
    errorMessage: runtime.errorMessage,
    activeRunId: runtime.activeRunId ?? null,
    inputDocumentsHash: runtime.inputDocumentsHash ?? null,
  };
}
export function cloneObserverState(state: InterviewObserverState): InterviewObserverState {
  return {
    view: { ...state.view },
    recordingStatus: state.recordingStatus,
    runtime: {
      ...state.runtime,
      stdout: [...state.runtime.stdout],
      stderr: [...state.runtime.stderr],
    },
  };
}
export function projectRecordingEvent(
  event: RecordingEvent,
  state: InterviewObserverState,
): InterviewObserverEvent {
  const base = { seq: event.seq, timestampMs: event.timestampMs };
  switch (event.type) {
    case "content-change":
      return {
        ...base,
        type: "document-changed",
        payload: {
          documentId: event.payload.documentId ?? `source:${event.payload.language}`,
          version: event.payload.version,
        },
      };
    case "record-start":
      return {
        ...base,
        type: "record-start",
        payload: {
          view: {
            documentId: `source:${event.payload.initialLanguage}`,
            language: event.payload.initialLanguage,
            fontSize: event.payload.initialFontSize,
            theme: event.payload.initialTheme,
          },
        },
      };
    case "language-change":
      return {
        ...base,
        type: "view-change",
        payload: {
          view: {
            ...state.view,
            documentId: `source:${event.payload.to}`,
            language: event.payload.to,
          },
        },
      };
    case "resume-baseline":
      return {
        ...base,
        type: "resume-baseline",
        payload: {
          view: observerView(event.payload.snapshot.editor),
          runtime: observerRuntime(event.payload.snapshot.runtime),
        },
      };
    case "record-pause":
    case "record-resume":
    case "record-stop":
      return { ...base, type: event.type, payload: {} };
    case "run-start":
      return {
        ...base,
        type: "run-start",
        payload: {
          runId: event.payload.runId,
          inputDocumentsHash: event.payload.inputDocumentsHash ?? null,
        },
      };
    case "run-output":
    case "run-error": {
      const payload = {
        runId: event.payload.runId,
        inputDocumentsHash:
          event.payload.runId === state.runtime.activeRunId
            ? state.runtime.inputDocumentsHash
            : null,
        stdout: [...event.payload.stdout],
        stderr: [...event.payload.stderr],
        previewHtml: event.payload.previewHtml,
      };
      return event.type === "run-output"
        ? { ...base, type: "run-output", payload }
        : {
            ...base,
            type: "run-error",
            payload: { ...payload, errorMessage: event.payload.message },
          };
    }
    default:
      return { ...base, type: "noop", payload: {} };
  }
}
export function observerReducer(
  state: InterviewObserverState,
  event: InterviewObserverEvent,
): InterviewObserverState {
  switch (event.type) {
    case "record-start":
      return {
        ...buildInitialObserverState(),
        view: { ...event.payload.view },
        recordingStatus: "recording",
      };
    case "record-pause":
      return { ...state, recordingStatus: "paused" };
    case "record-resume":
      return { ...state, recordingStatus: "recording" };
    case "record-stop":
      return { ...state, recordingStatus: "stopped" };
    case "resume-baseline":
      return {
        ...state,
        recordingStatus: "recording",
        view: { ...event.payload.view },
        runtime: {
          ...event.payload.runtime,
          stdout: [...event.payload.runtime.stdout],
          stderr: [...event.payload.runtime.stderr],
        },
      };
    case "view-change":
      return { ...state, view: { ...event.payload.view } };
    case "run-start":
      return {
        ...state,
        runtime: {
          ...buildInitialObserverState().runtime,
          status: "running",
          activeRunId: event.payload.runId,
          inputDocumentsHash: event.payload.inputDocumentsHash,
        },
      };
    case "run-output":
    case "run-error":
      if (
        event.payload.runId !== state.runtime.activeRunId ||
        event.payload.inputDocumentsHash !== state.runtime.inputDocumentsHash
      )
        return state;
      return {
        ...state,
        runtime: {
          ...state.runtime,
          status: event.type === "run-output" ? "success" : "error",
          stdout: [...event.payload.stdout],
          stderr: [...event.payload.stderr],
          previewHtml: event.payload.previewHtml,
          errorMessage: event.type === "run-error" ? event.payload.errorMessage : null,
        },
      };
    default:
      return state;
  }
}

export type RemoteObserverWorkbenchState = {
  observerState: InterviewObserverState;
  expectedSeq: number;
  lastAppliedSeq: number;
  syncStatus: "idle" | "live" | "waiting-for-snapshot";
  snapshotRequestNeeded: SnapshotRequestNeed | null;
};
export type RemoteObserverWorkbench = {
  getState(): RemoteObserverWorkbenchState;
  pushObserverEvent(message: InterviewObserverEventMessage): RemoteObserverWorkbenchState;
  pushObserverSnapshot(message: InterviewObserverSnapshotMessage): RemoteObserverWorkbenchState;
  subscribe(listener: (state: RemoteObserverWorkbenchState) => void): () => void;
};
export function createRemoteObserverWorkbench(
  options: {
    initialState?: InterviewObserverState;
    initialExpectedSeq?: number;
    debug?: DebugLogOptions;
  } = {},
): RemoteObserverWorkbench {
  let observerState = cloneObserverState(options.initialState ?? buildInitialObserverState());
  const buffer = createRemoteTimelineBuffer<InterviewObserverEvent>({
    initialExpectedSeq: options.initialExpectedSeq,
  });
  const debug = createDebugLog(options.debug);
  const trace = (
    message: InterviewObserverEventMessage | InterviewObserverSnapshotMessage,
    outcome: "applied" | "buffered" | "superseded",
  ) => {
    const state = buffer.state();
    debug({
      event: message.kind,
      outcome,
      roomId: message.roomId,
      recordingSessionId: message.sessionId,
      expectedSeq: state.expectedSeq,
      lastAppliedSeq: state.lastAppliedSeq,
      ...(message.kind === "observer-event"
        ? { seq: message.event.seq }
        : { snapshotSeq: message.snapshotSeq }),
    });
  };
  const listeners = new Set<(state: RemoteObserverWorkbenchState) => void>();
  const snapshot = (): RemoteObserverWorkbenchState => {
    const state = buffer.state();
    return {
      ...state,
      observerState: cloneObserverState(observerState),
      syncStatus: state.snapshotRequestNeeded
        ? "waiting-for-snapshot"
        : state.lastAppliedSeq > 0
          ? "live"
          : "idle",
    };
  };
  const notify = () => {
    const state = snapshot();
    listeners.forEach((listener) => listener(snapshot()));
    return state;
  };
  return {
    getState: snapshot,
    pushObserverEvent(message) {
      const previous = buffer.state();
      const result = buffer.pushRecordingEvent(message);
      observerState = result.appliedEvents.reduce(observerReducer, observerState);
      trace(
        message,
        message.event.seq <= previous.lastAppliedSeq
          ? "superseded"
          : result.appliedEvents.length
            ? "applied"
            : "buffered",
      );
      return notify();
    },
    pushObserverSnapshot(message) {
      const result = buffer.pushSnapshot(message);
      if (result.snapshotAccepted) observerState = cloneObserverState(message.state);
      observerState = result.appliedEvents.reduce(observerReducer, observerState);
      trace(message, result.snapshotAccepted ? "applied" : "superseded");
      return notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function createInterviewObserverPublisher({
  snapshotState,
  ...options
}: InterviewSyncPublisherOptions): InterviewObserverPublisher {
  let state = buildInitialObserverState(snapshotState);
  let lastCoveredSeq: number | null = null;
  let lastTimestampMs = 0;
  let stableEventsSinceSnapshot = 0;
  let lastSnapshotAt: number | null = null;
  let preparingSnapshot = false;
  const now = options.nowProvider ?? (() => Date.now());
  const base = () => ({
    roomId: options.roomId,
    sessionId: options.sessionId,
    messageId: options.messageIdProvider?.() ?? crypto.randomUUID(),
    sentAt: now(),
    stateVersion: options.stateVersionProvider?.() ?? 0,
  });
  const advance = (recording: RecordingEvent, event = projectRecordingEvent(recording, state)) => {
    // Recovery snapshots describe candidate-local facts, not transport delivery.
    // A retry or an already-published backlog entry must not rewind that state.
    if (lastCoveredSeq !== null && event.seq <= lastCoveredSeq) return;
    state = observerReducer(state, event);
    lastCoveredSeq = event.seq;
    lastTimestampMs = event.timestampMs;
    if (STABLE_EVENT_TYPES.has(recording.type)) stableEventsSinceSnapshot++;
  };
  const publishRecordingEvent = (recording: RecordingEvent): InterviewObserverPublishResult => {
    const event = projectRecordingEvent(recording, state);
    advance(recording, event);
    if (options.channel.readyState !== "open") return { ok: false, reason: "channel-not-open" };
    const message: InterviewObserverEventMessage = { ...base(), kind: "observer-event", event };
    try {
      options.channel.send(JSON.stringify(message));
    } catch {
      return { ok: false, reason: "send-failed" };
    }
    return { ok: true, message };
  };
  const publishSnapshot = (): InterviewObserverSnapshotPublishResult => {
    if (preparingSnapshot) return { ok: false, reason: "snapshot-in-progress" };
    if (options.channel.readyState !== "open") return { ok: false, reason: "channel-not-open" };
    preparingSnapshot = true;
    try {
      try {
        options.beforeSnapshot?.();
      } catch {
        return { ok: false, reason: "flush-failed" };
      }
      if (lastCoveredSeq === null) return { ok: false, reason: "no-published-events" };
      const message: InterviewObserverSnapshotMessage = {
        ...base(),
        kind: "observer-snapshot",
        snapshotSeq: lastCoveredSeq,
        snapshotTimeMs: lastTimestampMs,
        state: cloneObserverState(state),
      };
      try {
        options.channel.send(JSON.stringify(message));
      } catch {
        return { ok: false, reason: "send-failed" };
      }
      stableEventsSinceSnapshot = 0;
      lastSnapshotAt = now();
      return { ok: true, message };
    } finally {
      preparingSnapshot = false;
    }
  };
  const maybeSnapshot = () => {
    if (preparingSnapshot || lastCoveredSeq === null) return;
    const time = now();
    lastSnapshotAt ??= time;
    if (
      stableEventsSinceSnapshot >= (options.snapshotEventInterval ?? 50) ||
      time - lastSnapshotAt >= (options.snapshotTimeIntervalMs ?? 5000)
    )
      publishSnapshot();
  };
  return {
    publishRecordingEvent,
    publishSnapshot,
    subscribeTo(bus, config = {}) {
      const publish = (event: RecordingEvent) => {
        if (config.shouldPublishEvent?.(event) === false) {
          advance(event);
          maybeSnapshot();
          return;
        }
        const result = publishRecordingEvent(event);
        config.onPublishResult?.(event, result);
        if (result.ok) maybeSnapshot();
      };
      if (config.includeBacklog) bus.peek?.().forEach(publish);
      return bus.subscribe(publish);
    },
  };
}

const LANGUAGES = new Set(["javascript", "typescript", "python", "html", "css"]);
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    object(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function integer(value: unknown): value is number {
  return number(value) && Number.isSafeInteger(value);
}
function text(value: unknown): value is string {
  return typeof value === "string";
}
function nullableText(value: unknown): value is string | null {
  return value === null || text(value);
}
function texts(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text);
}
function view(value: unknown): value is InterviewObserverView {
  return (
    exact(value, ["documentId", "language", "fontSize", "theme"]) &&
    text(value.language) &&
    LANGUAGES.has(value.language) &&
    value.documentId === `source:${value.language}` &&
    number(value.fontSize) &&
    value.fontSize > 0 &&
    (value.theme === "light" || value.theme === "dark")
  );
}
function runtime(value: unknown): value is InterviewObserverRuntime {
  return (
    exact(value, [
      "status",
      "stdout",
      "stderr",
      "previewHtml",
      "errorMessage",
      "activeRunId",
      "inputDocumentsHash",
    ]) &&
    ["idle", "running", "success", "error"].includes(value.status as string) &&
    texts(value.stdout) &&
    texts(value.stderr) &&
    nullableText(value.previewHtml) &&
    nullableText(value.errorMessage) &&
    nullableText(value.activeRunId) &&
    nullableText(value.inputDocumentsHash)
  );
}
function observerState(value: unknown): value is InterviewObserverState {
  return (
    exact(value, ["view", "recordingStatus", "runtime"]) &&
    view(value.view) &&
    runtime(value.runtime) &&
    ["idle", "recording", "paused", "stopped"].includes(value.recordingStatus as string)
  );
}
function base(value: Record<string, unknown>): boolean {
  return (
    text(value.roomId) &&
    value.roomId.length > 0 &&
    text(value.sessionId) &&
    value.sessionId.length > 0 &&
    text(value.messageId) &&
    value.messageId.length > 0 &&
    number(value.sentAt) &&
    integer(value.stateVersion)
  );
}
function observerEvent(value: unknown): value is InterviewObserverEvent {
  if (
    !exact(value, ["seq", "timestampMs", "type", "payload"]) ||
    !integer(value.seq) ||
    value.seq < 1 ||
    !number(value.timestampMs)
  )
    return false;
  const payload = value.payload;
  switch (value.type) {
    case "document-changed":
      return (
        exact(payload, ["documentId", "version"]) &&
        text(payload.documentId) &&
        LANGUAGES.has(payload.documentId.replace(/^source:/, "")) &&
        payload.documentId.startsWith("source:") &&
        integer(payload.version)
      );
    case "record-start":
    case "view-change":
      return exact(payload, ["view"]) && view(payload.view);
    case "resume-baseline":
      return exact(payload, ["view", "runtime"]) && view(payload.view) && runtime(payload.runtime);
    case "noop":
    case "record-pause":
    case "record-resume":
    case "record-stop":
      return exact(payload, []);
    case "run-start":
      return (
        exact(payload, ["runId", "inputDocumentsHash"]) &&
        text(payload.runId) &&
        payload.runId.length > 0 &&
        nullableText(payload.inputDocumentsHash)
      );
    case "run-output":
    case "run-error":
      return (
        exact(payload, [
          "runId",
          "inputDocumentsHash",
          "stdout",
          "stderr",
          "previewHtml",
          ...(value.type === "run-error" ? ["errorMessage"] : []),
        ]) &&
        text(payload.runId) &&
        payload.runId.length > 0 &&
        nullableText(payload.inputDocumentsHash) &&
        texts(payload.stdout) &&
        texts(payload.stderr) &&
        nullableText(payload.previewHtml) &&
        (value.type !== "run-error" || text(payload.errorMessage))
      );
    default:
      return false;
  }
}
export function isObserverEventMessage(value: unknown): value is InterviewObserverEventMessage {
  return (
    exact(value, ["kind", "roomId", "sessionId", "messageId", "sentAt", "stateVersion", "event"]) &&
    value.kind === "observer-event" &&
    base(value) &&
    observerEvent(value.event)
  );
}
export function isObserverSnapshotMessage(
  value: unknown,
): value is InterviewObserverSnapshotMessage {
  return (
    exact(value, [
      "kind",
      "roomId",
      "sessionId",
      "messageId",
      "sentAt",
      "stateVersion",
      "snapshotSeq",
      "snapshotTimeMs",
      "state",
    ]) &&
    value.kind === "observer-snapshot" &&
    base(value) &&
    integer(value.snapshotSeq) &&
    number(value.snapshotTimeMs) &&
    observerState(value.state)
  );
}
