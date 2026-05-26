import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { createReplayScheduler, defaultTickStrategy } from "./replayScheduler";
import { createTimelineClock } from "./timelineClock";
import { ReplayControls } from "./ReplayControls";
import { CodeEditor } from "@/features/editor/CodeEditor";
import { PreviewPane } from "@/features/runtime-preview/PreviewPane";
import { createIframeRuntime } from "@/features/runtime-preview/iframeRuntime";
import { createRecordingStore } from "@/features/library/recordingStore";
import type {
  RecordingPackageV1,
  ReplaySchedulerState,
  ReplayStableState,
} from "@/shared/recording-schema";

const INITIAL_SCHEDULER_STATE: ReplaySchedulerState = {
  status: "loading",
  timelineTimeMs: 0,
  playbackRate: 1,
  lastAppliedSeq: 0,
  mediaStatus: "none",
  driftMs: 0,
};

const INITIAL_STABLE_STATE: ReplayStableState = {
  editor: {
    code: "",
    language: "javascript",
    cursor: null,
    selection: null,
    scrollTop: 0,
    scrollLeft: 0,
    fontSize: 14,
    theme: "dark",
  },
  pointer: null,
  media: { microphoneEnabled: false, cameraEnabled: false, cameraPosition: { x: 0, y: 0 } },
  runtime: { status: "idle", stdout: [], stderr: [], previewHtml: null, errorMessage: null },
};

/**
 * ReplayPage — wires the replay core (scheduler + clock + repository + runtime)
 * and renders the playback layout.
 *
 * UI shell is intentionally minimal. Mouse laser, shortcut badge overlay,
 * console panel rendering, chapter marker tooltips are delegated to issues.
 */
export function ReplayPage() {
  const { id } = useParams();
  const repository = useMemo(() => createRecordingStore(), []);
  const runtime = useMemo(() => createIframeRuntime(), []);
  const scheduler = useMemo(() => {
    return createReplayScheduler({
      clock: createTimelineClock(),
      tickStrategy: defaultTickStrategy(),
      onTick: (state) => {
        setStableState(state);
      },
    });
  }, []);

  const [schedulerState, setSchedulerState] =
    useState<ReplaySchedulerState>(INITIAL_SCHEDULER_STATE);
  const [stableState, setStableState] = useState<ReplayStableState>(INITIAL_STABLE_STATE);
  const [pkg, setPkg] = useState<RecordingPackageV1 | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);

  useEffect(() => scheduler.subscribe(setSchedulerState), [scheduler]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      const result = await repository.load(id);
      if (cancelled) return;
      if (!result.ok) {
        setLoadError(
          `${result.error.code}: ${"message" in result.error ? result.error.message : ""}`,
        );
        return;
      }
      setPkg(result.package);
      await scheduler.load(result.package);
    })();
    return () => {
      cancelled = true;
      scheduler.destroy();
    };
  }, [id, repository, scheduler]);

  if (loadError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-danger">加载失败：{loadError}</p>
        <Link to="/" className="text-xs text-muted underline underline-offset-2">
          返回库
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="grid flex-1 grid-cols-1 md:grid-cols-[1fr_minmax(320px,420px)]">
        <div className="relative border-r border-border">
          <CodeEditor
            language={stableState.editor.language}
            initialValue={stableState.editor.code}
            fontSize={stableState.editor.fontSize}
            theme={stableState.editor.theme}
          />
        </div>
        <PreviewPane runtime={runtime} previewHtml={stableState.runtime.previewHtml} />
      </div>
      <ReplayControls
        state={schedulerState}
        durationMs={pkg?.meta.durationMs ?? 0}
        onPlayPause={() =>
          schedulerState.status === "playing" ? scheduler.pause() : scheduler.play()
        }
        onSeek={(target) => void scheduler.seek(target)}
        onRate={(rate) => scheduler.setRate(rate)}
        volume={volume}
        muted={muted}
        onVolume={(v) => {
          setVolume(v);
          scheduler.setVolume(v);
        }}
        onMuted={(m) => {
          setMuted(m);
          scheduler.setMuted(m);
        }}
      />
    </div>
  );
}
