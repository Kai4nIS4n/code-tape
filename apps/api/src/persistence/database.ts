import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AppDatabase = Database.Database;

export function openAppDatabase(path: string): AppDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, display_name TEXT NOT NULL, disabled_at INTEGER);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      expires_at INTEGER NOT NULL, revoked_at INTEGER);
    CREATE TABLE IF NOT EXISTS refresh_tokens(hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
      consumed_at INTEGER, replaced_by TEXT);
    CREATE TABLE IF NOT EXISTS interview_rooms(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS room_members(room_id TEXT NOT NULL REFERENCES interview_rooms(id),
      user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL, revoked_at INTEGER,
      PRIMARY KEY(room_id,user_id), UNIQUE(room_id,role));
    CREATE TABLE IF NOT EXISTS room_invites(hash TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES interview_rooms(id),
      expires_at INTEGER NOT NULL, consumed_by TEXT);
    CREATE TABLE IF NOT EXISTS ws_tickets(hash TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES interview_rooms(id),
      user_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), purpose TEXT NOT NULL,
      expires_at INTEGER NOT NULL, consumed_at INTEGER);
    CREATE TABLE IF NOT EXISTS collaborative_documents(room_id TEXT NOT NULL REFERENCES interview_rooms(id),
      epoch INTEGER NOT NULL, state BLOB NOT NULL, covered_revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(room_id,epoch));
    CREATE TABLE IF NOT EXISTS collaborative_updates(room_id TEXT NOT NULL, epoch INTEGER NOT NULL,
      revision INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(room_id,epoch,revision));
    CREATE TABLE IF NOT EXISTS update_receipts(room_id TEXT NOT NULL, epoch INTEGER NOT NULL,
      update_id TEXT NOT NULL, update_hash TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY(room_id,epoch,update_id));
    CREATE TABLE IF NOT EXISTS recordings(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS recording_assets(id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES recordings(id),
      kind TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(recording_id,kind));
    CREATE TABLE IF NOT EXISTS upload_sessions(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(owner_id,idempotency_key));
    CREATE TABLE IF NOT EXISTS share_links(id TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES recordings(id),
      token_hash TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS playback_grants(hash TEXT PRIMARY KEY, recording_id TEXT NOT NULL REFERENCES recordings(id),
      session_id TEXT, share_id TEXT, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS upload_targets(hash TEXT PRIMARY KEY, object_key TEXT NOT NULL,
      mime_type TEXT NOT NULL, max_size INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER, session_id TEXT);
    CREATE TABLE IF NOT EXISTS stored_objects(object_key TEXT PRIMARY KEY, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS recordings_owner ON recordings(owner_id,status);
    INSERT OR IGNORE INTO schema_migrations(version) VALUES(1);
  `);
  // Connections belong to a process, not to durable room membership.
  for (const row of db
    .prepare("SELECT id,payload FROM interview_rooms")
    .all() as Array<{ id: string; payload: string }>) {
    const room = JSON.parse(row.payload) as Record<string, unknown>;
    room.candidateConnectionId = null;
    room.interviewerConnectionId = null;
    // Older task snapshots duplicated an invitation capability in room JSON.
    // Keep its hash in room_invites, but scrub the plaintext mirror.
    delete room.joinCode;
    if (room.status === "live" || room.status === "connecting")
      room.status = "waiting";
    db.prepare("UPDATE interview_rooms SET payload=? WHERE id=?").run(
      JSON.stringify(room),
      row.id,
    );
  }
  return db;
}

export function readPayload<T>(
  db: AppDatabase,
  sql: string,
  ...params: unknown[]
): T | null {
  const row = db.prepare(sql).get(...params) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as T) : null;
}
