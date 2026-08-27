import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const POLICY_DIRECTORY_NAME = "policy";
const POLICY_DIRECTORY_MODE = 0o755;
const POLICY_FILE_MODE = 0o644;
const POLICY_FILES = Object.freeze(["Caddyfile", "compose.production.yml"]);

function fail(message) {
  throw new Error(`HyperFaucet policy staging: ${message}`);
}

function sameMetadata(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function optionalLstat(filename) {
  try {
    return await lstat(filename, { bigint: true });
  } catch(error) {
    if(error?.code === "ENOENT") return null;
    throw error;
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

async function copyPolicyFile(source, destination, label) {
  const sourceHandle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let destinationHandle;
  try {
    const before = await sourceHandle.stat({ bigint: true });
    if(!before.isFile() || before.nlink !== 1n) fail(`${label} source must be a single-link regular file`);
    if(before.size > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${label} source is too large`);
    const bytes = await sourceHandle.readFile();
    const after = await sourceHandle.stat({ bigint: true });
    const pathMetadata = await lstat(source, { bigint: true });
    if(!sameMetadata(before, after) || !sameMetadata(after, pathMetadata))
      fail(`${label} source changed during staging`);

    destinationHandle = await open(
      destination,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await destinationHandle.writeFile(bytes);
    await destinationHandle.chmod(POLICY_FILE_MODE);
    await destinationHandle.sync();
    const installed = await destinationHandle.stat({ bigint: true });
    if(!installed.isFile() || installed.nlink !== 1n
      || Number(installed.mode & 0o777n) !== POLICY_FILE_MODE
      || installed.size !== before.size) fail(`${label} staged identity is invalid`);
  } finally {
    await destinationHandle?.close();
    await sourceHandle.close();
  }
}

export async function stageRuntimePolicy(runtimeRoot) {
  if(typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot))
    fail("runtime root must be absolute");
  const rootMetadata = await lstat(runtimeRoot, { bigint: true });
  if(rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory())
    fail("runtime root must be a real directory");
  if(await realpath(runtimeRoot) !== runtimeRoot) fail("runtime root must already be canonical");
  if((Number(rootMetadata.mode & 0o777n) & 0o077) !== 0)
    fail("runtime root permissions are too broad");

  const policyRoot = path.join(runtimeRoot, POLICY_DIRECTORY_NAME);
  if(await optionalLstat(policyRoot)) fail("runtime policy already exists");
  const temporary = path.join(
    runtimeRoot,
    `.policy-stage.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  await mkdir(temporary, { mode: 0o700 });
  try {
    for(const name of POLICY_FILES) {
      await copyPolicyFile(path.join(SOURCE_ROOT, name), path.join(temporary, name), name);
    }
    // The policy contains no secrets, and the pinned Caddy image runs as an
    // unprivileged UID that must traverse this directory to read its bind.
    await chmod(temporary, POLICY_DIRECTORY_MODE);
    await fsyncDirectory(temporary);
    if(await optionalLstat(policyRoot)) fail("runtime policy appeared during staging");
    await rename(temporary, policyRoot);
    const published = await lstat(policyRoot, { bigint: true });
    if(!published.isDirectory() || Number(published.mode & 0o777n) !== POLICY_DIRECTORY_MODE
      || await realpath(policyRoot) !== policyRoot) fail("staged policy directory identity is invalid");
    await fsyncDirectory(runtimeRoot);
    return Object.freeze({
      caddyfile: path.join(policyRoot, "Caddyfile"),
      compose: path.join(policyRoot, "compose.production.yml"),
      policyRoot,
    });
  } catch(error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function main(argv) {
  if(argv.length !== 1) fail("usage: stage-runtime-policy.mjs <absolute-runtime-root>");
  const result = await stageRuntimePolicy(argv[0]);
  process.stdout.write(`${result.policyRoot}\n`);
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
