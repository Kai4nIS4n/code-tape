import { expect, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import type * as Monaco from "monaco-editor";

const API = `http://127.0.0.1:${process.env.CODE_TAPE_E2E_API_PORT ?? "4173"}`;
const CONTROL_TOKEN = process.env.CODE_TAPE_E2E_TOKEN ?? "codetape-e2e-control";
const WEB = process.env.CODE_TAPE_E2E_WEB_ORIGIN ?? "http://127.0.0.1:5173";
let nextAccount = 0;

test("two account members merge real offline edits and preserve inactive HTML in candidate playback", async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  // Isolated Chromium profile with synthetic camera/microphone only. The
  // actual SDP, ICE and DataChannel paths remain browser-native and unmocked.
  const rtcBrowser = await browser.browserType().launch({
    channel: "chromium",
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const candidateContext = await rtcBrowser.newContext({ baseURL: WEB, permissions: ["camera", "microphone"] });
  const interviewerContext = await rtcBrowser.newContext({ baseURL: WEB, permissions: ["camera", "microphone"] });
  await captureObserverChannels(candidateContext);
  await captureObserverChannels(interviewerContext);
  const candidate = await candidateContext.newPage();
  const interviewer = await interviewerContext.newPage();
  const errors: string[] = [];
  candidate.on("pageerror", (error) => errors.push(error.message));
  interviewer.on("pageerror", (error) => errors.push(error.message));
  try {
    await register(candidate, "candidate");
    const bob = await register(interviewer, "interviewer");
    const create = candidate.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/interviews/rooms" &&
        response.request().method() === "POST",
    );
    await candidate.goto("/interview");
    await candidate.getByRole("button", { name: "发起面试", exact: true }).click();
    const created = await create;
    expect(created.status()).toBe(201);
    const room = (await created.json()) as { roomId: string; joinCode: string };
    await editorReady(candidate);
    await replaceEditor(candidate, "const sharedBase = 1;\n");
    await interviewer.goto(
      `/interview/interviewer/${room.roomId}?joinCode=${encodeURIComponent(room.joinCode)}`,
    );
    await editorReady(interviewer);
    await expect(editorLines(interviewer)).toContainText("sharedBase");
    await saved(candidate);
    await saved(interviewer);

    await control(request, "/_e2e/transport", { userId: bob.id, blocked: true });
    await expect(interviewer.locator("[data-collaboration-status]")).toHaveAttribute(
      "data-collaboration-status",
      "local-saved",
    );
    await insertAtEdge(candidate, "// Alice stayed online\n", "end");
    await insertAtEdge(interviewer, "// Bob edited offline\n", "start");
    await expect(editorLines(interviewer)).toContainText("Bob edited offline");
    await expect(interviewer.locator("[data-collaboration-status]")).toContainText("本机已保存");
    await expect(editorLines(candidate)).not.toContainText("Bob edited offline");
    await control(request, "/_e2e/transport", { userId: bob.id, blocked: false });
    await expect(editorLines(candidate)).toContainText("Bob edited offline");
    await expect(editorLines(interviewer)).toContainText("Alice stayed online");
    await saved(candidate);
    await saved(interviewer);
    // Read the actual mounted Monaco models; visible DOM is only a decorated,
    // virtualized projection. Edits above are still real user keyboard input.
    const candidateSource = await actualEditorSource(candidate);
    const interviewerSource = await actualEditorSource(interviewer);
    expect(candidateSource).toBe(interviewerSource);
    expect(candidateSource.replace(/\r\n/gu, "\n")).toBe(
      "// Bob edited offline\nconst sharedBase = 1;\n// Alice stayed online\n",
    );
    await interviewer.reload();
    await editorReady(interviewer);
    await saved(interviewer);
    await expect(editorLines(interviewer)).toContainText("Bob edited offline");
    await expect(editorLines(interviewer)).toContainText("Alice stayed online");

    await control(request, "/_e2e/restart", {});
    await saved(candidate);
    await saved(interviewer);
    await interviewer.reload();
    await editorReady(interviewer);
    await saved(interviewer);
    await expect(editorLines(interviewer)).toContainText("Bob edited offline");
    await expect(editorLines(interviewer)).toContainText("Alice stayed online");

    await candidate.reload();
    await editorReady(candidate);
    await saved(candidate);
    await expect(editorLines(candidate)).toContainText("Bob edited offline");
    const renewedInvite = candidate.waitForResponse((response) =>
      new URL(response.url()).pathname === `/api/interviews/rooms/${room.roomId}/invites` &&
      response.request().method() === "POST",
    );
    await candidate.getByRole("button", { name: "重新生成邀请", exact: true }).click();
    const renewed = await renewedInvite;
    expect(renewed.status()).toBe(201);
    const invite = await renewed.json() as { token: string };
    expect(invite.token).not.toBe(room.joinCode);
    await expect(candidate.getByText(invite.token, { exact: true })).toBeVisible();
    // Start this observer check with a fresh interviewer join after the
    // candidate reload. This is the native signaling offer trigger; Yjs reload
    // and server-restart persistence were already verified independently above.
    await interviewer.reload();
    await editorReady(interviewer);
    await saved(interviewer);

    await candidate.getByLabel("麦克风设备").selectOption("");
    await candidate.getByLabel("摄像头设备").selectOption("");
    await eventsChannelOpen(candidate);
    await eventsChannelOpen(interviewer);
    await candidate.evaluate(() => { (globalThis as ObserverCaptureWindow).__observerCapture.sent.length = 0; });
    await candidate.getByRole("button", { name: "开始录制", exact: true }).click();
    await expect(candidate.getByLabel("录制状态：录制中")).toBeVisible();
    await control(request, "/_e2e/transport", { userId: bob.id, blocked: true });
    await expect(interviewer.locator("[data-collaboration-status]")).toHaveAttribute(
      "data-collaboration-status",
      "local-saved",
    );
    await interviewer.getByLabel("协同文档").selectOption("html");
    const html = '<p id="remote-html">Interviewer changed inactive HTML</p>';
    await replaceEditor(interviewer, html);
    await expect.poll(() => actualEditorSource(interviewer, "html")).toBe(html);
    await expect.poll(() => actualEditorSource(candidate, "html")).not.toBe(html);
    const snapshotCount = (await observerMessages(candidate)).filter((message) => message.kind === "observer-snapshot").length;
    const receivedSnapshotCount = await interviewer.evaluate(() => (globalThis as ObserverCaptureWindow).__observerCapture.received.filter(
      (message) => message.kind === "observer-snapshot",
    ).length);
    await interviewer.evaluate((roomId) => {
      const channel = (globalThis as ObserverCaptureWindow).__observerCapture.channels.find(
        (channel) => channel.label === "events" && channel.readyState === "open",
      );
      if (!channel) throw new Error("Real interviewer events DataChannel is not open");
      channel.send(JSON.stringify({
        kind: "snapshot-request", roomId, sessionId: "e2e-interviewer", messageId: crypto.randomUUID(),
        sentAt: Date.now(), reason: "manual-reconnect", expectedSeq: 1, lastAppliedSeq: 0,
      }));
    }, room.roomId);
    await expect.poll(async () => (await observerMessages(candidate)).filter(
      (message) => message.kind === "observer-snapshot",
    ).length).toBeGreaterThan(snapshotCount);
    await expect.poll(() => interviewer.evaluate(() => (globalThis as ObserverCaptureWindow).__observerCapture.received.filter(
      (message) => message.kind === "observer-snapshot",
    ).length)).toBeGreaterThan(receivedSnapshotCount);
    // The observation snapshot describes the candidate's run/view state, not
    // the interviewer's unsynchronized Y.Doc. A real request must not erase it.
    await expect.poll(() => actualEditorSource(interviewer, "html")).toBe(html);
    await control(request, "/_e2e/transport", { userId: bob.id, blocked: false });
    await saved(interviewer);
    // A durable ACK does not assert that the peer has applied its inbound
    // update. Wait for the candidate's actual inactive document as well.
    await expect.poll(() => actualEditorSource(candidate, "html")).toBe(html);
    await expect(candidate.getByLabel("语言", { exact: true })).toHaveValue("javascript");
    await expect(editorLines(candidate)).not.toContainText("remote-html");
    await candidate.getByRole("button", { name: "运行代码", exact: true }).click();
    await expect(
      candidate.frameLocator('iframe[title="code-tape preview"]').locator("body"),
    ).toContainText("Interviewer changed inactive HTML");
    await expect(candidate.getByRole("button", { name: "运行代码", exact: true })).toBeEnabled();
    await expect(
      interviewer.frameLocator('iframe[title="code-tape preview"]').locator("body"),
    ).toContainText("Interviewer changed inactive HTML");
    await candidate.getByRole("button", { name: "停止录制", exact: true }).click();
    await expect(candidate).toHaveURL(/\/replay\/[^/]+$/u);
    await expect(candidate.getByRole("button", { name: "播放", exact: true })).toBeEnabled();
    const messages = await observerMessages(candidate);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((message) => message.kind === "observer-event" || message.kind === "observer-snapshot")).toBe(true);
    messages.forEach(assertNoObserverEditorBody);
    const observedEvents = messages.filter((message) => message.kind === "observer-event").map(
      (message) => message.event as { seq: number; type: string; payload: Record<string, unknown> },
    );
    expect(observedEvents.map((event) => event.seq)).toEqual(observedEvents.map((_, index) => index + 1));
    expect(observedEvents.some((event) => event.type === "document-changed" && event.payload.documentId === "source:html")).toBe(true);
    expect(observedEvents.some((event) => event.type === "run-output" && typeof event.payload.previewHtml === "string" && event.payload.previewHtml.includes("Interviewer changed inactive HTML"))).toBe(true);
    const recordingId = decodeURIComponent(new URL(candidate.url()).pathname.split("/").at(-1)!);
    const recording = await storedRecording(candidate, recordingId);
    expect(recording.manifest.schemaVersion).toBe("0.2.0");
    expect(observedEvents.map((event) => event.seq)).toEqual(recording.events.map((event) => event.seq));
    expect(
      recording.events.some(
        (event) =>
          event.type === "content-change" &&
          event.payload.documentId === "source:html" &&
          event.payload.code === html,
      ),
    ).toBe(true);
    await candidate.getByRole("slider", { name: "播放进度", exact: true }).focus();
    await candidate.keyboard.press("End");
    await expect(editorLines(candidate)).toContainText("sharedBase");
    await expect(
      candidate.frameLocator('iframe[title="code-tape preview"]').locator("body"),
    ).toContainText("Interviewer changed inactive HTML");
    expect(errors).toEqual([]);
  } finally {
    await candidateContext.close();
    await interviewerContext.close();
    await rtcBrowser.close();
  }
});

test("real cloud upload and an anonymous share reject cached asset grants after owner revocation", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const ownerContext = await browser.newContext({
    baseURL: WEB,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const viewerContext = await browser.newContext({ baseURL: WEB });
  const owner = await ownerContext.newPage();
  const viewer = await viewerContext.newPage();
  try {
    await register(owner, "owner");
    await owner.goto("/record");
    await editorReady(owner);
    await owner.getByLabel("麦克风设备").selectOption("");
    await owner.getByLabel("摄像头设备").selectOption("");
    await owner.getByRole("button", { name: "开始录制", exact: true }).click();
    await expect(owner.getByLabel("录制状态：录制中")).toBeVisible();
    await replaceEditor(
      owner,
      'document.body.textContent = "cloud-secret-content";\nconsole.log("cloud-result");',
    );
    await owner.getByRole("button", { name: "运行代码", exact: true }).click();
    await expect(
      owner.frameLocator('iframe[title="code-tape preview"]').locator("body"),
    ).toContainText("cloud-secret-content");
    await expect(owner.getByRole("region", { name: "Runtime output", exact: true })).toContainText(
      "cloud-result",
    );
    await owner.getByRole("button", { name: "停止录制", exact: true }).click();
    await expect(owner).toHaveURL(/\/replay\/[^/]+$/u);
    await owner.goto("/");
    await expect(owner.getByRole("button", { name: "上传到云端", exact: true })).toBeVisible();
    const upload = owner.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/recordings/upload-sessions" &&
        response.request().method() === "POST",
    );
    await owner.getByRole("button", { name: "上传到云端", exact: true }).click();
    expect((await upload).status()).toBe(201);
    await expect(owner.getByRole("dialog")).toContainText("已上传");
    await owner.getByRole("button", { name: "确认", exact: true }).click();
    await owner.getByRole("tab", { name: "云端录制", exact: true }).click();
    await expect(owner.getByRole("button", { name: "复制分享链接", exact: true })).toBeVisible();
    const share = owner.waitForResponse(
      (response) =>
        /\/api\/recordings\/[^/]+\/share-links$/u.test(new URL(response.url()).pathname) &&
        response.request().method() === "POST",
    );
    await owner.getByRole("button", { name: "复制分享链接", exact: true }).click();
    const shareResponse = await share;
    expect(shareResponse.status()).toBe(201);
    const { url } = (await shareResponse.json()) as { url: string };
    await expect(owner.getByRole("dialog")).toContainText("分享链接已复制");
    await owner.getByRole("button", { name: "确认", exact: true }).click();
    const descriptorResponse = viewer.waitForResponse((response) =>
      /\/api\/share\/[^/]+\/playback$/u.test(new URL(response.url()).pathname),
    );
    await viewer.goto(new URL(url, WEB).href);
    await expect(viewer.getByRole("button", { name: "播放", exact: true })).toBeEnabled();
    const descriptor = (await (await descriptorResponse).json()) as {
      eventsUrl: string;
      mediaUrl: string | null;
      thumbnailUrl: string | null;
    };
    const assetUrl = new URL(descriptor.mediaUrl ?? descriptor.eventsUrl, WEB).href;
    const permitted = await viewerContext.request.get(assetUrl, {
      headers: { range: "bytes=0-20" },
    });
    expect(permitted.status()).toBe(206);
    await owner.getByRole("button", { name: "管理分享", exact: true }).click();
    const manager = owner.getByRole("dialog", { name: "管理分享", exact: true });
    const revoked = owner.waitForResponse(
      (response) =>
        /\/api\/recordings\/[^/]+\/share-links\/[^/]+$/u.test(new URL(response.url()).pathname) &&
        response.request().method() === "DELETE",
    );
    await manager.getByRole("button", { name: "撤销", exact: true }).click();
    expect((await revoked).status()).toBe(200);
    await expect(manager).toContainText("已撤销");
    expect(
      (await viewerContext.request.get(assetUrl, { headers: { range: "bytes=0-20" } })).status(),
    ).toBe(403);
    expect((await viewerContext.request.head(assetUrl)).status()).toBe(403);
    if (descriptor.thumbnailUrl)
      expect(
        (await viewerContext.request.get(new URL(descriptor.thumbnailUrl, WEB).href)).status(),
      ).toBe(403);
    await viewer.reload();
    await expect(
      viewer.getByText(/分享链接不可用|分享链接.*失效|share link not found/u),
    ).toBeVisible();
  } finally {
    await ownerContext.close();
    await viewerContext.close();
  }
});

async function register(page: Page, prefix: string): Promise<{ id: string }> {
  const username = `${prefix}_${Date.now().toString(36)}_${++nextAccount}`;
  await page.goto("/login");
  await page.getByRole("button", { name: "没有账号？创建账号", exact: true }).click();
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("显示名称", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill("codetape-e2e-password");
  const registration = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/auth/register",
  );
  await page.getByRole("button", { name: "注册并登录", exact: true }).click();
  const response = await registration;
  expect(response.status()).toBe(201);
  const result = (await response.json()) as { user: { id: string } };
  await expect(page).toHaveURL(`${WEB}/`);
  return result.user;
}
async function editorReady(page: Page) {
  await expect(
    page.locator('[data-code-editor][data-editor-ready="true"] .monaco-editor'),
  ).toBeVisible({ timeout: 30_000 });
}
function editorLines(page: Page) {
  return page.locator("[data-code-editor] .view-lines");
}
async function replaceEditor(page: Page, source: string) {
  await page.locator("[data-code-editor] .monaco-editor").click();
  await page.keyboard.press(`${await editorModifier(page)}+A`);
  await page.keyboard.insertText(source);
  await expect(editorLines(page)).toContainText(source.split("\n")[0]);
}
async function insertAtEdge(page: Page, source: string, edge: "start" | "end") {
  await page.bringToFront();
  await page.locator("[data-code-editor] .monaco-editor").click();
  await page.keyboard.press(`${await editorModifier(page)}+A`);
  await page.keyboard.press(edge === "start" ? "ArrowLeft" : "ArrowRight");
  await page.keyboard.insertText(source);
}
async function saved(page: Page) {
  await expect(page.locator("[data-collaboration-status]")).toHaveAttribute(
    "data-collaboration-status",
    "server-saved",
    { timeout: 30_000 },
  );
}
async function actualEditorSource(page: Page, language?: string): Promise<string> {
  return page.evaluate(async (requestedLanguage) => {
    const moduleUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => /monaco-editor_esm_vs_editor_editor__api\.js/u.test(name));
    if (!moduleUrl) throw new Error("Mounted Monaco API module was not loaded");
    const monaco = (await import(moduleUrl)) as typeof Monaco;
    const host = document.querySelector("[data-code-editor]");
    const editor = monaco.editor.getEditors().find((editor) => {
      const node = editor.getDomNode();
      return node && host?.contains(node);
    });
    if (!editor) throw new Error("Could not read the mounted editor model");
    if (requestedLanguage) {
      const model = monaco.editor
        .getModels()
        .find((model) => model.getLanguageId() === requestedLanguage);
      if (!model) throw new Error("Could not read the inactive document model");
      return model.getValue();
    }
    return editor.getValue();
  }, language);
}
async function editorModifier(page: Page): Promise<"Meta" | "Control"> {
  return page.evaluate(() => (navigator.userAgent.includes("Macintosh") ? "Meta" : "Control"));
}
async function control(request: APIRequestContext, path: string, body: unknown) {
  const response = await request.post(`${API}${path}`, {
    headers: { "x-e2e-token": CONTROL_TOKEN },
    data: body,
  });
  expect(response.status()).toBe(200);
}
async function storedRecording(
  page: Page,
  id: string,
): Promise<{
  manifest: { schemaVersion: string };
  events: Array<{ seq: number; type: string; payload: Record<string, unknown> }>;
}> {
  return page.evaluate(async (recordingId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("code-tape");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db
          .transaction("recordings", "readonly")
          .objectStore("recordings")
          .get(recordingId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }, id);
}

type ObserverCaptureWindow = typeof globalThis & {
  __observerCapture: { channels: RTCDataChannel[]; sent: Record<string, unknown>[]; received: Record<string, unknown>[] };
};
async function captureObserverChannels(context: BrowserContext) {
  await context.addInitScript(() => {
    const capture = { channels: [] as RTCDataChannel[], sent: [] as Record<string, unknown>[], received: [] as Record<string, unknown>[] };
    (globalThis as ObserverCaptureWindow).__observerCapture = capture;
    const attached = new WeakSet<RTCDataChannel>();
    const track = (channel: RTCDataChannel) => {
      if (channel.label !== "events" || attached.has(channel)) return;
      attached.add(channel);
      capture.channels.push(channel);
      channel.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        try { capture.received.push(JSON.parse(event.data) as Record<string, unknown>); }
        catch { /* Binary or non-JSON messages are not observer packets. */ }
      });
      const send = channel.send;
      channel.send = ((data: unknown) => {
        Reflect.apply(send, channel, [data]);
        if (typeof data === "string") {
          try { capture.sent.push(JSON.parse(data) as Record<string, unknown>); }
          catch { /* Non-JSON RTC traffic is irrelevant to observer assertions. */ }
        }
      }) as typeof channel.send;
    };
    const PeerConnection = globalThis.RTCPeerConnection;
    const createDataChannel = PeerConnection.prototype.createDataChannel;
    PeerConnection.prototype.createDataChannel = function (...args) {
      const channel = Reflect.apply(createDataChannel, this, args) as RTCDataChannel;
      track(channel);
      return channel;
    };
    globalThis.RTCPeerConnection = new Proxy(PeerConnection, {
      construct(target, args, newTarget) {
        const peer = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
        peer.addEventListener("datachannel", (event) => track(event.channel));
        return peer;
      },
    });
  });
}
async function eventsChannelOpen(page: Page) {
  await expect.poll(() => page.evaluate(() => (globalThis as ObserverCaptureWindow).__observerCapture.channels.some(
    (channel) => channel.label === "events" && channel.readyState === "open",
  )), { timeout: 30_000, message: "A real events DataChannel must open; no mocked transport fallback" }).toBe(true);
}
async function observerMessages(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => (globalThis as ObserverCaptureWindow).__observerCapture.sent);
}
function assertNoObserverEditorBody(value: unknown) {
  if (Array.isArray(value)) { value.forEach(assertNoObserverEditorBody); return; }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    expect(["code", "documents", "initialDocuments"]).not.toContain(key);
    assertNoObserverEditorBody(nested);
  }
}
