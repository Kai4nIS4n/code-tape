import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import { cpus, platform, release, totalmem } from "node:os";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import {
  DEFAULT_SEED,
  generateRecordingFixture,
  rebuildAtTime,
  seededTargets,
  sha256,
  summarize,
} from "./fixtures.mjs";
import { STABLE_EVENT_TYPES, buildInitialReplayStateFromPackage, verifyRecordingPackageIntegrity } from "../../packages/recording-schema/dist/index.js";
import { canonicalStringify } from "../../packages/recording-schema/dist/hash.js";

const option = (name, fallback) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
const samples = Number(option("samples", "10")),
  observationMs = Number(option("observation-ms", "10000")),
  operations = Number(option("operations", "100"));
if (
  ![samples, observationMs, operations].every(
    (value) => Number.isInteger(value) && value > 0,
  )
)
  throw new Error(
    "samples/observation-ms/operations must be positive integers",
  );
const out = resolve(option("out", "artifacts/perf/browser.json"));
const afterRoot = resolve(option("after-web-root", "apps/web/dist"));
const beforeRoot = option("before-web-root", null);
const versions = [
  ...(beforeRoot
    ? [
        {
          label: "before",
          ref: option("before-ref", "0ac9097"),
          root: resolve(beforeRoot),
          port: 4601,
        },
      ]
    : []),
  {
    label: "after",
    ref: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    root: afterRoot,
    port: 4602,
  },
];
const profiles = option("profiles", "desktop,limited").split(",");
if (profiles.some((profile) => !["desktop", "limited"].includes(profile)))
  throw new Error("Profiles must be desktop or limited");
const datasetCounts = option("datasets", "2000,10000,20000")
  .split(",")
  .map(Number);
const navigationEnabled = !process.argv.includes("--skip-navigation");
const interactionsEnabled = !process.argv.includes("--skip-interactions");
const mediaRecordingPath = option("media-recording", null);
let mediaFixture = null;
if (mediaRecordingPath) {
  const recording = JSON.parse(await readFile(resolve(mediaRecordingPath), "utf8"));
  const bytes = await readFile(resolve(option("media-file", resolve(dirname(mediaRecordingPath), "media.webm"))));
  if (!recording.media || recording.media.sizeBytes !== bytes.length) throw new Error("Media fixture metadata/file size mismatch");
  const verified = await verifyRecordingPackageIntegrity(recording, new Blob([bytes], { type: recording.media.mimeType }));
  if (!verified.ok) throw new Error(`Media fixture integrity rejected: ${JSON.stringify(verified.error)}`);
  mediaFixture = { pkg: verified.package, bytes, initialState: buildInitialReplayStateFromPackage(verified.package), datasetHash: sha256(canonicalStringify(recording)), mediaRawSha256: sha256(bytes) };
}
const blockedURLs = [
  "*://*/models/*",
  "*://huggingface.co/*",
  "*://*.huggingface.co/*",
  "*://cdn-lfs*/*",
  "*://hf.co/*",
];
const report = {
  experiment: "production-browser-performance",
  measuredAt: new Date().toISOString(),
  environment: {
    node: process.version,
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model,
    memoryBytes: totalmem(),
    powerMode: option("power-mode", "unreported"),
    commit: versions.at(-1).ref,
    workingTreeDirty: Boolean(
      execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
      }).trim(),
    ),
    lockfileSha256: sha256(await readFile("package-lock.json")),
    beforeDependencyMode: beforeRoot
      ? "baseline source 0ac9097 + shared upgraded lock/dependencies; baseline schema explicitly 0.1.0; not original baseline lock environment"
      : "no baseline build",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    browser: null,
    headless: !process.argv.includes("--headed"),
    foreground: "one active page; page.bringToFront()",
    seed: DEFAULT_SEED,
    samplesPerRouteAndCache: samples,
    observationMs,
    operations,
    percentileMethod: "R7 interpolation",
    deployment: "loopback production static files",
    profiles: {
      desktop: { cpuRate: 1, network: "unlimited" },
      limited: { cpuRate: 4, bandwidthMbps: 10, roundTripMs: 100 },
    },
    cacheDefinition: {
      cold: "new BrowserContext; only blank origin + IndexedDB seeded before hard navigation",
      warm: "second hard navigation in same context with HTTP cache enabled",
    },
    blockedURLs,
    media: "none",
    aiInference:
      "not measured; model requests blocked equally without Playwright routing (which would disable HTTP cache)",
    interpretation:
      "Experimental p75 is not real-user p75. RAF intervals are rendering opportunities, not measured FPS.",
  },
  builds: [],
  datasets: [],
  navigation: [],
  timeline: [],
  mediaSeek: [],
  failures: [],
};
const servers = [];
const browser = await chromium.launch({
  headless: report.environment.headless,
  ...(process.env.CODE_TAPE_CHROME_PATH
    ? { executablePath: process.env.CODE_TAPE_CHROME_PATH }
    : {}),
});
report.environment.browser = browser.version();
await mkdir(dirname(out), { recursive: true });
const save = () => writeFile(out, JSON.stringify(report, null, 2));
try {
  for (const version of versions) {
    const index = await readFile(resolve(version.root, "index.html"));
    let buildLockfileSha256 = null;
    try {
      buildLockfileSha256 = sha256(
        await readFile(resolve(version.root, "../../../package-lock.json")),
      );
    } catch {
      /* A standalone dist copy may not carry its lockfile. */
    }
    report.builds.push({
      label: version.label,
      ref: version.ref,
      indexSha256: sha256(index),
      sourceLockfileSha256: buildLockfileSha256,
      port: version.port,
    });
    const server = await serve(version.root, version.port);
    servers.push(server);
    version.origin = `http://127.0.0.1:${version.port}`;
  }
  const navigationFixture = await generateRecordingFixture({
    eventCount: 2000,
    schemaVersion: beforeRoot ? "0.1.0" : "0.2.0",
  });
  report.datasets.push({ purpose: "navigation", ...navigationFixture.stats });
  if (navigationEnabled)
    for (const profile of profiles)
      for (const route of [
        "/",
        "/record",
        `/replay/${navigationFixture.pkg.meta.id}`,
      ])
        for (let sample = 0; sample < samples; sample++) {
          // Alternate A/B order to reduce time-of-run drift. Each cold/warm pair owns
          // a fresh context, so a preceding version never preheats the next version.
          for (const version of sample % 2
            ? versions.slice().reverse()
            : versions) {
            const { context, page } = await preparePage(
              browser,
              version.origin,
              profile,
              navigationFixture.pkg,
            );
            try {
              for (const cache of ["cold", "warm"]) {
                const row = {
                  version: version.label,
                  ref: version.ref,
                  route,
                  profile,
                  cache,
                  sample,
                  datasetHash: navigationFixture.stats.datasetHash,
                };
                try {
                  await page.goto(`${version.origin}${route}`, {
                    waitUntil: "domcontentloaded",
                    timeout: 60000,
                  });
                  // No clicking, scrolling or typing during the observation window.
                  await page.waitForTimeout(observationMs);
                  const measured = await page.evaluate(() =>
                    window.__codeTapePerf.read(),
                  );
                  Object.assign(row, measured, {
                    ok: measured.readyMs !== null && measured.lcp !== null,
                  });
                  if (!row.ok)
                    row.error =
                      "Route did not reach business readiness or no LCP candidate inside the observation window";
                } catch (error) {
                  Object.assign(row, { ok: false, error: String(error) });
                }
                report.navigation.push(row);
                if (!row.ok)
                  report.failures.push({ phase: "navigation", ...row });
                await save();
              }
            } finally {
              await context.close();
            }
            console.log(
              `Navigation ${version.label} ${profile} ${route}: sample ${sample + 1}/${samples}`,
            );
          }
        }
  if (interactionsEnabled && !mediaFixture)
    for (const profile of profiles)
      for (const [datasetIndex, eventCount] of datasetCounts.entries()) {
        const fixture = await generateRecordingFixture({ eventCount });
        report.datasets.push({ purpose: "timeline", ...fixture.stats });
        const version = versions.at(-1);
        for (const mode of datasetIndex % 2
          ? ["virtual", "full"]
          : ["full", "virtual"]) {
          const { context, page } = await preparePage(
            browser,
            version.origin,
            profile,
            fixture.pkg,
          );
          try {
            const result = await timelineExperiment(
              page,
              version,
              profile,
              mode,
              fixture,
              operations,
            );
            report.timeline.push(result);
          } catch (error) {
            report.failures.push({
              phase: "timeline",
              profile,
              mode,
              eventCount,
              error: String(error),
            });
          } finally {
            await context.close();
          }
          await save();
          console.log(`Timeline ${eventCount} ${profile} ${mode}: ${out}`);
        }
      }
  if (interactionsEnabled && mediaFixture) {
    report.environment.media = "real native MediaRecorder WebM from isolated synthetic fake devices; separate after-only group";
    report.datasets.push({ purpose: "media-seek", datasetHash: mediaFixture.datasetHash, mediaRawSha256: mediaFixture.mediaRawSha256, eventCount: mediaFixture.pkg.events.length, durationMs: mediaFixture.pkg.meta.durationMs, media: mediaFixture.pkg.media });
    for (const profile of profiles) {
      const version = versions.at(-1);
      const { context, page } = await preparePage(browser, version.origin, profile, mediaFixture.pkg, mediaFixture.bytes);
      try {
        const result = await mediaSeekExperiment(page, version, profile, mediaFixture, operations);
        report.mediaSeek.push(result);
        for (const row of result.samples) if (!row.warmup && !row.ok) report.failures.push({ phase: "media-seek", profile, ...row });
      }
      catch (error) { report.failures.push({ phase: "media-seek", profile, error: String(error) }); }
      finally { await context.close(); }
      await save(); console.log(`Media ${profile}: ${out}`);
    }
  }
  report.navigationSummary = Object.fromEntries(
    [
      ...new Set(
        report.navigation.map(
          (row) => `${row.version}/${row.profile}/${row.route}/${row.cache}`,
        ),
      ),
    ].map((key) => {
      const rows = report.navigation.filter(
        (row) =>
          `${row.version}/${row.profile}/${row.route}/${row.cache}` === key,
      );
      const successful = rows.filter((row) => row.ok);
      return [
        key,
        {
          total: rows.length,
          failed: rows.length - successful.length,
          lcpMs: summarize(successful.map((row) => row.lcp.startTime)),
          observedLcpWithinWindowMs: summarize(rows.filter((row) => row.lcp).map((row) => row.lcp.startTime)),
          summaryPolicy: "lcpMs/readyMs require business-ready inside the observation window; all partial LCP candidates and failed raw samples remain available separately",
          readyMs: summarize(successful.map((row) => row.readyMs)),
          initialTransferredBytes: summarize(
            successful.map((row) =>
              row.resources.reduce((sum, entry) => sum + entry.transferSize, 0) + (row.documentTiming?.transferSize ?? 0),
            ),
          ),
        },
      ];
    }),
  );
  await save();
  if (report.failures.length) process.exitCode = 1;
} finally {
  await browser.close();
  for (const server of servers)
    await new Promise((resolve) => server.close(resolve));
}

async function serve(root, port) {
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
    if (path === "/_perf/blank") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        "<!doctype html><html><head><title>Fixture seed</title></head><body></body></html>",
      );
      return;
    }
    if (path.startsWith("/api/")) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            code: "unauthorized",
            message: "Performance scenario uses local recordings",
          },
        }),
      );
      return;
    }
    try {
      let target = resolve(root, `.${decodeURIComponent(path)}`);
      if (!target.startsWith(`${root}${sep}`) && target !== root) {
        response.writeHead(403);
        response.end();
        return;
      }
      if (!extname(path)) target = resolve(root, "index.html");
      const info = await stat(target);
      if (!info.isFile()) throw new Error("not a file");
      const body = await readFile(target);
      response.writeHead(200, {
        "Content-Type": mime[extname(target)] ?? "application/octet-stream",
        "Cache-Control": path.startsWith("/assets/")
          ? "public,max-age=31536000,immutable"
          : "no-cache",
        "Content-Length": body.length,
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function preparePage(browser, origin, profile, pkg, mediaBytes = null) {
  const context = await browser.newContext({
    viewport: report.environment.viewport,
    deviceScaleFactor: 1,
    serviceWorkers: "block",
  });
  await context.addInitScript(
    ({ title }) => {
      if (window.top !== window) return;
      performance.setResourceTimingBufferSize(10000);
      const result = {
        lcp: null,
        readyMs: null,
        readyDefinition: null,
        longTasks: [],
        rafIntervals: [],
        rafActive: false,
        mediaEvents: [],
        firstTimelineRowsMs: null,
        firstTimelineRowsRafMs: null,
      };
      for (const type of ["seeking", "seeked"]) document.addEventListener(type, (event) => {
        if (event.target instanceof HTMLMediaElement) result.mediaEvents.push({ type, at: performance.now(), mediaTimeSec: event.target.currentTime });
      }, true);
      const acceptLcp = (entries) => {
        for (const entry of entries)
          result.lcp = {
            startTime: entry.startTime,
            renderTime: entry.renderTime,
            loadTime: entry.loadTime,
            size: entry.size,
            element: entry.element
              ? {
                  tag: entry.element.tagName,
                  id: entry.element.id,
                  className: String(entry.element.className).slice(0, 120),
                }
              : null,
          };
      };
      const lcpObserver = new PerformanceObserver((list) =>
        acceptLcp(list.getEntries()),
      );
      lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
      const acceptTasks = (entries) =>
        entries.forEach((entry) =>
          result.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          }),
        );
      const taskObserver = new PerformanceObserver((list) =>
        acceptTasks(list.getEntries()),
      );
      taskObserver.observe({ type: "longtask", buffered: true });
      const ready = () => {
        if (result.firstTimelineRowsMs === null && document.querySelector('[data-testid="event-timeline-row"]')) {
          result.firstTimelineRowsMs = performance.now();
          requestAnimationFrame(() => { result.firstTimelineRowsRafMs = performance.now(); });
        }
        if (result.readyMs !== null) return;
        const path = location.pathname;
        const replayRoot = document.querySelector(
          '[data-testid="replay-ready"]',
        );
        const replay = replayRoot?.getAttribute("data-ready") === "true";
        const editor = document.querySelector(
          "[data-code-editor] .monaco-editor .view-lines",
        );
        const matches = path.startsWith("/replay/")
          ? replayRoot
            ? replay
            : editor
          : path === "/record"
            ? editor
            : path === "/"
              ? document.body?.textContent?.includes(title)
              : false;
        if (matches)
          requestAnimationFrame(() => {
            if (result.readyMs === null) {
              result.readyMs = performance.now();
              result.readyDefinition = path.startsWith("/replay/")
                ? replay
                  ? "replay-ready+following-RAF"
                  : "baseline-Monaco-view-lines+following-RAF"
                : path === "/record"
                  ? "Monaco-view-lines+following-RAF"
                  : "seeded-recording-card+following-RAF";
            }
          });
      };
      const observer = new MutationObserver(ready);
      observer.observe(document, {
        childList: true,
        subtree: true,
        attributes: true,
      });
      document.addEventListener("DOMContentLoaded", ready, { once: true });
      window.__codeTapePerf = {
        startRaf() {
          result.rafIntervals = [];
          result.rafActive = true;
          let previous = null;
          const frame = (time) => {
            if (!result.rafActive) return;
            if (previous !== null) result.rafIntervals.push(time - previous);
            previous = time;
            requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        },
        stopRaf() {
          result.rafActive = false;
          return result.rafIntervals;
        },
        read() {
          acceptLcp(lcpObserver.takeRecords());
          acceptTasks(taskObserver.takeRecords());
          const navigation = performance.getEntriesByType("navigation")[0];
          return {
            lcp: result.lcp,
            readyMs: result.readyMs,
            readyDefinition: result.readyDefinition,
            longTasks: result.longTasks,
            mediaEvents: result.mediaEvents,
            firstTimelineRowsMs: result.firstTimelineRowsMs,
            firstTimelineRowsRafMs: result.firstTimelineRowsRafMs,
            documentTiming: navigation ? { type: navigation.type, timeOrigin: performance.timeOrigin, domContentLoadedMs: navigation.domContentLoadedEventEnd, loadMs: navigation.loadEventEnd, transferSize: navigation.transferSize, encodedBodySize: navigation.encodedBodySize, decodedBodySize: navigation.decodedBodySize } : null,
            resources: performance
              .getEntriesByType("resource")
              .map((entry) => ({
                name: entry.name,
                initiatorType: entry.initiatorType,
                startTime: entry.startTime,
                duration: entry.duration,
                transferSize: entry.transferSize,
                encodedBodySize: entry.encodedBodySize,
                decodedBodySize: entry.decodedBodySize,
              })),
          };
        },
      };
    },
    { title: pkg.meta.title },
  );
  const page = await context.newPage();
  await page.bringToFront();
  page.setDefaultTimeout(30000);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
  await cdp.send("Network.setBlockedURLs", { urls: blockedURLs });
  await cdp.send("Emulation.setCPUThrottlingRate", {
    rate: profile === "limited" ? 4 : 1,
  });
  if (profile === "limited")
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 100,
      downloadThroughput: 1250000,
      uploadThroughput: 1250000,
    });
  await page.goto(`${origin}/_perf/blank`);
  await page.evaluate(async ({ pkg, mediaBase64 }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("code-tape", 2);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("recordings", {
          keyPath: "id",
        });
        store.createIndex("status", "manifest.status");
        store.createIndex("createdAtMs", "createdAtMs");
        request.result.createObjectStore("blobs");
        request.result.createObjectStore("thumbnails");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["recordings", "blobs"], "readwrite");
      tx.objectStore("recordings").put({
        id: pkg.meta.id,
        manifest: pkg.manifest,
        meta: pkg.meta,
        events: pkg.events,
        snapshots: pkg.snapshots,
        indexes: pkg.indexes,
        media: pkg.media,
        blobId: pkg.media?.blobId ?? null,
        thumbnailBlobId: null,
        createdAtMs: Date.parse(pkg.meta.createdAt),
      });
      if (mediaBase64) tx.objectStore("blobs").put({ dataBase64: mediaBase64, mimeType: pkg.media.mimeType }, pkg.media.blobId);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, { pkg, mediaBase64: mediaBytes?.toString("base64") ?? null });
  return { context, page };
}

async function timelineExperiment(
  page,
  version,
  profile,
  mode,
  fixture,
  count,
) {
  const url = `${version.origin}/replay/${fixture.pkg.meta.id}${mode === "full" ? "?benchmark=full" : ""}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page
    .locator('[data-testid="replay-ready"][data-ready="true"]')
    .waitFor();
  const viewport = page.getByTestId("event-timeline-viewport");
  await viewport.waitFor();
  const started = await page.evaluate(() => performance.now());
  await page.getByLabel("事件筛选").selectOption("all");
  await page.waitForFunction(
    ({ mode, count }) => {
      const rows = document.querySelectorAll(
        '[data-testid="event-timeline-row"]',
      );
      return mode === "full"
        ? rows.length === count
        : rows.length > 0 && rows.length < count;
    },
    { mode, count: fixture.pkg.events.length },
  );
  await twoFrames(page);
  const mounted = await viewport.evaluate((element) => ({
    height: element.clientHeight,
    rows: element.querySelectorAll('[data-testid="event-timeline-row"]').length,
    now: performance.now(),
  }));
  const rowBound = Math.ceil(mounted.height / 48) + 12;
  if (mode === "virtual" && mounted.rows > rowBound)
    throw new Error(
      `Virtual DOM row budget exceeded: ${mounted.rows}/${rowBound}`,
    );
  const scrollStart = await page.evaluate(() => {
    window.__codeTapePerf.startRaf();
    return performance.now();
  });
  const scrollTrace = [];
  for (const target of seededTargets(fixture.pkg.events.length * 48, 50)) {
    await viewport.evaluate((element, top) => {
      element.scrollTop = top;
    }, target);
    await twoFrames(page);
    const row = await viewport.evaluate((element) => ({
      at: performance.now(),
      scrollTop: element.scrollTop,
      rows: element.querySelectorAll('[data-testid="event-timeline-row"]')
        .length,
    }));
    if (mode === "virtual" && row.rows > rowBound)
      throw new Error("DOM row count grew during scroll");
    scrollTrace.push(row);
  }
  const rafIntervals = await page.evaluate(() =>
    window.__codeTapePerf.stopRaf(),
  );
  const stable = fixture.pkg.events.filter((event) =>
    STABLE_EVENT_TYPES.has(event.type),
  );
  const indexes = seededTargets(fixture.pkg.events.length - 1, count + 10).map(
    (value) => Math.max(0, Math.min(fixture.pkg.events.length - 1, value)),
  );
  const seeks = [];
  for (const [sample, index] of indexes.entries()) {
    const targetMs = fixture.pkg.events[index].timestampMs;
    const state = rebuildAtTime(
      fixture.pkg,
      fixture.initialState,
      targetMs,
      true,
      stable,
    ).state;
    let activeIndex = index;
    while (
      activeIndex + 1 < fixture.pkg.events.length &&
      fixture.pkg.events[activeIndex + 1].timestampMs <= targetMs
    )
      activeIndex++;
    await viewport.evaluate((element, index) => {
      element.scrollTop = Math.max(0, index * 48 - element.clientHeight / 2);
    }, index);
    const button = page.locator(`[data-timeline-index="${index}"]`);
    await button.waitFor();
    const seekStarted = await button.evaluate((element) => {
      const time = performance.now();
      element.click();
      return time;
    });
    const firstLine = state.editor.code.split("\n")[0];
    await page.waitForFunction(
      ({ activeIndex, firstLine }) => {
        const current = document.querySelector(
          `[data-timeline-index="${activeIndex}"][aria-current="true"]`,
        );
        const text = document
          .querySelector("[data-code-editor] .view-lines .view-line")
          ?.textContent?.replace(/\u00a0/g, " ")
          .replace(/\u200b/g, "")
          .trim();
        return current && text === firstLine;
      },
      { activeIndex, firstLine },
    );
    await twoFrames(page);
    const codeVisibleMs = await page.evaluate(
      (start) => performance.now() - start,
      seekStarted,
    );
    const display = await viewport.evaluate((element) => ({
      mountedRows: element.querySelectorAll(
        '[data-testid="event-timeline-row"]',
      ).length,
      height: element.clientHeight,
    }));
    if (
      mode === "virtual" &&
      display.mountedRows > Math.ceil(display.height / 48) + 12
    )
      throw new Error(
        "DOM row budget exceeded after Seek changed the detail panel",
      );
    if (sample >= 10)
      seeks.push({
        sample: sample - 10,
        index,
        targetMs,
        activeIndex,
        codeVisibleMs,
        expectedReplayStateSha256: sha256(canonicalStringify(state)),
        checkedFirstLine: firstLine,
        ...display,
      });
  }
  const collected = await page.evaluate(() => window.__codeTapePerf.read());
  return {
    version: version.label,
    profile,
    mode,
    eventCount: fixture.pkg.events.length,
    datasetHash: fixture.stats.datasetHash,
    mountedRows: mounted.rows,
    viewportHeight: mounted.height,
    rowBound,
    filterSettledMs: mounted.now - started,
    filterSettledDefinition: "all-event filter change → expected DOM row count → two RAF opportunities; not initial list mount cost",
    firstTimelineRowsMs: collected.firstTimelineRowsMs,
    firstTimelineRowsRafMs: collected.firstTimelineRowsRafMs,
    firstTimelineRowsDefinition: "hard navigation time origin → first attached timeline row → first following RAF opportunity; includes data/network/bootstrap",
    scrollTrace,
    rafIntervals,
    rafIntervalSummary: summarize(rafIntervals),
    longTasks: collected.longTasks.filter(
      (entry) => entry.startTime >= scrollStart,
    ),
    seekDefinition:
      "React timeline DOM click → correct active time row + correct visible source first line → two RAF opportunities; includes browser scheduling and model/render path, not a pure reducer time",
    seeks,
    seekLatency: summarize(seeks.map((row) => row.codeVisibleMs)),
  };
}
async function mediaSeekExperiment(page, version, profile, fixture, count) {
  await page.goto(`${version.origin}/replay/${fixture.pkg.meta.id}`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="replay-ready"][data-ready="true"]').waitFor();
  await page.waitForFunction(() => { const video = document.querySelector('video[aria-label^="录制"]'); return video && video.readyState >= 2; });
  const readVideo = () => page.evaluate(() => {
    const video = document.querySelector('video[aria-label^="录制"]');
    const finite = (value) => Number.isFinite(value) ? value : String(value);
    const ranges = (value) => Array.from({ length: value.length }, (_, index) => [finite(value.start(index)), finite(value.end(index))]);
    return video ? { currentTimeSec: video.currentTime, durationSec: finite(video.duration), seeking: video.seeking, readyState: video.readyState, error: video.error ? { code: video.error.code, message: video.error.message } : null, buffered: ranges(video.buffered), seekable: ranges(video.seekable), videoWidth: video.videoWidth, videoHeight: video.videoHeight } : null;
  });
  await page.evaluate(() => { const video = document.querySelector('video[aria-label^="录制"]'); if (video) video.muted = true; });
  const initialDecoderState = await readVideo();
  const control = page.locator("[data-replay-progress-control]");
  const slider = page.locator('[role="slider"][aria-label="播放进度"]');
  const stable = fixture.pkg.events.filter((event) => STABLE_EVENT_TYPES.has(event.type));
  const samples = [];
  for (const [sample, target] of seededTargets(fixture.pkg.meta.durationMs, count + 10).entries()) {
    const requestedPercent = Math.max(2, Math.min(98, target / fixture.pkg.meta.durationMs * 100));
    const row = { sample: sample - 10, warmup: sample < 10, requestedPercent, durationBasis: "recording-clock/package metadata; decoder duration separately observed" };
    const start = await page.evaluate(() => performance.now());
    try {
      const box = await control.boundingBox(); if (!box) throw new Error("Media progress control is not visible");
      await page.mouse.click(box.x + box.width * requestedPercent / 100, box.y + box.height / 2);
      await page.waitForFunction((percent) => Math.abs(Number(document.querySelector('[role="slider"][aria-label="播放进度"]')?.getAttribute("aria-valuenow")) - percent) < .3, requestedPercent, { timeout: 5000 });
      row.acceptedPercent = Number(await slider.getAttribute("aria-valuenow"));
      row.targetMs = row.acceptedPercent / 100 * fixture.pkg.meta.durationMs;
      const expectedMediaTimeSec = (row.targetMs - fixture.pkg.media.timelineOffsetMs) / 1000;
      const state = rebuildAtTime(fixture.pkg, fixture.initialState, row.targetMs, true, stable).state;
      const firstLine = state.editor.code.split("\n")[0];
      await page.waitForFunction(({ expectedMediaTimeSec, firstLine }) => {
        const video = document.querySelector('video[aria-label^="录制"]');
        const text = document.querySelector("[data-code-editor] .view-lines .view-line")?.textContent?.replace(/\u00a0/g, " ").replace(/\u200b/g, "").trim();
        return video && !video.seeking && Math.abs(video.currentTime - expectedMediaTimeSec) < .05 && text === firstLine;
      }, { expectedMediaTimeSec, firstLine }, { timeout: 5000 });
      await twoFrames(page);
      Object.assign(row, { ok: true, codeAndMediaVisibleMs: await page.evaluate((start) => performance.now() - start, start), expectedMediaTimeSec, checkedFirstLine: firstLine });
    } catch (error) { Object.assign(row, { ok: false, elapsedMs: await page.evaluate((start) => performance.now() - start, start), error: String(error) }); }
    row.decoder = await readVideo();
    row.nativeEvents = (await page.evaluate(() => window.__codeTapePerf.read().mediaEvents)).filter((entry) => entry.at >= start);
    samples.push(row);
  }
  const measured = samples.filter((row) => !row.warmup);
  return { profile, version: version.label, datasetHash: fixture.datasetHash, rawMediaSha256: fixture.mediaRawSha256, recordingDurationMs: fixture.pkg.meta.durationMs, mediaMetadata: fixture.pkg.media, initialDecoderState, finalDecoderState: await readVideo(), source: "synthetic fake devices; no personal audio/video or ASR quality claim", seekDefinition: "real slider pointer click → native media non-seeking at accepted target + expected visible code first line → two RAF opportunities", samples, latency: summarize(measured.filter((row) => row.ok).map((row) => row.codeAndMediaVisibleMs)), failures: measured.filter((row) => !row.ok).length };
}

function twoFrames(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}
