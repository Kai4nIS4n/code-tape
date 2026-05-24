import { describe, expect, it } from "vitest";
import {
  RECORDING_SCHEMA_VERSION,
  type RecordingEvent,
  type RecordingPackageV1,
} from "../types";
import {
  assertEventSeqInvariants,
  isRecordingPackageV1,
  validateRecordingPackageV1,
} from "../validators";
import { migrateRecordingPackage } from "../migrations";

function makePackage(): RecordingPackageV1 {
  return {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    manifest: {
      packageId: "pkg-1",
      schemaVersion: RECORDING_SCHEMA_VERSION,
      status: "complete",
      createdAt: "2026-05-24T00:00:00.000Z",
      completedAt: "2026-05-24T00:01:00.000Z",
      checksums: { eventsSha256: "e", snapshotsSha256: "s" },
    },
    meta: {
      id: "rec-1",
      title: "Two Sum 讲解",
      createdAt: "2026-05-24T00:00:00.000Z",
      durationMs: 60_000,
      appVersion: "0.0.0",
      ownerId: null,
      creatorInfo: { displayName: "ceilf6", source: "local" },
      initialLanguage: "javascript",
      initialFontSize: 14,
      initialTheme: "dark",
      mediaCapability: {
        audio: "available",
        camera: "available",
        selectedAudioDeviceId: null,
        selectedCameraDeviceId: null,
      },
    },
    events: [],
    snapshots: [],
    media: null,
  };
}

describe("validateRecordingPackageV1", () => {
  it("accepts a minimal complete package", () => {
    const result = validateRecordingPackageV1(makePackage());
    expect(result.ok).toBe(true);
  });

  it("rejects non-object inputs", () => {
    const result = validateRecordingPackageV1("not a package");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].path).toBe("$");
    }
  });

  it("flags unsupported schemaVersion", () => {
    const pkg = makePackage();
    const result = validateRecordingPackageV1({ ...pkg, schemaVersion: "9.9.9" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "schemaVersion")).toBe(true);
    }
  });

  it("flags missing meta fields with field paths", () => {
    const pkg = makePackage() as unknown as Record<string, unknown>;
    const broken = { ...pkg, meta: { ...(pkg.meta as Record<string, unknown>), title: 42 } };
    const result = validateRecordingPackageV1(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "meta.title")).toBe(true);
    }
  });

  it("flags malformed events with their index", () => {
    const pkg = makePackage() as unknown as Record<string, unknown>;
    const broken = { ...pkg, events: [{ id: "x" }] };
    const result = validateRecordingPackageV1(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path.startsWith("events[0]"))).toBe(true);
    }
  });

  it("isRecordingPackageV1 narrows the type", () => {
    const input: unknown = makePackage();
    expect(isRecordingPackageV1(input)).toBe(true);
  });
});

describe("assertEventSeqInvariants", () => {
  function mockEvent(seq: number): RecordingEvent {
    return {
      id: `e-${seq}`,
      seq,
      timestampMs: seq * 100,
      source: "editor",
      track: "main",
      type: "content-change",
      payload: {
        fileId: "main",
        version: seq,
        code: "",
        contentHash: "",
        language: "javascript",
        changeReason: "input",
        changeCount: 1,
        flushedBy: "debounce",
      },
    };
  }

  it("accepts monotonic unique seq", () => {
    const result = assertEventSeqInvariants([mockEvent(1), mockEvent(2), mockEvent(3)]);
    expect(result.ok).toBe(true);
  });

  it("rejects duplicate seq", () => {
    const result = assertEventSeqInvariants([mockEvent(1), mockEvent(1)]);
    expect(result.ok).toBe(false);
  });

  it("rejects out-of-order seq", () => {
    const result = assertEventSeqInvariants([mockEvent(2), mockEvent(1)]);
    expect(result.ok).toBe(false);
  });
});

describe("migrateRecordingPackage", () => {
  it("passes through already-current packages", () => {
    const result = migrateRecordingPackage(makePackage());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.appliedMigrations).toEqual([]);
  });

  it("returns unsupported-schema for unknown source version", () => {
    const result = migrateRecordingPackage({ ...makePackage(), schemaVersion: "9.9.9" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsupported-schema");
  });

  it("returns invalid-manifest when schemaVersion missing", () => {
    const result = migrateRecordingPackage({ no: "version" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid-manifest");
  });
});
