import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sqlite from "../libs/sqlite3_wasm.cjs";
import {
  validateCaddyImageSecurity,
  validateRunningCaddyImage,
} from "./caddy-image-admission.mjs";
import {
  APP_CONTAINER,
  CADDY_CONTAINER,
  EGRESS_NETWORK,
  HYPERFAUCET_HOST,
  INGRESS_NETWORK,
  INTERNAL_NETWORK,
  assertReceiptContainersStopped,
  immutableImageReference,
  observeRuntime,
  receiptDocument,
  sha256,
  validateReceiptDocument,
  verifyLiveReceipt,
} from "./runtime-receipt.mjs";
import { createSnapshot, restoreSnapshot, verifySnapshot } from "./state-snapshot.mjs";
import { stageRuntimePolicy } from "./stage-runtime-policy.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const APP_ID = "a".repeat(64);
const CADDY_ID = "b".repeat(64);
const APP_IMAGE_ID = `sha256:${"c".repeat(64)}`;
const CADDY_IMAGE_ID = `sha256:${"d".repeat(64)}`;
const CADDY_IMAGE_INDEX = "4".repeat(64);
const CADDY_BUILD_LOCK_BYTES = Buffer.from('{"fixture":"custom-caddy-build-lock"}\n', "utf8");
const CADDY_BUILD_LOCK = sha256(CADDY_BUILD_LOCK_BYTES);
const INTERNAL_ID = "e".repeat(64);
const EGRESS_ID = "f".repeat(64);
const INGRESS_ID = "0".repeat(64);
const REVISION = "1".repeat(40);
const APP_REFERENCE = `hyperfaucet@${APP_IMAGE_ID}`;
const CADDY_REFERENCE = `ghcr.io/validaoxyz/hyperpools-caddy@sha256:${CADDY_IMAGE_INDEX}`;

async function fixture(context) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "hyperfaucet-hosting-test-")));
  context.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, "runtime");
  const secretsDir = path.join(root, "secrets");
  await mkdir(path.join(runtimeRoot, "config"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(runtimeRoot, "state"), { recursive: true, mode: 0o700 });
  await mkdir(secretsDir, { mode: 0o700 });
  await chmod(runtimeRoot, 0o700);
  await chmod(path.join(runtimeRoot, "config"), 0o700);
  await chmod(path.join(runtimeRoot, "state"), 0o700);
  const policy = await stageRuntimePolicy(runtimeRoot);
  const configPath = path.join(runtimeRoot, "config", "faucet-config.yaml");
  await writeFile(configPath, "version: 2\n", { mode: 0o600 });
  await chmod(configPath, 0o600);
  const secretNames = [
    "caddy_basic_auth",
    "cloudflare_aop_ca",
    "cloudflare_origin_cert",
    "cloudflare_origin_key",
  ];
  for(const name of secretNames) {
    const filename = path.join(secretsDir, name);
    await writeFile(filename, `fixture-${name}\n`, { mode: 0o600 });
    await chmod(filename, 0o600);
  }
  const securityPath = path.join(root, "caddy-image-security.json");
  const buildLockPath = path.join(root, "caddy-build-lock.json");
  const platform = (architecture, variant, imageConfigSha256, imageManifestSha256) => ({
    architecture,
    criticalHighFindings: 0,
    imageConfigSha256,
    imageManifestSha256,
    os: "linux",
    variant,
    vulnerablePackages: 0,
  });
  const decision = {
    contract: "hyperpools/caddy-image-security/v2",
    current: {
      image: CADDY_REFERENCE,
      platforms: {
        "linux/amd64": platform("amd64", null, CADDY_IMAGE_ID.slice(7), "6".repeat(64)),
        "linux/arm64": platform("arm64", "v8", "7".repeat(64), "8".repeat(64)),
      },
    },
    method: "Trivy image scan with machine-produced OCI platform metadata.",
    previous: {
      image: `caddy:2.11.4-alpine@sha256:${"9".repeat(64)}`,
      platforms: {
        "linux/amd64": platform("amd64", null, "a".repeat(64), "b".repeat(64)),
        "linux/arm64": platform("arm64", "v8", "c".repeat(64), "d".repeat(64)),
      },
    },
    releaseBlockReason: "The exact current image has zero Critical or High findings.",
    releaseBlocked: false,
    scannedAt: new Date().toISOString(),
    scanner: { name: "Trivy", version: "0.74.0" },
  };
  await writeFile(securityPath, `${JSON.stringify(decision)}\n`, { mode: 0o600 });
  await writeFile(buildLockPath, CADDY_BUILD_LOCK_BYTES, { mode: 0o600 });
  await chmod(securityPath, 0o600);
  await chmod(buildLockPath, 0o600);
  const sqlitePath = path.join(runtimeRoot, "state", "faucet-store.db");
  const database = new sqlite.Database(sqlitePath);
  database.exec("CREATE TABLE Fixture (Value TEXT NOT NULL); INSERT INTO Fixture VALUES ('durable');");
  database.close();
  await chmod(sqlitePath, 0o600);

  const environment = {
    HYPERFAUCET_CADDY_BUILD_LOCK_PATH: buildLockPath,
    HYPERFAUCET_CADDY_BUILD_LOCK_SHA256: CADDY_BUILD_LOCK,
    HYPERFAUCET_CADDY_IMAGE_REFERENCE: CADDY_REFERENCE,
    HYPERFAUCET_CADDY_SECURITY_PATH: securityPath,
    HYPERFAUCET_HOST,
    HYPERFAUCET_IMAGE_REFERENCE: APP_REFERENCE,
    HYPERFAUCET_RUNTIME_ROOT: runtimeRoot,
    HYPERFAUCET_SECRETS_DIR: secretsDir,
    HYPERFAUCET_SOURCE_REVISION: REVISION,
  };
  const networkAttachment = (id) => ({ NetworkID: id });
  const app = {
    Config: {
      Cmd: ["--config=/run/hyperfaucet/faucet-config.yaml", "--datadir=/data"],
      Entrypoint: ["/entrypoint.sh"],
      Env: ["FAUCET_ROLE=app", "FAUCET_SERVER_PORT=8082", "FAUCET_HTTP_PROXY_OFFSET=1", "PATH=/usr/bin"],
      Healthcheck: {
        Interval: 15_000_000_000,
        Retries: 8,
        StartPeriod: 45_000_000_000,
        Test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8082/api/getVersion').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
        Timeout: 5_000_000_000,
      },
      Image: APP_REFERENCE,
      Labels: {
        "com.docker.compose.config-hash": "2".repeat(64),
        "com.docker.compose.project": "hyperfaucet",
        "com.docker.compose.service": "app",
      },
      StopTimeout: 90,
      User: "nginx",
    },
    HostConfig: {
      CapAdd: null,
      CapDrop: ["ALL"],
      Init: true,
      PortBindings: {},
      ReadonlyRootfs: true,
      RestartPolicy: { MaximumRetryCount: 0, Name: "unless-stopped" },
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "rw,size=64m,mode=1777,noexec,nosuid,nodev" },
    },
    Id: APP_ID,
    Image: APP_IMAGE_ID,
    Mounts: [
      { Destination: "/data", RW: true, Source: path.join(runtimeRoot, "state"), Type: "bind" },
      {
        Destination: "/run/hyperfaucet/faucet-config.yaml",
        RW: false,
        Source: configPath,
        Type: "bind",
      },
      { Destination: "/tmp", RW: true, Source: "", Type: "tmpfs" },
    ],
    Name: `/${APP_CONTAINER}`,
    NetworkSettings: {
      Networks: {
        [EGRESS_NETWORK]: networkAttachment(EGRESS_ID),
        [INTERNAL_NETWORK]: networkAttachment(INTERNAL_ID),
      },
    },
    State: { Health: { Status: "healthy" }, Running: true },
  };
  const caddy = {
    Config: {
      Cmd: ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
      Entrypoint: ["/usr/bin/caddy"],
      Env: [`HYPERFAUCET_HOST=${HYPERFAUCET_HOST}`, "XDG_CONFIG_HOME=/tmp/caddy-config", "XDG_DATA_HOME=/tmp/caddy-data", "PATH=/usr/bin"],
      Healthcheck: {
        Interval: 30_000_000_000,
        Retries: 4,
        StartPeriod: 10_000_000_000,
        Test: ["CMD", "caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
        Timeout: 5_000_000_000,
      },
      Image: CADDY_REFERENCE,
      Labels: {
        "com.docker.compose.config-hash": "3".repeat(64),
        "com.docker.compose.project": "hyperfaucet",
        "com.docker.compose.service": "caddy",
      },
      StopTimeout: 30,
      User: "0:0",
    },
    HostConfig: {
      CapAdd: ["CAP_DAC_READ_SEARCH"],
      CapDrop: ["ALL"],
      Init: true,
      PortBindings: {
        "443/tcp": [{ HostIp: "0.0.0.0", HostPort: "443" }],
      },
      ReadonlyRootfs: true,
      RestartPolicy: { MaximumRetryCount: 0, Name: "unless-stopped" },
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "rw,size=64m,mode=1777,noexec,nosuid,nodev" },
    },
    Id: CADDY_ID,
    Image: CADDY_IMAGE_ID,
    Mounts: [
      {
        Destination: "/etc/caddy/Caddyfile",
        RW: false,
        Source: policy.caddyfile,
        Type: "bind",
      },
      ...secretNames.map((name) => ({
        Destination: `/run/secrets/${name}`,
        RW: false,
        Source: path.join(secretsDir, name),
        Type: "bind",
      })),
      { Destination: "/tmp", RW: true, Source: "", Type: "tmpfs" },
    ],
    Name: `/${CADDY_CONTAINER}`,
    NetworkSettings: {
      Networks: {
        [INGRESS_NETWORK]: networkAttachment(INGRESS_ID),
        [INTERNAL_NETWORK]: networkAttachment(INTERNAL_ID),
      },
      Ports: {
        "2019/tcp": null,
        "443/tcp": [{ HostIp: "0.0.0.0", HostPort: "443" }],
        "443/udp": null,
        "80/tcp": null,
      },
    },
    State: { Health: { Status: "healthy" }, Running: true },
  };
  const network = (name, id, logicalName, internal) => ({
    Attachable: false,
    Driver: "bridge",
    Id: id,
    Ingress: false,
    Internal: internal,
    Labels: {
      "com.docker.compose.network": logicalName,
      "com.docker.compose.project": "hyperfaucet",
    },
    Name: name,
    Scope: "local",
  });
  const values = new Map([
    [`container:${APP_CONTAINER}`, app],
    [`container:${APP_ID}`, app],
    [`container:${CADDY_CONTAINER}`, caddy],
    [`container:${CADDY_ID}`, caddy],
    [`network:${INTERNAL_NETWORK}`, network(INTERNAL_NETWORK, INTERNAL_ID, "internal", true)],
    [`network:${EGRESS_NETWORK}`, network(EGRESS_NETWORK, EGRESS_ID, "egress", false)],
    [`network:${INGRESS_NETWORK}`, network(INGRESS_NETWORK, INGRESS_ID, "ingress", false)],
    [`image:${APP_IMAGE_ID}`, {
      Architecture: "amd64",
      Config: { Labels: { "org.opencontainers.image.revision": REVISION } },
      Id: APP_IMAGE_ID,
      Os: "linux",
      RepoDigests: [APP_REFERENCE],
      Variant: "",
    }],
    [`image:${CADDY_IMAGE_ID}`, {
      Architecture: "amd64",
      Id: CADDY_IMAGE_ID,
      Os: "linux",
      RepoDigests: [CADDY_REFERENCE],
      Variant: "",
    }],
  ]);
  const docker = async ([kind, command, name]) => {
    assert.equal(command, "inspect");
    const value = values.get(`${kind}:${name}`);
    if(!value) throw new Error(`unexpected Docker fixture request: ${kind} ${name}`);
    return `${JSON.stringify([value])}\n`;
  };
  return {
    app,
    buildLockPath,
    caddy,
    decision,
    docker,
    environment,
    policy,
    root,
    runtimeRoot,
    securityPath,
    secretsDir,
    sqlitePath,
    values,
  };
}

test("production Compose keeps the app private and gives only Caddy host port 443", async () => {
  const compose = await readFile(path.join(ROOT, "ops", "compose.production.yml"), "utf8");
  const app = compose.slice(compose.indexOf("  app:"), compose.indexOf("  caddy:"));
  const caddy = compose.slice(compose.indexOf("  caddy:"), compose.indexOf("\nsecrets:"));
  assert.doesNotMatch(app, /^\s+ports:/m);
  assert.match(app, /networks:\n\s+- internal\n\s+- egress/);
  assert.match(caddy, /published: "443"/);
  assert.match(caddy, /cap_add:\n\s+- DAC_READ_SEARCH/);
  assert.match(caddy, /networks:\n\s+- internal/);
  assert.match(caddy, /networks:\n\s+- internal\n\s+- ingress/);
  assert.doesNotMatch(caddy, /\n\s+- egress/);
  assert.match(compose, /internal:\n\s+name: hyperfaucet_internal_v1\n\s+internal: true/);
  assert.match(compose, /egress:\n\s+name: hyperfaucet_egress_v1/);
  assert.match(compose, /ingress:\n\s+name: hyperfaucet_ingress_v1/);
  assert.doesNotMatch(compose, /external:\s*true/);
  assert.match(compose, /HYPERFAUCET_IMAGE_REFERENCE:\?set an immutable/);
  assert.match(compose, /HYPERFAUCET_CADDY_IMAGE_REFERENCE:\?set an immutable patched/);
});

test("Docker Compose resolves the exact production network and publication contract", async (context) => {
  const setup = await fixture(context);
  const result = spawnSync("docker", [
    "compose",
    "--env-file", "/dev/null",
    "-f", setup.policy.compose,
    "config",
    "--format", "json",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      HYPERFAUCET_CADDY_IMAGE_REFERENCE: CADDY_REFERENCE,
      HYPERFAUCET_HOST: "hyperfaucet.example.invalid",
      HYPERFAUCET_IMAGE_REFERENCE: APP_REFERENCE,
      HYPERFAUCET_RUNTIME_ROOT: setup.runtimeRoot,
      HYPERFAUCET_SECRETS_DIR: setup.secretsDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.name, "hyperfaucet");
  assert.equal(config.networks.internal.name, INTERNAL_NETWORK);
  assert.equal(config.networks.internal.internal, true);
  assert.equal(config.networks.egress.name, EGRESS_NETWORK);
  assert.equal(config.networks.egress.internal, undefined);
  assert.equal(config.networks.ingress.name, INGRESS_NETWORK);
  assert.equal(config.networks.ingress.internal, undefined);
  assert.deepEqual(config.services.app.networks, { egress: null, internal: null });
  assert.equal(config.services.app.ports, undefined);
  assert.deepEqual(config.services.caddy.networks, { ingress: null, internal: null });
  assert.deepEqual(config.services.caddy.cap_add, ["DAC_READ_SEARCH"]);
  assert.deepEqual(config.services.caddy.ports, [{
    host_ip: "0.0.0.0",
    mode: "ingress",
    protocol: "tcp",
    published: "443",
    target: 443,
  }]);
});

test("the independent edge enforces AOP and strips credentials", async () => {
  const caddy = await readFile(path.join(ROOT, "ops", "Caddyfile"), "utf8");
  assert.match(caddy, /\{\$HYPERFAUCET_HOST\}:443/);
  assert.match(caddy, /tls \/run\/secrets\/cloudflare_origin_cert \/run\/secrets\/cloudflare_origin_key/);
  assert.match(caddy, /client_auth \{\s*mode require_and_verify\s*trust_pool file \/run\/secrets\/cloudflare_aop_ca\s*\}/);
  const proxy = caddy.indexOf("reverse_proxy app:8082");
  assert.ok(proxy > caddy.indexOf("client_auth"));
  assert.match(caddy, /header_up -Authorization/);
  assert.match(caddy, /header_up -Proxy-Authorization/);
  assert.match(caddy, /header_up X-Forwarded-For \{client_ip\}/);
  assert.match(caddy, /Cache-Control "private, no-store"/);
  assert.doesNotMatch(caddy, /plaintext-fixture-password|caddy_basic_auth|basic_auth\s*\{|Vary "Authorization"/i);
});

test("the container entrypoint has a direct app role and rejects unknown roles", async () => {
  const entrypoint = await readFile(path.join(ROOT, "docker", "entrypoint.sh"), "utf8");
  assert.equal(entrypoint.split(/\r?\n/, 1)[0], "#!/bin/sh");
  assert.doesNotMatch(entrypoint, /bash/);
  const appRole = entrypoint.slice(entrypoint.indexOf('FAUCET_ROLE:-combined}" = "app"'), entrypoint.indexOf("fi", 100) + 2);
  assert.match(appRole, /exec node --no-deprecation \/app\/bundle\/powfaucet\.cjs/);
  assert.doesNotMatch(appRole, /nginx/);
  assert.match(entrypoint, /unsupported FAUCET_ROLE/);
});

test("the app image uses the exact locked minimal base images", async () => {
  const dockerfile = await readFile(path.join(ROOT, "Dockerfile"), "utf8");
  const lock = JSON.parse(await readFile(path.join(ROOT, "ops", "app-image-base-lock.json"), "utf8"));
  assert.equal(lock.contract, "hyperfaucet/app-image-base-lock/v1");
  assert.equal(lock.platform, "linux/amd64");
  assert.equal(lock.node.resolvedVersion, "22.23.2");
  assert.equal(lock.nginx.resolvedVersion, "1.30.4");
  assert.equal(lock.node.alpineVersion, lock.nginx.alpineVersion);
  assert.match(lock.openssl.alpineVersion, /^3\.5\.8-r0$/);
  assert.equal(lock.openssl.cve, "CVE-2026-14456");
  for(const image of [lock.node, lock.nginx]) {
    assert.match(image.reference, /@sha256:[0-9a-f]{64}$/);
    assert.match(image.platformManifest, /^sha256:[0-9a-f]{64}$/);
    assert.match(image.sourceRevision, /^[0-9a-f]{40}$/);
  }
  const lines = new Set(dockerfile.split(/\r?\n/));
  assert.ok(lines.has(`ARG NODE_IMAGE=${lock.node.reference}`));
  assert.ok(lines.has(`ARG NGINX_IMAGE=${lock.nginx.reference}`));
  assert.ok(lines.has(`RUN apk add --no-cache libcrypto3=${lock.openssl.alpineVersion} libssl3=${lock.openssl.alpineVersion}`));
  assert.match(dockerfile, /COPY --from=node-runtime \/usr\/lib\/libgcc_s\.so\.1 \/usr\/lib\//);
  assert.match(dockerfile, /COPY --from=node-runtime \/usr\/lib\/libstdc\+\+\.so\.6\* \/usr\/lib\//);
  assert.match(dockerfile, /USER nginx\s+WORKDIR \/data\s+\s*EXPOSE 8080\s+ENTRYPOINT/);
});

test("the dedicated adapter can start and validate its initialized host", async (context) => {
  let promoter;
  let bootstrap;
  let sudoers;
  try {
    promoter = await readFile(path.join(ROOT, "ops", "dedicated-host", "promoter.py"), "utf8");
    bootstrap = await readFile(path.join(ROOT, "ops", "dedicated-host", "bootstrap.sh"), "utf8");
    sudoers = await readFile(path.join(ROOT, "ops", "dedicated-host", "hyperfaucet-ci.sudoers"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      context.skip("dedicated-host operations are intentionally absent from the public export");
      return;
    }
    throw error;
  }
  const directoryCheck = promoter.slice(promoter.indexOf("def _directory"), promoter.indexOf("def _atomic_write"));
  assert.doesNotMatch(directoryCheck, /metadata\.st_nlink/);
  assert.match(bootstrap, /useradd .*--shell \/bin\/bash hyperfaucet-ci/);
  assert.match(bootstrap, /usermod --shell \/bin\/bash hyperfaucet-ci/);
  assert.match(bootstrap, /external_interface=\$\(ip -4 route show default/);
  assert.match(bootstrap, /HYPERFAUCET_CF -i "\$external_interface" -p tcp --dport 443/);
  assert.match(bootstrap, /--initial-config/);
  assert.doesNotMatch(bootstrap, /--preview-config/);
  assert.match(bootstrap, /service-mode\.json/);
  const dispatcher = bootstrap.slice(
    bootstrap.indexOf("cat > /usr/local/libexec/hyperfaucet/dispatcher.py"),
    bootstrap.indexOf("cat > /etc/sudoers.d/hyperfaucet-ci"),
  );
  assert.doesNotMatch(dispatcher, /activate|init-mode|reseal|rotate-wallet|enable-turnstile/);
  assert.match(sudoers, /promoter\.py stage \*/);
  assert.match(sudoers, /promoter\.py deploy \*/);
  assert.match(sudoers, /promoter\.py status \*/);
  assert.match(sudoers, /promoter\.py rollback \*/);
  assert.doesNotMatch(sudoers, /rotate-wallet/);
  assert.doesNotMatch(sudoers, /enable-turnstile/);
  assert.doesNotMatch(sudoers, /promoter\.py \*\s*$/m);
  assert.match(promoter, /def activate\(commit: str, authorized_by: str\)/);
  assert.match(promoter, /"--force-recreate", "app"/);
  assert.match(promoter, /def reseal\(commit: str\)/);
  assert.match(promoter, /def rotate_wallet\(/);
  assert.match(promoter, /def enable_turnstile\(/);
  const walletRotation = promoter.slice(
    promoter.indexOf("def rotate_wallet"),
    promoter.indexOf("def deploy", promoter.indexOf("def rotate_wallet")),
  );
  assert.ok(walletRotation.indexOf('_compose("stop", "caddy"') < walletRotation.indexOf('_compose("stop", "app"'));
  assert.ok(walletRotation.indexOf('_compose("stop", "app"') < walletRotation.indexOf("_assert_no_claiming_sessions()"));
  assert.ok(walletRotation.indexOf('"replacement-verified"') < walletRotation.indexOf('_compose("up", "-d", "caddy"'));
  assert.match(walletRotation, /_assert_no_claiming_sessions\(\)/);
  assert.match(walletRotation, /if journal\["state"\] in \{"edge-starting", "receipt-published"\}:/);
  assert.ok(walletRotation.indexOf('if journal["state"] in {"edge-starting", "receipt-published"}:') < walletRotation.indexOf("_restore_wallet_rotation("));
  assert.match(walletRotation, /if _build_active_config\(\) != current_config:/);
  assert.match(promoter, /set\(overrides\)\.issubset\(\{"ethWalletKey"\}\)/);
  assert.doesNotMatch(walletRotation, /\b_active_mode\(/);
  const turnstileActivation = promoter.slice(
    promoter.indexOf("def enable_turnstile"),
    promoter.indexOf("def deploy", promoter.indexOf("def enable_turnstile")),
  );
  assert.ok(turnstileActivation.indexOf("_verify_turnstile_secret(secret)") < turnstileActivation.indexOf('_compose("stop", "caddy"'));
  assert.ok(turnstileActivation.indexOf('_compose("stop", "caddy"') < turnstileActivation.indexOf('_compose("stop", "app"'));
  assert.ok(turnstileActivation.indexOf('_compose("stop", "app"') < turnstileActivation.indexOf("_assert_no_live_sessions()"));
  assert.ok(turnstileActivation.indexOf('"candidate-verified"') < turnstileActivation.indexOf('_compose("up", "-d", "caddy"'));
  assert.match(turnstileActivation, /if journal\["state"\] in \{"edge-starting", "receipt-published"\}:/);
  assert.match(turnstileActivation, /_invalidate_previous_release\(\)/);
  assert.match(promoter, /CADDY_REPO_DIGEST = f"\{CADDY_REPOSITORY\}@\{CADDY_IMAGE_ID\}"/);
  assert.match(promoter, /repo_digests not in \(\[\], \[CADDY_REPO_DIGEST\]\)/);
  const runnerInstaller = await readFile(path.join(ROOT, "ops", "dedicated-host", "install-runner.sh"), "utf8");
  assert.match(runnerInstaller, /--profile internal\|internal-secondary/);
  assert.match(runnerInstaller, /runner_name=hyperfaucet-internal-37/);
  assert.match(runnerInstaller, /runner_name=hyperfaucet-internal-37-secondary/);
  assert.match(runnerInstaller, /runner_labels=hyperfaucet-internal-37,\$runner_name/);
  assert.match(runnerInstaller, /actions-runner-internal/);
  assert.match(runnerInstaller, /runner_user=hyperfaucet-internal/);
  assert.match(runnerInstaller, /KillMode=mixed/);
  assert.doesNotMatch(runnerInstaller, /hyperfaucet-public/);
});

test("service modes and wallet rotation primitives fail closed", async (context) => {
  const promoterPath = path.join(ROOT, "ops", "dedicated-host", "promoter.py");
  try {
    await readFile(promoterPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      context.skip("dedicated-host operations are intentionally absent from the public export");
      return;
    }
    throw error;
  }
  const script = String.raw`
import copy, glob, importlib.util, io, json, os, pathlib, sqlite3, sys, tempfile, time, types
yaml = types.ModuleType("yaml")
yaml.YAMLError = Exception
yaml.safe_dump = lambda value, **kwargs: json.dumps(value)
yaml.safe_load = lambda value: json.loads(value)
sys.modules["yaml"] = yaml
spec = importlib.util.spec_from_file_location("promoter", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
config_sha = "a" * 64
preview = module._preview_mode(config_sha)
active = module._active_mode(config_sha, "mura:chat-2026-08-27")
assert module._validate_service_mode(preview, config_sha) == preview
assert module._validate_service_mode(active, config_sha) == active
rotated = module._updated_active_mode(active, "b" * 64)
assert rotated["configSha256"] == "b" * 64
assert rotated["activatedAt"] == active["activatedAt"]
assert rotated["authorizedBy"] == active["authorizedBy"]
for broken in (
    {**preview, "promotable": True},
    {**active, "previewOnly": True},
    {**active, "service": "hyperfaucet-preview"},
    {**active, "configSha256": "b" * 64},
):
    try:
        module._validate_service_mode(broken, config_sha)
    except module.PromoteError:
        pass
    else:
        raise AssertionError("invalid service mode was accepted")
module._service_mode_sha = lambda: (preview, "f" * 64)
stage = module.stage_document("staged", "1" * 40, module.image_reference("2" * 64), "3" * 64, "4" * 64)
assert set(stage) == {"imageReference", "previewOnly", "promotable", "scanAdmissionSha256", "schemaVersion", "service", "sourceCommit", "state", "trivyReportSha256"}
assert stage["schemaVersion"] == 3
assert stage["service"] == "hyperfaucet-preview"

for payload in (b"a" * 64, b"0x" + b"A" * 64 + b"\n"):
    key = module._read_wallet_key(io.BytesIO(payload))
    assert len(key) == 64
    for index in range(len(key)):
        key[index] = 0
for payload in (b"", b"a" * 63, b"a" * 65, b"g" * 64, b"a" * 64 + b"\nX"):
    try:
        module._read_wallet_key(io.BytesIO(payload))
    except module.PromoteError:
        pass
    else:
        raise AssertionError("invalid wallet key frame was accepted")

for payload in (b"0x" + b"A" * 32, b"0x" + b"a" * 64 + b"\n"):
    secret = module._read_turnstile_secret(io.BytesIO(payload))
    assert secret.startswith(b"0x")
    for index in range(len(secret)):
        secret[index] = 0
for payload in (b"", b"3x" + b"A" * 32, b"0x short", b"0x" + b"A" * 1023, b"0x" + b"A" * 32 + b"\nX"):
    try:
        module._read_turnstile_secret(io.BytesIO(payload))
    except module.PromoteError:
        pass
    else:
        raise AssertionError("invalid Turnstile secret frame was accepted")

base_modules = {name: {"enabled": True} for name in module.ACTIVE_MODULES}
base_modules["captcha"] = {
    "enabled": False,
    "provider": "turnstile",
    "siteKey": "placeholder",
    "secret": "CensoredTurnstileSecretKey",
    "allowedHostnames": [module.HOSTNAME],
    "checkSessionStart": True,
    "checkBalanceClaim": False,
}
template = {
    "ethWalletKey": "f" * 64,
    "faucetSecret": "template",
    "pseudonymKey": "template",
    "statusAdminToken": None,
    "ethChainId": 998,
    "ethRpcHost": "https://rpc.hyperliquid-testnet.xyz/evm",
    "httpProxyCount": 0,
    "ethQueueNoFunds": False,
    "minDropAmount": 1,
    "maxDropAmount": 2,
    "modules": base_modules,
}
current = copy.deepcopy(template)
current["ethWalletKey"] = "a" * 64
current["faucetSecret"] = "b" * 32
current["pseudonymKey"] = "c" * 32
current["statusAdminToken"] = "d" * 32
original_read_yaml = module._read_yaml
module._read_yaml = lambda path, *args: copy.deepcopy(
    current if path == module.CONFIG / "faucet-config.yaml" else template
)
disabled = json.loads(module._build_active_config())
assert disabled["modules"]["captcha"]["enabled"] is False
assert disabled["modules"]["captcha"]["siteKey"] is None
assert disabled["modules"]["captcha"]["secret"] is None
sitekey = "0x" + "A" * 24
turnstile_secret = "0x" + "B" * 32
enabled = json.loads(module._build_turnstile_config(sitekey, turnstile_secret))
assert enabled["modules"]["captcha"]["enabled"] is True
assert enabled["modules"]["captcha"]["siteKey"] == sitekey
assert enabled["modules"]["captcha"]["secret"] == turnstile_secret
current = enabled
rotated_wallet = json.loads(module._build_active_config({"ethWalletKey": "e" * 64}))
assert rotated_wallet["ethWalletKey"] == "e" * 64
assert rotated_wallet["modules"]["captcha"]["siteKey"] == sitekey
assert rotated_wallet["modules"]["captcha"]["secret"] == turnstile_secret
module._read_yaml = original_read_yaml

with tempfile.TemporaryDirectory() as temporary:
    database = pathlib.Path(temporary) / "faucet-store.db"
    connection = sqlite3.connect(database)
    connection.execute("CREATE TABLE Sessions (SessionId TEXT, Status TEXT)")
    connection.close()
    summary = module._assert_no_claiming_sessions(database, os.getuid())
    assert summary["sessionCount"] == 0
    assert summary["claimingSessions"] == 0
    assert summary["runningSessions"] == 0
    connection = sqlite3.connect(database)
    connection.execute("INSERT INTO Sessions VALUES ('done', 'finished')")
    connection.commit()
    connection.close()
    summary = module._assert_no_claiming_sessions(database, os.getuid())
    assert summary["sessionCount"] == 1
    module._assert_no_live_sessions(database, os.getuid())
    connection = sqlite3.connect(database)
    connection.execute("INSERT INTO Sessions VALUES ('active', 'running')")
    connection.commit()
    connection.close()
    try:
        module._assert_no_live_sessions(database, os.getuid())
    except module.PromoteError:
        pass
    else:
        raise AssertionError("running session did not block Turnstile activation")
    connection = sqlite3.connect(database)
    connection.execute("DELETE FROM Sessions WHERE SessionId = 'active'")
    connection.commit()
    connection.close()
    connection = sqlite3.connect(database)
    connection.execute("INSERT INTO Sessions VALUES ('unsafe', 'claiming')")
    connection.commit()
    connection.close()
    try:
        module._assert_no_claiming_sessions(database, os.getuid())
    except module.PromoteError:
        pass
    else:
        raise AssertionError("claiming session did not block wallet rotation")

with tempfile.TemporaryDirectory() as temporary:
    target = pathlib.Path(temporary) / "secret"
    original_write = module.os.write
    original_fchown = module.os.fchown
    def fail_after_one_byte(descriptor, value):
        original_write(descriptor, value[:1])
        raise OSError("injected write failure")
    module.os.write = fail_after_one_byte
    module.os.fchown = lambda *args: None
    try:
        try:
            module._atomic_write(target, b"fixture-secret", mode=0o600, owner=os.getuid())
        except OSError:
            pass
        else:
            raise AssertionError("injected atomic-write failure was accepted")
    finally:
        module.os.write = original_write
        module.os.fchown = original_fchown
    assert not glob.glob(str(pathlib.Path(temporary) / ".secret.incoming-*"))
`;
  const result = spawnSync("python3", ["-", promoterPath], { encoding: "utf8", input: script });
  assert.equal(result.status, 0, result.stderr);
});

test("runtime receipt binds exact images, containers, networks, mounts, and port boundary", async (context) => {
  const setup = await fixture(context);
  const observed = await observeRuntime({ docker: setup.docker, environment: setup.environment });
  const receipt = receiptDocument(observed, "2026-08-25T12:00:00.000Z");
  assert.equal(validateReceiptDocument(receipt), receipt);
  assert.equal(receipt.networks[0].name, INTERNAL_NETWORK);
  assert.equal(receipt.networks[1].name, EGRESS_NETWORK);
  assert.equal(receipt.networks[2].name, INGRESS_NETWORK);
  assert.equal(receipt.containers[0].ports.length, 0);
  assert.deepEqual(receipt.containers[1].ports, [{
    containerPort: "443/tcp",
    hostIp: "0.0.0.0",
    hostPort: "443",
  }]);
  assert.equal(receipt.images.caddy.contract, "hyperpools/caddy-image-security/v2");
  assert.equal(receipt.images.caddy.buildLockSha256, CADDY_BUILD_LOCK);
  assert.equal(receipt.images.caddy.platform, "linux/amd64");
  await verifyLiveReceipt(receipt, { docker: setup.docker });
});

test("staged policy modes are exact without weakening private bindings", async (context) => {
  const setup = await fixture(context);
  const observed = await observeRuntime({ docker: setup.docker, environment: setup.environment });
  assert.equal(observed.bindings.caddyfile.mode, "644");
  assert.equal(observed.bindings.compose.mode, "644");
  assert.equal(observed.bindings.caddyfile.path, setup.policy.caddyfile);
  assert.equal(observed.bindings.compose.path, setup.policy.compose);
  assert.notEqual(observed.bindings.caddyfile.path, path.join(ROOT, "ops", "Caddyfile"));
  await assert.rejects(stageRuntimePolicy(setup.runtimeRoot), /runtime policy already exists/);

  const writablePolicy = structuredClone(observed);
  writablePolicy.bindings.caddyfile.mode = "664";
  assert.throws(
    () => validateReceiptDocument(receiptDocument(writablePolicy, "2026-08-25T12:00:00.000Z")),
    /Caddyfile permissions must be 644/,
  );

  const publicPrivateBinding = structuredClone(observed);
  publicPrivateBinding.bindings.caddyBuildLock.mode = "644";
  assert.throws(
    () => validateReceiptDocument(receiptDocument(publicPrivateBinding, "2026-08-25T12:00:00.000Z")),
    /Caddy custom build lock permissions are too broad/,
  );
});

test("Caddy admission accepts only the shared fresh zero-finding multi-platform decision", async (context) => {
  const setup = await fixture(context);
  const summary = validateCaddyImageSecurity(setup.decision, {
    expectedImage: CADDY_REFERENCE,
    requireAccepted: true,
  });
  assert.equal(summary.image, CADDY_REFERENCE);
  assert.equal(validateRunningCaddyImage(setup.decision, {
    architecture: "amd64",
    imageId: CADDY_IMAGE_ID,
    imageReference: CADDY_REFERENCE,
    os: "linux",
    repoDigests: [CADDY_REFERENCE],
    variant: null,
  }).imageConfigSha256, CADDY_IMAGE_ID.slice(7));

  const vulnerable = structuredClone(setup.decision);
  vulnerable.current.platforms["linux/amd64"].criticalHighFindings = 1;
  assert.throws(() => validateCaddyImageSecurity(vulnerable, {
    expectedImage: CADDY_REFERENCE,
    requireAccepted: true,
  }), /must remain release-blocked/);

  const stale = structuredClone(setup.decision);
  stale.scannedAt = "2026-08-20T00:00:00.000Z";
  assert.throws(() => validateCaddyImageSecurity(stale, {
    expectedImage: CADDY_REFERENCE,
    requireAccepted: true,
  }), /scan timestamp is stale/);
});

test("runtime capture rejects mutable images and every network, mount, or host-port drift", async (context) => {
  const setup = await fixture(context);
  assert.throws(() => immutableImageReference("hyperfaucet:latest"), /must be immutable/);

  await assert.rejects(
    observeRuntime({
      docker: setup.docker,
      environment: { ...setup.environment, HYPERFAUCET_CADDY_BUILD_LOCK_SHA256: "0".repeat(64) },
    }),
    /does not match the bound build-lock file/,
  );

  setup.app.HostConfig.PortBindings = { "8082/tcp": [{ HostIp: "", HostPort: "8082" }] };
  setup.app.NetworkSettings.Ports = { "8082/tcp": [{ HostIp: "", HostPort: "8082" }] };
  await assert.rejects(
    observeRuntime({ docker: setup.docker, environment: setup.environment }),
    /app must not publish a host port/,
  );
  setup.app.HostConfig.PortBindings = {};
  delete setup.app.NetworkSettings.Ports;

  const activeCaddyPort = setup.caddy.NetworkSettings.Ports["443/tcp"];
  setup.caddy.NetworkSettings.Ports["443/tcp"] = null;
  await assert.rejects(
    observeRuntime({ docker: setup.docker, environment: setup.environment }),
    /caddy active port bindings do not match the requested policy/,
  );
  setup.caddy.NetworkSettings.Ports["443/tcp"] = activeCaddyPort;

  setup.app.NetworkSettings.Networks.shared = { NetworkID: "9".repeat(64) };
  await assert.rejects(
    observeRuntime({ docker: setup.docker, environment: setup.environment }),
    /app network attachments changed/,
  );
  delete setup.app.NetworkSettings.Networks.shared;

  setup.caddy.NetworkSettings.Networks[EGRESS_NETWORK] = { NetworkID: EGRESS_ID };
  await assert.rejects(
    observeRuntime({ docker: setup.docker, environment: setup.environment }),
    /caddy network attachments changed/,
  );
  delete setup.caddy.NetworkSettings.Networks[EGRESS_NETWORK];

  setup.app.Mounts.find(({ Destination }) => Destination === "/data").RW = false;
  await assert.rejects(
    observeRuntime({ docker: setup.docker, environment: setup.environment }),
    /app bind mounts changed/,
  );
  setup.app.Mounts.find(({ Destination }) => Destination === "/data").RW = true;

  setup.app.HostConfig.ReadonlyRootfs = false;
  await assert.rejects(
    observeRuntime({ docker: setup.docker, environment: setup.environment }),
    /app host security policy changed/,
  );
});

test("live verification detects in-place policy-file changes", async (context) => {
  const setup = await fixture(context);
  const receipt = receiptDocument(await observeRuntime({
    docker: setup.docker,
    environment: setup.environment,
  }), "2026-08-25T12:00:00.000Z");
  await writeFile(path.join(setup.runtimeRoot, "config", "faucet-config.yaml"), "version: 3\n");
  await assert.rejects(
    verifyLiveReceipt(receipt, { docker: setup.docker }),
    /live HyperFaucet runtime changed from its receipt/,
  );
});

test("state-copy gate binds full stopped-container identity and detects a restart", async (context) => {
  const setup = await fixture(context);
  const receipt = receiptDocument(await observeRuntime({
    docker: setup.docker,
    environment: setup.environment,
  }), "2026-08-25T12:00:00.000Z");
  for(const container of [setup.app, setup.caddy]) {
    container.RestartCount = 0;
    container.State = {
      Dead: false,
      FinishedAt: "2026-08-25T12:01:00.000000000Z",
      Paused: false,
      Pid: 0,
      Restarting: false,
      Running: false,
      StartedAt: "2026-08-25T12:00:00.000000000Z",
      Status: "exited",
    };
  }
  const stoppedStates = await assertReceiptContainersStopped(receipt, { docker: setup.docker });
  setup.app.Mounts.find(({ Destination }) => Destination === "/data").RW = false;
  await assert.rejects(
    assertReceiptContainersStopped(receipt, { docker: setup.docker }),
    /app bind mounts changed/,
  );
  setup.app.Mounts.find(({ Destination }) => Destination === "/data").RW = true;
  setup.app.State.FinishedAt = "2026-08-25T12:02:00.000000000Z";
  await assert.rejects(
    assertReceiptContainersStopped(receipt, { docker: setup.docker, expectedStates: stoppedStates }),
    /restarted during state copy/,
  );
});

test("snapshot creation verifies SQLite and restores config plus state into a new runtime root", async (context) => {
  const setup = await fixture(context);
  const observed = await observeRuntime({ docker: setup.docker, environment: setup.environment });
  const receipt = receiptDocument(observed, "2026-08-25T12:00:00.000Z");
  const snapshot = path.join(setup.root, "snapshot");
  const assertStopped = async (candidate) => assert.equal(candidate.receiptSha256, receipt.receiptSha256);
  const created = await createSnapshot({
    assertStopped,
    outputDirectory: snapshot,
    receipt,
  });
  assert.equal((await verifySnapshot(snapshot)).snapshotSha256, created.snapshotSha256);
  const restored = path.join(setup.root, "restored-runtime");
  await restoreSnapshot({
    assertStopped,
    receipt,
    runtimeRoot: restored,
    snapshotDirectory: snapshot,
  });
  assert.equal(await readFile(path.join(restored, "config", "faucet-config.yaml"), "utf8"), "version: 2\n");
  const restoredDb = new sqlite.Database(path.join(restored, "state", "faucet-store.db"), { fileMustExist: true });
  assert.equal(restoredDb.get("SELECT Value FROM Fixture").Value, "durable");
  restoredDb.close();
  await assert.rejects(
    restoreSnapshot({ assertStopped, receipt, runtimeRoot: restored, snapshotDirectory: snapshot }),
    /restore runtime root already exists/,
  );
});

test("snapshot verification rejects payload drift and creation rejects state symlinks", async (context) => {
  const setup = await fixture(context);
  const receipt = receiptDocument(await observeRuntime({
    docker: setup.docker,
    environment: setup.environment,
  }), "2026-08-25T12:00:00.000Z");
  const assertStopped = async () => {};
  const snapshot = path.join(setup.root, "snapshot-drift");
  await createSnapshot({ assertStopped, outputDirectory: snapshot, receipt });
  await writeFile(path.join(snapshot, "runtime", "config", "faucet-config.yaml"), "changed: true\n");
  await assert.rejects(verifySnapshot(snapshot), /payload does not match/);

  const linkTarget = path.join(setup.root, "outside.txt");
  await writeFile(linkTarget, "outside\n");
  await symlink(linkTarget, path.join(setup.runtimeRoot, "state", "escape"));
  await assert.rejects(
    createSnapshot({
      assertStopped,
      outputDirectory: path.join(setup.root, "snapshot-symlink"),
      receipt,
    }),
    /must not be a symbolic link/,
  );
});
