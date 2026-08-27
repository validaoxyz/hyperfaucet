import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { bindTestStubs, unbindTestStubs, loadDefaultTestConfig } from './common.js';
import { ServiceManager } from '../src/common/ServiceManager.js';
import { FaucetDatabase } from '../src/db/FaucetDatabase.js';
import { ModuleHookAction, ModuleManager } from '../src/modules/ModuleManager.js';
import { faucetConfig } from '../src/config/FaucetConfig.js';
import { MODULE_CLASSES } from '../src/modules/modules.js';
import { FaucetProcess } from '../src/common/FaucetProcess.js';
import { BaseModule } from '../src/modules/BaseModule.js';
import { FakeProvider } from './stubs/FakeProvider.js';
import { IEnsNameConfig } from '../src/modules/ensname/EnsNameConfig.js';
import { IMainnetWalletConfig } from '../src/modules/mainnet-wallet/MainnetWalletConfig.js';
import { IIPInfoConfig } from '../src/modules/ipinfo/IPInfoConfig.js';
import { ICaptchaConfig } from '../src/modules/captcha/CaptchaConfig.js';
import { IZupassConfig } from '../src/modules/zupass/ZupassConfig.js';
import { IFaucetOutflowConfig } from '../src/modules/faucet-outflow/FaucetOutflowConfig.js';
import { IConcurrencyLimitConfig } from '../src/modules/concurrency-limit/ConcurrencyLimitConfig.js';
import { SessionManager } from '../src/session/SessionManager.js';
import { FaucetSession, FaucetSessionStatus } from '../src/session/FaucetSession.js';
import { FaucetError } from '../src/common/FaucetError.js';

type ModuleConstructor = new (manager: ModuleManager, name: string) => BaseModule;
const moduleClasses: Record<string, ModuleConstructor> = MODULE_CLASSES;
const FAUCET_UNAVAILABLE_MESSAGE = "The faucet is temporarily unavailable. Please try again shortly.";

function expectUnavailableError(error: unknown): void {
  expect(error).to.be.instanceOf(FaucetError);
  if(!(error instanceof FaucetError))
    throw new Error("expected faucet unavailable error");
  expect(error.getCode()).to.equal("FAUCET_UNAVAILABLE");
  expect(error.message).to.equal(FAUCET_UNAVAILABLE_MESSAGE);
  expect(error).to.not.have.property("cause");
}

class LifecycleTestModule extends BaseModule {
  protected readonly moduleDefaultConfig = { enabled: true };
  public failStart = false;
  public failStop = false;
  public failActivation = false;
  public stopCalls = 0;
  public readonly startError = new Error("test start failure");
  public readonly stopError = new Error("test stop failure");
  public readonly activationError = new Error("test activation failure");

  protected override async startModule(): Promise<void> {
    this.moduleManager.addActionHook(this, ModuleHookAction.SessionStart, 100, "test-start", () => undefined);
    if(this.failStart)
      throw this.startError;
  }

  protected override async stopModule(): Promise<void> {
    this.stopCalls++;
    if(this.failStop)
      throw this.stopError;
  }

  protected override async onStateRestoreComplete(): Promise<void> {
    this.moduleManager.addActionHook(this, ModuleHookAction.SessionStart, 100, "test-activation", () => undefined);
    if(this.failActivation)
      throw this.activationError;
  }
}

class ReloadAdmissionTestModule extends BaseModule {
  protected readonly moduleDefaultConfig = { enabled: true };
  public reloadGate: Promise<void> | null = null;
  public failReload = false;
  public sessionStartCalls = 0;

  protected override async startModule(): Promise<void> {
    this.moduleManager.addActionHook(this, ModuleHookAction.SessionStart, 100, "reload-admission", () => {
      this.sessionStartCalls++;
    });
  }

  protected override async stopModule(): Promise<void> {}

  protected override async onConfigReload(): Promise<void> {
    if(this.failReload)
      throw new Error("test reload failure");
    if(this.reloadGate)
      await this.reloadGate;
  }
}


describe("Faucet Module Management", () => {
  let globalStubs;
  let fakeProvider;

  beforeEach(async function() {
    this.timeout(5000);
    globalStubs = bindTestStubs();
    fakeProvider = new FakeProvider();
    fakeProvider.injectResponse("net_version", "5");
    loadDefaultTestConfig();
    await ServiceManager.GetService(FaucetDatabase).initialize();
  });
  afterEach(async () => {
    let dbService = ServiceManager.GetService(FaucetDatabase);
    try {
      await ServiceManager.DisposeAllServices();
    } finally {
      try {
        await dbService.closeDatabase();
      } finally {
        await unbindTestStubs(globalStubs);
      }
    }
  });

  it("Load & unload modules", async () => {
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();

    let allModules = Object.keys(MODULE_CLASSES);
    allModules.forEach((module) => {
      faucetConfig.modules[module] = { enabled: true };
      switch(module) {
        case "concurrency-limit":
          (faucetConfig.modules[module] as IConcurrencyLimitConfig).concurrencyLimit = 1;
          break;
        case "ensname":
          (faucetConfig.modules[module] as IEnsNameConfig).rpcHost = fakeProvider;
          break;
        case "mainnet-wallet":
          (faucetConfig.modules[module] as IMainnetWalletConfig).rpcHost = fakeProvider;
          break;
        case "captcha":
          faucetConfig.modules[module] = {
            enabled: true,
            provider: "hcaptcha",
            siteKey: "test-site-key",
            secret: "test-secret",
            checkSessionStart: false,
            checkBalanceClaim: false,
            allowedHostnames: [],
          } as ICaptchaConfig;
          break;
        case "faucet-outflow":
          faucetConfig.modules[module] = {
            enabled: true,
            amount: "1000",
            duration: 60,
            lowerLimit: "-1000",
            upperLimit: "1000",
          } as IFaucetOutflowConfig;
          break;
        case "zupass":
          faucetConfig.modules[module] = {
            enabled: true,
            zupassUrl: "https://zupass.example/",
            event: {
              name: "test event",
              eventIds: [],
              productIds: [],
            },
            verify: {
              signer: [
                "05e0c4e8517758da3a26c80310ff2fe65b9f85d89dfc9c80e6d0b6477f88173e",
                "29ae64b615383a0ebb1bc37b3a642d82d37545f0f5b1444330300e4c4eedba3f",
              ],
            },
          } as IZupassConfig;
          break;
        
      }
    });
    faucetConfig.modules["inv_al_id"] = { enabled: true };
    ServiceManager.GetService(FaucetProcess).emit("reload");
    await moduleManager.getLoadingPromise();
    ServiceManager.GetService(FaucetProcess).emit("reload");
    await moduleManager.getLoadingPromise();
    allModules.forEach((module) => {
      let modObj = moduleManager.getModule<BaseModule>(module);
      expect(!!modObj).to.equal(true, "module not loaded: " + module);
      expect(modObj.isEnabled()).to.equal(true, "module not enabled: " + module);
      expect(modObj.getModuleName()).to.equal(module, "module name mismatch: " + module);
      faucetConfig.modules[module].enabled = false;
    });
    ServiceManager.GetService(FaucetProcess).emit("reload");
    await moduleManager.getLoadingPromise();
    allModules.forEach((module) => {
      let modObj = moduleManager.getModule<BaseModule>(module);
      expect(!!modObj).to.equal(false, "module still loaded: " + module);
    });
  }).timeout(5000);

  it("Module lifecycle", async () => {
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();

    faucetConfig.modules["captcha"] = {
      enabled: true,
      provider: "hcaptcha",
      siteKey: "test-site-key",
      secret: "test-secret",
      checkSessionStart: false,
      checkBalanceClaim: false,
      allowedHostnames: [],
    } as ICaptchaConfig;
    faucetConfig.modules["ipinfo"] = { enabled: true };
    ServiceManager.GetService(FaucetProcess).emit("reload");
    await moduleManager.getLoadingPromise();
    let captchaModule = moduleManager.getModule<BaseModule>("captcha");

    let error: Error | null = null;
    try {
      await captchaModule.enableModule();
    } catch(ex) {
      error = ex;
    }
    expect(!!error).to.equal(true, "no error thrown when enabling already enabled module");

    faucetConfig.modules["captcha"].enabled = false;
    ServiceManager.GetService(FaucetProcess).emit("reload");
    await moduleManager.getLoadingPromise();

    error = null;
    try {
      await captchaModule.disableModule();
    } catch(ex) {
      error = ex;
    }
    expect(!!error).to.equal(true, "no error thrown when disabling already disabled module");    
  });

  it("can recover a later reload after one reload fails", async () => {
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();

    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "http://ip.example/{ip}",
    } as IIPInfoConfig;
    ServiceManager.GetService(FaucetProcess).emit("reload");
    let firstError: unknown;
    try {
      await moduleManager.getLoadingPromise();
    } catch(ex) {
      firstError = ex;
    }
    expect(String(firstError)).to.include("HTTPS");

    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://ip.example/{ip}",
    } as IIPInfoConfig;
    ServiceManager.GetService(FaucetProcess).emit("reload");
    await moduleManager.getLoadingPromise();
    expect(moduleManager.getModule<BaseModule>("ipinfo")?.isEnabled()).to.equal(true);
  });

  it("fails session admission promptly while a serialized reload remains pending", async () => {
    const moduleName = "test-reload-admission";
    moduleClasses[moduleName] = ReloadAdmissionTestModule;
    faucetConfig.modules[moduleName] = { enabled: true };
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    let moduleManager: ModuleManager | undefined;
    let releaseReload: (() => void) | undefined;

    try {
      moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      const module = moduleManager.getModule<ReloadAdmissionTestModule>(moduleName);
      module.reloadGate = new Promise<void>((resolve) => {
        releaseReload = resolve;
      });
      faucetConfig.modules[moduleName] = { enabled: true };
      const sessionManager = ServiceManager.GetService(SessionManager);
      const beginAdmission = sinon.spy(sessionManager, "beginAdmission");

      ServiceManager.GetService(FaucetProcess).emit("reload");
      const reloadPromise = moduleManager.getLoadingPromise();
      let reloadSettled = false;
      void reloadPromise.then(
        () => { reloadSettled = true; },
        () => { reloadSettled = true; },
      );
      let admissionsSettled = false;
      const admissionResultsPromise = Promise.all(Array.from({length: 8}, () => {
        return sessionManager
          .createSession("8.8.8.8", {addr: "0x0000000000000000000000000000000000001337"})
          .then(() => null, (error: unknown) => error);
      })).then((results) => {
        admissionsSettled = true;
        return results;
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const pendingReloadObservation = {
        reloadSettled,
        admissionsSettled,
        beginAdmissionCalls: beginAdmission.callCount,
        sessionStartCalls: module.sessionStartCalls,
        unhandledRejections: unhandledRejections.slice(),
      };

      releaseReload?.();
      await reloadPromise;
      const admissionResults = await admissionResultsPromise;

      expect(pendingReloadObservation.reloadSettled).to.equal(false, "gated reload settled unexpectedly");
      expect(pendingReloadObservation.admissionsSettled).to.equal(true, "session admissions waited for reload");
      expect(pendingReloadObservation.beginAdmissionCalls).to.equal(0, "rejected sessions reserved admission state");
      expect(pendingReloadObservation.sessionStartCalls).to.equal(0, "rejected sessions ran SessionStart hooks");
      expect(pendingReloadObservation.unhandledRejections).to.deep.equal([]);
      admissionResults.forEach(expectUnavailableError);

      const recoveredSession = await sessionManager
        .createSession("8.8.4.4", {addr: "0x0000000000000000000000000000000000001338"});
      expect(recoveredSession).to.not.equal(undefined);
      expect(beginAdmission.callCount).to.equal(1);
      expect(module.sessionStartCalls).to.equal(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejections).to.deep.equal([]);
    } finally {
      releaseReload?.();
      await moduleManager?.getLoadingPromise().catch(() => undefined);
      process.removeListener("unhandledRejection", onUnhandledRejection);
      delete moduleClasses[moduleName];
      delete faucetConfig.modules[moduleName];
    }
  });

  it("fails session admission safely while the module manager is closed", async () => {
    const moduleManager = ServiceManager.GetService(ModuleManager);
    const sessionManager = ServiceManager.GetService(SessionManager);
    const beginAdmission = sinon.spy(sessionManager, "beginAdmission");
    let sessionStartCalls = 0;
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "closed-admission", () => {
      sessionStartCalls++;
    });
    const session = new FaucetSession(sessionManager);

    const admissionError = await session
      .startSession("8.8.8.8", {addr: "0x0000000000000000000000000000000000001337"})
      .then(() => null, (error: unknown) => error);

    expectUnavailableError(admissionError);
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.UNKNOWN);
    expect(session.getSessionId()).to.equal(undefined);
    expect(session.getStartTime()).to.equal(undefined);
    expect(session.getRemoteIP()).to.equal(undefined);
    expect(beginAdmission.callCount).to.equal(0);
    expect(sessionStartCalls).to.equal(0);
  });

  it("keeps session admission closed after a failed reload until recovery succeeds", async () => {
    const moduleName = "test-reload-recovery";
    moduleClasses[moduleName] = ReloadAdmissionTestModule;
    faucetConfig.modules[moduleName] = { enabled: true };

    try {
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let module = moduleManager.getModule<ReloadAdmissionTestModule>(moduleName);
      module.failReload = true;
      faucetConfig.modules[moduleName] = { enabled: true };

      ServiceManager.GetService(FaucetProcess).emit("reload");
      await moduleManager.getLoadingPromise().catch(() => undefined);
      const sessionManager = ServiceManager.GetService(SessionManager);
      const beginAdmission = sinon.spy(sessionManager, "beginAdmission");
      let failedAdmission = await sessionManager
        .createSession("8.8.8.8", {addr: "0x0000000000000000000000000000000000001337"})
        .then(() => null, (error) => error as unknown);
      expectUnavailableError(failedAdmission);
      expect(beginAdmission.callCount).to.equal(0);
      expect(module.sessionStartCalls).to.equal(0);

      module.failReload = false;
      faucetConfig.modules[moduleName] = { enabled: true };
      ServiceManager.GetService(FaucetProcess).emit("reload");
      await moduleManager.getLoadingPromise();
      let session = await sessionManager
        .createSession("8.8.4.4", {addr: "0x0000000000000000000000000000000000001338"});
      expect(session).to.not.equal(undefined);
      expect(beginAdmission.callCount).to.equal(1);
      expect(module.sessionStartCalls).to.equal(1);
    } finally {
      delete moduleClasses[moduleName];
      delete faucetConfig.modules[moduleName];
    }
  });

  it("observes a reload failure without emitting an unhandled rejection", async () => {
    const moduleName = "test-reload-rejection";
    moduleClasses[moduleName] = ReloadAdmissionTestModule;
    faucetConfig.modules[moduleName] = { enabled: true };
    let unhandledRejections: unknown[] = [];
    let onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let module = moduleManager.getModule<ReloadAdmissionTestModule>(moduleName);
      module.failReload = true;

      ServiceManager.GetService(FaucetProcess).emit("reload");
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejections).to.deep.equal([]);
      await moduleManager.getLoadingPromise().catch(() => undefined);

      module.failReload = false;
      ServiceManager.GetService(FaucetProcess).emit("reload");
      await moduleManager.getLoadingPromise();
    } finally {
      process.removeListener("unhandledRejection", onUnhandledRejection);
      delete moduleClasses[moduleName];
      delete faucetConfig.modules[moduleName];
    }
  });

  it("waits for every same-priority hook before propagating a fast failure", async () => {
    let moduleManager = new ModuleManager();
    let siblingStarted = false;
    let siblingFinished = false;
    let laterPriorityRan = false;
    let releaseSibling: () => void;
    let siblingGate = new Promise<void>((resolve) => {
      releaseSibling = resolve;
    });
    let fastFailure = new Error("fast hook failure");

    let hookPromise = moduleManager.processActionHooks([
      {prio: 10, hook: () => { throw fastFailure; }},
      {prio: 10, hook: async () => {
        siblingStarted = true;
        await siblingGate;
        siblingFinished = true;
      }},
      {prio: 20, hook: () => { laterPriorityRan = true; }},
    ], ModuleHookAction.SessionStart, []);
    let hookSettled = false;
    hookPromise.finally(() => {
      hookSettled = true;
    }).catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(siblingStarted).to.equal(true, "same-priority sibling was not invoked");
    expect(hookSettled).to.equal(false, "hook processing did not wait for same-priority sibling");
    expect(laterPriorityRan).to.equal(false, "later priority ran after a failure");

    releaseSibling();
    let hookError = await hookPromise.then(() => null, (error) => error as unknown);
    expect(hookError).to.equal(fastFailure);
    expect(siblingFinished).to.equal(true);
    expect(laterPriorityRan).to.equal(false);
  });

  it("reports same-priority hook failures in registration order", async () => {
    let moduleManager = new ModuleManager();
    let firstFailure = new Error("first hook failure");
    let secondFailure = new Error("second hook failure");

    let hookError = await moduleManager.processActionHooks([
      {prio: 10, hook: async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        throw firstFailure;
      }},
      {prio: 10, hook: () => { throw secondFailure; }},
    ], ModuleHookAction.SessionStart, []).then(() => null, (error) => error as unknown);

    expect(hookError).to.be.instanceOf(AggregateError);
    if(!(hookError instanceof AggregateError))
      throw new Error("expected aggregate hook failure");
    expect(hookError.errors).to.deep.equal([firstFailure, secondFailure]);
  });

  it("keeps a failed start cleanup-required when rollback also fails", async () => {
    let moduleManager = new ModuleManager();
    let module = new LifecycleTestModule(moduleManager, "start-failure");
    module.failStart = true;
    module.failStop = true;

    let enableError: unknown;
    try {
      await module.enableModule();
    } catch(ex) {
      enableError = ex;
    }

    expect(enableError).to.be.instanceOf(AggregateError);
    if(!(enableError instanceof AggregateError))
      throw new Error("expected aggregate start and rollback failure");
    expect(enableError.errors).to.deep.equal([module.startError, module.stopError]);
    expect(module.requiresCleanup()).to.equal(true);
    expect(module.isEnabled()).to.equal(true);
    expect(moduleManager.getActionHooks(ModuleHookAction.SessionStart)).to.deep.equal([]);

    let retryError: unknown;
    try {
      await module.enableModule();
    } catch(ex) {
      retryError = ex;
    }
    expect(String(retryError)).to.include("cleanup-required");

    module.failStop = false;
    await module.disableModule();
    expect(module.isEnabled()).to.equal(false);
    expect(module.stopCalls).to.equal(2);
  });

  it("requires cleanup and removes hooks when state-restore activation fails", async () => {
    let moduleManager = new ModuleManager();
    let module = new LifecycleTestModule(moduleManager, "activation-failure");
    module.failActivation = true;

    await module.enableModule();
    expect(moduleManager.getActionHooks(ModuleHookAction.SessionStart).map((hook) => hook.name)).to.deep.equal(["test-start"]);

    let activationError: unknown;
    try {
      await module.activateAfterStateRestore();
    } catch(ex) {
      activationError = ex;
    }

    expect(activationError).to.equal(module.activationError);
    expect(module.requiresCleanup()).to.equal(true);
    expect(module.isEnabled()).to.equal(true);
    expect(moduleManager.getActionHooks(ModuleHookAction.SessionStart)).to.deep.equal([]);

    await module.disableModule();
    expect(module.isEnabled()).to.equal(false);
  });

  it("fully rolls back a partial initialize before retrying", async () => {
    const stableName = "test-initialize-stable";
    const retryName = "test-initialize-retry";
    let stableStarts = 0;
    let retryStarts = 0;
    let failFirstRetryStart = true;

    class StableHookModule extends BaseModule {
      protected readonly moduleDefaultConfig = { enabled: true };

      protected override async startModule(): Promise<void> {
        stableStarts++;
        this.moduleManager.addActionHook(this, ModuleHookAction.SessionStart, 100, stableName, () => undefined);
      }

      protected override async stopModule(): Promise<void> {}
    }

    class RetryHookModule extends BaseModule {
      protected readonly moduleDefaultConfig = { enabled: true };

      protected override async startModule(): Promise<void> {
        retryStarts++;
        this.moduleManager.addActionHook(this, ModuleHookAction.SessionStart, 100, retryName, () => undefined);
        if(failFirstRetryStart) {
          failFirstRetryStart = false;
          throw new Error("test initialize failure");
        }
      }

      protected override async stopModule(): Promise<void> {}
    }

    moduleClasses[stableName] = StableHookModule;
    moduleClasses[retryName] = RetryHookModule;
    faucetConfig.modules[stableName] = { enabled: true };
    faucetConfig.modules[retryName] = { enabled: true };

    try {
      let moduleManager = ServiceManager.GetService(ModuleManager);
      let initializeError: unknown;
      try {
        await moduleManager.initialize();
      } catch(ex) {
        initializeError = ex;
      }

      expect(initializeError).to.be.instanceOf(AggregateError);
      expect(moduleManager.getModule(stableName)).to.equal(undefined);
      expect(moduleManager.getModule(retryName)).to.equal(undefined);
      expect(moduleManager.getActionHooks(ModuleHookAction.SessionStart)).to.deep.equal([]);

      await moduleManager.initialize();

      expect(stableStarts).to.equal(2);
      expect(retryStarts).to.equal(2);
      expect(moduleManager.getActionHooks(ModuleHookAction.SessionStart).map((hook) => hook.name)).to.deep.equal([
        stableName,
        retryName,
      ]);
    } finally {
      delete moduleClasses[stableName];
      delete moduleClasses[retryName];
      delete faucetConfig.modules[stableName];
      delete faucetConfig.modules[retryName];
    }
  });

  
});
