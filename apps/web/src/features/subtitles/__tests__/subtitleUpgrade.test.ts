import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { buildSubtitleTimeIndex, findActiveSubtitleIndex } from "../subtitleTimeIndex";
import { processSubtitleBatches } from "../processSubtitleBatches";
import { createSubtitleStore } from "../subtitleStore";
import {
  constrainCorrectionToTrack,
  extractSubtitleCorrectionResult,
} from "../subtitlePostProcessorShared";
import { isValidCodeRange } from "../subtitleCodeAnchors";
import {
  clearExternalLlmConfig,
  loadExternalLlmConfig,
  saveExternalLlmConfig,
  SUBTITLE_LLM_CONFIG_STORAGE_KEY,
} from "../subtitleLlmConfig";
import type { SubtitleAsset, SubtitleTrack } from "../types";

function track(count = 2): SubtitleTrack {
  return {
    recordingId: "recording-1",
    generatedAt: "now",
    model: "test",
    source: "huggingface-local",
    segments: Array.from({ length: count }, (_, index) => ({
      id: `s-${index}`,
      startMs: index * 1000,
      endMs: (index + 1) * 1000,
      text: `Source ${index}`,
    })),
  };
}
describe("subtitle upgrade", () => {
  it("indexes overlapping ranges with earliest source-row precedence and exclusive ends", () => {
    const segments = [
      { id: "first", startMs: 1000, endMs: 3000, text: "first" },
      { id: "second", startMs: 0, endMs: 2000, text: "second" },
      { id: "third", startMs: 3000, endMs: 4000, text: "third" },
    ];
    const index = buildSubtitleTimeIndex(segments);
    expect(findActiveSubtitleIndex(index, 500)).toBe(1);
    expect(findActiveSubtitleIndex(index, 1500)).toBe(0);
    expect(findActiveSubtitleIndex(index, 2500)).toBe(0);
    expect(findActiveSubtitleIndex(index, 3000)).toBe(2);
    expect(findActiveSubtitleIndex(index, 4000)).toBe(-1);
  });

  it("uses historical context per <=60 segment batch and preserves source IDs and timing", async () => {
    const source = track(131);
    const resolver = vi.fn((start: number, end: number) => ({
      code: `historical ${start}-${end}`,
    }));
    const process = vi.fn(async (input: { track: SubtitleTrack }) => ({
      segments: input.track.segments.map((segment) => ({
        id: segment.id,
        text: `${segment.text} corrected`,
      })),
      chapters: [],
    }));
    const result = await processSubtitleBatches({
      track: source,
      processor: { process },
      contextResolver: resolver,
      signal: new AbortController().signal,
      durationMs: 131000,
    });
    expect(process).toHaveBeenCalledTimes(3);
    expect(resolver.mock.calls).toEqual([
      [0, 60000],
      [60000, 120000],
      [120000, 131000],
    ]);
    expect(result.track.segments.map(({ id, startMs, endMs }) => ({ id, startMs, endMs }))).toEqual(
      source.segments.map(({ id, startMs, endMs }) => ({ id, startMs, endMs })),
    );
    expect(result.track.segments[130].text).toBe("Source 130 corrected");
  });

  it("rejects an invalid correction batch while independently keeping a valid chapter", async () => {
    const source = track();
    const result = await processSubtitleBatches({
      track: source,
      processor: {
        process: async () => ({
          segments: [
            { id: "s-0", text: "Valid text" },
            { id: "missing", text: "Invented" },
          ],
          chapters: [{ title: "Valid chapter", startMs: 0, endMs: 2000 }],
        }),
      },
      signal: new AbortController().signal,
      durationMs: 2000,
    });
    expect(result.track).toEqual(source);
    expect(result.chapters).toMatchObject([{ title: "Valid chapter" }]);
    expect(result.warnings).toMatchObject([{ code: "invalid-correction" }]);
  });

  it("strict model validation rejects duplicates and retains text when a chapter field is malformed", () => {
    const source = track();
    const duplicate = constrainCorrectionToTrack(
      {
        segments: [
          { id: "s-0", text: "one" },
          { id: "s-0", text: "two" },
        ],
        chapters: [{ title: "chapter", startMs: 0, endMs: 2000 }],
      },
      source,
    );
    expect(duplicate.segments).toEqual([]);
    expect(duplicate.validationWarnings).toMatchObject([{ code: "invalid-correction" }]);
    expect(duplicate.chapters).toHaveLength(1);
    const malformed = constrainCorrectionToTrack(
      extractSubtitleCorrectionResult(
        '{"segments":[{"id":"s-0","text":"Source 0 corrected"}],"chapters":[{"title":3,"startMs":0}]}',
        true,
      ),
      source,
    );
    expect(malformed.segments).toEqual([{ id: "s-0", text: "Source 0 corrected" }]);
    expect(malformed.chapters).toEqual([]);
    expect(malformed.validationWarnings).toMatchObject([{ code: "invalid-chapter" }]);
  });

  it("saves track, chapters and anchors together and rejects a stale revision", async () => {
    const store = createSubtitleStore({ databaseName: `upgrade-${crypto.randomUUID()}` });
    const asset: SubtitleAsset = {
      recordingId: "recording-1",
      sourceEventsChecksum: "events-checksum",
      subtitleTrackRevision: 1,
      track: track(),
      chapters: [{ id: "chapter", title: "First", startMs: 0, endMs: 2000 }],
      anchors: [
        {
          segmentId: "s-0",
          targetMs: 0,
          eventSeq: 0,
          documentId: "source:javascript",
          contentHash: "code-hash",
          source: "manual",
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
        },
      ],
    };
    await expect(store.saveAsset!(asset, 0)).resolves.toBe(true);
    const saved = await store.loadAsset!(asset.recordingId);
    expect(saved?.track.revision).toBe(1);
    expect(saved?.anchors).toEqual(asset.anchors);
    await expect(
      store.saveAsset!({ ...asset, track: { ...asset.track, segments: [] } }, 0),
    ).resolves.toBe(false);
    expect((await store.loadAsset!(asset.recordingId))?.track.segments).toHaveLength(2);
    const broken = {
      ...asset,
      anchors: [
        {
          ...asset.anchors[0],
          range: (() => null) as unknown as (typeof asset.anchors)[0]["range"],
        },
      ],
    };
    await expect(store.saveAsset!(broken, 1)).rejects.toThrow();
    expect(await store.loadAsset!(asset.recordingId)).toEqual(saved);
  });

  it("checks both line and column bounds before highlighting code", () => {
    expect(
      isValidCodeRange("abc\nxy", {
        startLineNumber: 1,
        startColumn: 2,
        endLineNumber: 2,
        endColumn: 3,
      }),
    ).toBe(true);
    expect(
      isValidCodeRange("abc", {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: 2,
        endColumn: 1,
      }),
    ).toBe(false);
    expect(
      isValidCodeRange("abc", {
        startLineNumber: 1,
        startColumn: 5,
        endLineNumber: 1,
        endColumn: 6,
      }),
    ).toBe(false);
  });

  it("keeps external keys session-scoped unless remembering is explicitly selected", () => {
    clearExternalLlmConfig();
    const config = {
      provider: "openai" as const,
      baseURL: "https://example.test/v1",
      apiKey: "private-key",
      model: "test",
    };
    saveExternalLlmConfig(config);
    expect(localStorage.getItem(SUBTITLE_LLM_CONFIG_STORAGE_KEY)).toBeNull();
    expect(loadExternalLlmConfig()).toEqual(config);
    saveExternalLlmConfig(config, undefined, { rememberKey: true });
    sessionStorage.clear();
    expect(loadExternalLlmConfig()).toEqual(config);
    clearExternalLlmConfig();
    expect(localStorage.getItem(SUBTITLE_LLM_CONFIG_STORAGE_KEY)).toBeNull();
  });
});
