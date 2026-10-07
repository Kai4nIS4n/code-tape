import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { cpus, platform, release, totalmem } from "node:os";
import { STABLE_EVENT_TYPES } from "../../packages/recording-schema/dist/index.js";
import { canonicalStringify } from "../../packages/recording-schema/dist/hash.js";
import {
  DEFAULT_SEED,
  SNAPSHOT_STRATEGIES,
  buildSnapshots,
  fixtureStats,
  generateRecordingFixture,
  rebuildAtTime,
  seededTargets,
  sha256,
  summarize,
} from "./fixtures.mjs";

const out = resolve(
  process.argv.find((arg) => arg.startsWith("--out="))?.slice(6) ??
    "artifacts/perf/snapshot-seek.json",
);
const count = Number(
  process.argv.find((arg) => arg.startsWith("--operations="))?.slice(13) ?? 100,
);
if (!Number.isInteger(count) || count < 1)
  throw new Error("--operations must be a positive integer");
const result = {
  experiment: "deterministic-snapshot-and-seek",
  measuredAt: new Date().toISOString(),
  environment: {
    node: process.version,
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model,
    memoryBytes: totalmem(),
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    lockfileSha256: sha256(await readFile("package-lock.json")),
    seed: DEFAULT_SEED,
    operations: count,
    percentileMethod: "R7 interpolation",
    timer: "performance.now",
    media: "none",
    notes:
      "Both algorithms use the same current reducer and cloned immutable snapshots; indexes are prepared outside timing. Browser code-visible latency is a separate measurement.",
  },
  datasets: [],
};
for (const [eventCount, sourceBytes] of [
  [2000, 2048],
  [10000, 2048],
  [20000, 2048],
  [2000, 20480],
]) {
  const fixture = await generateRecordingFixture({ eventCount, sourceBytes });
  const stable = fixture.pkg.events.filter((event) =>
    STABLE_EVENT_TYPES.has(event.type),
  );
  const targets = seededTargets(fixture.pkg.meta.durationMs, count);
  const dataset = {
    eventCount,
    sourceBytes,
    seed: DEFAULT_SEED,
    sourceEventsChecksum: fixture.pkg.manifest.checksums.eventsSha256,
    strategies: [],
  };
  for (const strategy of SNAPSHOT_STRATEGIES) {
    const started = performance.now();
    const snapshots = buildSnapshots(
      fixture.pkg.events,
      fixture.initialState,
      strategy,
    );
    const buildMs = performance.now() - started;
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
      indexes: {
        ...fixture.pkg.indexes,
        snapshotSeqsByTime: snapshots.map((snapshot) => snapshot.eventSeq),
      },
    };
    const samples = [];
    // Warm code paths without using those iterations as measurements.
    for (const indexed of [false, true])
      for (const target of targets.slice(0, 10))
        rebuildAtTime(pkg, fixture.initialState, target, indexed, stable);
    for (const [sample, targetMs] of targets.entries()) {
      const pair = [];
      for (const indexed of sample % 2 ? [true, false] : [false, true]) {
        const start = performance.now();
        const rebuilt = rebuildAtTime(
          pkg,
          fixture.initialState,
          targetMs,
          indexed,
          stable,
        );
        const elapsedMs = performance.now() - start;
        const row = {
          sample,
          algorithm: indexed ? "upper-bound" : "linear-prefix-scan",
          targetMs,
          elapsedMs,
          scannedEvents: rebuilt.scanned,
          appliedEvents: rebuilt.applied,
          snapshotSeq: rebuilt.snapshotSeq,
          lastAppliedSeq: rebuilt.lastSeq,
          stateSha256: sha256(canonicalStringify(rebuilt.state)),
        };
        samples.push(row);
        pair.push(row);
      }
      if (
        pair[0].stateSha256 !== pair[1].stateSha256 ||
        pair[0].lastAppliedSeq !== pair[1].lastAppliedSeq
      )
        throw new Error("Seek algorithms reconstructed different state");
    }
    dataset.strategies.push({
      strategy,
      buildMs,
      stats: fixtureStats(pkg),
      latency: Object.fromEntries(
        ["linear-prefix-scan", "upper-bound"].map((algorithm) => [
          algorithm,
          summarize(
            samples
              .filter((row) => row.algorithm === algorithm)
              .map((row) => row.elapsedMs),
          ),
        ]),
      ),
      samples,
    });
  }
  result.datasets.push(dataset);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(result, null, 2));
  console.log(
    `Measured ${eventCount} events / ${sourceBytes} source bytes: ${out}`,
  );
}
