import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import YAML from 'yaml';
import { bindTestStubs, unbindTestStubs, loadDefaultTestConfig, awaitSleepPromise } from './common.js';
import { ServiceManager } from '../src/common/ServiceManager.js';
import { FaucetLogLevel, FaucetProcess } from '../src/common/FaucetProcess.js';
import { sleepPromise } from '../src/utils/PromiseUtils.js';
import { cliArgs, faucetConfig, getAppDataDir, loadFaucetConfig, setAppBasePath } from '../src/config/FaucetConfig.js';
import { FaucetWorkers } from '../src/common/FaucetWorker.js';
import { ICaptchaConfig } from '../src/modules/captcha/CaptchaConfig.js';
import { IGithubConfig } from '../src/modules/github/GithubConfig.js';
import { IPassportConfig } from '../src/modules/passport/PassportConfig.js';
import { FaucetHttpServer } from '../src/webserv/FaucetHttpServer.js';
import { EthClaimManager } from '../src/eth/EthClaimManager.js';
import { SessionManager } from '../src/session/SessionManager.js';
import { FaucetSession, FaucetSessionStatus } from '../src/session/FaucetSession.js';
import { ModuleHookAction, ModuleManager } from '../src/modules/ModuleManager.js';
import { FaucetDatabase } from '../src/db/FaucetDatabase.js';
import { PoWServer } from '../src/modules/pow/PoWServer.js';
import { EventEmitter } from 'node:events';


describe("Faucet Process", () => {
  let globalStubs;

  beforeEach(async () => {
    globalStubs = bindTestStubs({
      "process.exit": sinon.stub(process, "exit"),
    });
    loadDefaultTestConfig();
  });
  afterEach(async () => {
    ServiceManager.GetService(FaucetProcess).dispose();
    await unbindTestStubs(globalStubs);
  });

  function tmpFile(prefix?: string, suffix?: string, tmpdir?: string): string {
    prefix = (typeof prefix !== 'undefined') ? prefix : 'tmp.';
    suffix = (typeof suffix !== 'undefined') ? suffix : '';
    tmpdir = tmpdir ? tmpdir : os.tmpdir();
    return path.join(tmpdir, prefix + crypto.randomBytes(16).toString('hex') + suffix);
  }


  it("Check process event handler: uncaughtException", async () => {
    var originalException = process.listeners('uncaughtException').pop()
    process.removeListener('uncaughtException', originalException as any);
    after(() => {
      process.listeners('uncaughtException').push(originalException as any)
    });
    await ServiceManager.GetService(FaucetProcess).initialize();
    globalStubs["FaucetProcess.emitLog"] = sinon.stub(FaucetProcess.prototype, "emitLog");
    setTimeout(function() {
      throw new Error("test error");
    });
    await sleepPromise(10);
    expect(globalStubs["process.exit"].callCount).to.equal(1, "process.exit not called");
    expect(globalStubs["FaucetProcess.emitLog"].getCall(0).args[0]).to.equal("ERROR", "missing log entry");
    expect(globalStubs["FaucetProcess.emitLog"].getCall(0).args[1]).to.match(/unhandled exception/, "missing log entry");
  });

  it("Check process event handler: unhandledRejection (string reason)", async () => {
    await ServiceManager.GetService(FaucetProcess).initialize();
    globalStubs["FaucetProcess.emitLog"] = sinon.stub(FaucetProcess.prototype, "emitLog");
    new Promise((resolve, reject) => {
      setTimeout(function() {
        reject();
      });
    });
    await sleepPromise(10);
    expect(globalStubs["process.exit"].callCount).to.equal(0, "process.exit has been called");
    expect(globalStubs["FaucetProcess.emitLog"].getCall(0).args[0]).to.equal("ERROR", "missing log entry");
    expect(globalStubs["FaucetProcess.emitLog"].getCall(0).args[1]).to.match(/unhandled rejection/, "missing log entry");
  });

  it("Check process event handler: unhandledRejection (error reason)", async () => {
    await ServiceManager.GetService(FaucetProcess).initialize();
    await ServiceManager.GetService(FaucetProcess).initialize();
    globalStubs["FaucetProcess.emitLog"] = sinon.stub(FaucetProcess.prototype, "emitLog");
    new Promise((resolve, reject) => {
      setTimeout(function() {
        try {
          throw new Error("test error");
        } catch(ex) {
          reject(ex);
        }
      });
    });
    await sleepPromise(10);
    expect(globalStubs["process.exit"].callCount).to.equal(0, "process.exit has been called");
    expect(globalStubs["FaucetProcess.emitLog"].getCall(0).args[0]).to.equal("ERROR", "missing log entry");
    expect(globalStubs["FaucetProcess.emitLog"].getCall(0).args[1]).to.match(/unhandled rejection/, "missing log entry");
  });

  it("Check process event handler: SIGUSR1", async () => {
    await ServiceManager.GetService(FaucetProcess).initialize();
    globalStubs["FaucetProcess.emitLog"] = sinon.stub(FaucetProcess.prototype, "emitLog");
    let reloadFired = false;
    ServiceManager.GetService(FaucetProcess).on("reload", () => {
      reloadFired = true;
    });
    process.kill(process.pid, "SIGUSR1");
    await sleepPromise(10);
    expect(globalStubs["process.exit"].callCount).to.equal(0, "process.exit has been called");
    expect(reloadFired).to.equal(true, "missing reload event");
    expect(globalStubs["FaucetProcess.emitLog"].getCall(0).args[0]).to.equal("INFO", "missing log entry");
    expect(globalStubs["FaucetProcess.emitLog"].getCall(0).args[1]).to.match(/SIGURS1 signal/, "missing log entry");
  });

  it("Check process event handler: SIGINT", async () => {
    await ServiceManager.GetService(FaucetProcess).initialize();
    globalStubs["FaucetProcess.emitLog"] = sinon.stub(FaucetProcess.prototype, "emitLog");
    process.kill(process.pid, "SIGINT");
    await sleepPromise(10);
    expect(globalStubs["process.exit"].callCount).to.equal(1, "process.exit not called");
    expect(globalStubs["FaucetProcess.emitLog"].getCall(0).args[0]).to.equal("INFO", "missing log entry");
    expect(globalStubs["FaucetProcess.emitLog"].getCall(0).args[1]).to.match(/SIGINT signal/, "missing log entry");
  });

  it("Check process event handler: SIGQUIT", async () => {
    await ServiceManager.GetService(FaucetProcess).initialize();
    globalStubs["FaucetProcess.emitLog"] = sinon.stub(FaucetProcess.prototype, "emitLog");
    process.kill(process.pid, "SIGQUIT");
    await sleepPromise(10);
    expect(globalStubs["process.exit"].callCount).to.equal(1, "process.exit not called");
    expect(globalStubs["FaucetProcess.emitLog"].getCall(0).args[0]).to.equal("INFO", "missing log entry");
    expect(globalStubs["FaucetProcess.emitLog"].getCall(0).args[1]).to.match(/SIGQUIT signal/, "missing log entry");
  });

  it("Check process event handler: SIGTERM", async () => {
    await ServiceManager.GetService(FaucetProcess).initialize();
    globalStubs["FaucetProcess.emitLog"] = sinon.stub(FaucetProcess.prototype, "emitLog");
    process.kill(process.pid, "SIGTERM");
    await sleepPromise(10);
    expect(globalStubs["process.exit"].callCount).to.equal(1, "process.exit not called");
    expect(globalStubs["FaucetProcess.emitLog"].getCall(0).args[0]).to.equal("INFO", "missing log entry");
    expect(globalStubs["FaucetProcess.emitLog"].getCall(0).args[1]).to.match(/SIGTERM signal/, "missing log entry");
  });

  it("stops admission and drains durable state in dependency order", async () => {
    let steps: string[] = [];
    let rewardOperationsStopped = false;
    let disposeAllServices = ServiceManager.DisposeAllServices.bind(ServiceManager);
    let httpDispose = sinon.stub(FaucetHttpServer.prototype, "dispose").callsFake(async () => { steps.push("http"); });
    let rewardStop = sinon.stub(SessionManager.prototype, "stopRewardOperations").callsFake(() => {
      if(!rewardOperationsStopped) {
        rewardOperationsStopped = true;
        steps.push("stop-rewards");
      }
    });
    let claimDispose = sinon.stub(EthClaimManager.prototype, "dispose").callsFake(async () => { steps.push("claims"); });
    let sessionProducerDrain = sinon.stub(SessionManager.prototype, "drainRewardProducers").callsFake(async () => { steps.push("session-producers"); });
    let moduleProducerDrain = sinon.stub(ModuleManager.prototype, "quiesceRewardProducers").callsFake(async () => { steps.push("module-producers"); });
    let rewardDrain = sinon.stub(SessionManager.prototype, "drainRewardOperations").callsFake(async () => { steps.push("rewards"); });
    sinon.stub(SessionManager.prototype, "saveAllSessions").callsFake(async () => { steps.push("sessions"); });
    let moduleDispose = sinon.stub(ModuleManager.prototype, "dispose").callsFake(async () => { steps.push("modules"); });
    sinon.stub(ServiceManager, "DisposeAllServices").callsFake(async () => {
      steps.push("services");
      await disposeAllServices();
    });
    sinon.stub(FaucetDatabase.prototype, "closeDatabase").callsFake(async () => { steps.push("database"); });

    ServiceManager.GetService(FaucetHttpServer);
    ServiceManager.GetService(EthClaimManager);
    ServiceManager.GetService(ModuleManager);
    await ServiceManager.GetService(FaucetProcess).shutdown(0);

    expect(steps).to.deep.equal([
      "http",
      "stop-rewards",
      "claims",
      "module-producers",
      "session-producers",
      "rewards",
      "modules",
      "sessions",
      "services",
      "database",
    ]);
    expect(httpDispose.callCount).to.equal(1);
    expect(rewardStop.callCount).to.be.greaterThanOrEqual(1);
    expect(claimDispose.callCount).to.equal(1);
    expect(sessionProducerDrain.callCount).to.equal(1);
    expect(moduleProducerDrain.callCount).to.equal(1);
    expect(moduleDispose.callCount).to.equal(1);
    expect(rewardDrain.callCount).to.equal(1);
    expect(globalStubs["process.exit"].calledOnceWithExactly(0)).to.equal(true);
  });

  it("keeps modules alive until active reward hooks finish", async () => {
    let steps: string[] = [];
    let releaseHook: () => void;
    let hookStarted: () => void;
    let hookGate = new Promise<void>((resolve) => releaseHook = resolve);
    let hookEntered = new Promise<void>((resolve) => hookStarted = resolve);
    let disposeAllServices = ServiceManager.DisposeAllServices.bind(ServiceManager);

    sinon.stub(FaucetHttpServer.prototype, "dispose").callsFake(async () => { steps.push("http"); });
    sinon.stub(EthClaimManager.prototype, "dispose").callsFake(async () => { steps.push("claims"); });
    sinon.stub(ModuleManager.prototype, "dispose").callsFake(async () => { steps.push("modules"); });
    sinon.stub(SessionManager.prototype, "saveAllSessions").callsFake(async () => { steps.push("sessions"); });
    sinon.stub(ServiceManager, "DisposeAllServices").callsFake(async () => {
      steps.push("services");
      await disposeAllServices();
    });
    sinon.stub(FaucetDatabase.prototype, "closeDatabase").callsFake(async () => { steps.push("database"); });

    ServiceManager.GetService(FaucetHttpServer);
    ServiceManager.GetService(EthClaimManager);
    let moduleManager = ServiceManager.GetService(ModuleManager);
    let sessionManager = ServiceManager.GetService(SessionManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionRewarded, 100, "shutdown-order", async () => {
      steps.push("hook-start");
      hookStarted();
      await hookGate;
      steps.push("hook-mutation");
    });
    let accounting = sessionManager.runRewardOperation(async () => {
      await moduleManager.processActionHooks([], ModuleHookAction.SessionRewarded, [null, 1n]);
    });
    await hookEntered;

    let shutdown = ServiceManager.GetService(FaucetProcess).shutdown(0);
    await awaitSleepPromise(1000, () => steps.includes("claims"));
    expect(steps).to.deep.equal(["hook-start", "http", "claims"]);
    expect(sessionManager.canApplyRewards()).to.equal(false, "reward admission remained open");
    expect(steps).to.not.include("modules");
    expect(steps).to.not.include("sessions");
    expect(steps).to.not.include("database");
    expect(globalStubs["process.exit"].callCount).to.equal(0);

    releaseHook();
    await Promise.all([accounting, shutdown]);

    expect(steps).to.deep.equal(["hook-start", "http", "claims", "hook-mutation", "modules", "sessions", "services", "database"]);
    expect(globalStubs["process.exit"].calledOnceWithExactly(0)).to.equal(true);
  });

  it("drains accepted ordinary hook batches before stopping modules or the database", async () => {
    let steps: string[] = [];
    let releaseHook: () => void;
    let hookStarted: () => void;
    let hookGate = new Promise<void>((resolve) => releaseHook = resolve);
    let hookEntered = new Promise<void>((resolve) => hookStarted = resolve);
    let disposeAllServices = ServiceManager.DisposeAllServices.bind(ServiceManager);
    let lateAdmissionError: unknown;
    let lateAdmissionHookRan = false;

    sinon.stub(FaucetHttpServer.prototype, "dispose").callsFake(async () => { steps.push("http"); });
    sinon.stub(EthClaimManager.prototype, "dispose").callsFake(async () => { steps.push("claims"); });
    sinon.stub(ModuleManager.prototype, "dispose").callsFake(async () => { steps.push("modules"); });
    sinon.stub(SessionManager.prototype, "saveAllSessions").callsFake(async () => { steps.push("sessions"); });
    sinon.stub(ServiceManager, "DisposeAllServices").callsFake(async () => {
      steps.push("services");
      await disposeAllServices();
    });
    sinon.stub(FaucetDatabase.prototype, "closeDatabase").callsFake(async () => { steps.push("database"); });

    ServiceManager.GetService(FaucetHttpServer);
    ServiceManager.GetService(EthClaimManager);
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.ClientConfig, 10, "blocked-client-config", async () => {
      steps.push("hook-start");
      hookStarted();
      await hookGate;
      steps.push("hook-finish");
    });
    moduleManager.addActionHook(null, ModuleHookAction.ClientConfig, 20, "later-client-config", async () => {
      steps.push("later-hook");
      try {
        await moduleManager.processActionHooks([
          {prio: 1, hook: () => lateAdmissionHookRan = true},
        ], ModuleHookAction.ClientConfig, [{}]);
      } catch(error) {
        lateAdmissionError = error;
      }
    });
    let hookBatch = moduleManager.processActionHooks([], ModuleHookAction.ClientConfig, [{}]);
    await hookEntered;

    let shutdown = ServiceManager.GetService(FaucetProcess).shutdown(0);
    await awaitSleepPromise(100, () => steps.includes("claims"));
    let postCloseHookRan = false;
    let postCloseError: unknown;
    let postCloseSettled = false;
    let postClose = moduleManager.processActionHooks([
      {prio: 1, hook: () => postCloseHookRan = true},
    ], ModuleHookAction.ClientConfig, [{}]).then(
      () => postCloseSettled = true,
      (error) => {
        postCloseError = error;
        postCloseSettled = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();

    try {
      expect(steps).to.deep.equal(["hook-start", "http", "claims"]);
      expect(postCloseSettled).to.equal(true, "post-close hook admission remained open");
      expect(postCloseError).to.be.instanceOf(Error);
      expect((postCloseError as any).getCode?.()).to.equal("FAUCET_UNAVAILABLE");
      expect(postCloseHookRan).to.equal(false);
      expect(globalStubs["process.exit"].callCount).to.equal(0);
    } finally {
      releaseHook();
      await Promise.allSettled([hookBatch, postClose, shutdown]);
    }

    expect(steps).to.deep.equal([
      "hook-start",
      "http",
      "claims",
      "hook-finish",
      "later-hook",
      "modules",
      "sessions",
      "services",
      "database",
    ]);
    expect(lateAdmissionError).to.be.instanceOf(Error);
    expect((lateAdmissionError as any).getCode?.()).to.equal("FAUCET_UNAVAILABLE");
    expect(lateAdmissionHookRan).to.equal(false, "a captured hook admitted unbounded late ordinary work");
    expect(globalStubs["process.exit"].calledOnceWithExactly(0)).to.equal(true);
  });

  it("lets an accepted PoW abort finish SessionInfo during clean shutdown", async () => {
    let releasePoWClose: () => void;
    let powCloseEntered: () => void;
    const powCloseGate = new Promise<void>((resolve) => releasePoWClose = resolve);
    const powCloseStarted = new Promise<void>((resolve) => powCloseEntered = resolve);
    let sessionInfoCalls = 0;
    let disposeAllServices = ServiceManager.DisposeAllServices.bind(ServiceManager);

    sinon.stub(FaucetHttpServer.prototype, "dispose").resolves();
    sinon.stub(EthClaimManager.prototype, "dispose").resolves();
    sinon.stub(SessionManager.prototype, "saveAllSessions").resolves();
    sinon.stub(ServiceManager, "DisposeAllServices").callsFake(() => disposeAllServices());
    sinon.stub(FaucetDatabase.prototype, "closeDatabase").resolves();

    ServiceManager.GetService(FaucetHttpServer);
    ServiceManager.GetService(EthClaimManager);
    const moduleManager = ServiceManager.GetService(ModuleManager);
    const session = new FaucetSession(ServiceManager.GetService(SessionManager));
    sinon.stub(session, "getSessionId").returns("accepted-pow-abort");
    sinon.stub(session, "getSessionStatus").returns(FaucetSessionStatus.RUNNING);
    sinon.stub(session, "getStartTime").returns(1);
    sinon.stub(session, "getBlockingTasks").returns([]);
    sinon.stub(session, "getDropAmount").returns(0n);
    sinon.stub(session, "getTargetAddr").returns("0x0000000000000000000000000000000000001337");

    const powModule = {
      processPoWSessionClose: sinon.stub().callsFake(async () => {
        powCloseEntered();
        await powCloseGate;
      }),
    } as any;
    const childProcess = new EventEmitter() as any;
    childProcess.send = sinon.spy();
    childProcess.kill = sinon.spy();
    const server = new PoWServer(powModule, "accepted-abort-server", {childProcess} as any);
    (server as any).sessions[session.getSessionId()] = session;

    moduleManager.addActionHook(null, ModuleHookAction.SessionInfo, 10, "shutdown-session-info", (
      hookedSession: FaucetSession,
      moduleData: any,
    ) => {
      expect(hookedSession).to.equal(session);
      sessionInfoCalls++;
      moduleData.shutdownProbe = true;
    });
    moduleManager.addActionHook(null, ModuleHookAction.RewardProducerStop, 10, "shutdown-pow-server", () => {
      return server.shutdown();
    });

    childProcess.emit("message", {
      action: "pow-session-abort",
      sessionId: session.getSessionId(),
      type: "closed",
      reason: "client disconnected",
      dirtyProps: {},
    });
    await powCloseStarted;

    const shutdown = ServiceManager.GetService(FaucetProcess).shutdown(0);
    await awaitSleepPromise(100, () => childProcess.send.calledWith({action: "pow-shutdown"}));
    childProcess.emit("close");
    releasePoWClose();
    await shutdown;

    expect(sessionInfoCalls).to.equal(1, "accepted PoW cleanup lost ordinary hook admission");
    expect(powModule.processPoWSessionClose.calledOnceWithExactly(session)).to.equal(true);
    expect(globalStubs["process.exit"].calledOnceWithExactly(0)).to.equal(true);
  }).timeout(3000);

  it("closes session-start admission and drains an accepted full start before teardown", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    await database.initialize();
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    await sessionManager.initialize();
    let releaseStart: () => void;
    let startHookEntered: () => void;
    let startGate = new Promise<void>((resolve) => releaseStart = resolve);
    let startEntered = new Promise<void>((resolve) => startHookEntered = resolve);
    let startHookCalls = 0;
    let laterHookRan = false;
    let databaseClosed = false;
    let databaseWorkAfterClose = false;
    let disposeAllServices = ServiceManager.DisposeAllServices.bind(ServiceManager);

    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 10, "blocked-start", async () => {
      startHookCalls++;
      if(startHookCalls === 1) {
        startHookEntered();
        await startGate;
      }
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 20, "later-start", (session: FaucetSession) => {
      laterHookRan = true;
      session.addBlockingTask("test", "hold", 60);
    });
    let insertRunningSession = database.insertRunningSession.bind(database);
    sinon.stub(database, "insertRunningSession").callsFake(async (sessionData) => {
      if(databaseClosed)
        databaseWorkAfterClose = true;
      return await insertRunningSession(sessionData);
    });
    sinon.stub(FaucetHttpServer.prototype, "dispose").resolves();
    sinon.stub(EthClaimManager.prototype, "dispose").resolves();
    sinon.stub(ServiceManager, "DisposeAllServices").callsFake(() => disposeAllServices());
    sinon.stub(database, "closeDatabase").callsFake(async () => {
      databaseClosed = true;
    });

    ServiceManager.GetService(FaucetHttpServer);
    ServiceManager.GetService(EthClaimManager);
    let acceptedStart = sessionManager.createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    await startEntered;

    let shutdown = ServiceManager.GetService(FaucetProcess).shutdown(0);
    await awaitSleepPromise(100, () => !sessionManager.canApplyRewards());
    let postCloseStart = sessionManager.createSession("8.8.4.4", {
      addr: "0x0000000000000000000000000000000000007331",
    }).then(
      () => null,
      (error) => error,
    );
    await Promise.resolve();
    await Promise.resolve();

    try {
      expect(databaseClosed).to.equal(false, "shutdown closed the database before the accepted start drained");
      expect(startHookCalls).to.equal(1, "a post-close session entered start hooks");
      expect(laterHookRan).to.equal(false);
      expect(globalStubs["process.exit"].callCount).to.equal(0);
    } finally {
      releaseStart();
    }

    let [acceptedResult, postCloseError] = await Promise.all([
      acceptedStart,
      postCloseStart,
      shutdown,
    ]);
    expect(acceptedResult).to.be.instanceOf(FaucetSession);
    expect(postCloseError).to.be.instanceOf(Error);
    expect((postCloseError as any).getCode?.()).to.equal("FAUCET_UNAVAILABLE");
    expect(startHookCalls).to.equal(1);
    expect(laterHookRan).to.equal(true);
    expect(databaseWorkAfterClose).to.equal(false);
    expect(databaseClosed).to.equal(true);
    expect(globalStubs["process.exit"].calledOnceWithExactly(0)).to.equal(true);
    sinon.restore();
    await database.closeDatabase();
  }).timeout(5000);

  it("does not close the database while a terminal operation emitted during module shutdown is pending", async () => {
    faucetConfig.minDropAmount = 1;
    faucetConfig.sessionSaveTime = 3600;
    let database = ServiceManager.GetService(FaucetDatabase);
    await database.initialize();
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);

    let releaseCompletion: () => void;
    let completionStarted: () => void;
    let releasePostCloseCompletion: () => void;
    let completionGate = new Promise<void>((resolve) => releaseCompletion = resolve);
    let completionEntered = new Promise<void>((resolve) => completionStarted = resolve);
    let postCloseCompletionGate = new Promise<void>((resolve) => releasePostCloseCompletion = resolve);
    let postCloseCompletionStarted = false;
    let session: FaucetSession;
    let postCloseSession: FaucetSession;
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    moduleManager.addActionHook(null, ModuleHookAction.SessionComplete, 100, "late-terminal-gate", async (completedSession: FaucetSession) => {
      if(completedSession === session) {
        completionStarted();
        await completionGate;
      } else if(completedSession === postCloseSession) {
        postCloseCompletionStarted = true;
        await postCloseCompletionGate;
      }
    });

    session = await sessionManager.createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    await session.addReward(100n);
    await session.saveSession();
    postCloseSession = await sessionManager.createSession("8.8.4.4", {
      addr: "0x0000000000000000000000000000000000007331",
    });
    await postCloseSession.saveSession();

    sinon.stub(FaucetHttpServer.prototype, "dispose").resolves();
    sinon.stub(EthClaimManager.prototype, "dispose").resolves();
    let lateFailure: Promise<void>;
    let lateFailureSettled = false;
    sinon.stub(ModuleManager.prototype, "quiesceRewardProducers").callsFake(async () => {
      lateFailure = session.setSessionFailed("LATE_MODULE_FAILURE", "module emitted failure during shutdown");
      void lateFailure.then(
        () => lateFailureSettled = true,
        () => lateFailureSettled = true,
      );
    });
    let postCloseOperation: Promise<void>;
    let postCloseFailure: Promise<void>;
    let postCloseSettled = false;
    let postCloseOperationRan = false;
    let moduleDisposeStarted: () => void;
    let moduleDisposeEntered = new Promise<void>((resolve) => moduleDisposeStarted = resolve);
    sinon.stub(ModuleManager.prototype, "dispose").callsFake(async () => {
      moduleDisposeStarted();
      postCloseFailure = postCloseSession.setSessionFailed(
        "POST_CLOSE_MODULE_FAILURE",
        "module emitted failure after terminal admission closed",
      );
      postCloseOperation = sessionManager.runRewardOperation(async () => {
        postCloseOperationRan = true;
      });
      await Promise.allSettled([postCloseFailure, postCloseOperation]);
      postCloseSettled = true;
    });
    sinon.stub(ServiceManager, "DisposeAllServices").resolves();
    let databaseCloseStarted = false;
    sinon.stub(FaucetDatabase.prototype, "closeDatabase").callsFake(async () => {
      databaseCloseStarted = true;
    });

    ServiceManager.GetService(FaucetHttpServer);
    ServiceManager.GetService(EthClaimManager);
    let shutdown = ServiceManager.GetService(FaucetProcess).shutdown(0);
    await completionEntered;
    await awaitSleepPromise(100, () => databaseCloseStarted);

    let databaseClosedWhileTerminalPending = databaseCloseStarted;
    releaseCompletion();
    await moduleDisposeEntered;
    await awaitSleepPromise(100, () => postCloseSettled || postCloseCompletionStarted);
    let postCloseCompletionRan = postCloseCompletionStarted;
    releasePostCloseCompletion();
    await Promise.allSettled([lateFailure, postCloseFailure, postCloseOperation, shutdown]);
    let storedSession = await database.getSession(session.getSessionId());
    let storedPostCloseSession = await database.getSession(postCloseSession.getSessionId());
    sinon.restore();
    await ServiceManager.DisposeAllServices();
    await database.dropAllTables();
    await database.closeDatabase();

    expect(databaseClosedWhileTerminalPending).to.equal(false, "shutdown closed the database before the terminal queue drained");
    expect(lateFailureSettled).to.equal(true);
    expect(postCloseSettled).to.equal(true, "post-close reward operation did not settle before database close");
    expect(postCloseCompletionRan).to.equal(false, "post-close terminal work entered session completion hooks");
    expect(postCloseOperationRan).to.equal(false, "reward operation admission reopened after the final drain");
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(storedSession.data["failed.code"]).to.equal("LATE_MODULE_FAILURE");
    expect(storedPostCloseSession.status).to.equal(FaucetSessionStatus.RUNNING);
    expect(storedPostCloseSession.data["failed.code"]).to.equal(undefined);
  }).timeout(5000);

  it("waits for every active session save after one fails", async () => {
    let steps: string[] = [];
    let releasePendingSave: () => void;
    let pendingSaveStarted: () => void;
    let pendingSaveGate = new Promise<void>((resolve) => releasePendingSave = resolve);
    let pendingSaveEntered = new Promise<void>((resolve) => pendingSaveStarted = resolve);
    let disposeAllServices = ServiceManager.DisposeAllServices.bind(ServiceManager);
    let saveFailure = new Error("first session save failed");

    sinon.stub(FaucetHttpServer.prototype, "dispose").callsFake(async () => { steps.push("http"); });
    sinon.stub(EthClaimManager.prototype, "dispose").callsFake(async () => { steps.push("claims"); });
    sinon.stub(SessionManager.prototype, "drainRewardOperations").callsFake(async () => { steps.push("rewards"); });
    sinon.stub(ModuleManager.prototype, "dispose").callsFake(async () => { steps.push("modules"); });
    sinon.stub(ServiceManager, "DisposeAllServices").callsFake(async () => {
      steps.push("services");
      await disposeAllServices();
    });
    sinon.stub(FaucetDatabase.prototype, "closeDatabase").callsFake(async () => { steps.push("database"); });

    ServiceManager.GetService(FaucetHttpServer);
    ServiceManager.GetService(EthClaimManager);
    ServiceManager.GetService(ModuleManager);
    let sessionManager = ServiceManager.GetService(SessionManager);
    let failedSession = new FaucetSession(sessionManager);
    sinon.stub(failedSession, "getSessionId").returns("failed-save");
    sinon.stub(failedSession, "getSessionStatus").returns(FaucetSessionStatus.RUNNING);
    sinon.stub(failedSession, "saveSession").callsFake(async () => {
      steps.push("save-failed");
      throw saveFailure;
    });
    sessionManager.notifySessionUpdate(failedSession);

    let pendingSession = new FaucetSession(sessionManager);
    sinon.stub(pendingSession, "getSessionId").returns("pending-save");
    sinon.stub(pendingSession, "getSessionStatus").returns(FaucetSessionStatus.RUNNING);
    sinon.stub(pendingSession, "saveSession").callsFake(async () => {
      steps.push("save-pending");
      pendingSaveStarted();
      await pendingSaveGate;
      steps.push("save-finished");
    });
    sessionManager.notifySessionUpdate(pendingSession);

    let faucetProcess = ServiceManager.GetService(FaucetProcess);
    let emitLog = sinon.stub(faucetProcess, "emitLog");
    let shutdown = faucetProcess.shutdown(0);
    await pendingSaveEntered;
    await awaitSleepPromise(100, () => steps.includes("services"));

    try {
      expect(steps).to.deep.equal(["http", "claims", "rewards", "modules", "save-failed", "save-pending"]);
      expect(globalStubs["process.exit"].callCount).to.equal(0);
    } finally {
      releasePendingSave();
      await shutdown;
    }

    expect(steps).to.deep.equal(["http", "claims", "rewards", "modules", "save-failed", "save-pending", "save-finished", "services", "database"]);
    expect(emitLog.calledWith(
      FaucetLogLevel.ERROR,
      "Shutdown could not save active sessions: Error: " + saveFailure.message,
    )).to.equal(true);
    expect(globalStubs["process.exit"].calledOnceWithExactly(1)).to.equal(true);
  });

  it("continues shutdown after a cleanup and configured log-file failure", async () => {
    let steps: string[] = [];
    let rewardOperationsStopped = false;
    let disposeAllServices = ServiceManager.DisposeAllServices.bind(ServiceManager);
    let logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "hyperfaucet-log-failure-"));
    faucetConfig.faucetLogFile = logDirectory;

    let consoleLog = sinon.stub(console, "log").throws(new Error("stdout unavailable"));
    let consoleError = sinon.stub(console, "error").throws(new Error("stderr unavailable"));
    sinon.stub(FaucetHttpServer.prototype, "dispose").callsFake(async () => {
      steps.push("http");
      throw new Error("HTTP shutdown failed");
    });
    sinon.stub(SessionManager.prototype, "stopRewardOperations").callsFake(() => {
      if(!rewardOperationsStopped) {
        rewardOperationsStopped = true;
        steps.push("stop-rewards");
      }
    });
    sinon.stub(EthClaimManager.prototype, "dispose").callsFake(async () => { steps.push("claims"); });
    sinon.stub(SessionManager.prototype, "drainRewardProducers").callsFake(async () => { steps.push("session-producers"); });
    sinon.stub(ModuleManager.prototype, "quiesceRewardProducers").callsFake(async () => { steps.push("module-producers"); });
    sinon.stub(ModuleManager.prototype, "dispose").callsFake(async () => { steps.push("modules"); });
    sinon.stub(SessionManager.prototype, "drainRewardOperations").callsFake(async () => { steps.push("rewards"); });
    sinon.stub(SessionManager.prototype, "saveAllSessions").callsFake(async () => { steps.push("sessions"); });
    sinon.stub(ServiceManager, "DisposeAllServices").callsFake(async () => {
      steps.push("services");
      await disposeAllServices();
    });
    sinon.stub(FaucetDatabase.prototype, "closeDatabase").callsFake(async () => { steps.push("database"); });

    ServiceManager.GetService(FaucetHttpServer);
    ServiceManager.GetService(EthClaimManager);
    ServiceManager.GetService(ModuleManager);
    let faucetProcess = ServiceManager.GetService(FaucetProcess);
    faucetProcess.hideLogOutput = false;

    try {
      await faucetProcess.shutdown(0);
    } finally {
      fs.rmSync(logDirectory, { recursive: true, force: true });
    }

    expect(steps).to.deep.equal([
      "http",
      "stop-rewards",
      "claims",
      "module-producers",
      "session-producers",
      "rewards",
      "modules",
      "sessions",
      "services",
      "database",
    ]);
    expect(globalStubs["process.exit"].calledOnceWithExactly(1)).to.equal(true);
    expect(consoleLog.calledOnce).to.equal(true);
    expect(consoleError.callCount).to.equal(2);
    expect(consoleError.firstCall.args[0]).to.contain("HTTP shutdown failed");
  });

  it("Check logging: stdout", async () => {
    let faucetProcess = ServiceManager.GetService(FaucetProcess);
    await faucetProcess.initialize();
    faucetProcess.hideLogOutput = false;
    globalStubs["console.log"] = sinon.stub(console, "log");
    faucetProcess.emitLog(FaucetLogLevel.INFO, "test log message");
    expect(globalStubs["console.log"].getCall(0).args[0]).to.match(/test log message/, "missing console.log call");
  });

  it("Check logging: file", async () => {
    faucetConfig.faucetLogFile = tmpFile("powfaucet-", "-log.txt");
    let faucetProcess = ServiceManager.GetService(FaucetProcess);
    await faucetProcess.initialize();
    faucetProcess.emitLog(FaucetLogLevel.INFO, "test log message");
    expect(fs.existsSync(faucetConfig.faucetLogFile)).to.equal(true, "log file not found");
    let logData = fs.readFileSync(faucetConfig.faucetLogFile, "utf8");
    expect(logData).to.match(/test log message/, "missing console.log call");
    fs.unlinkSync(faucetConfig.faucetLogFile);
  });

  it("falls back to one bounded stderr record when configured file logging fails", async () => {
    let logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "hyperfaucet-log-failure-\n"));
    faucetConfig.faucetLogFile = logDirectory;
    let faucetProcess = ServiceManager.GetService(FaucetProcess);
    faucetProcess.hideLogOutput = false;
    let consoleLog = sinon.stub(console, "log");
    let consoleError = sinon.stub(console, "error").callsFake(() => {
      throw new Error("stderr unavailable");
    });

    try {
      expect(() => faucetProcess.emitLog(FaucetLogLevel.ERROR, "test\nmessage" + "x".repeat(5000))).to.not.throw();
    } finally {
      fs.rmSync(logDirectory, { recursive: true, force: true });
    }

    expect(consoleLog.calledOnce).to.equal(true, "normal console output changed");
    expect(consoleLog.firstCall.args[0]).to.contain("test\\nmessage");
    expect(consoleError.calledOnce).to.equal(true, "missing stderr fallback");
    expect(consoleError.firstCall.args[0]).to.contain("Log file write failed; stderr fallback only");
    expect(consoleError.firstCall.args[0]).to.not.match(/[\r\n\u2028\u2029]/);
    expect(consoleError.firstCall.args[0].length).to.be.at.most(4096);
  });

  it("Keeps file log records on one bounded line", async () => {
    faucetConfig.faucetLogFile = tmpFile("powfaucet-", "-log.txt");
    let faucetProcess = ServiceManager.GetService(FaucetProcess);
    await faucetProcess.initialize();
    faucetProcess.emitLog(FaucetLogLevel.INFO, "request failed\r\n2099-01-01 00:00:00  INFO  forged" + "x".repeat(5000));

    let logData = fs.readFileSync(faucetConfig.faucetLogFile, "utf8");
    expect(logData.trimEnd().split(/\r?\n/)).to.have.length(1, "log message created another record");
    expect(logData).to.contain("request failed\\n2099", "line break was not escaped");
    expect(logData).to.contain("[truncated]", "oversized log message was not marked");
    expect(logData.length).to.be.lessThan(4200, "log record exceeds its maximum size");
    fs.unlinkSync(faucetConfig.faucetLogFile);
  });

  it("Check pid file", async () => {
    faucetConfig.faucetPidFile = tmpFile("powfaucet-", "-pid.txt");
    let faucetProcess = ServiceManager.GetService(FaucetProcess);
    await faucetProcess.initialize();
    expect(fs.existsSync(faucetConfig.faucetPidFile)).to.equal(true, "pid file not found");
    let pidData = fs.readFileSync(faucetConfig.faucetPidFile, "utf8");
    expect(pidData).to.equal(process.pid.toString(), "pid does not match");
  });

  it("Check custom datadir flag", async () => {
    let oldDatadir = cliArgs["datadir"];
    let cwd = process.cwd();

    cliArgs["datadir"] = "/test/path"
    expect(getAppDataDir()).to.equal("/test/path", "invalid datadir (absolute path)");

    cliArgs["datadir"] = "test/path"
    expect(getAppDataDir()).to.equal(path.join(cwd, "test/path"), "invalid datadir (relative path)");

    cliArgs["datadir"] = "~app/"
    setAppBasePath("/test");
    expect(getAppDataDir()).to.equal("/test", "invalid datadir (~app path)");
    setAppBasePath(".");

    cliArgs["datadir"] = oldDatadir;
  });

  it("Check config creation & loading", async () => {
    let oldConfigArg = cliArgs["config"];
    let oldDatadir = cliArgs["datadir"];

    let tempdir = tmpFile("powfaucet-", "-data");
    fs.mkdirSync(tempdir);
    cliArgs["datadir"] = tempdir;

    // check create-config
    cliArgs["create-config"] = true;
    loadFaucetConfig();
    expect(globalStubs["process.exit"].callCount).to.equal(1, "process.exit not called");
    expect(fs.existsSync(path.join(tempdir, "faucet-config.yaml"))).to.equal(true, "new default config not created");
    let generatedConfig = YAML.parse(fs.readFileSync(path.join(tempdir, "faucet-config.yaml"), "utf8"));
    expect(generatedConfig.faucetSecret).to.match(/^[0-9a-f]{64}$/, "faucetSecret was not generated from 32 random bytes");
    expect(generatedConfig.pseudonymKey).to.match(/^[0-9a-f]{64}$/, "pseudonymKey was not generated from 32 random bytes");
    expect(generatedConfig.pseudonymKey).to.not.equal(generatedConfig.faucetSecret, "generated secrets were reused");
    delete cliArgs["create-config"];

    fs.renameSync(path.join(tempdir, "faucet-config.yaml"), path.join(tempdir, "test-config.yaml"))
    cliArgs["config"] = "test-config.yaml"
    loadFaucetConfig();

    cliArgs["config"] = oldConfigArg;
    cliArgs["datadir"] = oldDatadir;
    fs.rmSync(tempdir, { recursive: true, force: true });
  });

  it("Check config validation", async () => {
    let oldConfigArg = cliArgs["config"];
    let oldDatadir = cliArgs["datadir"];
    let envNames = [
      "FAUCET_SECRET",
      "FAUCET_PSEUDONYM_KEY",
      "FAUCET_STATUS_ADMIN_TOKEN",
      "FAUCET_ETH_WALLET_KEY",
      "FAUCET_CAPTCHA_SECRET",
      "FAUCET_GITHUB_APP_SECRET",
      "FAUCET_PASSPORT_SCORER_API_KEY",
    ];
    let oldEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    let tempdir = tmpFile("powfaucet-", "-data");

    try {
      envNames.forEach((name) => delete process.env[name]);
      fs.mkdirSync(tempdir);
      cliArgs["datadir"] = tempdir;

      fs.writeFileSync(path.join(tempdir, "bad-config.yaml"), "version: 1");
      cliArgs["config"] = "bad-config.yaml";
      expect(() => loadFaucetConfig()).to.throw("V1 configuration is incompatible");

      fs.writeFileSync(path.join(tempdir, "missing-secret.yaml"), "version: 2\nmodules: {}\n");
      cliArgs["config"] = "missing-secret.yaml";
      expect(() => loadFaucetConfig()).to.throw("faucetSecret is required");

      fs.writeFileSync(path.join(tempdir, "missing-pseudonym-key.yaml"), [
        "version: 2",
        `faucetSecret: ${"f".repeat(64)}`,
        "modules: {}",
      ].join("\n"));
      cliArgs["config"] = "missing-pseudonym-key.yaml";
      expect(() => loadFaucetConfig()).to.throw("pseudonymKey is required");

      fs.writeFileSync(path.join(tempdir, "placeholder-secret.yaml"), [
        "version: 2",
        "faucetSecret: REPLACE_WITH_32_BYTE_RANDOM_SECRET",
        `pseudonymKey: ${"p".repeat(64)}`,
        "modules: {}",
      ].join("\n"));
      cliArgs["config"] = "placeholder-secret.yaml";
      expect(() => loadFaucetConfig()).to.throw("faucetSecret still contains a placeholder");

      fs.writeFileSync(path.join(tempdir, "good-config.yaml"), [
        "version: 2",
        `faucetSecret: ${"f".repeat(64)}`,
        `pseudonymKey: ${"p".repeat(64)}`,
        "modules:",
        "  captcha:",
        "    enabled: false",
        "    secret: yaml-captcha-secret",
        "  github:",
        "    enabled: false",
        "    appSecret: yaml-github-secret",
        "  passport:",
        "    enabled: false",
        "    scorerApiKey: yaml-passport-api-key",
      ].join("\n"));
      cliArgs["config"] = "good-config.yaml";
      loadFaucetConfig();
      expect(faucetConfig.statusAdminToken).to.equal(null, "absent statusAdminToken should disable operator status");

      fs.writeFileSync(path.join(tempdir, "reused-secret.yaml"), [
        "version: 2",
        `faucetSecret: ${"r".repeat(64)}`,
        `pseudonymKey: ${"r".repeat(64)}`,
        "modules: {}",
      ].join("\n"));
      cliArgs["config"] = "reused-secret.yaml";
      expect(() => loadFaucetConfig()).to.throw("pseudonymKey must be different from faucetSecret");

      cliArgs["config"] = "good-config.yaml";
      process.env.FAUCET_SECRET = "REPLACE_WITH_32_BYTE_RANDOM_SECRET";
      expect(() => loadFaucetConfig()).to.throw("faucetSecret still contains a placeholder");

      process.env.FAUCET_SECRET = "short";
      expect(() => loadFaucetConfig()).to.throw("faucetSecret must contain at least 32 bytes");

      process.env.FAUCET_SECRET = "s".repeat(64);
      process.env.FAUCET_PSEUDONYM_KEY = "n".repeat(64);
      process.env.FAUCET_STATUS_ADMIN_TOKEN = "a".repeat(64);
      process.env.FAUCET_ETH_WALLET_KEY = "feedbeef12340000feedbeef12340000feedbeef12340000feedbeef12340000";
      process.env.FAUCET_CAPTCHA_SECRET = "env-captcha-secret";
      process.env.FAUCET_GITHUB_APP_SECRET = "env-github-secret";
      process.env.FAUCET_PASSPORT_SCORER_API_KEY = "env-passport-api-key";
      loadFaucetConfig();
      expect(faucetConfig.faucetSecret).to.equal(process.env.FAUCET_SECRET, "env override for faucetSecret not applied");
      expect(faucetConfig.pseudonymKey).to.equal(process.env.FAUCET_PSEUDONYM_KEY, "env override for pseudonymKey not applied");
      expect(faucetConfig.statusAdminToken).to.equal(process.env.FAUCET_STATUS_ADMIN_TOKEN, "env override for statusAdminToken not applied");
      expect(faucetConfig.ethWalletKey).to.equal(process.env.FAUCET_ETH_WALLET_KEY, "env override for ethWalletKey not applied");
      expect((faucetConfig.modules.captcha as ICaptchaConfig).secret).to.equal(process.env.FAUCET_CAPTCHA_SECRET, "env override for captcha secret not applied");
      expect((faucetConfig.modules.github as IGithubConfig).appSecret).to.equal(process.env.FAUCET_GITHUB_APP_SECRET, "env override for github app secret not applied");
      expect((faucetConfig.modules.passport as IPassportConfig).scorerApiKey).to.equal(process.env.FAUCET_PASSPORT_SCORER_API_KEY, "env override for passport scorer api key not applied");
    } finally {
      envNames.forEach((name) => {
        if(typeof oldEnv[name] === "string")
          process.env[name] = oldEnv[name];
        else
          delete process.env[name];
      });
      if(typeof oldConfigArg === "undefined")
        delete cliArgs["config"];
      else
        cliArgs["config"] = oldConfigArg;
      if(typeof oldDatadir === "undefined")
        delete cliArgs["datadir"];
      else
        cliArgs["datadir"] = oldDatadir;
      fs.rmSync(tempdir, { recursive: true, force: true });
    }
  });

  it("Check worker handling", async () => {
    let faucetWorkers = ServiceManager.GetService(FaucetWorkers);
    let workerFile = tmpFile("powfaucet-", "-worker.js");
    fs.writeFileSync(workerFile, [
      'const {parentPort, workerData} = require("node:worker_threads")',
      'setTimeout(function() {',
        'parentPort.postMessage({ action: "hello", data: workerData });',
      '}, 50);',
    ].join("\n"));

    globalStubs["FaucetWorkers.createWorker"].restore();
    faucetWorkers.initialize(workerFile);
    faucetWorkers.initialize("");

    try {
      faucetWorkers.createWorker("test2");
      expect(null).to.equal("error", "no error for unknown worker class");
    } catch(ex) {
    }

    let worker = faucetWorkers.createWorker("test");
    let workerMsg;
    worker.on("message", (msg) => {
      workerMsg = msg;
    });
    await awaitSleepPromise(500, () => !!workerMsg);

    expect(!!workerMsg).to.equal(true, "no response from worker");
    expect(workerMsg.action).to.equal("hello", "invalid response action from worker");
    expect(workerMsg.data.classKey).to.equal("test", "invalid response data from worker");

    let channel = new MessageChannel();
    let testMsg;
    channel.port1.onmessage = (msg) => {
      testMsg = msg.data;
    };

    FaucetWorkers.loadWorkerClass("test", channel.port2 as any);
    await awaitSleepPromise(500, () => !!testMsg);
    expect(!!testMsg).to.equal(true, "no response from test worker class");
    expect(testMsg.action).to.equal("test", "invalid response action from test worker class");
  });
  
});
