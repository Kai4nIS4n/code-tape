import type { RecordingPackageV1, ReplayStableState } from "@/shared/recording-schema";
import { sha256Hex } from "@/shared/util/hash";
import { buildInitialState } from "@/features/player/initialState";
import { replayReducer } from "@/features/player/replayReducer";
import type { SubtitleCodeAnchor, SubtitleTrack } from "./types";

export function isValidCodeRange(
  code: string,
  range: NonNullable<SubtitleCodeAnchor["range"]>,
): boolean {
  const lines = code.split("\n");
  const values = [range.startLineNumber, range.endLineNumber, range.startColumn, range.endColumn];
  return (
    values.every((value) => Number.isSafeInteger(value) && value >= 1) &&
    range.startLineNumber <= range.endLineNumber &&
    range.endLineNumber <= lines.length &&
    range.startColumn <= lines[range.startLineNumber - 1].length + 1 &&
    range.endColumn <= lines[range.endLineNumber - 1].length + 1 &&
    (range.startLineNumber !== range.endLineNumber || range.startColumn <= range.endColumn)
  );
}
export async function anchorFromState(
  segmentId: string,
  targetMs: number,
  eventSeq: number,
  state: ReplayStableState,
  manual = false,
): Promise<SubtitleCodeAnchor | null> {
  const { selection, cursor, code, language } = state.editor;
  const range = selection
    ? {
        startLineNumber: selection.startLineNumber,
        startColumn: selection.startColumn,
        endLineNumber: selection.endLineNumber,
        endColumn: selection.endColumn,
      }
    : cursor
      ? {
          startLineNumber: cursor.lineNumber,
          startColumn: cursor.column,
          endLineNumber: cursor.lineNumber,
          endColumn: cursor.column,
        }
      : undefined;
  if (!range || !isValidCodeRange(code, range)) return null;
  return {
    segmentId,
    targetMs,
    eventSeq,
    documentId: state.editor.activeDocumentId ?? `source:${language}`,
    contentHash: await sha256Hex(code),
    range,
    source: manual ? "manual" : selection ? "recorded-selection" : "recorded-cursor",
  };
}
export async function buildSubtitleCodeAnchors(
  pkg: RecordingPackageV1,
  track: SubtitleTrack,
): Promise<SubtitleCodeAnchor[]> {
  const events = pkg.events.slice().sort((a, b) => a.timestampMs - b.timestampMs || a.seq - b.seq);
  const segments = track.segments.slice().sort((a, b) => a.startMs - b.startMs);
  const anchors: SubtitleCodeAnchor[] = [];
  let state = buildInitialState(pkg);
  let cursor = 0;
  let eventSeq = 0;
  for (const segment of segments) {
    while (cursor < events.length && events[cursor].timestampMs <= segment.startMs) {
      const event = events[cursor++];
      state = replayReducer(state, event);
      eventSeq = event.seq;
    }
    const anchor = await anchorFromState(segment.id, segment.startMs, eventSeq, state);
    if (anchor) anchors.push(anchor);
  }
  return anchors;
}
