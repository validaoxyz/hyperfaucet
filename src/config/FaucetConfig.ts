import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml'
import randomBytes from 'randombytes'

import { ServiceManager } from '../common/ServiceManager.js';
import { FaucetLogLevel, FaucetProcess } from '../common/FaucetProcess.js';
import { IConfigSchema } from './ConfigSchema.js';
import { getDefaultConfig } from './DefaultConfig.js';

const GENERATED_SECRET_BYTES = 32;
const MIN_SECRET_BYTES = 32;
const MIN_SAFE_TIMER_INTERVAL_SECONDS = 0.001;
const MAX_SAFE_TIMER_INTERVAL_SECONDS = (2_147_483_647 - 10) / 1000;
const SECRET_PLACEHOLDERS = new Set([
  "***censored***",
  "randomstringthatshouldbeverysecret!",
  "replace_with_32_byte_random_secret",
  "replace_with_different_32_byte_random_secret",
]);

function replaceGeneratedSecret(yaml: string, key: "faucetSecret" | "pseudonymKey"): string {
  let pattern = new RegExp(`^${key}:.*$`, "m");
  if(!pattern.test(yaml))
    throw new Error(`Default config template is missing ${key}`);
  let secret = randomBytes(GENERATED_SECRET_BYTES).toString("hex");
  return yaml.replace(pattern, `${key}: "${secret}"`);
}

function buildGeneratedConfig(exampleYaml: string): string {
  let walletPattern = /^ethWalletKey:.*$/m;
  if(!walletPattern.test(exampleYaml))
    throw new Error("Default config template is missing ethWalletKey");

  let generatedYaml = exampleYaml.replace(
    walletPattern,
    `ethWalletKey: "${randomBytes(32).toString("hex")}"`,
  );
  generatedYaml = replaceGeneratedSecret(generatedYaml, "faucetSecret");
  return replaceGeneratedSecret(generatedYaml, "pseudonymKey");
}

function installGeneratedConfig(configFile: string, contents: string): void {
  let tempFile = path.join(
    path.dirname(configFile),
    `.${path.basename(configFile)}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`,
  );
  let noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let fileDescriptor: number | null = null;

  try {
    fileDescriptor = fs.openSync(
      tempFile,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    fs.fchmodSync(fileDescriptor, 0o600);
    fs.writeFileSync(fileDescriptor, contents, { encoding: "utf8" });
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = null;

    // A same-directory hard link installs the complete inode atomically and
    // fails with EEXIST for every existing destination, including symlinks.
    fs.linkSync(tempFile, configFile);
  } finally {
    if(fileDescriptor !== null)
      fs.closeSync(fileDescriptor);
    try {
      fs.unlinkSync(tempFile);
    } catch(ex) {
      if((ex as NodeJS.ErrnoException).code !== "ENOENT")
        throw ex;
    }
  }
}

function validateSecret(name: string, value: unknown, required: boolean): string | null {
  if(value === null || typeof value === "undefined" || value === "") {
    if(required)
      throw new Error(`${name} is required and must contain at least ${MIN_SECRET_BYTES} bytes`);
    return null;
  }
  if(typeof value !== "string")
    throw new Error(`${name} must be a string`);

  let normalized = value.trim();
  if(!normalized || SECRET_PLACEHOLDERS.has(normalized.toLowerCase()))
    throw new Error(`${name} still contains a placeholder`);
  if(Buffer.byteLength(normalized, "utf8") < MIN_SECRET_BYTES)
    throw new Error(`${name} must contain at least ${MIN_SECRET_BYTES} bytes`);
  return normalized;
}

function validateRuntimeSecrets(config: IConfigSchema): void {
  config.faucetSecret = validateSecret("faucetSecret", config.faucetSecret, true);
  config.pseudonymKey = validateSecret("pseudonymKey", config.pseudonymKey, true);
  config.statusAdminToken = validateSecret("statusAdminToken", config.statusAdminToken, false);

  if(config.pseudonymKey === config.faucetSecret)
    throw new Error("pseudonymKey must be different from faucetSecret");
  if(config.statusAdminToken === config.faucetSecret || config.statusAdminToken === config.pseudonymKey)
    throw new Error("statusAdminToken must be different from faucetSecret and pseudonymKey");
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseConfig(yamlSrc: string): Record<string, unknown> {
  let parsed: unknown = YAML.parse(yamlSrc);
  if(!isConfigObject(parsed))
    throw new Error("Faucet configuration must be a YAML object");
  if(!parsed.version || parsed.version == 1)
    throw new Error("V1 configuration is incompatible with V2.");
  return parsed;
}

function getModuleEnvironmentOverrideTarget(
  modules: IConfigSchema["modules"],
  moduleName: string,
): Record<string, unknown> {
  const moduleConfig: unknown = modules[moduleName];
  if(moduleConfig === undefined) {
    const disabledModule = {enabled: false};
    modules[moduleName] = disabledModule;
    return disabledModule;
  }
  if(!isConfigObject(moduleConfig))
    throw new Error(`modules.${moduleName} must be a YAML object`);
  return moduleConfig;
}

function applyEnvironmentOverrides(config: IConfigSchema): void {
  // Environment overrides are part of the candidate and are validated before
  // the candidate becomes visible to the rest of the process.
  if(process.env.FAUCET_SECRET)
    config.faucetSecret = process.env.FAUCET_SECRET;
  if(process.env.FAUCET_PSEUDONYM_KEY)
    config.pseudonymKey = process.env.FAUCET_PSEUDONYM_KEY;
  if(process.env.FAUCET_STATUS_ADMIN_TOKEN)
    config.statusAdminToken = process.env.FAUCET_STATUS_ADMIN_TOKEN;
  if(process.env.FAUCET_ETH_WALLET_KEY)
    config.ethWalletKey = process.env.FAUCET_ETH_WALLET_KEY;

  if(!config.modules || typeof config.modules !== "object" || Array.isArray(config.modules))
    throw new Error("modules must be a YAML object");
  if(process.env.FAUCET_CAPTCHA_SECRET)
    getModuleEnvironmentOverrideTarget(config.modules, "captcha").secret = process.env.FAUCET_CAPTCHA_SECRET;
  if(process.env.FAUCET_GITHUB_APP_SECRET)
    getModuleEnvironmentOverrideTarget(config.modules, "github").appSecret = process.env.FAUCET_GITHUB_APP_SECRET;
  if(process.env.FAUCET_PASSPORT_SCORER_API_KEY)
    getModuleEnvironmentOverrideTarget(config.modules, "passport").scorerApiKey = process.env.FAUCET_PASSPORT_SCORER_API_KEY;
  if(process.env.FAUCET_SERVER_PORT)
    config.serverPort = parseInt(process.env.FAUCET_SERVER_PORT, 10);
  if(process.env.FAUCET_HTTP_PROXY_OFFSET)
    config.httpProxyCount += parseInt(process.env.FAUCET_HTTP_PROXY_OFFSET, 10);
}

function validateTimerInterval(name: string, value: unknown): void {
  if(
    typeof value !== "number" || !Number.isFinite(value) ||
    value < MIN_SAFE_TIMER_INTERVAL_SECONDS || value > MAX_SAFE_TIMER_INTERVAL_SECONDS
  ) {
    throw new Error(
      `${name} must be a finite number between ` +
      `${MIN_SAFE_TIMER_INTERVAL_SECONDS} and ${MAX_SAFE_TIMER_INTERVAL_SECONDS} seconds`,
    );
  }
}

function validateModuleConfigs(modules: unknown): void {
  if(!isConfigObject(modules))
    throw new Error("modules must be a YAML object");

  for(const [moduleName, moduleConfig] of Object.entries(modules)) {
    if(!isConfigObject(moduleConfig))
      throw new Error(`modules.${moduleName} must be a YAML object`);
    if(typeof moduleConfig.enabled !== "boolean")
      throw new Error(`modules.${moduleName}.enabled must be a boolean`);
  }
}

function validateCandidate(config: IConfigSchema, loadDefaultsOnly: boolean): void {
  if(!Number.isSafeInteger(config.httpProxyCount) || config.httpProxyCount < 0)
    throw new Error("httpProxyCount must be a non-negative integer");
  validateModuleConfigs(config.modules);
  validateTimerInterval("faucetLogStatsInterval", config.faucetLogStatsInterval);
  if(config.faucetStatus !== null) {
    if(!isConfigObject(config.faucetStatus))
      throw new Error("faucetStatus must be a YAML object or null");
    if(config.faucetStatus.refresh !== undefined)
      validateTimerInterval("faucetStatus.refresh", config.faucetStatus.refresh);
  }
  if(!loadDefaultsOnly)
    validateRuntimeSecrets(config);
}

export let cliArgs = (function() {
  let args = {};
  let arg, key;
  for(let i = 0; i < process.argv.length; i++) {
      if((arg = /^--([^=]+)(?:=(.+))?$/.exec(process.argv[i]))) {
          key = arg[1];
          args[arg[1]] = arg[2] || true;
      }
      else if(key) {
          args[key] = process.argv[i];
          key = null;
      }
  }
  return args;
})();


let internalBasePath = path.join(".");
export let faucetConfig: IConfigSchema = null;

export function getAppDataDir(): string {
  let datadir: string;

  if(cliArgs['datadir']) {
    datadir = cliArgs['datadir'];
    if(!path.isAbsolute(datadir))
      datadir = resolveRelativePath(datadir, process.cwd());
  }
  else
    datadir = process.cwd();

  return datadir;
}

export function setAppBasePath(basePath: string) {
  internalBasePath = basePath;
}

export function loadFaucetConfig(loadDefaultsOnly = false): void {
  let datadir = getAppDataDir();
  let config: Record<string, unknown> | undefined;
  let configFile: string;

  if(cliArgs['config']) {
    if(path.isAbsolute(cliArgs['config']))
      configFile = cliArgs['config'];
    else
      configFile = path.join(datadir, cliArgs['config']);
  }
  else
    configFile = path.join(datadir, "faucet-config.yaml");

  let faucetVersion: string;
  if(typeof POWFAUCET_VERSION !== "undefined") {
    faucetVersion = POWFAUCET_VERSION;
  } else {
    let packageJson = JSON.parse(fs.readFileSync(path.join(internalBasePath, "package.json"), 'utf8'));
    faucetVersion = packageJson.version;
  }

  let yamlSrc: string | undefined;
  if(!loadDefaultsOnly) {
    try {
      yamlSrc = fs.readFileSync(configFile, "utf8");
    } catch(ex) {
      if((ex as NodeJS.ErrnoException).code !== "ENOENT")
        throw ex;

      let exampleConfigFile = resolveRelativePath("~app/faucet-config.example.yaml");
      let exampleYamlSrc: string;
      try {
        exampleYamlSrc = fs.readFileSync(exampleConfigFile, "utf8");
      } catch(templateError) {
        if((templateError as NodeJS.ErrnoException).code === "ENOENT")
          throw new Error(exampleConfigFile + " not found");
        throw templateError;
      }

      yamlSrc = buildGeneratedConfig(exampleYamlSrc);
      installGeneratedConfig(configFile, yamlSrc);
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Created default config at " + configFile);
    }
  }
  if(cliArgs['create-config']) {
    process.exit(0);
  }

  if(!loadDefaultsOnly) {
    config = parseConfig(yamlSrc);
  }

  if(config) {
    if(typeof config.staticPath === "string" && config.staticPath)
      config.staticPath = resolveRelativePath(config.staticPath);
    if(typeof config.faucetPidFile === "string" && config.faucetPidFile)
      config.faucetPidFile = resolveRelativePath(config.faucetPidFile);
    if(typeof config.faucetLogFile === "string" && config.faucetLogFile)
      config.faucetLogFile = resolveRelativePath(config.faucetLogFile);
    if(isConfigObject(config.faucetStats) && typeof config.faucetStats.logfile === "string" && config.faucetStats.logfile)
      config.faucetStats.logfile = resolveRelativePath(config.faucetStats.logfile);
  }

  let candidate = Object.assign(getDefaultConfig(), config || {}, {
    appBasePath: datadir,
    faucetVersion: faucetVersion,
  });
  applyEnvironmentOverrides(candidate);
  validateCandidate(candidate, loadDefaultsOnly);

  faucetConfig = candidate;
  if(!loadDefaultsOnly)
    ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Loaded faucet config from yaml file: " + configFile);
}

export function resolveRelativePath(inputPath: string, customBasePath?: string): string {
  if(!inputPath || typeof inputPath !== "string" || inputPath === ":memory:")
    return inputPath;

  let outputPath: string = inputPath;
  if(inputPath.match(/^~app\//))
    outputPath = path.join(internalBasePath, inputPath.replace(/^~app\//, ""));
  else if(!path.isAbsolute(inputPath))
    outputPath = path.join(customBasePath || getAppDataDir(), inputPath);

  return outputPath;
}
