import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";

// Manual, opt-in smoke. No production profiles, physical devices or paid APIs.
const option = (name, fallback) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const root = resolve(option("root", process.cwd()));
const out = resolve(option("out", "artifacts/perf/browser-model-smoke.json"));
await mkdir(dirname(out), { recursive: true });
const mediaPath = resolve(root, "docs/performance/2026-10-07/media-fixture/media.webm");
const metadataPath = resolve(root, "docs/performance/2026-10-07/media-fixture/metadata.json");
const require = createRequire(resolve(root, "package.json"));
const { chromium } = require("playwright");
const perFlowTimeoutMs = 60_000;
const report = {
  experiment: "isolated-browser-real-model-smoke",
  startedAt: new Date().toISOString(),
  node: process.version,
  root,
  privacy: { physicalDevicesUsed: false, userProfileUsed: false, paidApiUsed: false, offOriginRequestsBlocked: true },
  method: "Vite source modules; unchanged real model loaders; ASR WASM fp32 and production LLM Worker WASM q8; no accuracy claim",
  flows: [],
};
let devProcess;
let browser;
let devLog = "";
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  interrupted = true;
  void browser?.close();
  stopDev();
});

try {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Use the isolated bundled Node24 runtime");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  if (metadata.privacy?.physicalMicrophoneOrCameraUsed !== false || metadata.integrityValidated !== true) throw new Error("Synthetic fixture provenance is not verified");
  const media = await readFile(mediaPath);
  const digest = createHash("sha256").update(media).digest("hex");
  if (digest !== metadata.mediaSha256RawBytes) throw new Error("Synthetic WebM byte hash mismatch");
  report.fixture = { bytes: media.length, sha256: digest, clockDurationMs: metadata.mediaDurationMs, note: "Synthetic fake-device sound, not a speech accuracy fixture" };
  const port = await unusedPort();
  const origin = `http://127.0.0.1:${port}`;
  report.origin = origin;
  devProcess = spawn(option("npm-bin", "npm"), ["run", "dev", "--", "--port", String(port), "--strictPort"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, GITHUB_PAGES: "false", VITE_HF_REMOTE_HOST: "", VITE_SUBTITLE_POSTPROCESSOR_MODEL: "", VITE_CODE_TAPE_DEBUG_ENABLED: "false" },
  });
  for (const stream of [devProcess.stdout, devProcess.stderr]) stream.on("data", (chunk) => { devLog = (devLog + chunk).slice(-6000); });
  await waitForDev(origin);
  browser = await chromium.launch({ headless: true, channel: "chromium", timeout: 15_000, ...(process.env.CODE_TAPE_CHROME_PATH ? { executablePath: process.env.CODE_TAPE_CHROME_PATH } : {}) });
  report.browser = browser.version();
  for (const kind of ["asr", "llm"]) {
    if (interrupted) throw new Error("Smoke interrupted");
    const flow = await runFlow(kind, origin, { mediaBase64: media.toString("base64"), mimeType: metadata.mediaMimeType, durationMs: metadata.mediaDurationMs });
    report.flows.push(flow);
    console.log(JSON.stringify({ kind, outcome: flow.outcome, lastPhase: flow.lastPhase, durationMs: flow.durationMs, stages: flow.stages }));
  }
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  report.devLog = devLog;
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  stopDev();
  if (devProcess && devProcess.exitCode === null && devProcess.signalCode === null) {
    await Promise.race([new Promise((done) => devProcess.once("exit", done)), new Promise((done) => setTimeout(done, 3000))]);
    if (devProcess.exitCode === null && devProcess.signalCode === null) stopDev("SIGKILL");
  }
  report.completedAt = new Date().toISOString();
  report.ok = !report.error && report.flows.length === 2 && report.flows.every((flow) => flow.outcome === "completed");
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`Real browser smoke result: ${out}; ok=${report.ok}`);
  if (!report.ok) process.exitCode = 1;
}

async function runFlow(kind, origin, fixture) {
  const started = performance.now();
  const flow = { kind, outcome: "failed", lastPhase: "context", stages: [], resources: [], blockedRequests: [], errors: [], deadlineMs: perFlowTimeoutMs };
  const context = await browser.newContext({ permissions: [], serviceWorkers: "block" });
  const requestStage = new WeakMap();
  context.on("request", (request) => requestStage.set(request, flow.lastPhase));
  context.on("response", (response) => {
    const url = new URL(response.url());
    if (/\/(models|ort)\//u.test(url.pathname)) flow.resources.push({ phase: requestStage.get(response.request()), path: url.pathname, status: response.status(), fromServiceWorker: response.fromServiceWorker() });
  });
  context.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (/\/(models|ort)\//u.test(url.pathname)) flow.resources.push({ phase: requestStage.get(request), path: url.pathname, failed: request.failure()?.errorText ?? "unknown" });
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin && !["blob:", "data:"].includes(url.protocol)) {
      flow.blockedRequests.push({ host: url.hostname, path: url.pathname });
      await route.abort();
    } else if (url.pathname === "/__codetape_model_smoke__") {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><meta charset=utf-8><title>Isolated real model smoke</title>" });
    } else await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => flow.errors.push(error.message));
  await page.exposeFunction("reportModelSmokeStage", (stage) => {
    if (stage.state) flow.lastPhase = stage.phase;
    flow.stages.push({ ...stage, elapsedMs: Math.round(performance.now() - started), modelAssetResponses: flow.resources.length });
    console.log(JSON.stringify({ kind, ...stage }));
  });
  let timer;
  try {
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Real ${kind} flow exceeded ${perFlowTimeoutMs}ms`)), Math.max(1, perFlowTimeoutMs - (performance.now() - started))); });
    const operation = (async () => {
      await page.goto(`${origin}/__codetape_model_smoke__`, { waitUntil: "domcontentloaded", timeout: 10_000 });
      return page.evaluate(async ({ kind, fixture }) => {
        const stages = [];
        const timed = async (phase, action) => {
          await globalThis.reportModelSmokeStage({ phase, state: "started" });
          const started = performance.now();
          try {
            const value = await action();
            const stage = { phase, state: "completed", durationMs: Math.round(performance.now() - started) };
            stages.push(stage);
            await globalThis.reportModelSmokeStage(stage);
            return value;
          } catch (error) {
            await globalThis.reportModelSmokeStage({ phase, state: "failed", durationMs: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) });
            throw error;
          }
        };
        const controller = new AbortController();
        let processor;
        try {
          processor = await timed("import", async () => {
            if (kind === "asr") {
              const module = await import("/src/features/subtitles/subtitleTranscriber.ts");
              return module.createHuggingFaceSubtitleTranscriber();
            }
            const module = await import("/src/features/subtitles/subtitlePostProcessorWorkerClient.ts");
            return module.createWorkerBackedHuggingFaceSubtitlePostProcessor({ onMetric: (metric) => { void globalThis.reportModelSmokeStage({ ...metric, phase: "worker-metric", workerPhase: metric.phase }); } });
          });
          await timed("cold-warmup", () => processor.warmUp());
          await timed("reuse-warmup", () => processor.warmUp());
          const result = await timed("inference", async () => {
            if (kind === "asr") {
              const mediaBlob = new Blob([Uint8Array.from(atob(fixture.mediaBase64), (value) => value.charCodeAt(0))], { type: fixture.mimeType });
              const draft = await processor.transcribe({ mediaBlob, durationMs: fixture.durationMs, signal: controller.signal });
              const valid = draft.segments.every((segment) => Number.isFinite(segment.startMs) && Number.isFinite(segment.endMs) && segment.startMs >= 0 && segment.endMs > segment.startMs && segment.endMs <= fixture.durationMs && typeof segment.text === "string" && segment.text.trim());
              if (!valid) throw new Error("ASR produced invalid normalized timestamp contract");
              return { model: draft.model, source: draft.source, segmentCount: draft.segments.length, emptyText: draft.segments.length === 0, timestampContractValid: true };
            }
            const track = { recordingId: "browser-smoke", generatedAt: new Date().toISOString(), model: "synthetic-asr-input", source: "huggingface-local", language: "zh", segments: [{ id: "subtitle-1", startMs: 0, endMs: 2000, text: "这里用 use state 保存 count" }] };
            const result = await processor.process({ track, context: { language: "typescript", fileName: "Counter.tsx", code: "const [count, setCount] = useState(0);", glossary: ["React", "useState", "setCount"] }, strictValidation: true, signal: controller.signal });
            return { segmentCount: result.segments.length, chapterCount: result.chapters?.length ?? 0, warningCount: result.validationWarnings?.length ?? 0, acceptedByProductionValidator: true, correctionResult: result };
          });
          return { stages, result };
        } finally {
          controller.abort();
          processor?.dispose?.();
        }
      }, { kind, fixture });
    })();
    const result = await Promise.race([operation, deadline]);
    flow.outcome = "completed";
    flow.result = result.result;
    flow.reuse = { noModelFetchAfterColdWarmup: !flow.resources.some((resource) => resource.phase === "reuse-warmup" || resource.phase === "inference"), note: "Same recognizer/worker object reused; real model source, no injected factories" };
  } catch (error) {
    flow.outcome = /exceeded 60000ms/u.test(String(error)) ? "timeout" : "failed";
    flow.error = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
    await context.close();
    flow.durationMs = Math.round(performance.now() - started);
  }
  return flow;
}

async function unusedPort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function waitForDev(origin) {
  const started = performance.now();
  while (performance.now() - started < 25_000) {
    if (interrupted || devProcess.exitCode !== null) throw new Error("Private Vite dev server exited");
    try { if ((await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error("Private Vite dev server readiness timed out");
}

function stopDev(signal = "SIGTERM") {
  if (devProcess?.pid && devProcess.exitCode === null && devProcess.signalCode === null) {
    try { process.kill(-devProcess.pid, signal); } catch {}
  }
}
