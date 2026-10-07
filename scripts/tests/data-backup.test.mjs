import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { backupData, restoreData, verifyBackup } from "../data-backup.mjs";

const requireApi = createRequire(
  new URL("../../apps/api/package.json", import.meta.url),
);
const Database = requireApi("better-sqlite3");
const secret = "backup-exercise-secret-at-least-thirty-two-bytes";
const base = "http://localhost";
const execute = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codetape-backup-"));
  const source = join(root, "source");
  await mkdir(source, { mode: 0o700 });
  await mkdir(join(source, "objects"), { mode: 0o700 });
  const db = new Database(join(source, "code-tape.sqlite"));
  db.exec(
    "CREATE TABLE stored_objects(object_key TEXT PRIMARY KEY, size_bytes INTEGER NOT NULL)",
  );
  db.close();
  await writeFile(join(source, "auth-secret"), secret, { mode: 0o600 });
  return {
    root,
    source,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("maintenance backup and restore preserve a real account, signing key and private HTTP asset bytes", async () => {
  const { createSecureRuntime } =
    await import("../../apps/api/dist/demo/secureRuntime.js");
  const root = await mkdtemp(join(tmpdir(), "codetape-runtime-backup-"));
  const source = join(root, "source"),
    backup = join(root, "backup"),
    restored = join(root, "restored");
  await mkdir(source, { mode: 0o700 });
  await writeFile(join(source, "auth-secret"), secret, { mode: 0o600 });
  let runtime = createSecureRuntime({
    dataDirectory: source,
    authSecret: secret,
  });
  let nextRuntime;
  try {
    const registered = await runtime.handler(
      new Request(`${base}/api/auth/register`, {
        method: "POST",
        headers: {
          origin: base,
          "content-type": "application/json",
          "x-code-tape-client": "web",
        },
        body: JSON.stringify({
          username: "backup-user",
          password: "temporary-password-only",
        }),
      }),
    );
    assert.equal(registered.status, 201);
    const login = await registered.json();
    const ownerRequest = new Request(`${base}/api/auth/me`, {
      headers: { authorization: `Bearer ${login.accessToken}` },
    });
    const identity = await runtime.auth.authenticate(ownerRequest);
    const body = new TextEncoder().encode("private-object-backup-bytes");
    const objectKey = "private/recording-backup/media";
    await runtime.storage.putObject({
      key: objectKey,
      body,
      contentType: "video/webm",
    });
    const now = new Date().toISOString();
    const recording = {
      id: "recording-backup",
      ownerId: login.user.id,
      localPackageId: "backup-fixture",
      title: "Private backup fixture",
      schemaVersion: "0.2.0",
      status: "ready",
      visibility: "private",
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      deletedAt: null,
      durationMs: 1000,
      initialLanguage: "javascript",
      hasAudio: true,
      hasCamera: false,
      totalSizeBytes: body.byteLength,
      eventCount: 0,
      snapshotCount: 0,
      failureCode: null,
      failureMessage: null,
    };
    const asset = {
      id: "asset-backup",
      recordingId: recording.id,
      kind: "media",
      objectKey,
      sha256: createHash("sha256")
        .update(Buffer.from(body).toString("base64"))
        .digest("hex"),
      sizeBytes: body.byteLength,
      mimeType: "video/webm",
      uploadedAt: now,
      validatedAt: now,
    };
    runtime.db
      .prepare(
        "INSERT INTO recordings(id,owner_id,status,payload) VALUES(?,?,?,?)",
      )
      .run(
        recording.id,
        recording.ownerId,
        recording.status,
        JSON.stringify(recording),
      );
    runtime.db
      .prepare(
        "INSERT INTO recording_assets(id,recording_id,kind,payload) VALUES(?,?,?,?)",
      )
      .run(asset.id, recording.id, asset.kind, JSON.stringify(asset));
    const grant = "backup-exercise-private-grant";
    runtime.db
      .prepare(
        "INSERT INTO playback_grants(hash,recording_id,session_id,expires_at) VALUES(?,?,?,?)",
      )
      .run(
        createHash("sha256").update(grant).digest("hex"),
        recording.id,
        identity.sessionId,
        Date.now() + 60_000,
      );
    runtime.close();
    runtime = null;
    const before = await readFile(join(source, "code-tape.sqlite"));
    const created = await backupData(source, backup);
    assert.equal(created.manifest.authSecretIncluded, true);
    assert.ok(
      created.manifest.files.some((file) => file.path.startsWith("objects/")),
    );
    assert.equal((await stat(backup)).mode & 0o777, 0o700);
    assert.equal((await stat(join(backup, "auth-secret"))).mode & 0o777, 0o600);
    assert.deepEqual(await readFile(join(source, "code-tape.sqlite")), before);
    await verifyBackup(backup);
    await restoreData(backup, restored);
    nextRuntime = createSecureRuntime({
      dataDirectory: restored,
      authSecret: (
        await readFile(join(restored, "auth-secret"), "utf8")
      ).trim(),
    });
    const me = await nextRuntime.handler(ownerRequest);
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.id, login.user.id);
    const actual = await nextRuntime.handler(
      new Request(
        `${base}/api/playback-assets/${recording.id}/media?grant=${grant}`,
      ),
    );
    assert.equal(actual.status, 200);
    assert.deepEqual(new Uint8Array(await actual.arrayBuffer()), body);
    const range = await nextRuntime.handler(
      new Request(
        `${base}/api/playback-assets/${recording.id}/media?grant=${grant}`,
        { headers: { range: "bytes=0-6" } },
      ),
    );
    assert.equal(range.status, 206);
    assert.equal(await range.text(), "private");
  } finally {
    runtime?.close();
    nextRuntime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("backup and restore refuse existing destinations and ancestor/descendant paths", async () => {
  const data = await fixture();
  try {
    const backup = join(data.root, "backup");
    await backupData(data.source, backup);
    const original = await readFile(join(backup, "backup-manifest.json"));
    await assert.rejects(backupData(data.source, backup), /already exists/u);
    assert.deepEqual(
      await readFile(join(backup, "backup-manifest.json")),
      original,
    );
    await assert.rejects(
      backupData(data.source, join(data.source, "child")),
      /contain/u,
    );
    await assert.rejects(backupData(data.source, data.root), /contain/u);
    await assert.rejects(restoreData(backup, data.source), /already exists/u);
    await assert.rejects(
      restoreData(backup, join(backup, "child")),
      /contain/u,
    );
  } finally {
    await data.cleanup();
  }
});

test("SQLite backup includes committed WAL data and external secret dependence is explicit", async () => {
  const data = await fixture();
  const db = new Database(join(data.source, "code-tape.sqlite"));
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    const key = "private/wal-object";
    const name = createHash("sha256").update(key).digest("hex");
    await writeFile(join(data.source, "objects", name), "WAL", { mode: 0o600 });
    db.prepare(
      "INSERT INTO stored_objects(object_key,size_bytes) VALUES(?,?)",
    ).run(key, 3);
    assert.ok((await stat(join(data.source, "code-tape.sqlite-wal"))).size > 0);
    await unlink(join(data.source, "auth-secret"));
    const backup = join(data.root, "backup");
    const result = await backupData(data.source, backup);
    assert.equal(result.manifest.authSecretIncluded, false);
    const snapshot = new Database(join(backup, "code-tape.sqlite"), {
      readonly: true,
    });
    try {
      assert.equal(
        snapshot.prepare("SELECT count(*) count FROM stored_objects").get()
          .count,
        1,
      );
    } finally {
      snapshot.close();
    }
    await verifyBackup(backup);
  } finally {
    db.close();
    await data.cleanup();
  }
});

test("a corrupted backup is rejected before any restore destination is created", async () => {
  const data = await fixture();
  try {
    const backup = join(data.root, "backup"),
      restored = join(data.root, "rejected");
    await backupData(data.source, backup);
    await writeFile(join(backup, "auth-secret"), "corrupted-secret");
    await assert.rejects(verifyBackup(backup), /checksum/u);
    await assert.rejects(restoreData(backup, restored), /checksum/u);
    await assert.rejects(access(restored), { code: "ENOENT" });
    assert.equal(
      await readFile(join(data.source, "auth-secret"), "utf8"),
      secret,
    );
  } finally {
    await data.cleanup();
  }
});

test("CLI verifies and restores a new private directory without logging signing secrets", async () => {
  const data = await fixture();
  try {
    const script = fileURLToPath(
      new URL("../data-backup.mjs", import.meta.url),
    );
    const backup = join(data.root, "cli-backup"),
      restored = join(data.root, "cli-restored");
    const created = await execute(process.execPath, [
      script,
      "backup",
      data.source,
      backup,
    ]);
    assert.equal(JSON.parse(created.stdout).operation, "backup");
    assert.ok(!created.stdout.includes(secret));
    const verified = await execute(process.execPath, [
      script,
      "verify",
      backup,
    ]);
    assert.equal(JSON.parse(verified.stdout).operation, "verify");
    const copied = await execute(process.execPath, [
      script,
      "restore",
      backup,
      restored,
    ]);
    assert.equal(
      JSON.parse(copied.stdout).destination,
      await realpath(restored),
    );
    assert.equal((await stat(restored)).mode & 0o777, 0o700);
    await assert.rejects(
      execute(process.execPath, [script, "restore", backup, restored]),
    );
  } finally {
    await data.cleanup();
  }
});

test("symlink assets and path traversal entries are rejected", async () => {
  const data = await fixture();
  try {
    const backup = join(data.root, "backup");
    await backupData(data.source, backup);
    const manifestPath = join(backup, "backup-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.files.push({
      path: "objects/../../outside",
      sizeBytes: 0,
      sha256: "0".repeat(64),
    });
    const bytes = JSON.stringify(manifest);
    await writeFile(manifestPath, bytes);
    await writeFile(
      join(backup, "backup-manifest.sha256"),
      createHash("sha256").update(bytes).digest("hex"),
    );
    await assert.rejects(verifyBackup(backup), /file entry/u);
    const outside = join(data.root, "outside");
    await writeFile(outside, "private outside content");
    await symlink(outside, join(data.source, "objects", "alias"));
    await assert.rejects(
      backupData(data.source, join(data.root, "symlink-rejected")),
      /Symbolic links/u,
    );
    assert.equal(await readFile(outside, "utf8"), "private outside content");
  } finally {
    await data.cleanup();
  }
});
