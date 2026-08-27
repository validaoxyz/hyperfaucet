import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  caddySecurityDecisionSha256,
  validateRunningCaddyImage,
} from "./caddy-image-admission.mjs";

const execFileAsync = promisify(execFile);
export const RECEIPT_KIND = "hyperfaucet-runtime-receipt-v1";
export const PROJECT = "hyperfaucet";
export const INTERNAL_NETWORK = "hyperfaucet_internal_v1";
export const EGRESS_NETWORK = "hyperfaucet_egress_v1";
export const INGRESS_NETWORK = "hyperfaucet_ingress_v1";
export const APP_CONTAINER = "hyperfaucet-app-1";
export const CADDY_CONTAINER = "hyperfaucet-caddy-1";
export const HYPERFAUCET_HOST = "hyperfaucet.dev";

const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const PRIVATE_MODE_POLICY = Object.freeze({ forbiddenMask: 0o077 });
const PUBLIC_POLICY_MODE_POLICY = Object.freeze({ exactMode: 0o644 });
const SECRET_NAMES = Object.freeze([
  "caddy_basic_auth",
  "cloudflare_aop_ca",
  "cloudflare_origin_cert",
  "cloudflare_origin_key",
]);

function fail(message) {
  throw new Error(message);
}

export function canonicalJson(value) {
  if(value === null || typeof value !== "object") return JSON.stringify(value);
  if(Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(",")}}`;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function immutableImageReference(reference, label = "image reference") {
  if(typeof reference !== "string" || !(
    IMAGE_ID.test(reference) || /@sha256:[a-f0-9]{64}$/.test(reference)
  )) fail(`${label} must be immutable`);
  return reference;
}

function exactKeys(value, expected, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} fields changed`);
}

function requiredEnvironment(environment = process.env) {
  const runtimeRoot = environment.HYPERFAUCET_RUNTIME_ROOT;
  const secretsDir = environment.HYPERFAUCET_SECRETS_DIR;
  const sourceRevision = environment.HYPERFAUCET_SOURCE_REVISION;
  const caddyBuildLockPath = environment.HYPERFAUCET_CADDY_BUILD_LOCK_PATH;
  const caddyBuildLockSha256 = environment.HYPERFAUCET_CADDY_BUILD_LOCK_SHA256;
  const caddySecurityPath = environment.HYPERFAUCET_CADDY_SECURITY_PATH;
  const appImageReference = immutableImageReference(
    environment.HYPERFAUCET_IMAGE_REFERENCE,
    "HYPERFAUCET_IMAGE_REFERENCE",
  );
  const caddyImageReference = immutableImageReference(
    environment.HYPERFAUCET_CADDY_IMAGE_REFERENCE,
    "HYPERFAUCET_CADDY_IMAGE_REFERENCE",
  );
  if(typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot))
    fail("HYPERFAUCET_RUNTIME_ROOT must be absolute");
  if(typeof secretsDir !== "string" || !path.isAbsolute(secretsDir))
    fail("HYPERFAUCET_SECRETS_DIR must be absolute");
  if(typeof sourceRevision !== "string" || !REVISION.test(sourceRevision))
    fail("HYPERFAUCET_SOURCE_REVISION must be a lowercase 40-character commit hash");
  if(!/^[a-z0-9][a-z0-9._:-]*(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[a-f0-9]{64}$/.test(caddyImageReference))
    fail("HYPERFAUCET_CADDY_IMAGE_REFERENCE must be a custom-registry OCI index digest");
  if(typeof caddySecurityPath !== "string" || !path.isAbsolute(caddySecurityPath))
    fail("HYPERFAUCET_CADDY_SECURITY_PATH must be absolute");
  if(typeof caddyBuildLockPath !== "string" || !path.isAbsolute(caddyBuildLockPath))
    fail("HYPERFAUCET_CADDY_BUILD_LOCK_PATH must be absolute");
  if(!SHA256.test(caddyBuildLockSha256 ?? ""))
    fail("HYPERFAUCET_CADDY_BUILD_LOCK_SHA256 must be a lowercase SHA-256 digest");
  if(environment.HYPERFAUCET_HOST !== HYPERFAUCET_HOST)
    fail(`HYPERFAUCET_HOST must be ${HYPERFAUCET_HOST}`);
  return {
    appImageReference,
    caddyBuildLockPath,
    caddyBuildLockSha256,
    caddyImageReference,
    caddySecurityPath,
    host: HYPERFAUCET_HOST,
    runtimeRoot,
    secretsDir,
    sourceRevision,
  };
}

function sameMetadata(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function validateMode(mode, modePolicy, kind) {
  if(modePolicy.exactMode !== undefined && mode !== modePolicy.exactMode)
    fail(`${kind} permissions must be ${modePolicy.exactMode.toString(8)}`);
  if(modePolicy.forbiddenMask !== undefined && (mode & modePolicy.forbiddenMask) !== 0)
    fail(`${kind} permissions are too broad`);
  return mode;
}

async function binding(filename, kind, modePolicy = PRIVATE_MODE_POLICY) {
  const directory = kind.endsWith("directory");
  if(directory) {
    const metadata = await lstat(filename, { bigint: true });
    if(metadata.isSymbolicLink() || !metadata.isDirectory()) fail(`${kind} has the wrong file type`);
    const mode = Number(metadata.mode & 0o777n);
    validateMode(mode, modePolicy, kind);
    const canonical = await realpath(filename);
    if(canonical !== filename) fail(`${kind} path must already be canonical`);
    return Object.freeze({
      device: metadata.dev.toString(),
      gid: metadata.gid.toString(),
      inode: metadata.ino.toString(),
      mode: mode.toString(8).padStart(3, "0"),
      path: filename,
      realPath: canonical,
      uid: metadata.uid.toString(),
    });
  }
  const descriptor = await open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await descriptor.stat({ bigint: true });
    if(!before.isFile() || before.nlink !== 1n) fail(`${kind} must be a single-link regular file`);
    if(before.size > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${kind} exceeds the supported size`);
    const mode = Number(before.mode & 0o777n);
    validateMode(mode, modePolicy, kind);
    const bytes = await descriptor.readFile();
    const after = await descriptor.stat({ bigint: true });
    const pathMetadata = await lstat(filename, { bigint: true });
    if(!sameMetadata(before, after) || !sameMetadata(after, pathMetadata))
      fail(`${kind} changed while it was bound`);
    const canonical = await realpath(filename);
    if(canonical !== filename) fail(`${kind} path must already be canonical`);
    return Object.freeze({
      device: before.dev.toString(),
      gid: before.gid.toString(),
      inode: before.ino.toString(),
      mode: mode.toString(8).padStart(3, "0"),
      path: filename,
      realPath: canonical,
      sha256: sha256(bytes),
      size: Number(before.size),
      uid: before.uid.toString(),
    });
  } finally {
    await descriptor.close();
  }
}

async function runtimeBindings({ caddyBuildLockPath, caddySecurityPath, runtimeRoot, secretsDir }) {
  const canonicalRuntimeRoot = await realpath(runtimeRoot);
  const canonicalSecretsDir = await realpath(secretsDir);
  if(canonicalRuntimeRoot !== runtimeRoot) fail("runtime root must already be canonical");
  if(canonicalSecretsDir !== secretsDir) fail("secrets directory must already be canonical");
  const configPath = path.join(runtimeRoot, "config", "faucet-config.yaml");
  const policyRoot = path.join(runtimeRoot, "policy");
  const policyRootMetadata = await lstat(policyRoot, { bigint: true });
  if(policyRootMetadata.isSymbolicLink() || !policyRootMetadata.isDirectory()
    || await realpath(policyRoot) !== policyRoot
    || Number(policyRootMetadata.mode & 0o777n) !== 0o755) {
    fail("runtime policy directory identity is invalid");
  }
  const caddyfilePath = path.join(policyRoot, "Caddyfile");
  const composePath = path.join(policyRoot, "compose.production.yml");
  const statePath = path.join(runtimeRoot, "state");
  const secrets = [];
  for(const name of SECRET_NAMES) {
    const filename = path.join(secretsDir, name);
    secrets.push(Object.freeze({ name, ...await binding(filename, `secret ${name}`) }));
  }
  return Object.freeze({
    caddyBuildLock: await binding(caddyBuildLockPath, "Caddy custom build lock"),
    caddySecurity: await binding(caddySecurityPath, "Caddy image security decision"),
    caddyfile: await binding(caddyfilePath, "Caddyfile", PUBLIC_POLICY_MODE_POLICY),
    compose: await binding(composePath, "Compose file", PUBLIC_POLICY_MODE_POLICY),
    config: await binding(configPath, "runtime config"),
    root: await binding(runtimeRoot, "runtime root directory"),
    secrets,
    secretsRoot: await binding(secretsDir, "secrets directory"),
    state: await binding(statePath, "runtime state directory"),
  });
}

async function dockerJson(args, docker = defaultDocker) {
  const result = await docker(args);
  let parsed;
  try {
    parsed = JSON.parse(result);
  } catch {
    fail(`docker returned malformed JSON for ${args[0]}`);
  }
  return parsed;
}

export async function defaultDocker(args) {
  const { stdout } = await execFileAsync("docker", args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

function containerLabels(raw, service) {
  const labels = raw?.Config?.Labels;
  if(!labels || labels["com.docker.compose.project"] !== PROJECT
    || labels["com.docker.compose.service"] !== service
    || !/^[a-f0-9]{64}$/.test(labels["com.docker.compose.config-hash"] ?? "")) {
    fail(`${service} Compose identity labels are invalid`);
  }
  return Object.freeze({ configHash: labels["com.docker.compose.config-hash"] });
}

function normalizedNetworks(raw, service, expectedNames) {
  const networks = raw?.NetworkSettings?.Networks;
  if(!networks || typeof networks !== "object" || Array.isArray(networks))
    fail(`${service} network attachments are invalid`);
  const names = Object.keys(networks).sort();
  if(canonicalJson(names) !== canonicalJson([...expectedNames].sort()))
    fail(`${service} network attachments changed`);
  return Object.freeze(names.map((name) => {
    const id = networks[name]?.NetworkID;
    if(!CONTAINER_ID.test(id ?? "")) fail(`${service} network ${name} has an invalid ID`);
    return Object.freeze({ id, name });
  }));
}

function normalizedMounts(raw, service) {
  if(!Array.isArray(raw?.Mounts)) fail(`${service} mount inventory is invalid`);
  return Object.freeze(raw.Mounts.map((mount) => {
    if(!["bind", "tmpfs", "volume"].includes(mount?.Type)
      || typeof mount?.Destination !== "string" || !path.isAbsolute(mount.Destination)) {
      fail(`${service} has an invalid mount`);
    }
    return Object.freeze({
      destination: mount.Destination,
      readOnly: mount.RW === false,
      source: typeof mount.Source === "string" ? mount.Source : "",
      type: mount.Type,
    });
  }).sort((left, right) => left.destination.localeCompare(right.destination)));
}

function assertMounts(mounts, expected, service) {
  const actualBinds = mounts.filter(({ type }) => type !== "tmpfs");
  const tmpfs = mounts.filter(({ type }) => type === "tmpfs");
  if(tmpfs.some(({ destination, source }) => destination !== "/tmp" || source !== ""))
    fail(`${service} has an unexpected tmpfs mount`);
  const wanted = expected.map((mount) => Object.freeze({ type: "bind", ...mount }))
    .sort((left, right) => left.destination.localeCompare(right.destination));
  if(canonicalJson(actualBinds) !== canonicalJson(wanted)) fail(`${service} bind mounts changed`);
}

function normalizedPortBindings(raw, service) {
  const bindings = raw?.HostConfig?.PortBindings ?? {};
  if(typeof bindings !== "object" || Array.isArray(bindings)) fail(`${service} port bindings are invalid`);
  const normalize = (entries) => Object.entries(entries).flatMap(([containerPort, values]) => {
    if(values === null) return [];
    if(!Array.isArray(values)) fail(`${service} port binding ${containerPort} is invalid`);
    return values.map((value) => Object.freeze({
      containerPort,
      hostIp: value?.HostIp ?? "",
      hostPort: value?.HostPort ?? "",
    }));
  }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const requested = normalize(bindings);
  const activeBindings = raw?.NetworkSettings?.Ports ?? {};
  if(typeof activeBindings !== "object" || Array.isArray(activeBindings))
    fail(`${service} active port bindings are invalid`);
  const active = normalize(activeBindings);
  if(canonicalJson(active) !== canonicalJson(requested))
    fail(`${service} active port bindings do not match the requested policy`);
  return Object.freeze(requested);
}

function assertPortBoundary(ports, service) {
  if(service === "app") {
    if(ports.length !== 0) fail("app must not publish a host port");
    return;
  }
  if(ports.length !== 1 || ports[0].containerPort !== "443/tcp"
    || ports[0].hostPort !== "443" || ports[0].hostIp !== "0.0.0.0") {
    fail("Caddy must publish only host TCP port 443");
  }
}

const APP_HEALTHCHECK = Object.freeze([
  "CMD",
  "node",
  "-e",
  "fetch('http://127.0.0.1:8082/api/getVersion').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
]);
const CADDY_HEALTHCHECK = Object.freeze([
  "CMD", "caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
]);

function exactArray(actual, expected, label) {
  if(!Array.isArray(actual) || canonicalJson(actual) !== canonicalJson(expected)) fail(`${label} changed`);
  return Object.freeze([...actual]);
}

function normalizedEnvironment(raw, service) {
  if(!Array.isArray(raw?.Config?.Env) || raw.Config.Env.some((item) => typeof item !== "string"))
    fail(`${service} environment inventory is invalid`);
  const values = new Map();
  for(const item of raw.Config.Env) {
    const separator = item.indexOf("=");
    if(separator < 1) fail(`${service} has an invalid environment entry`);
    const name = item.slice(0, separator);
    if(values.has(name)) fail(`${service} has a duplicate environment entry`);
    values.set(name, item.slice(separator + 1));
  }
  const expected = service === "app"
    ? { FAUCET_HTTP_PROXY_OFFSET: "1", FAUCET_ROLE: "app", FAUCET_SERVER_PORT: "8082" }
    : { HYPERFAUCET_HOST, XDG_CONFIG_HOME: "/tmp/caddy-config", XDG_DATA_HOME: "/tmp/caddy-data" };
  for(const [name, value] of Object.entries(expected)) {
    if(values.get(name) !== value) fail(`${service} required environment changed`);
  }
  const controlledPrefix = service === "app" ? "FAUCET_" : "HYPERFAUCET_";
  const expectedControlled = Object.keys(expected).filter((name) => name.startsWith(controlledPrefix));
  if([...values.keys()].filter((name) => name.startsWith(controlledPrefix)).length !== expectedControlled.length)
    fail(`${service} has an unexpected controlled environment entry`);
  return Object.freeze([...raw.Config.Env].sort());
}

function assertTmpfs(raw, service) {
  const tmpfs = raw?.HostConfig?.Tmpfs;
  if(!tmpfs || typeof tmpfs !== "object" || Array.isArray(tmpfs)
    || Object.keys(tmpfs).length !== 1 || typeof tmpfs["/tmp"] !== "string") {
    fail(`${service} tmpfs policy is invalid`);
  }
  const options = new Set(tmpfs["/tmp"].split(",").filter(Boolean));
  const size = [...options].find((item) => item.startsWith("size="));
  const required = ["rw", "mode=1777", "noexec", "nosuid", "nodev"];
  if(!required.every((item) => options.has(item))
    || !["size=64m", "size=65536k", "size=67108864"].includes(size)
    || options.size !== required.length + 1) fail(`${service} tmpfs options changed`);
  return Object.freeze({ path: "/tmp", value: [...options].sort().join(",") });
}

function normalizedRuntimePolicy(raw, service) {
  const app = service === "app";
  const capAdd = app ? null : ["CAP_DAC_READ_SEARCH"];
  if(raw?.HostConfig?.ReadonlyRootfs !== true
    || canonicalJson(raw?.HostConfig?.CapDrop) !== canonicalJson(["ALL"])
    || canonicalJson(raw?.HostConfig?.CapAdd ?? null) !== canonicalJson(capAdd)
    || canonicalJson(raw?.HostConfig?.SecurityOpt) !== canonicalJson(["no-new-privileges:true"])
    || raw?.HostConfig?.Init !== true
    || raw?.HostConfig?.RestartPolicy?.Name !== "unless-stopped"
    || raw?.HostConfig?.RestartPolicy?.MaximumRetryCount !== 0) {
    fail(`${service} host security policy changed`);
  }
  const expectedUser = app ? "nginx" : "0:0";
  const expectedEntrypoint = app ? ["/entrypoint.sh"] : ["/usr/bin/caddy"];
  const expectedCommand = app
    ? ["--config=/run/hyperfaucet/faucet-config.yaml", "--datadir=/data"]
    : ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"];
  const expectedHealthcheck = app ? APP_HEALTHCHECK : CADDY_HEALTHCHECK;
  const healthcheck = raw?.Config?.Healthcheck;
  const expectedInterval = app ? 15_000_000_000 : 30_000_000_000;
  const expectedStartPeriod = app ? 45_000_000_000 : 10_000_000_000;
  const expectedRetries = app ? 8 : 4;
  const expectedStopTimeout = app ? 90 : 30;
  if(raw?.Config?.User !== expectedUser || raw?.Config?.StopTimeout !== expectedStopTimeout
    || !healthcheck || healthcheck.Interval !== expectedInterval || healthcheck.Timeout !== 5_000_000_000
    || healthcheck.Retries !== expectedRetries || healthcheck.StartPeriod !== expectedStartPeriod) {
    fail(`${service} process or health policy changed`);
  }
  return Object.freeze({
    capAdd: Object.freeze(capAdd ?? []),
    capDrop: Object.freeze(["ALL"]),
    command: exactArray(raw.Config.Cmd, expectedCommand, `${service} command`),
    entrypoint: exactArray(raw.Config.Entrypoint, expectedEntrypoint, `${service} entrypoint`),
    environment: normalizedEnvironment(raw, service),
    healthcheck: Object.freeze({
      interval: healthcheck.Interval,
      retries: healthcheck.Retries,
      startPeriod: healthcheck.StartPeriod,
      test: exactArray(healthcheck.Test, expectedHealthcheck, `${service} healthcheck`),
      timeout: healthcheck.Timeout,
    }),
    init: true,
    noNewPrivileges: true,
    readOnlyRoot: true,
    restartPolicy: "unless-stopped",
    securityOptions: Object.freeze(["no-new-privileges:true"]),
    stopTimeout: raw.Config.StopTimeout,
    tmpfs: assertTmpfs(raw, service),
    user: raw.Config.User,
  });
}

function normalizeContainer(raw, definition, { requireRunning = true } = {}) {
  const { imageReference, mounts, name, networks, service } = definition;
  if(raw?.Name !== `/${name}` || !CONTAINER_ID.test(raw?.Id ?? ""))
    fail(`${service} container identity is invalid`);
  if(!IMAGE_ID.test(raw?.Image ?? "") || raw?.Config?.Image !== imageReference)
    fail(`${service} image identity changed`);
  if(requireRunning && (raw?.State?.Running !== true || raw?.State?.Health?.Status !== "healthy"))
    fail(`${service} is not running and healthy`);
  const labels = containerLabels(raw, service);
  const normalizedMountInventory = normalizedMounts(raw, service);
  assertMounts(normalizedMountInventory, mounts, service);
  const ports = normalizedPortBindings(raw, service);
  assertPortBoundary(ports, service);
  return Object.freeze({
    configHash: labels.configHash,
    id: raw.Id,
    imageId: raw.Image,
    imageReference,
    mounts: normalizedMountInventory,
    name: raw.Name,
    networks: normalizedNetworks(raw, service, networks),
    ports,
    runtimePolicy: normalizedRuntimePolicy(raw, service),
    service,
  });
}

function normalizeNetwork(raw, logicalName, expected) {
  if(raw?.Name !== expected.name || !CONTAINER_ID.test(raw?.Id ?? "")
    || raw?.Driver !== "bridge" || raw?.Scope !== "local" || raw?.Ingress !== false
    || raw?.Internal !== expected.internal || raw?.Attachable !== false) {
    fail(`network ${expected.name} identity is invalid`);
  }
  const labels = raw?.Labels;
  if(!labels || labels["com.docker.compose.project"] !== PROJECT
    || labels["com.docker.compose.network"] !== logicalName) {
    fail(`network ${expected.name} is not owned by the HyperFaucet Compose project`);
  }
  return Object.freeze({
    attachable: raw.Attachable,
    driver: raw.Driver,
    id: raw.Id,
    ingress: raw.Ingress,
    internal: raw.Internal,
    logicalName,
    name: raw.Name,
    scope: raw.Scope,
  });
}

function normalizeAppImage(raw, expectedId, expectedReference, sourceRevision) {
  if(raw?.Id !== expectedId || !IMAGE_ID.test(raw?.Id ?? "") || raw?.Os !== "linux"
    || !["amd64", "arm64"].includes(raw?.Architecture)
    || raw?.Config?.Labels?.["org.opencontainers.image.revision"] !== sourceRevision) {
    fail("app runtime image identity or source revision is invalid");
  }
  if(!Array.isArray(raw.RepoDigests) || raw.RepoDigests.some((value) => typeof value !== "string"))
    fail("app runtime repository digest inventory is invalid");
  if(expectedReference.includes("@sha256:") && !raw.RepoDigests.includes(expectedReference))
    fail("app runtime repository digests omit the selected immutable reference");
  return Object.freeze({
    architecture: raw.Architecture,
    id: raw.Id,
    os: raw.Os,
    platform: `${raw.Os}/${raw.Architecture}`,
    reference: expectedReference,
    repoDigests: Object.freeze([...raw.RepoDigests].sort()),
    sourceRevision,
    variant: raw.Variant || null,
  });
}

async function inspectOne(kind, name, docker) {
  const rows = await dockerJson([kind, "inspect", name], docker);
  if(!Array.isArray(rows) || rows.length !== 1) fail(`docker ${kind} inspect ${name} returned the wrong inventory`);
  return rows[0];
}

function expectedMounts(bindings) {
  return Object.freeze({
    app: Object.freeze([
      { destination: "/data", readOnly: false, source: bindings.state.realPath },
      { destination: "/run/hyperfaucet/faucet-config.yaml", readOnly: true, source: bindings.config.realPath },
    ]),
    caddy: Object.freeze([
      { destination: "/etc/caddy/Caddyfile", readOnly: true, source: bindings.caddyfile.realPath },
      ...bindings.secrets.map((secret) => ({
        destination: `/run/secrets/${secret.name}`,
        readOnly: true,
        source: secret.realPath,
      })),
    ]),
  });
}

export async function observeRuntime({ docker = defaultDocker, environment = process.env } = {}) {
  const expected = requiredEnvironment(environment);
  const bindings = await runtimeBindings(expected);
  if(bindings.caddyBuildLock.sha256 !== expected.caddyBuildLockSha256)
    fail("HYPERFAUCET_CADDY_BUILD_LOCK_SHA256 does not match the bound build-lock file");
  const mounts = expectedMounts(bindings);
  const [appRaw, caddyRaw, internalRaw, egressRaw, ingressRaw] = await Promise.all([
    inspectOne("container", APP_CONTAINER, docker),
    inspectOne("container", CADDY_CONTAINER, docker),
    inspectOne("network", INTERNAL_NETWORK, docker),
    inspectOne("network", EGRESS_NETWORK, docker),
    inspectOne("network", INGRESS_NETWORK, docker),
  ]);
  const [appImageRaw, caddyImageRaw] = await Promise.all([
    inspectOne("image", appRaw.Image, docker),
    inspectOne("image", caddyRaw.Image, docker),
  ]);
  const containers = Object.freeze([
    normalizeContainer(appRaw, {
      imageReference: expected.appImageReference,
      mounts: mounts.app,
      name: APP_CONTAINER,
      networks: [INTERNAL_NETWORK, EGRESS_NETWORK],
      service: "app",
      sourceRevision: expected.sourceRevision,
    }),
    normalizeContainer(caddyRaw, {
      imageReference: expected.caddyImageReference,
      mounts: mounts.caddy,
      name: CADDY_CONTAINER,
      networks: [INTERNAL_NETWORK, INGRESS_NETWORK],
      service: "caddy",
      sourceRevision: expected.sourceRevision,
    }),
  ]);
  const networks = Object.freeze([
    normalizeNetwork(internalRaw, "internal", { internal: true, name: INTERNAL_NETWORK }),
    normalizeNetwork(egressRaw, "egress", { internal: false, name: EGRESS_NETWORK }),
    normalizeNetwork(ingressRaw, "ingress", { internal: false, name: INGRESS_NETWORK }),
  ]);
  const appImage = normalizeAppImage(
    appImageRaw,
    containers[0].imageId,
    expected.appImageReference,
    expected.sourceRevision,
  );
  if(caddyImageRaw?.Id !== containers[1].imageId) fail("Caddy image inspect does not match its container");
  let caddySecurityDecision;
  let caddySecurityBytes;
  try {
    caddySecurityBytes = await readFile(bindings.caddySecurity.realPath);
    if(sha256(caddySecurityBytes) !== bindings.caddySecurity.sha256)
      fail("Caddy image security decision changed after binding");
    caddySecurityDecision = JSON.parse(caddySecurityBytes.toString("utf8"));
  } catch(error) {
    fail(`cannot read Caddy image security evidence: ${error.message}`);
  }
  const caddyImage = validateRunningCaddyImage(
    caddySecurityDecision,
    {
      architecture: caddyImageRaw.Architecture,
      imageId: caddyImageRaw.Id,
      imageReference: expected.caddyImageReference,
      os: caddyImageRaw.Os,
      repoDigests: caddyImageRaw.RepoDigests,
      variant: caddyImageRaw.Variant || null,
    },
    {
      decisionSha256: caddySecurityDecisionSha256(caddySecurityBytes),
      expectedImage: expected.caddyImageReference,
      requireAccepted: true,
    },
  );
  return Object.freeze({
    bindings,
    containers,
    images: Object.freeze({
      app: appImage,
      caddy: Object.freeze({ ...caddyImage, buildLockSha256: expected.caddyBuildLockSha256 }),
    }),
    kind: RECEIPT_KIND,
    networks,
    project: PROJECT,
    sourceRevision: expected.sourceRevision,
  });
}

export function receiptDocument(observed, createdAt = new Date().toISOString()) {
  const body = Object.freeze({ ...observed, createdAt });
  return Object.freeze({ ...body, receiptSha256: sha256(Buffer.from(`${canonicalJson(body)}\n`, "utf8")) });
}

function validateBindingRecord(value, label, {
  directory = false,
  modePolicy = PRIVATE_MODE_POLICY,
  named = false,
} = {}) {
  const fields = ["device", "gid", "inode", "mode", "path", "realPath", "uid"];
  if(!directory) fields.push("sha256", "size");
  if(named) fields.push("name");
  exactKeys(value, fields, label);
  if(!/^\d+$/.test(value.device) || !/^\d+$/.test(value.inode) || !/^\d+$/.test(value.uid)
    || !/^\d+$/.test(value.gid) || !/^[0-7]{3}$/.test(value.mode)
    || typeof value.path !== "string" || !path.isAbsolute(value.path)
    || value.realPath !== value.path) fail(`${label} identity is invalid`);
  validateMode(Number.parseInt(value.mode, 8), modePolicy, label);
  if(!directory && (!SHA256.test(value.sha256 ?? "") || !Number.isSafeInteger(value.size) || value.size < 0))
    fail(`${label} content identity is invalid`);
  return value;
}

function validateRuntimePolicyRecord(value, service) {
  exactKeys(value, [
    "capAdd", "capDrop", "command", "entrypoint", "environment", "healthcheck", "init", "noNewPrivileges",
    "readOnlyRoot", "restartPolicy", "securityOptions", "stopTimeout", "tmpfs", "user",
  ], `${service} runtime policy`);
  const app = service === "app";
  const expectedCommand = app
    ? ["--config=/run/hyperfaucet/faucet-config.yaml", "--datadir=/data"]
    : ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"];
  const expectedEntrypoint = app ? ["/entrypoint.sh"] : ["/usr/bin/caddy"];
  if(canonicalJson(value.command) !== canonicalJson(expectedCommand)
    || canonicalJson(value.entrypoint) !== canonicalJson(expectedEntrypoint)
    || !Array.isArray(value.environment) || value.environment.some((entry) => typeof entry !== "string")
    || canonicalJson(value.capDrop) !== canonicalJson(["ALL"])
    || canonicalJson(value.capAdd) !== canonicalJson(app ? [] : ["CAP_DAC_READ_SEARCH"])
    || canonicalJson(value.securityOptions) !== canonicalJson(["no-new-privileges:true"])
    || value.init !== true || value.noNewPrivileges !== true || value.readOnlyRoot !== true
    || value.restartPolicy !== "unless-stopped" || value.stopTimeout !== (app ? 90 : 30)
    || value.user !== (app ? "nginx" : "0:0")) fail(`${service} runtime policy is invalid`);
  const requiredEnvironment = app
    ? ["FAUCET_HTTP_PROXY_OFFSET=1", "FAUCET_ROLE=app", "FAUCET_SERVER_PORT=8082"]
    : [`HYPERFAUCET_HOST=${HYPERFAUCET_HOST}`, "XDG_CONFIG_HOME=/tmp/caddy-config", "XDG_DATA_HOME=/tmp/caddy-data"];
  if(!requiredEnvironment.every((entry) => value.environment.includes(entry)))
    fail(`${service} runtime environment is invalid`);
  exactKeys(value.healthcheck, ["interval", "retries", "startPeriod", "test", "timeout"], `${service} healthcheck`);
  if(value.healthcheck.interval !== (app ? 15_000_000_000 : 30_000_000_000)
    || value.healthcheck.retries !== (app ? 8 : 4)
    || value.healthcheck.startPeriod !== (app ? 45_000_000_000 : 10_000_000_000)
    || value.healthcheck.timeout !== 5_000_000_000
    || canonicalJson(value.healthcheck.test) !== canonicalJson(app ? APP_HEALTHCHECK : CADDY_HEALTHCHECK)) {
    fail(`${service} healthcheck is invalid`);
  }
  exactKeys(value.tmpfs, ["path", "value"], `${service} tmpfs`);
  if(value.tmpfs.path !== "/tmp" || typeof value.tmpfs.value !== "string") fail(`${service} tmpfs is invalid`);
}

function validateContainerRecord(container, service) {
  exactKeys(container, [
    "configHash", "id", "imageId", "imageReference", "mounts", "name", "networks",
    "ports", "runtimePolicy", "service",
  ], `${service} container`);
  if(container.service !== service || container.name !== `/${service === "app" ? APP_CONTAINER : CADDY_CONTAINER}`
    || !CONTAINER_ID.test(container.id ?? "") || !IMAGE_ID.test(container.imageId ?? "")
    || !SHA256.test(container.configHash ?? "") || !Array.isArray(container.mounts)
    || !Array.isArray(container.networks) || !Array.isArray(container.ports)) {
    fail(`${service} container identity is invalid`);
  }
  immutableImageReference(container.imageReference, `${service} receipt image reference`);
  for(const mount of container.mounts) {
    exactKeys(mount, ["destination", "readOnly", "source", "type"], `${service} mount`);
    if(typeof mount.destination !== "string" || !path.isAbsolute(mount.destination)
      || typeof mount.readOnly !== "boolean" || typeof mount.source !== "string"
      || !["bind", "tmpfs"].includes(mount.type)) fail(`${service} mount is invalid`);
  }
  for(const network of container.networks) {
    exactKeys(network, ["id", "name"], `${service} network attachment`);
    if(!CONTAINER_ID.test(network.id ?? "") || typeof network.name !== "string")
      fail(`${service} network attachment is invalid`);
  }
  for(const port of container.ports) {
    exactKeys(port, ["containerPort", "hostIp", "hostPort"], `${service} port`);
  }
  validateRuntimePolicyRecord(container.runtimePolicy, service);
}

export function validateReceiptDocument(document) {
  exactKeys(document, [
    "bindings", "containers", "createdAt", "images", "kind", "networks", "project",
    "receiptSha256", "sourceRevision",
  ], "runtime receipt");
  if(document.kind !== RECEIPT_KIND || document.project !== PROJECT
    || !REVISION.test(document.sourceRevision ?? "") || !SHA256.test(document.receiptSha256 ?? "")
    || !Number.isFinite(Date.parse(document.createdAt))) fail("runtime receipt header is invalid");
  const body = { ...document };
  delete body.receiptSha256;
  const expected = sha256(Buffer.from(`${canonicalJson(body)}\n`, "utf8"));
  if(expected !== document.receiptSha256) fail("runtime receipt hash is invalid");
  if(!document.bindings || !document.images || !Array.isArray(document.containers)
    || document.containers.length !== 2 || !Array.isArray(document.networks)
    || document.networks.length !== 3) fail("runtime receipt inventory is incomplete");
  exactKeys(document.bindings, [
    "caddyBuildLock", "caddySecurity", "caddyfile", "compose", "config", "root", "secrets",
    "secretsRoot", "state",
  ], "runtime bindings");
  const [app, caddy] = document.containers;
  validateContainerRecord(app, "app");
  validateContainerRecord(caddy, "caddy");
  const expectedNetworkNames = [INTERNAL_NETWORK, EGRESS_NETWORK, INGRESS_NETWORK];
  if(canonicalJson(document.networks.map(({ name }) => name)) !== canonicalJson(expectedNetworkNames)
    || document.networks[0].logicalName !== "internal" || document.networks[0].internal !== true
    || document.networks[1].logicalName !== "egress" || document.networks[1].internal !== false
    || document.networks[2].logicalName !== "ingress" || document.networks[2].internal !== false) {
    fail("runtime receipt network inventory is invalid");
  }
  const appNetworkNames = app.networks.map(({ name }) => name).sort();
  if(canonicalJson(appNetworkNames) !== canonicalJson([INTERNAL_NETWORK, EGRESS_NETWORK].sort())
    || canonicalJson(caddy.networks.map(({ name }) => name).sort())
      !== canonicalJson([INTERNAL_NETWORK, INGRESS_NETWORK].sort())) {
    fail("runtime receipt container network boundary is invalid");
  }
  for(const [index, network] of document.networks.entries()) {
    exactKeys(network, [
      "attachable", "driver", "id", "ingress", "internal", "logicalName", "name", "scope",
    ], `runtime network ${index}`);
    if(!CONTAINER_ID.test(network.id ?? "") || network.attachable !== false || network.driver !== "bridge"
      || network.ingress !== false || network.scope !== "local") fail("runtime network identity is invalid");
    const attached = (network.name === INGRESS_NETWORK ? caddy : app).networks
      .find(({ name }) => name === network.name);
    const caddyInternal = caddy.networks.find(({ name }) => name === INTERNAL_NETWORK);
    if(attached?.id !== network.id || (network.name === INTERNAL_NETWORK
      && caddyInternal?.id !== network.id)) fail("runtime network ID binding is invalid");
  }
  assertPortBoundary(app.ports, "app");
  assertPortBoundary(caddy.ports, "caddy");
  exactKeys(document.images, ["app", "caddy"], "runtime images");
  exactKeys(document.images.app, [
    "architecture", "id", "os", "platform", "reference", "repoDigests", "sourceRevision", "variant",
  ], "app runtime image");
  exactKeys(document.images.caddy, [
    "architecture", "buildLockSha256", "contract", "imageConfigSha256", "imageId",
    "imageIndexSha256", "imageManifestSha256", "imageReference", "os", "platform", "repoDigest",
    "scanDecisionSha256", "scannedAt", "variant",
  ], "Caddy runtime image");
  if(document.images.app.id !== app.imageId || document.images.app.reference !== app.imageReference
    || document.images.app.sourceRevision !== document.sourceRevision
    || !Array.isArray(document.images.app.repoDigests)
    || document.images.caddy.imageId !== caddy.imageId
    || document.images.caddy.imageReference !== caddy.imageReference
    || document.images.caddy.contract !== "hyperpools/caddy-image-security/v2"
    || !SHA256.test(document.images.caddy.buildLockSha256 ?? "")
    || !SHA256.test(document.images.caddy.imageConfigSha256 ?? "")
    || !SHA256.test(document.images.caddy.imageIndexSha256 ?? "")
    || !SHA256.test(document.images.caddy.imageManifestSha256 ?? "")
    || !SHA256.test(document.images.caddy.scanDecisionSha256 ?? "")) {
    fail("runtime receipt image inventory is invalid");
  }
  const rootPath = document.bindings.root?.path;
  const configPath = document.bindings.config?.path;
  const policyRoot = typeof rootPath === "string" ? path.join(rootPath, "policy") : null;
  const caddyfilePath = typeof policyRoot === "string" ? path.join(policyRoot, "Caddyfile") : null;
  const composePath = typeof policyRoot === "string" ? path.join(policyRoot, "compose.production.yml") : null;
  const statePath = document.bindings.state?.path;
  if(typeof rootPath !== "string" || !path.isAbsolute(rootPath)
    || configPath !== path.join(rootPath, "config", "faucet-config.yaml")
    || statePath !== path.join(rootPath, "state")
    || document.bindings.root.realPath !== rootPath
    || document.bindings.config.realPath !== configPath
    || document.bindings.state.realPath !== statePath) {
    fail("runtime receipt state binding is invalid");
  }
  if(!Array.isArray(document.bindings.secrets)
    || canonicalJson(document.bindings.secrets.map(({ name }) => name)) !== canonicalJson(SECRET_NAMES)) {
    fail("runtime receipt secret binding inventory is invalid");
  }
  validateBindingRecord(document.bindings.root, "runtime root", { directory: true });
  validateBindingRecord(document.bindings.state, "runtime state", { directory: true });
  validateBindingRecord(document.bindings.secretsRoot, "secrets root", { directory: true });
  validateBindingRecord(document.bindings.config, "runtime config");
  validateBindingRecord(document.bindings.caddyfile, "Caddyfile", { modePolicy: PUBLIC_POLICY_MODE_POLICY });
  validateBindingRecord(document.bindings.compose, "Compose file", { modePolicy: PUBLIC_POLICY_MODE_POLICY });
  validateBindingRecord(document.bindings.caddyBuildLock, "Caddy custom build lock");
  validateBindingRecord(document.bindings.caddySecurity, "Caddy image security decision");
  for(const [index, secret] of document.bindings.secrets.entries()) {
    validateBindingRecord(secret, `secret ${index}`, { named: true });
    if(secret.path !== path.join(document.bindings.secretsRoot.path, secret.name))
      fail("runtime receipt secret path is invalid");
  }
  if(document.bindings.caddyfile.path !== caddyfilePath || document.bindings.compose.path !== composePath
    || document.bindings.caddyBuildLock.sha256 !== document.images.caddy.buildLockSha256
    || document.bindings.caddySecurity.sha256 !== document.images.caddy.scanDecisionSha256)
    fail("runtime receipt policy-file binding is invalid");
  const expectedAppMounts = [
    { destination: "/data", readOnly: false, source: statePath, type: "bind" },
    { destination: "/run/hyperfaucet/faucet-config.yaml", readOnly: true, source: configPath, type: "bind" },
  ];
  const actualAppBinds = app.mounts.filter(({ type }) => type !== "tmpfs");
  if(canonicalJson(actualAppBinds) !== canonicalJson(expectedAppMounts))
    fail("runtime receipt app mount inventory is invalid");
  const expectedCaddyMounts = [
    { destination: "/etc/caddy/Caddyfile", readOnly: true, source: document.bindings.caddyfile.path, type: "bind" },
    ...document.bindings.secrets.map((secret) => ({
      destination: `/run/secrets/${secret.name}`,
      readOnly: true,
      source: secret.path,
      type: "bind",
    })),
  ].sort((left, right) => left.destination.localeCompare(right.destination));
  const actualCaddyBinds = caddy.mounts.filter(({ type }) => type !== "tmpfs");
  if(canonicalJson(actualCaddyBinds) !== canonicalJson(expectedCaddyMounts))
    fail("runtime receipt Caddy mount inventory is invalid");
  return document;
}

export async function loadReceipt(filename) {
  let document;
  try {
    document = JSON.parse(await readFile(filename, "utf8"));
  } catch(error) {
    fail(`cannot read runtime receipt: ${error.message}`);
  }
  return validateReceiptDocument(document);
}

async function fsyncDirectory(directory) {
  const descriptor = await open(directory, fsConstants.O_RDONLY);
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

export async function writeReceipt(filename, document) {
  if(!path.isAbsolute(filename)) fail("receipt output path must be absolute");
  const parent = path.dirname(filename);
  const parentInfo = await stat(parent);
  if(!parentInfo.isDirectory()) fail("receipt output parent is not a directory");
  const temporary = path.join(parent, `.${path.basename(filename)}.${process.pid}.${Date.now()}.tmp`);
  const bytes = Buffer.from(`${canonicalJson(document)}\n`, "utf8");
  let published = false;
  try {
    const descriptor = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    try {
      await descriptor.writeFile(bytes);
      await descriptor.sync();
    } finally {
      await descriptor.close();
    }
    await link(temporary, filename);
    published = true;
    await unlink(temporary);
    await fsyncDirectory(parent);
  } catch(error) {
    if(!published) await unlink(temporary).catch((unlinkError) => {
      if(unlinkError?.code !== "ENOENT") throw unlinkError;
    });
    throw error;
  }
}

export async function verifyLiveReceipt(receipt, { docker = defaultDocker } = {}) {
  const environment = {
    HYPERFAUCET_CADDY_BUILD_LOCK_PATH: receipt.bindings.caddyBuildLock.path,
    HYPERFAUCET_CADDY_BUILD_LOCK_SHA256: receipt.images.caddy.buildLockSha256,
    HYPERFAUCET_CADDY_IMAGE_REFERENCE: receipt.images.caddy.imageReference,
    HYPERFAUCET_CADDY_SECURITY_PATH: receipt.bindings.caddySecurity.path,
    HYPERFAUCET_HOST,
    HYPERFAUCET_IMAGE_REFERENCE: receipt.images.app.reference,
    HYPERFAUCET_RUNTIME_ROOT: receipt.bindings.root.path,
    HYPERFAUCET_SECRETS_DIR: receipt.bindings.secretsRoot.path,
    HYPERFAUCET_SOURCE_REVISION: receipt.sourceRevision,
  };
  const observed = await observeRuntime({ docker, environment });
  const prior = { ...receipt };
  delete prior.createdAt;
  delete prior.receiptSha256;
  if(canonicalJson(observed) !== canonicalJson(prior)) fail("live HyperFaucet runtime changed from its receipt");
  return observed;
}

function stoppedContainerState(raw, service) {
  const state = raw?.State;
  if(!state || state.Running !== false || state.Restarting !== false || state.Paused !== false
    || state.Dead !== false || state.Pid !== 0 || state.Status !== "exited"
    || typeof state.StartedAt !== "string" || state.StartedAt.length === 0
    || typeof state.FinishedAt !== "string" || state.FinishedAt.length === 0
    || !Number.isSafeInteger(raw.RestartCount) || raw.RestartCount < 0) {
    fail(`${service} must be durably stopped before state copy`);
  }
  return Object.freeze({
    finishedAt: state.FinishedAt,
    restartCount: raw.RestartCount,
    startedAt: state.StartedAt,
  });
}

export async function assertReceiptContainersStopped(receipt, {
  docker = defaultDocker,
  expectedStates = null,
} = {}) {
  validateReceiptDocument(receipt);
  const mounts = expectedMounts(receipt.bindings);
  const states = [];
  for(const container of receipt.containers) {
    const raw = await inspectOne("container", container.id, docker);
    const normalized = normalizeContainer(raw, {
      imageReference: container.imageReference,
      mounts: mounts[container.service],
      name: container.service === "app" ? APP_CONTAINER : CADDY_CONTAINER,
      networks: container.service === "app"
        ? [INTERNAL_NETWORK, EGRESS_NETWORK]
        : [INTERNAL_NETWORK, INGRESS_NETWORK],
      service: container.service,
    }, { requireRunning: false });
    if(canonicalJson(normalized) !== canonicalJson(container))
      fail(`${container.service} stopped-container identity changed`);
    states.push(Object.freeze({ id: container.id, ...stoppedContainerState(raw, container.service) }));
  }
  if(expectedStates !== null && canonicalJson(states) !== canonicalJson(expectedStates))
    fail("a HyperFaucet container restarted during state copy");
  return Object.freeze(states);
}

async function main(argv) {
  const [command, filename] = argv;
  if(command === "capture" && filename) {
    const observed = await observeRuntime();
    const document = receiptDocument(observed);
    await writeReceipt(path.resolve(filename), document);
    process.stdout.write(`${document.receiptSha256}\n`);
    return;
  }
  if(command === "verify-live" && filename) {
    const receipt = await loadReceipt(path.resolve(filename));
    await verifyLiveReceipt(receipt);
    process.stdout.write(`${receipt.receiptSha256}\n`);
    return;
  }
  if(command === "assert-stopped" && filename) {
    const receipt = await loadReceipt(path.resolve(filename));
    await assertReceiptContainersStopped(receipt);
    process.stdout.write(`${receipt.receiptSha256}\n`);
    return;
  }
  fail("usage: runtime-receipt.mjs capture|verify-live|assert-stopped <absolute-receipt-path>");
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
