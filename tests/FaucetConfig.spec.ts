import "mocha";
import { expect } from "chai";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";
import { cliArgs, faucetConfig, loadFaucetConfig } from "../src/config/FaucetConfig.js";

const MODULE_SECRET_OVERRIDES = [
  {environmentName: "FAUCET_CAPTCHA_SECRET", moduleName: "captcha", secretField: "secret"},
  {environmentName: "FAUCET_GITHUB_APP_SECRET", moduleName: "github", secretField: "appSecret"},
  {environmentName: "FAUCET_PASSPORT_SCORER_API_KEY", moduleName: "passport", secretField: "scorerApiKey"},
] as const;
const MIN_SAFE_TIMER_INTERVAL_SECONDS = 0.001;
const MAX_SAFE_TIMER_INTERVAL_SECONDS = (2_147_483_647 - 10) / 1000;
const TIMER_INTERVAL_REQUIREMENT =
  `must be a finite number between ${MIN_SAFE_TIMER_INTERVAL_SECONDS} and ` +
  `${MAX_SAFE_TIMER_INTERVAL_SECONDS} seconds`;

describe("Faucet configuration", () => {
  let originalConfigArg: unknown;
  let originalDatadirArg: unknown;
  let originalModuleEnvironment: Map<string, string | undefined>;
  let configDirectory: string;

  beforeEach(() => {
    originalConfigArg = cliArgs["config"];
    originalDatadirArg = cliArgs["datadir"];
    configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "powfaucet-config-test-"));
    cliArgs["config"] = "faucet-config.yaml";
    cliArgs["datadir"] = configDirectory;
    originalModuleEnvironment = new Map(MODULE_SECRET_OVERRIDES.map(({environmentName}) => {
      return [environmentName, process.env[environmentName]];
    }));
    MODULE_SECRET_OVERRIDES.forEach(({environmentName}) => delete process.env[environmentName]);
  });

  afterEach(() => {
    if(typeof originalConfigArg === "undefined")
      delete cliArgs["config"];
    else
      cliArgs["config"] = originalConfigArg;
    if(typeof originalDatadirArg === "undefined")
      delete cliArgs["datadir"];
    else
      cliArgs["datadir"] = originalDatadirArg;
    MODULE_SECRET_OVERRIDES.forEach(({environmentName}) => {
      const originalValue = originalModuleEnvironment.get(environmentName);
      if(originalValue === undefined)
        delete process.env[environmentName];
      else
        process.env[environmentName] = originalValue;
    });
    fs.rmSync(configDirectory, {recursive: true, force: true});
  });

  function loadConfig(overrides: Record<string, unknown>): void {
    const config = {
      version: 2,
      faucetSecret: "f".repeat(64),
      pseudonymKey: "p".repeat(64),
      modules: {},
      ...overrides,
    };
    fs.writeFileSync(path.join(configDirectory, "faucet-config.yaml"), YAML.stringify(config));
    loadFaucetConfig();
  }

  it("uses HyperFaucet branding by default", () => {
    loadConfig({});

    expect(faucetConfig.faucetTitle).to.equal("HyperFaucet");
  });

  it("accepts positive fractional timer intervals", () => {
    loadConfig({
      faucetLogStatsInterval: 0.25,
      faucetStatus: {refresh: 0.125},
    });

    expect(faucetConfig.faucetLogStatsInterval).to.equal(0.25);
    expect(faucetConfig.faucetStatus?.refresh).to.equal(0.125);
  });

  for(const boundary of [MIN_SAFE_TIMER_INTERVAL_SECONDS, MAX_SAFE_TIMER_INTERVAL_SECONDS]) {
    it(`accepts the ${boundary}-second timer boundary`, () => {
      loadConfig({
        faucetLogStatsInterval: boundary,
        faucetStatus: {refresh: boundary},
      });

      expect(faucetConfig.faucetLogStatsInterval).to.equal(boundary);
      expect(faucetConfig.faucetStatus?.refresh).to.equal(boundary);
    });
  }

  for(const [name, value] of [
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["not finite", Number.POSITIVE_INFINITY],
  ] as const) {
    it(`rejects a ${name} faucetLogStatsInterval`, () => {
      expect(() => loadConfig({faucetLogStatsInterval: value}))
        .to.throw(`faucetLogStatsInterval ${TIMER_INTERVAL_REQUIREMENT}`);
    });

    it(`rejects a ${name} faucetStatus.refresh`, () => {
      expect(() => loadConfig({faucetStatus: {refresh: value}}))
        .to.throw(`faucetStatus.refresh ${TIMER_INTERVAL_REQUIREMENT}`);
    });
  }

  for(const [description, value] of [
    ["a below-minimum", MIN_SAFE_TIMER_INTERVAL_SECONDS - 0.000_001],
    ["an above-maximum", MAX_SAFE_TIMER_INTERVAL_SECONDS + 0.001],
  ] as const) {
    it(`rejects ${description} faucetLogStatsInterval`, () => {
      expect(() => loadConfig({faucetLogStatsInterval: value}))
        .to.throw(`faucetLogStatsInterval ${TIMER_INTERVAL_REQUIREMENT}`);
    });

    it(`rejects ${description} faucetStatus.refresh`, () => {
      expect(() => loadConfig({faucetStatus: {refresh: value}}))
        .to.throw(`faucetStatus.refresh ${TIMER_INTERVAL_REQUIREMENT}`);
    });
  }

  it("accepts explicitly enabled and disabled module entries", () => {
    loadConfig({
      modules: {
        enabledModule: {enabled: true},
        disabledModule: {enabled: false},
      },
    });

    expect(faucetConfig.modules.enabledModule.enabled).to.equal(true);
    expect(faucetConfig.modules.disabledModule.enabled).to.equal(false);
  });

  for(const {environmentName, moduleName, secretField} of MODULE_SECRET_OVERRIDES) {
    it(`creates a disabled ${moduleName} entry for ${environmentName}`, () => {
      const secret = `test-${moduleName}-secret`;
      process.env[environmentName] = secret;

      loadConfig({});

      expect(faucetConfig.modules[moduleName]).to.deep.include({
        enabled: false,
        [secretField]: secret,
      });
      MODULE_SECRET_OVERRIDES
        .filter((override) => override.moduleName !== moduleName)
        .forEach((override) => expect(faucetConfig.modules[override.moduleName]).to.equal(undefined));
      expect(fs.readFileSync(path.join(configDirectory, "faucet-config.yaml"), "utf8"))
        .to.not.include(secret);
    });
  }

  for(const [description, moduleConfig] of [
    ["null", null],
    ["an array", []],
    ["a string", "disabled"],
    ["a number", 0],
  ] as const) {
    it(`rejects a module entry that is ${description}`, () => {
      expect(() => loadConfig({modules: {example: moduleConfig}}))
        .to.throw("modules.example must be a YAML object");
    });
  }

  for(const [description, enabled] of [
    ["is missing", undefined],
    ["is null", null],
    ["is zero", 0],
    ["is an empty string", ""],
    ["is a string", "false"],
  ] as const) {
    it(`rejects a module entry whose enabled field ${description}`, () => {
      const moduleConfig = enabled === undefined ? {} : {enabled};
      expect(() => loadConfig({modules: {example: moduleConfig}}))
        .to.throw("modules.example.enabled must be a boolean");
    });
  }

  it("keeps the last valid config after rejected module and interval reloads", () => {
    loadConfig({
      faucetLogStatsInterval: 1.5,
      faucetStatus: {refresh: 2.5},
      modules: {stable: {enabled: false}},
    });
    const lastGoodConfig = faucetConfig;
    const lastGoodValues = {
      faucetLogStatsInterval: faucetConfig.faucetLogStatsInterval,
      faucetStatusRefresh: faucetConfig.faucetStatus?.refresh,
      modules: structuredClone(faucetConfig.modules),
    };
    const expectLastGoodConfig = () => {
      expect(faucetConfig).to.equal(lastGoodConfig);
      expect({
        faucetLogStatsInterval: faucetConfig.faucetLogStatsInterval,
        faucetStatusRefresh: faucetConfig.faucetStatus?.refresh,
        modules: faucetConfig.modules,
      }).to.deep.equal(lastGoodValues);
    };

    expect(() => loadConfig({modules: {invalid: {enabled: 0}}}))
      .to.throw("modules.invalid.enabled must be a boolean");
    expectLastGoodConfig();

    expect(() => loadConfig({faucetLogStatsInterval: MIN_SAFE_TIMER_INTERVAL_SECONDS / 2}))
      .to.throw(`faucetLogStatsInterval ${TIMER_INTERVAL_REQUIREMENT}`);
    expectLastGoodConfig();
  });
});
