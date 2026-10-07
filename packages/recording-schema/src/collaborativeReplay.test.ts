import assert from "node:assert/strict";
import test from "node:test";
import { buildInitialReplayStateFromRecordStart, replayReducer } from "./replayState.js";
import { verifyRecordingPackageIntegrity } from "./integrity.js";
import { canonicalStringify, sha256Hex } from "./hash.js";
import type { RecordingEvent, RecordingPackageV1, RecordStartPayload } from "./types.js";
import { assertEventSeqInvariants } from "./validators.js";

const start: RecordStartPayload = { initialLanguage: "javascript", initialTheme: "dark", initialFontSize: 14, selectedAudioDeviceId: null, selectedCameraDeviceId: null, mediaCapability: { audio: "unsupported", camera: "unsupported", selectedAudioDeviceId: null, selectedCameraDeviceId: null } };
const content: Extract<RecordingEvent, { type: "content-change" }> = { id: "edit", seq: 1, timestampMs: 10, source: "editor", track: "main", type: "content-change", payload: { fileId: "main", documentId: "source:html", version: 1, code: "<h1>Hello</h1>", language: "html", contentHash: "hash", changeReason: "input", changeCount: 1, flushedBy: "debounce" } };

test("events permit time ties but reject decreasing time for binary timeline indexes", () => {
  assert.equal(assertEventSeqInvariants([content, { ...content, seq: 2 }]).ok, true);
  assert.equal(assertEventSeqInvariants([content, { ...content, seq: 2, timestampMs: 9 }]).ok, false);
});

test("inactive shared document and delayed view events do not switch the recorded view", () => {
  const initial = buildInitialReplayStateFromRecordStart(start);
  const updated = replayReducer(initial, content);
  assert.equal(updated.editor.language, "javascript");
  assert.equal(updated.editor.code, "");
  assert.equal(updated.editor.documents!.html.code, content.payload.code);
  const scrolled = replayReducer(updated, { id: "scroll", seq: 2, timestampMs: 11, source: "editor", track: "main", type: "editor-scroll", payload: { documentId: "source:html", scrollTop: 500, scrollLeft: 0 } });
  assert.equal(scrolled.editor.scrollTop, 0);
  assert.equal(scrolled.editor.documents!.html.scrollTop, 500);
});

test("snapshot run identity rejects results belonging to an earlier run", () => {
  const running = replayReducer(buildInitialReplayStateFromRecordStart(start), { id: "run", seq: 1, timestampMs: 10, source: "runtime", track: "runtime", type: "run-start", payload: { runId: "new-run", runtime: "iframe", language: "javascript", inputDocumentsHash: "inputs" } });
  const late = replayReducer(running, { id: "late", seq: 2, timestampMs: 11, source: "runtime", track: "runtime", type: "run-output", payload: { runId: "old-run", status: "success", stdout: ["wrong"], stderr: [], previewHtml: null } });
  assert.equal(late, running);
  assert.equal(late.runtime.inputDocumentsHash, "inputs");
});

test("0.1.0 checksum is verified before adaptation, then migrated checksums describe 0.2.0", async () => {
  const oldEvent = { ...content, payload: { ...content.payload, documentId: undefined } };
  const pkg: RecordingPackageV1 = { schemaVersion: "0.1.0", manifest: { packageId: "old", schemaVersion: "0.1.0", status: "complete", createdAt: "2026-01-01", completedAt: "2026-01-01", checksums: { eventsSha256: await sha256Hex(canonicalStringify([oldEvent])), snapshotsSha256: await sha256Hex("[]") } }, meta: { id: "old", title: "Old", createdAt: "2026-01-01", durationMs: 20, appVersion: "0.1", ownerId: null, creatorInfo: null, initialLanguage: "javascript", initialFontSize: 14, initialTheme: "dark", mediaCapability: start.mediaCapability }, events: [oldEvent], snapshots: [], media: null };
  const good = await verifyRecordingPackageIntegrity(pkg);
  assert.equal(good.ok, true);
  if (!good.ok) return;
  assert.equal(good.package.schemaVersion, "0.2.0");
  assert.equal(replayReducer(buildInitialReplayStateFromRecordStart(start), good.package.events[0]).editor.language, "html");
  assert.equal(good.package.manifest.checksums.eventsSha256, await sha256Hex(canonicalStringify(good.package.events)));
  const bad = await verifyRecordingPackageIntegrity({ ...pkg, events: [{ ...oldEvent, payload: { ...oldEvent.payload, code: "tampered" } }] });
  assert.deepEqual(bad, { ok: false, error: { code: "checksum-mismatch", target: "events" } });
});
