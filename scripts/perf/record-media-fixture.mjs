import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { verifyRecordingPackageIntegrity } from "../../packages/recording-schema/dist/index.js";

const option = (name, fallback) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
const root = resolve(
  option("web-root", "apps/web/dist"),
);
const output = resolve(option("out", "artifacts/perf/media-fixture"));
const port = Number(option("port", "4603"));
const durationMs = Number(option("duration-ms", "6000"));
if (
  !Number.isSafeInteger(durationMs) ||
  durationMs < 4000 ||
  durationMs > 15000
)
  throw new Error(
    "duration-ms must be 4000–15000; this fixture only records a short synthetic sample",
  );
const origin = `http://127.0.0.1:${port}`;
const flags = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const modelRequests = [];
const startedAt = new Date().toISOString();
const server = createServer((request, response) => {
  void staticResponse(request, response).catch(() => {
    response.writeHead(500);
    response.end("fixture server failed");
  });
});
let browser;
let context;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  browser = await chromium.launch({
    headless: true,
    args: flags,
    ...(process.env.CODE_TAPE_CHROME_PATH
      ? { executablePath: process.env.CODE_TAPE_CHROME_PATH }
      : {}),
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    permissions: ["camera", "microphone"],
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (
      url.pathname.includes("/models/") ||
      /(^|\.)(huggingface\.co|hf\.co)$/u.test(url.hostname) ||
      url.hostname.startsWith("cdn-lfs")
    ) {
      modelRequests.push(`${url.origin}${url.pathname}`);
      await route.abort();
    } else await route.continue();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/record`, { waitUntil: "domcontentloaded" });
  await page
    .locator("[data-code-editor] .monaco-editor")
    .waitFor({ timeout: 30000 });
  const modifier = await page.evaluate(() =>
    navigator.userAgent.includes("Macintosh") ? "Meta" : "Control",
  );
  await setSource(page, modifier, 0);
  await page.getByRole("button", { name: "申请设备权限", exact: true }).click();
  const fakeDevices = await page.evaluate(async () =>
    (await navigator.mediaDevices.enumerateDevices())
      .filter(
        (device) =>
          device.kind === "audioinput" || device.kind === "videoinput",
      )
      .map((device) => ({
        kind: device.kind,
        deviceId: device.deviceId,
        label: device.label,
      })),
  );
  const audio = fakeDevices.find((device) => device.kind === "audioinput");
  const camera = fakeDevices.find((device) => device.kind === "videoinput");
  if (
    !audio ||
    !camera ||
    !fakeDevices.every((device) => /fake/iu.test(device.label))
  )
    throw new Error(
      `Expected only synthetic fake input devices; kinds/labels=${JSON.stringify(fakeDevices.map(({ kind, label }) => ({ kind, label })))}`,
    );
  await page
    .getByLabel("麦克风设备", { exact: true })
    .selectOption(audio.deviceId);
  await page
    .getByLabel("摄像头设备", { exact: true })
    .selectOption(camera.deviceId);
  await page.getByRole("button", { name: "开始录制", exact: true }).click();
  await page.getByLabel("录制状态：录制中").waitFor({ timeout: 30000 });
  const recordingStarted = Date.now();
  for (let step = 1; step <= 3; step++) {
    await page.waitForTimeout(
      Math.max(0, recordingStarted + (durationMs * step) / 4 - Date.now()),
    );
    await setSource(page, modifier, step);
    await page.getByRole("button", { name: "运行代码", exact: true }).click();
    await page
      .frameLocator('iframe[title="code-tape preview"]')
      .locator("body")
      .getByText(`synthetic-media-${step}`, { exact: true })
      .waitFor();
  }
  await page.waitForTimeout(
    Math.max(0, recordingStarted + durationMs - Date.now()),
  );
  await page.getByRole("button", { name: "停止录制", exact: true }).click();
  await page.waitForURL(/\/replay\/[^/]+$/u, { timeout: 30000 });
  await page
    .locator('[data-testid="replay-ready"][data-ready="true"]')
    .waitFor({ timeout: 30000 });
  const recordingId = decodeURIComponent(
    new URL(page.url()).pathname.split("/").at(-1),
  );
  const captured = await page.evaluate(async (id) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("code-tape");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const requestValue = (request) =>
        new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const recording = await requestValue(
        db
          .transaction("recordings", "readonly")
          .objectStore("recordings")
          .get(id),
      );
      if (!recording?.blobId || !recording.media)
        throw new Error("Real UI recording has no media blob");
      const blob = await requestValue(
        db
          .transaction("blobs", "readonly")
          .objectStore("blobs")
          .get(recording.blobId),
      );
      if (!blob?.dataBase64)
        throw new Error("Stored media is not available as dataBase64");
      const video = document.querySelector(
        "video[aria-label='录制摄像头视频']",
      );
      return {
        pkg: {
          schemaVersion: recording.manifest.schemaVersion,
          manifest: recording.manifest,
          meta: recording.meta,
          events: recording.events,
          snapshots: recording.snapshots,
          indexes: recording.indexes,
          media: recording.media,
        },
        blob,
        observedVideoDurationSeconds:
          video && Number.isFinite(video.duration) ? video.duration : null,
      };
    } finally {
      db.close();
    }
  }, recordingId);
  const media = Buffer.from(captured.blob.dataBase64, "base64");
  if (
    media.length === 0 ||
    media.readUInt32BE(0) !== 0x1a45dfa3 ||
    !captured.pkg.media.hasAudio ||
    !captured.pkg.media.hasCamera
  )
    throw new Error(
      "Expected a nonempty native WebM with synthetic audio and video",
    );
  const integrity = await verifyRecordingPackageIntegrity(
    captured.pkg,
    new Blob([media], { type: captured.blob.mimeType }),
  );
  if (!integrity.ok)
    throw new Error(
      `Native package integrity validation failed: ${JSON.stringify(integrity.error)}`,
    );
  const recordingBytes = Buffer.from(JSON.stringify(captured.pkg, null, 2));
  const metadata = {
    experiment: "real-ui-synthetic-media-fixture",
    startedAt,
    completedAt: new Date().toISOString(),
    method:
      "Production CodeTape UI + native getUserMedia/MediaRecorder; Chromium synthetic default devices only; read-only IndexedDB extraction; no human media or ASR inference",
    privacy: {
      isolatedTemporaryBrowserProfile: true,
      realUserProfileUsed: false,
      physicalMicrophoneOrCameraUsed: false,
      syntheticDeviceFlags: flags,
    },
    environment: {
      node: process.version,
      browser: browser.version(),
      webRoot: root,
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    },
    buildIndexSha256: sha256(await readFile(resolve(root, "index.html"))),
    requestedRecordingDurationMs: durationMs,
    recordingDurationMs: captured.pkg.meta.durationMs,
    mediaDurationMs: captured.pkg.media.durationMs,
    timelineOffsetMs: captured.pkg.media.timelineOffsetMs,
    observedVideoDurationSeconds: captured.observedVideoDurationSeconds,
    note: "A null native video duration is reported honestly; MediaRecorder WebM may lack an intrinsic duration before playback. Package duration comes from the actual recording clock.",
    recordingId,
    eventCount: captured.pkg.events.length,
    snapshotCount: captured.pkg.snapshots.length,
    mediaMimeType: captured.blob.mimeType,
    mediaBytes: media.length,
    mediaSha256RawBytes: sha256(media),
    mediaChecksumFromOriginalManifest:
      captured.pkg.manifest.checksums.mediaSha256,
    recordingJsonSha256: sha256(recordingBytes),
    integrityValidated: true,
    syntheticDevices: fakeDevices.map(({ kind, label }) => ({ kind, label })),
    blockedModelRequests: modelRequests,
    pageErrors: errors,
    files: {
      recording: resolve(output, "recording.json"),
      media: resolve(output, "media.webm"),
    },
  };
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, "recording.json"), recordingBytes);
  await writeFile(resolve(output, "media.webm"), media);
  await writeFile(
    resolve(output, "metadata.json"),
    JSON.stringify(metadata, null, 2),
  );
  console.log(
    JSON.stringify({
      output,
      recordingId,
      recordingDurationMs: metadata.recordingDurationMs,
      mediaDurationMs: metadata.mediaDurationMs,
      mediaBytes: media.length,
      integrityValidated: true,
    }),
  );
} finally {
  await context?.close();
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

async function setSource(page, modifier, step) {
  await page.locator("[data-code-editor] .monaco-editor").click();
  await page.keyboard.press(`${modifier}+A`);
  await page.keyboard.insertText(
    `document.body.textContent = "synthetic-media-${step}";\nconsole.log("synthetic-step-${step}");\n`,
  );
}
async function staticResponse(request, response) {
  const url = new URL(request.url ?? "/", origin);
  if (url.pathname.startsWith("/api/")) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: { code: "unauthorized", message: "local fixture recording" },
      }),
    );
    return;
  }
  let path;
  try {
    path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }
  if (!path.startsWith(`${root}${sep}`) && path !== root) {
    response.writeHead(403);
    response.end();
    return;
  }
  const file = await stat(path).catch(() => null);
  if (!file?.isFile())
    path = extname(path) ? null : resolve(root, "index.html");
  if (!path) {
    response.writeHead(404);
    response.end();
    return;
  }
  const body = await readFile(path);
  const mime =
    {
      ".html": "text/html",
      ".js": "text/javascript",
      ".mjs": "text/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".wasm": "application/wasm",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".webp": "image/webp",
      ".woff2": "font/woff2",
    }[extname(path)] ?? "application/octet-stream";
  response.writeHead(200, {
    "content-type": mime,
    "cache-control": "no-store",
  });
  response.end(body);
}
