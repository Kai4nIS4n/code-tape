import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthClient, type AuthClient } from "../authClient";
import { createCloudRecordingRepository } from "@/features/cloud/cloudRecordingRepository";
import type { RecordingPackageV1 } from "@/shared/recording-schema";

const clients: AuthClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.dispose());
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function loggedIn(id: string) {
  return new Response(
    JSON.stringify({
      user: { id, username: id, displayName: id },
      accessToken: `access-${id}`,
      expiresAt: Date.now() + 900_000,
    }),
    { status: 200 },
  );
}
function client(fetcher: typeof fetch, broadcast = false) {
  const auth = createAuthClient({ fetch: fetcher, broadcast });
  clients.push(auth);
  return auth;
}

describe("account concurrency review regressions", () => {
  it("an old restore cannot report anonymous while a newer broadcast login refresh is pending", async () => {
    const channels: EventTarget[] = [];
    class TestChannel extends EventTarget {
      constructor(_name: string) {
        super();
        channels.push(this);
      }
      postMessage() {}
      close() {}
    }
    vi.stubGlobal("BroadcastChannel", TestChannel);
    const oldRefresh = deferred<Response>();
    const newRefresh = deferred<Response>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => oldRefresh.promise)
      .mockImplementationOnce(() => newRefresh.promise);
    const auth = client(fetcher, true);
    const oldRestore = auth.restore();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    channels[0].dispatchEvent(new MessageEvent("message", { data: { type: "login" } }));
    oldRefresh.resolve(loggedIn("alice"));
    await oldRestore;
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(auth.getSnapshot().status).toBe("loading");
    expect(auth.getSnapshot().user).toBeNull();
    newRefresh.resolve(loggedIn("bob"));
    await vi.waitFor(() => expect(auth.getSnapshot().user?.id).toBe("bob"));
  });
  it("does not resolve a superseded queued login as a successful authentication", async () => {
    const channels: EventTarget[] = [];
    class TestChannel extends EventTarget {
      constructor(_name: string) {
        super();
        channels.push(this);
      }
      postMessage() {}
      close() {}
    }
    vi.stubGlobal("BroadcastChannel", TestChannel);
    const oldRefresh = deferred<Response>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => oldRefresh.promise)
      .mockResolvedValue(loggedIn("bob"));
    const auth = client(fetcher, true);
    const refresh = auth.getAccessToken();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const pendingLogin = auth.login({ username: "bob", password: "password123" });
    const rejected = expect(pendingLogin).rejects.toBeDefined();
    channels[0].dispatchEvent(new MessageEvent("message", { data: { type: "logout" } }));
    oldRefresh.resolve(loggedIn("alice"));
    await refresh;
    await rejected;
    expect(auth.getSnapshot().user).toBeNull();
  });
  it("restores the new cookie identity when a broadcast login supersedes an in-flight refresh", async () => {
    const channels: EventTarget[] = [];
    class TestChannel extends EventTarget {
      constructor(_name: string) {
        super();
        channels.push(this);
      }
      postMessage() {}
      close() {}
    }
    vi.stubGlobal("BroadcastChannel", TestChannel);
    const oldRefresh = deferred<Response>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => oldRefresh.promise)
      .mockResolvedValue(loggedIn("bob"));
    const auth = client(fetcher, true);
    const pending = auth.getAccessToken();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    channels[0].dispatchEvent(new MessageEvent("message", { data: { type: "login" } }));
    oldRefresh.resolve(loggedIn("alice"));
    await pending;
    await vi.waitFor(() => expect(auth.getSnapshot().user?.id).toBe("bob"));
  });

  it("rejects an old account response whose JSON body finishes after account switching", async () => {
    const body = deferred<{
      items: Array<{ id: string; createdAt: string; expiresAt: null; revokedAt: null }>;
    }>();
    const response = new Response("headers arrived", { status: 200 });
    const readBody = vi.spyOn(response, "json").mockImplementation(() => body.promise);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(loggedIn("alice"))
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(loggedIn("bob"));
    const auth = client(fetcher);
    await auth.getAccessToken();
    const repository = createCloudRecordingRepository({ auth });
    const pending = repository.listShareLinks("alice-private-recording");
    await vi.waitFor(() => expect(readBody).toHaveBeenCalled());
    await auth.login({ username: "bob", password: "password123" });
    body.resolve({
      items: [
        {
          id: "alice-private-share",
          createdAt: "2026-10-07T00:00:00Z",
          expiresAt: null,
          revokedAt: null,
        },
      ],
    });
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("advances the identity epoch on refresh rejection and rejects old private response bodies", async () => {
    const body = deferred<{ items: unknown[] }>();
    const response = new Response("headers arrived", { status: 200 });
    const readBody = vi.spyOn(response, "json").mockImplementation(() => body.promise);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(loggedIn("alice"))
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const auth = client(fetcher);
    await auth.getAccessToken();
    const originalEpoch = auth.epoch;
    const repository = createCloudRecordingRepository({ auth });
    const pending = repository.listShareLinks("alice-private-recording");
    await vi.waitFor(() => expect(readBody).toHaveBeenCalled());
    expect(await auth.getAccessToken(true)).toBeNull();
    body.resolve({ items: [{ id: "alice-private-share" }] });
    const result = await pending;
    expect(auth.epoch).toBeGreaterThan(originalEpoch);
    expect(result).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("does not create an upload session under the next account after slow asset preparation", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(loggedIn("alice"))
      .mockResolvedValueOnce(loggedIn("bob"))
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            sessionId: "bob-session",
            recordingId: "bob-recording",
            uploadTargets: [],
          }),
          { status: 201 },
        ),
      );
    const auth = client(fetcher);
    await auth.getAccessToken();
    const repository = createCloudRecordingRepository({ auth });
    const bytes = deferred<ArrayBuffer>();
    const thumbnail = new Blob(["thumbnail"], { type: "image/webp" });
    const readBytes = vi.spyOn(thumbnail, "arrayBuffer").mockImplementation(() => bytes.promise);
    const pkg: RecordingPackageV1 = {
      schemaVersion: "0.2.0",
      manifest: {
        packageId: "alice-package",
        schemaVersion: "0.2.0",
        status: "complete",
        createdAt: "2026-10-07T00:00:00Z",
        completedAt: null,
        checksums: { eventsSha256: "events", snapshotsSha256: "snapshots" },
      },
      meta: {
        id: "alice-recording",
        title: "Alice private title",
        createdAt: "2026-10-07T00:00:00Z",
        durationMs: 1000,
        appVersion: "test",
        ownerId: null,
        creatorInfo: null,
        initialLanguage: "javascript",
        initialFontSize: 14,
        initialTheme: "dark",
        mediaCapability: {
          audio: "unsupported",
          camera: "unsupported",
          selectedAudioDeviceId: null,
          selectedCameraDeviceId: null,
        },
      },
      events: [],
      snapshots: [],
      media: null,
    };
    const pending = repository.uploadPackage(pkg, { thumbnail });
    await vi.waitFor(() => expect(readBytes).toHaveBeenCalled());
    await auth.login({ username: "bob", password: "password123" });
    bytes.resolve(new ArrayBuffer(0));
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes("upload-sessions")),
    ).toHaveLength(0);
  });
});
