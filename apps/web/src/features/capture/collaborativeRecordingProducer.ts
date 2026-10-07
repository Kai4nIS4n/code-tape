import type * as Y from "yjs";
import { RECORDING_LANGUAGES, buildInitialReplayStateFromRecordStart, replayReducer } from "@/shared/recording-schema";
import type { ContentChangePayload, EventBus, RecordingClock, RecordingLanguage, ReplayStableState } from "@/shared/recording-schema";
import type { CollaborationSession } from "@/features/collaboration/collaborationSession";
import { REMOTE_COLLABORATION_ORIGIN } from "@/features/collaboration/collaborationSession";

export function createCollaborativeRecordingProducer(deps: {
  session: CollaborationSession;
  bus: EventBus;
  clock: RecordingClock;
  getCurrentLanguage(): RecordingLanguage;
}) {
  type Pending = { code: string; count: number; origin: ContentChangePayload["origin"]; debounce: ReturnType<typeof setTimeout>; maximum: ReturnType<typeof setTimeout> };
  const pending = new Map<RecordingLanguage, Pending>();
  const versions = new Map<RecordingLanguage, number>();
  const lastCodes = new Map<RecordingLanguage, string>();
  let active = false;
  let disposed = false;
  let pausedDocuments: Record<RecordingLanguage, string> | null = null;
  const clear = (language: RecordingLanguage) => {
    const entry = pending.get(language);
    if (entry) { clearTimeout(entry.debounce); clearTimeout(entry.maximum); }
    pending.delete(language);
  };
  const flushDocument = (language: RecordingLanguage, reason: ContentChangePayload["flushedBy"]) => {
    const entry = pending.get(language);
    if (!entry || !active) return;
    clear(language);
    if (lastCodes.get(language) === entry.code) return;
    lastCodes.set(language, entry.code);
    const version = (versions.get(language) ?? 0) + 1;
    versions.set(language, version);
    deps.bus.emit({ type: "content-change", source: "editor", track: "main", payload: {
      fileId: "main", documentId: `source:${language}`, version, language, code: entry.code,
      contentHash: hashContent(entry.code), changeCount: entry.count, changeReason: "programmatic", flushedBy: reason, origin: entry.origin,
    } });
  };
  const flushPending = (reason: ContentChangePayload["flushedBy"] = "snapshot") => {
    for (const language of RECORDING_LANGUAGES) flushDocument(language, reason);
  };
  const subscriptions = RECORDING_LANGUAGES.map((language) => {
    const text = deps.session.getText(language);
    const observer = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (!active || disposed) return;
      const existing = pending.get(language);
      if (existing) clearTimeout(existing.debounce);
      const origin = transaction.origin === REMOTE_COLLABORATION_ORIGIN ? "remote" : "local";
      pending.set(language, {
        code: text.toString(), count: (existing?.count ?? 0) + 1,
        origin: existing && existing.origin !== origin ? "unknown" : origin,
        debounce: setTimeout(() => flushDocument(language, "debounce"), 300),
        maximum: existing?.maximum ?? setTimeout(() => flushDocument(language, "idle"), 1000),
      });
    };
    text.observe(observer);
    return () => text.unobserve(observer);
  });
  return {
    flushPending,
    start() { if (!disposed) { active = true; for (const language of RECORDING_LANGUAGES) lastCodes.set(language, deps.session.getText(language).toString()); } },
    pause() { flushPending("pause"); pausedDocuments = deps.session.getDocuments(); active = false; },
    resume() {
      if (disposed) return;
      active = true;
      const documents = deps.session.getDocuments();
      if (pausedDocuments && RECORDING_LANGUAGES.some((language) => documents[language] !== pausedDocuments![language])) {
        const start = deps.bus.peek().find((event) => event.type === "record-start");
        if (start?.type === "record-start") {
          let state: ReplayStableState = deps.bus.peek().reduce(replayReducer, buildInitialReplayStateFromRecordStart(start.payload));
          const nextDocuments = { ...state.editor.documents! };
          for (const language of RECORDING_LANGUAGES) nextDocuments[language] = { ...nextDocuments[language], code: documents[language] };
          const language = deps.getCurrentLanguage();
          state = { ...state, editor: { ...state.editor, documents: nextDocuments, language, activeDocumentId: `source:${language}`, code: documents[language] } };
          deps.bus.emit({ type: "resume-baseline", source: "recorder", track: "main", payload: { reason: "paused-state-changed", snapshot: state } });
        }
      }
      pausedDocuments = null;
      for (const language of RECORDING_LANGUAGES) lastCodes.set(language, documents[language]);
    },
    stop() { flushPending("stop"); active = false; },
    dispose() { disposed = true; active = false; subscriptions.forEach((unsubscribe) => unsubscribe()); for (const language of RECORDING_LANGUAGES) clear(language); },
  };
}

function hashContent(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}
