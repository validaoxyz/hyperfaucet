import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { sha256File } from "./package-binaries.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const ARTIFACTS = [
  "powfaucet-server-all.tar.gz",
  "powfaucet-server-all.zip",
  "powfaucet-static.tar.gz",
  "powfaucet-static.zip",
];

function run(command, args, environment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
        ...environment,
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`,
        ),
      );
    });
  });
}

async function walk(root, relative = "") {
  const entries = [];
  for (const dirent of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const childRelative = path.join(relative, dirent.name);
    entries.push(childRelative);
    if (dirent.isDirectory()) {
      entries.push(...(await walk(root, childRelative)));
    }
  }
  return entries;
}

async function validateExtractedModes(root) {
  for (const relative of await walk(root)) {
    const entryStat = await stat(path.join(root, relative));
    const actualMode = entryStat.mode & 0o777;
    if (entryStat.isDirectory()) {
      assert.equal(actualMode, 0o755, `directory mode must be 0755: ${relative}`);
      continue;
    }
    assert(entryStat.isFile(), `archive entry must be a regular file: ${relative}`);
    const expectedMode = relative === "run-faucet.sh" ? 0o755 : 0o644;
    assert.equal(
      actualMode,
      expectedMode,
      `file mode must be ${expectedMode.toString(8).padStart(4, "0")}: ${relative}`,
    );
  }
}

async function extractWithExactModes(artifactPath, destination) {
  const archiveArgs = artifactPath.endsWith(".zip")
    ? ["unzip", "-q", artifactPath, "-d", destination]
    : ["tar", "-xzf", artifactPath, "-C", destination];
  await run("/bin/sh", ["-c", 'umask 000; exec "$@"', "archive-mode-check", ...archiveArgs]);
}

const epoch = process.env.SOURCE_DATE_EPOCH?.trim();
if (!epoch || !/^\d+$/u.test(epoch)) {
  throw new Error("SOURCE_DATE_EPOCH must be set to a non-negative integer");
}
const releaseOutputRoot = path.resolve(process.env.RELEASE_OUTPUT_DIR ?? REPO_ROOT);

const checkRoot = await mkdtemp(path.join(tmpdir(), "hyperfaucet-release-check-"));
try {
  const firstOutput = path.join(checkRoot, "first");
  const secondOutput = path.join(checkRoot, "second");
  await run("/bin/bash", ["./scripts/package-release.sh"], {
    RELEASE_OUTPUT_DIR: firstOutput,
    SOURCE_DATE_EPOCH: epoch,
  });
  await run("/bin/bash", ["./scripts/package-release.sh"], {
    RELEASE_OUTPUT_DIR: secondOutput,
    SOURCE_DATE_EPOCH: epoch,
  });

  for (const artifact of ARTIFACTS) {
    const firstPath = path.join(firstOutput, artifact);
    const secondPath = path.join(secondOutput, artifact);
    const publishedPath = path.join(releaseOutputRoot, artifact);
    const firstHash = await sha256File(firstPath);
    const secondHash = await sha256File(secondPath);
    const publishedHash = await sha256File(publishedPath);
    assert.equal(secondHash, firstHash, `release archive is not reproducible: ${artifact}`);
    assert.equal(
      publishedHash,
      firstHash,
      `published release archive does not match the reproducible build: ${artifact}`,
    );

    if (artifact.endsWith(".tar.gz")) {
      const header = (await readFile(secondPath)).subarray(0, 10);
      assert.deepEqual(
        header,
        Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x02, 0xff]),
        `release gzip header is not portable: ${artifact}`,
      );
    }

    const extractionRoot = path.join(checkRoot, `extract-${artifact.replaceAll(".", "-")}`);
    await run("mkdir", ["-p", extractionRoot]);
    await extractWithExactModes(secondPath, extractionRoot);
    await validateExtractedModes(extractionRoot);
    process.stdout.write(`${secondHash}  ${artifact}\n`);
  }
} finally {
  await rm(checkRoot, { force: true, recursive: true });
}
