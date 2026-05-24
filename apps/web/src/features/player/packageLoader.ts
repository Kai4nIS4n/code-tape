import JSZip from "jszip";
import {
  RECORDING_SCHEMA_VERSION,
  verifyRecordingPackageIntegrity,
} from "@/shared/recording-schema";
import type {
  PackageLoader,
  PackageLoaderInput,
  PackageLoadResult,
  RecordingIndexes,
  RecordingManifest,
  RecordingMedia,
  RecordingMeta,
  RecordingPackageV1,
  RecordingRepository,
} from "@/shared/recording-schema";

export type PackageLoaderOptions = {
  repository: RecordingRepository;
};

/**
 * PackageLoader — uniform read path used by ReplayPage and RecordingLibraryPage.
 *
 * Two entry points:
 *  - kind="indexeddb"  → delegate to repository.load (which already validates).
 *  - kind="file"       → unzip the supplied Blob, parse manifest+events+snapshots,
 *                         run schema validation & migrations, attach media blob.
 */
export function createPackageLoader(options: PackageLoaderOptions): PackageLoader {
  return {
    async load(input: PackageLoaderInput): Promise<PackageLoadResult> {
      if (input.kind === "indexeddb") {
        return options.repository.load(input.recordingId);
      }
      return loadFromZip(input.zip);
    },
  };
}

async function loadFromZip(zip: Blob): Promise<PackageLoadResult> {
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(zip);
  } catch (err) {
    return {
      ok: false,
      error: { code: "invalid-manifest", message: `zip load failed: ${(err as Error).message}` },
    };
  }
  const manifestFile = archive.file("manifest.json");
  const eventsFile = archive.file("events.json");
  const snapshotsFile = archive.file("snapshots.json");
  const metaFile = archive.file("meta.json");
  const indexesFile = archive.file("indexes.json");
  const mediaMetaFile = archive.file("media.json");
  if (!manifestFile || !eventsFile || !snapshotsFile || !metaFile) {
    return {
      ok: false,
      error: { code: "incomplete-package", packageId: "(unknown)" },
    };
  }

  const [manifestRaw, eventsRaw, snapshotsRaw, metaRaw, indexesRaw, mediaMetaRaw] = await Promise.all([
    manifestFile.async("string"),
    eventsFile.async("string"),
    snapshotsFile.async("string"),
    metaFile.async("string"),
    indexesFile?.async("string") ?? Promise.resolve(""),
    mediaMetaFile?.async("string") ?? Promise.resolve(""),
  ]);

  let parsed: RecordingPackageV1;
  let mediaBlob: Blob | null = null;
  try {
    const manifest = JSON.parse(manifestRaw) as RecordingManifest;
    const meta = JSON.parse(metaRaw) as RecordingMeta;
    const mediaFromJson = mediaMetaRaw ? (JSON.parse(mediaMetaRaw) as RecordingMedia) : null;
    const mediaEntry = Object.keys(archive.files).find((n) => n.startsWith("media.") && n !== "media.json");
    const mediaBuffer = mediaEntry ? await archive.file(mediaEntry)!.async("arraybuffer") : null;
    mediaBlob = mediaBuffer
      ? new Blob([mediaBuffer], { type: mediaFromJson?.mimeType ?? "application/octet-stream" })
      : null;
    const media = mediaFromJson ?? (mediaBlob && manifest.checksums.mediaSha256
        ? {
            blobId: "file-media",
            mimeType: mediaBlob.type || "application/octet-stream",
            durationMs: meta.durationMs,
            sizeBytes: mediaBlob.size,
            timelineOffsetMs: 0,
            hasAudio: meta.mediaCapability.audio === "available",
            hasCamera: meta.mediaCapability.camera === "available",
          }
        : null);
    parsed = {
      manifest,
      meta,
      events: JSON.parse(eventsRaw),
      snapshots: JSON.parse(snapshotsRaw),
      media,
      indexes: indexesRaw ? (JSON.parse(indexesRaw) as RecordingIndexes) : undefined,
      schemaVersion: manifest.schemaVersion ?? RECORDING_SCHEMA_VERSION,
    } as RecordingPackageV1;
  } catch (err) {
    return {
      ok: false,
      error: { code: "invalid-manifest", message: `json parse failed: ${(err as Error).message}` },
    };
  }

  return verifyRecordingPackageIntegrity(parsed, mediaBlob);
}
