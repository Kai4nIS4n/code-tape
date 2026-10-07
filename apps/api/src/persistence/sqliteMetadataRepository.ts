import type { MetadataRepository } from "../cloud/metadataRepository.js";
import type {
  CloudRecordingRecord,
  CloudRecordingAssetRecord,
  CloudRecordingShareLinkRecord,
  UploadSessionRecord,
} from "../cloud/types.js";
import { readPayload, type AppDatabase } from "./database.js";

export function createSqliteMetadataRepository(
  db: AppDatabase,
): MetadataRepository {
  const recording = (id: string) =>
    readPayload<CloudRecordingRecord>(
      db,
      "SELECT payload FROM recordings WHERE id=?",
      id,
    );
  const session = (id: string) =>
    readPayload<UploadSessionRecord>(
      db,
      "SELECT payload FROM upload_sessions WHERE id=?",
      id,
    );
  const saveRecording = (value: CloudRecordingRecord) => {
    db.prepare(
      "INSERT INTO recordings(id,owner_id,status,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,status=excluded.status,payload=excluded.payload",
    ).run(value.id, value.ownerId, value.status, JSON.stringify(value));
  };
  const assets = (id: string) =>
    (
      db
        .prepare("SELECT payload FROM recording_assets WHERE recording_id=?")
        .all(id) as Array<{ payload: string }>
    ).map((row) => JSON.parse(row.payload) as CloudRecordingAssetRecord);
  return {
    async getRecording(id) {
      return recording(id);
    },
    async getSession(id) {
      return session(id);
    },
    async findSessionByOwnerAndIdempotencyKey(ownerId, key) {
      return readPayload(
        db,
        "SELECT payload FROM upload_sessions WHERE owner_id=? AND idempotency_key=?",
        ownerId,
        key,
      );
    },
    async listRecordingsByOwner(input) {
      const values = (
        db
          .prepare("SELECT payload FROM recordings WHERE owner_id=?")
          .all(input.ownerId) as Array<{ payload: string }>
      ).map((row) => JSON.parse(row.payload) as CloudRecordingRecord);
      return values
        .filter(
          (item) => !input.statuses || input.statuses.includes(item.status),
        )
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    },
    async listAssets(id) {
      return assets(id);
    },
    async createUpload(input) {
      return db.transaction(() => {
        const existing = readPayload<UploadSessionRecord>(
          db,
          "SELECT payload FROM upload_sessions WHERE owner_id=? AND idempotency_key=?",
          input.session.ownerId,
          input.session.idempotencyKey,
        );
        if (existing)
          return {
            status: "idempotency-key-exists" as const,
            existingSession: existing,
          };
        saveRecording(input.recording);
        for (const item of input.assets)
          db.prepare(
            "INSERT INTO recording_assets(id,recording_id,kind,payload) VALUES(?,?,?,?)",
          ).run(item.id, item.recordingId, item.kind, JSON.stringify(item));
        db.prepare(
          "INSERT INTO upload_sessions(id,owner_id,idempotency_key,payload) VALUES(?,?,?,?)",
        ).run(
          input.session.id,
          input.session.ownerId,
          input.session.idempotencyKey,
          JSON.stringify(input.session),
        );
        return { status: "created" as const };
      })();
    },
    async createShareLink(value) {
      const result = db
        .prepare(
          "INSERT OR IGNORE INTO share_links(id,recording_id,token_hash,payload) VALUES(?,?,?,?)",
        )
        .run(
          value.id,
          value.recordingId,
          value.tokenHash,
          JSON.stringify(value),
        );
      return {
        status: result.changes
          ? ("created" as const)
          : ("token-hash-exists" as const),
      };
    },
    async findShareLinkByTokenHash(hash) {
      return readPayload(
        db,
        "SELECT payload FROM share_links WHERE token_hash=?",
        hash,
      );
    },
    async revokeShareLinksByRecordingId(input) {
      const values = db
        .prepare("SELECT id,payload FROM share_links WHERE recording_id=?")
        .all(input.recordingId) as Array<{ id: string; payload: string }>;
      db.transaction(() => {
        for (const row of values) {
          const link = JSON.parse(row.payload) as CloudRecordingShareLinkRecord;
          if (link.revokedAt === null)
            db.prepare("UPDATE share_links SET payload=? WHERE id=?").run(
              JSON.stringify({ ...link, revokedAt: input.revokedAt }),
              row.id,
            );
        }
      })();
    },
    async markUploadCompleted(input) {
      db.transaction(() => {
        const upload = session(input.sessionId);
        if (!upload) return;
        const value = recording(upload.recordingId);
        if (value?.status !== "uploading") return;
        db.prepare("UPDATE upload_sessions SET payload=? WHERE id=?").run(
          JSON.stringify({
            ...upload,
            status: "completed",
            completedAt: input.completedAt,
          }),
          upload.id,
        );
        saveRecording({
          ...value,
          status: "processing",
          updatedAt: input.completedAt,
        });
        for (const asset of assets(value.id))
          if (input.uploadedAssetKinds.includes(asset.kind))
            db.prepare("UPDATE recording_assets SET payload=? WHERE id=?").run(
              JSON.stringify({ ...asset, uploadedAt: input.completedAt }),
              asset.id,
            );
      })();
    },
    async findNextProcessingRecording() {
      return readPayload(
        db,
        "SELECT payload FROM recordings WHERE status='processing' ORDER BY rowid LIMIT 1",
      );
    },
    async updateRecording(value) {
      saveRecording(value);
    },
    async updateRecordingIfStatus(input) {
      return db.transaction(() => {
        const current = recording(input.recordingId);
        if (!current || current.status !== input.expectedStatus)
          return { status: "status-mismatch" as const, current };
        const updated = { ...current, ...input.patch, id: current.id };
        saveRecording(updated);
        return { status: "updated" as const, recording: updated };
      })();
    },
    async updateAsset(asset) {
      db.prepare("UPDATE recording_assets SET payload=? WHERE id=?").run(
        JSON.stringify(asset),
        asset.id,
      );
    },
  };
}
