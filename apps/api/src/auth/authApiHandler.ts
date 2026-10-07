import { ApiFailure, type AccountAuthService } from "./accountAuthService.js";

export function json(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
}
export function apiError(error: unknown): Response {
  return error instanceof ApiFailure
    ? json(
        { error: { code: error.code, message: error.message } },
        error.status,
      )
    : json(
        {
          error: {
            code: "internal-error",
            message: "request could not be completed",
          },
        },
        500,
      );
}
export function assertTrustedOrigin(
  request: Request,
  allowedOrigins: readonly string[] = [],
) {
  const origin = request.headers.get("origin");
  if (
    !origin ||
    !(origin === new URL(request.url).origin || allowedOrigins.includes(origin))
  )
    throw new ApiFailure(403, "forbidden", "untrusted Origin");
}
export function readRefreshCookie(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === "code_tape_refresh") return value.join("=");
  }
  return null;
}

export function createAuthApiHandler(input: {
  auth: AccountAuthService;
  allowedOrigins?: readonly string[];
  secureCookie?: boolean;
}) {
  const attempts = new Map<string, { count: number; until: number }>();
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url),
        action = url.pathname.replace("/api/auth/", "");
      const context = {
        requestId: request.headers.get("x-code-tape-request-id") ?? undefined,
      };
      if (request.method === "GET" && action === "me") {
        const identity = await input.auth.authenticate(request);
        if (!identity)
          throw new ApiFailure(401, "unauthorized", "sign in required");
        return json({ user: identity.user });
      }
      if (
        request.method !== "POST" ||
        !["register", "login", "refresh", "logout"].includes(action)
      )
        throw new ApiFailure(404, "not-found", "route not found");
      assertTrustedOrigin(request, input.allowedOrigins);
      if (
        request.headers.get("x-code-tape-client") !== "web" ||
        !request.headers.get("content-type")?.startsWith("application/json")
      )
        throw new ApiFailure(
          403,
          "forbidden",
          "JSON application request required",
        );
      const secure = input.secureCookie ?? url.protocol === "https:",
        cookie = (token: string, maxAge: number) =>
          `code_tape_refresh=${token}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
      if (action === "logout") {
        input.auth.logout(readRefreshCookie(request), context);
        const identity = await input.auth.authenticate(request);
        if (identity) input.auth.revoke(identity.sessionId, context);
        return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });
      }
      if (action === "refresh") {
        const raw = readRefreshCookie(request);
        if (!raw) throw new ApiFailure(401, "unauthorized", "sign in required");
        const issued = await input.auth.refresh(raw, context);
        return json(
          {
            user: issued.user,
            accessToken: issued.accessToken,
            expiresAt: issued.expiresAt,
          },
          200,
          { "set-cookie": cookie(issued.refreshToken, 7 * 24 * 60 * 60) },
        );
      }
      const body = (await request.json()) as {
        username?: unknown;
        password?: unknown;
        displayName?: unknown;
      };
      if (
        typeof body?.username !== "string" ||
        typeof body.password !== "string" ||
        (body.displayName !== undefined && typeof body.displayName !== "string")
      )
        throw new ApiFailure(400, "bad-request", "invalid credentials");
      // The Node adapter supplies peer address; never trust user-provided X-Forwarded-For.
      const peer = request.headers.get("x-code-tape-peer") ?? "handler",
        now = Date.now();
      for (const [bucket, limit] of [
        [`peer:${peer}`, 30],
        [`account:${body.username.toLowerCase()}`, 10],
      ] as const) {
        const previous = attempts.get(bucket),
          counter =
            previous && previous.until > now
              ? previous
              : { count: 0, until: now + 60000 };
        if (++counter.count > limit)
          throw new ApiFailure(429, "rate-limited", "try again later");
        attempts.set(bucket, counter);
      }
      if (attempts.size > 10000)
        for (const [key, value] of attempts)
          if (value.until <= now) attempts.delete(key);
      const issued =
        action === "register"
          ? await input.auth.register(
              {
                username: body.username,
                password: body.password,
                displayName: body.displayName as string | undefined,
              },
              context,
            )
          : await input.auth.login(
              {
                username: body.username,
                password: body.password,
              },
              context,
            );
      return json(
        {
          user: issued.user,
          accessToken: issued.accessToken,
          expiresAt: issued.expiresAt,
        },
        action === "register" ? 201 : 200,
        { "set-cookie": cookie(issued.refreshToken, 7 * 24 * 60 * 60) },
      );
    } catch (error) {
      return apiError(error);
    }
  };
}
