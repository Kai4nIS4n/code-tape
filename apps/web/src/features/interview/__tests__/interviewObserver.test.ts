import { describe, expect, it, vi } from "vitest";
import { createInterviewSyncPublisher, type InterviewRealtimeDataChannel } from "../interviewSync";
import {
  buildInitialObserverState,
  createRemoteObserverWorkbench,
  isObserverEventMessage,
  isObserverSnapshotMessage,
  type InterviewObserverEventMessage,
} from "../interviewObserver";
import { INITIAL_REMOTE_INTERVIEW_STABLE_STATE } from "../remoteInterviewInitialState";
import {
  cloneReplayStableState,
  type RecordingEvent,
  type RecordingLanguage,
} from "@/shared/recording-schema";
import { createEventBus } from "@/features/recorder/eventBus";
import { createRecordingClock } from "@/features/recorder/recordingClock";

const envelope = {
  roomId: "room",
  sessionId: "session",
  messageId: "message",
  sentAt: 100,
  stateVersion: 1,
};
const content = (seq: number, language: RecordingLanguage = "javascript"): RecordingEvent => ({
  id: `event-${seq}`,
  seq,
  timestampMs: seq * 10,
  source: "editor",
  track: "main",
  type: "content-change",
  payload: {
    fileId: "main",
    documentId: `source:${language}`,
    version: seq,
    language,
    code: "PRIVATE_SOURCE_SENTINEL",
    contentHash: "PRIVATE_SOURCE_HASH",
    changeReason: "input",
    changeCount: 1,
    flushedBy: "debounce",
  },
});
function fakeChannel() {
  const sent: string[] = [];
  const channel: InterviewRealtimeDataChannel = {
    readyState: "open",
    send: (data) => {
      sent.push(data);
    },
  };
  return { channel, sent };
}
function observerMessage(seq: number): InterviewObserverEventMessage {
  return {
    ...envelope,
    kind: "observer-event",
    event: {
      seq,
      timestampMs: seq * 10,
      type: "document-changed",
      payload: { documentId: "source:javascript", version: seq },
    },
  };
}

describe("lightweight interview observer protocol", () => {
  it("recovers local runtime metadata when run-start send fails before a delivered output", () => {
    const { channel, sent } = fakeChannel();
    const publisher = createInterviewSyncPublisher({
      channel,
      roomId: "room",
      sessionId: "session",
      mode: "observer",
    });
    const send = channel.send;
    channel.send = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("temporary send failure");
      })
      .mockImplementation(send);
    expect(
      publisher.publishRecordingEvent({
        id: "run",
        seq: 1,
        timestampMs: 1,
        source: "runtime",
        track: "runtime",
        type: "run-start",
        payload: {
          language: "javascript",
          runtime: "iframe",
          runId: "run",
          inputDocumentsHash: "original-run-input",
        },
      }),
    ).toEqual({ ok: false, reason: "send-failed" });
    const result = publisher.publishRecordingEvent({
      id: "output",
      seq: 2,
      timestampMs: 2,
      source: "runtime",
      track: "runtime",
      type: "run-output",
      payload: {
        runId: "run",
        stdout: ["completed"],
        stderr: [],
        previewHtml: null,
        status: "success",
      },
    });
    expect(result).toMatchObject({
      ok: true,
      message: { event: { payload: { runId: "run", inputDocumentsHash: "original-run-input" } } },
    });
    expect(publisher.publishSnapshot().ok).toBe(true);
    const snapshot = JSON.parse(sent.at(-1)!);
    expect(snapshot).toMatchObject({
      snapshotSeq: 2,
      state: {
        runtime: {
          activeRunId: "run",
          inputDocumentsHash: "original-run-input",
          status: "success",
          stdout: ["completed"],
        },
      },
    });
    const workbench = createRemoteObserverWorkbench();
    workbench.pushObserverEvent(JSON.parse(sent[0]));
    expect(workbench.getState().snapshotRequestNeeded).toMatchObject({ expectedSeq: 1 });
    expect(workbench.pushObserverSnapshot(snapshot)).toMatchObject({
      expectedSeq: 3,
      snapshotRequestNeeded: null,
      observerState: {
        runtime: {
          status: "success",
          inputDocumentsHash: "original-run-input",
          stdout: ["completed"],
        },
      },
    });
  });

  it("retains opt-in sequence diagnostics without any observer state or output body", () => {
    const sink = vi.fn();
    const workbench = createRemoteObserverWorkbench({ debug: { enabled: true, sink } });
    workbench.pushObserverEvent(observerMessage(2));
    workbench.pushObserverEvent(observerMessage(1));
    workbench.pushObserverEvent(observerMessage(1));
    const state = buildInitialObserverState();
    state.runtime.stdout = ["PRIVATE_RUNTIME_OUTPUT"];
    workbench.pushObserverSnapshot({
      ...envelope,
      kind: "observer-snapshot",
      snapshotSeq: 3,
      snapshotTimeMs: 30,
      state,
    });
    workbench.pushObserverSnapshot({
      ...envelope,
      kind: "observer-snapshot",
      snapshotSeq: 2,
      snapshotTimeMs: 20,
      state,
    });
    const common = { roomId: "room", recordingSessionId: "session" };
    expect(sink.mock.calls.map(([record]) => record)).toEqual([
      {
        ...common,
        event: "observer-event",
        outcome: "buffered",
        seq: 2,
        expectedSeq: 1,
        lastAppliedSeq: 0,
      },
      {
        ...common,
        event: "observer-event",
        outcome: "applied",
        seq: 1,
        expectedSeq: 3,
        lastAppliedSeq: 2,
      },
      {
        ...common,
        event: "observer-event",
        outcome: "superseded",
        seq: 1,
        expectedSeq: 3,
        lastAppliedSeq: 2,
      },
      {
        ...common,
        event: "observer-snapshot",
        outcome: "applied",
        snapshotSeq: 3,
        expectedSeq: 4,
        lastAppliedSeq: 3,
      },
      {
        ...common,
        event: "observer-snapshot",
        outcome: "superseded",
        snapshotSeq: 2,
        expectedSeq: 4,
        lastAppliedSeq: 3,
      },
    ]);
    expect(JSON.stringify(sink.mock.calls)).not.toContain("PRIVATE");
  });

  it("projects all source-bearing lifecycle paths without changing local recording history", () => {
    const { channel, sent } = fakeChannel();
    const initial = cloneReplayStableState(INITIAL_REMOTE_INTERVIEW_STABLE_STATE);
    initial.editor.code = "PRIVATE_INITIAL_SOURCE";
    const publisher = createInterviewSyncPublisher({
      channel,
      roomId: "room",
      sessionId: "session",
      mode: "observer",
      snapshotState: initial,
    });
    const start: RecordingEvent = {
      id: "start",
      seq: 1,
      timestampMs: 0,
      source: "recorder",
      track: "main",
      type: "record-start",
      payload: {
        initialLanguage: "javascript",
        initialFontSize: 16,
        initialTheme: "dark",
        initialDocuments: Object.fromEntries(
          ["javascript", "typescript", "python", "html", "css"].map((language) => [
            language,
            {
              code: `PRIVATE_${language}_SOURCE`,
              cursor: null,
              selection: null,
              scrollTop: 0,
              scrollLeft: 0,
            },
          ]),
        ) as NonNullable<
          Extract<RecordingEvent, { type: "record-start" }>["payload"]["initialDocuments"]
        >,
        selectedAudioDeviceId: null,
        selectedCameraDeviceId: null,
        mediaCapability: {
          audio: "available",
          camera: "available",
          selectedAudioDeviceId: null,
          selectedCameraDeviceId: null,
        },
      },
    };
    initial.editor.documents = start.payload.initialDocuments;
    const history: RecordingEvent[] = [
      start,
      ...(["javascript", "typescript", "python", "html", "css"] as const).map((language, index) =>
        content(index + 2, language),
      ),
      {
        id: "resume",
        seq: 7,
        timestampMs: 70,
        source: "recorder",
        track: "main",
        type: "resume-baseline",
        payload: { reason: "paused-state-changed", snapshot: initial },
      },
    ];
    const before = structuredClone(history);
    publisher.subscribeTo(
      { peek: () => history, subscribe: () => () => {} },
      { includeBacklog: true },
    );
    expect(publisher.publishSnapshot().ok).toBe(true);
    expect(history).toEqual(before);
    expect(sent.join("\n")).not.toContain("PRIVATE_");
    expect(sent.join("\n")).not.toMatch(
      /"(?:code|documents|initialDocuments|contentHash|keys|label)"/,
    );
    expect(sent.map((value) => JSON.parse(value).kind)).toEqual([
      ...Array.from({ length: 7 }, () => "observer-event"),
      "observer-snapshot",
    ]);
    expect(sent.slice(0, 7).map((value) => JSON.parse(value).event.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(JSON.parse(sent[1]).event).toMatchObject({
      type: "document-changed",
      payload: { documentId: "source:javascript", version: 2 },
    });
  });

  it("rejects unexpected source body fields at every nested protocol boundary", () => {
    const event = observerMessage(1);
    expect(isObserverEventMessage(event)).toBe(true);
    expect(isObserverEventMessage({ ...event, code: "injected" })).toBe(false);
    expect(
      isObserverEventMessage({
        ...event,
        event: { ...event.event, payload: { ...event.event.payload, code: "injected" } },
      }),
    ).toBe(false);
    const snapshot = {
      ...envelope,
      kind: "observer-snapshot",
      snapshotSeq: 1,
      snapshotTimeMs: 10,
      state: buildInitialObserverState(),
    };
    expect(isObserverSnapshotMessage(snapshot)).toBe(true);
    expect(
      isObserverSnapshotMessage({ ...snapshot, state: { ...snapshot.state, documents: {} } }),
    ).toBe(false);
    expect(
      isObserverSnapshotMessage({
        ...snapshot,
        state: { ...snapshot.state, view: { ...snapshot.state.view, code: "injected" } },
      }),
    ).toBe(false);
    expect(
      isObserverSnapshotMessage({
        ...snapshot,
        state: { ...snapshot.state, runtime: { ...snapshot.state.runtime, documents: {} } },
      }),
    ).toBe(false);
  });

  it("buffers sequence gaps and replays only events newer than a recovery snapshot", () => {
    const workbench = createRemoteObserverWorkbench();
    expect(workbench.pushObserverEvent(observerMessage(2))).toMatchObject({
      lastAppliedSeq: 0,
      expectedSeq: 1,
      syncStatus: "waiting-for-snapshot",
    });
    expect(workbench.pushObserverEvent(observerMessage(1))).toMatchObject({
      lastAppliedSeq: 2,
      expectedSeq: 3,
      syncStatus: "live",
    });
    expect(workbench.pushObserverEvent(observerMessage(1)).lastAppliedSeq).toBe(2);
    workbench.pushObserverEvent(observerMessage(4));
    expect(
      workbench.pushObserverSnapshot({
        ...envelope,
        kind: "observer-snapshot",
        snapshotSeq: 3,
        snapshotTimeMs: 30,
        state: buildInitialObserverState(),
      }),
    ).toMatchObject({ lastAppliedSeq: 4, expectedSeq: 5, snapshotRequestNeeded: null });
    expect(
      workbench.pushObserverSnapshot({
        ...envelope,
        kind: "observer-snapshot",
        snapshotSeq: 1,
        snapshotTimeMs: 10,
        state: buildInitialObserverState(),
      }).lastAppliedSeq,
    ).toBe(4);
    expect(workbench.getState()).not.toHaveProperty("stableState");
  });

  it("keeps every otherwise unused recording sequence as an empty noop", () => {
    const { channel, sent } = fakeChannel();
    const publisher = createInterviewSyncPublisher({
      channel,
      roomId: "room",
      sessionId: "session",
      mode: "observer",
    });
    const events: RecordingEvent[] = [
      {
        id: "selection",
        seq: 1,
        timestampMs: 10,
        source: "editor",
        track: "main",
        type: "selection-change",
        payload: { cursor: null, selection: null },
      },
      {
        id: "scroll",
        seq: 2,
        timestampMs: 20,
        source: "editor",
        track: "main",
        type: "editor-scroll",
        payload: { scrollTop: 30, scrollLeft: 40 },
      },
      {
        id: "move",
        seq: 3,
        timestampMs: 30,
        source: "pointer",
        track: "ui",
        type: "mouse-move",
        payload: { x: 1, y: 2, containerWidth: 10, containerHeight: 10 },
      },
      {
        id: "click",
        seq: 4,
        timestampMs: 40,
        source: "pointer",
        track: "ui",
        type: "mouse-click",
        payload: { x: 1, y: 2, containerWidth: 10, containerHeight: 10, button: 0 },
      },
      {
        id: "shortcut",
        seq: 5,
        timestampMs: 50,
        source: "shortcut",
        track: "ui",
        type: "shortcut",
        payload: { keys: ["PRIVATE_KEY"], label: "PRIVATE_LABEL", command: "PRIVATE_COMMAND" },
      },
      {
        id: "toggle",
        seq: 6,
        timestampMs: 60,
        source: "media",
        track: "media",
        type: "media-toggle",
        payload: { cameraEnabled: true, microphoneEnabled: true },
      },
      {
        id: "warning",
        seq: 7,
        timestampMs: 70,
        source: "media",
        track: "media",
        type: "media-warning",
        payload: { target: "audio", code: "busy", message: "PRIVATE_DEVICE" },
      },
      {
        id: "camera",
        seq: 8,
        timestampMs: 80,
        source: "media",
        track: "ui",
        type: "camera-position",
        payload: { x: 3, y: 4 },
      },
      {
        id: "chapter",
        seq: 9,
        timestampMs: 90,
        source: "annotation",
        track: "ui",
        type: "chapter-marker",
        payload: { title: "PRIVATE_TITLE", note: "PRIVATE_NOTE" },
      },
    ];
    events.forEach(publisher.publishRecordingEvent);
    const workbench = createRemoteObserverWorkbench();
    sent.forEach((raw, index) => {
      const message = JSON.parse(raw);
      expect(message.event).toEqual({
        seq: index + 1,
        timestampMs: (index + 1) * 10,
        type: "noop",
        payload: {},
      });
      workbench.pushObserverEvent(message);
    });
    expect(workbench.getState()).toMatchObject({
      expectedSeq: 10,
      lastAppliedSeq: 9,
      snapshotRequestNeeded: null,
    });
    expect(sent.join("\n")).not.toContain("PRIVATE_");
  });

  it("preserves candidate lifecycle and view metadata without changing another editor view", () => {
    const { channel, sent } = fakeChannel();
    const publisher = createInterviewSyncPublisher({
      channel,
      roomId: "room",
      sessionId: "session",
      mode: "observer",
    });
    const workbench = createRemoteObserverWorkbench();
    const push = (event: RecordingEvent) => {
      publisher.publishRecordingEvent(event);
      return workbench.pushObserverEvent(JSON.parse(sent.at(-1)!)).observerState;
    };
    expect(
      push({
        id: "pause",
        seq: 1,
        timestampMs: 1,
        source: "recorder",
        track: "main",
        type: "record-pause",
        payload: { reason: "user", stateSeq: 0 },
      }).recordingStatus,
    ).toBe("paused");
    expect(
      push({
        id: "resume",
        seq: 2,
        timestampMs: 2,
        source: "recorder",
        track: "main",
        type: "record-resume",
        payload: { reason: "user" },
      }).recordingStatus,
    ).toBe("recording");
    expect(
      push({
        id: "language",
        seq: 3,
        timestampMs: 3,
        source: "editor",
        track: "main",
        type: "language-change",
        payload: { from: "typescript", to: "html" },
      }).view,
    ).toEqual({ documentId: "source:html", language: "html", fontSize: 14, theme: "dark" });
    expect(
      push({
        id: "stop",
        seq: 4,
        timestampMs: 4,
        source: "recorder",
        track: "main",
        type: "record-stop",
        payload: { reason: "user", durationMs: 4 },
      }).recordingStatus,
    ).toBe("stopped");
  });

  it("attributes results to run-start input identity instead of newer live code and ignores stale runs", () => {
    const { channel, sent } = fakeChannel();
    const publisher = createInterviewSyncPublisher({
      channel,
      roomId: "room",
      sessionId: "session",
      mode: "observer",
    });
    const workbench = createRemoteObserverWorkbench();
    const runStart = (seq: number, runId: string, hash: string): RecordingEvent => ({
      id: `run-${seq}`,
      seq,
      timestampMs: seq,
      source: "runtime",
      track: "runtime",
      type: "run-start",
      payload: { language: "javascript", runtime: "iframe", runId, inputDocumentsHash: hash },
    });
    const output = (seq: number, runId: string): RecordingEvent => ({
      id: `output-${seq}`,
      seq,
      timestampMs: seq,
      source: "runtime",
      track: "runtime",
      type: "run-output",
      payload: {
        runId,
        stdout: [`output ${runId}`],
        stderr: [],
        previewHtml: "<div>preview</div>",
        status: "success",
      },
    });
    const events = [
      runStart(1, "old", "run-input-old"),
      content(2),
      output(3, "old"),
      runStart(4, "new", "run-input-new"),
      output(5, "old"),
      {
        id: "error",
        seq: 6,
        timestampMs: 6,
        source: "runtime",
        track: "runtime",
        type: "run-error",
        payload: {
          runId: "old",
          phase: "runtime",
          message: "stale error",
          stdout: [],
          stderr: [],
          previewHtml: null,
        },
      } as RecordingEvent,
      output(7, "new"),
    ];
    events.forEach((event) => {
      const result = publisher.publishRecordingEvent(event);
      expect(result.ok).toBe(true);
      const message = JSON.parse(sent.at(-1)!);
      expect(isObserverEventMessage(message)).toBe(true);
      const state = workbench.pushObserverEvent(message);
      if (event.seq === 3)
        expect(state.observerState.runtime).toMatchObject({
          status: "success",
          activeRunId: "old",
          inputDocumentsHash: "run-input-old",
          stdout: ["output old"],
        });
      if (event.seq === 5 || event.seq === 6)
        expect(state.observerState.runtime).toMatchObject({
          status: "running",
          activeRunId: "new",
          inputDocumentsHash: "run-input-new",
          stdout: [],
          errorMessage: null,
        });
    });
    expect(workbench.getState()).toMatchObject({
      expectedSeq: 8,
      observerState: {
        runtime: {
          status: "success",
          activeRunId: "new",
          inputDocumentsHash: "run-input-new",
          stdout: ["output new"],
        },
      },
    });
    const mismatch: InterviewObserverEventMessage = {
      ...envelope,
      kind: "observer-event",
      event: {
        seq: 8,
        timestampMs: 8,
        type: "run-output",
        payload: {
          runId: "new",
          inputDocumentsHash: "other-input",
          stdout: ["wrong"],
          stderr: [],
          previewHtml: null,
        },
      },
    };
    expect(workbench.pushObserverEvent(mismatch)).toMatchObject({
      expectedSeq: 9,
      observerState: { runtime: { stdout: ["output new"], inputDocumentsHash: "run-input-new" } },
    });
    expect(publisher.publishSnapshot().ok).toBe(true);
    expect(isObserverSnapshotMessage(JSON.parse(sent.at(-1)!))).toBe(true);
  });

  it.each(["event-count", "time"] as const)(
    "flushes all dirty local documents before a %s observer snapshot without reentry",
    (trigger) => {
      const { channel, sent } = fakeChannel();
      let now = 0,
        dirty = false,
        flushes = 0;
      const clock = createRecordingClock({ nowProvider: () => now });
      clock.start();
      const bus = createEventBus({ clock });
      const publisher = createInterviewSyncPublisher({
        channel,
        roomId: "room",
        sessionId: "session",
        mode: "observer",
        nowProvider: () => now,
        snapshotEventInterval: trigger === "event-count" ? 2 : 100,
        snapshotTimeIntervalMs: 5000,
        beforeSnapshot: () => {
          flushes++;
          if (!dirty) return;
          dirty = false;
          for (const language of ["javascript", "typescript", "python", "html", "css"] as const) {
            const event = content(1, language) as Extract<
              RecordingEvent,
              { type: "content-change" }
            >;
            bus.emit({
              type: "content-change",
              source: "editor",
              track: "main",
              payload: event.payload,
            });
          }
          expect(publisher.publishSnapshot()).toEqual({
            ok: false,
            reason: "snapshot-in-progress",
          });
        },
      });
      publisher.subscribeTo(bus);
      const first = content(1) as Extract<RecordingEvent, { type: "content-change" }>;
      bus.emit({ type: "content-change", source: "editor", track: "main", payload: first.payload });
      dirty = true;
      if (trigger === "time") now = 5000;
      if (trigger === "event-count")
        bus.emit({
          type: "selection-change",
          source: "editor",
          track: "main",
          payload: { cursor: null, selection: null },
        });
      else
        bus.emit({
          type: "shortcut",
          source: "shortcut",
          track: "ui",
          payload: { keys: ["PRIVATE_KEY"], label: "PRIVATE_LABEL" },
        });
      const messages = sent.map((raw) => JSON.parse(raw));
      expect(
        messages
          .filter((message) => message.kind === "observer-event")
          .map((message) => message.event.seq),
      ).toEqual([1, 2, 3, 4, 5, 6, 7]);
      const snapshots = messages.filter((message) => message.kind === "observer-snapshot");
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].snapshotSeq).toBe(7);
      expect(flushes).toBe(1);
      expect(sent.join("\n")).not.toContain("PRIVATE_");
      expect(bus.peek().filter((event) => event.type === "content-change")).toHaveLength(6);
      expect(bus.peek().find((event) => event.type === "content-change")?.payload).toHaveProperty(
        "code",
        "PRIVATE_SOURCE_SENTINEL",
      );
    },
  );

  it("still emits periodic observer snapshots after 50 full-body local edits", () => {
    const { channel, sent } = fakeChannel();
    const history = Array.from({ length: 50 }, (_, index) => content(index + 1));
    const publisher = createInterviewSyncPublisher({
      channel,
      roomId: "room",
      sessionId: "session",
      mode: "observer",
      nowProvider: () => 100,
    });
    publisher.subscribeTo(
      { peek: () => history, subscribe: () => () => {} },
      { includeBacklog: true },
    );
    const messages = sent.map((raw) => JSON.parse(raw));
    expect(messages.filter((message) => message.kind === "observer-event")).toHaveLength(50);
    expect(messages.at(-1)).toMatchObject({ kind: "observer-snapshot", snapshotSeq: 50 });
    expect(sent.join("\n")).not.toContain("PRIVATE_");
  });

  it("reconstructs skipped backlog metadata on channel reopen and preserves result identity", () => {
    const { channel, sent } = fakeChannel();
    const history: RecordingEvent[] = [
      {
        id: "run",
        seq: 1,
        timestampMs: 1,
        source: "runtime",
        track: "runtime",
        type: "run-start",
        payload: {
          language: "javascript",
          runtime: "iframe",
          runId: "run",
          inputDocumentsHash: "execution-input",
        },
      },
      content(2),
    ];
    const publisher = createInterviewSyncPublisher({
      channel,
      roomId: "room",
      sessionId: "session",
      mode: "observer",
      snapshotEventInterval: 2,
    });
    const callback = vi.fn();
    publisher.subscribeTo(
      { peek: () => history, subscribe: () => () => {} },
      { includeBacklog: true, shouldPublishEvent: () => false, onPublishResult: callback },
    );
    expect(callback).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    const snapshot = JSON.parse(sent[0]);
    expect(snapshot).toMatchObject({
      kind: "observer-snapshot",
      snapshotSeq: 2,
      state: {
        runtime: { activeRunId: "run", inputDocumentsHash: "execution-input", status: "running" },
      },
    });
    const workbench = createRemoteObserverWorkbench();
    workbench.pushObserverSnapshot(snapshot);
    const result = publisher.publishRecordingEvent({
      id: "output",
      seq: 3,
      timestampMs: 3,
      source: "runtime",
      track: "runtime",
      type: "run-output",
      payload: { runId: "run", stdout: ["okay"], stderr: [], previewHtml: null, status: "success" },
    });
    if (!result.ok) throw new Error("publish failed");
    expect(workbench.pushObserverEvent(result.message)).toMatchObject({
      lastAppliedSeq: 3,
      observerState: { runtime: { stdout: ["okay"], inputDocumentsHash: "execution-input" } },
    });
  });

  it("retains covered local sequence after a failed send and guards snapshot flush errors", () => {
    const { channel, sent } = fakeChannel();
    const beforeSnapshot = vi.fn();
    const publisher = createInterviewSyncPublisher({
      channel,
      roomId: "room",
      sessionId: "session",
      mode: "observer",
      beforeSnapshot,
    });
    expect(publisher.publishSnapshot()).toEqual({ ok: false, reason: "no-published-events" });
    channel.readyState = "closed";
    expect(publisher.publishRecordingEvent(content(1))).toEqual({
      ok: false,
      reason: "channel-not-open",
    });
    expect(publisher.publishSnapshot()).toEqual({ ok: false, reason: "channel-not-open" });
    channel.readyState = "open";
    const originalSend = channel.send;
    channel.send = () => {
      throw new Error("send failed");
    };
    expect(publisher.publishRecordingEvent(content(1))).toEqual({
      ok: false,
      reason: "send-failed",
    });
    channel.send = originalSend;
    expect(publisher.publishSnapshot().ok).toBe(true);
    expect(JSON.parse(sent.at(-1)!)).toMatchObject({ snapshotSeq: 1 });
    expect(publisher.publishRecordingEvent(content(1)).ok).toBe(true);
    beforeSnapshot.mockImplementationOnce(() => {
      throw new Error("flush failed");
    });
    expect(publisher.publishSnapshot()).toEqual({ ok: false, reason: "flush-failed" });
    expect(publisher.publishSnapshot().ok).toBe(true);
    expect(JSON.parse(sent.at(-1)!)).toMatchObject({ snapshotSeq: 1 });
  });

  it("labels a snapshot with its unsent local event sequence rather than the last successful send", () => {
    const { channel, sent } = fakeChannel();
    const publisher = createInterviewSyncPublisher({
      channel,
      roomId: "room",
      sessionId: "session",
      mode: "observer",
    });
    publisher.publishRecordingEvent(content(1));
    publisher.publishRecordingEvent(content(2));
    const send = channel.send;
    channel.send = () => {
      throw new Error("temporary failure");
    };
    expect(
      publisher.publishRecordingEvent({
        id: "view",
        seq: 3,
        timestampMs: 30,
        source: "editor",
        track: "main",
        type: "language-change",
        payload: { from: "typescript", to: "html" },
      }),
    ).toEqual({ ok: false, reason: "send-failed" });
    channel.send = send;
    expect(publisher.publishSnapshot().ok).toBe(true);
    expect(JSON.parse(sent.at(-1)!)).toMatchObject({
      snapshotSeq: 3,
      snapshotTimeMs: 30,
      state: { view: { documentId: "source:html", language: "html" } },
    });
    expect(sent.slice(0, -1).map((raw) => JSON.parse(raw).event.seq)).toEqual([1, 2]);
    // Retrying an old event is allowed to send, but cannot rewind the local snapshot.
    publisher.publishRecordingEvent({
      id: "old-view",
      seq: 1,
      timestampMs: 1,
      source: "editor",
      track: "main",
      type: "language-change",
      payload: { from: "typescript", to: "javascript" },
    });
    expect(publisher.publishSnapshot().ok).toBe(true);
    expect(JSON.parse(sent.at(-1)!)).toMatchObject({
      snapshotSeq: 3,
      snapshotTimeMs: 30,
      state: { view: { language: "html" } },
    });
  });

  it("returns and publishes cloned observer runtime arrays to isolate consumers", () => {
    const initial = buildInitialObserverState();
    initial.runtime.stdout = ["original"];
    const workbench = createRemoteObserverWorkbench({ initialState: initial });
    initial.runtime.stdout.push("changed outside");
    const seen = vi.fn((state) => {
      state.observerState.runtime.stdout.push("listener mutation");
    });
    const unsubscribe = workbench.subscribe(seen);
    workbench.pushObserverEvent(observerMessage(1));
    const snapshot = workbench.getState();
    snapshot.observerState.runtime.stdout.push("return mutation");
    expect(workbench.getState().observerState.runtime.stdout).toEqual(["original"]);
    unsubscribe();
    workbench.pushObserverEvent(observerMessage(2));
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
