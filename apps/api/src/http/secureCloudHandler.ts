import {
  ApiFailure,
  randomToken,
  tokenHash,
  type AccountAuthService,
  type AccountIdentity,
} from "../auth/accountAuthService.js";
import { apiError, json } from "../auth/authApiHandler.js";
import type { AppDatabase } from "../persistence/database.js";
import { readPayload } from "../persistence/database.js";
import type { MetadataRepository } from "../cloud/metadataRepository.js";
import type { PrivateDiskObjectStorage } from "../cloud/privateDiskObjectStorage.js";
import type {
  CloudPlaybackDescriptor,
  CloudRecordingShareLinkRecord,
  UploadSessionRecord,
} from "../cloud/types.js";
import type { CloudApiHandler } from "./cloudApiHandler.js";

export function createSecureCloudHandler(input: {
  db: AppDatabase;
  metadata: MetadataRepository;
  storage: PrivateDiskObjectStorage;
  auth: AccountAuthService;
  cloud: CloudApiHandler;
  publicBaseUrl?: string;
  now?: () => number;
}) {
  const db = input.db,
    now = input.now ?? Date.now,
    base = (input.publicBaseUrl ?? "").replace(/\/+$/u, "");
  async function requireIdentity(request: Request) {
    const identity = await input.auth.authenticate(request);
    if (!identity)
      throw new ApiFailure(401, "unauthorized", "sign in required");
    return identity;
  }
  function grant(
    recordingId: string,
    source: { sessionId?: string; shareId?: string },
  ) {
    const raw = randomToken(),
      expiresAt = now() + 5 * 60 * 1000;
    db.prepare(
      "INSERT INTO playback_grants(hash,recording_id,session_id,share_id,expires_at) VALUES(?,?,?,?,?)",
    ).run(
      tokenHash(raw),
      recordingId,
      source.sessionId ?? null,
      source.shareId ?? null,
      expiresAt,
    );
    return { raw, expiresAt };
  }
  function activeShare(id: string) {
    const value = readPayload<CloudRecordingShareLinkRecord>(
      db,
      "SELECT payload FROM share_links WHERE id=?",
      id,
    );
    return value &&
      value.revokedAt === null &&
      (value.expiresAt === null || Date.parse(value.expiresAt) > now())
      ? value
      : null;
  }
  async function asset(request: Request, recordingId: string, kind: string) {
    const raw = new URL(request.url).searchParams.get("grant") ?? "",
      ticket = db
        .prepare(
          "SELECT * FROM playback_grants WHERE hash=? AND recording_id=?",
        )
        .get(tokenHash(raw), recordingId) as
        | {
            session_id: string | null;
            share_id: string | null;
            expires_at: number;
          }
        | undefined;
    const recording = await input.metadata.getRecording(recordingId);
    if (!ticket || ticket.expires_at <= now() || recording?.status !== "ready")
      throw new ApiFailure(403, "forbidden", "playback grant unavailable");
    if (ticket.session_id) {
      const owner = input.auth.activeSession(ticket.session_id);
      if (!owner || owner.user.id !== recording.ownerId)
        throw new ApiFailure(403, "forbidden", "playback session revoked");
    } else if (
      !ticket.share_id ||
      activeShare(ticket.share_id)?.recordingId !== recordingId
    )
      throw new ApiFailure(403, "forbidden", "share revoked");
    const item = (await input.metadata.listAssets(recordingId)).find(
      (item) => item.kind === kind && item.validatedAt !== null,
    );
    if (!item) throw new ApiFailure(404, "not-found", "asset unavailable");
    return input.storage.stream(item.objectKey, request);
  }
  async function rewriteDescriptor(
    response: Response,
    identity: AccountIdentity | null,
    shareToken: string | null,
  ) {
    if (!response.ok) return response;
    const descriptor = (await response.json()) as CloudPlaybackDescriptor;
    let share: CloudRecordingShareLinkRecord | null = null;
    if (shareToken)
      share = await input.metadata.findShareLinkByTokenHash(
        tokenHash(shareToken),
      );
    const ticket = grant(
      descriptor.id,
      identity ? { sessionId: identity.sessionId } : { shareId: share!.id },
    );
    const fields = {
      manifestUrl: "manifest",
      metaUrl: "meta",
      eventsUrl: "events",
      snapshotsUrl: "snapshots",
      indexesUrl: "indexes",
      mediaUrl: "media",
      thumbnailUrl: "thumbnail",
    } as const;
    for (const [field, kind] of Object.entries(fields))
      if (descriptor[field as keyof typeof fields])
        descriptor[field as keyof typeof fields] =
          `${base}/api/playback-assets/${encodeURIComponent(descriptor.id)}/${kind}?grant=${ticket.raw}`;
    descriptor.expiresAt = new Date(ticket.expiresAt).toISOString();
    return json(descriptor);
  }
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url),
        path = url.pathname;
      if (path.startsWith("/dev/object-storage/") || path === "/api/auth/token")
        throw new ApiFailure(404, "not-found", "route not found");
      const assetMatch = /^\/api\/playback-assets\/([^/]+)\/([^/]+)$/u.exec(
        path,
      );
      if (assetMatch && (request.method === "GET" || request.method === "HEAD"))
        return await asset(
          request,
          decodeURIComponent(assetMatch[1]!),
          assetMatch[2]!,
        );
      const uploadMatch = /^\/api\/uploads\/([^/]+)$/u.exec(path);
      if (uploadMatch && request.method === "PUT") {
        const hash = tokenHash(uploadMatch[1]!),
          target = db
            .prepare("SELECT * FROM upload_targets WHERE hash=?")
            .get(hash) as
            | {
                object_key: string;
                mime_type: string;
                max_size: number;
                expires_at: number;
                consumed_at: number | null;
                session_id: string | null;
              }
            | undefined;
        if (
          !target ||
          target.expires_at <= now() ||
          !target.session_id ||
          !input.auth.activeSession(target.session_id)
        )
          throw new ApiFailure(
            403,
            "forbidden",
            "upload authorization unavailable",
          );
        if (target.consumed_at !== null)
          throw new ApiFailure(
            409,
            "upload-session-conflict",
            "upload credential already consumed",
          );
        const identity = input.auth.activeSession(target.session_id)!,
          recordingId = db
            .prepare(
              "SELECT recording_id FROM recording_assets WHERE json_extract(payload,'$.objectKey')=?",
            )
            .get(target.object_key) as { recording_id: string } | undefined;
        const recording = recordingId
          ? await input.metadata.getRecording(recordingId.recording_id)
          : null;
        if (
          !recording ||
          recording.ownerId !== identity.user.id ||
          recording.status !== "uploading"
        )
          throw new ApiFailure(403, "forbidden", "upload session closed");
        const upload = readPayload<UploadSessionRecord>(
          db,
          "SELECT payload FROM upload_sessions WHERE json_extract(payload,'$.recordingId')=?",
          recording.id,
        );
        if (
          !upload ||
          upload.status !== "open" ||
          Date.parse(upload.expiresAt) <= now()
        )
          throw new ApiFailure(
            410,
            "upload-session-expired",
            "upload session expired",
          );
        const body = new Uint8Array(await request.arrayBuffer());
        if (
          body.byteLength !== target.max_size ||
          request.headers.get("content-type") !== target.mime_type
        )
          throw new ApiFailure(
            400,
            "bad-request",
            "asset size or type differs from upload plan",
          );
        const claimed = db
          .prepare(
            "UPDATE upload_targets SET consumed_at=? WHERE hash=? AND consumed_at IS NULL",
          )
          .run(now(), hash);
        if (!claimed.changes)
          throw new ApiFailure(
            409,
            "upload-session-conflict",
            "upload credential already consumed",
          );
        try {
          await input.storage.putObject({
            key: target.object_key,
            body,
            contentType: target.mime_type,
          });
        } catch (error) {
          db.prepare(
            "UPDATE upload_targets SET consumed_at=NULL WHERE hash=?",
          ).run(hash);
          throw error;
        }
        return new Response(null, { status: 204 });
      }
      const links =
        /^\/api\/recordings\/([^/]+)\/share-links(?:\/([^/]+))?$/u.exec(path);
      if (links && (request.method === "GET" || request.method === "DELETE")) {
        const identity = await requireIdentity(request),
          recording = await input.metadata.getRecording(
            decodeURIComponent(links[1]!),
          );
        if (!recording || recording.ownerId !== identity.user.id)
          throw new ApiFailure(404, "not-found", "recording not found");
        if (request.method === "GET")
          return json({
            items: (
              db
                .prepare("SELECT payload FROM share_links WHERE recording_id=?")
                .all(recording.id) as Array<{ payload: string }>
            ).map((row) => {
              const { tokenHash: _hash, ...rest } = JSON.parse(
                row.payload,
              ) as CloudRecordingShareLinkRecord;
              return rest;
            }),
          });
        if (links[2]) {
          const link = readPayload<CloudRecordingShareLinkRecord>(
            db,
            "SELECT payload FROM share_links WHERE id=? AND recording_id=?",
            decodeURIComponent(links[2]),
            recording.id,
          );
          if (!link) throw new ApiFailure(404, "not-found", "share not found");
          db.prepare("UPDATE share_links SET payload=? WHERE id=?").run(
            JSON.stringify({
              ...link,
              revokedAt: new Date(now()).toISOString(),
            }),
            link.id,
          );
        } else
          await input.metadata.revokeShareLinksByRecordingId({
            recordingId: recording.id,
            revokedAt: new Date(now()).toISOString(),
          });
        return json({ ok: true });
      }
      const ownerPlayback = /^\/api\/recordings\/([^/]+)\/playback$/u.exec(
          path,
        ),
        sharedPlayback = /^\/api\/share\/([^/]+)\/playback$/u.exec(path);
      if (request.method === "GET" && (ownerPlayback || sharedPlayback)) {
        const identity = ownerPlayback ? await requireIdentity(request) : null;
        return await rewriteDescriptor(
          await input.cloud(request),
          identity,
          sharedPlayback ? decodeURIComponent(sharedPlayback[1]!) : null,
        );
      }
      if (
        request.method === "POST" &&
        path === "/api/recordings/upload-sessions"
      ) {
        await requireIdentity(request);
        let plan: unknown;
        try {
          plan = await request.clone().json();
        } catch {
          throw new ApiFailure(400, "bad-request", "invalid JSON");
        }
        if (
          plan &&
          typeof plan === "object" &&
          Array.isArray((plan as { assets?: unknown }).assets)
        ) {
          for (const asset of (plan as { assets: unknown[] }).assets)
            assertSafeAssetMime(asset);
        }
      }
      const response = await input.cloud(request);
      if (
        response.ok &&
        request.method === "POST" &&
        path === "/api/recordings/upload-sessions"
      ) {
        const identity = await requireIdentity(request),
          body = (await response.clone().json()) as {
            uploadTargets: Array<{ url: string }>;
          };
        for (const target of body.uploadTargets) {
          const token = new URL(target.url, url).pathname.split("/").at(-1)!;
          db.prepare("UPDATE upload_targets SET session_id=? WHERE hash=?").run(
            identity.sessionId,
            tokenHash(token),
          );
        }
      }
      if (
        response.ok &&
        request.method === "GET" &&
        path === "/api/recordings"
      ) {
        const identity = await requireIdentity(request),
          body = (await response.json()) as {
            items: Array<{ id: string; thumbnailUrl: string | null }>;
          };
        for (const item of body.items)
          if (item.thumbnailUrl) {
            const ticket = grant(item.id, { sessionId: identity.sessionId });
            item.thumbnailUrl = `${base}/api/playback-assets/${encodeURIComponent(item.id)}/thumbnail?grant=${ticket.raw}`;
          }
        return json(body);
      }
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      headers.set("referrer-policy", "no-referrer");
      return new Response(response.body, { status: response.status, headers });
    } catch (error) {
      return apiError(error);
    }
  };
}

function assertSafeAssetMime(value: unknown) {
  if (!value || typeof value !== "object") return;
  const asset = value as { kind?: unknown; mimeType?: unknown };
  if (typeof asset.kind !== "string" || typeof asset.mimeType !== "string")
    return;
  const mime = asset.mimeType.split(";", 1)[0]!.trim().toLowerCase();
  const allowed =
    asset.kind === "media"
      ? ["video/webm", "audio/webm"]
      : asset.kind === "thumbnail"
        ? ["image/png", "image/jpeg", "image/webp"]
        : ["manifest", "meta", "events", "snapshots", "indexes"].includes(
              asset.kind,
            )
          ? ["application/json"]
          : null;
  if (allowed && !allowed.includes(mime))
    throw new ApiFailure(
      415,
      "media-type-not-supported",
      "asset MIME type is not supported",
    );
}
