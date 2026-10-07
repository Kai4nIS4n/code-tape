import { buildSubtitlePostProcessorMessages } from "./subtitlePostProcessorShared";
import { applySubtitleCorrection } from "./subtitleCorrection";
import { isStaleTransformersChunkImportError } from "./transformersLoader";
import type {
  SubtitleChapter,
  SubtitleCorrectionWarning,
  SubtitlePostProcessor,
  SubtitlePostProcessorContext,
  SubtitleTrack,
} from "./types";

export async function processSubtitleBatches({
  track,
  processor,
  context,
  contextResolver,
  signal,
  durationMs,
}: {
  track: SubtitleTrack;
  processor: SubtitlePostProcessor;
  context?: SubtitlePostProcessorContext;
  contextResolver?: (startMs: number, endMs: number) => SubtitlePostProcessorContext;
  signal: AbortSignal;
  durationMs: number;
}) {
  const segments = track.segments.slice();
  const chapters: SubtitleChapter[] = [];
  const warnings: SubtitleCorrectionWarning[] = [];
  for (let start = 0; start < segments.length; ) {
    if (signal.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
    let count = Math.min(60, segments.length - start);
    let batch = { ...track, segments: track.segments.slice(start, start + count) };
    let batchContext =
      contextResolver?.(batch.segments[0].startMs, batch.segments.at(-1)!.endMs) ?? context;
    while (
      count > 1 &&
      JSON.stringify(buildSubtitlePostProcessorMessages({ track: batch, context: batchContext }))
        .length > 12_000
    ) {
      count = Math.ceil(count / 2);
      batch = { ...track, segments: track.segments.slice(start, start + count) };
      batchContext =
        contextResolver?.(batch.segments[0].startMs, batch.segments.at(-1)!.endMs) ?? context;
    }
    try {
      const correction = await processor.process({
        track: batch,
        context: batchContext,
        signal,
        strictValidation: true,
      });
      if (signal.aborted) throw new DOMException("字幕纠错已取消", "AbortError");
      const textResult = applySubtitleCorrection(
        batch,
        { segments: correction.segments },
        { durationMs },
      );
      warnings.push(...(correction.validationWarnings ?? []));
      warnings.push(...textResult.warnings);
      if (
        !textResult.warnings.length &&
        !correction.validationWarnings?.some((warning) => warning.code === "invalid-correction")
      )
        segments.splice(start, count, ...textResult.track.segments);
      const startMs = batch.segments[0].startMs;
      const endMs = batch.segments.at(-1)!.endMs;
      const outsideBatch = correction.chapters?.some(
        (chapter) =>
          chapter.startMs < startMs ||
          chapter.startMs >= endMs ||
          (chapter.endMs !== undefined && chapter.endMs > endMs),
      );
      if (outsideBatch)
        warnings.push({
          code: "invalid-chapter",
          message: "章节超出本批字幕时间范围，已保留原章节。",
        });
      else {
        const chapterResult = applySubtitleCorrection(
          batch,
          { segments: [], chapters: correction.chapters },
          { durationMs: endMs },
        );
        warnings.push(...chapterResult.warnings);
        chapters.push(...chapterResult.chapters);
      }
    } catch (error) {
      if (signal.aborted || isStaleTransformersChunkImportError(error)) throw error;
      // Failed batches retain original ASR text. A later batch may still succeed.
      warnings.push({
        code: "invalid-correction",
        message: error instanceof Error ? error.message : "本批字幕优化失败，已保留原文。",
      });
    }
    start += count;
  }
  const sortedChapters = chapters
    .sort((a, b) => a.startMs - b.startMs)
    .filter((chapter, index, all) => index === 0 || chapter.startMs !== all[index - 1].startMs);
  const merged = applySubtitleCorrection(
    { ...track, segments },
    { segments: [], chapters: sortedChapters },
    { durationMs },
  );
  return {
    track: merged.track,
    chapters: merged.chapters,
    warnings: [...warnings, ...merged.warnings],
  };
}
