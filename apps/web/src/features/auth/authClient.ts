export type AccountUser = { id: string; username: string; displayName: string };
export type AuthSnapshot = {
  user: AccountUser | null;
  status: "loading" | "authenticated" | "anonymous";
  error: string | null;
  epoch: number;
};
type AuthResponse = { user: AccountUser; accessToken: string; expiresAt: number };
export type AuthClient = ReturnType<typeof createAuthClient>;

export function createAuthClient(
  options: {
    apiBase?: string;
    fetch?: typeof fetch;
    now?: () => number;
    broadcast?: boolean;
  } = {},
) {
  const apiBase = options.apiBase ?? "";
  const request = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? Date.now;
  let snapshot: AuthSnapshot = { user: null, status: "loading", error: null, epoch: 0 };
  let access: { value: string; expiresAt: number } | null = null;
  let refreshInFlight: Promise<string | null> | null = null;
  let operationQueue: Promise<unknown> = Promise.resolve();
  let signedOut = false;
  const listeners = new Set<() => void>();
  const channel =
    options.broadcast !== false && typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel("code-tape-auth")
      : null;

  const update = (value: Partial<AuthSnapshot>) => {
    snapshot = { ...snapshot, ...value };
    listeners.forEach((listener) => listener());
  };
  const invalidate = () => {
    access = null;
    refreshInFlight = null;
    update({ user: null, status: "anonymous", error: null, epoch: snapshot.epoch + 1 });
  };
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = async (): Promise<T> => {
      if (typeof navigator === "undefined" || !navigator.locks) return operation();
      let value!: T;
      await navigator.locks.request("code-tape-auth", async () => {
        value = await operation();
      });
      return value;
    };
    const pending = operationQueue.then(run, run);
    operationQueue = pending.catch(() => undefined);
    return pending;
  };
  const authRequest = (path: string, body?: unknown) =>
    request(`${apiBase}/api/auth/${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-code-tape-client": "web" },
      body: JSON.stringify(body ?? {}),
    });
  const readError = async (response: Response) => {
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      return body.error?.message ?? "账号操作失败，请重试";
    } catch {
      return "账号操作失败，请重试";
    }
  };
  const accept = (body: AuthResponse, epoch: number): string | null => {
    if (
      snapshot.epoch !== epoch ||
      !body.user?.id ||
      !body.user.username ||
      typeof body.accessToken !== "string" ||
      !Number.isFinite(body.expiresAt) ||
      body.expiresAt <= now()
    )
      return null;
    access = { value: body.accessToken, expiresAt: body.expiresAt };
    const identityChanged = snapshot.user !== null && snapshot.user.id !== body.user.id;
    update({
      user: body.user,
      status: "authenticated",
      error: null,
      ...(identityChanged ? { epoch: snapshot.epoch + 1 } : {}),
    });
    return access.value;
  };

  const getAccessToken = async (force = false): Promise<string | null> => {
    if (signedOut) return null;
    if (!force && access && access.expiresAt > now() + 30_000) return access.value;
    if (refreshInFlight) return refreshInFlight;
    const epoch = snapshot.epoch;
    const pending = exclusive(async () => {
      if (signedOut || epoch !== snapshot.epoch) return null;
      try {
        let response = await authRequest("refresh");
        if (response.status === 409) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          if (signedOut || epoch !== snapshot.epoch) return null;
          response = await authRequest("refresh");
        }
        if (response.ok) return accept((await response.json()) as AuthResponse, epoch);
        if (epoch === snapshot.epoch) {
          invalidate();
        }
      } catch {
        if (epoch === snapshot.epoch)
          update({ status: snapshot.user ? "authenticated" : "anonymous" });
      }
      return null;
    }).finally(() => {
      if (refreshInFlight === pending) refreshInFlight = null;
    });
    refreshInFlight = pending;
    return pending;
  };

  const authenticate = (
    path: "login" | "register",
    input: {
      username: string;
      password: string;
      displayName?: string;
    },
  ): Promise<void> => {
    invalidate();
    signedOut = false;
    const epoch = snapshot.epoch;
    update({ status: "loading" });
    return exclusive(async () => {
      if (epoch !== snapshot.epoch) throw new Error("账号状态已更新，请重新操作");
      try {
        const response = await authRequest(path, input);
        if (!response.ok) throw new Error(await readError(response));
        if (!accept((await response.json()) as AuthResponse, epoch)) {
          if (epoch === snapshot.epoch) throw new Error("登录响应无效，请重试");
          throw new Error("账号状态已更新，请重新操作");
        }
        channel?.postMessage({ type: "login" });
      } catch (error) {
        if (epoch === snapshot.epoch)
          update({
            status: "anonymous",
            error: error instanceof Error ? error.message : "登录失败",
          });
        throw error;
      }
    });
  };

  const logout = async () => {
    signedOut = true;
    invalidate();
    const epoch = snapshot.epoch;
    channel?.postMessage({ type: "logout" });
    await exclusive(async () => {
      if (epoch !== snapshot.epoch) return;
      try {
        const response = await authRequest("logout");
        if (!response.ok) throw new Error(await readError(response));
      } catch (error) {
        if (epoch === snapshot.epoch) update({ error: "本机已退出，但未能确认服务器退出，请重试" });
        throw error;
      }
    });
  };

  const restore = async () => {
    if (signedOut) return;
    const epoch = snapshot.epoch;
    update({ status: "loading" });
    await getAccessToken();
    if (epoch !== snapshot.epoch) return;
    if (snapshot.status === "loading")
      update({ status: snapshot.user ? "authenticated" : "anonymous" });
  };

  channel?.addEventListener("message", (event: MessageEvent<{ type?: string }>) => {
    if (event.data?.type !== "login" && event.data?.type !== "logout") return;
    invalidate();
    signedOut = event.data.type === "logout";
    if (!signedOut) void restore();
  });

  return {
    get epoch() {
      return snapshot.epoch;
    },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getAccessToken,
    restore,
    login: (input: { username: string; password: string }) => authenticate("login", input),
    register: (input: { username: string; password: string; displayName?: string }) =>
      authenticate("register", input),
    logout,
    async fetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
      const epoch = snapshot.epoch;
      const send = (token: string) => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${token}`);
        return request(input, { ...init, headers: Object.fromEntries(headers.entries()) });
      };
      const unauthorized = () =>
        new Response(
          JSON.stringify({
            error: { code: "unauthorized", message: "请登录后访问云端或协作房间" },
          }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        );
      const token = await getAccessToken();
      if (!token || epoch !== snapshot.epoch) return unauthorized();
      const response = await send(token);
      if (epoch !== snapshot.epoch) return unauthorized();
      if (response.status !== 401) return response;
      const refreshed = await getAccessToken(true);
      if (!refreshed || epoch !== snapshot.epoch) return unauthorized();
      const retry = await send(refreshed);
      return epoch === snapshot.epoch ? retry : unauthorized();
    },
    dispose() {
      channel?.close();
      listeners.clear();
    },
  };
}

export const authClient = createAuthClient();
