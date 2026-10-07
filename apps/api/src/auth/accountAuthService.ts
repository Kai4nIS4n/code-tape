import { createHash, randomBytes, randomUUID } from "node:crypto";
import argon2 from "argon2";
import { SignJWT, jwtVerify } from "jose";
import type { AppDatabase } from "../persistence/database.js";
import type {
  AuditContext,
  AuditLogger,
} from "../observability/auditLogger.js";

export type AccountUser = { id: string; username: string; displayName: string };
export type AccountIdentity = { user: AccountUser; sessionId: string };
type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  disabled_at: number | null;
};
type SessionRow = {
  id: string;
  user_id: string;
  expires_at: number;
  revoked_at: number | null;
};
export class ApiFailure extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const tokenHash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");

export function createAccountAuthService(input: {
  db: AppDatabase;
  secret: string;
  now?: () => number;
  onRevoke?: (sessionId: string) => void;
  audit?: AuditLogger;
}) {
  if (Buffer.byteLength(input.secret) < 32)
    throw new Error("CODE_TAPE_AUTH_SECRET must contain at least 32 bytes");
  const db = input.db,
    now = input.now ?? Date.now,
    key = new TextEncoder().encode(input.secret);
  const userById = (id: string) =>
    db.prepare("SELECT * FROM users WHERE id=?").get(id) as UserRow | undefined;
  const sessionById = (id: string) =>
    db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as
      | SessionRow
      | undefined;
  const publicUser = (user: UserRow): AccountUser => ({
    id: user.id,
    username: user.username,
    displayName: user.display_name,
  });
  const activeSession = (id: string): AccountIdentity | null => {
    const session = sessionById(id);
    if (!session || session.revoked_at !== null || session.expires_at <= now())
      return null;
    const user = userById(session.user_id);
    return user && user.disabled_at === null
      ? { user: publicUser(user), sessionId: id }
      : null;
  };
  const revoke = (id: string, context: AuditContext = {}) => {
    const revoked = db
      .prepare(
        "UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL",
      )
      .run(now(), id);
    if (revoked.changes)
      input.audit?.emit("session.revoked", { ...context, sessionId: id });
    input.onRevoke?.(id);
  };
  async function issue(identity: AccountIdentity, refreshToken: string) {
    const expiresAt = now() + 15 * 60 * 1000;
    const accessToken = await new SignJWT({ sid: identity.sessionId })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(identity.user.id)
      .setIssuer("code-tape")
      .setAudience("code-tape-web")
      .setIssuedAt(Math.floor(now() / 1000))
      .setExpirationTime(Math.floor(expiresAt / 1000))
      .setJti(randomUUID())
      .sign(key);
    return { ...identity, accessToken, expiresAt, refreshToken };
  }
  async function begin(user: UserRow, context: AuditContext = {}) {
    const sessionId = randomUUID(),
      refreshToken = randomToken(),
      expiresAt = now() + 7 * 24 * 60 * 60 * 1000;
    db.transaction(() => {
      db.prepare(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)",
      ).run(sessionId, user.id, expiresAt);
      db.prepare("INSERT INTO refresh_tokens(hash,session_id) VALUES(?,?)").run(
        tokenHash(refreshToken),
        sessionId,
      );
    })();
    input.audit?.emit("session.created", { ...context, sessionId });
    return issue({ user: publicUser(user), sessionId }, refreshToken);
  }
  return {
    activeSession,
    revoke,
    async register(
      input: {
        username: string;
        password: string;
        displayName?: string;
      },
      context: AuditContext = {},
    ) {
      const username = normalizeCredentials(input.username, input.password),
        displayName = (input.displayName ?? input.username).trim();
      if (!displayName || displayName.length > 80)
        throw new ApiFailure(
          400,
          "bad-request",
          "displayName must contain 1–80 characters",
        );
      const passwordHash = await argon2.hash(input.password, {
        type: argon2.argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      });
      const id = randomUUID();
      try {
        db.prepare(
          "INSERT INTO users(id,username,password_hash,display_name) VALUES(?,?,?,?)",
        ).run(id, username, passwordHash, displayName);
      } catch (error) {
        if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE")
          throw new ApiFailure(
            409,
            "username-unavailable",
            "username is unavailable",
          );
        throw error;
      }
      return begin(userById(id)!, context);
    },
    async login(
      input: { username: string; password: string },
      context: AuditContext = {},
    ) {
      const username = normalizeCredentials(input.username, input.password);
      const user = db
        .prepare("SELECT * FROM users WHERE username=?")
        .get(username) as UserRow | undefined;
      // Perform the same password work for unknown accounts to avoid cheap account enumeration.
      const hash =
        user?.password_hash ??
        (await argon2.hash("invalid-account-password", {
          type: argon2.argon2id,
          memoryCost: 19456,
          timeCost: 2,
          parallelism: 1,
        }));
      const valid = await argon2.verify(hash, input.password);
      if (!user || user.disabled_at !== null || !valid)
        throw new ApiFailure(
          401,
          "unauthorized",
          "username or password is incorrect",
        );
      return begin(user, context);
    },
    async refresh(raw: string, context: AuditContext = {}) {
      const next = randomToken(),
        hash = tokenHash(raw);
      const result = db.transaction(() => {
        const row = db
          .prepare("SELECT * FROM refresh_tokens WHERE hash=?")
          .get(hash) as
          | { session_id: string; consumed_at: number | null }
          | undefined;
        if (!row) return { error: "unauthorized" as const };
        const identity = activeSession(row.session_id);
        if (!identity) return { error: "unauthorized" as const };
        if (row.consumed_at !== null) {
          if (now() - row.consumed_at <= 5000)
            return { error: "refresh-raced" as const };
          revoke(row.session_id, context);
          return { error: "unauthorized" as const };
        }
        db.prepare(
          "UPDATE refresh_tokens SET consumed_at=?,replaced_by=? WHERE hash=? AND consumed_at IS NULL",
        ).run(now(), tokenHash(next), hash);
        db.prepare(
          "INSERT INTO refresh_tokens(hash,session_id) VALUES(?,?)",
        ).run(tokenHash(next), row.session_id);
        return { identity };
      })();
      if (result.error)
        throw new ApiFailure(
          result.error === "refresh-raced" ? 409 : 401,
          result.error,
          "refresh session is unavailable",
        );
      input.audit?.emit("session.refreshed", {
        ...context,
        sessionId: result.identity.sessionId,
      });
      return issue(result.identity, next);
    },
    logout(raw: string | null, context: AuditContext = {}) {
      if (!raw) return;
      const row = db
        .prepare("SELECT session_id FROM refresh_tokens WHERE hash=?")
        .get(tokenHash(raw)) as { session_id: string } | undefined;
      if (row) revoke(row.session_id, context);
    },
    async authenticate(request: Request): Promise<AccountIdentity | null> {
      const match = /^Bearer\s+([^\s]+)$/iu.exec(
        request.headers.get("authorization") ?? "",
      );
      if (!match) return null;
      try {
        const verified = await jwtVerify(match[1]!, key, {
          algorithms: ["HS256"],
          issuer: "code-tape",
          audience: "code-tape-web",
          currentDate: new Date(now()),
        });
        const sid = verified.payload.sid;
        if (typeof sid !== "string" || typeof verified.payload.sub !== "string")
          return null;
        const identity = activeSession(sid);
        return identity?.user.id === verified.payload.sub ? identity : null;
      } catch {
        return null;
      }
    },
  };
}
export type AccountAuthService = ReturnType<typeof createAccountAuthService>;
function normalizeCredentials(username: string, password: string): string {
  if (typeof username !== "string" || typeof password !== "string")
    throw new ApiFailure(
      400,
      "bad-request",
      "username and password are required",
    );
  const normalized = username.trim().toLowerCase();
  if (
    !/^[a-z0-9_.-]{3,40}$/u.test(normalized) ||
    password.length < 8 ||
    Buffer.byteLength(password) > 256
  )
    throw new ApiFailure(
      400,
      "bad-request",
      "username must be 3–40 ASCII characters and password 8–256 bytes",
    );
  return normalized;
}
