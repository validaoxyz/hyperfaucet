import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { bindTestStubs, unbindTestStubs, loadDefaultTestConfig } from '../common.js';
import { ServiceManager } from '../../src/common/ServiceManager.js';
import { FaucetDatabase } from '../../src/db/FaucetDatabase.js';
import { ModuleHookAction, ModuleManager } from '../../src/modules/ModuleManager.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { faucetConfig } from '../../src/config/FaucetConfig.js';
import { IFaucetOutflowConfig } from '../../src/modules/faucet-outflow/FaucetOutflowConfig.js';
import { FakeProvider } from '../stubs/FakeProvider.js';
import { EthWalletManager, FaucetCoinType } from '../../src/eth/EthWalletManager.js';
import { sleepPromise } from '../../src/utils/PromiseUtils.js';
import { FaucetOutflowModule } from '../../src/modules/faucet-outflow/FaucetOutflowModule.js';
import { IDynamicOutflowConfig } from '../../src/modules/dynamic-outflow/DynamicOutflowConfig.js';
import { DynamicOutflowModule } from '../../src/modules/dynamic-outflow/DynamicOutflowModule.js';
import { ClaimTxStatus, ConfirmedClaimData, EthClaimInfo } from '../../src/eth/EthClaim.js';
import { EthClaimManager } from '../../src/eth/EthClaimManager.js';
import { FaucetSession, FaucetSessionStatus } from '../../src/session/FaucetSession.js';
import { getNewGuid } from '../../src/utils/GuidUtils.js';


describe("Faucet module: faucet-outflow", () => {
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

  function setOutflowBalance(module: FaucetOutflowModule, balance: bigint): void {
    let state = (module as any).outflowState;
    state.balanceNumerator = balance;
    state.balanceDenominator = 1n;
    state.updateTime = Math.floor(Date.now() / 1000);
  }

  async function addConfirmedClaim(
    txByte: string,
    fee: string,
  ): Promise<EthClaimInfo & {claim: ConfirmedClaimData}> {
    let sessionId = getNewGuid();
    let claim: ConfirmedClaimData = {
      claimFormat: 2,
      claimIdx: Number.parseInt(txByte, 16),
      claimStatus: ClaimTxStatus.CONFIRMED,
      claimTime: Math.floor(Date.now() / 1000),
      txHash: "0x" + txByte.repeat(32),
      txHex: "0x" + txByte,
      txNonce: Number.parseInt(txByte, 16),
      txBlock: 42,
      txFee: fee,
    };
    let claimInfo: EthClaimInfo & {claim: ConfirmedClaimData} = {
      session: sessionId,
      target: "0x0000000000000000000000000000000000001337",
      amount: "100",
      claim,
    };
    await ServiceManager.GetService(FaucetDatabase).updateSession({
      sessionId,
      status: FaucetSessionStatus.CLAIMING,
      startTime: claim.claimTime,
      targetAddr: claimInfo.target,
      dropAmount: claimInfo.amount,
      remoteIP: "8.8.8.8",
      tasks: [],
      data: {},
      claim,
    });
    return claimInfo;
  }

  it("Start sessions with decreasing drop amount", async () => {
    faucetConfig.maxDropAmount = 100;
    faucetConfig.minDropAmount = 10;
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 1000,
      duration: 10,
      lowerLimit: -1000,
      upperLimit: 1000,
    } as IFaucetOutflowConfig;
    await awaitTimeSlot();
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    expect(await runTestSession()).to.equal(100n, "unexpected drop amount: session 1");
    expect(await runTestSession()).to.equal(90n, "unexpected drop amount: session 2");
    expect(await runTestSession()).to.equal(81n, "unexpected drop amount: session 3");
    await sleepPromise(1000);
    expect((await runTestSession()) <= 82n).to.equal(true, "unexpected drop amount: session 4");
  }).timeout(3000);

  it("Check outflow balance overflow", async () => {
    faucetConfig.maxDropAmount = 100;
    faucetConfig.minDropAmount = 10;
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 1000,
      duration: 10,
      lowerLimit: -1000,
      upperLimit: 1000,
    } as IFaucetOutflowConfig;
    await awaitTimeSlot();
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    setOutflowBalance(outflowModule, 2000n);
    expect(outflowModule.getOutflowDebugState().balance).to.equal("1000", "unexpected outflow balance after 0 sessions");
    for(let i = 0; i < 11; i++) {
      expect(await runTestSession()).to.equal(100n, "unexpected drop amount: session " + (i+1));
      expect(outflowModule.getOutflowDebugState().balance).to.equal((1000 - ((i+1) * 100)).toString(), "unexpected outflow balance after " + (i+1) + " sessions");
    }
    expect(await runTestSession()).to.equal(90n, "unexpected drop amount: session 12");
  }).timeout(3000);

  it("Check outflow balance underflow", async () => {
    faucetConfig.maxDropAmount = 100;
    faucetConfig.minDropAmount = 10;
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 1000,
      duration: 10,
      lowerLimit: -1000,
      upperLimit: 1000,
    } as IFaucetOutflowConfig;
    await awaitTimeSlot();
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    setOutflowBalance(outflowModule, -1000n);
    expect(outflowModule.getOutflowDebugState().balance).to.equal("-1000", "unexpected outflow balance after 0 sessions");
    expect(await runTestSession("failed")).to.equal(0n, "unexpected drop amount: session 1");
    await sleepPromise(1000);
    expect(await runTestSession()).to.equal(10n, "unexpected drop amount: session 2");
  }).timeout(3000);

  it("Save & restore outflow state", async () => {
    faucetConfig.maxDropAmount = 100;
    faucetConfig.minDropAmount = 10;
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 1000,
      duration: 10,
      lowerLimit: -1000,
      upperLimit: 1000,
    } as IFaucetOutflowConfig;
    await awaitTimeSlot();
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    setOutflowBalance(outflowModule, -500n);
    expect(outflowModule.getOutflowDebugState().balance).to.equal("-500", "unexpected outflow balance after 0 sessions");
    expect(await runTestSession()).to.equal(50n, "unexpected drop amount: session 1");
    await outflowModule.saveOutflowState();
    (outflowModule as any).outflowState = null;
    await outflowModule.loadOutflowState();
    expect(await runTestSession()).to.equal(45n, "unexpected drop amount: session 2");
  }).timeout(3000);

  it("persists the complete outflow state when modules stop", async () => {
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 10,
      duration: 3,
      lowerLimit: -1000,
      upperLimit: 1000,
    } as IFaucetOutflowConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    await outflowModule.updateState(null, 1n);
    let expectedState = outflowModule.getOutflowDebugState();

    await moduleManager.dispose();
    let storedState = JSON.parse(await ServiceManager.GetService(FaucetDatabase).getKeyValueEntry("PoWOutflowLimiter.state"));
    expect(storedState.version).to.equal(3, "shutdown persisted a legacy outflow state");
    expect(storedState.balanceNumerator).to.equal(expectedState.balanceNumerator, "shutdown lost the outflow debit");
    expect(storedState.balanceDenominator).to.equal(expectedState.balanceDenominator, "shutdown lost outflow precision");

    await moduleManager.initialize();
    let restoredState = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow").getOutflowDebugState();
    expect(restoredState.balanceNumerator).to.equal(expectedState.balanceNumerator, "restart discarded the persisted outflow balance");
    expect(restoredState.balanceDenominator).to.equal(expectedState.balanceDenominator, "restart discarded persisted outflow precision");
  });

  it("settles the old rate before installing a reloaded policy", async () => {
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 100,
      duration: 10,
      lowerLimit: -1000,
      upperLimit: 2000,
    } as IFaucetOutflowConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    let now = 1000;
    sinon.stub(outflowModule as any, "now").callsFake(() => now);
    (outflowModule as any).outflowState = {
      version: 3,
      balanceNumerator: -500n,
      balanceDenominator: 1n,
      updateTime: now,
      rateAmount: 100n,
      rateDuration: 10,
      accountedClaimFees: {},
    };

    now = 1010;
    await outflowModule.setModuleConfig({
      enabled: true,
      amount: 200,
      duration: 10,
      lowerLimit: -1000,
      upperLimit: 2000,
    });
    expect(outflowModule.getOutflowDebugState().balance).to.equal("-400", "reload reinterpreted the old balance under the new rate");

    now = 1015;
    expect(outflowModule.getOutflowDebugState().balance).to.equal("-300", "reload did not apply the new rate after the boundary");
  });

  it("preserves fractional balance across policy reloads", async () => {
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 1,
      duration: 3,
      lowerLimit: -1000,
      upperLimit: 1000,
    } as IFaucetOutflowConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    let now = 1000;
    sinon.stub(outflowModule as any, "now").callsFake(() => now);
    (outflowModule as any).outflowState = {
      version: 3,
      balanceNumerator: 1n,
      balanceDenominator: 3n,
      updateTime: now,
      rateAmount: 1n,
      rateDuration: 3,
      accountedClaimFees: {},
    };

    await outflowModule.setModuleConfig({
      enabled: true,
      amount: 2,
      duration: 5,
      lowerLimit: -1000,
      upperLimit: 1000,
    });
    let state = outflowModule.getOutflowDebugState();
    expect(state.balanceNumerator).to.equal("1");
    expect(state.balanceDenominator).to.equal("3");
  });

  it("migrates legacy state once into a versioned balance", async () => {
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 10,
      duration: 3,
      lowerLimit: -1000,
      upperLimit: 1000,
    } as IFaucetOutflowConfig;
    await ServiceManager.GetService(FaucetDatabase).setKeyValueEntry("PoWOutflowLimiter.state", JSON.stringify({
      trackTime: Math.floor(Date.now() / 1000),
      dustAmount: "7",
    }));

    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    expect(outflowModule.getOutflowDebugState().balance).to.equal("7");
    let storedState = JSON.parse(await ServiceManager.GetService(FaucetDatabase).getKeyValueEntry("PoWOutflowLimiter.state"));
    expect(storedState.version).to.equal(3);
    expect(storedState.balanceNumerator).to.equal("7");
  });

  it("migrates version-two rational state without changing its basis", async () => {
    sinon.stub(FaucetOutflowModule.prototype as any, "now").returns(1000);
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 2,
      duration: 5,
      lowerLimit: -1000,
      upperLimit: 1000,
    } as IFaucetOutflowConfig;
    await ServiceManager.GetService(FaucetDatabase).setKeyValueEntry("PoWOutflowLimiter.state", JSON.stringify({
      version: 2,
      balanceNumerator: "1",
      balanceDenominator: "3",
      updateTime: 1000,
      rateAmount: "1",
      rateDuration: 3,
    }));

    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let state = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow").getOutflowDebugState();
    expect(state.balanceNumerator).to.equal("1");
    expect(state.balanceDenominator).to.equal("3");
    let storedState = JSON.parse(await ServiceManager.GetService(FaucetDatabase).getKeyValueEntry("PoWOutflowLimiter.state"));
    expect(storedState.version).to.equal(3);
    expect(storedState.rateAmount).to.equal("2");
    expect(storedState.rateDuration).to.equal(5);
    expect(storedState.accountedClaimFees).to.deep.equal({});
  });

  it("rejects unknown persisted state versions instead of treating them as legacy", async () => {
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 2,
      duration: 5,
      lowerLimit: -1000,
      upperLimit: 1000,
    } as IFaucetOutflowConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");

    expect(() => (outflowModule as any).parsePersistedState(JSON.stringify({
      version: 4,
      trackTime: Math.floor(Date.now() / 1000),
      dustAmount: "7",
    }))).to.throw(/Unsupported persisted faucet outflow state version/);
  });

  it("accounts a native confirmed-claim fee exactly once across retries and restarts", async () => {
    let fixedNow = Math.floor(Date.now() / 1000);
    sinon.stub(FaucetOutflowModule.prototype as any, "now").returns(fixedNow);
    sinon.stub(EthWalletManager.prototype, "getClaimCoinType").returns(FaucetCoinType.NATIVE);
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 1,
      duration: 1000000,
      lowerLimit: -100000,
      upperLimit: 100000,
    } as IFaucetOutflowConfig;

    let database = ServiceManager.GetService(FaucetDatabase);
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    setOutflowBalance(outflowModule, 1000n);
    await outflowModule.saveOutflowState();
    let claimInfo = await addConfirmedClaim("ab", "25");
    let originalCas = database.compareAndSetKeyValueEntry.bind(database);
    let acknowledgementLost = false;
    sinon.stub(database, "compareAndSetKeyValueEntry").callsFake(async (key, expected, next) => {
      let changed = await originalCas(key, expected, next);
      if(!acknowledgementLost && changed) {
        acknowledgementLost = true;
        throw new Error("commit acknowledgement lost");
      }
      return changed;
    });

    await Promise.all([
      moduleManager.processActionHooks([], ModuleHookAction.SessionClaimed, [claimInfo]),
      moduleManager.processActionHooks([], ModuleHookAction.SessionClaimed, [claimInfo]),
    ]);
    expect(acknowledgementLost).to.equal(true);
    expect(outflowModule.getOutflowDebugState().balance).to.equal("975");
    let storedState = JSON.parse(await database.getKeyValueEntry("PoWOutflowLimiter.state"));
    expect(storedState.accountedClaimFees[claimInfo.claim.txHash]).to.equal(claimInfo.session);

    await moduleManager.dispose();
    await moduleManager.initialize();
    outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    await moduleManager.processActionHooks([], ModuleHookAction.SessionClaimed, [claimInfo]);
    expect(outflowModule.getOutflowDebugState().balance).to.equal("975", "restart replayed the native fee");

    expect(await database.finalizeConfirmedClaim(claimInfo.session, claimInfo.claim)).to.equal(true);
    await moduleManager.dispose();
    await moduleManager.initialize();
    outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    storedState = JSON.parse(await database.getKeyValueEntry("PoWOutflowLimiter.state"));
    expect(storedState.accountedClaimFees).to.deep.equal({}, "finalized fee marker was not pruned");
    await moduleManager.processActionHooks([], ModuleHookAction.SessionClaimed, [claimInfo]);
    expect(outflowModule.getOutflowDebugState().balance).to.equal("975", "late finalized replay charged the fee again");
  });

  it("adopts marker-free peer state after a claim-fee CAS loses acknowledgement", async () => {
    let fixedNow = Math.floor(Date.now() / 1000);
    sinon.stub(FaucetOutflowModule.prototype as any, "now").returns(fixedNow);
    sinon.stub(EthWalletManager.prototype, "getClaimCoinType").returns(FaucetCoinType.NATIVE);
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 1,
      duration: 1000000,
      lowerLimit: -500,
      upperLimit: 100000,
    } as IFaucetOutflowConfig;

    let database = ServiceManager.GetService(FaucetDatabase);
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    setOutflowBalance(outflowModule, 10n);
    await outflowModule.saveOutflowState();
    let claimInfo = await addConfirmedClaim("ad", "25");
    let originalCas = database.compareAndSetKeyValueEntry.bind(database);
    let casCalls = 0;
    sinon.stub(database, "compareAndSetKeyValueEntry").callsFake(async (key, expected, next) => {
      casCalls++;
      if(casCalls === 1) {
        let peerState = JSON.parse(expected);
        peerState.balanceNumerator = "-500";
        peerState.balanceDenominator = "1";
        peerState.accountedClaimFees = {};
        await database.setKeyValueEntry(key, JSON.stringify(peerState));
        throw new Error("claim-fee CAS acknowledgement lost after peer write");
      }
      return originalCas(key, expected, next);
    });

    let firstError = await moduleManager.processActionHooks(
      [],
      ModuleHookAction.SessionClaimed,
      [claimInfo],
    ).then(() => null, (error) => error);

    expect(String(firstError)).to.include("claim-fee CAS acknowledgement lost after peer write");
    expect(outflowModule.getOutflowDebugState().balance).to.equal("-500", "runtime did not adopt the peer balance");
    expect(outflowModule.getOutflowDebugState().restriction).to.equal(0);
    expect((outflowModule as any).uncertainClaimFee).to.equal(null);
    let durableState = JSON.parse(await database.getKeyValueEntry("PoWOutflowLimiter.state"));
    expect(durableState.balanceNumerator).to.equal("-500");
    expect(durableState.accountedClaimFees).to.deep.equal({});

    await outflowModule.saveOutflowState();
    durableState = JSON.parse(await database.getKeyValueEntry("PoWOutflowLimiter.state"));
    expect(durableState.balanceNumerator).to.equal("-500", "a later save overwrote the peer balance");
    expect(durableState.accountedClaimFees).to.deep.equal({});

    await moduleManager.processActionHooks([], ModuleHookAction.SessionClaimed, [claimInfo]);
    expect(outflowModule.getOutflowDebugState().balance).to.equal("-525", "retry did not charge the fee exactly once");
    durableState = JSON.parse(await database.getKeyValueEntry("PoWOutflowLimiter.state"));
    expect(durableState.balanceNumerator).to.equal("-525");
    expect(durableState.accountedClaimFees[claimInfo.claim.txHash]).to.equal(claimInfo.session);

    await moduleManager.processActionHooks([], ModuleHookAction.SessionClaimed, [claimInfo]);
    expect(casCalls).to.equal(2, "duplicate retry attempted another fee debit");
    expect(outflowModule.getOutflowDebugState().balance).to.equal("-525");
    durableState = JSON.parse(await database.getKeyValueEntry("PoWOutflowLimiter.state"));
    expect(durableState.balanceNumerator).to.equal("-525");
  });

  it("fails restriction closed until an unreadable committed claim-fee write is reconciled", async () => {
    let fixedNow = Math.floor(Date.now() / 1000);
    sinon.stub(FaucetOutflowModule.prototype as any, "now").returns(fixedNow);
    sinon.stub(EthWalletManager.prototype, "getClaimCoinType").returns(FaucetCoinType.NATIVE);
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 1,
      duration: 1000000,
      lowerLimit: -500,
      upperLimit: 100000,
    } as IFaucetOutflowConfig;

    let database = ServiceManager.GetService(FaucetDatabase);
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    setOutflowBalance(outflowModule, 10n);
    await outflowModule.saveOutflowState();
    let claimInfo = await addConfirmedClaim("ac", "1000");
    let originalCas = database.compareAndSetKeyValueEntry.bind(database);
    let originalGet = database.getKeyValueEntry.bind(database);
    let rejectReadback = false;
    let casCalls = 0;
    sinon.stub(database, "compareAndSetKeyValueEntry").callsFake(async (key, expected, next) => {
      casCalls++;
      let changed = await originalCas(key, expected, next);
      if(changed && casCalls === 1) {
        rejectReadback = true;
        throw new Error("claim-fee commit acknowledgement lost");
      }
      return changed;
    });
    sinon.stub(database, "getKeyValueEntry").callsFake(async (key) => {
      if(key === "PoWOutflowLimiter.state" && rejectReadback) {
        rejectReadback = false;
        throw new Error("claim-fee reconciliation read failed");
      }
      return originalGet(key);
    });
    let laterWrites = sinon.spy(database, "setKeyValueEntry");

    let firstError = await moduleManager.processActionHooks(
      [],
      ModuleHookAction.SessionClaimed,
      [claimInfo],
    ).then(() => null, (error) => error);

    expect(String(firstError)).to.include("claim-fee commit acknowledgement lost");
    expect(outflowModule.getOutflowDebugState().balance).to.equal("10");
    expect(outflowModule.getOutflowDebugState().restriction).to.equal(0);
    expect((outflowModule as any).uncertainClaimFee).to.deep.equal({
      txHash: claimInfo.claim.txHash,
      session: claimInfo.session,
    });
    let blockedSave = await outflowModule.saveOutflowState().then(() => null, (error) => error);
    expect(String(blockedSave)).to.include("uncertain claim-fee accounting");
    expect(laterWrites.called).to.equal(false, "an unresolved claim-fee outcome allowed a later overwrite");

    await moduleManager.processActionHooks([], ModuleHookAction.SessionClaimed, [claimInfo]);

    expect(casCalls).to.equal(1, "claim-fee retry attempted a second debit");
    expect((outflowModule as any).uncertainClaimFee).to.equal(null);
    expect(outflowModule.getOutflowDebugState().balance).to.equal("-990");
    expect(outflowModule.getOutflowDebugState().restriction).to.equal(0);
    let durableState = JSON.parse(await originalGet("PoWOutflowLimiter.state"));
    expect(durableState.balanceNumerator).to.equal("-990");
    expect(durableState.accountedClaimFees[claimInfo.claim.txHash]).to.equal(claimInfo.session);
    await outflowModule.saveOutflowState();
    expect(laterWrites.calledOnce).to.equal(true, "reconciled claim-fee state did not resume persistence");
  });

  it("keeps a finalized claim row until its native fee marker is durably retired", async () => {
    let fixedNow = Math.floor(Date.now() / 1000);
    sinon.stub(FaucetOutflowModule.prototype as any, "now").returns(fixedNow);
    sinon.stub(EthWalletManager.prototype, "getClaimCoinType").returns(FaucetCoinType.NATIVE);
    faucetConfig.sessionCleanup = 10;
    faucetConfig.ethMaxPending = 1;
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 1,
      duration: 1000000,
      lowerLimit: -100000,
      upperLimit: 100000,
    } as IFaucetOutflowConfig;

    let database = ServiceManager.GetService(FaucetDatabase);
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    setOutflowBalance(outflowModule, 1000n);
    await outflowModule.saveOutflowState();
    let claimInfo = await addConfirmedClaim("ef", "25");
    let oldSession = await database.getSession(claimInfo.session);
    oldSession.startTime = fixedNow - 60;
    expect(await database.updateSession(oldSession)).to.equal(true);

    await moduleManager.processActionHooks([], ModuleHookAction.SessionClaimed, [claimInfo]);
    expect(await database.finalizeConfirmedClaim(claimInfo.session, claimInfo.claim)).to.equal(true);
    await database.cleanStore();

    expect(await database.getSession(claimInfo.session)).to.not.equal(null, "cleanup removed the marker-owned finalization proof");
    let storedState = JSON.parse(await database.getKeyValueEntry("PoWOutflowLimiter.state"));
    expect(storedState.accountedClaimFees[claimInfo.claim.txHash]).to.equal(claimInfo.session);

    let skipGracefulSave = sinon.stub(outflowModule, "saveOutflowState").resolves();
    await moduleManager.dispose();
    skipGracefulSave.restore();
    await moduleManager.initialize();
    outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    await database.cleanStore();

    expect(await database.getSession(claimInfo.session)).to.equal(null);
    storedState = JSON.parse(await database.getKeyValueEntry("PoWOutflowLimiter.state"));
    expect(storedState.accountedClaimFees).to.deep.equal({});

    for(let txByte of ["e1", "e2"]) {
      claimInfo = await addConfirmedClaim(txByte, "25");
      oldSession = await database.getSession(claimInfo.session);
      oldSession.startTime = fixedNow - 60;
      expect(await database.updateSession(oldSession)).to.equal(true);
      await moduleManager.processActionHooks([], ModuleHookAction.SessionClaimed, [claimInfo]);
      expect(await database.finalizeConfirmedClaim(claimInfo.session, claimInfo.claim)).to.equal(true);
      await database.cleanStore();
      expect(await database.getSession(claimInfo.session)).to.not.equal(null, "cleanup removed a marker-owned row at the marker bound");
      await outflowModule.saveOutflowState();
      await database.cleanStore();
      expect(await database.getSession(claimInfo.session)).to.equal(null);
    }

    expect(outflowModule.getOutflowDebugState().balance).to.equal("925", "marker retirement replayed or skipped a native fee");
  });

  it("retains native fee-marker proof when faucet-outflow is omitted at cold start", async () => {
    faucetConfig.sessionCleanup = 10;
    delete faucetConfig.modules["faucet-outflow"];
    let database = ServiceManager.GetService(FaucetDatabase);
    let claimInfo = await addConfirmedClaim("df", "25");
    let oldSession = await database.getSession(claimInfo.session);
    oldSession.startTime -= 60;
    expect(await database.updateSession(oldSession)).to.equal(true);
    await database.setKeyValueEntry("PoWOutflowLimiter.state", JSON.stringify({
      version: 3,
      balanceNumerator: "0",
      balanceDenominator: "1",
      updateTime: claimInfo.claim.claimTime,
      rateAmount: "1",
      rateDuration: 1000000,
      accountedClaimFees: {
        [claimInfo.claim.txHash]: claimInfo.session,
      },
    }));
    expect(await database.finalizeConfirmedClaim(claimInfo.session, claimInfo.claim)).to.equal(true);

    await database.cleanStore();

    expect(await database.getSession(claimInfo.session)).to.not.equal(null, "disabled cold start removed fee-marker finalization proof");
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 1,
      duration: 1000000,
      lowerLimit: -100000,
      upperLimit: 100000,
    } as IFaucetOutflowConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    await database.cleanStore();

    expect(await database.getSession(claimInfo.session)).to.equal(null);
    let storedState = JSON.parse(await database.getKeyValueEntry("PoWOutflowLimiter.state"));
    expect(storedState.accountedClaimFees).to.deep.equal({});
  });

  it("returns cleanup-guard ownership to the default across disable and re-enable", async () => {
    faucetConfig.sessionCleanup = 10;
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 1,
      duration: 1000000,
      lowerLimit: -100000,
      upperLimit: 100000,
    } as IFaucetOutflowConfig;
    let database = ServiceManager.GetService(FaucetDatabase);
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let firstModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    let firstGuard = sinon.spy(firstModule as any, "canCleanupSession");

    await moduleManager.dispose();
    let firstClaim = await addConfirmedClaim("d4", "25");
    let firstSession = await database.getSession(firstClaim.session);
    firstSession.startTime -= 60;
    expect(await database.updateSession(firstSession)).to.equal(true);
    expect(await database.finalizeConfirmedClaim(firstClaim.session, firstClaim.claim)).to.equal(true);
    await database.cleanStore();

    expect(firstGuard.notCalled).to.equal(true, "cleanup called a stopped module guard");
    expect(await database.getSession(firstClaim.session)).to.equal(null);
    await moduleManager.initialize();
    let replacementModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    expect(replacementModule).to.not.equal(firstModule);
    let replacementGuard = sinon.spy(replacementModule as any, "canCleanupSession");
    let secondClaim = await addConfirmedClaim("d5", "25");
    let secondSession = await database.getSession(secondClaim.session);
    secondSession.startTime -= 60;
    expect(await database.updateSession(secondSession)).to.equal(true);
    expect(await database.finalizeConfirmedClaim(secondClaim.session, secondClaim.claim)).to.equal(true);
    await database.cleanStore();

    expect(replacementGuard.calledOnce).to.equal(true, "replacement module did not own cleanup serialization");
    expect(await database.getSession(secondClaim.session)).to.equal(null);
  });

  it("keeps native gas fees out of the ERC20 faucet-asset ledger", async () => {
    let fixedNow = Math.floor(Date.now() / 1000);
    sinon.stub(FaucetOutflowModule.prototype as any, "now").returns(fixedNow);
    sinon.stub(EthWalletManager.prototype, "getClaimCoinType").returns(FaucetCoinType.ERC20);
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 1,
      duration: 1000000,
      lowerLimit: -100000,
      upperLimit: 100000,
    } as IFaucetOutflowConfig;

    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    setOutflowBalance(outflowModule, 1000n);
    await outflowModule.saveOutflowState();
    let claimInfo = await addConfirmedClaim("cd", "25");

    await moduleManager.processActionHooks([], ModuleHookAction.SessionClaimed, [claimInfo]);

    expect(outflowModule.getOutflowDebugState().balance).to.equal("1000");
    let storedState = JSON.parse(await ServiceManager.GetService(FaucetDatabase).getKeyValueEntry("PoWOutflowLimiter.state"));
    expect(storedState.accountedClaimFees).to.deep.equal({});
  });

  it("rolls back an outflow debit when its durable save fails", async () => {
    let fixedNow = Math.floor(Date.now() / 1000);
    sinon.stub(FaucetOutflowModule.prototype as any, "now").returns(fixedNow);
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 1,
      duration: 1000000,
      lowerLimit: -100000,
      upperLimit: 100000,
    } as IFaucetOutflowConfig;

    let database = ServiceManager.GetService(FaucetDatabase);
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    setOutflowBalance(outflowModule, 1000n);
    await outflowModule.saveOutflowState();

    let originalSave = database.setKeyValueEntry.bind(database);
    let saveCount = 0;
    sinon.stub(database, "setKeyValueEntry").callsFake(async (key, value) => {
      saveCount++;
      if(saveCount === 1)
        throw new Error("injected save failure");
      await originalSave(key, value);
    });

    let failed = false;
    try {
      await outflowModule.updateState(null, 100n);
    } catch {
      failed = true;
    }
    expect(failed).to.equal(true);
    expect(outflowModule.getOutflowDebugState().balance).to.equal("1000", "failed save left a ghost debit in memory");

    await outflowModule.saveOutflowState();
    let storedState = JSON.parse(await database.getKeyValueEntry("PoWOutflowLimiter.state"));
    expect(storedState.balanceNumerator).to.equal("1000", "later save persisted the failed debit");

    await outflowModule.updateState(null, 100n);
    expect(outflowModule.getOutflowDebugState().balance).to.equal("900", "retry did not debit exactly once");
  });

  it("adopts a committed outflow debit when its write acknowledgement is lost", async () => {
    let fixedNow = Math.floor(Date.now() / 1000);
    sinon.stub(FaucetOutflowModule.prototype as any, "now").returns(fixedNow);
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 1,
      duration: 1000000,
      lowerLimit: -100000,
      upperLimit: 100000,
    } as IFaucetOutflowConfig;

    let database = ServiceManager.GetService(FaucetDatabase);
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    setOutflowBalance(outflowModule, 1000n);
    await outflowModule.saveOutflowState();

    let originalSave = database.setKeyValueEntry.bind(database);
    let acknowledgementLost = false;
    sinon.stub(database, "setKeyValueEntry").callsFake(async (key, value) => {
      await originalSave(key, value);
      if(key === "PoWOutflowLimiter.state" && !acknowledgementLost) {
        acknowledgementLost = true;
        throw new Error("faucet outflow acknowledgement lost");
      }
    });

    let updateError: unknown;
    try {
      await outflowModule.updateState(null, 100n);
    } catch(ex) {
      updateError = ex;
    }

    expect(updateError).to.equal(undefined);
    expect(acknowledgementLost).to.equal(true);
    expect(outflowModule.getOutflowDebugState().balance).to.equal("900");
    let storedState = JSON.parse(await database.getKeyValueEntry("PoWOutflowLimiter.state"));
    expect(storedState.balanceNumerator).to.equal("900");

    await outflowModule.saveOutflowState();
    storedState = JSON.parse(await database.getKeyValueEntry("PoWOutflowLimiter.state"));
    expect(storedState.balanceNumerator).to.equal("900", "a later save overwrote the adopted debit");
  });

  it("blocks writes and reloads while an unreadable or divergent debit outcome is uncertain", async () => {
    let fixedNow = Math.floor(Date.now() / 1000);
    sinon.stub(FaucetOutflowModule.prototype as any, "now").returns(fixedNow);
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 1,
      duration: 1000000,
      lowerLimit: -100000,
      upperLimit: 100000,
    } as IFaucetOutflowConfig;

    let database = ServiceManager.GetService(FaucetDatabase);
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    setOutflowBalance(outflowModule, 1000n);
    await outflowModule.saveOutflowState();

    let previousJson = await database.getKeyValueEntry("PoWOutflowLimiter.state");
    let durableJson = previousJson;
    let writeCalls = 0;
    let reconciliationReads = 0;
    let originalGet = database.getKeyValueEntry.bind(database);
    sinon.stub(database, "getKeyValueEntry").callsFake(async (key) => {
      if(key !== "PoWOutflowLimiter.state")
        return originalGet(key);
      reconciliationReads++;
      if(reconciliationReads === 1)
        throw new Error("faucet outflow reconciliation read failed");
      return durableJson;
    });
    let originalSave = database.setKeyValueEntry.bind(database);
    sinon.stub(database, "setKeyValueEntry").callsFake(async (key, value) => {
      if(key !== "PoWOutflowLimiter.state")
        return originalSave(key, value);
      writeCalls++;
      if(writeCalls === 1)
        throw new Error("faucet outflow write result unknown");
      durableJson = value;
    });

    let updateError: unknown;
    try {
      await outflowModule.updateState(null, 100n);
    } catch(ex) {
      updateError = ex;
    }
    expect(String(updateError)).to.include("faucet outflow write result unknown");
    expect(reconciliationReads).to.equal(1);
    expect(writeCalls).to.equal(1);
    expect(outflowModule.getOutflowDebugState().restriction).to.equal(0);

    let divergentState = JSON.parse(previousJson);
    divergentState.balanceNumerator = "777";
    durableJson = JSON.stringify(divergentState);
    let divergentSaveError: unknown;
    try {
      await outflowModule.saveOutflowState();
    } catch(ex) {
      divergentSaveError = ex;
    }
    expect(String(divergentSaveError)).to.include("uncertain");
    expect(writeCalls).to.equal(1, "a divergent reconciliation allowed a later overwrite");
    expect(durableJson).to.equal(JSON.stringify(divergentState));

    let divergentLoadError: unknown;
    try {
      await outflowModule.loadOutflowState();
    } catch(ex) {
      divergentLoadError = ex;
    }
    expect(String(divergentLoadError)).to.include("uncertain");
    expect(writeCalls).to.equal(1);

    durableJson = previousJson;
    await outflowModule.loadOutflowState();
    expect(outflowModule.getOutflowDebugState().balance).to.equal("1000");
    await outflowModule.saveOutflowState();
    expect(writeCalls).to.equal(2, "the reconciled state did not resume persistence");
  });

  it("matches a durable peer outflow debit with the failed session reward when one real hook cannot persist", async () => {
    faucetConfig.maxDropAmount = 100;
    faucetConfig.minDropAmount = 1;
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 1,
      duration: 1000000,
      lowerLimit: -100000,
      upperLimit: 100000,
    } as IFaucetOutflowConfig;
    faucetConfig.modules["dynamic-outflow"] = {
      enabled: true,
      targetDrainTime: 10,
      refreshInterval: 3600,
      burstWindow: 2,
      cutoffWindow: 1,
    } as IDynamicOutflowConfig;

    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    await ServiceManager.GetService(SessionManager).initialize();
    await ServiceManager.GetService(EthClaimManager).initialize();
    await moduleManager.activateModulesAfterStateRestore();

    let faucetOutflow = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    setOutflowBalance(faucetOutflow, 1000n);
    await faucetOutflow.saveOutflowState();
    let dynamicOutflow = moduleManager.getModule<DynamicOutflowModule>("dynamic-outflow");
    let fixedNow = Math.floor(Date.now() / 1000);
    sinon.stub(dynamicOutflow as any, "now").returns(fixedNow);
    (dynamicOutflow as any).outflowState = {budget: 0n, updateTime: fixedNow};
    await (dynamicOutflow as any).saveOutflowState();

    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    let database = ServiceManager.GetService(FaucetDatabase);
    let originalSave = database.setKeyValueEntry.bind(database);
    let rejectedFaucetSave = false;
    sinon.stub(database, "setKeyValueEntry").callsFake(async (key, value) => {
      if(key === "PoWOutflowLimiter.state" && !rejectedFaucetSave) {
        rejectedFaucetSave = true;
        throw new Error("injected faucet-outflow save failure");
      }
      await originalSave(key, value);
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let rewardError: unknown;
    try {
      await session.addReward(59n);
    } catch(ex) {
      rewardError = ex;
    }

    expect(String(rewardError)).to.include("injected faucet-outflow save failure");
    expect(rejectedFaucetSave).to.equal(true);
    expect(faucetOutflow.getOutflowDebugState().balance).to.equal("1000", "failed hook kept its rolled-back debit");
    let dynamicState = JSON.parse(await database.getKeyValueEntry("DynamicOutflow.state"));
    let storedSession = await database.getSession(session.getSessionId());
    expect(dynamicState.budget).to.equal("-59", "successful peer hook did not persist its debit");
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.dropAmount).to.equal("59");
    expect(-BigInt(dynamicState.budget)).to.equal(BigInt(storedSession.dropAmount));
    expect(storedSession.data["failed.code"]).to.equal("REWARD_ACCOUNTING");
  });

  it("accepts exact decimal strings and rejects unsafe numeric policy values", async () => {
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: "100000000000000000001",
      duration: 10,
      lowerLimit: "-200000000000000000002",
      upperLimit: "100000000000000000001",
    } as IFaucetOutflowConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let exactState = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow").getOutflowDebugState();
    expect(exactState.amount).to.equal("100000000000000000001");
    expect(exactState.lowerLimit).to.equal("-200000000000000000002");

    let reloadError: Error = null;
    try {
      await moduleManager.getModule<FaucetOutflowModule>("faucet-outflow").setModuleConfig({
        enabled: true,
        amount: Number.MAX_SAFE_INTEGER + 1,
        duration: 10,
        lowerLimit: -100,
        upperLimit: 100,
      });
    } catch(ex) {
      reloadError = ex;
    }
    expect(reloadError?.message).to.match(/safe integer or decimal string/);
    expect(moduleManager.getModule<FaucetOutflowModule>("faucet-outflow").getOutflowDebugState().amount).to.equal("100000000000000000001");
  });

});
