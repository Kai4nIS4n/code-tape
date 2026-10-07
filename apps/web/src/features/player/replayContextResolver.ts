import type { RecordingPackageV1, ReplayStableState } from "@/shared/recording-schema";
import { buildInitialState, cloneState } from "./initialState";
import { buildReplayIndex, findSnapshotAtMost, upperBoundEventSeq } from "./replayIndex";
import { replayReducer } from "./replayReducer";
import type { SubtitlePostProcessorContext } from "@/features/subtitles/types";

/** Reuses one index for all batches; never depends on the viewer's playhead. */
export function createReplayContextResolver(pkg: RecordingPackageV1, glossary: string[] = []) {
  const index = buildReplayIndex(pkg);
  const initial = buildInitialState(pkg);
  const stateAt = (targetMs: number): { state: ReplayStableState; eventSeq: number } => {
    const snapshot = findSnapshotAtMost(index.snapshotsByTime, targetMs);
    let state = cloneState(snapshot?.state ?? initial);
    let eventSeq = snapshot?.eventSeq ?? 0;
    for (let cursor = upperBoundEventSeq(index.stableEventsByTime, eventSeq); cursor < index.stableEventsByTime.length; cursor += 1) {
      const event = index.stableEventsByTime[cursor];
      if (event.timestampMs > targetMs) break;
      state = replayReducer(state, event);
      eventSeq = event.seq;
    }
    return { state, eventSeq };
  };
  return {
    stateAt,
    resolve(startMs: number, endMs: number): SubtitlePostProcessorContext {
      const start = stateAt(startMs).state;
      const end = stateAt(endMs).state;
      const code = start.editor.code === end.editor.code ? start.editor.code : `${start.editor.code}\n/* 窗口结束时的代码 */\n${end.editor.code}`;
      return { language: end.editor.language, fileName: `source:${end.editor.language}`, code: code.slice(0, 6_000), runtimeOutput: [...end.runtime.stdout, ...end.runtime.stderr, end.runtime.errorMessage ?? ""].join("\n").slice(0, 2_000), glossary: glossary.slice(0, 100) };
    },
  };
}
