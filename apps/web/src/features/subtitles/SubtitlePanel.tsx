import { Captions, Loader2, WandSparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { SubtitleAsrConfigButton } from "./SubtitleAsrConfigButton";
import { SubtitleChapterList } from "./SubtitleChapterList";
import { SubtitleLlmConfigButton } from "./SubtitleLlmConfigButton";
import { processSubtitleBatches } from "./processSubtitleBatches";
import { buildSubtitleCodeAnchors } from "./subtitleCodeAnchors";
import { buildSubtitleTimeIndex, findActiveSubtitleIndex } from "./subtitleTimeIndex";
import { useFixedVirtualList } from "@/shared/virtualization/useFixedVirtualList";
import type { RecordingPackageV1 } from "@/shared/recording-schema";
import { createExternalAsrSubtitleTranscriber } from "./externalAsrSubtitleTranscriber";
import { createExternalLlmSubtitlePostProcessor } from "./externalLlmSubtitlePostProcessor";
import { createFallbackSubtitlePostProcessor } from "./fallbackSubtitlePostProcessor";
import { createFallbackSubtitleTranscriber } from "./fallbackSubtitleTranscriber";
import { resolveEffectivePostProcessTimeoutMs } from "./subtitlePostProcessTimeout";
import { isExternalLlmConfigured, loadExternalLlmConfig } from "./subtitleLlmConfig";
import { isExternalAsrConfigured, loadExternalAsrConfig } from "./subtitleAsrConfig";
import { resolveSubtitlePostProcessorModel } from "./subtitlePostProcessorConfig";
import { createWorkerBackedHuggingFaceSubtitlePostProcessor } from "./subtitlePostProcessorWorkerClient";
import { createSubtitleStore } from "./subtitleStore";
import { createHuggingFaceSubtitleTranscriber } from "./subtitleTranscriber";
import { requestStaleTransformersImportRecovery } from "./transformersLoader";
import type {
  SubtitleChapter,
  SubtitleCodeAnchor,
  SubtitleCorrectionWarning,
  SubtitlePostProcessor,
  SubtitlePostProcessorContext,
  SubtitlePostProcessorMetric,
  SubtitleSegment,
  SubtitleStore,
  SubtitleTrack,
  SubtitleTranscriber,
  SubtitleTranscriptionStatus,
} from "./types";
import { cn } from "@/shared/ui/utils/cn";

export const DEFAULT_SUBTITLE_POSTPROCESS_TIMEOUT_MS = 60_000;

export type SubtitlePanelProps = {
  recordingId: string | null;
  mediaBlob: Blob | null;
  hasAudio: boolean;
  durationMs: number;
  currentTimeMs: number;
  onSeek(timeMs: number): void;
  store?: SubtitleStore;
  transcriber?: SubtitleTranscriber;
  postProcessor?: SubtitlePostProcessor | null;
  postProcessorContext?: SubtitlePostProcessorContext;
  postProcessTimeoutMs?: number;
  recordingPackage?: RecordingPackageV1;
  contextResolver?: (startMs: number, endMs: number) => SubtitlePostProcessorContext;
  onAnchorSeek?: (anchor: SubtitleCodeAnchor) => Promise<void>;
  onCreateManualAnchor?: (segmentId: string) => Promise<SubtitleCodeAnchor | null>;
  onResolveAnchor?: (segment: SubtitleSegment) => Promise<SubtitleCodeAnchor | null | undefined>;
};

type GenerationStatus = "idle" | "loading" | "generating" | "post-processing" | "ready" | "error";

type AsrRuntimeStatus = "idle" | "warming" | "warm" | "warm-error" | SubtitleTranscriptionStatus;

type PostProcessorWarmUpState = {
  recordingId: string;
  postProcessor: SubtitlePostProcessor;
  status: "pending" | "running" | "completed";
  cancel(): void;
};

export function SubtitlePanel({
  recordingId,
  mediaBlob,
  hasAudio,
  durationMs,
  currentTimeMs,
  onSeek,
  store: injectedStore,
  transcriber: injectedTranscriber,
  postProcessor: injectedPostProcessor,
  postProcessorContext,
  postProcessTimeoutMs = DEFAULT_SUBTITLE_POSTPROCESS_TIMEOUT_MS,
  recordingPackage,
  contextResolver,
  onAnchorSeek,
  onCreateManualAnchor,
  onResolveAnchor,
}: SubtitlePanelProps) {
  const store = useMemo(() => injectedStore ?? createSubtitleStore(), [injectedStore]);
  const [asrConfigVersion, setAsrConfigVersion] = useState(0);
  const transcriber = useMemo(() => {
    if (injectedTranscriber) return injectedTranscriber;
    const localTranscriber = createHuggingFaceSubtitleTranscriber();
    const externalConfig = loadExternalAsrConfig();
    if (!isExternalAsrConfigured(externalConfig)) return localTranscriber;
    const externalTranscriber = createExternalAsrSubtitleTranscriber({ config: externalConfig });
    return createFallbackSubtitleTranscriber(externalTranscriber, localTranscriber, {
      onFallback: () =>
        console.warn("[code-tape] external subtitle ASR failed; falling back to local model"),
    });
    // asrConfigVersion bumps when the user saves/clears the external ASR config.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injectedTranscriber, asrConfigVersion]);
  const externalAsrConfigured = useMemo(
    () => isExternalAsrConfigured(loadExternalAsrConfig()),
    // Recompute when the user saves/clears the config (version bump).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [asrConfigVersion],
  );
  const [llmConfigVersion, setLlmConfigVersion] = useState(0);
  const postProcessor = useMemo(
    () => {
      if (injectedPostProcessor !== undefined) return injectedPostProcessor;
      const localProcessor = createWorkerBackedHuggingFaceSubtitlePostProcessor({
        model: resolveSubtitlePostProcessorModel(),
        onMetric: logSubtitlePostProcessorMetric,
      });
      const externalConfig = loadExternalLlmConfig();
      if (!isExternalLlmConfigured(externalConfig)) return localProcessor;
      const externalProcessor = createExternalLlmSubtitlePostProcessor({ config: externalConfig });
      return createFallbackSubtitlePostProcessor(externalProcessor, localProcessor, {
        // Log only a sanitized category — never the raw error/response, which
        // could echo the API key or subtitle/code context from a misconfigured endpoint.
        onFallback: () =>
          console.warn("[code-tape] external subtitle LLM failed; falling back to local model"),
      });
    },
    // llmConfigVersion bumps when the user saves/clears the external LLM config,
    // forcing the post-processor to rebuild against the new config.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [injectedPostProcessor, llmConfigVersion],
  );
  const externalLlmConfigured = useMemo(
    () => isExternalLlmConfigured(loadExternalLlmConfig()),
    // Recompute when the user saves/clears the config (version bump).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [llmConfigVersion],
  );
  const [track, setTrack] = useState<SubtitleTrack | null>(null);
  const [chapters, setChapters] = useState<SubtitleChapter[]>([]);
  const [warnings, setWarnings] = useState<SubtitleCorrectionWarning[]>([]);
  const [status, setStatus] = useState<GenerationStatus>("idle");
  const [asrStatus, setAsrStatus] = useState<AsrRuntimeStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [anchors, setAnchors] = useState<SubtitleCodeAnchor[]>([]);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState("");
  const [draftStartMs, setDraftStartMs] = useState(0);
  const [warmUpIntent, setWarmUpIntent] = useState(false);
  const timeIndex = useMemo(() => buildSubtitleTimeIndex(track?.segments ?? []), [track]);
  const activeIndex = findActiveSubtitleIndex(timeIndex, currentTimeMs);
  const virtual = useFixedVirtualList(track?.segments.length ?? 0, 72);
  const { scrollToIndex } = virtual;
  const requestVersionRef = useRef(0);
  const anchorRequestVersionRef = useRef(0);
  const trackRef = useRef<SubtitleTrack | null>(null);
  trackRef.current = track;
  const generationAbortRef = useRef<AbortController | null>(null);
  const warmUpTranscriberRef = useRef<SubtitleTranscriber | null>(null);
  const asrWarmPromiseRef = useRef<Promise<void> | null>(null);
  const postProcessorWarmUpRef = useRef<PostProcessorWarmUpState | null>(null);

  useEffect(() => {
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    anchorRequestVersionRef.current += 1;
    generationAbortRef.current?.abort();
    generationAbortRef.current = null;
    if (!recordingId) {
      setTrack(null);
      setChapters([]);
      setWarnings([]);
      setStatus("idle");
      setError(null);
      setAnchors([]);
      return;
    }
    let cancelled = false;
    setTrack(null);
    setChapters([]);
    setWarnings([]);
    setAnchors([]);
    setSelectedSegmentId(null);
    setStatus("loading");
    setError(null);
    (async () => {
      if (store.loadAsset) {
        const asset = await store.loadAsset(recordingId);
        if (cancelled || requestVersionRef.current !== requestVersion) return;
        setTrack(asset?.track ?? null);
        setChapters(asset?.chapters ?? []);
        setStatus(asset ? "ready" : "idle");
        if (asset) {
          const matches =
            asset.sourceEventsChecksum === recordingPackage?.manifest.checksums.eventsSha256 &&
            asset.subtitleTrackRevision === (asset.track.revision ?? 0);
          setAnchors(matches ? asset.anchors : []);
          if (!matches && asset.anchors.some((anchor) => anchor.source === "manual"))
            setWarnings([
              {
                code: "invalid-anchor",
                message: "录制来源或字幕版本已变化，手动代码关联需要重新设置。",
              },
            ]);
        }
      } else {
        const savedTrack = await store.load(recordingId);
        if (cancelled || requestVersionRef.current !== requestVersion) return;
        const savedChapters = savedTrack
          ? await store.loadChapters(recordingId).catch(() => [])
          : [];
        if (cancelled || requestVersionRef.current !== requestVersion) return;
        setTrack(savedTrack);
        setChapters(savedChapters);
        setStatus(savedTrack ? "ready" : "idle");
      }
    })().catch((err) => {
      if (cancelled || requestVersionRef.current !== requestVersion) return;
      setError(formatSubtitleError(err));
      setStatus("error");
    });
    return () => {
      cancelled = true;
      anchorRequestVersionRef.current += 1;
      requestVersionRef.current += 1;
      generationAbortRef.current?.abort();
      generationAbortRef.current = null;
      postProcessorWarmUpRef.current = null;
      postProcessor?.dispose?.();
    };
  }, [postProcessor, recordingId, recordingPackage, store]);

  useEffect(() => {
    scrollToIndex(activeIndex);
  }, [activeIndex, scrollToIndex]);

  const ensureAsrWarm = useCallback(() => {
    if (!transcriber.warmUp) return Promise.resolve();
    if (warmUpTranscriberRef.current !== transcriber) {
      warmUpTranscriberRef.current = transcriber;
      asrWarmPromiseRef.current = null;
    }
    if (!asrWarmPromiseRef.current)
      asrWarmPromiseRef.current = transcriber.warmUp().catch((error: unknown) => {
        if (warmUpTranscriberRef.current === transcriber) asrWarmPromiseRef.current = null;
        throw error;
      });
    return asrWarmPromiseRef.current;
  }, [transcriber]);

  useEffect(() => {
    if (!recordingId || !hasAudio || !warmUpIntent) return;
    let cancelled = false;
    const cancelIdle = scheduleIdleWarmUp(() => {
      if (cancelled) return;
      setAsrStatus("warming");
      void ensureAsrWarm()
        .then(() => {
          if (!cancelled) setAsrStatus("warm");
        })
        .catch(() => {
          if (!cancelled) setAsrStatus("warm-error");
        });
    });
    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [ensureAsrWarm, hasAudio, mediaBlob, recordingId, transcriber, warmUpIntent]);

  useEffect(() => {
    if (
      !recordingId ||
      !hasAudio ||
      !warmUpIntent ||
      asrStatus !== "warm" ||
      !track ||
      track.recordingId !== recordingId ||
      track.segments.length === 0 ||
      status === "loading" ||
      status === "generating" ||
      status === "post-processing" ||
      !postProcessor?.warmUp
    ) {
      return;
    }
    const existingWarmUp = postProcessorWarmUpRef.current;
    if (
      existingWarmUp?.recordingId === recordingId &&
      existingWarmUp.postProcessor === postProcessor
    ) {
      return;
    }
    let cancelled = false;
    const warmUpState: PostProcessorWarmUpState = {
      recordingId,
      postProcessor,
      status: "pending",
      cancel: () => undefined,
    };
    postProcessorWarmUpRef.current = warmUpState;
    warmUpState.cancel = scheduleIdleWarmUp(() => {
      if (cancelled) return;
      warmUpState.status = "running";
      void postProcessor
        .warmUp?.()
        .catch(() => undefined)
        .finally(() => {
          if (postProcessorWarmUpRef.current === warmUpState) {
            warmUpState.status = "completed";
          }
        });
    });
    return () => {
      cancelled = true;
      cancelPendingPostProcessorWarmUpState(postProcessorWarmUpRef, warmUpState);
    };
  }, [asrStatus, hasAudio, postProcessor, recordingId, status, track, warmUpIntent]);

  const canGenerate = Boolean(
    recordingId &&
    mediaBlob &&
    hasAudio &&
    status !== "loading" &&
    status !== "generating" &&
    status !== "post-processing",
  );
  const canPostProcess = Boolean(
    recordingId &&
    track &&
    track.segments.length > 0 &&
    postProcessor &&
    status !== "loading" &&
    status !== "generating" &&
    status !== "post-processing",
  );
  const shouldGenerateBeforePostProcess = Boolean(postProcessor && canGenerate);
  const primaryActionLabel = shouldGenerateBeforePostProcess
    ? "生成字幕并优化"
    : track && postProcessor
      ? "优化字幕和章节"
      : "生成字幕";
  const canRunPrimaryAction = shouldGenerateBeforePostProcess
    ? canGenerate
    : track && postProcessor
      ? canPostProcess
      : canGenerate;

  const persistTrack = async (
    nextTrack: SubtitleTrack,
    nextChapters: SubtitleChapter[],
    nextAnchors: SubtitleCodeAnchor[],
    expectedRevision: number,
    signal?: AbortSignal,
  ) => {
    const savedTrack = { ...nextTrack, revision: expectedRevision + 1 };
    if (store.saveAsset) {
      const saved = await store.saveAsset(
        {
          recordingId: savedTrack.recordingId,
          sourceEventsChecksum: recordingPackage?.manifest.checksums.eventsSha256 ?? "",
          subtitleTrackRevision: savedTrack.revision,
          track: savedTrack,
          chapters: nextChapters,
          anchors: nextAnchors,
        },
        expectedRevision,
        signal,
      );
      if (!saved) throw new Error("字幕已有较新的修改，已保留新版本。请重新加载后再优化。");
    } else await store.saveWithChapters(savedTrack, nextChapters);
    return savedTrack;
  };

  const postProcessTrack = async (
    baseTrack: SubtitleTrack,
    requestVersion: number,
    abortController: AbortController,
    baseAnchors = anchors,
    previousChapters = chapters,
  ) => {
    if (!postProcessor) return;
    setStatus("post-processing");
    try {
      const result = await runWithPostProcessTimeout(
        processSubtitleBatches({
          track: baseTrack,
          processor: postProcessor,
          context: postProcessorContext,
          contextResolver,
          signal: abortController.signal,
          durationMs,
        }),
        {
          abortController,
          timeoutMs: resolveEffectivePostProcessTimeoutMs(
            postProcessTimeoutMs,
            externalLlmConfigured,
          ),
        },
      );
      if (!isCurrentGeneration(requestVersionRef, requestVersion, abortController)) return;
      const textChanged = result.track.segments.some(
        (segment, index) => segment.text !== baseTrack.segments[index]?.text,
      );
      if (!textChanged && result.chapters.length === 0) {
        setWarnings(result.warnings);
        setStatus("ready");
        return;
      }
      const nextChapters =
        result.warnings.some((warning) => warning.code === "invalid-chapter") ||
        !result.chapters.length
          ? previousChapters
          : result.chapters;
      const savedTrack = await persistTrack(
        result.track,
        nextChapters,
        baseAnchors,
        baseTrack.revision ?? 0,
        abortController.signal,
      );
      if (!isCurrentGeneration(requestVersionRef, requestVersion, abortController)) return;
      trackRef.current = savedTrack;
      setTrack(savedTrack);
      setChapters(nextChapters);
      setWarnings(result.warnings);
      setStatus("ready");
    } catch (err) {
      if (isPostProcessTimeoutError(err)) {
        if (
          requestVersionRef.current !== requestVersion ||
          generationAbortRef.current !== abortController
        )
          return;
        setError(formatSubtitleError(err));
        setStatus("error");
        return;
      }
      if (abortController.signal.aborted || requestVersionRef.current !== requestVersion) return;
      if (requestStaleTransformersImportRecovery(err)) return;
      setError(formatSubtitleError(err));
      setStatus("error");
    }
  };

  const generateSubtitles = async () => {
    if (!recordingId || !mediaBlob || !hasAudio) return;
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    generationAbortRef.current?.abort();
    cancelPendingPostProcessorWarmUp(postProcessorWarmUpRef, postProcessor);
    const abortController = new AbortController();
    generationAbortRef.current = abortController;
    setStatus("generating");
    setError(null);
    setWarnings([]);
    try {
      setAsrStatus("transcribing");
      const draft = await transcriber.transcribe({
        mediaBlob,
        durationMs,
        signal: abortController.signal,
        onStatus: setAsrStatus,
      });
      if (!isCurrentGeneration(requestVersionRef, requestVersion, abortController)) return;
      const nextTrack: SubtitleTrack = {
        recordingId,
        generatedAt: new Date().toISOString(),
        ...draft,
      };
      const nextAnchors = recordingPackage
        ? await buildSubtitleCodeAnchors(recordingPackage, nextTrack)
        : [];
      if (!isCurrentGeneration(requestVersionRef, requestVersion, abortController)) return;
      const savedTrack = await persistTrack(
        nextTrack,
        [],
        nextAnchors,
        trackRef.current?.revision ?? 0,
        abortController.signal,
      );
      if (!isCurrentGeneration(requestVersionRef, requestVersion, abortController)) return;
      trackRef.current = savedTrack;
      setTrack(savedTrack);
      setAnchors(nextAnchors);
      setChapters([]);
      setAsrStatus("warm");
      if (postProcessor) {
        await postProcessTrack(savedTrack, requestVersion, abortController, nextAnchors, []);
        return;
      }
      setStatus("ready");
    } catch (err) {
      if (abortController.signal.aborted || requestVersionRef.current !== requestVersion) return;
      if (requestStaleTransformersImportRecovery(err)) return;
      setAsrStatus("warm-error");
      setError(formatSubtitleError(err));
      setStatus("error");
    } finally {
      if (generationAbortRef.current === abortController) {
        generationAbortRef.current = null;
      }
    }
  };

  const postProcessSubtitles = async () => {
    if (!recordingId || !track || !postProcessor) return;
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    generationAbortRef.current?.abort();
    cancelPendingPostProcessorWarmUp(postProcessorWarmUpRef, postProcessor);
    const abortController = new AbortController();
    generationAbortRef.current = abortController;
    setError(null);
    setWarnings([]);
    try {
      await postProcessTrack(track, requestVersion, abortController);
    } finally {
      if (generationAbortRef.current === abortController) {
        generationAbortRef.current = null;
      }
    }
  };

  const runPrimarySubtitleAction = () => {
    setWarmUpIntent(true);
    if (!shouldGenerateBeforePostProcess && track && postProcessor) {
      void postProcessSubtitles();
      return;
    }
    void generateSubtitles();
  };
  const selectSegment = (segment: SubtitleSegment) => {
    const anchorRequest = ++anchorRequestVersionRef.current;
    setSelectedSegmentId(segment.id);
    setDraftText(segment.text);
    setDraftStartMs(segment.startMs);
    const anchor = anchors.find((candidate) => candidate.segmentId === segment.id);
    if (anchor && onAnchorSeek) void onAnchorSeek(anchor);
    else if (onResolveAnchor && onAnchorSeek)
      void onResolveAnchor(segment)
        .then((resolved) => {
          if (anchorRequest !== anchorRequestVersionRef.current) return;
          if (resolved === undefined) return;
          if (resolved) {
            setAnchors((current) => [
              ...current.filter((item) => item.segmentId !== segment.id),
              resolved,
            ]);
            void onAnchorSeek(resolved);
          } else onSeek(segment.startMs);
        })
        .catch(() => {
          if (anchorRequest === anchorRequestVersionRef.current) onSeek(segment.startMs);
        });
    else onSeek(segment.startMs);
  };
  const saveManualEdit = async () => {
    const baseTrack = trackRef.current;
    if (
      !baseTrack ||
      !selectedSegmentId ||
      !draftText.trim() ||
      draftText.length > 4_000 ||
      !Number.isFinite(draftStartMs)
    )
      return;
    const original = baseTrack.segments.find((segment) => segment.id === selectedSegmentId);
    if (!original || draftStartMs < 0 || draftStartMs >= original.endMs) {
      setError("字幕开始时间必须在该段结束之前。");
      return;
    }
    generationAbortRef.current?.abort();
    requestVersionRef.current += 1;
    anchorRequestVersionRef.current += 1;
    setStatus("ready");
    const version = requestVersionRef.current;
    const controller = new AbortController();
    generationAbortRef.current = controller;
    try {
      const next = {
        ...baseTrack,
        segments: baseTrack.segments.map((segment) =>
          segment.id === selectedSegmentId
            ? { ...segment, text: draftText.trim(), startMs: draftStartMs }
            : segment,
        ),
      };
      const automaticAnchors =
        original.startMs !== draftStartMs && recordingPackage
          ? await buildSubtitleCodeAnchors(recordingPackage, next)
          : anchors;
      const preservedManual = anchors.filter(
        (anchor) => anchor.source === "manual" && anchor.segmentId !== selectedSegmentId,
      );
      const manualIds = new Set(preservedManual.map((anchor) => anchor.segmentId));
      const nextAnchors = [
        ...automaticAnchors.filter((anchor) => !manualIds.has(anchor.segmentId)),
        ...preservedManual,
      ];
      if (requestVersionRef.current !== version) return;
      const saved = await persistTrack(
        next,
        chapters,
        nextAnchors,
        baseTrack.revision ?? 0,
        controller.signal,
      );
      if (requestVersionRef.current !== version) return;
      trackRef.current = saved;
      setTrack(saved);
      setAnchors(nextAnchors);
      setStatus("ready");
      setError(null);
    } catch (error) {
      if (requestVersionRef.current === version) setError(formatSubtitleError(error));
    } finally {
      if (generationAbortRef.current === controller) generationAbortRef.current = null;
    }
  };
  const saveManualAnchor = async () => {
    if (!track || !selectedSegmentId || !onCreateManualAnchor) return;
    const version = ++requestVersionRef.current;
    generationAbortRef.current?.abort();
    anchorRequestVersionRef.current += 1;
    setStatus("ready");
    const controller = new AbortController();
    generationAbortRef.current = controller;
    const anchor = await onCreateManualAnchor(selectedSegmentId);
    if (requestVersionRef.current !== version) return;
    if (!anchor) {
      setError("当前历史状态没有有效光标或选区，无法关联。");
      return;
    }
    const nextAnchors = [...anchors.filter((item) => item.segmentId !== selectedSegmentId), anchor];
    try {
      const saved = await persistTrack(
        track,
        chapters,
        nextAnchors,
        track.revision ?? 0,
        controller.signal,
      );
      if (requestVersionRef.current !== version) return;
      trackRef.current = saved;
      setTrack(saved);
      setAnchors(nextAnchors);
      setStatus("ready");
      setError(null);
    } catch (error) {
      if (requestVersionRef.current === version) setError(formatSubtitleError(error));
    } finally {
      if (generationAbortRef.current === controller) generationAbortRef.current = null;
    }
  };
  const statusMessage = formatAsrStatusMessage(status, asrStatus);

  return (
    <section
      aria-label="字幕"
      onPointerEnter={() => setWarmUpIntent(true)}
      onFocus={() => setWarmUpIntent(true)}
      className="shrink-0 border-t border-border bg-background px-3 py-2"
    >
      <div className="mb-2 flex min-h-9 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
          <Captions aria-hidden size={17} className="shrink-0 text-primary" />
          <span>字幕</span>
          {track ? (
            <span className="truncate text-xs font-normal text-muted">{track.model}</span>
          ) : null}
        </div>
        <div className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
          <SubtitleLlmConfigButton
            configured={externalLlmConfigured}
            onConfigChange={() => setLlmConfigVersion((version) => version + 1)}
          />
          <SubtitleAsrConfigButton
            configured={externalAsrConfigured}
            onConfigChange={() => setAsrConfigVersion((version) => version + 1)}
          />
          <button
            type="button"
            aria-label={primaryActionLabel}
            disabled={!canRunPrimaryAction}
            onClick={runPrimarySubtitleAction}
            className={buttonClassName}
          >
            {status === "generating" || status === "post-processing" ? (
              <Loader2 aria-hidden size={14} className="animate-spin" />
            ) : (
              <WandSparkles aria-hidden size={14} />
            )}
            <span>{primaryActionLabel}</span>
          </button>
          {status === "generating" || status === "post-processing" ? (
            <button
              type="button"
              className={buttonClassName}
              onClick={() => {
                generationAbortRef.current?.abort();
                requestVersionRef.current += 1;
                setStatus(track ? "ready" : "idle");
              }}
            >
              取消
            </button>
          ) : null}
        </div>
      </div>
      {error ? (
        <p role="alert" className="mb-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
      {warnings.length > 0 ? (
        <p role="alert" className="mb-2 text-xs text-warning">
          {warnings[0]?.message}
        </p>
      ) : null}
      {statusMessage ? <p className="mb-2 text-xs text-muted">{statusMessage}</p> : null}
      {!hasAudio ? (
        <p className="text-xs text-muted">无音频轨道</p>
      ) : track && track.segments.length > 0 ? (
        <>
          <SubtitleChapterList chapters={chapters} currentTimeMs={currentTimeMs} onSeek={onSeek} />
          <div
            ref={virtual.containerRef}
            data-testid="subtitle-viewport"
            onScroll={virtual.onScroll}
            className="relative h-36 min-h-0 overflow-y-auto overscroll-contain pr-1"
          >
            <div style={{ height: virtual.totalHeight, position: "relative" }}>
              {track.segments.slice(virtual.start, virtual.end).map((segment, offset) => {
                const index = virtual.start + offset;
                const isActive = activeIndex === index;
                return (
                  <button
                    key={segment.id}
                    data-testid="subtitle-row"
                    style={{ position: "absolute", top: index * 72, height: 72, left: 0, right: 0 }}
                    type="button"
                    aria-current={isActive ? "true" : undefined}
                    aria-label={segment.text}
                    onClick={() => selectSegment(segment)}
                    className={cn(
                      "grid grid-cols-[4.5rem_1fr] gap-2 rounded-md px-2 py-1.5 text-left text-xs leading-5",
                      "transition-[background-color,color] duration-150 ease-out-soft",
                      "hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                      isActive ? "bg-surface-raised text-foreground" : "text-muted",
                    )}
                  >
                    <span className="font-mono tabular-nums">
                      {formatSubtitleTime(segment.startMs)}
                    </span>
                    <span className="line-clamp-2 text-foreground">{segment.text}</span>
                  </button>
                );
              })}
            </div>
          </div>
          {selectedSegmentId ? (
            <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-border pt-2">
              <label className="min-w-48 flex-1 text-xs">
                完整字幕
                <textarea
                  aria-label="编辑完整字幕"
                  value={draftText}
                  onChange={(event) => setDraftText(event.target.value)}
                  maxLength={4_000}
                  className="mt-1 block w-full rounded border border-border bg-surface p-2"
                />
              </label>
              <label className="text-xs">
                开始时间（毫秒）
                <input
                  aria-label="字幕开始时间"
                  type="number"
                  min={0}
                  value={draftStartMs}
                  onChange={(event) => setDraftStartMs(Number(event.target.value))}
                  className="mt-1 block w-28 rounded border border-border bg-surface p-1"
                />
              </label>
              <button
                type="button"
                className={buttonClassName}
                onClick={() => void saveManualEdit()}
              >
                保存字幕
              </button>
              {onCreateManualAnchor ? (
                <button
                  type="button"
                  className={buttonClassName}
                  onClick={() => void saveManualAnchor()}
                >
                  关联当前代码选区
                </button>
              ) : null}
            </div>
          ) : null}
          {onCreateManualAnchor ? (
            <span className="text-xs text-muted">
              关联 {formatSubtitleTime(currentTimeMs)} 的当前代码选区，保存时暂停回放。
            </span>
          ) : null}
        </>
      ) : status === "generating" || status === "post-processing" ? null : (
        <p className="text-xs text-muted">暂无字幕</p>
      )}
    </section>
  );
}

const buttonClassName = cn(
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium",
  "text-foreground transition-[background-color,color] duration-150 ease-out-soft",
  "hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background",
);

function isCurrentGeneration(
  requestVersionRef: MutableRefObject<number>,
  requestVersion: number,
  abortController: AbortController,
): boolean {
  return !abortController.signal.aborted && requestVersionRef.current === requestVersion;
}

function formatSubtitleTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatSubtitleError(error: unknown): string {
  return error instanceof Error ? error.message : "字幕生成失败";
}

function formatAsrStatusMessage(
  generationStatus: GenerationStatus,
  asrStatus: AsrRuntimeStatus,
): string | null {
  if (generationStatus === "post-processing") return "ASR 完成，正在纠错并生成章节...";
  if (generationStatus === "generating") {
    if (asrStatus === "loading-local-model") return "正在加载本地 ASR 模型...";
    if (asrStatus === "requesting-external-asr") return "正在请求外部 ASR...";
    if (asrStatus === "transcribing") return "正在识别音频...";
    return "正在生成字幕...";
  }
  if (asrStatus === "warming") return "正在加载本地 ASR 模型...";
  if (asrStatus === "warm-error") return "本地 ASR 模型预热失败，点击生成时会重试。";
  return null;
}

class PostProcessTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`字幕纠错超时（${formatTimeoutBudget(timeoutMs)}），已保留当前字幕和章节。`);
    this.name = "PostProcessTimeoutError";
  }
}

function runWithPostProcessTimeout<T>(
  operation: Promise<T>,
  {
    abortController,
    timeoutMs,
  }: {
    abortController: AbortController;
    timeoutMs: number;
  },
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return operation;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let didTimeout = false;
  const guardedOperation = operation.catch((error) => {
    if (didTimeout) throw new PostProcessTimeoutError(timeoutMs);
    throw error;
  });
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      didTimeout = true;
      abortController.abort();
      reject(new PostProcessTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  return Promise.race([guardedOperation, timeout]).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId);
  });
}

function isPostProcessTimeoutError(error: unknown): error is PostProcessTimeoutError {
  return error instanceof Error && error.name === "PostProcessTimeoutError";
}

function cancelPendingPostProcessorWarmUp(
  warmUpRef: MutableRefObject<PostProcessorWarmUpState | null>,
  postProcessor: SubtitlePostProcessor | null,
): void {
  const warmUpState = warmUpRef.current;
  if (!warmUpState || warmUpState.postProcessor !== postProcessor) return;
  cancelPendingPostProcessorWarmUpState(warmUpRef, warmUpState);
}

function cancelPendingPostProcessorWarmUpState(
  warmUpRef: MutableRefObject<PostProcessorWarmUpState | null>,
  warmUpState: PostProcessorWarmUpState,
): void {
  warmUpState.cancel();
  if (warmUpRef.current === warmUpState && warmUpState.status === "pending") {
    warmUpRef.current = null;
  }
}

function scheduleIdleWarmUp(callback: () => void): () => void {
  const requestIdle = globalThis.requestIdleCallback;
  if (typeof requestIdle === "function") {
    const handle = requestIdle(callback, { timeout: 2_000 });
    return () => {
      globalThis.cancelIdleCallback?.(handle);
    };
  }
  const handle = setTimeout(callback, 250);
  return () => clearTimeout(handle);
}

function formatTimeoutBudget(timeoutMs: number): string {
  if (timeoutMs < 1_000) return `${Math.round(timeoutMs)}ms`;
  return `${Math.round(timeoutMs / 1_000)} 秒`;
}

function logSubtitlePostProcessorMetric(metric: SubtitlePostProcessorMetric): void {
  console.debug("[code-tape] subtitle postprocessor metric", {
    phase: metric.phase,
    status: metric.status,
    model: metric.model,
    workerLoadDurationMs: roundMetricDuration(metric.workerLoadDurationMs),
    workerRequestDurationMs: roundMetricDuration(metric.workerRequestDurationMs),
    totalDurationMs: roundMetricDuration(metric.totalDurationMs),
  });
}

function roundMetricDuration(durationMs: number): number {
  return Math.round(Math.max(0, durationMs) * 1_000) / 1_000;
}
