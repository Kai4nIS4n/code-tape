import { migrateRecordingPackage } from "./migrations.js";
import { isKnownRecordingEventType, validateRecordingPackageV1 } from "./validators.js";
import type {
  PackageLoadError,
  PackageLoadResult,
  PackageWarning,
  RecordingEvent,
  RecordingPackageV1,
  SchemaValidationIssue,
} from "./types.js";
import { canonicalStringify, sha256Hex } from "./hash.js";

export async function sha256Blob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  return sha256Hex(arrayBufferToBase64(buffer));
}

export async function verifyRecordingPackageIntegrity(
  input: unknown,
  mediaBlob: Blob | null = null,
): Promise<PackageLoadResult> {
  // Verify the bytes represented by the original version before adapting any
  // events or snapshots. Otherwise migration could hide a tampered old package.
  const pkg = input as RecordingPackageV1;
  if (pkg && typeof pkg === "object" && pkg.schemaVersion !== "0.1.0" && pkg.schemaVersion !== "0.2.0") {
    const migration = migrateRecordingPackage(input);
    if (!migration.ok) return { ok: false, error: migration.error };
  }
  const validation = validateRecordingPackageV1(pkg);
  if (!validation.ok) return { ok: false, error: validationToLoadError(validation.errors) };

  const eventsSha256 = await sha256Hex(canonicalStringify(pkg.events));
  if (eventsSha256 !== pkg.manifest.checksums.eventsSha256) {
    return { ok: false, error: { code: "checksum-mismatch", target: "events" } };
  }

  const snapshotsSha256 = await sha256Hex(canonicalStringify(pkg.snapshots));
  if (snapshotsSha256 !== pkg.manifest.checksums.snapshotsSha256) {
    return { ok: false, error: { code: "checksum-mismatch", target: "snapshots" } };
  }

  const warnings: PackageWarning[] = [];
  if (pkg.media) {
    if (!mediaBlob) {
      warnings.push({ code: "media-missing", blobId: pkg.media.blobId });
    } else if (!pkg.manifest.checksums.mediaSha256) {
      return { ok: false, error: { code: "checksum-mismatch", target: "media" } };
    } else {
      const mediaSha256 = await sha256Blob(mediaBlob);
      if (mediaSha256 !== pkg.manifest.checksums.mediaSha256) {
        return { ok: false, error: { code: "checksum-mismatch", target: "media" } };
      }
    }
  }
  const migrated = migrateRecordingPackage(input);
  if (!migrated.ok) return { ok: false, error: migrated.error };
  const migratedPackage = migrated.appliedMigrations.length ? {
    ...migrated.package,
    manifest: { ...migrated.package.manifest, checksums: {
      ...migrated.package.manifest.checksums,
      eventsSha256: await sha256Hex(canonicalStringify(migrated.package.events)),
      snapshotsSha256: await sha256Hex(canonicalStringify(migrated.package.snapshots)),
    } },
  } : migrated.package;
  const normalizedPackage = stripUnknownEvents(migratedPackage, warnings);
  return { ok: true, package: normalizedPackage, mediaBlob, warnings };
}

function stripUnknownEvents(
  pkg: RecordingPackageV1,
  warnings: PackageWarning[],
): RecordingPackageV1 {
  const knownEvents: RecordingEvent[] = [];
  let skipped = false;
  for (const event of pkg.events as Array<RecordingEvent | { seq: number; type: string }>) {
    if (isKnownRecordingEventType(event.type)) {
      knownEvents.push(event as RecordingEvent);
    } else {
      skipped = true;
      warnings.push({ code: "unknown-event-skipped", seq: event.seq, type: event.type });
    }
  }
  return skipped ? { ...pkg, events: knownEvents } : pkg;
}

function validationToLoadError(errors: SchemaValidationIssue[]): PackageLoadError {
  const message = errors.map((e) => `${e.path}: ${e.message}`).join("; ");
  if (errors.some((e) => e.path.startsWith("events["))) {
    return { code: "invalid-event", message };
  }
  return { code: "invalid-manifest", message };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  if (typeof btoa === "function") return btoa(binary);
  return Buffer.from(binary, "binary").toString("base64");
}
