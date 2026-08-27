import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { bindTestStubs, unbindTestStubs, loadDefaultTestConfig } from '../common.js';
import { ServiceManager } from '../../src/common/ServiceManager.js';
import { FaucetDatabase } from '../../src/db/FaucetDatabase.js';
import { ModuleManager } from '../../src/modules/ModuleManager.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { faucetConfig } from '../../src/config/FaucetConfig.js';
import { IDynamicOutflowConfig, validateDynamicOutflowConfig } from '../../src/modules/dynamic-outflow/DynamicOutflowConfig.js';
import { FakeProvider } from '../stubs/FakeProvider.js';
import { EthWalletManager } from '../../src/eth/EthWalletManager.js';
import { FaucetWebApi } from '../../src/webserv/FaucetWebApi.js';
import { sleepPromise } from '../../src/utils/PromiseUtils.js';
import { DynamicOutflowModule } from '../../src/modules/dynamic-outflow/DynamicOutflowModule.js';
import { EthClaimManager } from '../../src/eth/EthClaimManager.js';


describe("Faucet module: dynamic-outflow", () => {
  let globalStubs;
  let fakeProvider;

  beforeEach(async () => {
    globalStubs = bindTestStubs();
    fakeProvider = new FakeProvider();
    loadDefaultTestConfig();
    faucetConfig.faucetStats = null;
    faucetConfig.ethWalletKey = "feedbeef12340000feedbeef12340000feedbeef12340000feedbeef12340000";
    faucetConfig.ethRpcHost = fakeProvider;
    faucetConfig.spareFundsAmount = 0;
    faucetConfig.maxDropAmount = 100;
    faucetConfig.minDropAmount = 10;
    await ServiceManager.GetService(FaucetDatabase).initialize();
    fakeProvider.injectResponse("eth_chainId", 1337);
    fakeProvider.injectResponse("eth_getBalance", "100000");
    fakeProvider.injectResponse("eth_getTransactionCount", 42);
    await ServiceManager.GetService(EthWalletManager).initialize();
  });
  afterEach(async () => {
    let dbService = ServiceManager.GetService(FaucetDatabase);
    await ServiceManager.DisposeAllServices();
    await dbService.closeDatabase();
    await unbindTestStubs(globalStubs);
  });

  function moduleConfig(overrides?: Partial<IDynamicOutflowConfig>): IDynamicOutflowConfig {
    return Object.assign({
      enabled: true,
      targetDrainTime: 10, // wallet balance 100000 wei -> rate 10000 wei/sec
      refreshInterval: 3600, // don't refresh during the test, tests trigger refreshes explicitly
      burstWindow: 2,
      cutoffWindow: 1,
    }, overrides || {}) as IDynamicOutflowConfig;
  }

  async function initModule(): Promise<DynamicOutflowModule> {
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    await ServiceManager.GetService(SessionManager).initialize();
    await ServiceManager.GetService(EthClaimManager).initialize();
    await moduleManager.activateModulesAfterStateRestore();
    return moduleManager.getModule<DynamicOutflowModule>("dynamic-outflow");
  }

  function freezeBudget(module: DynamicOutflowModule, budget: bigint) {
    (module as any).outflowState.budget = budget;
    (module as any).outflowState.updateTime = Math.floor(new Date().getTime() / 1000);
  }

  async function runTestSession(expectedStatus?: string): Promise<bigint> {
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal(expectedStatus || "claimable", "unexpected session status");
    return testSession.getDropAmount();
  }

  async function awaitTimeSlot() {
    let now = new Date().getTime();
    let millis = now % 1000;
    if(millis < 50)
      return;
    await sleepPromise(1000 - millis + 10);
  }

  it("Compute outflow rate from wallet balance", async () => {
    faucetConfig.modules["dynamic-outflow"] = moduleConfig();
    await awaitTimeSlot();
    let module = await initModule();
    let debugState = module.getOutflowDebugState();
    expect(debugState.rate).to.equal("10000", "unexpected outflow rate");
    expect(debugState.restriction).to.equal(1, "unexpected restriction");
    expect(await runTestSession()).to.equal(100n, "unexpected drop amount: session 1");
    expect(module.getOutflowDebugState().budget).to.equal("-100", "unexpected budget after session 1");
    expect(await runTestSession()).to.equal(99n, "unexpected drop amount: session 2");
  }).timeout(5000);

  it("targets one HYPE per 15 minutes at a 400 HYPE wallet", async () => {
    faucetConfig.spareFundsAmount = 1000000000000000000;
    faucetConfig.modules["dynamic-outflow"] = moduleConfig({
      targetDrainTime: 359100,
      burstWindow: 900,
      cutoffWindow: 900,
    });
    let balanceStub = sinon.stub(EthWalletManager.prototype, "getFaucetBalance").returns(400000000000000000000n);
    try {
      await awaitTimeSlot();
      let module = await initModule();
      let debugState = module.getOutflowDebugState();
      expect(debugState.rate).to.equal("1111111111111111", "unexpected target rate");
      expect(BigInt(debugState.rate) * 900n).to.equal(999999999999999900n, "unexpected 15-minute allowance");
    } finally {
      balanceStub.restore();
    }
  }).timeout(5000);

  it("rejects invalid duration and window configuration", () => {
    for(let field of ["targetDrainTime", "refreshInterval", "burstWindow", "cutoffWindow"] as const) {
      for(let value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        let config = moduleConfig({[field]: value} as Partial<IDynamicOutflowConfig>);
        expect(() => validateDynamicOutflowConfig(config), `${field}=${value}`).to.throw(
          `${field} must be a positive safe integer number of seconds`,
        );
      }
    }
  });

  it("Restrict rewards linearly when budget is overdrafted", async () => {
    faucetConfig.modules["dynamic-outflow"] = moduleConfig();
    await awaitTimeSlot();
    let module = await initModule();
    freezeBudget(module, -5000n); // cutoff budget = rate * cutoffWindow = 10000
    expect(module.getOutflowDebugState().restriction).to.equal(0.5, "unexpected restriction");
    expect(await runTestSession()).to.equal(50n, "unexpected drop amount");
  }).timeout(5000);

  it("Deny rewards below the overdraft cutoff", async () => {
    faucetConfig.modules["dynamic-outflow"] = moduleConfig();
    await awaitTimeSlot();
    let module = await initModule();
    freezeBudget(module, -10000n);
    expect(module.getOutflowDebugState().restriction).to.equal(0, "unexpected restriction");
    expect(await runTestSession("failed")).to.equal(0n, "unexpected drop amount");
  }).timeout(5000);

  it("Cap accumulated budget at the burst window", async () => {
    faucetConfig.modules["dynamic-outflow"] = moduleConfig();
    await awaitTimeSlot();
    let module = await initModule();
    (module as any).outflowState.budget = 0n;
    (module as any).outflowState.updateTime = Math.floor(new Date().getTime() / 1000) - 10;
    // 10s * 10000 wei/s = 100000 accrued, capped at rate * burstWindow = 20000
    expect(module.getOutflowDebugState().budget).to.equal("20000", "unexpected capped budget");
  }).timeout(5000);

  it("Never forgive overdrafted debt beyond the cutoff", async () => {
    faucetConfig.modules["dynamic-outflow"] = moduleConfig();
    await awaitTimeSlot();
    let module = await initModule();
    freezeBudget(module, -20000n); // twice the cutoff budget of 10000
    expect(module.getOutflowDebugState().restriction).to.equal(0, "unexpected restriction");
    expect(await runTestSession("failed")).to.equal(0n, "unexpected drop amount");
    expect(module.getOutflowDebugState().budget).to.equal("-20000", "debt must not be floored to the cutoff");
    // 3 seconds of accrual at 10000 wei/s recovers the debt and caps at rate * burstWindow
    (module as any).outflowState.updateTime -= 3;
    expect(module.getOutflowDebugState().budget).to.equal("10000", "unexpected budget after recovery");
    expect(module.getOutflowDebugState().restriction).to.equal(1, "unexpected restriction after recovery");
  }).timeout(5000);

  it("Fail closed while wallet accounting is unknown or stale", async () => {
    faucetConfig.modules["dynamic-outflow"] = moduleConfig();
    await awaitTimeSlot();
    let module = await initModule();
    expect(module.getOutflowDebugState().restriction).to.equal(1, "unexpected restriction with fresh accounting");
    let realRate = (module as any).outflowRate;
    (module as any).outflowRate = null;
    expect(module.getOutflowDebugState().restriction).to.equal(0, "unexpected restriction with unknown balance");
    (module as any).outflowRate = realRate;
    (module as any).outflowRateTime -= 100000;
    expect(module.getOutflowDebugState().restriction).to.equal(0, "unexpected restriction with stale accounting");
  }).timeout(5000);

  it("Deny rewards when no mineable balance is left", async () => {
    faucetConfig.modules["dynamic-outflow"] = moduleConfig();
    await awaitTimeSlot();
    let module = await initModule();
    faucetConfig.spareFundsAmount = 100000; // reserve swallows the whole wallet balance
    await (module as any).refreshOutflowRate();
    expect(module.getOutflowDebugState().rate).to.equal("0", "unexpected rate");
    expect(module.getOutflowDebugState().restriction).to.equal(0, "unexpected restriction");
    expect(await runTestSession("failed")).to.equal(0n, "unexpected drop amount");
  }).timeout(5000);

  it("Save & restore outflow state", async () => {
    faucetConfig.modules["dynamic-outflow"] = moduleConfig();
    await awaitTimeSlot();
    let module = await initModule();
    freezeBudget(module, -5000n);
    await (module as any).saveOutflowState();
    (module as any).outflowState = null;
    await (module as any).loadOutflowState();
    freezeBudget(module, BigInt((module as any).outflowState.budget));
    expect(module.getOutflowDebugState().budget).to.equal("-5000", "unexpected budget after restore");
    expect(await runTestSession()).to.equal(50n, "unexpected drop amount after restore");
    // a positive burst buffer must not survive a restart (crash replay protection)
    freezeBudget(module, 15000n);
    await (module as any).saveOutflowState();
    (module as any).outflowState = null;
    await (module as any).loadOutflowState();
    expect((module as any).outflowState.budget.toString()).to.equal("0", "positive budget must not be restored");
  }).timeout(5000);

  it("flushes the latest outflow debit when modules stop", async () => {
    faucetConfig.modules["dynamic-outflow"] = moduleConfig();
    await awaitTimeSlot();
    let module = await initModule();
    freezeBudget(module, -4321n);

    await ServiceManager.GetService(ModuleManager).dispose();
    let storedState = JSON.parse(await ServiceManager.GetService(FaucetDatabase).getKeyValueEntry("DynamicOutflow.state"));
    expect(storedState.budget).to.equal("-4321", "shutdown lost the latest dynamic-outflow debit");
  }).timeout(5000);

  it("does not persist a failed reward debit during a concurrent refresh", async () => {
    faucetConfig.modules["dynamic-outflow"] = moduleConfig();
    await awaitTimeSlot();
    let module = await initModule();
    let fixedNow = Math.floor(Date.now() / 1000);
    sinon.stub(module as any, "now").returns(fixedNow);
    (module as any).outflowState = {budget: 5000n, updateTime: fixedNow};
    await (module as any).saveOutflowState();

    let database = ServiceManager.GetService(FaucetDatabase);
    let originalSave = database.setKeyValueEntry.bind(database);
    let saveStartedResolve: () => void;
    let failSaveResolve: () => void;
    let saveStarted = new Promise<void>((resolve) => { saveStartedResolve = resolve; });
    let failSave = new Promise<void>((resolve) => { failSaveResolve = resolve; });
    let saveCount = 0;
    sinon.stub(database, "setKeyValueEntry").callsFake(async (key, value) => {
      saveCount++;
      if(saveCount === 1) {
        saveStartedResolve();
        await failSave;
        throw new Error("injected save failure");
      }
      await originalSave(key, value);
    });

    let rewardResult = (module as any).processSessionRewarded(null, 100n);
    await saveStarted;
    let refreshResult = (module as any).refreshOutflowRate();
    failSaveResolve();
    let rewardFailure: Error = null;
    try {
      await rewardResult;
    } catch(ex) {
      rewardFailure = ex;
    }
    await refreshResult;

    expect(rewardFailure?.message).to.equal("injected save failure");
    expect(module.getOutflowDebugState().budget).to.equal("5000", "refresh preserved a failed reward debit");
    let storedState = JSON.parse(await database.getKeyValueEntry("DynamicOutflow.state"));
    expect(storedState.budget).to.equal("5000", "refresh persisted a failed reward debit");

    await (module as any).processSessionRewarded(null, 100n);
    expect(module.getOutflowDebugState().budget).to.equal("4900", "reward retry was not charged exactly once");
  }).timeout(5000);

  it("adopts a committed outflow debit when its write acknowledgement is lost", async () => {
    faucetConfig.modules["dynamic-outflow"] = moduleConfig();
    await awaitTimeSlot();
    let module = await initModule();
    let fixedNow = Math.floor(Date.now() / 1000);
    sinon.stub(module as any, "now").returns(fixedNow);
    (module as any).outflowState = {budget: 5000n, updateTime: fixedNow};
    await (module as any).saveOutflowState();

    let database = ServiceManager.GetService(FaucetDatabase);
    let originalSave = database.setKeyValueEntry.bind(database);
    let acknowledgementLost = false;
    sinon.stub(database, "setKeyValueEntry").callsFake(async (key, value) => {
      await originalSave(key, value);
      if(key === "DynamicOutflow.state" && !acknowledgementLost) {
        acknowledgementLost = true;
        throw new Error("dynamic outflow acknowledgement lost");
      }
    });

    let rewardError: unknown;
    try {
      await (module as any).processSessionRewarded(null, 100n);
    } catch(ex) {
      rewardError = ex;
    }

    expect(rewardError).to.equal(undefined);
    expect(acknowledgementLost).to.equal(true);
    expect(module.getOutflowDebugState().budget).to.equal("4900");
    let storedState = JSON.parse(await database.getKeyValueEntry("DynamicOutflow.state"));
    expect(storedState.budget).to.equal("4900");

    await (module as any).saveOutflowState();
    storedState = JSON.parse(await database.getKeyValueEntry("DynamicOutflow.state"));
    expect(storedState.budget).to.equal("4900", "a later save overwrote the adopted debit");
  }).timeout(5000);

  it("blocks writes and reloads while an unreadable or divergent debit outcome is uncertain", async () => {
    faucetConfig.modules["dynamic-outflow"] = moduleConfig();
    await awaitTimeSlot();
    let module = await initModule();
    let fixedNow = Math.floor(Date.now() / 1000);
    sinon.stub(module as any, "now").returns(fixedNow);
    (module as any).outflowState = {budget: -5000n, updateTime: fixedNow};
    await (module as any).saveOutflowState();

    let database = ServiceManager.GetService(FaucetDatabase);
    let previousJson = await database.getKeyValueEntry("DynamicOutflow.state");
    let durableJson = previousJson;
    let writeCalls = 0;
    let reconciliationReads = 0;
    let originalGet = database.getKeyValueEntry.bind(database);
    sinon.stub(database, "getKeyValueEntry").callsFake(async (key) => {
      if(key !== "DynamicOutflow.state")
        return originalGet(key);
      reconciliationReads++;
      if(reconciliationReads === 1)
        throw new Error("dynamic outflow reconciliation read failed");
      return durableJson;
    });
    let originalSave = database.setKeyValueEntry.bind(database);
    sinon.stub(database, "setKeyValueEntry").callsFake(async (key, value) => {
      if(key !== "DynamicOutflow.state")
        return originalSave(key, value);
      writeCalls++;
      if(writeCalls === 1)
        throw new Error("dynamic outflow write result unknown");
      durableJson = value;
    });

    let rewardError: unknown;
    try {
      await (module as any).processSessionRewarded(null, 100n);
    } catch(ex) {
      rewardError = ex;
    }
    expect(String(rewardError)).to.include("dynamic outflow write result unknown");
    expect(reconciliationReads).to.equal(1);
    expect(writeCalls).to.equal(1);
    expect(module.getOutflowDebugState().restriction).to.equal(0);

    durableJson = JSON.stringify({budget: "-777", updateTime: fixedNow});
    let divergentError: unknown;
    try {
      await (module as any).saveOutflowState();
    } catch(ex) {
      divergentError = ex;
    }
    expect(String(divergentError)).to.include("uncertain");
    expect(writeCalls).to.equal(1, "a divergent reconciliation allowed a later overwrite");
    expect(durableJson).to.equal(JSON.stringify({budget: "-777", updateTime: fixedNow}));

    let divergentLoadError: unknown;
    try {
      await (module as any).loadOutflowState();
    } catch(ex) {
      divergentLoadError = ex;
    }
    expect(String(divergentLoadError)).to.include("uncertain");
    expect(writeCalls).to.equal(1);

    durableJson = previousJson;
    await (module as any).loadOutflowState();
    expect(module.getOutflowDebugState().budget).to.equal("-5000");
    await (module as any).saveOutflowState();
    expect(writeCalls).to.equal(2, "the reconciled state did not resume persistence");
  }).timeout(5000);

  it("Export no client config (module has no client consumer)", async () => {
    faucetConfig.modules["dynamic-outflow"] = moduleConfig();
    await awaitTimeSlot();
    await initModule();
    let clientConfig = await ServiceManager.GetService(FaucetWebApi).onGetFaucetConfig();
    expect(!!clientConfig.modules['dynamic-outflow']).to.equal(false, "unexpected dynamic-outflow client config export");
  }).timeout(5000);

  it("Reschedule the refresh timer when refreshInterval changes on config reload", async () => {
    faucetConfig.modules["dynamic-outflow"] = moduleConfig({refreshInterval: 3600});
    await awaitTimeSlot();
    let module = await initModule();
    let oldTimer = (module as any).refreshTimer;
    expect(!!oldTimer).to.equal(true, "no refresh timer after start");
    module.setModuleConfig(moduleConfig({refreshInterval: 1}));
    let newTimer = (module as any).refreshTimer;
    expect(newTimer !== oldTimer).to.equal(true, "refresh timer not rescheduled on config reload");
    expect((newTimer as any)._idleTimeout).to.equal(1000, "rescheduled timer does not follow the new refreshInterval");
  }).timeout(5000);

  it("rolls back an invalid live reload", async () => {
    faucetConfig.modules["dynamic-outflow"] = moduleConfig({refreshInterval: 3600});
    await awaitTimeSlot();
    let module = await initModule();
    let previousTimer = (module as any).refreshTimer;
    let reloadError: unknown;
    try {
      await module.setModuleConfig(moduleConfig({cutoffWindow: 0}));
    } catch(ex) {
      reloadError = ex;
    }
    expect(String(reloadError)).to.include("cutoffWindow must be a positive safe integer number of seconds");
    expect(module.getModuleConfig().cutoffWindow).to.equal(1);
    expect((module as any).refreshTimer).not.to.equal(previousTimer);
    expect((module as any).refreshTimer?._idleTimeout).to.equal(3600000);
  }).timeout(5000);

});
