import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  decodeCollaborationFrame,
  encodeCollaborationFrame,
  COLLABORATION_MAX_FRAME_BYTES,
} from "@code-tape/recording-schema";
import { ApiFailure } from "../auth/accountAuthService.js";
import { assertTrustedOrigin } from "../auth/authApiHandler.js";
import type {
  SecureRooms,
  RoomConnectionIdentity,
} from "../interview/secureRooms.js";
import type { InterviewSignalingServer } from "../signaling/interviewSignalingServer.js";
import type { createCollaborationRepository } from "./collaborationRepository.js";
import type { AuditLogger } from "../observability/auditLogger.js";

type Active = {
  socket: WebSocket;
  identity: RoomConnectionIdentity;
  id: string;
  awarenessIds: Set<number>;
  windowStart: number;
  messages: number;
  requestId: string;
};
export function createSecureWebSocketServer(input: {
  rooms: SecureRooms;
  repository: ReturnType<typeof createCollaborationRepository>;
  signaling: InterviewSignalingServer;
  allowedOrigins?: readonly string[];
  testBlockedUsers?: Set<string>;
  audit?: AuditLogger;
}) {
  const server = new WebSocketServer({
      noServer: true,
      maxPayload: COLLABORATION_MAX_FRAME_BYTES,
    }),
    connections = new Set<Active>(),
    awarenessByRoom = new Map<string, awarenessProtocol.Awareness>();
  let closed = false;
  function send(active: Active, value: unknown) {
    if (active.socket.readyState === WebSocket.OPEN) {
      active.socket.send(JSON.stringify(value));
      return true;
    }
    return false;
  }
  function binary(active: Active, bytes: Uint8Array) {
    if (active.socket.readyState === WebSocket.OPEN) active.socket.send(bytes);
  }
  function check(active: Active) {
    const member = input.rooms.authorize(
      active.identity,
      active.identity.roomId,
    );
    if (
      member.role !== active.identity.role ||
      member.room.epoch !== active.identity.epoch
    )
      throw new ApiFailure(
        409,
        "epoch-mismatch",
        "room permissions or epoch changed",
      );
    return member;
  }
  function closeWhere(predicate: (active: Active) => boolean) {
    for (const active of connections)
      if (predicate(active)) active.socket.close(4003, "authorization revoked");
  }
  const interval = setInterval(() => {
    for (const active of connections) {
      try {
        check(active);
      } catch {
        active.socket.close(4003, "authorization revoked");
      }
    }
  }, 5000);
  interval.unref();
  function awareness(roomId: string) {
    let value = awarenessByRoom.get(roomId);
    if (!value) {
      const doc = new Y.Doc();
      value = new awarenessProtocol.Awareness(doc);
      value.setLocalState(null);
      awarenessByRoom.set(roomId, value);
    }
    return value;
  }
  return {
    canHandle(request: IncomingMessage) {
      return /^\/api\/interviews\/rooms\/[^/]+\/(collaboration|signaling)$/u.test(
        new URL(request.url ?? "/", "http://localhost").pathname,
      );
    },
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      try {
        const protocol = (request.socket as { encrypted?: boolean }).encrypted
            ? "https"
            : "http",
          url = new URL(
            request.url ?? "/",
            `${protocol}://${request.headers.host ?? "localhost"}`,
          ),
          match =
            /^\/api\/interviews\/rooms\/([^/]+)\/(collaboration|signaling)$/u.exec(
              url.pathname,
            );
        if (!match)
          throw new ApiFailure(404, "not-found", "unknown WebSocket endpoint");
        assertTrustedOrigin(
          new Request(url, {
            headers: { origin: request.headers.origin ?? "" },
          }),
          input.allowedOrigins,
        );
        const identity = input.rooms.consumeTicket(
          url.searchParams.get("ticket") ?? "",
          decodeURIComponent(match[1]!),
          match[2] as "collaboration" | "signaling",
        );
        if (
          identity.purpose === "collaboration" &&
          input.testBlockedUsers?.has(identity.user.id)
        )
          throw new ApiFailure(
            503,
            "test-disconnected",
            "test transport is disconnected",
          );
        server.handleUpgrade(request, socket, head, (webSocket) => {
          const active: Active = {
            socket: webSocket,
            identity,
            id: randomUUID(),
            awarenessIds: new Set(),
            windowStart: Date.now(),
            messages: 0,
            requestId: randomUUID(),
          };
          connections.add(active);
          input.audit?.emit("ws.authorized", auditFields(active));
          if (identity.purpose === "signaling")
            send(active, {
              kind: "connected",
              roomId: identity.roomId,
              connectionId: active.id,
            });
          else {
            const current = input.repository.get(
              identity.roomId,
              identity.epoch,
            );
            send(active, {
              type: "hello",
              roomId: identity.roomId,
              epoch: identity.epoch,
              workspaceId: `${identity.roomId}:${identity.epoch}`,
              revision: current.revision,
            });
            const state = awareness(identity.roomId);
            const ids = [...state.getStates().keys()];
            if (ids.length)
              binary(
                active,
                encodeCollaborationFrame({
                  type: "awareness",
                  data: awarenessProtocol.encodeAwarenessUpdate(state, ids),
                }),
              );
          }
          webSocket.on("message", (data, isBinary) => {
            if (closed) return;
            try {
              check(active);
              if (identity.purpose === "signaling")
                receiveSignaling(active, data);
              else receiveCollaboration(active, data, isBinary);
            } catch (error) {
              const failure =
                error instanceof ApiFailure
                  ? error
                  : new ApiFailure(400, "bad-message", "invalid message");
              const fatal =
                [401, 403, 410].includes(failure.status) ||
                failure.code === "epoch-mismatch";
              send(active, {
                type: "error",
                kind: "error",
                code: failure.code,
                message: failure.message,
                fatal,
                epoch: identity.epoch,
              });
              if (fatal) webSocket.close(4003, failure.code);
            }
          });
          webSocket.on("error", () => {
            input.audit?.emit("ws.transport-error", auditFields(active));
          });
          webSocket.on("close", (closeCode) => {
            connections.delete(active);
            if (closed) return;
            input.audit?.emit("ws.closed", {
              ...auditFields(active),
              closeCode,
            });
            if (identity.purpose === "signaling")
              input.signaling.disconnect(active.id);
            else if (active.awarenessIds.size) {
              const state = awareness(identity.roomId),
                ids = [...active.awarenessIds];
              awarenessProtocol.removeAwarenessStates(state, ids, "disconnect");
              const bytes = encodeCollaborationFrame({
                type: "awareness",
                data: awarenessProtocol.encodeAwarenessUpdate(state, ids),
              });
              for (const peer of connections)
                if (
                  peer.identity.roomId === identity.roomId &&
                  peer.identity.purpose === "collaboration"
                )
                  binary(peer, bytes);
            }
          });
        });
      } catch (error) {
        const status = error instanceof ApiFailure ? error.status : 400;
        socket.write(
          `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
        socket.destroy();
      }
    },
    closeSession(sessionId: string) {
      closeWhere((active) => active.identity.sessionId === sessionId);
    },
    disconnectCollaboration(userId: string) {
      for (const active of connections)
        if (
          active.identity.user.id === userId &&
          active.identity.purpose === "collaboration"
        )
          active.socket.terminate();
    },
    closeRoom(roomId: string) {
      input.signaling.notifyRoomEnded(roomId);
      closeWhere((active) => active.identity.roomId === roomId);
    },
    removeMember(roomId: string, userId: string) {
      closeWhere(
        (active) =>
          active.identity.roomId === roomId &&
          active.identity.user.id === userId,
      );
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      for (const active of connections) {
        input.audit?.emit("ws.closed", auditFields(active));
        active.socket.terminate();
      }
      server.close();
      for (const state of awarenessByRoom.values()) {
        state.doc.destroy();
        state.destroy();
      }
      input.repository.close();
    },
  };
  function receiveSignaling(active: Active, data: RawData) {
    const raw = Buffer.from(asBytes(data)).toString("utf8");
    if (Buffer.byteLength(raw) > 64 * 1024)
      throw new ApiFailure(
        413,
        "quota-exceeded",
        "signaling message too large",
      );
    const message = JSON.parse(raw) as {
      roomId?: unknown;
      role?: unknown;
      connectionId?: unknown;
      kind?: unknown;
      joinCode?: unknown;
    };
    if (
      message.roomId !== active.identity.roomId ||
      message.role !== active.identity.role ||
      message.connectionId !== active.id
    )
      throw new ApiFailure(403, "forbidden", "signaling identity mismatch");
    // Ticket membership authorizes join; caller-provided role and invitation never grant identity.
    if (message.kind === "join")
      message.joinCode = input.rooms.get(active.identity.roomId)?.joinCode;
    input.signaling.receive(
      {
        id: active.id,
        send: (raw) => {
          if (active.socket.readyState === WebSocket.OPEN)
            active.socket.send(raw);
        },
      },
      JSON.stringify(message),
    );
  }
  function receiveCollaboration(
    active: Active,
    data: RawData,
    isBinary: boolean,
  ) {
    if (!isBinary)
      throw new ApiFailure(
        400,
        "bad-message",
        "collaboration requires binary frames",
      );
    const frame = decodeCollaborationFrame(asBytes(data)),
      identity = active.identity,
      current = input.repository.get(identity.roomId, identity.epoch);
    if (frame.type === "state-vector") {
      binary(
        active,
        encodeCollaborationFrame({
          type: "sync",
          epoch: identity.epoch,
          persistedRevision: current.revision,
          data: Y.encodeStateAsUpdate(current.doc, frame.data),
        }),
      );
      binary(
        active,
        encodeCollaborationFrame({
          type: "state-vector",
          data: Y.encodeStateVector(current.doc),
        }),
      );
      return;
    }
    if (frame.type === "sync")
      throw new ApiFailure(
        400,
        "bad-message",
        "client sync writes must use durable update frames",
      );
    if (frame.type === "update") {
      input.audit?.emit("update.received", {
        ...auditFields(active),
        updateId: frame.updateId,
      });
      if (frame.epoch !== identity.epoch)
        throw new ApiFailure(409, "epoch-mismatch", "document epoch changed");
      try {
        const result = input.repository.commit({
          roomId: identity.roomId,
          ...frame,
        });
        input.audit?.emit(
          result.duplicate ? "update.duplicate" : "update.committed",
          {
            ...auditFields(active),
            updateId: frame.updateId,
            persistedRevision: result.revision,
          },
        );
        if (!result.duplicate) {
          const bytes = encodeCollaborationFrame({
            type: "sync",
            epoch: identity.epoch,
            persistedRevision: result.revision,
            data: frame.data,
          });
          for (const peer of connections)
            if (
              peer !== active &&
              peer.identity.roomId === identity.roomId &&
              peer.identity.purpose === "collaboration"
            ) {
              try {
                check(peer);
                binary(peer, bytes);
              } catch {
                peer.socket.close(4003, "authorization revoked");
              }
            }
        }
        const enqueued = send(active, {
          type: "ack",
          updateId: frame.updateId,
          persistedRevision: result.revision,
        });
        if (enqueued)
          input.audit?.emit("ack.enqueued", {
            ...auditFields(active),
            updateId: frame.updateId,
            persistedRevision: result.revision,
          });
      } catch (error) {
        const failure =
          error instanceof ApiFailure
            ? error
            : new ApiFailure(500, "storage-failed", "update was not saved");
        input.audit?.emit("update.rejected", {
          ...auditFields(active),
          updateId: frame.updateId,
          code: failure.code,
        });
        send(active, {
          type: "error",
          code: failure.code,
          message: failure.message,
          updateId: frame.updateId,
          fatal: failure.code === "epoch-mismatch",
          epoch: identity.epoch,
        });
      }
      return;
    }
    if (frame.data.byteLength > 16 * 1024)
      throw new ApiFailure(413, "quota-exceeded", "awareness too large");
    if (Date.now() - active.windowStart > 1000) {
      active.windowStart = Date.now();
      active.messages = 0;
    }
    if (++active.messages > 50)
      throw new ApiFailure(
        429,
        "rate-limited",
        "presence update rate exceeded",
      );
    const state = awareness(identity.roomId),
      decoder = decoding.createDecoder(frame.data),
      encoder = encoding.createEncoder(),
      count = decoding.readVarUint(decoder);
    if (count > 8)
      throw new ApiFailure(400, "bad-message", "too many awareness clients");
    encoding.writeVarUint(encoder, count);
    for (let index = 0; index < count; index++) {
      const clientId = decoding.readVarUint(decoder),
        clock = decoding.readVarUint(decoder),
        raw = decoding.readVarString(decoder);
      if (
        [...connections].some(
          (peer) =>
            peer !== active &&
            peer.identity.roomId === identity.roomId &&
            peer.awarenessIds.has(clientId),
        )
      )
        throw new ApiFailure(
          403,
          "forbidden",
          "awareness client belongs to another connection",
        );
      const value = JSON.parse(raw) as unknown;
      if (value !== null && (typeof value !== "object" || Array.isArray(value)))
        throw new ApiFailure(400, "bad-message", "invalid awareness state");
      if (!active.awarenessIds.has(clientId) && active.awarenessIds.size >= 8)
        throw new ApiFailure(
          400,
          "bad-message",
          "connection awareness client budget exceeded",
        );
      active.awarenessIds.add(clientId);
      // Presence display identity is supplied by the authenticated server.
      const authorized =
        value === null
          ? null
          : {
              ...value,
              user: {
                name: identity.user.displayName,
                displayName: identity.user.displayName,
                role: identity.role,
              },
            };
      encoding.writeVarUint(encoder, clientId);
      encoding.writeVarUint(encoder, clock);
      encoding.writeVarString(encoder, JSON.stringify(authorized));
    }
    if (decoding.hasContent(decoder))
      throw new ApiFailure(400, "bad-message", "trailing awareness bytes");
    const authorizedData = encoding.toUint8Array(encoder);
    awarenessProtocol.applyAwarenessUpdate(state, authorizedData, active.id);
    for (const peer of connections)
      if (
        peer !== active &&
        peer.identity.roomId === identity.roomId &&
        peer.identity.purpose === "collaboration"
      ) {
        try {
          check(peer);
          binary(
            peer,
            encodeCollaborationFrame({
              type: "awareness",
              data: authorizedData,
            }),
          );
        } catch {
          peer.socket.close(4003, "authorization revoked");
        }
      }
  }
}
function auditFields(active: Active) {
  return {
    requestId: active.requestId,
    sessionId: active.identity.sessionId,
    roomId: active.identity.roomId,
    connectionId: active.id,
    epoch: active.identity.epoch,
    purpose: active.identity.purpose,
  };
}
function asBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
