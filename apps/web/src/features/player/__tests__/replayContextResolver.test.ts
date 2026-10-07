import { describe, expect, it } from "vitest";
import type { RecordingEvent, RecordingPackageV1 } from "@/shared/recording-schema";
import { RECORDING_SCHEMA_VERSION } from "@/shared/recording-schema";
import { sha256Hex } from "@/shared/util/hash";
import { createReplayContextResolver } from "../replayContextResolver";
import { buildSubtitleCodeAnchors } from "@/features/subtitles/subtitleCodeAnchors";

function content(seq: number, timestampMs: number, code: string): RecordingEvent {
  return {
    id: `e-${seq}`,
    seq,
    timestampMs,
    source: "editor",
    track: "main",
    type: "content-change",
    payload: {
      fileId: "main",
      documentId: "source:javascript",
      language: "javascript",
      version: seq,
      code,
      contentHash: "hash",
      changeReason: "input",
      changeCount: 1,
      flushedBy: "debounce",
    },
  };
}
function fixture(): RecordingPackageV1 {
  return {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    manifest: {
      packageId: "package",
      schemaVersion: RECORDING_SCHEMA_VERSION,
      status: "complete",
      createdAt: "2026-10-07T00:00:00Z",
      completedAt: null,
      checksums: { eventsSha256: "events-checksum", snapshotsSha256: "snapshots-checksum" },
    },
    meta: {
      id: "recording",
      title: "History",
      createdAt: "2026-10-07T00:00:00Z",
      durationMs: 5000,
      appVersion: "test",
      ownerId: null,
      creatorInfo: null,
      initialLanguage: "javascript",
      initialFontSize: 14,
      initialTheme: "dark",
      mediaCapability: {
        audio: "unsupported",
        camera: "unsupported",
        selectedAudioDeviceId: null,
        selectedCameraDeviceId: null,
      },
    },
    events: [
      content(1, 1000, "const early = 1;"),
      content(2, 3000, "const late = 2;"),
      {
        id: "cursor",
        seq: 3,
        timestampMs: 3000,
        source: "editor",
        track: "main",
        type: "selection-change",
        payload: {
          documentId: "source:javascript",
          cursor: { lineNumber: 1, column: 7 },
          selection: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 11 },
        },
      },
    ],
    snapshots: [],
    media: null,
  };
}
describe("historical subtitle contexts and anchors", () => {
  it("resolves each batch against historical state rather than the current viewer", () => {
    const resolver = createReplayContextResolver(fixture(), ["React"]);
    expect(resolver.resolve(1000, 2000).code).toBe("const early = 1;");
    expect(resolver.resolve(3000, 4000).code).toBe("const late = 2;");
    expect(resolver.resolve(3000, 4000).glossary).toEqual(["React"]);
  });
  it("builds a range from the state after all equal-time events and links its hash", async () => {
    const pkg = fixture();
    const anchors = await buildSubtitleCodeAnchors(pkg, {
      recordingId: pkg.meta.id,
      generatedAt: "now",
      model: "test",
      source: "huggingface-local",
      segments: [
        { id: "early", startMs: 500, endMs: 1000, text: "No range" },
        { id: "late", startMs: 3000, endMs: 4000, text: "Explain late" },
      ],
    });
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({
      segmentId: "late",
      targetMs: 3000,
      eventSeq: 3,
      documentId: "source:javascript",
      contentHash: await sha256Hex("const late = 2;"),
      source: "recorded-selection",
      range: { startLineNumber: 1, startColumn: 7, endLineNumber: 1, endColumn: 11 },
    });
  });
});
