import { createHash } from "node:crypto";
import {
  buildInitialReplayStateFromRecordStart,
  replayReducer,
  STABLE_EVENT_TYPES,
  verifyRecordingPackageIntegrity,
} from "../../packages/recording-schema/dist/index.js";
import { canonicalStringify } from "../../packages/recording-schema/dist/hash.js";

export const DEFAULT_SEED = 20261007;
export const SNAPSHOT_STRATEGIES = [
  { name: "2s-20", intervalMs: 2000, stableEvents: 20 },
  { name: "5s-50", intervalMs: 5000, stableEvents: 50 },
  { name: "10s-100", intervalMs: 10000, stableEvents: 100 },
];
const SEMANTIC = new Set([
  "record-pause",
  "record-resume",
  "language-change",
  "run-start",
  "run-output",
  "run-error",
]);
const LANGUAGES = ["javascript", "typescript", "python", "html", "css"];
const EVENT_TYPES = [
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
];
const DATE = "2026-10-07T00:00:00.000Z";
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
export function seededRandom(seed = DEFAULT_SEED) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let n = Math.imul(value ^ (value >>> 15), 1 | value);
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}
export function seededTargets(durationMs, count = 100, seed = DEFAULT_SEED) {
  const random = seededRandom(seed);
  return Array.from({ length: count }, (_, index) =>
    Math.floor(
      (index % 2 ? random() * 0.5 : 0.5 + random() * 0.5) * durationMs,
    ),
  );
}
function codeFor(language, version, sourceBytes) {
  const first =
    language === "typescript"
      ? `const perfValue: number = ${version};\n`
      : `const perfValue = ${version};\n`;
  const comment = "/* deterministic recording performance fixture ";
  return (
    first +
    comment +
    "x".repeat(Math.max(0, sourceBytes - first.length - comment.length - 3)) +
    " */"
  );
}
function contentHash(code) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < code.length; index++) {
    hash ^= code.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16)}`;
}
export function buildSnapshots(
  events,
  initialState,
  strategy = SNAPSHOT_STRATEGIES[1],
) {
  let state = initialState,
    stableCount = 0,
    lastTime = -Infinity,
    lastSeq = -1;
  const snapshots = [];
  const capture = (event) => {
    if (event.seq === lastSeq) return;
    snapshots.push({
      id: `perf-snapshot-${event.seq}`,
      eventSeq: event.seq,
      timestampMs: event.timestampMs,
      state: structuredClone(state),
    });
    lastSeq = event.seq;
    lastTime = event.timestampMs;
    stableCount = 0;
  };
  for (const event of events) {
    if (STABLE_EVENT_TYPES.has(event.type)) {
      state = replayReducer(state, event);
      stableCount++;
    }
    if (
      event.type === "record-start" ||
      event.type === "record-stop" ||
      SEMANTIC.has(event.type) ||
      event.timestampMs - lastTime >= strategy.intervalMs ||
      stableCount >= strategy.stableEvents
    )
      capture(event);
  }
  return snapshots;
}

/** Exact event count, fixed 15-minute clock, UTF-8 source byte count and seed. */
export async function generateRecordingFixture({
  eventCount = 2000,
  sourceBytes = 2048,
  seed = DEFAULT_SEED,
  schemaVersion = "0.2.0",
  strategy = SNAPSHOT_STRATEGIES[1],
} = {}) {
  if (!Number.isInteger(eventCount) || eventCount < 10 || eventCount > 20000)
    throw new Error("Fixture event count must be 10–20000");
  if (!["0.1.0", "0.2.0"].includes(schemaVersion))
    throw new Error("Unsupported fixture schema");
  if (
    !Number.isInteger(sourceBytes) ||
    sourceBytes < 128 ||
    sourceBytes > 20480
  )
    throw new Error("Fixture source size must be 128–20480 bytes");
  const random = seededRandom(seed),
    durationMs = 900000;
  const documents = Object.fromEntries(
    LANGUAGES.map((language) => [
      language,
      {
        code:
          language === "javascript" || language === "typescript"
            ? codeFor(language, 0, sourceBytes)
            : "",
        cursor: null,
        selection: null,
        scrollTop: 0,
        scrollLeft: 0,
      },
    ]),
  );
  const capability = {
    audio: "unsupported",
    camera: "unsupported",
    selectedAudioDeviceId: null,
    selectedCameraDeviceId: null,
  };
  const start = {
    initialLanguage: "javascript",
    initialActiveScriptLanguage: "javascript",
    initialDocuments: documents,
    initialTheme: "dark",
    initialFontSize: 14,
    selectedAudioDeviceId: null,
    selectedCameraDeviceId: null,
    mediaCapability: capability,
  };
  const initialState = buildInitialReplayStateFromRecordStart(start);
  let state = initialState,
    revision = 0,
    activeRunId = null;
  const documentVersions = { javascript: 0, typescript: 0 };
  const events = [];
  const emit = (type, payload, timestampMs) => {
    const source = type.startsWith("run-")
      ? "runtime"
      : [
            "record-start",
            "record-stop",
            "record-pause",
            "record-resume",
            "resume-baseline",
          ].includes(type)
        ? "recorder"
        : type.startsWith("mouse-")
          ? "pointer"
          : type === "shortcut"
            ? "shortcut"
            : type === "chapter-marker"
              ? "annotation"
              : type === "media-toggle"
                ? "media"
                : "editor";
    const event = {
      id: `perf-event-${events.length + 1}`,
      seq: events.length + 1,
      timestampMs,
      source,
      track:
        source === "runtime"
          ? "runtime"
          : source === "pointer" ||
              source === "shortcut" ||
              source === "annotation"
            ? "ui"
            : source === "media"
              ? "media"
              : "main",
      type,
      payload,
    };
    events.push(event);
    if (STABLE_EVENT_TYPES.has(type)) state = replayReducer(state, event);
  };
  emit("record-start", start, 0);
  for (let index = 1; index < eventCount - 1; index++) {
    const slot = index % 1000;
    const effectiveIndex =
      slot === 701 || slot === 702 ? index - slot + 700 : index;
    const time = Math.floor(
      (Math.floor(effectiveIndex / 2) * 2 * (durationMs - 1)) /
        (eventCount - 2),
    );
    const language = state.editor.language,
      documentId = `source:${language}`;
    if (slot === 700) {
      emit("record-pause", { reason: "user", stateSeq: events.length }, time);
      continue;
    }
    if (slot === 701) {
      emit("record-resume", { reason: "user" }, time);
      continue;
    }
    if (slot === 702) {
      const baseline = structuredClone(state);
      baseline.editor.cursor = { lineNumber: 1, column: 2 };
      baseline.editor.selection = {
        startLineNumber: 1,
        startColumn: 2,
        endLineNumber: 1,
        endColumn: 2,
      };
      baseline.editor.documents[language].cursor = baseline.editor.cursor;
      baseline.editor.documents[language].selection = baseline.editor.selection;
      emit(
        "resume-baseline",
        { reason: "paused-state-changed", snapshot: baseline },
        time,
      );
      continue;
    }
    if (index % 250 === 0) {
      activeRunId = `perf-run-${index}`;
      emit(
        "run-start",
        {
          language,
          runtime: "iframe",
          runId: activeRunId,
          inputDocumentsHash: sha256(
            canonicalStringify({
              language,
              activeScriptLanguage: state.editor.activeScriptLanguage,
              source: state.editor.code,
              documents: Object.fromEntries(
                LANGUAGES.map((name) => [
                  name,
                  state.editor.documents[name].code,
                ]),
              ),
            }),
          ),
        },
        time,
      );
      continue;
    }
    if (index % 250 === 1 && activeRunId) {
      emit(
        index % 500 === 251 ? "run-error" : "run-output",
        index % 500 === 251
          ? {
              runId: activeRunId,
              phase: "runtime",
              message: "fixture-error",
              stdout: [],
              stderr: ["fixture-error"],
              previewHtml: null,
            }
          : {
              runId: activeRunId,
              stdout: ["fixture-result"],
              stderr: [],
              previewHtml: "<p>Fixture result</p>",
              status: "success",
            },
        time,
      );
      continue;
    }
    if (index % 500 === 450) {
      emit(
        "language-change",
        {
          from: language,
          to: language === "javascript" ? "typescript" : "javascript",
        },
        time,
      );
      continue;
    }
    if (index % 500 === 490) {
      emit(
        "chapter-marker",
        { title: `Chapter ${Math.floor(index / 500) + 1}` },
        time,
      );
      continue;
    }
    const value = random();
    if (value < 0.25) {
      const code = codeFor(language, ++revision, sourceBytes);
      const version =
        schemaVersion === "0.2.0" ? ++documentVersions[language] : revision;
      emit(
        "content-change",
        {
          fileId: "main",
          ...(schemaVersion === "0.2.0" ? { documentId } : {}),
          version,
          code,
          contentHash: contentHash(code),
          language,
          changeReason: "input",
          changeCount: 1,
          flushedBy: "debounce",
        },
        time,
      );
    } else if (value < 0.45)
      emit(
        "selection-change",
        {
          ...(schemaVersion === "0.2.0" ? { documentId } : {}),
          cursor: { lineNumber: 1, column: 1 },
          selection: {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 5,
          },
        },
        time,
      );
    else if (value < 0.6)
      emit(
        "editor-scroll",
        {
          ...(schemaVersion === "0.2.0" ? { documentId } : {}),
          scrollTop: Math.floor(random() * 20),
          scrollLeft: 0,
        },
        time,
      );
    else if (value < 0.85)
      emit(
        "mouse-move",
        {
          x: Math.floor(random() * 500),
          y: Math.floor(random() * 300),
          containerWidth: 600,
          containerHeight: 400,
        },
        time,
      );
    else if (value < 0.93)
      emit(
        "shortcut",
        { keys: ["Control", "S"], label: "Format", command: "format" },
        time,
      );
    else
      emit(
        "media-toggle",
        { microphoneEnabled: false, cameraEnabled: false },
        time,
      );
  }
  emit("record-stop", { durationMs, reason: "user" }, durationMs);
  const snapshots = buildSnapshots(events, initialState, strategy);
  const meta = {
    id: `perf-${eventCount}-${sourceBytes}-${seed}`,
    title: `Performance fixture ${eventCount}/${sourceBytes}`,
    createdAt: DATE,
    durationMs,
    appVersion: "performance-fixture",
    ownerId: null,
    creatorInfo: null,
    ...start,
  };
  const indexes = {
    generatedAt: DATE,
    eventsByType: Object.fromEntries(
      EVENT_TYPES.map((type) => [
        type,
        events.filter((event) => event.type === type).map((event) => event.seq),
      ]),
    ),
    snapshotSeqsByTime: snapshots.map((snapshot) => snapshot.eventSeq),
    markers: events
      .filter((event) => event.type === "chapter-marker")
      .map((event) => ({
        eventSeq: event.seq,
        timestampMs: event.timestampMs,
        type: event.type,
      })),
  };
  const pkg = {
    schemaVersion,
    manifest: {
      packageId: meta.id,
      schemaVersion,
      status: "complete",
      createdAt: DATE,
      completedAt: "2026-10-07T00:15:00.000Z",
      checksums: {
        eventsSha256: sha256(canonicalStringify(events)),
        snapshotsSha256: sha256(canonicalStringify(snapshots)),
      },
    },
    meta,
    events,
    snapshots,
    indexes,
    media: null,
  };
  const stats = fixtureStats(pkg, {
    seed,
    sourceBytes,
    strategy: strategy.name,
  });
  assertFixtureBudget(pkg, stats);
  const verified = await verifyRecordingPackageIntegrity(pkg);
  if (!verified.ok)
    throw new Error(
      `Generated fixture invalid: ${JSON.stringify(verified.error)}`,
    );
  return { pkg, initialState, stats };
}
export function fixtureStats(pkg, extra = {}) {
  const assets = Object.fromEntries(
    ["manifest", "meta", "events", "snapshots", "indexes", "media"].map(
      (key) => [key, Buffer.byteLength(canonicalStringify(pkg[key]))],
    ),
  );
  return {
    ...extra,
    schemaVersion: pkg.schemaVersion,
    eventCount: pkg.events.length,
    stableEventCount: pkg.events.filter((event) =>
      STABLE_EVENT_TYPES.has(event.type),
    ).length,
    snapshotCount: pkg.snapshots.length,
    eventTypes: Object.fromEntries(
      [...new Set(pkg.events.map((event) => event.type))].map((type) => [
        type,
        pkg.events.filter((event) => event.type === type).length,
      ]),
    ),
    assets,
    totalBytes: Object.values(assets).reduce((sum, value) => sum + value, 0),
    datasetHash: sha256(canonicalStringify(pkg)),
  };
}
export function assertFixtureBudget(pkg, stats = fixtureStats(pkg)) {
  if (
    pkg.events.length > 20000 ||
    pkg.meta.durationMs > 900000 ||
    stats.totalBytes > 250 * 1024 * 1024
  )
    throw new Error("Fixture exceeds recording budget");
}
export function rebuildAtTime(
  pkg,
  initialState,
  targetMs,
  indexed = true,
  stable = pkg.events.filter((event) => STABLE_EVENT_TYPES.has(event.type)),
) {
  let low = 0,
    high = pkg.snapshots.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (pkg.snapshots[middle].timestampMs <= targetMs) low = middle + 1;
    else high = middle;
  }
  const snapshot = pkg.snapshots[low - 1];
  let state = structuredClone(snapshot?.state ?? initialState),
    lastSeq = snapshot?.eventSeq ?? 0,
    start = 0,
    scanned = 0,
    applied = 0;
  if (indexed) {
    low = 0;
    high = stable.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (stable[middle].seq <= lastSeq) low = middle + 1;
      else high = middle;
    }
    start = low;
  }
  for (let index = start; index < stable.length; index++) {
    const event = stable[index];
    scanned++;
    if (event.seq <= lastSeq) continue;
    if (event.timestampMs > targetMs) break;
    state = replayReducer(state, event);
    lastSeq = event.seq;
    applied++;
  }
  return {
    state,
    lastSeq,
    scanned,
    applied,
    snapshotSeq: snapshot?.eventSeq ?? 0,
  };
}
export function summarize(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const percentile = (fraction) => {
    const index = (sorted.length - 1) * fraction,
      lower = Math.floor(index);
    return (
      sorted[lower] +
      (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower)
    );
  };
  return sorted.length
    ? {
        count: sorted.length,
        min: sorted[0],
        p50: percentile(0.5),
        p75: percentile(0.75),
        p95: percentile(0.95),
        max: sorted.at(-1),
      }
    : { count: 0 };
}
