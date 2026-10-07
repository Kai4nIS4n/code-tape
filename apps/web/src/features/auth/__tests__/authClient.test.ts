import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthClient, type AuthClient } from "../authClient";

const clients: AuthClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((client) => client.dispose());
});
function client(fetcher: typeof fetch) {
  const instance = createAuthClient({ fetch: fetcher, broadcast: false });
  clients.push(instance);
  return instance;
}
const loggedIn = (id = "alice", token = "access-alice") =>
  new Response(
    JSON.stringify({
      user: { id, username: id, displayName: id },
      accessToken: token,
      expiresAt: Date.now() + 900_000,
    }),
    { status: 200 },
  );

describe("account authentication", () => {
  it("coalesces refresh and keeps access credentials out of localStorage", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(loggedIn());
    const auth = client(fetcher);
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(await Promise.all([auth.getAccessToken(), auth.getAccessToken()])).toEqual([
      "access-alice",
      "access-alice",
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("/api/auth/refresh");
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      credentials: "same-origin",
      headers: { "x-code-tape-client": "web" },
    });
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });
  it("retries a business 401 once with a rotated access token", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(loggedIn())
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(loggedIn("alice", "access-new"))
      .mockResolvedValueOnce(new Response("ok"));
    const auth = client(fetcher);
    const response = await auth.fetch("/api/recordings");
    expect(await response.text()).toBe("ok");
    expect(new Headers(fetcher.mock.calls[3][1]?.headers).get("authorization")).toBe(
      "Bearer access-new",
    );
  });
  it("does not apply a refresh that completes after logout", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(new Response(null, { status: 204 }));
    const auth = client(fetcher);
    const refresh = auth.getAccessToken();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const logout = auth.logout();
    finish(loggedIn());
    expect(await refresh).toBeNull();
    await logout;
    expect(auth.getSnapshot().user).toBeNull();
    expect(await auth.getAccessToken()).toBeNull();
  });
  it("does not expose a business response after the account changes", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(loggedIn())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(loggedIn("bob", "access-bob"));
    const auth = client(fetcher);
    const pending = auth.fetch("/api/recordings");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await auth.login({ username: "bob", password: "password123" });
    finish(new Response("alice-private-recordings"));
    expect((await pending).status).toBe(401);
    expect(auth.getSnapshot().user?.id).toBe("bob");
  });
  it("never sends an anonymous owner token when refresh fails", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 401 }));
    const auth = client(fetcher);
    localStorage.setItem("code-tape-cloud-owner-token", "old-owner");
    expect((await auth.fetch("/api/recordings")).status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.body).toBe("{}");
    localStorage.removeItem("code-tape-cloud-owner-token");
  });
});
