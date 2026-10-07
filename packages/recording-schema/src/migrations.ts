import { validateRecordingPackageV1 } from "./validators.js";
import {
  RECORDING_SCHEMA_VERSION,
  type MigrateResult,
  type MigrationRegistryEntry,
  type RecordingPackageV1,
} from "./types.js";

/**
 * Migration registry. Add new entries as schema bumps land.
 *
 * Each entry takes the input shape of `from` and returns the input shape of `to`.
 * `migrateRecordingPackage` will walk the registry from the input version up to
 * the latest version, applying each migration in sequence.
 */
export const migrationRegistry: MigrationRegistryEntry[] = [
  {
    from: "0.1.0",
    to: "0.2.0",
    migrate(input) {
      const pkg = input as RecordingPackageV1;
      const runs = pkg.events.filter((event) => event.type === "run-start").sort((left, right) => left.seq - right.seq);
      const adaptState = (state: RecordingPackageV1["snapshots"][number]["state"], eventSeq: number) => {
        let low = 0;
        let high = runs.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (runs[middle].seq <= eventSeq) low = middle + 1; else high = middle;
        }
        const run = low > 0 ? runs[low - 1] : null;
        return { ...state, editor: { ...state.editor, activeDocumentId: `source:${state.editor.language}` }, runtime: {
          ...state.runtime, ...(run?.type === "run-start" ? { activeRunId: run.payload.runId, inputDocumentsHash: run.payload.inputDocumentsHash } : {}),
        } };
      };
      let language = pkg.meta.initialLanguage;
      const events = pkg.events.map((event) => {
        if (event.type === "content-change") {
          language = event.payload.language;
          return { ...event, payload: { ...event.payload, documentId: `source:${language}`, legacyActivatesDocument: true } };
        }
        if (event.type === "language-change") language = event.payload.to;
        if (event.type === "resume-baseline") {
          language = event.payload.snapshot.editor.language;
          return { ...event, payload: { ...event.payload, snapshot: adaptState(event.payload.snapshot, event.seq) } };
        }
        if (event.type === "selection-change" || event.type === "editor-scroll") {
          return { ...event, payload: { ...event.payload, documentId: `source:${language}` } };
        }
        return event;
      });
      return { ...pkg, schemaVersion: "0.2.0", manifest: { ...pkg.manifest, schemaVersion: "0.2.0" }, events,
        snapshots: pkg.snapshots.map((snapshot) => ({ ...snapshot, state: adaptState(snapshot.state, snapshot.eventSeq) })) };
    },
  },
];

function getSchemaVersion(input: unknown): string | null {
  if (typeof input === "object" && input !== null && "schemaVersion" in input) {
    const version = (input as { schemaVersion: unknown }).schemaVersion;
    return typeof version === "string" ? version : null;
  }
  return null;
}

export function migrateRecordingPackage(input: unknown): MigrateResult {
  const sourceVersion = getSchemaVersion(input);
  if (!sourceVersion) {
    return {
      ok: false,
      error: { code: "invalid-manifest", message: "schemaVersion missing or not a string" },
    };
  }

  let current: unknown = input;
  let currentVersion = sourceVersion;
  const applied: string[] = [];
  const sourceValidation = validateRecordingPackageV1(input);
  if (sourceVersion === "0.1.0" && !sourceValidation.ok) {
    return { ok: false, error: { code: "invalid-manifest", message: sourceValidation.errors.map((e) => `${e.path}: ${e.message}`).join("; ") } };
  }

  while (currentVersion !== RECORDING_SCHEMA_VERSION) {
    const entry = migrationRegistry.find((m) => m.from === currentVersion);
    if (!entry) {
      return {
        ok: false,
        error: { code: "unsupported-schema", schemaVersion: currentVersion },
      };
    }
    current = entry.migrate(current);
    currentVersion = entry.to;
    applied.push(`${entry.from}->${entry.to}`);
  }

  const validation = validateRecordingPackageV1(current);
  if (!validation.ok) {
    return {
      ok: false,
      error: {
        code: "invalid-manifest",
        message: validation.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
      },
    };
  }
  return { ok: true, package: current as RecordingPackageV1, appliedMigrations: applied };
}
