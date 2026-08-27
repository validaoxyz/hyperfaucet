import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadManifest, verifyCachedBase } from "./package-binaries.mjs";

const manifest = await loadManifest();
const binary = manifest.binaries[0];
const cacheDir = await mkdtemp(path.join(tmpdir(), "hyperfaucet-pkg-integrity-"));

try {
  const tampered = "tampered pkg base\n";
  const testBinary = { ...binary, size: Buffer.byteLength(tampered) };
  await writeFile(path.join(cacheDir, binary.asset), tampered, { mode: 0o555 });
  await assert.rejects(
    verifyCachedBase(cacheDir, testBinary),
    /pkg base checksum mismatch/u,
    "a modified pkg base must fail checksum verification",
  );
  process.stdout.write("Modified pkg bases fail checksum verification.\n");
} finally {
  await rm(cacheDir, { force: true, recursive: true });
}
