#!/usr/bin/env bash
set -euo pipefail

export LANG=C
export LC_ALL=C
export TZ=UTC
umask 022

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly REPO_ROOT
readonly BUILD_EPOCH="${SOURCE_DATE_EPOCH:?SOURCE_DATE_EPOCH must be set to the source commit time}"
RELEASE_OUTPUT_DIR="${RELEASE_OUTPUT_DIR:-$REPO_ROOT}"

if [[ ! "$BUILD_EPOCH" =~ ^[0-9]+$ ]]; then
  echo "SOURCE_DATE_EPOCH must be a non-negative integer" >&2
  exit 1
fi

node --input-type=module - "$REPO_ROOT" <<'NODE'
import { lstatSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.argv[2];
const releaseInputs = [
  { kind: "directory", path: "bundle" },
  { kind: "directory", path: "static" },
  { kind: "regular file", path: "faucet-config.example.yaml" },
  { kind: "regular file", path: "res/run-faucet.sh" },
  { kind: "regular file", path: "res/run-faucet.bat" },
];

let valid = true;
for (const input of releaseInputs) {
  let inputStat;
  try {
    inputStat = lstatSync(join(repoRoot, input.path));
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.error(`required release input is missing: ${input.path}`);
      valid = false;
      continue;
    }
    throw error;
  }

  const hasExpectedKind =
    input.kind === "directory" ? inputStat.isDirectory() : inputStat.isFile();
  if (!hasExpectedKind) {
    console.error(`required release input must be a ${input.kind}: ${input.path}`);
    valid = false;
  }
}

if (!valid) {
  process.exitCode = 1;
}
NODE

mkdir -p "$RELEASE_OUTPUT_DIR"
RELEASE_OUTPUT_DIR="$(cd -- "$RELEASE_OUTPUT_DIR" && pwd -P)"
readonly RELEASE_OUTPUT_DIR

STAGING_ROOT="$(mktemp -d)"
readonly STAGING_ROOT
PUBLISH_ROOT="$(mktemp -d "$RELEASE_OUTPUT_DIR/.package-release.XXXXXX")"
readonly PUBLISH_ROOT
trap 'rm -rf "$STAGING_ROOT" "$PUBLISH_ROOT"' EXIT
readonly PACKAGE_ROOT="$STAGING_ROOT/package"
readonly OUTPUT_ROOT="$STAGING_ROOT/output"
mkdir -p "$PACKAGE_ROOT" "$OUTPUT_ROOT"

cp -RP \
  "$REPO_ROOT/bundle" \
  "$REPO_ROOT/static" \
  "$REPO_ROOT/faucet-config.example.yaml" \
  "$REPO_ROOT/res/run-faucet.sh" \
  "$REPO_ROOT/res/run-faucet.bat" \
  "$PACKAGE_ROOT/"
node "$REPO_ROOT/scripts/normalize-release-tree.mjs" "$PACKAGE_ROOT" "$BUILD_EPOCH"
node "$REPO_ROOT/scripts/create-release-archives.mjs" \
  "$PACKAGE_ROOT" \
  "$OUTPUT_ROOT" \
  "$BUILD_EPOCH"

for artifact in \
  powfaucet-server-all.tar.gz \
  powfaucet-server-all.zip \
  powfaucet-static.tar.gz \
  powfaucet-static.zip; do
  test -s "$OUTPUT_ROOT/$artifact"
  chmod 0644 "$OUTPUT_ROOT/$artifact"
  mv "$OUTPUT_ROOT/$artifact" "$PUBLISH_ROOT/$artifact"
  mv "$PUBLISH_ROOT/$artifact" "$RELEASE_OUTPUT_DIR/$artifact"
done
