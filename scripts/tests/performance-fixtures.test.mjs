import assert from "node:assert/strict";
import test from "node:test";
import { verifyRecordingPackageIntegrity } from "../../packages/recording-schema/dist/index.js";
import { canonicalStringify } from "../../packages/recording-schema/dist/hash.js";
import {
  SNAPSHOT_STRATEGIES,
  assertFixtureBudget,
  buildSnapshots,
  fixtureStats,
  generateRecordingFixture,
  rebuildAtTime,
  seededTargets,
  sha256,
} from "../perf/fixtures.mjs";

test("seeded 2k/10k/20k fixture packages obey size/time budgets and original checksum validation", async () => {
  for (const [eventCount, sourceBytes] of [
    [2000, 2048],
    [10000, 2048],
    [20000, 2048],
    [2000, 20480],
  ]) {
    const fixture = await generateRecordingFixture({ eventCount, sourceBytes });
    assert.equal(fixture.pkg.events.length, eventCount);
    assert.equal(
      Buffer.byteLength(fixture.pkg.meta.initialDocuments.javascript.code),
      sourceBytes,
    );
    assert.ok(fixture.stats.totalBytes < 250 * 1024 * 1024);
    assert.ok(
      fixture.pkg.events.some(
        (event, index, events) =>
          index > 0 && event.timestampMs === events[index - 1].timestampMs,
      ),
    );
    for (const type of [
      "content-change",
      "selection-change",
      "run-start",
      "run-error",
      "chapter-marker",
      "record-pause",
    ])
      assert.ok(
        fixture.stats.eventTypes[type] > 0,
        `${eventCount} fixture missing ${type}`,
      );
    assert.equal((await verifyRecordingPackageIntegrity(fixture.pkg)).ok, true);
  }
});

test("same seed produces the same bytes; 0.1.0 remains readable and tampering is rejected before migration", async () => {
  const first = await generateRecordingFixture({
    eventCount: 2000,
    schemaVersion: "0.1.0",
  });
  const repeated = await generateRecordingFixture({
    eventCount: 2000,
    schemaVersion: "0.1.0",
  });
  assert.equal(first.stats.datasetHash, repeated.stats.datasetHash);
  const read = await verifyRecordingPackageIntegrity(first.pkg);
  assert.equal(read.ok, true);
  assert.equal(read.package.schemaVersion, "0.2.0");
  const tampered = structuredClone(first.pkg);
  tampered.events.find(
    (event) => event.type === "content-change",
  ).payload.code = "tampered";
  assert.deepEqual(await verifyRecordingPackageIntegrity(tampered), {
    ok: false,
    error: { code: "checksum-mismatch", target: "events" },
  });
});

test("snapshot OR strategies preserve every semantic checkpoint and both seek paths reconstruct identical state", async () => {
  const fixture = await generateRecordingFixture({ eventCount: 2000 });
  const semantic = new Set([
    "record-start",
    "record-stop",
    "record-pause",
    "record-resume",
    "language-change",
    "run-start",
    "run-output",
    "run-error",
  ]);
  const counts = [];
  for (const strategy of SNAPSHOT_STRATEGIES) {
    const snapshots = buildSnapshots(
      fixture.pkg.events,
      fixture.initialState,
      strategy,
    );
    counts.push(snapshots.length);
    for (const event of fixture.pkg.events)
      if (semantic.has(event.type))
        assert.ok(
          snapshots.some((snapshot) => snapshot.eventSeq === event.seq),
        );
    const pkg = {
      ...fixture.pkg,
      snapshots,
      manifest: {
        ...fixture.pkg.manifest,
        checksums: {
          ...fixture.pkg.manifest.checksums,
          snapshotsSha256: sha256(canonicalStringify(snapshots)),
        },
      },
    };
    assert.equal((await verifyRecordingPackageIntegrity(pkg)).ok, true);
    for (const targetMs of seededTargets(pkg.meta.durationMs, 30)) {
      const linear = rebuildAtTime(pkg, fixture.initialState, targetMs, false);
      const indexed = rebuildAtTime(pkg, fixture.initialState, targetMs, true);
      assert.equal(
        canonicalStringify(linear.state),
        canonicalStringify(indexed.state),
      );
      assert.equal(linear.lastSeq, indexed.lastSeq);
      assert.ok(indexed.scanned <= linear.scanned);
    }
  }
  assert.ok(counts[0] >= counts[1] && counts[1] >= counts[2]);
});

test("explicit invalid duration, event and byte budgets are rejected", async () => {
  const { pkg } = await generateRecordingFixture({ eventCount: 100 });
  assert.throws(
    () =>
      assertFixtureBudget({
        ...pkg,
        meta: { ...pkg.meta, durationMs: 900001 },
      }),
    /budget/,
  );
  assert.throws(
    () =>
      assertFixtureBudget(pkg, {
        ...fixtureStats(pkg),
        totalBytes: 250 * 1024 * 1024 + 1,
      }),
    /budget/,
  );
  await assert.rejects(() => generateRecordingFixture({ eventCount: 20001 }));
});
