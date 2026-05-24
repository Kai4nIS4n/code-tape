import {
  RECORDING_SCHEMA_VERSION,
  type RecordingEvent,
  type RecordingEventType,
  type RecordingPackageV1,
  type SchemaValidationIssue,
  type SchemaValidationResult,
} from "./types";

const EVENT_TYPES = new Set<RecordingEventType>([
  "record-start",
  "record-pause",
  "record-resume",
  "resume-baseline",
  "record-stop",
  "content-change",
  "language-change",
  "selection-change",
  "editor-scroll",
  "mouse-move",
  "mouse-click",
  "shortcut",
  "media-toggle",
  "media-warning",
  "camera-position",
  "run-start",
  "run-output",
  "run-error",
  "chapter-marker",
]);

/** Strongly-typed predicate so downstream code never sees `unknown` after a positive check. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushIssue(errors: SchemaValidationIssue[], path: string, message: string): void {
  errors.push({ path, message });
}

function expectString(value: unknown, path: string, errors: SchemaValidationIssue[]): value is string {
  if (typeof value !== "string") {
    pushIssue(errors, path, `expected string, got ${typeof value}`);
    return false;
  }
  return true;
}

function expectNumber(value: unknown, path: string, errors: SchemaValidationIssue[]): value is number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    pushIssue(errors, path, `expected finite number, got ${typeof value}`);
    return false;
  }
  return true;
}

function expectBoolean(value: unknown, path: string, errors: SchemaValidationIssue[]): value is boolean {
  if (typeof value !== "boolean") {
    pushIssue(errors, path, `expected boolean, got ${typeof value}`);
    return false;
  }
  return true;
}

function validateManifest(value: unknown, errors: SchemaValidationIssue[]): void {
  if (!isPlainObject(value)) {
    pushIssue(errors, "manifest", "manifest must be an object");
    return;
  }
  expectString(value.packageId, "manifest.packageId", errors);
  if (value.schemaVersion !== RECORDING_SCHEMA_VERSION) {
    pushIssue(errors, "manifest.schemaVersion", `unsupported schema version: ${String(value.schemaVersion)}`);
  }
  if (value.status !== "draft" && value.status !== "complete") {
    pushIssue(errors, "manifest.status", "status must be draft or complete");
  }
  expectString(value.createdAt, "manifest.createdAt", errors);
  if (value.completedAt !== null && typeof value.completedAt !== "string") {
    pushIssue(errors, "manifest.completedAt", "completedAt must be string or null");
  }
  if (!isPlainObject(value.checksums)) {
    pushIssue(errors, "manifest.checksums", "checksums must be an object");
  } else {
    expectString(value.checksums.eventsSha256, "manifest.checksums.eventsSha256", errors);
    expectString(value.checksums.snapshotsSha256, "manifest.checksums.snapshotsSha256", errors);
  }
}

function validateMeta(value: unknown, errors: SchemaValidationIssue[]): void {
  if (!isPlainObject(value)) {
    pushIssue(errors, "meta", "meta must be an object");
    return;
  }
  expectString(value.id, "meta.id", errors);
  expectString(value.title, "meta.title", errors);
  expectString(value.createdAt, "meta.createdAt", errors);
  expectNumber(value.durationMs, "meta.durationMs", errors);
  expectString(value.appVersion, "meta.appVersion", errors);
  if (value.ownerId !== null && typeof value.ownerId !== "string") {
    pushIssue(errors, "meta.ownerId", "ownerId must be string or null");
  }
  if (value.initialLanguage !== "javascript" && value.initialLanguage !== "typescript" && value.initialLanguage !== "python") {
    pushIssue(errors, "meta.initialLanguage", "initialLanguage must be one of javascript|typescript|python");
  }
  expectNumber(value.initialFontSize, "meta.initialFontSize", errors);
  if (value.initialTheme !== "light" && value.initialTheme !== "dark") {
    pushIssue(errors, "meta.initialTheme", "initialTheme must be light or dark");
  }
  if (!isPlainObject(value.mediaCapability)) {
    pushIssue(errors, "meta.mediaCapability", "mediaCapability must be an object");
  }
}

function validateEvent(value: unknown, index: number, errors: SchemaValidationIssue[]): void {
  const prefix = `events[${index}]`;
  if (!isPlainObject(value)) {
    pushIssue(errors, prefix, "event must be an object");
    return;
  }
  expectString(value.id, `${prefix}.id`, errors);
  expectNumber(value.seq, `${prefix}.seq`, errors);
  expectNumber(value.timestampMs, `${prefix}.timestampMs`, errors);
  expectString(value.source, `${prefix}.source`, errors);
  expectString(value.track, `${prefix}.track`, errors);
  if (!expectString(value.type, `${prefix}.type`, errors)) return;
  if (!EVENT_TYPES.has(value.type as RecordingEventType)) {
    pushIssue(errors, `${prefix}.type`, `unknown event type: ${value.type}`);
  }
  if (!("payload" in value)) {
    pushIssue(errors, `${prefix}.payload`, "payload is required");
  }
}

function validateSnapshot(value: unknown, index: number, errors: SchemaValidationIssue[]): void {
  const prefix = `snapshots[${index}]`;
  if (!isPlainObject(value)) {
    pushIssue(errors, prefix, "snapshot must be an object");
    return;
  }
  expectString(value.id, `${prefix}.id`, errors);
  expectNumber(value.timestampMs, `${prefix}.timestampMs`, errors);
  expectNumber(value.eventSeq, `${prefix}.eventSeq`, errors);
  if (!isPlainObject(value.state)) {
    pushIssue(errors, `${prefix}.state`, "state must be an object");
  }
}

function validateMedia(value: unknown, errors: SchemaValidationIssue[]): void {
  if (value === null) return;
  if (!isPlainObject(value)) {
    pushIssue(errors, "media", "media must be object or null");
    return;
  }
  expectString(value.blobId, "media.blobId", errors);
  expectString(value.mimeType, "media.mimeType", errors);
  expectNumber(value.durationMs, "media.durationMs", errors);
  expectNumber(value.sizeBytes, "media.sizeBytes", errors);
  expectNumber(value.timelineOffsetMs, "media.timelineOffsetMs", errors);
  expectBoolean(value.hasAudio, "media.hasAudio", errors);
  expectBoolean(value.hasCamera, "media.hasCamera", errors);
}

/**
 * Validate that a value matches RecordingPackageV1.
 *
 * Intentionally implemented without zod / arktype to keep dependency surface small.
 * The check is shape-based: any unknown nested keys are tolerated so future minor
 * extensions don't break old loaders, but every required field is enforced.
 */
export function validateRecordingPackageV1(input: unknown): SchemaValidationResult {
  const errors: SchemaValidationIssue[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: "$", message: "package must be an object" }] };
  }
  if (input.schemaVersion !== RECORDING_SCHEMA_VERSION) {
    errors.push({
      path: "schemaVersion",
      message: `unsupported schemaVersion: ${String(input.schemaVersion)}`,
    });
  }
  validateManifest(input.manifest, errors);
  validateMeta(input.meta, errors);

  if (!Array.isArray(input.events)) {
    errors.push({ path: "events", message: "events must be an array" });
  } else {
    input.events.forEach((event, idx) => validateEvent(event, idx, errors));
  }

  if (!Array.isArray(input.snapshots)) {
    errors.push({ path: "snapshots", message: "snapshots must be an array" });
  } else {
    input.snapshots.forEach((snapshot, idx) => validateSnapshot(snapshot, idx, errors));
  }

  validateMedia(input.media, errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

/** Convenience type guard for already-validated inputs. */
export function isRecordingPackageV1(input: unknown): input is RecordingPackageV1 {
  return validateRecordingPackageV1(input).ok;
}

/** Returns a deterministic event ordering invariant: every `seq` is unique and monotonic. */
export function assertEventSeqInvariants(events: RecordingEvent[]): SchemaValidationResult {
  const seen = new Set<number>();
  const errors: SchemaValidationIssue[] = [];
  let last = 0;
  events.forEach((event, idx) => {
    if (seen.has(event.seq)) {
      errors.push({ path: `events[${idx}].seq`, message: `duplicate seq: ${event.seq}` });
    }
    seen.add(event.seq);
    if (event.seq <= last && idx > 0) {
      errors.push({ path: `events[${idx}].seq`, message: `seq must be monotonic: ${event.seq} after ${last}` });
    }
    last = Math.max(last, event.seq);
  });
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
