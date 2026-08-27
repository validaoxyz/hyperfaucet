import { createHash } from "node:crypto";

export const CADDY_IMAGE_SECURITY_CONTRACT = "hyperpools/caddy-image-security/v2";
export const CADDY_RELEASE_SCAN_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:([a-f0-9]{64})$/;
const IMMUTABLE_IMAGE = /^\S+@sha256:([a-f0-9]{64})$/;
const CUSTOM_REGISTRY_IMAGE = /^[a-z0-9][a-z0-9._:-]*(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:([a-f0-9]{64})$/;
const PLATFORM_SPECS = Object.freeze({
  "linux/amd64": Object.freeze({ architecture: "amd64", os: "linux", variant: null }),
  "linux/arm64": Object.freeze({ architecture: "arm64", os: "linux", variant: "v8" }),
});
const PLATFORM_NAMES = Object.freeze(Object.keys(PLATFORM_SPECS));

function fail(message) {
  throw new Error(`Caddy image admission: ${message}`);
}

function record(value, label) {
  if(!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(record(value, label)).sort();
  const wanted = [...expected].sort();
  if(actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    fail(`${label} has unknown or missing keys`);
}

function digest(value, label) {
  if(typeof value !== "string" || !SHA256.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function boundedInteger(value, label) {
  if(!Number.isSafeInteger(value) || value < 0 || value > 1_000_000)
    fail(`${label} must be an integer from 0 through 1000000`);
  return value;
}

function timestamp(value, label, now) {
  if(typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    fail(`${label} is invalid`);
  }
  const milliseconds = Date.parse(value);
  const canonical = value.includes(".") ? value : value.replace("Z", ".000Z");
  if(!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== canonical)
    fail(`${label} is invalid`);
  if(milliseconds > now) fail(`${label} is in the future`);
  if(now - milliseconds > CADDY_RELEASE_SCAN_MAX_AGE_MS) fail(`${label} is stale`);
  return milliseconds;
}

function platformRecord(value, platform, label) {
  const result = record(value, label);
  exactKeys(result, [
    "architecture", "criticalHighFindings", "imageConfigSha256", "imageManifestSha256",
    "os", "variant", "vulnerablePackages",
  ], label);
  const expected = PLATFORM_SPECS[platform];
  if(result.os !== expected.os || result.architecture !== expected.architecture
    || result.variant !== expected.variant) fail(`${label} does not match ${platform}`);
  return Object.freeze({
    architecture: result.architecture,
    criticalHighFindings: boundedInteger(result.criticalHighFindings, `${label} findings`),
    imageConfigSha256: digest(result.imageConfigSha256, `${label} image config`),
    imageManifestSha256: digest(result.imageManifestSha256, `${label} image manifest`),
    os: result.os,
    variant: result.variant,
    vulnerablePackages: boundedInteger(result.vulnerablePackages, `${label} vulnerable packages`),
  });
}

function imageRecord(value, label, { requireCustomRegistry = false } = {}) {
  const image = record(value, label);
  exactKeys(image, ["image", "platforms"], label);
  const match = (requireCustomRegistry ? CUSTOM_REGISTRY_IMAGE : IMMUTABLE_IMAGE).exec(image.image ?? "");
  if(!match) fail(`${label} must pin one immutable${requireCustomRegistry ? " custom-registry" : ""} OCI index`);
  const values = record(image.platforms, `${label} platforms`);
  exactKeys(values, PLATFORM_NAMES, `${label} platforms`);
  const platforms = Object.freeze(Object.fromEntries(PLATFORM_NAMES.map((platform) => [
    platform,
    platformRecord(values[platform], platform, `${label} ${platform}`),
  ])));
  if(new Set(Object.values(platforms).map(({ imageManifestSha256 }) => imageManifestSha256)).size !== 2
    || new Set(Object.values(platforms).map(({ imageConfigSha256 }) => imageConfigSha256)).size !== 2) {
    fail(`${label} platform image identities must be distinct`);
  }
  return Object.freeze({ image: image.image, imageIndexSha256: match[1], platforms });
}

export function caddySecurityDecisionSha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateCaddyImageSecurity(value, {
  expectedImage,
  now = Date.now(),
  requireAccepted = true,
} = {}) {
  const decision = record(value, "decision");
  exactKeys(decision, [
    "contract", "current", "method", "previous", "releaseBlockReason", "releaseBlocked",
    "scannedAt", "scanner",
  ], "decision");
  if(decision.contract !== CADDY_IMAGE_SECURITY_CONTRACT) fail("decision contract is invalid");
  const scanner = record(decision.scanner, "scanner");
  exactKeys(scanner, ["name", "version"], "scanner");
  if(typeof scanner.name !== "string" || scanner.name.length === 0 || scanner.name.length > 128
    || typeof scanner.version !== "string" || scanner.version.length === 0 || scanner.version.length > 64) {
    fail("scanner identity is invalid");
  }
  if(typeof decision.method !== "string" || decision.method.length === 0 || decision.method.length > 512)
    fail("scan method is invalid");
  timestamp(decision.scannedAt, "scan timestamp", now);
  if(typeof decision.releaseBlocked !== "boolean") fail("releaseBlocked must be boolean");
  if(typeof decision.releaseBlockReason !== "string" || decision.releaseBlockReason.length === 0
    || decision.releaseBlockReason.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(decision.releaseBlockReason)) {
    fail("releaseBlockReason is invalid");
  }
  imageRecord(decision.previous, "previous scan");
  const current = imageRecord(decision.current, "current scan", { requireCustomRegistry: true });
  if(expectedImage !== undefined && current.image !== expectedImage)
    fail("scan decision does not match the selected Caddy image");
  const findings = Object.values(current.platforms)
    .reduce((total, platform) => total + platform.criticalHighFindings, 0);
  if(findings > 0 && decision.releaseBlocked !== true)
    fail("a scan with Critical or High findings must remain release-blocked");
  if(requireAccepted && (decision.releaseBlocked || findings !== 0))
    fail("release admission requires releaseBlocked:false and zero Critical or High findings");
  return Object.freeze({
    contract: CADDY_IMAGE_SECURITY_CONTRACT,
    image: current.image,
    imageIndexSha256: current.imageIndexSha256,
    platforms: current.platforms,
    releaseBlocked: decision.releaseBlocked,
    scannedAt: decision.scannedAt,
  });
}

export function validateRunningCaddyImage(decision, runtime, options = {}) {
  const observed = record(runtime, "running Caddy image");
  exactKeys(observed, [
    "architecture", "imageId", "imageReference", "os", "repoDigests", "variant",
  ], "running Caddy image");
  const scan = validateCaddyImageSecurity(decision, options);
  if(observed.imageReference !== scan.image) fail("runtime image reference does not match the accepted scan");
  const platform = `${observed.os}/${observed.architecture}`;
  const acceptedPlatform = scan.platforms[platform];
  if(!acceptedPlatform) fail(`runtime platform is not scanned: ${platform}`);
  const variant = observed.variant === "" ? null : observed.variant;
  if(variant !== acceptedPlatform.variant) fail("runtime image variant changed");
  const imageId = IMAGE_ID.exec(observed.imageId ?? "");
  if(!imageId || imageId[1] !== acceptedPlatform.imageConfigSha256)
    fail("runtime image ID is not the accepted platform config digest");
  if(!Array.isArray(observed.repoDigests) || observed.repoDigests.length === 0
    || observed.repoDigests.length > 32 || new Set(observed.repoDigests).size !== observed.repoDigests.length
    || observed.repoDigests.some((item) => typeof item !== "string" || item.length > 512)) {
    fail("runtime repository digest inventory is invalid");
  }
  const indexSuffix = `@sha256:${scan.imageIndexSha256}`;
  const repoDigest = observed.repoDigests.find((item) => item.endsWith(indexSuffix));
  if(!repoDigest) fail("runtime repository digests omit the accepted OCI index");
  return Object.freeze({
    architecture: acceptedPlatform.architecture,
    contract: CADDY_IMAGE_SECURITY_CONTRACT,
    imageConfigSha256: acceptedPlatform.imageConfigSha256,
    imageId: observed.imageId,
    imageIndexSha256: scan.imageIndexSha256,
    imageManifestSha256: acceptedPlatform.imageManifestSha256,
    imageReference: scan.image,
    os: acceptedPlatform.os,
    platform,
    repoDigest,
    scanDecisionSha256: options.decisionSha256,
    scannedAt: scan.scannedAt,
    variant: acceptedPlatform.variant,
  });
}
