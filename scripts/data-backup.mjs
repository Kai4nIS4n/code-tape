import { createHash } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const requireApi = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const Database = requireApi("better-sqlite3");
const DATABASE = "code-tape.sqlite";
const MANIFEST = "backup-manifest.json";
const MANIFEST_HASH = "backup-manifest.sha256";
const TOP_LEVEL = new Set([
  DATABASE,
  "objects",
  "auth-secret",
  MANIFEST,
  MANIFEST_HASH,
]);

function isWithin(parent, child) {
  const part = relative(parent, child);
  return (
    part === "" ||
    (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`))
  );
}

async function sourceDirectory(value) {
  const path = resolve(value);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Source must be a real directory, not a symbolic link");
  return realpath(path);
}

async function newDestination(source, value) {
  const requested = resolve(value);
  const parent = await realpath(dirname(requested));
  const destination = join(parent, basename(requested));
  if (isWithin(source, destination) || isWithin(destination, source))
    throw new Error("Source and destination must not contain one another");
  try {
    await mkdir(destination, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error("Destination already exists; choose a new directory");
    throw error;
  }
  await chmod(destination, 0o700);
  return destination;
}

async function regularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Backup files must be regular files, not symbolic links");
  return info;
}

async function hashFile(path) {
  await regularFile(path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function filesUnder(root, directory = root) {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isSymbolicLink())
      throw new Error("Symbolic links are not supported in backup data");
    if (info.isDirectory()) files.push(...(await filesUnder(root, path)));
    else if (info.isFile())
      files.push(relative(root, path).split(sep).join("/"));
    else throw new Error("Backup data contains a non-regular filesystem entry");
  }
  return files;
}

async function copyPrivate(source, destination) {
  await regularFile(source);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  await chmod(destination, 0o600);
}

function openSnapshot(path) {
  return new Database(path, { readonly: true, fileMustExist: true });
}

async function checkDatabase(root) {
  const db = openSnapshot(join(root, DATABASE));
  try {
    if (db.pragma("quick_check", { simple: true }) !== "ok")
      throw new Error("SQLite integrity check failed");
    // Detect committed object metadata with a missing/truncated private file.
    for (const row of db
      .prepare("SELECT object_key, size_bytes FROM stored_objects")
      .all()) {
      const name = createHash("sha256").update(row.object_key).digest("hex");
      const info = await regularFile(join(root, "objects", name));
      if (info.size !== row.size_bytes)
        throw new Error(
          "SQLite object metadata does not match private file size",
        );
    }
  } finally {
    db.close();
  }
}

function validateManifest(value) {
  if (
    !value ||
    value.version !== 1 ||
    value.application !== "code-tape" ||
    !Number.isFinite(Date.parse(value.snapshotStartedAt)) ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    typeof value.authSecretIncluded !== "boolean" ||
    !Array.isArray(value.files)
  )
    throw new Error("Invalid backup manifest");
  const seen = new Set();
  for (const file of value.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      file.path.includes("\\") ||
      file.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      !(
        file.path === DATABASE ||
        file.path === "auth-secret" ||
        file.path.startsWith("objects/")
      ) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) ||
      seen.has(file.path)
    )
      throw new Error("Invalid backup file entry");
    seen.add(file.path);
  }
  if (
    !seen.has(DATABASE) ||
    seen.has("auth-secret") !== value.authSecretIncluded
  )
    throw new Error("Backup manifest is missing required data");
  return value;
}

async function verifyFiles(root, manifest) {
  const actual = (await filesUnder(root))
    .filter((path) => path !== MANIFEST && path !== MANIFEST_HASH)
    .sort();
  const expected = manifest.files.map((file) => file.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("Backup file inventory does not match manifest");
  for (const file of manifest.files) {
    const path = join(root, ...file.path.split("/"));
    if (
      (await regularFile(path)).size !== file.sizeBytes ||
      (await hashFile(path)) !== file.sha256
    )
      throw new Error(`Backup checksum mismatch: ${file.path}`);
  }
  await checkDatabase(root);
}

/** Stop the API first: SQLite snapshots alone cannot freeze external media files. */
export async function backupData(sourceInput, destinationInput) {
  const source = await sourceDirectory(sourceInput);
  await regularFile(join(source, DATABASE));
  const destination = await newDestination(source, destinationInput);
  const snapshotStartedAt = new Date().toISOString();
  const db = openSnapshot(join(source, DATABASE));
  try {
    await db.backup(join(destination, DATABASE));
  } finally {
    db.close();
  }
  await chmod(join(destination, DATABASE), 0o600);
  // Normalize only the new snapshot to a self-contained file. Opening a WAL
  // snapshot read-only for verification can otherwise leave new WAL/SHM files.
  const snapshot = new Database(join(destination, DATABASE), {
    fileMustExist: true,
  });
  try {
    snapshot.pragma("journal_mode = DELETE");
  } finally {
    snapshot.close();
  }
  await mkdir(join(destination, "objects"), { mode: 0o700 });
  const objectDirectory = join(source, "objects");
  const objectInfo = await lstat(objectDirectory).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (objectInfo) {
    if (!objectInfo.isDirectory() || objectInfo.isSymbolicLink())
      throw new Error("Private objects must be a real directory");
    for (const path of await filesUnder(objectDirectory))
      await copyPrivate(
        join(objectDirectory, ...path.split("/")),
        join(destination, "objects", ...path.split("/")),
      );
  }
  const secretInfo = await lstat(join(source, "auth-secret")).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (secretInfo)
    await copyPrivate(
      join(source, "auth-secret"),
      join(destination, "auth-secret"),
    );
  const files = [];
  for (const path of await filesUnder(destination))
    files.push({
      path,
      sizeBytes: (await regularFile(join(destination, ...path.split("/"))))
        .size,
      sha256: await hashFile(join(destination, ...path.split("/"))),
    });
  const manifest = {
    application: "code-tape",
    version: 1,
    snapshotStartedAt,
    completedAt: new Date().toISOString(),
    authSecretIncluded: Boolean(secretInfo),
    files,
  };
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(destination, MANIFEST), bytes, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    join(destination, MANIFEST_HASH),
    `${createHash("sha256").update(bytes).digest("hex")}\n`,
    { flag: "wx", mode: 0o600 },
  );
  await verifyBackup(destination);
  return { destination, manifest };
}

export async function verifyBackup(sourceInput) {
  const root = await sourceDirectory(sourceInput);
  for (const name of await readdir(root))
    if (!TOP_LEVEL.has(name))
      throw new Error("Unexpected top-level backup entry");
  if (!(await lstat(join(root, "objects"))).isDirectory())
    throw new Error("Backup objects directory is missing");
  const info = await regularFile(join(root, MANIFEST));
  if (info.size > 16 * 1024 * 1024)
    throw new Error("Backup manifest is too large");
  await regularFile(join(root, MANIFEST_HASH));
  const bytes = await readFile(join(root, MANIFEST));
  const expectedHash = (
    await readFile(join(root, MANIFEST_HASH), "utf8")
  ).trim();
  if (
    !/^[a-f0-9]{64}$/u.test(expectedHash) ||
    createHash("sha256").update(bytes).digest("hex") !== expectedHash
  )
    throw new Error("Backup manifest checksum mismatch");
  const manifest = validateManifest(JSON.parse(bytes.toString("utf8")));
  await verifyFiles(root, manifest);
  return manifest;
}

export async function restoreData(sourceInput, destinationInput) {
  const source = await sourceDirectory(sourceInput);
  const manifest = await verifyBackup(source);
  const destination = await newDestination(source, destinationInput);
  await mkdir(join(destination, "objects"), { mode: 0o700 });
  for (const file of manifest.files)
    await copyPrivate(
      join(source, ...file.path.split("/")),
      join(destination, ...file.path.split("/")),
    );
  // Recheck the copy, so a changed/corrupt source cannot become a usable restore.
  await verifyFiles(destination, manifest);
  return { destination, manifest };
}

async function main(args) {
  const [command, source, destination, ...extra] = args;
  if (
    extra.length ||
    !source ||
    (command !== "verify" && !destination) ||
    (command === "verify" && destination) ||
    !["backup", "verify", "restore"].includes(command)
  )
    throw new Error(
      "Usage: node scripts/data-backup.mjs backup|restore SOURCE NEW_DESTINATION; verify BACKUP_DIRECTORY",
    );
  const result =
    command === "verify"
      ? await verifyBackup(source)
      : command === "backup"
        ? await backupData(source, destination)
        : await restoreData(source, destination);
  console.log(
    JSON.stringify({
      operation: command,
      destination: result.destination,
      snapshotStartedAt: (result.manifest ?? result).snapshotStartedAt,
      authSecretIncluded: (result.manifest ?? result).authSecretIncluded,
    }),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
