import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CodeEditor, type CodeEditorHandle } from "@/features/editor/CodeEditor";
import { createIframeRuntime } from "@/features/runtime-preview/iframeRuntime";
import { createPreviewCompiler } from "@/features/runtime-preview/previewCompiler";
import { PreviewPane } from "@/features/runtime-preview/PreviewPane";
import { RuntimeOutputPanel } from "@/features/runtime-preview/RuntimeOutputPanel";
import { createRuntimeProducer } from "@/features/capture/runtimeProducer";
import { createEventBus } from "@/features/recorder/eventBus";
import { createRecordingClock } from "@/features/recorder/recordingClock";
import { RECORDING_LANGUAGES } from "@/shared/recording-schema";
import type { RecordingLanguage, RecordingScriptLanguage, ReplayStableState } from "@/shared/recording-schema";
import { CollaborationStatus } from "./CollaborationStatus";
import type { CollaborationSession } from "./collaborationSession";

/** Interviewer's local execution is deliberately not connected to the recording bus. */
export function CollaborativeEditorWorkspace({ session }: { session: CollaborationSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const editor = useRef<CodeEditorHandle | null>(null);
  const [language, setLanguage] = useState<RecordingLanguage>("javascript");
  const scriptLanguage = useRef<RecordingScriptLanguage>("javascript");
  const [runtimeState, setRuntimeState] = useState<ReplayStableState["runtime"]>({ status: "idle", stdout: [], stderr: [], previewHtml: null, errorMessage: null });
  const stack = useMemo(() => {
    const clock = createRecordingClock();
    const bus = createEventBus({ clock });
    const runtime = createIframeRuntime();
    const producer = createRuntimeProducer({ clock, bus, runtime, compiler: createPreviewCompiler() });
    return { bus, runtime, producer };
  }, []);
  useEffect(() => {
    const unsubscribe = stack.bus.subscribe((event) => {
      if (event.type === "run-start") setRuntimeState({ status: "running", stdout: [], stderr: [], previewHtml: null, errorMessage: null, activeRunId: event.payload.runId, inputDocumentsHash: event.payload.inputDocumentsHash });
      else if (event.type === "run-output" || event.type === "run-error") setRuntimeState((current) => current.activeRunId !== event.payload.runId ? current : {
        ...current, status: event.type === "run-output" ? "success" : "error", stdout: event.payload.stdout, stderr: event.payload.stderr, previewHtml: event.payload.previewHtml,
        errorMessage: event.type === "run-error" ? event.payload.message : null,
      });
    });
    return () => { unsubscribe(); stack.producer.dispose(); stack.runtime.reset(); };
  }, [stack]);
  const run = async () => {
    if (language === "python" || runtimeState.status === "running") return;
    const documents = session.getDocuments();
    try { await stack.producer.trigger({ language, source: documents[language], documents, activeScriptLanguage: scriptLanguage.current }); }
    catch (error) { setRuntimeState((current) => ({ ...current, status: "error", errorMessage: error instanceof Error ? error.message : String(error) })); }
  };
  return <div className="flex h-full min-h-0 flex-col">
    <CollaborationStatus session={session} />
    <div className="flex items-center gap-3 border-b border-border px-4 py-2 text-xs">
      <label>我的文档 <select aria-label="协同文档" className="rounded border border-border bg-background px-2 py-1" value={language} onChange={(event) => {
        const next = event.target.value as RecordingLanguage; setLanguage(next);
        if (next === "javascript" || next === "typescript") scriptLanguage.current = next;
      }}>{RECORDING_LANGUAGES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <button type="button" disabled={language === "python" || runtimeState.status === "running" || !state.ready || state.status === "revoked"} onClick={() => void run()} className="rounded bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50">本地试跑</button>
      <span className="text-muted">结果仅自己可见，不进入候选人录制</span>
    </div>
    <div className="min-h-[288px] flex-1"><CodeEditor ref={editor} collaboration={session} language={language} initialValue="" fontSize={14} theme="dark" readOnly={!state.ready || state.status === "revoked"} onCommand={(command) => { if (command === "run") void run(); }} /></div>
    {runtimeState.previewHtml ? <div className="h-40 shrink-0"><PreviewPane runtime={stack.runtime} previewHtml={runtimeState.previewHtml} theme="dark" showReset={false} /></div> : null}
    <div className="max-h-40 overflow-auto border-t border-border"><RuntimeOutputPanel runtime={runtimeState} /></div>
  </div>;
}
