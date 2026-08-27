import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { open, chmod, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST_PATH = fileURLToPath(new URL("./pkg-base-binaries.json", import.meta.url));
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MODES = new Set(["0644", "0755"]);
const MODES_BY_TARGET = new Map([
  ["node22.23.2-linux-x64", "0755"],
  ["node22.23.2-win-x64", "0644"],
]);

process.umask(0o022);

function fail(message) {
  throw new Error(message);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function loadManifest() {
  const manifest = await readJson(MANIFEST_PATH);
  validateManifest(manifest);
  return manifest;
}

export function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1) {
    fail("pkg base manifest schemaVersion must be 1");
  }
  for (const field of ["pkgVersion", "pkgFetchVersion", "nodeVersion"]) {
    if (typeof manifest[field] !== "string" || manifest[field].length === 0) {
      fail(`pkg base manifest ${field} must be a non-empty string`);
    }
  }
  if (!/^v\d+\.\d+\.\d+$/.test(manifest.nodeVersion)) {
    fail("pkg base manifest nodeVersion must be an exact v-prefixed version");
  }
  if (!Array.isArray(manifest.binaries) || manifest.binaries.length !== 2) {
    fail("pkg base manifest must contain exactly two binaries");
  }

  const seenTargets = new Set();
  const seenOutputs = new Set();
  for (const binary of manifest.binaries) {
    const requiredStrings = ["target", "asset", "url", "sha256", "output", "mode"];
    for (const field of requiredStrings) {
      if (typeof binary[field] !== "string" || binary[field].length === 0) {
        fail(`pkg base binary ${field} must be a non-empty string`);
      }
    }
    if (!MODES_BY_TARGET.has(binary.target)) {
      fail(`unexpected pkg target: ${binary.target}`);
    }
    if (binary.mode !== MODES_BY_TARGET.get(binary.target) || !MODES.has(binary.mode)) {
      fail(`unexpected output mode for ${binary.target}: ${binary.mode}`);
    }
    if (binary.asset !== path.basename(binary.asset) || binary.asset.includes("..")) {
      fail(`unsafe pkg base asset name: ${binary.asset}`);
    }
    const sourceUrl = new URL(binary.url);
    if (sourceUrl.protocol !== "https:" || sourceUrl.hostname !== "github.com") {
      fail(`pkg base URL must use https://github.com: ${binary.url}`);
    }
    if (!sourceUrl.pathname.endsWith(`/${binary.asset}`)) {
      fail(`pkg base URL does not end with its asset name: ${binary.url}`);
    }
    if (!SHA256_PATTERN.test(binary.sha256)) {
      fail(`invalid SHA-256 for ${binary.asset}`);
    }
    if (!Number.isSafeInteger(binary.size) || binary.size <= 0) {
      fail(`invalid byte size for ${binary.asset}`);
    }
    if (path.isAbsolute(binary.output) || binary.output.split(/[\\/]/u).includes("..")) {
      fail(`unsafe pkg output path: ${binary.output}`);
    }
    if (seenTargets.has(binary.target) || seenOutputs.has(binary.output)) {
      fail(`duplicate pkg target or output: ${binary.target}`);
    }
    seenTargets.add(binary.target);
    seenOutputs.add(binary.output);
  }
}

function cacheDirectory() {
  const configured = process.env.PKG_BASE_CACHE_PATH?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(homedir(), ".cache", "hyperfaucet", "pkg-base-binaries");
}

function cachedBasePath(cacheDir, binary) {
  return path.join(cacheDir, binary.asset);
}

async function sha256FileHandle(file) {
  const hash = createHash("sha256");
  for await (const chunk of file.createReadStream({ autoClose: false })) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function sha256File(filePath) {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await sha256FileHandle(file);
  } finally {
    await file.close();
  }
}

export async function verifyCachedBase(cacheDir, binary) {
  const filePath = cachedBasePath(cacheDir, binary);
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fileStat = await file.stat();
    if (!fileStat.isFile()) {
      fail(`pkg base must be a regular file: ${filePath}`);
    }
    if (fileStat.size !== binary.size) {
      fail(
        `pkg base size mismatch for ${binary.asset}: expected ${binary.size}, got ${fileStat.size}`,
      );
    }
    const actualHash = await sha256FileHandle(file);
    if (actualHash !== binary.sha256) {
      fail(
        `pkg base checksum mismatch for ${binary.asset}: expected ${binary.sha256}, got ${actualHash}`,
      );
    }
  } finally {
    await file.close();
  }
  return filePath;
}

async function downloadBase(cacheDir, binary) {
  try {
    const existing = await verifyCachedBase(cacheDir, binary);
    process.stdout.write(`Reusing verified pkg base ${binary.asset}\n`);
    return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(cacheDir, `.${binary.asset}.${process.pid}.${randomUUID()}.tmp`);
  let file;
  try {
    const response = await fetch(binary.url, {
      headers: { Accept: "application/octet-stream" },
      redirect: "follow",
      signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok || response.body === null) {
      fail(`failed to download ${binary.url}: HTTP ${response.status}`);
    }
    if (new URL(response.url).protocol !== "https:") {
      fail(`pkg base download redirected away from HTTPS: ${response.url}`);
    }

    file = await open(tempPath, "wx", 0o600);
    const hash = createHash("sha256");
    let downloadedSize = 0;
    for await (const chunk of response.body) {
      hash.update(chunk);
      downloadedSize += chunk.length;
      if (downloadedSize > binary.size) {
        fail(`downloaded pkg base is larger than ${binary.size} bytes: ${binary.asset}`);
      }
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
        if (bytesWritten === 0) {
          fail(`pkg base download write made no progress: ${binary.asset}`);
        }
        offset += bytesWritten;
      }
    }
    await file.sync();
    await file.close();
    file = undefined;

    const actualHash = hash.digest("hex");
    if (downloadedSize !== binary.size) {
      fail(
        `downloaded pkg base size mismatch for ${binary.asset}: expected ${binary.size}, got ${downloadedSize}`,
      );
    }
    if (actualHash !== binary.sha256) {
      fail(
        `downloaded pkg base checksum mismatch for ${binary.asset}: expected ${binary.sha256}, got ${actualHash}`,
      );
    }
    await chmod(tempPath, 0o555);
    await rename(tempPath, cachedBasePath(cacheDir, binary));
    process.stdout.write(`Downloaded and verified pkg base ${binary.asset}\n`);
    return await verifyCachedBase(cacheDir, binary);
  } finally {
    await file?.close();
    await rm(tempPath, { force: true });
  }
}

async function verifyBuildToolchain(manifest) {
  const rootPackage = await readJson(path.join(REPO_ROOT, "package.json"));
  const pkgPackage = await readJson(
    path.join(REPO_ROOT, "node_modules", "@yao-pkg", "pkg", "package.json"),
  );
  const pkgFetchPackage = await readJson(
    path.join(REPO_ROOT, "node_modules", "@yao-pkg", "pkg-fetch", "package.json"),
  );
  if (pkgPackage.version !== manifest.pkgVersion) {
    fail(`@yao-pkg/pkg must be ${manifest.pkgVersion}, got ${pkgPackage.version}`);
  }
  if (pkgFetchPackage.version !== manifest.pkgFetchVersion) {
    fail(`@yao-pkg/pkg-fetch must be ${manifest.pkgFetchVersion}, got ${pkgFetchPackage.version}`);
  }
  if (process.version !== `v${rootPackage.engines.node}`) {
    fail(`release packaging requires Node v${rootPackage.engines.node}, got ${process.version}`);
  }
  const npmVersion = process.env.npm_config_user_agent?.match(/^npm\/([^ ]+)/u)?.[1];
  if (npmVersion !== rootPackage.engines.npm) {
    fail(
      `release packaging requires npm ${rootPackage.engines.npm}; run this through the pinned npm, got ${npmVersion ?? "unreported"}`,
    );
  }

  const configuredTargets = rootPackage.pkg?.targets;
  const manifestTargets = manifest.binaries.map((binary) => binary.target);
  if (JSON.stringify(configuredTargets) !== JSON.stringify(manifestTargets)) {
    fail("package.json pkg targets do not match the pinned base manifest");
  }

  const vendorHashes = await readJson(
    path.join(
      REPO_ROOT,
      "node_modules",
      "@yao-pkg",
      "pkg-fetch",
      "lib-es5",
      "expected-shas.json",
    ),
  );
  for (const binary of manifest.binaries) {
    if (vendorHashes[binary.asset] !== binary.sha256) {
      fail(`installed pkg-fetch does not recognize the repository-pinned ${binary.asset}`);
    }
  }
}

async function spawnPkg(args, environment) {
  const pkgBin = path.join(
    REPO_ROOT,
    "node_modules",
    "@yao-pkg",
    "pkg",
    "lib-es5",
    "bin.js",
  );
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [pkgBin, ...args], {
      cwd: REPO_ROOT,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    fail(
      `pkg failed with ${result.signal ? `signal ${result.signal}` : `exit code ${result.code}`}`,
    );
  }
}

async function buildBinaries(manifest, cacheDir) {
  const verifiedBases = new Map();
  for (const binary of manifest.binaries) {
    verifiedBases.set(binary.target, await verifyCachedBase(cacheDir, binary));
  }

  for (const binary of manifest.binaries) {
    const outputPath = path.join(REPO_ROOT, binary.output);
    await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o755 });
    await rm(outputPath, { force: true });
    const basePath = verifiedBases.get(binary.target);
    const environment = {
      ...process.env,
      ALL_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      LANG: "C",
      LC_ALL: "C",
      NO_PROXY: "",
      PKG_CACHE_PATH: path.join(cacheDir, "network-disabled-pkg-cache"),
      PKG_NODE_PATH: basePath,
      TZ: "UTC",
      http_proxy: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9",
      npm_config_offline: "true",
    };
    try {
      await spawnPkg(
        [
          "--no-bytecode",
          "--public-packages",
          "*",
          "--public",
          "--compress",
          "Brotli",
          "--options",
          "no-warnings",
          "--target",
          binary.target,
          "--output",
          binary.output,
          ".",
        ],
        environment,
      );
      const outputStat = await lstat(outputPath);
      if (!outputStat.isFile() || outputStat.size === 0) {
        fail(`pkg did not produce a non-empty regular file: ${binary.output}`);
      }
      await chmod(outputPath, Number.parseInt(binary.mode, 8));
      await verifyCachedBase(cacheDir, binary);
    } catch (error) {
      await rm(outputPath, { force: true });
      throw error;
    }
  }
}

async function outputHashes(manifest) {
  return new Map(
    await Promise.all(
      manifest.binaries.map(async (binary) => [
        binary.output,
        await sha256File(path.join(REPO_ROOT, binary.output)),
      ]),
    ),
  );
}

async function checkReproducibleBinaries(manifest, cacheDir) {
  await buildBinaries(manifest, cacheDir);
  const firstHashes = await outputHashes(manifest);
  await buildBinaries(manifest, cacheDir);
  const secondHashes = await outputHashes(manifest);
  for (const binary of manifest.binaries) {
    const first = firstHashes.get(binary.output);
    const second = secondHashes.get(binary.output);
    if (first !== second) {
      fail(`binary is not reproducible: ${binary.output} (${first} != ${second})`);
    }
    process.stdout.write(`${second}  ${binary.output}\n`);
  }
}

async function main() {
  const mode = process.argv[2] ?? "all";
  if (!["all", "prefetch", "verify", "build", "check-reproducible"].includes(mode)) {
    fail(`unknown package-binaries mode: ${mode}`);
  }
  if (process.argv.length > 3) {
    fail("package-binaries accepts at most one mode argument");
  }

  const manifest = await loadManifest();
  await verifyBuildToolchain(manifest);
  const cacheDir = cacheDirectory();
  if (mode === "all" || mode === "prefetch") {
    for (const binary of manifest.binaries) {
      await downloadBase(cacheDir, binary);
    }
  }
  if (mode === "verify") {
    for (const binary of manifest.binaries) {
      await verifyCachedBase(cacheDir, binary);
    }
  }
  if (mode === "all" || mode === "build") {
    await buildBinaries(manifest, cacheDir);
  }
  if (mode === "check-reproducible") {
    await checkReproducibleBinaries(manifest, cacheDir);
  }
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`package-binaries: ${error.message}\n`);
    process.exitCode = 1;
  });
}
