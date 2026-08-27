import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sqlite from "../libs/sqlite3_wasm.cjs";
import {
  assertReceiptContainersStopped,
  canonicalJson,
  loadReceipt,
  sha256,
  validateReceiptDocument,
} from "./runtime-receipt.mjs";

export const SNAPSHOT_KIND = "hyperfaucet-state-snapshot-v1";
const SAFE_SQLITE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,126}\.db$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(message);
}

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function safeRelative(relative, label) {
  if(typeof relative !== "string" || relative.length === 0 || path.isAbsolute(relative)
    || relative.split(/[\\/]/).some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`${label} is not a safe relative path`);
  }
  return relative;
}

async function ensureCanonicalDirectory(directory, label, requirePrivate = true) {
  if(!path.isAbsolute(directory)) fail(`${label} must be absolute`);
  const metadata = await lstat(directory, { bigint: true });
  if(metadata.isSymbolicLink() || !metadata.isDirectory()) fail(`${label} must be a real directory`);
  if(await realpath(directory) !== directory) fail(`${label} must already be canonical`);
  const mode = Number(metadata.mode & 0o777n);
  if(requirePrivate && (mode & 0o077) !== 0) fail(`${label} permissions are too broad`);
  return metadata;
}

async function verifyReceiptBinding(binding, label) {
  if(!binding || typeof binding.path !== "string" || typeof binding.realPath !== "string")
    fail(`${label} receipt binding is invalid`);
  const metadata = await lstat(binding.path, { bigint: true });
  if(metadata.isSymbolicLink() || await realpath(binding.path) !== binding.realPath
    || metadata.dev.toString() !== binding.device || metadata.ino.toString() !== binding.inode
    || Number(metadata.mode & 0o777n).toString(8).padStart(3, "0") !== binding.mode) {
    fail(`${label} changed from the runtime receipt`);
  }
  if(binding.sha256 !== undefined
    && (metadata.size > BigInt(Number.MAX_SAFE_INTEGER) || Number(metadata.size) !== binding.size
      || await hashFile(binding.path) !== binding.sha256)) {
    fail(`${label} content changed from the runtime receipt`);
  }
}

async function optionalLstat(filename) {
  try {
    return await lstat(filename, { bigint: true });
  } catch(error) {
    if(error?.code === "ENOENT") return null;
    throw error;
  }
}

async function hashFile(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode && left.nlink === right.nlink;
}

async function copyRegularFile(source, destination, relative) {
  const sourceHandle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let destinationHandle;
  try {
    const before = await sourceHandle.stat({ bigint: true });
    if(!before.isFile() || before.nlink !== 1n) fail(`snapshot source ${relative} must be a single-link regular file`);
    if(before.size > BigInt(Number.MAX_SAFE_INTEGER)) fail(`snapshot source ${relative} exceeds the supported size`);
    const mode = Number(before.mode & 0o777n);
    if((mode & 0o022) !== 0) fail(`snapshot source ${relative} is writable by group or other`);
    destinationHandle = await open(
      destination,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      mode,
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while(position < before.size) {
      const remaining = before.size - BigInt(position);
      const length = Number(remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length));
      const { bytesRead } = await sourceHandle.read(buffer, 0, length, position);
      if(bytesRead === 0) fail(`snapshot source ${relative} ended before its recorded size`);
      let written = 0;
      while(written < bytesRead) {
        const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
        if(result.bytesWritten === 0) fail(`snapshot destination ${relative} stopped accepting bytes`);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await destinationHandle.sync();
    const after = await sourceHandle.stat({ bigint: true });
    if(!sameFileSnapshot(before, after)) fail(`snapshot source ${relative} changed while it was copied`);
    return Object.freeze({
      mode: mode.toString(8).padStart(3, "0"),
      path: relative,
      sha256: await hashFile(destination),
      size: Number(before.size),
      type: "file",
    });
  } finally {
    await destinationHandle?.close();
    await sourceHandle.close();
  }
}

async function copyTree(sourceRoot, destinationRoot, relativeRoot = "") {
  const entries = [];
  const walk = async (sourceDirectory, destinationDirectory, prefix) => {
    const metadata = await lstat(sourceDirectory, { bigint: true });
    if(metadata.isSymbolicLink() || !metadata.isDirectory() || metadata.nlink < 1n)
      fail(`snapshot source ${prefix || "."} must be a real directory`);
    const mode = Number(metadata.mode & 0o777n);
    if((mode & 0o022) !== 0) fail(`snapshot source ${prefix || "."} is writable by group or other`);
    await mkdir(destinationDirectory, { mode });
    entries.push(Object.freeze({
      mode: mode.toString(8).padStart(3, "0"),
      path: prefix,
      type: "directory",
    }));
    const children = await readdir(sourceDirectory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for(const child of children) {
      if(child.name === "." || child.name === ".." || child.name.includes("/"))
        fail("snapshot source has an invalid entry name");
      const childRelative = prefix ? `${prefix}/${child.name}` : child.name;
      const childSource = path.join(sourceDirectory, child.name);
      const childDestination = path.join(destinationDirectory, child.name);
      const childInfo = await lstat(childSource, { bigint: true });
      if(childInfo.isSymbolicLink()) fail(`snapshot source ${childRelative} must not be a symbolic link`);
      if(childInfo.isDirectory()) await walk(childSource, childDestination, childRelative);
      else if(childInfo.isFile()) entries.push(await copyRegularFile(childSource, childDestination, childRelative));
      else fail(`snapshot source ${childRelative} has an unsupported file type`);
    }
    const after = await lstat(sourceDirectory, { bigint: true });
    if(!sameFileSnapshot(metadata, after)) fail(`snapshot source ${prefix || "."} changed while it was copied`);
  };
  await walk(sourceRoot, destinationRoot, relativeRoot);
  return entries;
}

function sqliteIntegrity(filename) {
  let database;
  try {
    database = new sqlite.Database(filename, { fileMustExist: true });
    const row = database.get("PRAGMA integrity_check");
    const result = row && Object.values(row)[0];
    if(result !== "ok") fail(`SQLite integrity check failed for ${filename}`);
  } finally {
    database?.close();
  }
}

async function fsyncTree(directory) {
  const children = await readdir(directory, { withFileTypes: true });
  for(const child of children) {
    const filename = path.join(directory, child.name);
    if(child.isDirectory()) await fsyncTree(filename);
    else if(child.isFile()) {
      const descriptor = await open(filename, fsConstants.O_RDONLY);
      try {
        await descriptor.sync();
      } finally {
        await descriptor.close();
      }
    }
  }
  const descriptor = await open(directory, fsConstants.O_RDONLY);
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

async function fsyncDirectory(directory) {
  const descriptor = await open(directory, fsConstants.O_RDONLY);
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

async function acquireOperatorLock(runtimeRoot) {
  const lockPath = `${runtimeRoot}.operator-lock`;
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch(error) {
    if(error?.code === "EEXIST") fail(`operator lock is already held: ${lockPath}`);
    throw error;
  }
  await fsyncDirectory(path.dirname(lockPath));
  return async () => {
    await rmdir(lockPath);
    await fsyncDirectory(path.dirname(lockPath));
  };
}

function snapshotDocument({ createdAt, entries, receipt, sqliteRelativePath }) {
  const body = Object.freeze({
    createdAt,
    entries: Object.freeze(entries.sort((left, right) => left.path.localeCompare(right.path))),
    kind: SNAPSHOT_KIND,
    runtimeReceiptSha256: receipt.receiptSha256,
    sourceRevision: receipt.sourceRevision,
    sqliteRelativePath,
  });
  return Object.freeze({
    ...body,
    snapshotSha256: sha256(Buffer.from(`${canonicalJson(body)}\n`, "utf8")),
  });
}

function validateSnapshotHeader(document) {
  if(!document || typeof document !== "object" || Array.isArray(document)
    || document.kind !== SNAPSHOT_KIND || !SHA256.test(document.snapshotSha256 ?? "")
    || !SHA256.test(document.runtimeReceiptSha256 ?? "")
    || !/^[a-f0-9]{40}$/.test(document.sourceRevision ?? "")
    || !Number.isFinite(Date.parse(document.createdAt))
    || !SAFE_SQLITE_NAME.test(document.sqliteRelativePath ?? "") || !Array.isArray(document.entries)) {
    fail("state snapshot manifest header is invalid");
  }
  const body = { ...document };
  delete body.snapshotSha256;
  if(sha256(Buffer.from(`${canonicalJson(body)}\n`, "utf8")) !== document.snapshotSha256)
    fail("state snapshot manifest hash is invalid");
}

async function inventoryTree(root, prefix = "") {
  const entries = [];
  const walk = async (directory, relativeDirectory) => {
    const metadata = await lstat(directory, { bigint: true });
    if(metadata.isSymbolicLink() || !metadata.isDirectory()) fail(`snapshot ${relativeDirectory} is not a real directory`);
    entries.push({
      mode: Number(metadata.mode & 0o777n).toString(8).padStart(3, "0"),
      path: relativeDirectory,
      type: "directory",
    });
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for(const child of children) {
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const filename = path.join(directory, child.name);
      const childInfo = await lstat(filename, { bigint: true });
      if(childInfo.isSymbolicLink()) fail(`snapshot ${relative} contains a symbolic link`);
      if(childInfo.isDirectory()) await walk(filename, relative);
      else if(childInfo.isFile()) entries.push({
        mode: Number(childInfo.mode & 0o777n).toString(8).padStart(3, "0"),
        path: relative,
        sha256: await hashFile(filename),
        size: Number(childInfo.size),
        type: "file",
      });
      else fail(`snapshot ${relative} has an unsupported file type`);
    }
  };
  await walk(root, prefix);
  return entries;
}

export async function verifySnapshot(snapshotDirectory) {
  await ensureCanonicalDirectory(snapshotDirectory, "snapshot directory");
  let document;
  try {
    document = JSON.parse(await readFile(path.join(snapshotDirectory, "manifest.json"), "utf8"));
  } catch(error) {
    fail(`cannot read state snapshot manifest: ${error.message}`);
  }
  validateSnapshotHeader(document);
  const runtimeDirectory = path.join(snapshotDirectory, "runtime");
  const sqlitePath = path.join(runtimeDirectory, "state", safeRelative(document.sqliteRelativePath, "SQLite path"));
  sqliteIntegrity(sqlitePath);
  const actualEntries = await inventoryTree(runtimeDirectory);
  if(canonicalJson(actualEntries) !== canonicalJson(document.entries))
    fail("state snapshot payload does not match its manifest");
  return document;
}

export async function createSnapshot({
  assertStopped = assertReceiptContainersStopped,
  outputDirectory,
  receipt,
  sqliteRelativePath = "faucet-store.db",
}) {
  validateReceiptDocument(receipt);
  if(!SAFE_SQLITE_NAME.test(sqliteRelativePath)) fail("SQLite path must be one safe .db filename");
  if(!path.isAbsolute(outputDirectory)) fail("snapshot output directory must be absolute");
  const runtimeRoot = receipt.bindings?.root?.path;
  await ensureCanonicalDirectory(runtimeRoot, "runtime root");
  await verifyReceiptBinding(receipt.bindings.root, "runtime root");
  await verifyReceiptBinding(receipt.bindings.config, "runtime config");
  await verifyReceiptBinding(receipt.bindings.state, "runtime state directory");
  if(inside(outputDirectory, runtimeRoot) || inside(runtimeRoot, outputDirectory))
    fail("snapshot output and runtime root must not contain one another");
  if(await optionalLstat(outputDirectory)) fail("snapshot output already exists");
  const releaseLock = await acquireOperatorLock(runtimeRoot);
  try {
    const stoppedStates = await assertStopped(receipt);
    const sqliteSource = path.join(runtimeRoot, "state", sqliteRelativePath);
    sqliteIntegrity(sqliteSource);
    const parent = path.dirname(outputDirectory);
    await ensureCanonicalDirectory(parent, "snapshot output parent", false);
    const temporary = path.join(parent, `.${path.basename(outputDirectory)}.${process.pid}.${Date.now()}.tmp`);
    if(await optionalLstat(temporary)) fail("snapshot temporary directory already exists");
    await mkdir(temporary, { mode: 0o700 });
    try {
      const runtimeDestination = path.join(temporary, "runtime");
      const entries = await copyTree(runtimeRoot, runtimeDestination);
      sqliteIntegrity(path.join(runtimeDestination, "state", sqliteRelativePath));
      const [sourceEntries, copiedEntries] = await Promise.all([
        inventoryTree(runtimeRoot),
        inventoryTree(runtimeDestination),
      ]);
      if(canonicalJson(sourceEntries) !== canonicalJson(entries)
        || canonicalJson(copiedEntries) !== canonicalJson(entries)) {
        fail("runtime state changed while its snapshot was copied");
      }
      await verifyReceiptBinding(receipt.bindings.root, "runtime root");
      await verifyReceiptBinding(receipt.bindings.config, "runtime config");
      await verifyReceiptBinding(receipt.bindings.state, "runtime state directory");
      await assertStopped(receipt, { expectedStates: stoppedStates });
      const document = snapshotDocument({
        createdAt: new Date().toISOString(),
        entries,
        receipt,
        sqliteRelativePath,
      });
      const manifestHandle = await open(
        path.join(temporary, "manifest.json"),
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        await manifestHandle.writeFile(`${canonicalJson(document)}\n`, "utf8");
        await manifestHandle.sync();
      } finally {
        await manifestHandle.close();
      }
      await fsyncTree(temporary);
      if(await optionalLstat(outputDirectory)) fail("snapshot output appeared during publication");
      await rename(temporary, outputDirectory);
      await fsyncDirectory(parent);
      return document;
    } catch(error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await releaseLock();
  }
}

export async function restoreSnapshot({
  assertStopped = assertReceiptContainersStopped,
  receipt,
  runtimeRoot,
  snapshotDirectory,
}) {
  validateReceiptDocument(receipt);
  const document = await verifySnapshot(snapshotDirectory);
  if(document.runtimeReceiptSha256 !== receipt.receiptSha256
    || document.sourceRevision !== receipt.sourceRevision) {
    fail("state snapshot does not belong to the supplied runtime receipt");
  }
  if(!path.isAbsolute(runtimeRoot)) fail("restore runtime root must be absolute");
  if(await optionalLstat(runtimeRoot)) fail("restore runtime root already exists");
  if(inside(runtimeRoot, snapshotDirectory) || inside(snapshotDirectory, runtimeRoot))
    fail("restore runtime root and snapshot must not contain one another");
  const releaseLock = await acquireOperatorLock(receipt.bindings.root.path);
  try {
    const stoppedStates = await assertStopped(receipt);
    const parent = path.dirname(runtimeRoot);
    await ensureCanonicalDirectory(parent, "restore runtime parent", false);
    const temporary = path.join(parent, `.${path.basename(runtimeRoot)}.${process.pid}.${Date.now()}.tmp`);
    if(await optionalLstat(temporary)) fail("restore temporary directory already exists");
    try {
      const copiedEntries = await copyTree(path.join(snapshotDirectory, "runtime"), temporary);
      sqliteIntegrity(path.join(temporary, "state", document.sqliteRelativePath));
      const restoredEntries = await inventoryTree(temporary);
      if(canonicalJson(copiedEntries) !== canonicalJson(document.entries)
        || canonicalJson(restoredEntries) !== canonicalJson(document.entries)) {
        fail("restored state does not match the snapshot inventory");
      }
      await assertStopped(receipt, { expectedStates: stoppedStates });
      if(await optionalLstat(runtimeRoot)) fail("restore runtime root appeared during publication");
      await fsyncTree(temporary);
      await rename(temporary, runtimeRoot);
      await fsyncDirectory(parent);
      return document;
    } catch(error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  } finally {
    await releaseLock();
  }
}

async function main(argv) {
  const [command, first, second, third] = argv;
  if(command === "create" && first && second) {
    const receipt = await loadReceipt(path.resolve(first));
    const document = await createSnapshot({
      outputDirectory: path.resolve(second),
      receipt,
      sqliteRelativePath: third ?? "faucet-store.db",
    });
    process.stdout.write(`${document.snapshotSha256}\n`);
    return;
  }
  if(command === "verify" && first) {
    const document = await verifySnapshot(path.resolve(first));
    process.stdout.write(`${document.snapshotSha256}\n`);
    return;
  }
  if(command === "restore" && first && second && third) {
    const receipt = await loadReceipt(path.resolve(first));
    const document = await restoreSnapshot({
      receipt,
      runtimeRoot: path.resolve(third),
      snapshotDirectory: path.resolve(second),
    });
    process.stdout.write(`${document.snapshotSha256}\n`);
    return;
  }
  fail("usage: state-snapshot.mjs create <receipt> <snapshot> [sqlite-file] | verify <snapshot> | restore <receipt> <snapshot> <new-runtime-root>");
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
