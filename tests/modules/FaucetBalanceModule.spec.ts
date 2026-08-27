import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { bindTestStubs, unbindTestStubs, loadDefaultTestConfig, awaitSleepPromise } from '../common.js';
import { ServiceManager } from '../../src/common/ServiceManager.js';
import { FaucetDatabase } from '../../src/db/FaucetDatabase.js';
import { ModuleManager } from '../../src/modules/ModuleManager.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { faucetConfig } from '../../src/config/FaucetConfig.js';
import { FakeProvider } from '../stubs/FakeProvider.js';
import { EthWalletManager } from '../../src/eth/EthWalletManager.js';
import { IFaucetBalanceConfig } from '../../src/modules/faucet-balance/FaucetBalanceConfig.js';
import { FaucetBalanceModule } from '../../src/modules/faucet-balance/FaucetBalanceModule.js';


describe("Faucet module: faucet-balance", () => {
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

  it("Start session with static restriction (100%)", async () => {
    faucetConfig.maxDropAmount = 1000;
    faucetConfig.minDropAmount = 10;
    faucetConfig.modules["faucet-balance"] = {
      enabled: true,
      fixedRestriction: {
        99999: 90,
        90000: 50,
      },
    } as IFaucetBalanceConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(testSession.getDropAmount()).to.equal(1000n, "unexpected drop amount");
    expect(moduleManager.getModule<FaucetBalanceModule>("faucet-balance").getBalanceRestriction()).to.equal(100, "unexpected balance restriction");
  });

  it("Start session with static restriction (50%)", async () => {
    faucetConfig.maxDropAmount = 1000;
    faucetConfig.minDropAmount = 10;
    faucetConfig.modules["faucet-balance"] = {
      enabled: true,
      fixedRestriction: {
        200000: 90,
        110000: 50,
         90000: 30,
      },
    } as IFaucetBalanceConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(testSession.getDropAmount()).to.equal(500n, "unexpected drop amount");
    expect(moduleManager.getModule<FaucetBalanceModule>("faucet-balance").getBalanceRestriction()).to.equal(50, "unexpected balance restriction");
  });

  it("applies fixed restrictions at exact large base-unit thresholds", async () => {
    faucetConfig.modules["faucet-balance"] = {
      enabled: true,
      fixedRestriction: {
        "9007199254740993": 50,
        "1000000000000000000000": 90,
      },
    } as IFaucetBalanceConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let module = moduleManager.getModule<FaucetBalanceModule>("faucet-balance") as any;

    expect(module.getStaticBalanceRestriction(9007199254740992n)).to.equal(50);
    expect(module.getStaticBalanceRestriction(500000000000000000000n)).to.equal(90);
    expect(module.getStaticBalanceRestriction(1000000000000000000001n)).to.equal(100);
  });

  it("rejects invalid restrictions and preserves compiled state after failed reloads", async () => {
    faucetConfig.modules["faucet-balance"] = {
      enabled: true,
      fixedRestriction: {
        "1000000000000000000000": 25,
      },
      dynamicRestriction: {
        targetBalance: "1000000000000000000000",
      },
    } as IFaucetBalanceConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let module = moduleManager.getModule<FaucetBalanceModule>("faucet-balance");
    let invalidConfigs: Array<{config: IFaucetBalanceConfig, error: RegExp}> = [
      {
        config: {enabled: true, fixedRestriction: {"1e+21": 50}},
        error: /canonical non-negative decimal strings/,
      },
      {
        config: {enabled: true, fixedRestriction: {"1000": 101}},
        error: /finite numbers from 0 to 100/,
      },
      {
        config: {enabled: true, dynamicRestriction: {targetBalance: Number.MAX_SAFE_INTEGER + 1}},
        error: /non-negative safe integer or canonical decimal string/,
      },
    ];

    for(let invalid of invalidConfigs) {
      let reloadError: Error = null;
      try {
        await module.setModuleConfig(invalid.config);
      } catch(ex) {
        reloadError = ex as Error;
      }
      expect(reloadError?.message).to.match(invalid.error);
    }

    expect((module as any).getStaticBalanceRestriction(500000000000000000000n)).to.equal(25);
    expect((module as any).getDynamicBalanceRestriction(500000000000000000000n)).to.equal(50);
    expect(module.requiresCleanup()).to.equal(false);
  });

  it("Start session with dynamic restriction (100%)", async () => {
    faucetConfig.maxDropAmount = 1000;
    faucetConfig.minDropAmount = 10;
    faucetConfig.modules["faucet-balance"] = {
      enabled: true,
      dynamicRestriction: {
        targetBalance: 100000
      },
    } as IFaucetBalanceConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(testSession.getDropAmount()).to.equal(1000n, "unexpected drop amount");
    expect(moduleManager.getModule<FaucetBalanceModule>("faucet-balance").getBalanceRestriction()).to.equal(100, "unexpected balance restriction");
  });

  it("Start session with dynamic restriction (50%)", async () => {
    faucetConfig.maxDropAmount = 1000;
    faucetConfig.minDropAmount = 10;
    faucetConfig.modules["faucet-balance"] = {
      enabled: true,
      dynamicRestriction: {
        targetBalance: 200000
      },
    } as IFaucetBalanceConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(testSession.getDropAmount()).to.equal(500n, "unexpected drop amount");
    expect(moduleManager.getModule<FaucetBalanceModule>("faucet-balance").getBalanceRestriction()).to.equal(50, "unexpected balance restriction");
  });

  it("Start session with dynamic restriction (0%)", async () => {
    faucetConfig.maxDropAmount = 1000;
    faucetConfig.minDropAmount = 10;
    faucetConfig.spareFundsAmount = 100000;
    faucetConfig.modules["faucet-balance"] = {
      enabled: true,
      dynamicRestriction: {
        targetBalance: 200000
      },
    } as IFaucetBalanceConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("failed", "unexpected session status");
    expect(testSession.getDropAmount()).to.equal(0n, "unexpected drop amount");
    expect(moduleManager.getModule<FaucetBalanceModule>("faucet-balance").getBalanceRestriction()).to.equal(0, "unexpected balance restriction");
  });


});
