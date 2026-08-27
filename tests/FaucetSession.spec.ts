import 'mocha';
import sinon from 'sinon';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { expect } from 'chai';
import { bindTestStubs, unbindTestStubs, loadDefaultTestConfig, awaitSleepPromise } from './common.js';
import { ServiceManager } from '../src/common/ServiceManager.js';
import { FaucetDatabase, FaucetDbDriver } from '../src/db/FaucetDatabase.js';
import { ModuleHookAction, ModuleManager } from '../src/modules/ModuleManager.js';
import { SessionManager } from '../src/session/SessionManager.js';
import { faucetConfig } from '../src/config/FaucetConfig.js';
import { FaucetError } from '../src/common/FaucetError.js';
import { FaucetSession, FaucetSessionStatus } from '../src/session/FaucetSession.js';
import { FaucetStatsLog } from '../src/services/FaucetStatsLog.js';
import { FaucetProcess } from '../src/common/FaucetProcess.js';

function spyOnRewardContextDisable(session: FaucetSession): {
  factor: sinon.SinonSpy;
  accounting: sinon.SinonSpy;
} {
  return {
    factor: sinon.spy((session as any).rewardFactorContext, "disable"),
    accounting: sinon.spy((session as any).rewardAccountingContext, "disable"),
  };
}

function expectRewardContextsDisabled(
  spies: {factor: sinon.SinonSpy, accounting: sinon.SinonSpy},
  count: number,
): void {
  expect(spies.factor.callCount).to.equal(count, "unexpected reward-factor context disable count");
  expect(spies.accounting.callCount).to.equal(count, "unexpected reward-accounting context disable count");
}


describe("Faucet Session Management", () => {
  let globalStubs;
  let testDirectory: string | undefined;

  beforeEach(async () => {
    globalStubs = bindTestStubs();
    loadDefaultTestConfig();
    testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "powfaucet-session-test-"));
    faucetConfig.database = {
      driver: FaucetDbDriver.SQLITE,
      file: path.join(testDirectory, "faucet.sqlite"),
    };
    await ServiceManager.GetService(FaucetDatabase).initialize();
    await ServiceManager.GetService(ModuleManager).initialize();
  });
  afterEach(async () => {
    let dbService = ServiceManager.GetService(FaucetDatabase);
    let cleanupErrors: unknown[] = [];
    for(const cleanup of [
      () => ServiceManager.DisposeAllServices(),
      () => dbService.dropAllTables(),
      () => dbService.closeDatabase(),
      () => unbindTestStubs(globalStubs),
    ]) {
      try {
        await cleanup();
      } catch(error) {
        cleanupErrors.push(error);
      }
    }
    if(testDirectory) {
      try {
        fs.rmSync(testDirectory, {recursive: true, force: true});
      } catch(error) {
        cleanupErrors.push(error);
      }
      testDirectory = undefined;
    }
    if(cleanupErrors.length === 1)
      throw cleanupErrors[0];
    if(cleanupErrors.length > 1)
      throw new AggregateError(cleanupErrors, "Faucet session test cleanup failed");
  });

  it("Create normal session", async () => {
    let sessionManager = ServiceManager.GetService(SessionManager);
    let now = Math.floor(new Date().getTime() / 1000);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    expect(testSession).to.not.equal(null, "createSession failed");
    expect(testSession.getRemoteIP()).to.equal("8.8.8.8", "unexpected remoteIP");
    expect(testSession.getTargetAddr()).to.equal("0x0000000000000000000000000000000000001337", "unexpected targetAddr");
    expect(Math.abs(testSession.getStartTime() - now)).to.be.lessThan(2, "unexpected startTime");
    expect(testSession.getBlockingTasks().length).to.equal(0, "unexpected blockingTasks");
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(testSession.getDropAmount()).to.equal(BigInt(faucetConfig.maxDropAmount), "unexpected drop amount");
  });

  it("disables both reward contexts once after successful completion", async () => {
    faucetConfig.minDropAmount = 1;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let disableSpies = spyOnRewardContextDisable(session);

    expect(await session.addReward(10n)).to.equal(10n);
    expectRewardContextsDisabled(disableSpies, 0);
    await session.completeSession();

    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.CLAIMABLE);
    expectRewardContextsDisabled(disableSpies, 1);
    await Promise.all([
      session.completeSession(),
      session.setSessionFailed("LATE_FAILURE", "late failure"),
    ]);
    expectRewardContextsDisabled(disableSpies, 1);
  });

  it("disables both reward contexts once after ordinary failure", async () => {
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let disableSpies = spyOnRewardContextDisable(session);

    let firstFailure = session.setSessionFailed("FIRST_FAILURE", "first failure");
    let repeatedFailure = session.setSessionFailed("REPEATED_FAILURE", "repeated failure");
    expect(repeatedFailure).to.equal(firstFailure);
    expectRewardContextsDisabled(disableSpies, 0);
    await Promise.all([firstFailure, repeatedFailure]);

    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
    expect(session.getSessionData("failed.code")).to.equal("FIRST_FAILURE");
    expectRewardContextsDisabled(disableSpies, 1);
    await Promise.all([
      session.setSessionFailed("LATE_FAILURE", "late failure"),
      session.completeSession(),
    ]);
    expectRewardContextsDisabled(disableSpies, 1);
  });

  it("drains every registered start rollback after an absent start failure", async () => {
    let moduleManager = ServiceManager.GetService(ModuleManager);
    let failedSession: FaucetSession;
    let rollbackOrder: string[] = [];
    let rollbackObservedSettledOwnership = false;
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 10, "acquire external ownership", (session: FaucetSession) => {
      failedSession = session;
      session.registerStartRollback("first", async () => {
        rollbackOrder.push("first");
        rollbackObservedSettledOwnership = session.getSessionStatus() === FaucetSessionStatus.FAILED
          && await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId()) === null;
      });
      session.registerStartRollback("second", () => {
        rollbackOrder.push("second");
        throw new Error("second rollback failed");
      });
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 20, "reject start", () => {
      throw new Error("later start hook failed");
    });

    let startError: unknown;
    try {
      await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
    } catch(ex) {
      startError = ex;
    }

    expect(startError).to.be.instanceOf(AggregateError);
    expect(String(startError)).to.include("later start hook failed");
    expect(String(startError)).to.include("second rollback failed");
    expect(rollbackOrder).to.deep.equal(["second", "first"]);
    expect(rollbackObservedSettledOwnership).to.equal(true);
    expect(failedSession.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
  });

  it("rolls back start ownership after activation persistence fails before commit", async () => {
    let moduleManager = ServiceManager.GetService(ModuleManager);
    let failedSession: FaucetSession;
    let rollbackCalls = 0;
    let rollbackObservedSettledOwnership = false;
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 10, "acquire external ownership", (session: FaucetSession) => {
      failedSession = session;
      session.registerStartRollback("external reservation", async () => {
        rollbackCalls++;
        rollbackObservedSettledOwnership = session.getSessionStatus() === FaucetSessionStatus.FAILED
          && await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId()) === null;
      });
      session.addBlockingTask("test", "hold", 60);
    });
    sinon.stub(FaucetDatabase.prototype, "insertRunningSession").rejects(new Error("insert failed before commit"));

    let startError: unknown;
    try {
      await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
    } catch(ex) {
      startError = ex;
    }

    expect(String(startError)).to.include("insert failed before commit");
    expect(rollbackCalls).to.equal(1);
    expect(rollbackObservedSettledOwnership).to.equal(true);
    expect(failedSession.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
  });

  it("defers start rollback until an uncertain activation insert is reconciled", async () => {
    let moduleManager = ServiceManager.GetService(ModuleManager);
    let failedSession: FaucetSession;
    let rollbackCalls = 0;
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 10, "acquire external ownership", (session: FaucetSession) => {
      failedSession = session;
      session.registerStartRollback("external reservation", () => {
        rollbackCalls++;
      });
      session.addBlockingTask("test", "hold", 60);
    });
    let database = ServiceManager.GetService(FaucetDatabase);
    let insertStub = sinon.stub(database, "insertRunningSession").rejects(new Error("insert result unknown"));
    let originalGetSession = database.getSession.bind(database);
    let failedReconciliationReads = 0;
    let getSessionStub = sinon.stub(database, "getSession").callsFake(async (sessionId) => {
      if(failedSession && sessionId === failedSession.getSessionId() && failedReconciliationReads++ < 2)
        throw new Error("session read unavailable");
      return originalGetSession(sessionId);
    });

    let startError: unknown;
    let sessionManager = ServiceManager.GetService(SessionManager);
    try {
      await sessionManager.createSession("8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
    } catch(ex) {
      startError = ex;
    }

    expect(startError).to.not.equal(undefined);
    expect(rollbackCalls).to.equal(0, "rollback ran while insert ownership was uncertain");
    insertStub.restore();
    getSessionStub.restore();

    await sessionManager.saveAllSessions();

    expect(rollbackCalls).to.equal(1);
    expect(await database.getSession(failedSession.getSessionId())).to.equal(null);
  });

  it("reconciles an uncertain committed insert against its immutable running snapshot", async () => {
    let moduleManager = ServiceManager.GetService(ModuleManager);
    let failedSession: FaucetSession;
    let rollbackCalls = 0;
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 10, "acquire external ownership", (session: FaucetSession) => {
      failedSession = session;
      session.registerStartRollback("external reservation", () => {
        rollbackCalls++;
      });
      session.addBlockingTask("test", "hold", 60);
    });
    let database = ServiceManager.GetService(FaucetDatabase);
    let originalInsert = database.insertRunningSession.bind(database);
    let insertStub = sinon.stub(database, "insertRunningSession").callsFake(async (sessionData) => {
      await originalInsert(sessionData);
      throw new Error("insert acknowledgement lost");
    });
    let originalGetSession = database.getSession.bind(database);
    let failedReconciliationReads = 0;
    let getSessionStub = sinon.stub(database, "getSession").callsFake(async (sessionId) => {
      if(failedSession && sessionId === failedSession.getSessionId() && failedReconciliationReads++ < 2)
        throw new Error("session read unavailable");
      return originalGetSession(sessionId);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);

    try {
      await sessionManager.createSession("8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
    } catch {}

    expect(rollbackCalls).to.equal(0, "rollback ran before the committed insert was reconciled");
    insertStub.restore();
    getSessionStub.restore();
    await sessionManager.saveAllSessions();

    expect(rollbackCalls).to.equal(1);
    expect((await database.getSession(failedSession.getSessionId())).status).to.equal(FaucetSessionStatus.FAILED);
  });

  it("adopts a successfully advanced uncertain insert without rolling back its start ownership", async () => {
    let moduleManager = ServiceManager.GetService(ModuleManager);
    let uncertainSession: FaucetSession;
    let rollbackCalls = 0;
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 10, "acquire external ownership", (session: FaucetSession) => {
      uncertainSession = session;
      session.registerStartRollback("external reservation", () => {
        rollbackCalls++;
      });
      session.addBlockingTask("test", "hold", 60);
    });
    let database = ServiceManager.GetService(FaucetDatabase);
    let originalInsert = database.insertRunningSession.bind(database);
    let insertStub = sinon.stub(database, "insertRunningSession").callsFake(async (sessionData) => {
      await originalInsert(sessionData);
      throw new Error("insert acknowledgement lost");
    });
    let originalGetSession = database.getSession.bind(database);
    let failedReconciliationReads = 0;
    let getSessionStub = sinon.stub(database, "getSession").callsFake(async (sessionId) => {
      if(uncertainSession && sessionId === uncertainSession.getSessionId() && failedReconciliationReads++ < 2)
        throw new Error("session read unavailable");
      return originalGetSession(sessionId);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);

    try {
      await sessionManager.createSession("8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
    } catch {}

    expect(rollbackCalls).to.equal(0);
    insertStub.restore();
    getSessionStub.restore();
    let runningSession = await database.getSession(uncertainSession.getSessionId());
    expect(runningSession.status).to.equal(FaucetSessionStatus.RUNNING);
    expect(await database.transitionSession({
      ...runningSession,
      status: FaucetSessionStatus.CLAIMABLE,
      dropAmount: faucetConfig.maxDropAmount.toString(),
    }, FaucetSessionStatus.RUNNING)).to.equal(true);

    await sessionManager.saveAllSessions();

    expect(rollbackCalls).to.equal(0, "successful terminal ownership was released by a failed-start rollback");
    expect(uncertainSession.getSessionStatus()).to.equal(FaucetSessionStatus.CLAIMABLE);
    expect((await database.getSession(uncertainSession.getSessionId())).status).to.equal(FaucetSessionStatus.CLAIMABLE);
  });

  it("clears registered start rollbacks only after durable activation", async () => {
    let moduleManager = ServiceManager.GetService(ModuleManager);
    let rollbackCalls = 0;
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 10, "acquire external ownership", (session: FaucetSession) => {
      session.registerStartRollback("external reservation", () => {
        rollbackCalls++;
      });
      session.addBlockingTask("test", "hold", 60);
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.RUNNING);
    expect((await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId())).status).to.equal(FaucetSessionStatus.RUNNING);

    await session.setSessionFailed("TEST", "later failure");

    expect(rollbackCalls).to.equal(0);
  });

  it("keeps a durable claimable payout when post-commit statistics fail", async () => {
    let sessionManager = ServiceManager.GetService(SessionManager);
    let releaseAdmission = sinon.spy(sessionManager, "releaseAdmission");
    sinon.stub(FaucetStatsLog.prototype, "addSessionStats").throws(new Error("injected statistics failure"));

    let session = await sessionManager.createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());

    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.CLAIMABLE);
    expect(storedSession.status).to.equal(FaucetSessionStatus.CLAIMABLE);
    expect(storedSession.data["failed.code"]).to.equal(undefined);
    expect(releaseAdmission.calledOnceWithExactly(session)).to.equal(true);
  });

  it("keeps a durable claimable payout when its post-commit log fails", async () => {
    let faucetProcess = ServiceManager.GetService(FaucetProcess);
    let originalLog = faucetProcess.emitLog.bind(faucetProcess);
    sinon.stub(faucetProcess, "emitLog").callsFake((level, message) => {
      if(message.includes(" is claimable"))
        throw new Error("injected claimable log failure");
      return originalLog(level, message);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let releaseAdmission = sinon.spy(sessionManager, "releaseAdmission");

    let session = await sessionManager.createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });

    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.CLAIMABLE);
    expect((await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId())).status).to.equal(FaucetSessionStatus.CLAIMABLE);
    expect(releaseAdmission.calledOnceWithExactly(session)).to.equal(true);
  });

  it("reconciles a claimable transition that commits before its acknowledgement fails", async () => {
    let moduleManager = ServiceManager.GetService(ModuleManager);
    let disableSpies: ReturnType<typeof spyOnRewardContextDisable>;
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "observe reward contexts", (session: FaucetSession) => {
      disableSpies = spyOnRewardContextDisable(session);
    });
    let completionHookCalls = 0;
    moduleManager.addActionHook(null, ModuleHookAction.SessionComplete, 100, "completion-count", () => {
      completionHookCalls++;
    });
    let database = ServiceManager.GetService(FaucetDatabase);
    let originalTransition = database.transitionSession.bind(database);
    let acknowledgementLost = false;
    sinon.stub(database, "transitionSession").callsFake(async (sessionData, expectedStatus) => {
      let transitioned = await originalTransition(sessionData, expectedStatus);
      if(!acknowledgementLost && transitioned && sessionData.status === FaucetSessionStatus.CLAIMABLE) {
        acknowledgementLost = true;
        throw new Error("claimable acknowledgement lost");
      }
      return transitioned;
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let releaseAdmission = sinon.spy(sessionManager, "releaseAdmission");

    let session = await sessionManager.createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });

    expect(acknowledgementLost).to.equal(true);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.CLAIMABLE);
    expect((await database.getSession(session.getSessionId())).status).to.equal(FaucetSessionStatus.CLAIMABLE);
    expect(completionHookCalls).to.equal(1);
    expect(releaseAdmission.calledOnceWithExactly(session)).to.equal(true);
    expectRewardContextsDisabled(disableSpies, 1);
  });

  it("reports lost claimable ownership without dereferencing an absent reconciliation row", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let originalTransition = database.transitionSession.bind(database);
    sinon.stub(database, "transitionSession").callsFake(async (sessionData, expectedStatus) => {
      if(sessionData.status === FaucetSessionStatus.CLAIMABLE)
        throw new Error("claimable persistence unavailable");
      return originalTransition(sessionData, expectedStatus);
    });
    sinon.stub(database, "getSession").resolves(null);

    let failure: unknown;
    try {
      await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
    } catch(ex) {
      failure = ex;
    }

    expect(String(failure)).to.include("claimable persistence unavailable");
    expect(String(failure)).to.not.include("Cannot read properties of null");
  });

  it("reconciles an initial insert that commits before its acknowledgement fails", async () => {
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    let database = ServiceManager.GetService(FaucetDatabase);
    let originalInsert = database.insertRunningSession.bind(database);
    let acknowledgementLost = false;
    sinon.stub(database, "insertRunningSession").callsFake(async (sessionData) => {
      await originalInsert(sessionData);
      if(!acknowledgementLost) {
        acknowledgementLost = true;
        throw new Error("insert acknowledgement lost");
      }
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let storedSession = await database.getSession(session.getSessionId());

    expect(acknowledgementLost).to.equal(true);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.RUNNING);
    expect(storedSession.status).to.equal(FaucetSessionStatus.RUNNING);
    expect(storedSession.data).to.deep.equal(session.getStoreData().data);
  });

  it("retries failed terminal persistence without replaying completion hooks", async () => {
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    let completionHookCalls = 0;
    moduleManager.addActionHook(null, ModuleHookAction.SessionComplete, 100, "completion-count", () => {
      completionHookCalls++;
    });

    let sessionManager = ServiceManager.GetService(SessionManager);
    let releaseAdmission = sinon.spy(sessionManager, "releaseAdmission");
    let session = await sessionManager.createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let disableSpies = spyOnRewardContextDisable(session);
    let database = ServiceManager.GetService(FaucetDatabase);
    let originalTransition = database.transitionSession.bind(database);
    let transitionAttempts = 0;
    sinon.stub(database, "transitionSession").callsFake(async (sessionData, expectedStatus) => {
      transitionAttempts++;
      if(transitionAttempts === 1)
        throw new Error("transient terminal persistence failure");
      return originalTransition(sessionData, expectedStatus);
    });

    let firstError: unknown;
    try {
      await session.setSessionFailed("TEST", "test failure");
    } catch(ex) {
      firstError = ex;
    }
    expect(firstError).to.not.equal(undefined);
    expect(completionHookCalls).to.equal(1);
    expect(releaseAdmission.notCalled).to.equal(true);
    expect((await database.getSession(session.getSessionId())).status).to.equal(FaucetSessionStatus.RUNNING);
    expectRewardContextsDisabled(disableSpies, 0);

    await sessionManager.saveAllSessions();

    expect(transitionAttempts).to.equal(2);
    expect(completionHookCalls).to.equal(1, "terminal persistence retry replayed completion hooks");
    expect(releaseAdmission.calledOnceWithExactly(session)).to.equal(true);
    expect((await database.getSession(session.getSessionId())).status).to.equal(FaucetSessionStatus.FAILED);
    expectRewardContextsDisabled(disableSpies, 1);
  });

  it("reconciles terminal persistence that commits before its acknowledgement fails", async () => {
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    let completionHookCalls = 0;
    moduleManager.addActionHook(null, ModuleHookAction.SessionComplete, 100, "completion-count", () => {
      completionHookCalls++;
    });

    let sessionManager = ServiceManager.GetService(SessionManager);
    let releaseAdmission = sinon.spy(sessionManager, "releaseAdmission");
    let session = await sessionManager.createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let database = ServiceManager.GetService(FaucetDatabase);
    let originalTransition = database.transitionSession.bind(database);
    let acknowledgementLost = false;
    sinon.stub(database, "transitionSession").callsFake(async (sessionData, expectedStatus) => {
      let transitioned = await originalTransition(sessionData, expectedStatus);
      if(!acknowledgementLost && transitioned) {
        acknowledgementLost = true;
        throw new Error("terminal acknowledgement lost");
      }
      return transitioned;
    });

    await session.setSessionFailed("TEST", "test failure");

    expect(acknowledgementLost).to.equal(true);
    expect(completionHookCalls).to.equal(1);
    expect(releaseAdmission.calledOnceWithExactly(session)).to.equal(true);
    expect((await database.getSession(session.getSessionId())).status).to.equal(FaucetSessionStatus.FAILED);
  });

  it("reconciles a timeout that commits before its acknowledgement fails", async () => {
    faucetConfig.sessionTimeout = 3600;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    let completionHookCalls = 0;
    moduleManager.addActionHook(null, ModuleHookAction.SessionComplete, 100, "completion-count", () => {
      completionHookCalls++;
    });

    let sessionManager = ServiceManager.GetService(SessionManager);
    let releaseAdmission = sinon.spy(sessionManager, "releaseAdmission");
    let session = await sessionManager.createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let database = ServiceManager.GetService(FaucetDatabase);
    let originalTimeout = database.tryTimeoutSession.bind(database);
    let acknowledgementLost = false;
    sinon.stub(database, "tryTimeoutSession").callsFake(async (sessionData, timeout) => {
      let transitioned = await originalTimeout(sessionData, timeout);
      if(!acknowledgementLost && transitioned) {
        acknowledgementLost = true;
        throw new Error("timeout acknowledgement lost");
      }
      return transitioned;
    });

    expect(await session.tryApplyTimeout(-1)).to.equal(true);

    expect(acknowledgementLost).to.equal(true);
    expect(completionHookCalls).to.equal(1);
    expect(releaseAdmission.calledOnceWithExactly(session)).to.equal(true);
    expect((await database.getSession(session.getSessionId())).status).to.equal(FaucetSessionStatus.FAILED);
  });

  it("Create invalid session (missing addr)", async () => {
    let sessionManager = ServiceManager.GetService(SessionManager);
    let error: FaucetError | null = null;
    try {
      await sessionManager.createSession("8.8.8.8", { });
    } catch(ex) { error = ex; }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("INVALID_ADDR", "unexpected error code");
  });

  it("Create invalid session (invalid addr)", async () => {
    let sessionManager = ServiceManager.GetService(SessionManager);
    let error: FaucetError | null = null;
    try {
      await sessionManager.createSession("8.8.8.8", { addr: "not_a_eth_address" });
    } catch(ex) { error = ex; }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("INVALID_ADDR", "unexpected error code");
    expect(error?.message).to.equal("Invalid target address.");
    expect(error?.message).to.not.include("not_a_eth_address");
  });

  it("waits for completion hooks before a running session finishes failing", async () => {
    let releaseHook: () => void;
    let hookStarted: () => void;
    let hookGate = new Promise<void>((resolve) => releaseHook = resolve);
    let hookEntered = new Promise<void>((resolve) => hookStarted = resolve);
    ServiceManager.GetService(ModuleManager).addActionHook(
      null,
      ModuleHookAction.SessionStart,
      100,
      "keep-running",
      (session: FaucetSession) => session.addBlockingTask("test", "hold", 60),
    );
    ServiceManager.GetService(ModuleManager).addActionHook(
      null,
      ModuleHookAction.SessionComplete,
      100,
      "delayed-completion",
      async () => {
        hookStarted();
        await hookGate;
      },
    );

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let failurePromise = session.setSessionFailed("TEST", "test failure");
    await hookEntered;
    let settled = false;
    failurePromise.then(() => settled = true);
    await Promise.resolve();
    expect(settled).to.equal(false);

    releaseHook();
    await failurePromise;
    expect(settled).to.equal(true);
  });

  it("Create session with blocking task", async () => {
    faucetConfig.minDropAmount = 1000;
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let now = Math.floor(new Date().getTime() / 1000);
    let testSession = await sessionManager.createSession("8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    expect(testSession).to.not.equal(null, "createSession failed");
    expect(testSession.getRemoteIP()).to.equal("8.8.8.8", "unexpected remoteIP");
    expect(testSession.getTargetAddr()).to.equal("0x0000000000000000000000000000000000001337", "unexpected targetAddr");
    expect(Math.abs(testSession.getStartTime() - now)).to.be.lessThan(2, "unexpected startTime");
    expect(testSession.getBlockingTasks().length).to.equal(1, "unexpected blockingTasks");
    expect(testSession.getSessionStatus()).to.equal(FaucetSessionStatus.RUNNING, "unexpected session status");
    await testSession.addReward(1337n);
    expect(testSession.getDropAmount()).to.equal(1337n, "unexpected drop amount after addReward()");
    await testSession.subPenalty(10n);
    expect(testSession.getDropAmount()).to.equal(1327n, "unexpected drop amount after subPenalty()");
    let runningSession = sessionManager.getSession(testSession.getSessionId(), [FaucetSessionStatus.RUNNING]);
    expect(runningSession === testSession).to.equal(true, "sessionManager.getSession did not return running session (running state)");
    let runningSession2 = sessionManager.getSession(testSession.getSessionId());
    expect(runningSession2 === testSession).to.equal(true, "sessionManager.getSession did not return running session (stateless)");
    await awaitSleepPromise(4000, () => testSession.getSessionStatus() === FaucetSessionStatus.CLAIMABLE);
    expect(testSession.getSessionStatus()).to.equal(FaucetSessionStatus.CLAIMABLE, "unexpected session status");
    testSession.setDropAmount(42n); // this may not work anymore as the balance is already set
    expect(testSession.getDropAmount()).to.equal(1327n, "unexpected drop amount after setDropAmount()");
  }).timeout(5000);

  it("does not emit accounting hooks when a session closes during factor evaluation", async () => {
    faucetConfig.minDropAmount = 1;
    let releaseFactor: () => void;
    let factorEntered: () => void;
    let factorGate = new Promise<void>((resolve) => releaseFactor = resolve);
    let factorStarted = new Promise<void>((resolve) => factorEntered = resolve);
    let rewardedAmount = 0n;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "delayed-factor", async () => {
      factorEntered();
      await factorGate;
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "accounting", (_session: FaucetSession, amount: bigint) => {
      rewardedAmount += amount;
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let rewardPromise = session.addReward(10n);
    await factorStarted;
    let failurePromise = session.setSessionFailed("TEST_CLOSE", "test close during factor evaluation");
    let failureSettled = false;
    failurePromise.then(() => failureSettled = true);
    await Promise.resolve();
    expect(failureSettled).to.equal(false, "terminal state bypassed the pending reward operation");
    releaseFactor();
    await failurePromise;

    expect(await rewardPromise).to.equal(0n, "a closed session accepted the pending reward");
    expect(session.getDropAmount()).to.equal(0n, "a closed session balance changed");
    expect(rewardedAmount).to.equal(0n, "accounting hooks ran for an uncommitted reward");
  });

  it("queues a microtask detached from a synchronous factor hook behind reward accounting", async () => {
    faucetConfig.minDropAmount = 1;
    let releasePeer: () => void;
    let peerEntered: () => void;
    let detachedRequested: () => void;
    let detachedSettled = false;
    let detachedWork: Promise<void>;
    let accountedAmount = 0n;
    const peerGate = new Promise<void>((resolve) => releasePeer = resolve);
    const peerStarted = new Promise<void>((resolve) => peerEntered = resolve);
    const detachedRequest = new Promise<void>((resolve) => detachedRequested = resolve);
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "detached-microtask", (session: FaucetSession) => {
      detachedWork = Promise.resolve().then(async () => {
        const failure = session.setSessionFailed("DETACHED_FACTOR_MICROTASK", "detached factor microtask");
        detachedRequested();
        await failure;
        detachedSettled = true;
      });
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "blocked-peer", async () => {
      peerEntered();
      await peerGate;
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "accounting", (_session: FaucetSession, amount: bigint) => {
      accountedAmount += amount;
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    const reward = session.addReward(19n);
    await Promise.all([peerStarted, detachedRequest]);
    await Promise.resolve();
    const settledWhilePeerBlocked = detachedSettled;
    releasePeer();
    const appliedAmount = await reward;
    await detachedWork;

    expect(settledWhilePeerBlocked).to.equal(false, "a synchronous factor hook retained authority in its detached microtask");
    expect(appliedAmount).to.equal(19n);
    expect(accountedAmount).to.equal(19n);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
    expect(session.getDropAmount()).to.equal(19n);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.dropAmount).to.equal("19");
    expect(storedSession.data["failed.code"]).to.equal("DETACHED_FACTOR_MICROTASK");
  }).timeout(3000);

  it("deactivates factor-hook authority before a throwing then getter queues a microtask", async () => {
    faucetConfig.minDropAmount = 1;
    let releasePeer: () => void;
    let peerEntered: () => void;
    let detachedRequested: () => void;
    let detachedSettled = false;
    let detachedWork: Promise<void>;
    const peerGate = new Promise<void>((resolve) => releasePeer = resolve);
    const peerStarted = new Promise<void>((resolve) => peerEntered = resolve);
    const detachedRequest = new Promise<void>((resolve) => detachedRequested = resolve);
    const thenError = new Error("factor then getter failed");
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "throwing-then-getter", (session: FaucetSession) => {
      return Object.defineProperty({}, "then", {
        get: () => {
          detachedWork = Promise.resolve().then(async () => {
            const failure = session.setSessionFailed("DETACHED_THEN_GETTER", "detached then-getter microtask");
            detachedRequested();
            await failure;
            detachedSettled = true;
          });
          throw thenError;
        },
      });
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "blocked-peer", async () => {
      peerEntered();
      await peerGate;
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    const reward = session.addReward(29n).then(() => null, (error) => error);
    await Promise.all([peerStarted, detachedRequest]);
    await Promise.resolve();
    const settledWhilePeerBlocked = detachedSettled;
    releasePeer();
    const rewardError = await reward;
    await detachedWork;

    expect(settledWhilePeerBlocked).to.equal(false, "a throwing then getter retained factor-hook authority");
    expect(rewardError).to.equal(thenError);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
    expect(session.getDropAmount()).to.equal(0n);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.data["failed.code"]).to.equal("DETACHED_THEN_GETTER");
  }).timeout(3000);

  it("queues a microtask detached from a synchronous accounting hook behind its peer batch", async () => {
    faucetConfig.minDropAmount = 1;
    let releasePeer: () => void;
    let peerEntered: () => void;
    let detachedRequested: () => void;
    let detachedSettled = false;
    let detachedWork: Promise<void>;
    let accountedAmount = 0n;
    const peerGate = new Promise<void>((resolve) => releasePeer = resolve);
    const peerStarted = new Promise<void>((resolve) => peerEntered = resolve);
    const detachedRequest = new Promise<void>((resolve) => detachedRequested = resolve);
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "detached-microtask", (session: FaucetSession) => {
      detachedWork = Promise.resolve().then(async () => {
        const failure = session.setSessionFailed("DETACHED_ACCOUNTING_MICROTASK", "detached accounting microtask");
        detachedRequested();
        await failure;
        detachedSettled = true;
      });
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "blocked-peer", async () => {
      peerEntered();
      await peerGate;
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "accounting", (_session: FaucetSession, amount: bigint) => {
      accountedAmount += amount;
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    const reward = session.addReward(23n);
    await Promise.all([peerStarted, detachedRequest]);
    await Promise.resolve();
    const settledWhilePeerBlocked = detachedSettled;
    const amountWhilePeerBlocked = session.getDropAmount();
    releasePeer();
    const appliedAmount = await reward;
    await detachedWork;

    expect(settledWhilePeerBlocked).to.equal(false, "a synchronous accounting hook retained authority in its detached microtask");
    expect(amountWhilePeerBlocked).to.equal(23n);
    expect(appliedAmount).to.equal(23n);
    expect(accountedAmount).to.equal(23n);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
    expect(session.getDropAmount()).to.equal(23n);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.dropAmount).to.equal("23");
    expect(storedSession.data["failed.code"]).to.equal("DETACHED_ACCOUNTING_MICROTASK");
  }).timeout(3000);

  it("queues failure from a detached factor continuation until rewarded accounting finishes", async () => {
    faucetConfig.minDropAmount = 1;
    let releaseDetached: () => void;
    let detachedRequested: () => void;
    let accountingStarted: () => void;
    let releaseAccounting: () => void;
    let detachedSettled = false;
    let detachedWork: Promise<void>;
    const detachedGate = new Promise<void>((resolve) => releaseDetached = resolve);
    const detachedRequest = new Promise<void>((resolve) => detachedRequested = resolve);
    const accountingEntered = new Promise<void>((resolve) => accountingStarted = resolve);
    const accountingGate = new Promise<void>((resolve) => releaseAccounting = resolve);
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "detached-failure", (session: FaucetSession) => {
      detachedWork = (async () => {
        await detachedGate;
        const failure = session.setSessionFailed("DETACHED_FACTOR_FAILURE", "detached factor failure");
        detachedRequested();
        await failure;
        detachedSettled = true;
      })();
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "delayed-accounting", async () => {
      accountingStarted();
      await accountingGate;
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    const reward = session.addReward(41n);
    await accountingEntered;
    releaseDetached();
    await detachedRequest;
    await Promise.resolve();

    const settledWhileAccounting = detachedSettled;
    const statusWhileAccounting = session.getSessionStatus();
    const dropAmountWhileAccounting = session.getDropAmount();
    const storedWhileAccounting = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    releaseAccounting();
    expect(await reward).to.equal(41n);
    await detachedWork;

    expect(settledWhileAccounting).to.equal(false, "detached failure bypassed the reward queue");
    expect(statusWhileAccounting).to.equal(FaucetSessionStatus.RUNNING);
    expect(dropAmountWhileAccounting).to.equal(41n);
    expect(storedWhileAccounting.status).to.equal(FaucetSessionStatus.RUNNING);
    expect(storedWhileAccounting.dropAmount).to.equal("-1");
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
    expect(session.getDropAmount()).to.equal(41n);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.dropAmount).to.equal("41");
    expect(storedSession.data["failed.code"]).to.equal("DETACHED_FACTOR_FAILURE");
  }).timeout(3000);

  it("queues completion from a detached factor continuation until rewarded accounting finishes", async () => {
    faucetConfig.minDropAmount = 1;
    let releaseDetached: () => void;
    let detachedRequested: () => void;
    let accountingStarted: () => void;
    let releaseAccounting: () => void;
    let detachedSettled = false;
    let detachedWork: Promise<void>;
    const detachedGate = new Promise<void>((resolve) => releaseDetached = resolve);
    const detachedRequest = new Promise<void>((resolve) => detachedRequested = resolve);
    const accountingEntered = new Promise<void>((resolve) => accountingStarted = resolve);
    const accountingGate = new Promise<void>((resolve) => releaseAccounting = resolve);
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "detached-completion", (session: FaucetSession) => {
      detachedWork = (async () => {
        await detachedGate;
        const completion = session.completeSession();
        detachedRequested();
        await completion;
        detachedSettled = true;
      })();
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "delayed-accounting", async () => {
      accountingStarted();
      await accountingGate;
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    const reward = session.addReward(43n);
    await accountingEntered;
    releaseDetached();
    await detachedRequest;
    await Promise.resolve();

    const settledWhileAccounting = detachedSettled;
    const statusWhileAccounting = session.getSessionStatus();
    const dropAmountWhileAccounting = session.getDropAmount();
    const storedWhileAccounting = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    releaseAccounting();
    expect(await reward).to.equal(43n);
    await detachedWork;

    expect(settledWhileAccounting).to.equal(false, "detached completion bypassed the reward queue");
    expect(statusWhileAccounting).to.equal(FaucetSessionStatus.RUNNING);
    expect(dropAmountWhileAccounting).to.equal(43n);
    expect(storedWhileAccounting.status).to.equal(FaucetSessionStatus.RUNNING);
    expect(storedWhileAccounting.dropAmount).to.equal("-1");
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.CLAIMABLE);
    expect(session.getDropAmount()).to.equal(43n);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.CLAIMABLE);
    expect(storedSession.dropAmount).to.equal("43");
  }).timeout(3000);

  it("queues a detached factor descendant after its hook returns while a same-priority peer is blocked", async () => {
    faucetConfig.minDropAmount = 1;
    let releaseDetached: () => void;
    let releasePeer: () => void;
    let detachedRequested: () => void;
    let peerEntered: () => void;
    let detachedSettled = false;
    let detachedWork: Promise<void>;
    let rewardedAmount = 0n;
    const detachedGate = new Promise<void>((resolve) => releaseDetached = resolve);
    const peerGate = new Promise<void>((resolve) => releasePeer = resolve);
    const detachedRequest = new Promise<void>((resolve) => detachedRequested = resolve);
    const peerStarted = new Promise<void>((resolve) => peerEntered = resolve);
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "detached-failure", (session: FaucetSession) => {
      detachedWork = (async () => {
        await detachedGate;
        const failure = session.setSessionFailed("DETACHED_FACTOR_PEER_FAILURE", "detached factor peer failure");
        detachedRequested();
        await failure;
        detachedSettled = true;
      })();
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "blocked-peer", async () => {
      peerEntered();
      await peerGate;
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "accounting", (_session: FaucetSession, amount: bigint) => {
      rewardedAmount += amount;
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let disableSpies = spyOnRewardContextDisable(session);
    const reward = session.addReward(17n);
    await peerStarted;
    await Promise.resolve();
    await Promise.resolve();
    releaseDetached();
    await detachedRequest;
    await Promise.resolve();

    const settledWhilePeerBlocked = detachedSettled;
    const statusWhilePeerBlocked = session.getSessionStatus();
    const amountWhilePeerBlocked = session.getDropAmount();
    const storedWhilePeerBlocked = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expectRewardContextsDisabled(disableSpies, 0);
    releasePeer();
    const appliedReward = await reward;
    await detachedWork;

    expect(settledWhilePeerBlocked).to.equal(false, "a detached factor descendant retained hook reentry authority");
    expect(statusWhilePeerBlocked).to.equal(FaucetSessionStatus.RUNNING);
    expect(amountWhilePeerBlocked).to.equal(0n);
    expect(storedWhilePeerBlocked.status).to.equal(FaucetSessionStatus.RUNNING);
    expect(storedWhilePeerBlocked.dropAmount).to.equal("-1");
    expect(appliedReward).to.equal(17n);
    expect(rewardedAmount).to.equal(17n);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
    expect(session.getDropAmount()).to.equal(17n);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.dropAmount).to.equal("17");
    expect(storedSession.data["failed.code"]).to.equal("DETACHED_FACTOR_PEER_FAILURE");
    expectRewardContextsDisabled(disableSpies, 1);
  }).timeout(3000);

  it("queues a detached accounting descendant after its hook returns while a same-priority peer is blocked", async () => {
    faucetConfig.minDropAmount = 1;
    let releaseDetached: () => void;
    let releasePeer: () => void;
    let detachedRequested: () => void;
    let peerEntered: () => void;
    let detachedSettled = false;
    let detachedWork: Promise<void>;
    const detachedGate = new Promise<void>((resolve) => releaseDetached = resolve);
    const peerGate = new Promise<void>((resolve) => releasePeer = resolve);
    const detachedRequest = new Promise<void>((resolve) => detachedRequested = resolve);
    const peerStarted = new Promise<void>((resolve) => peerEntered = resolve);
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "detached-failure", (session: FaucetSession) => {
      detachedWork = (async () => {
        await detachedGate;
        const failure = session.setSessionFailed("DETACHED_ACCOUNTING_PEER_FAILURE", "detached accounting peer failure");
        detachedRequested();
        await failure;
        detachedSettled = true;
      })();
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "blocked-peer", async () => {
      peerEntered();
      await peerGate;
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let disableSpies = spyOnRewardContextDisable(session);
    const reward = session.addReward(19n);
    await peerStarted;
    await Promise.resolve();
    await Promise.resolve();
    releaseDetached();
    await detachedRequest;
    await Promise.resolve();

    const settledWhilePeerBlocked = detachedSettled;
    const statusWhilePeerBlocked = session.getSessionStatus();
    const amountWhilePeerBlocked = session.getDropAmount();
    const storedWhilePeerBlocked = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expectRewardContextsDisabled(disableSpies, 0);
    releasePeer();
    const appliedReward = await reward;
    await detachedWork;

    expect(settledWhilePeerBlocked).to.equal(false, "a detached accounting descendant retained hook reentry authority");
    expect(statusWhilePeerBlocked).to.equal(FaucetSessionStatus.RUNNING);
    expect(amountWhilePeerBlocked).to.equal(19n);
    expect(storedWhilePeerBlocked.status).to.equal(FaucetSessionStatus.RUNNING);
    expect(storedWhilePeerBlocked.dropAmount).to.equal("-1");
    expect(appliedReward).to.equal(19n);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
    expect(session.getDropAmount()).to.equal(19n);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.dropAmount).to.equal("19");
    expect(storedSession.data["failed.code"]).to.equal("DETACHED_ACCOUNTING_PEER_FAILURE");
    expectRewardContextsDisabled(disableSpies, 1);
  }).timeout(3000);

  it("does not cycle the reward queue when same-tick failure races factor completion", async () => {
    faucetConfig.minDropAmount = 1;
    let factorEntered: () => void;
    let factorStarted = new Promise<void>((resolve) => factorEntered = resolve);
    let rewardedAmount = 0n;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "complete-from-factor", async (session: FaucetSession) => {
      factorEntered();
      await session.completeSession();
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "accounting", (_session: FaucetSession, amount: bigint) => {
      rewardedAmount += amount;
    });

    let sessionManager = ServiceManager.GetService(SessionManager);
    let session = await sessionManager.createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let rewardSettled = false;
    let failureSettled = false;
    let drainSettled = false;
    const reward = session.addReward(41n);
    const failure = session.setSessionFailed("SAME_TICK_FAILURE", "same-tick external failure");
    await factorStarted;
    sessionManager.stopRewardOperations();
    const drain = sessionManager.drainRewardOperations();
    reward.then(() => rewardSettled = true, () => rewardSettled = true);
    failure.then(() => failureSettled = true, () => failureSettled = true);
    drain.then(() => drainSettled = true, () => drainSettled = true);

    await awaitSleepPromise(2000, () => rewardSettled && failureSettled && drainSettled);
    expect(rewardSettled).to.equal(true, "reward operation remained blocked by its queued terminal operation");
    expect(failureSettled).to.equal(true, "same-tick external failure did not settle");
    expect(drainSettled).to.equal(true, "shutdown reward drain did not settle");
    expect(await reward).to.equal(0n);
    await Promise.all([failure, drain]);
    expect(rewardedAmount).to.equal(0n);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
    expect(session.getDropAmount()).to.equal(0n);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.dropAmount).to.equal("-1");
    expect(storedSession.data["failed.code"]).to.equal("SAME_TICK_FAILURE");
  }).timeout(5000);

  it("closes reward-operation admission atomically and keeps post-close public calls inert", async () => {
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });

    let sessionManager = ServiceManager.GetService(SessionManager);
    let session = await sessionManager.createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let database = ServiceManager.GetService(FaucetDatabase);
    let transitionSession = sinon.spy(database, "transitionSession");
    let updateRunningSession = sinon.spy(database, "updateRunningSession");
    let insertRunningSession = sinon.spy(database, "insertRunningSession");

    sessionManager.stopRewardOperations();
    await sessionManager.drainRewardProducers();
    let drain = sessionManager.drainRewardOperations();
    let directOperationRan = false;
    let directOperationError = sessionManager.runRewardOperation(async () => {
      directOperationRan = true;
    }).then(
      () => null,
      (error) => error,
    );
    let publicResults = Promise.all([
      session.setSessionFailed("POST_CLOSE_FAILURE", "must not persist"),
      session.completeSession(),
      session.setDropAmount(100n),
      session.addReward(41n),
      session.subPenalty(41n),
    ]);

    await drain;
    expect(await directOperationError).to.be.instanceOf(Error).with.property(
      "message",
      "Reward operation admission is closed.",
    );
    expect(await publicResults).to.deep.equal([undefined, undefined, 0n, 0n, 0n]);
    expect(directOperationRan).to.equal(false);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.RUNNING);
    expect(session.getDropAmount()).to.equal(0n);
    expect(transitionSession.callCount).to.equal(0);
    expect(updateRunningSession.callCount).to.equal(0);
    expect(insertRunningSession.callCount).to.equal(0);
    let storedSession = await database.getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.RUNNING);
    expect(storedSession.dropAmount).to.equal("-1");
  });

  it("lets factor failure override same-tick external completion", async () => {
    faucetConfig.minDropAmount = 1;
    let rewardedAmount = 0n;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "fail-from-factor", async (session: FaucetSession) => {
      await session.setSessionFailed("FACTOR_FAILURE", "factor requested failure");
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "accounting", (_session: FaucetSession, amount: bigint) => {
      rewardedAmount += amount;
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let rewardSettled = false;
    let completionSettled = false;
    const reward = session.addReward(43n);
    const completion = session.completeSession();
    reward.then(() => rewardSettled = true, () => rewardSettled = true);
    completion.then(() => completionSettled = true, () => completionSettled = true);

    await awaitSleepPromise(2000, () => rewardSettled && completionSettled);
    expect(rewardSettled).to.equal(true, "reward operation remained blocked by external completion");
    expect(completionSettled).to.equal(true, "external completion did not settle after factor failure");
    expect(await reward).to.equal(0n);
    await completion;
    expect(rewardedAmount).to.equal(0n);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
    expect(session.getDropAmount()).to.equal(0n);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.dropAmount).to.equal("-1");
    expect(storedSession.data["failed.code"]).to.equal("FACTOR_FAILURE");
  }).timeout(5000);

  it("defers factor-only failure until every factor hook settles", async () => {
    faucetConfig.minDropAmount = 1;
    let statusAfterFailureRequest: FaucetSessionStatus;
    let peerStatus: FaucetSessionStatus;
    let failureRequested: () => void;
    let failureRequest = new Promise<void>((resolve) => failureRequested = resolve);
    let rewardedAmount = 0n;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "fail-from-factor", async (session: FaucetSession) => {
      await session.setSessionFailed("FACTOR_ONLY_FAILURE", "factor requested failure");
      statusAfterFailureRequest = session.getSessionStatus();
      failureRequested();
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "observe-factor-batch", async (session: FaucetSession) => {
      await failureRequest;
      peerStatus = session.getSessionStatus();
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "accounting", (_session: FaucetSession, amount: bigint) => {
      rewardedAmount += amount;
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(await session.addReward(47n)).to.equal(0n);

    expect(statusAfterFailureRequest).to.equal(FaucetSessionStatus.RUNNING);
    expect(peerStatus).to.equal(FaucetSessionStatus.RUNNING);
    expect(rewardedAmount).to.equal(0n);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
    expect(session.getDropAmount()).to.equal(0n);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.dropAmount).to.equal("-1");
    expect(storedSession.data["failed.code"]).to.equal("FACTOR_ONLY_FAILURE");
  });

  it("gives failure precedence across same-priority factor intents", async () => {
    faucetConfig.minDropAmount = 1;
    let statusesAfterIntent: FaucetSessionStatus[] = [];
    let rewardedAmount = 0n;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "complete-intent", async (session: FaucetSession) => {
      await session.completeSession();
      statusesAfterIntent.push(session.getSessionStatus());
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "first-failure-intent", async (session: FaucetSession) => {
      await session.setSessionFailed("FIRST_FACTOR_FAILURE", "first factor failure");
      statusesAfterIntent.push(session.getSessionStatus());
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "second-failure-intent", async (session: FaucetSession) => {
      await session.setSessionFailed("SECOND_FACTOR_FAILURE", "second factor failure");
      statusesAfterIntent.push(session.getSessionStatus());
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "accounting", (_session: FaucetSession, amount: bigint) => {
      rewardedAmount += amount;
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(await session.addReward(53n)).to.equal(0n);

    expect(statusesAfterIntent).to.deep.equal([
      FaucetSessionStatus.RUNNING,
      FaucetSessionStatus.RUNNING,
      FaucetSessionStatus.RUNNING,
    ]);
    expect(rewardedAmount).to.equal(0n);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
    expect(session.getDropAmount()).to.equal(0n);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.dropAmount).to.equal("-1");
    expect(storedSession.data["failed.code"]).to.equal("FIRST_FACTOR_FAILURE");
  });

  it("fails closed when a finite reward factor overflows its scaled representation", async () => {
    let rewardedAmount = 0n;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "oversized-factor", (_session: FaucetSession, factors) => {
      factors.push({factor: Number.MAX_VALUE, module: "test"});
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "accounting", (_session: FaucetSession, amount: bigint) => {
      rewardedAmount += amount;
    });
    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });

    expect(await session.addReward(10n)).to.equal(0n);
    expect(session.getDropAmount()).to.equal(0n);
    expect(rewardedAmount).to.equal(0n);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.RUNNING);
  });

  it("stores a credited reward when its same-priority accounting peer fails", async () => {
    faucetConfig.minDropAmount = 1;
    let accountedAmount = 0n;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "successful-accounting", (_session: FaucetSession, amount: bigint) => {
      accountedAmount += amount;
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "failed-accounting", () => {
      throw new Error("injected accounting failure");
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let rewardError: unknown;
    try {
      await session.addReward(37n);
    } catch(ex) {
      rewardError = ex;
    }

    expect(String(rewardError)).to.include("injected accounting failure");
    expect(accountedAmount).to.equal(37n);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
    expect(session.getDropAmount()).to.equal(37n);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.dropAmount).to.equal("37");
    expect(storedSession.data["failed.code"]).to.equal("REWARD_ACCOUNTING");
  });

  it("stores a credited reward when an accounting hook fails the session reentrantly", async () => {
    faucetConfig.minDropAmount = 1;
    let statusAfterFailureRequest: FaucetSessionStatus;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "fail-session", async (session: FaucetSession) => {
      await session.setSessionFailed("HOOK_FAILURE", "accounting hook failed the session");
      statusAfterFailureRequest = session.getSessionStatus();
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(await session.addReward(41n)).to.equal(41n);

    expect(statusAfterFailureRequest).to.equal(FaucetSessionStatus.RUNNING);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
    expect(session.getDropAmount()).to.equal(41n);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.dropAmount).to.equal("41");
    expect(storedSession.data["failed.code"]).to.equal("HOOK_FAILURE");
  });

  it("completes on the first rewarded hook without replacing or deadlocking the reward", async () => {
    faucetConfig.minDropAmount = 1;
    let statusAfterCompletionRequest: FaucetSessionStatus;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "complete-session", async (session: FaucetSession) => {
      await session.completeSession();
      statusAfterCompletionRequest = session.getSessionStatus();
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(await session.addReward(43n)).to.equal(43n);

    expect(statusAfterCompletionRequest).to.equal(FaucetSessionStatus.RUNNING);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.CLAIMABLE);
    expect(session.getDropAmount()).to.equal(43n);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.CLAIMABLE);
    expect(storedSession.dropAmount).to.equal("43");
  }).timeout(3000);

  it("includes a later reward when its accounting hook completes the session", async () => {
    faucetConfig.minDropAmount = 1;
    let rewardedCalls = 0;
    let statusAfterCompletionRequest: FaucetSessionStatus;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "complete-after-first", async (session: FaucetSession) => {
      rewardedCalls++;
      if(rewardedCalls === 2) {
        await session.completeSession();
        statusAfterCompletionRequest = session.getSessionStatus();
      }
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(await session.addReward(47n)).to.equal(47n);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.RUNNING);
    expect(await session.addReward(5n)).to.equal(5n);

    expect(statusAfterCompletionRequest).to.equal(FaucetSessionStatus.RUNNING);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.CLAIMABLE);
    expect(session.getDropAmount()).to.equal(52n);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.CLAIMABLE);
    expect(storedSession.dropAmount).to.equal("52");
  }).timeout(3000);

  it("stores a later credited reward when its accounting hook fails the session reentrantly", async () => {
    faucetConfig.minDropAmount = 1;
    let rewardedCalls = 0;
    let statusAfterFailureRequest: FaucetSessionStatus;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "fail-after-first", async (session: FaucetSession) => {
      rewardedCalls++;
      if(rewardedCalls === 2) {
        await session.setSessionFailed("LATER_HOOK_FAILURE", "later accounting hook failed the session");
        statusAfterFailureRequest = session.getSessionStatus();
      }
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(await session.addReward(53n)).to.equal(53n);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.RUNNING);
    expect(await session.addReward(7n)).to.equal(7n);

    expect(statusAfterFailureRequest).to.equal(FaucetSessionStatus.RUNNING);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
    expect(session.getDropAmount()).to.equal(60n);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.dropAmount).to.equal("60");
    expect(storedSession.data["failed.code"]).to.equal("LATER_HOOK_FAILURE");
  });

  it("lets a same-priority accounting failure override deferred reentrant completion", async () => {
    faucetConfig.minDropAmount = 1;
    let completionReturned: () => void;
    let peerEntered: () => void;
    let releasePeer: () => void;
    let completionFinished = new Promise<void>((resolve) => completionReturned = resolve);
    let peerStarted = new Promise<void>((resolve) => peerEntered = resolve);
    let peerGate = new Promise<void>((resolve) => releasePeer = resolve);
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "request-completion", async (session: FaucetSession) => {
      await session.completeSession();
      completionReturned();
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "failed-peer", async () => {
      peerEntered();
      await peerGate;
      throw new Error("later same-priority accounting failure");
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let disableSpies = spyOnRewardContextDisable(session);
    let rewardPromise = session.addReward(61n);
    await Promise.all([completionFinished, peerStarted]);
    let statusBeforePeerVerdict = session.getSessionStatus();
    expectRewardContextsDisabled(disableSpies, 0);
    releasePeer();
    let rewardError: unknown;
    try {
      await rewardPromise;
    } catch(ex) {
      rewardError = ex;
    }

    expect(statusBeforePeerVerdict).to.equal(FaucetSessionStatus.RUNNING);
    expect(String(rewardError)).to.include("later same-priority accounting failure");
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
    expect(session.getDropAmount()).to.equal(61n);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.dropAmount).to.equal("61");
    expect(storedSession.data["failed.code"]).to.equal("REWARD_ACCOUNTING");
    expectRewardContextsDisabled(disableSpies, 1);
  }).timeout(3000);

  it("credits a rewarded session before a concurrent terminal failure is persisted", async () => {
    faucetConfig.minDropAmount = 1;
    let releaseAccounting: () => void;
    let accountingStarted: () => void;
    let accountingGate = new Promise<void>((resolve) => releaseAccounting = resolve);
    let accountingEntered = new Promise<void>((resolve) => accountingStarted = resolve);
    let accountedAmount = 0n;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "delayed-accounting", async (_session: FaucetSession, amount: bigint) => {
      accountedAmount += amount;
      accountingStarted();
      await accountingGate;
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let rewardPromise = session.addReward(10n);
    await accountingEntered;
    let failurePromise = session.setSessionFailed("TEST_CLOSE", "test close during accounting");
    let failureSettled = false;
    failurePromise.then(() => failureSettled = true);
    await Promise.resolve();
    expect(failureSettled).to.equal(false, "terminal state bypassed rewarded accounting");

    releaseAccounting();
    expect(await rewardPromise).to.equal(10n);
    await failurePromise;

    expect(accountedAmount).to.equal(10n);
    expect(session.getDropAmount()).to.equal(10n);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.dropAmount).to.equal("10");
  });

  it("persists pending rewarded accounting before timing out a session", async () => {
    faucetConfig.minDropAmount = 1;
    faucetConfig.sessionTimeout = 60;
    let releaseAccounting: () => void;
    let accountingStarted: () => void;
    let accountingGate = new Promise<void>((resolve) => releaseAccounting = resolve);
    let accountingEntered = new Promise<void>((resolve) => accountingStarted = resolve);
    let accountedAmount = 0n;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "delayed-accounting", async (_session: FaucetSession, amount: bigint) => {
      accountedAmount += amount;
      accountingStarted();
      await accountingGate;
    });

    let sessionManager = ServiceManager.GetService(SessionManager);
    let session = await sessionManager.createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let rewardPromise = session.addReward(10n);
    await accountingEntered;
    faucetConfig.sessionTimeout = 0;
    let timeoutSettled = false;
    let timeoutPromise = sessionManager.processSessionTimeouts().then(() => timeoutSettled = true);
    await awaitSleepPromise(50, () => timeoutSettled);
    expect(timeoutSettled).to.equal(false, "timeout bypassed rewarded accounting");

    releaseAccounting();
    expect(await rewardPromise).to.equal(10n);
    await timeoutPromise;

    expect(accountedAmount).to.equal(10n);
    expect(session.getDropAmount()).to.equal(10n);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.dropAmount).to.equal("10");
    expect(storedSession.data["failed.code"]).to.equal("SESSION_TIMEOUT");
  });

  it("does not deadlock when a reward factor ends an unrewarded session", async () => {
    faucetConfig.minDropAmount = 1;
    let completionRequested: () => void;
    let completionRequest = new Promise<void>((resolve) => completionRequested = resolve);
    let statusAfterCompletionRequest: FaucetSessionStatus;
    let peerStatus: FaucetSessionStatus;
    let rewardedAmount = 0n;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "end-session", async (session: FaucetSession) => {
      await session.completeSession();
      statusAfterCompletionRequest = session.getSessionStatus();
      completionRequested();
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "observe-factor-batch", async (session: FaucetSession) => {
      await completionRequest;
      peerStatus = session.getSessionStatus();
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "accounting", (_session: FaucetSession, amount: bigint) => {
      rewardedAmount += amount;
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(await session.addReward(10n)).to.equal(0n);
    expect(statusAfterCompletionRequest).to.equal(FaucetSessionStatus.RUNNING);
    expect(peerStatus).to.equal(FaucetSessionStatus.RUNNING);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
    expect(session.getSessionData("failed.code")).to.equal("AMOUNT_TOO_LOW");
    expect(session.getDropAmount()).to.equal(0n);
    expect(rewardedAmount).to.equal(0n);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.dropAmount).to.equal("-1");
    expect(storedSession.data["failed.code"]).to.equal("AMOUNT_TOO_LOW");
  });

  it("completes a session only once when completion is requested concurrently", async () => {
    faucetConfig.minDropAmount = 1;
    let releaseRewardFactor: () => void;
    let factorStarted: () => void;
    let rewardFactorGate = new Promise<void>((resolve) => releaseRewardFactor = resolve);
    let rewardFactorEntered = new Promise<void>((resolve) => factorStarted = resolve);
    let completionHookCalls = 0;
    let reenteredCompletion: Promise<void>;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewardFactor, 100, "delayed-factor", async () => {
      factorStarted();
      await rewardFactorGate;
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionComplete, 100, "completion-count", (session: FaucetSession) => {
      completionHookCalls++;
      reenteredCompletion = session.completeSession();
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    session.resolveBlockingTask("test", "hold");
    let firstCompletion = session.completeSession();
    await rewardFactorEntered;
    let secondCompletion = session.completeSession();
    expect(secondCompletion).to.equal(firstCompletion);

    releaseRewardFactor();
    await Promise.all([firstCompletion, secondCompletion]);
    expect(session.getDropAmount()).to.equal(BigInt(faucetConfig.maxDropAmount));
    expect(completionHookCalls).to.equal(1);
    expect(reenteredCompletion).to.equal(firstCompletion, "completion promise was not installed before hook reentry");
  });

  it("cannot resurrect a session after durable timeout wins completion", async () => {
    faucetConfig.minDropAmount = 1;
    let releaseCompletion: () => void;
    let completionStarted: () => void;
    let completionGate = new Promise<void>((resolve) => releaseCompletion = resolve);
    let completionEntered = new Promise<void>((resolve) => completionStarted = resolve);
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionComplete, 100, "delayed-completion", async () => {
      completionStarted();
      await completionGate;
    });

    let session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    await session.addReward(10n);
    let completion = session.completeSession();
    await completionEntered;

    let database = ServiceManager.GetService(FaucetDatabase);
    let runningSnapshot = await database.getSession(session.getSessionId());
    expect(await database.tryTimeoutSession(runningSnapshot, 0)).to.equal(true);

    releaseCompletion();
    await completion;
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED);
    let storedSession = await database.getSession(session.getSessionId());
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.data["failed.code"]).to.equal("SESSION_TIMEOUT");
  });

  it("Create invalid session (amount too low)", async () => {
    faucetConfig.minDropAmount = 1000;
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.setDropAmount(500n);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    expect(testSession).to.not.equal(null, "createSession failed");
    expect(testSession.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED, "unexpected session status");
    expect(testSession.getSessionData("failed.code")).to.equal("AMOUNT_TOO_LOW", "unexpected error code");
  });

  it("Restore valid session", async () => {
    faucetConfig.sessionTimeout = 10;
    faucetConfig.minDropAmount = 1000;
    let now = Math.floor(new Date().getTime() / 1000);
    await ServiceManager.GetService(FaucetDatabase).updateSession({
      sessionId: "4e63566e-e482-46f3-bb91-da11f511aae5",
      status: FaucetSessionStatus.RUNNING,
      startTime: now,
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1337",
      remoteIP: "8.8.8.8",
      tasks: [],
      data: {"test.info": "test1"},
      claim: null,
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    await sessionManager.initialize();
    let testSession = sessionManager.getSession("4e63566e-e482-46f3-bb91-da11f511aae5", [FaucetSessionStatus.RUNNING]);
    expect(testSession).to.not.equal(undefined, "getSession failed");
    await testSession.tryProceedSession();
    expect(testSession.getRemoteIP()).to.equal("8.8.8.8", "unexpected remoteIP");
    expect(testSession.getTargetAddr()).to.equal("0x0000000000000000000000000000000000001337", "unexpected targetAddr");
    expect(Math.abs(testSession.getStartTime() - now)).to.be.lessThan(2, "unexpected startTime");
    expect(testSession.getBlockingTasks().length).to.equal(0, "unexpected blockingTasks");
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(testSession.getDropAmount()).to.equal(1337n, "unexpected drop amount");
    testSession.setSessionModuleRef("test.info", "info1234");
    expect(testSession.getSessionModuleRef("test.info")).to.equal("info1234", "unexpected getSessionModuleRef result");
  });

  it("Restore invalid session (timed out)", async () => {
    faucetConfig.sessionTimeout = 10;
    faucetConfig.minDropAmount = 1000;
    let now = Math.floor(new Date().getTime() / 1000);
    await ServiceManager.GetService(FaucetDatabase).updateSession({
      sessionId: "4e63566e-e482-46f3-bb91-da11f511aae6",
      status: FaucetSessionStatus.RUNNING,
      startTime: now - 60,
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1337",
      remoteIP: "8.8.8.8",
      tasks: [],
      data: {},
      claim: null,
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    await sessionManager.initialize();
    let testSession = sessionManager.getSession("4e63566e-e482-46f3-bb91-da11f511aae6", [FaucetSessionStatus.RUNNING]);
    expect(testSession).to.not.equal(undefined, "getSession failed");
    await testSession.tryProceedSession();
    let sessionData = await sessionManager.getSessionData("4e63566e-e482-46f3-bb91-da11f511aae6");
    expect(sessionData).to.not.equal(null, "getSessionData failed");
    expect(sessionData.status).to.equal(FaucetSessionStatus.FAILED, "unexpected session status");
    expect(sessionData.data["failed.code"]).to.equal("SESSION_TIMEOUT", "unexpected error code");
  });

  it("Check session task handling ", async () => {
    faucetConfig.minDropAmount = 1000;
    let changeAddrCalled = 0;
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test1", 1);
      session.addBlockingTask("test", "test2", 10);
    });
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionIpChange, 100, "test-task", (session: FaucetSession) => {
      changeAddrCalled++;
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    expect(testSession).to.not.equal(null, "createSession failed");
    expect(testSession.getBlockingTasks().length).to.equal(2, "unexpected blockingTasks");
    expect(testSession.getSessionStatus()).to.equal(FaucetSessionStatus.RUNNING, "unexpected session status");
    let error: FaucetError | null = null;
    try {
      testSession.setTargetAddr("0x0000000000000000000000000000000000001338");
    } catch(ex) {
      error = ex;
    }
    expect(error && error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("INVALID_STATE", "unexpected error code");
    await testSession.updateRemoteIP("::ffff:8.8.8.8");
    expect(changeAddrCalled).to.equal(0, "SessionIpChange for non-changed ip");
    await testSession.updateRemoteIP("8.8.4.4");
    expect(changeAddrCalled).to.equal(1, "no SessionIpChange for changed ip");
    expect(testSession.getRemoteIP()).to.equal("8.8.4.4", "unexpected remoteIP");
    testSession.setDropAmount(0n);
    expect(testSession.getDropAmount()).to.equal(0n, "unexpected drop amount");
    await testSession.addReward(1000n);
    testSession.resolveBlockingTask("test", "test1");
    expect(testSession.getBlockingTasks().length).to.equal(1, "unexpected blockingTasks count after resolving first task");
    testSession.resolveBlockingTask("test", "test2");
    expect(testSession.getBlockingTasks().length).to.equal(0, "unexpected blockingTasks count after resolving second task");
    await awaitSleepPromise(4000, () => testSession.getSessionStatus() === FaucetSessionStatus.CLAIMABLE);
    expect(testSession.getSessionStatus()).to.equal(FaucetSessionStatus.CLAIMABLE, "unexpected session status");
  }).timeout(5000);

  it("Check invalid session property changes", async () => {
    faucetConfig.minDropAmount = 1000;
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test1", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    expect(testSession).to.not.equal(null, "createSession failed");
    expect(testSession.getRemoteIP()).to.equal("8.8.8.8", "unexpected remoteIP");
    await testSession.subPenalty(1000n);
    expect(testSession.getDropAmount()).to.equal(0n, "unexpected drop amount after subPenalty from initial balance");
    await testSession.addReward(50n);
    testSession.resolveBlockingTask("test", "test1");
    await testSession.tryProceedSession(); // should fail with 0 balance
    expect(testSession.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED, "unexpected session status");
    await testSession.setDropAmount(1000n);
    expect(testSession.getDropAmount()).to.equal(50n, "unexpected drop amount after setDropAmount on failed session");
    await testSession.addReward(1000n);
    expect(testSession.getDropAmount()).to.equal(50n, "unexpected drop amount after addReward on failed session");
    await testSession.subPenalty(1000n);
    expect(testSession.getDropAmount()).to.equal(50n, "unexpected drop amount after subPenalty on failed session");
    let sessionInfo = await testSession.getSessionInfo();
    expect(sessionInfo.session).to.equal(testSession.getSessionId(), "invalid sessioninfo: id mismatch");
    expect(sessionInfo.balance).to.equal(testSession.getDropAmount().toString(), "invalid sessioninfo: balance mismatch");
    expect(sessionInfo.failedCode).to.equal("AMOUNT_TOO_LOW", "invalid sessioninfo: failedCode mismatch");
  });

  it("Check invalid balance change on failed session", async () => {
    faucetConfig.minDropAmount = 1000;
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test1", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    expect(testSession).to.not.equal(null, "createSession failed");
    expect(testSession.getRemoteIP()).to.equal("8.8.8.8", "unexpected remoteIP");
    await testSession.setSessionFailed("TEST_ERROR", "test");
    testSession.setDropAmount(1000n);
    expect(testSession.getDropAmount()).to.equal(0n, "unexpected drop amount after setDropAmount on failed session");
  });

  it("Check SessionManager: get session data", async () => {
    faucetConfig.minDropAmount = 1000;
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test1", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    expect(testSession).to.not.equal(null, "createSession failed");
    expect(sessionManager.getSession(testSession.getSessionId(), [FaucetSessionStatus.UNKNOWN])).to.equal(null, "unexpected getSession result for non-matching state");
    expect(sessionManager.getSession("4e63566e-e482-46f3-bb91-da11f511aae0", [FaucetSessionStatus.UNKNOWN])).to.equal(undefined, "unexpected getSession result for unknown session");
    expect(await sessionManager.getSessionData(testSession.getSessionId())).to.not.equal(null, "unexpected getSessionData result for known session");
    expect(await sessionManager.getSessionData("4e63566e-e482-46f3-bb91-da11f511aae0")).to.equal(null, "unexpected getSessionData result for unknown session");
    expect(sessionManager.getActiveSessions().length).to.equal(1, "unexpected getActiveSessions result count");
  });

  it("Check SessionManager: getUnclaimedBalance", async () => {
    faucetConfig.minDropAmount = 1000;
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test1", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    await testSession.addReward(1000n);
    expect(await sessionManager.getUnclaimedBalance()).to.equal(1000n, "unexpected getUnclaimedBalance result");
  });

  it("Check SessionManager: session timeout processing", async () => {
    faucetConfig.sessionTimeout = 10;
    faucetConfig.minDropAmount = 1000;
    let now = Math.floor(new Date().getTime() / 1000);
    await ServiceManager.GetService(FaucetDatabase).updateSession({
      sessionId: "4e63566e-e482-46f3-bb91-da11f511ab01",
      status: FaucetSessionStatus.RUNNING,
      startTime: now - 60,
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1337",
      remoteIP: "8.8.8.8",
      tasks: [],
      data: {},
      claim: null,
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    await sessionManager.initialize();
    await ServiceManager.GetService(FaucetDatabase).updateSession({
      sessionId: "4e63566e-e482-46f3-bb91-da11f511ab02",
      status: FaucetSessionStatus.RUNNING,
      startTime: now - 60,
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1337",
      remoteIP: "8.8.8.8",
      tasks: [],
      data: {},
      claim: null,
    });
    await sessionManager.processSessionTimeouts();
    await sessionManager.saveAllSessions();
    let session1 = await sessionManager.getSessionData("4e63566e-e482-46f3-bb91-da11f511ab01");
    expect(session1).to.not.equal(null, "getSessionData failed");
    expect(session1.status).to.equal(FaucetSessionStatus.FAILED, "unexpected session status");
    expect(session1.data["failed.code"]).to.equal("SESSION_TIMEOUT", "unexpected error code");
    let session2 = await sessionManager.getSessionData("4e63566e-e482-46f3-bb91-da11f511ab02");
    expect(session2).to.not.equal(null, "getSessionData failed");
    expect(session2.status).to.equal(FaucetSessionStatus.FAILED, "unexpected session status");
    expect(session2.data["failed.code"]).to.equal("SESSION_TIMEOUT", "unexpected error code");
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    await sessionManager.processSessionTimeouts();
    expect(testSession.getSessionStatus()).to.equal(FaucetSessionStatus.CLAIMABLE, "unexpected session status");
  });
});
