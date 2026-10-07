import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import { RECORDING_LANGUAGES } from "@code-tape/recording-schema";
import {
  ApiFailure,
  randomToken,
  tokenHash,
  type AccountAuthService,
  type AccountIdentity,
} from "../auth/accountAuthService.js";
import { apiError, json } from "../auth/authApiHandler.js";
import { readPayload, type AppDatabase } from "../persistence/database.js";
import { createInterviewRoomService } from "./interviewRoomService.js";
import type { InterviewRole, InterviewRoom } from "./types.js";

export const SOURCE_LANGUAGES = RECORDING_LANGUAGES;
export type SecureRoom = InterviewRoom & { ownerUserId: string; epoch: number };
export type RoomConnectionIdentity = AccountIdentity & {
  roomId: string;
  role: InterviewRole;
  epoch: number;
  purpose: "collaboration" | "signaling";
};

export function createSecureRooms(input: {
  db: AppDatabase;
  auth: AccountAuthService;
  now?: () => number;
  onRoomClosed?: (roomId: string) => void;
  onMemberRemoved?: (roomId: string, userId: string) => void;
}) {
  const db = input.db,
    now = input.now ?? Date.now;
  const get = (id: string) =>
    readPayload<SecureRoom>(
      db,
      "SELECT payload FROM interview_rooms WHERE id=?",
      id,
    );
  const loadLegacyRoom = (id: string) => {
    const room = get(id);
    // This public marker is only an internal adapter value after membership
    // authorization. It is never an invitation credential.
    return room ? { ...room, joinCode: room.id } : null;
  };
  const save = (room: InterviewRoom) => {
    const previous = get(room.id);
    const { joinCode: _joinCode, ...durableRoom } = { ...previous, ...room };
    db.prepare(
      "INSERT INTO interview_rooms(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
    ).run(room.id, JSON.stringify(durableRoom));
  };
  const legacy = createInterviewRoomService({
    rooms: { get: loadLegacyRoom, save },
    now: () => new Date(now()),
    createJoinCode: randomToken,
    createId: randomUUID,
  });
  const membership = (roomId: string, userId: string) =>
    db
      .prepare(
        "SELECT role FROM room_members WHERE room_id=? AND user_id=? AND revoked_at IS NULL",
      )
      .get(roomId, userId) as { role: InterviewRole } | undefined;
  function authorize(identity: AccountIdentity, roomId: string) {
    if (!input.auth.activeSession(identity.sessionId))
      throw new ApiFailure(401, "unauthorized", "session revoked");
    const room = get(roomId),
      member = membership(roomId, identity.user.id);
    if (!room || !member)
      throw new ApiFailure(403, "forbidden", "room membership required");
    if (
      room.status === "ended" ||
      room.status === "expired" ||
      Date.parse(room.expiresAt) <= now()
    )
      throw new ApiFailure(410, "room-ended", "room is closed");
    return { room, role: member.role };
  }
  const expose = (
    room: SecureRoom,
    role: InterviewRole,
    invitation?: string,
  ) => {
    const { joinCode: _joinCode, ...publicRoom } = room;
    return {
      room: { ...publicRoom, ...(invitation ? { joinCode: invitation } : {}) },
      role,
      roomId: room.id,
      ...(invitation ? { joinCode: invitation } : {}),
      status: room.status,
      expiresAt: room.expiresAt,
      epoch: room.epoch,
      signalingUrl: `/api/interviews/rooms/${encodeURIComponent(room.id)}/signaling`,
    };
  };
  const issueInvite = (room: SecureRoom) => {
    const token = randomToken(),
      expiresAt = Math.min(Date.parse(room.expiresAt), now() + 30 * 60 * 1000);
    db.prepare(
      "INSERT INTO room_invites(hash,room_id,expires_at) VALUES(?,?,?)",
    ).run(tokenHash(token), room.id, expiresAt);
    return {
      token,
      joinCode: token,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  };
  const handler = async (request: Request): Promise<Response> => {
    try {
      const identity = await input.auth.authenticate(request);
      if (!identity)
        throw new ApiFailure(401, "unauthorized", "sign in required");
      const path = new URL(request.url).pathname;
      if (request.method === "POST" && path === "/api/interviews/rooms") {
        const body = await optionalBody(request),
          documents = readDocuments(body.documents);
        const room = db.transaction(() => {
          const base = legacy.createRoom().room,
            room: SecureRoom = {
              ...base,
              ownerUserId: identity.user.id,
              epoch: 1,
            };
          save(room);
          db.prepare(
            "INSERT INTO room_members(room_id,user_id,role) VALUES(?,?,'candidate')",
          ).run(room.id, identity.user.id);
          const doc = new Y.Doc();
          for (const language of SOURCE_LANGUAGES)
            doc
              .getText(`source:${language}`)
              .insert(0, documents[language] ?? "");
          const state = Y.encodeStateAsUpdate(doc);
          doc.destroy();
          db.prepare(
            "INSERT INTO collaborative_documents(room_id,epoch,state) VALUES(?,?,?)",
          ).run(room.id, room.epoch, Buffer.from(state));
          // Join code is an invite capability; persist only its hash in invite storage.
          db.prepare(
            "INSERT INTO room_invites(hash,room_id,expires_at) VALUES(?,?,?)",
          ).run(tokenHash(room.joinCode), room.id, Date.parse(room.expiresAt));
          return room;
        })();
        return json(expose(room, "candidate", room.joinCode), 201);
      }
      const match =
        /^\/api\/interviews\/rooms\/([^/]+)(?:\/(join|invites|ws-tickets|end|members)(?:\/([^/]+))?)?$/u.exec(
          path,
        );
      if (!match) throw new ApiFailure(404, "not-found", "route not found");
      const roomId = decodeURIComponent(match[1]!),
        action = match[2];
      if (action === "join" && request.method === "POST") {
        const body = await optionalBody(request),
          token = body.joinCode ?? body.token;
        if (typeof token !== "string" || token.length > 256)
          throw new ApiFailure(400, "bad-request", "joinCode required");
        const room = db.transaction(() => {
          const room = get(roomId);
          if (
            !room ||
            Date.parse(room.expiresAt) <= now() ||
            ["ended", "expired"].includes(room.status)
          )
            throw new ApiFailure(410, "room-ended", "room is closed");
          const existing = membership(roomId, identity.user.id);
          if (existing) return room;
          const invite = db
            .prepare("SELECT * FROM room_invites WHERE hash=? AND room_id=?")
            .get(tokenHash(token), roomId) as
            | { expires_at: number; consumed_by: string | null }
            | undefined;
          if (
            !invite ||
            invite.expires_at <= now() ||
            invite.consumed_by !== null
          )
            throw new ApiFailure(
              403,
              "invalid-join-code",
              "invitation unavailable",
            );
          if (
            db
              .prepare(
                "SELECT 1 FROM room_members WHERE room_id=? AND role='interviewer' AND revoked_at IS NULL",
              )
              .get(roomId)
          )
            throw new ApiFailure(
              409,
              "room-full",
              "room already has two members",
            );
          db.prepare(
            "DELETE FROM room_members WHERE room_id=? AND role='interviewer' AND revoked_at IS NOT NULL",
          ).run(roomId);
          db.prepare(
            "INSERT INTO room_members(room_id,user_id,role) VALUES(?,?,'interviewer')",
          ).run(roomId, identity.user.id);
          db.prepare("UPDATE room_invites SET consumed_by=? WHERE hash=?").run(
            identity.user.id,
            tokenHash(token),
          );
          return room;
        })();
        return json(expose(room, membership(roomId, identity.user.id)!.role));
      }
      const authorized = authorize(identity, roomId);
      if (request.method === "GET" && !action)
        return json({
          ...expose(authorized.room, authorized.role),
          candidateConnected: Boolean(authorized.room.candidateConnectionId),
          interviewerConnected: Boolean(
            authorized.room.interviewerConnectionId,
          ),
        });
      if (action === "ws-tickets" && request.method === "POST") {
        const body = await optionalBody(request);
        if (body.purpose !== "collaboration" && body.purpose !== "signaling")
          throw new ApiFailure(400, "bad-request", "invalid ticket purpose");
        const ticket = randomToken(),
          expiresAt = now() + 30000;
        db.prepare(
          "INSERT INTO ws_tickets(hash,room_id,user_id,session_id,purpose,expires_at) VALUES(?,?,?,?,?,?)",
        ).run(
          tokenHash(ticket),
          roomId,
          identity.user.id,
          identity.sessionId,
          body.purpose,
          expiresAt,
        );
        return json({
          ticket,
          expiresAt: new Date(expiresAt).toISOString(),
          epoch: authorized.room.epoch,
          role: authorized.role,
        });
      }
      if (authorized.role !== "candidate")
        throw new ApiFailure(403, "forbidden", "room owner required");
      if (action === "invites" && request.method === "POST")
        return json(issueInvite(authorized.room), 201);
      if (action === "end" && request.method === "POST") {
        save({
          ...authorized.room,
          status: "ended",
          candidateConnectionId: null,
          interviewerConnectionId: null,
        });
        input.onRoomClosed?.(roomId);
        return json({
          roomId,
          status: "ended",
          expiresAt: authorized.room.expiresAt,
        });
      }
      if (action === "members" && match[3] && request.method === "DELETE") {
        const userId = decodeURIComponent(match[3]);
        if (userId === identity.user.id)
          throw new ApiFailure(400, "bad-request", "owner cannot remove self");
        db.prepare(
          "UPDATE room_members SET revoked_at=? WHERE room_id=? AND user_id=?",
        ).run(now(), roomId, userId);
        input.onMemberRemoved?.(roomId, userId);
        return json({ ok: true });
      }
      throw new ApiFailure(404, "not-found", "route not found");
    } catch (error) {
      return apiError(error);
    }
  };
  return {
    handler,
    legacy,
    get: loadLegacyRoom,
    authorize,
    consumeTicket(
      raw: string,
      roomId: string,
      purpose: "collaboration" | "signaling",
    ): RoomConnectionIdentity {
      return db.transaction(() => {
        const ticket = db
          .prepare("SELECT * FROM ws_tickets WHERE hash=?")
          .get(tokenHash(raw)) as
          | {
              room_id: string;
              user_id: string;
              session_id: string;
              purpose: string;
              expires_at: number;
              consumed_at: number | null;
            }
          | undefined;
        if (
          !ticket ||
          ticket.room_id !== roomId ||
          ticket.purpose !== purpose ||
          ticket.expires_at <= now() ||
          ticket.consumed_at !== null
        )
          throw new ApiFailure(
            401,
            "unauthorized",
            "WebSocket ticket unavailable",
          );
        const identity = input.auth.activeSession(ticket.session_id);
        if (!identity || identity.user.id !== ticket.user_id)
          throw new ApiFailure(401, "unauthorized", "session revoked");
        const member = authorize(identity, roomId);
        db.prepare(
          "UPDATE ws_tickets SET consumed_at=? WHERE hash=? AND consumed_at IS NULL",
        ).run(now(), tokenHash(raw));
        return {
          ...identity,
          roomId,
          purpose,
          role: member.role,
          epoch: member.room.epoch,
        };
      })();
    },
  };
}
export type SecureRooms = ReturnType<typeof createSecureRooms>;
async function optionalBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiFailure(400, "bad-request", "invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ApiFailure(400, "bad-request", "JSON object required");
  return body as Record<string, unknown>;
}
function readDocuments(
  value: unknown,
): Partial<Record<(typeof SOURCE_LANGUAGES)[number], string>> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiFailure(400, "bad-request", "documents must be an object");
  const result: Partial<Record<(typeof SOURCE_LANGUAGES)[number], string>> = {};
  let bytes = 0;
  for (const [language, code] of Object.entries(value)) {
    if (
      !SOURCE_LANGUAGES.includes(
        language as (typeof SOURCE_LANGUAGES)[number],
      ) ||
      typeof code !== "string"
    )
      throw new ApiFailure(400, "bad-request", "invalid source document");
    bytes += Buffer.byteLength(code);
    result[language as (typeof SOURCE_LANGUAGES)[number]] = code;
  }
  if (bytes > 1024 * 1024)
    throw new ApiFailure(413, "quota-exceeded", "workspace exceeds 1 MiB");
  return result;
}
