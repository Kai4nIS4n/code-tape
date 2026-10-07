export type SubtitleSegment = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
};

export type SubtitleTrack = {
  recordingId: string;
  generatedAt: string;
  model: string;
  source: "huggingface-local" | "external-asr" | "backend-job";
  language?: string;
  segments: SubtitleSegment[];
  revision?: number;
};

export type SubtitleCodeAnchor = {
  segmentId: string;
  targetMs: number;
  eventSeq: number;
  documentId: string;
  contentHash: string;
  range?: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  source: "recorded-selection" | "recorded-cursor" | "manual";
};

export type SubtitleAsset = {
  recordingId: string;
  sourceEventsChecksum: string;
  subtitleTrackRevision: number;
  track: SubtitleTrack;
  chapters: SubtitleChapter[];
  anchors: SubtitleCodeAnchor[];
};

export type SubtitleChapter = {
  id: string;
  title: string;
  startMs: number;
  endMs?: number;
};

export type SubtitleCorrectionResult = {
  segments: Array<{
    id: string;
    text: string;
  }>;
  chapters?: Array<{
    title: string;
    startMs: number;
    endMs?: number;
  }>;
};

export type SubtitlePostProcessorContext = {
  language?: string;
  fileName?: string;
  code?: string;
  runtimeOutput?: string;
  glossary?: string[];
};

export type SubtitlePostProcessorInput = {
  track: SubtitleTrack;
  context?: SubtitlePostProcessorContext;
  signal?: AbortSignal;
  strictValidation?: boolean;
};

export type SubtitlePostProcessorMetric = {
  phase: "warmUp" | "process";
  status: "success" | "error" | "aborted";
  model: string;
  workerLoadDurationMs: number;
  workerRequestDurationMs: number;
  totalDurationMs: number;
};

export type SubtitlePostProcessor = {
  warmUp?(): Promise<void>;
  process(input: SubtitlePostProcessorInput): Promise<SubtitleCorrectionResult>;
  dispose?(): void;
};

export type SubtitleCorrectionWarning = {
  code: "invalid-correction" | "invalid-chapter" | "invalid-anchor";
  message: string;
};

export type SubtitleTrackDraft = Omit<SubtitleTrack, "recordingId" | "generatedAt">;

export type SubtitleTranscriberInput = {
  mediaBlob: Blob;
  durationMs: number;
  signal?: AbortSignal;
  onStatus?: (status: SubtitleTranscriptionStatus) => void;
};

export type SubtitleTranscriber = {
  warmUp?(): Promise<void>;
  transcribe(input: SubtitleTranscriberInput): Promise<SubtitleTrackDraft>;
  dispose?(): void;
};

export type SubtitleTranscriptionStatus =
  | "loading-local-model"
  | "requesting-external-asr"
  | "transcribing";

export type SubtitleStore = {
  load(recordingId: string): Promise<SubtitleTrack | null>;
  save(track: SubtitleTrack): Promise<void>;
  loadChapters(recordingId: string): Promise<SubtitleChapter[]>;
  saveChapters(recordingId: string, chapters: SubtitleChapter[]): Promise<void>;
  saveWithChapters(track: SubtitleTrack, chapters: SubtitleChapter[]): Promise<void>;
  remove(recordingId: string): Promise<void>;
  loadAsset?(recordingId: string): Promise<SubtitleAsset | null>;
  /** Compare-and-swap prevents delayed model results overwriting a newer edit. */
  saveAsset?(asset: SubtitleAsset, expectedRevision: number, signal?: AbortSignal): Promise<boolean>;
};
