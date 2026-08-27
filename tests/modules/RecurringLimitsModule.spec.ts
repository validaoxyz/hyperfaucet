import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { bindTestStubs, unbindTestStubs, loadDefaultTestConfig, awaitSleepPromise } from '../common.js';
import { ServiceManager } from '../../src/common/ServiceManager.js';
import { FaucetDatabase } from '../../src/db/FaucetDatabase.js';
import { ModuleManager } from '../../src/modules/ModuleManager.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { faucetConfig } from '../../src/config/FaucetConfig.js';
import { IRecurringLimitsConfig } from '../../src/modules/recurring-limits/RecurringLimitsConfig.js';
import { FaucetError } from '../../src/common/FaucetError.js';
import { FaucetSessionStatus } from '../../src/session/FaucetSession.js';


describe("Faucet module: recurring-limits", () => {
  let globalStubs;

  beforeEach(async () => {
    globalStubs = bindTestStubs();
    loadDefaultTestConfig();
    await ServiceManager.GetService(FaucetDatabase).initialize();
  });
  afterEach(async () => {
    let dbService = ServiceManager.GetService(FaucetDatabase);
    await ServiceManager.DisposeAllServices();
    await dbService.closeDatabase();
    await unbindTestStubs(globalStubs);
  });

  async function runTestSession(expectedStatus?: string): Promise<bigint> {
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal(expectedStatus || "claimable", "unexpected session status");
    return testSession.getDropAmount();
  }

  it("Exceed limit by ip (session count)", async () => {
    faucetConfig.maxDropAmount = 100;
    faucetConfig.minDropAmount = 10;
    faucetConfig.modules["recurring-limits"] = {
      enabled: true,
      limits: [
        {
          duration: 30,
          limitCount: 2,
          byIPOnly: true,
        }
      ]
    } as IRecurringLimitsConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    expect(await runTestSession()).to.equal(100n, "unexpected drop amount: session 1");
    expect(await runTestSession()).to.equal(100n, "unexpected drop amount: session 2");
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("RECURRING_LIMIT", "unexpected error code");
  });

  it("Exceed limit by addr (session amount)", async () => {
    faucetConfig.maxDropAmount = 100;
    faucetConfig.minDropAmount = 10;
    faucetConfig.modules["recurring-limits"] = {
      enabled: true,
      limits: [
        {
          duration: 30,
          limitAmount: 200,
          byAddrOnly: true,
        }
      ]
    } as IRecurringLimitsConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    expect(await runTestSession()).to.equal(100n, "unexpected drop amount: session 1");
    expect(await runTestSession()).to.equal(100n, "unexpected drop amount: session 2");
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("8.8.4.4", {
        addr: "0x0000000000000000000000000000000000001337",
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("RECURRING_LIMIT", "unexpected error code");
  });

  it("Exceed limit by ip & addr (session count)", async () => {
    faucetConfig.maxDropAmount = 100;
    faucetConfig.minDropAmount = 10;
    faucetConfig.modules["recurring-limits"] = {
      enabled: true,
      limits: [
        {
          duration: 30,
          limitCount: 2,
        }
      ]
    } as IRecurringLimitsConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    expect(await runTestSession()).to.equal(100n, "unexpected drop amount: session 1");
    expect(await runTestSession()).to.equal(100n, "unexpected drop amount: session 2");
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("RECURRING_LIMIT", "unexpected error code");
  });

  it("Exceed limit by ip subnet (session count)", async () => {
    faucetConfig.maxDropAmount = 100;
    faucetConfig.minDropAmount = 10;
    faucetConfig.modules["recurring-limits"] = {
      enabled: true,
      limits: [
        {
          duration: 30,
          ip4Subnet: 24,
          limitCount: 2,
        }
      ]
    } as IRecurringLimitsConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    expect(await runTestSession()).to.equal(100n, "unexpected drop amount: session 1");
    expect(await runTestSession()).to.equal(100n, "unexpected drop amount: session 2");
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("8.8.8.4", {
        addr: "0x0000000000000000000000000000000000001337",
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("RECURRING_LIMIT", "unexpected error code");
  });

  it("Check reward reduction when exceeding limit", async () => {
    faucetConfig.maxDropAmount = 100;
    faucetConfig.minDropAmount = 10;
    faucetConfig.modules["recurring-limits"] = {
      enabled: true,
      limits: [
        {
          duration: 30,
          limitCount: 2,
          action: "none",
          rewards: 10,
        }
      ]
    } as IRecurringLimitsConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    expect(await runTestSession()).to.equal(100n, "unexpected drop amount: session 1");
    expect(await runTestSession()).to.equal(100n, "unexpected drop amount: session 2");
    expect(await runTestSession()).to.equal(10n, "unexpected drop amount: session 3");
  });

  it("reserves the first pending claim while historical lookups are in flight", async () => {
    faucetConfig.maxDropAmount = 100;
    faucetConfig.minDropAmount = 10;
    faucetConfig.modules["recurring-limits"] = {
      enabled: true,
      limits: [{
        duration: 30,
        limitAmount: 100,
        byIPOnly: true,
      }],
    } as IRecurringLimitsConfig;
    await ServiceManager.GetService(ModuleManager).initialize();

    let results = await Promise.allSettled([
      runTestSession(),
      runTestSession(),
    ]);
    let fulfilled = results.filter((result) => result.status === "fulfilled") as PromiseFulfilledResult<bigint>[];
    let rejected = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];

    expect(fulfilled.length).to.equal(1);
    expect(fulfilled[0].value).to.equal(100n);
    expect(rejected.length).to.equal(1);
    expect(rejected[0].reason).to.be.instanceOf(FaucetError);
    expect(rejected[0].reason.getCode()).to.equal("RECURRING_LIMIT");
  });

  it("restores subnet reservations before admitting new traffic", async () => {
    faucetConfig.modules["recurring-limits"] = {
      enabled: true,
      limits: [{
        duration: 30,
        ip4Subnet: 24,
        limitCount: 1,
        byIPOnly: true,
      }],
    } as IRecurringLimitsConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    let now = Math.floor(Date.now() / 1000);
    await ServiceManager.GetService(FaucetDatabase).updateSession({
      sessionId: "4e63566e-e482-46f3-bb91-da11f511c005",
      status: FaucetSessionStatus.RUNNING,
      startTime: now,
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "100",
      remoteIP: "8.8.8.8",
      tasks: [{module: "test", name: "test", timeout: 0}],
      data: {},
      claim: null,
    });

    let sessionManager = ServiceManager.GetService(SessionManager);
    await sessionManager.initialize();
    let error: FaucetError | null = null;
    try {
      await sessionManager.createSession("8.8.8.4", {
        addr: "0x0000000000000000000000000000000000001338",
      });
    } catch(ex) {
      error = ex;
    }
    expect(error?.getCode()).to.equal("RECURRING_LIMIT");
  });


});
