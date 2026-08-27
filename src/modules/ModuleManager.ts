import { FaucetLogLevel, FaucetProcess } from "../common/FaucetProcess.js";
import { FaucetError } from "../common/FaucetError.js";
import { ServiceManager } from "../common/ServiceManager.js";
import { faucetConfig } from "../config/FaucetConfig.js";
import { BaseModule } from "./BaseModule.js";
import { MODULE_CLASSES } from "./modules.js";

export enum ModuleHookAction {
  ClientConfig,
  SessionStart,
  SessionRestore,
  SessionInfo,
  SessionRewardFactor,
  SessionRewarded,
  SessionIpChange,
  SessionComplete,
  SessionClaim,
  SessionClaimed,
  SessionClose,
  RewardProducerStop,
}

export interface ModuleHookRegistration {
  prio: number;
  module: BaseModule;
  name: string;
  hook: Function;
}

interface ModuleFailure {
  moduleName: string;
  operation: string;
  error: unknown;
}

type ModuleAdmissionState =
  | {kind: "closed"}
  | {kind: "loading"}
  | {kind: "ready"}
  | {kind: "failed", error: unknown};

export class ModuleManager {
  private initialized: boolean;
  private loadedModules: {[module: string]: BaseModule} = {};
  private moduleHooks: {[action in ModuleHookAction]?: ModuleHookRegistration[]} = {};
  private loadingPromise: Promise<void> = Promise.resolve();
  private loadGeneration = 0;
  private admissionState: ModuleAdmissionState = {kind: "closed"};
  private stateRestoreReady = false;
  private rewardProducerQuiescence: Promise<void> | null = null;
  private ordinaryHookAdmissionOpen = true;
  private terminalHookAdmissionOpen = true;
  private hookOperations = new Set<Promise<void>>();
  private ordinaryHookOperations = new Set<Promise<void>>();
  private readonly reloadHandler = () => {
    if(!this.initialized)
      return;
    let reloadPromise = this.queueLoad(() => this.loadModules(), true);
    void reloadPromise.catch((ex) => {
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.ERROR, "Module reload failed: " + String(ex));
    });
  };

  public async initialize(): Promise<void> {
    if(this.initialized)
      throw "already initialized";
    if(Object.values(this.loadedModules).some((module) => module.requiresCleanup()))
      throw new Error("cannot initialize module manager while module cleanup is incomplete");

    this.initialized = true;
    this.moduleHooks = {};
    this.stateRestoreReady = false;
    this.rewardProducerQuiescence = null;
    this.ordinaryHookAdmissionOpen = true;
    this.terminalHookAdmissionOpen = true;
    try {
      await this.queueLoad(() => this.loadModules(), false);
      ServiceManager.GetService(FaucetProcess).addListener("reload", this.reloadHandler);
    } catch(loadError) {
      this.initialized = false;
      this.closeAdmission();
      this.closeHookAdmission();
      let rollbackFailures: ModuleFailure[] = [];
      for(let [moduleName, module] of Object.entries(this.loadedModules)) {
        try {
          if(module.isEnabled())
            await module.disableModule();
          delete this.loadedModules[moduleName];
        } catch(ex) {
          rollbackFailures.push({moduleName, operation: "roll back initialization", error: ex});
        }
      }
      this.loadingPromise = Promise.resolve();
      this.moduleHooks = {};
      this.stateRestoreReady = false;

      if(rollbackFailures.length > 0) {
        rollbackFailures.unshift({moduleName: "module-manager", operation: "initialize", error: loadError});
        this.throwFailures(rollbackFailures);
      }
      throw loadError;
    }
  }

  public async dispose(): Promise<void> {
    let failures: ModuleFailure[] = [];
    this.closeHookAdmission();
    if(this.initialized) {
      this.initialized = false;
      this.closeAdmission();
      ServiceManager.GetService(FaucetProcess).removeListener("reload", this.reloadHandler);
    }
    else {
      this.closeAdmission();
    }

    await this.drainHookOperations(this.hookOperations);
    try {
      await this.loadingPromise;
    } catch(ex) {
      failures.push({moduleName: "module-manager", operation: "finish pending load", error: ex});
    }
    this.loadingPromise = Promise.resolve();

    for(let [moduleName, module] of Object.entries(this.loadedModules)) {
      try {
        if(module.isEnabled())
          await module.disableModule();
        delete this.loadedModules[moduleName];
      } catch(ex) {
        failures.push({moduleName, operation: "stop", error: ex});
      }
    }
    this.moduleHooks = {};
    this.stateRestoreReady = false;

    this.throwFailures(failures);
  }

  public getLoadingPromise(): Promise<void> {
    return this.loadingPromise;
  }

  public quiesceRewardProducers(): Promise<void> {
    if(!this.rewardProducerQuiescence)
      this.rewardProducerQuiescence = this.performRewardProducerQuiescence();
    return this.rewardProducerQuiescence;
  }

  private async performRewardProducerQuiescence(): Promise<void> {
    let failures: ModuleFailure[] = [];
    if(this.initialized) {
      this.initialized = false;
      this.closeAdmission();
      ServiceManager.GetService(FaucetProcess).removeListener("reload", this.reloadHandler);
    }
    else {
      this.closeAdmission();
    }

    try {
      await this.loadingPromise;
    } catch(ex) {
      failures.push({moduleName: "module-manager", operation: "finish pending load", error: ex});
    }
    this.loadingPromise = Promise.resolve();

    try {
      await this.runActionHooks([], ModuleHookAction.RewardProducerStop, []);
    } catch(ex) {
      failures.push({moduleName: "module-manager", operation: "quiesce reward producers", error: ex});
    }
    this.ordinaryHookAdmissionOpen = false;
    await this.drainHookOperations(this.ordinaryHookOperations);
    this.throwFailures(failures);
  }

  public assertSessionAdmissionReady(): void {
    const state = this.admissionState;
    switch(state.kind) {
      case "ready":
        return;
      case "closed":
      case "loading":
      case "failed":
        throw new FaucetError(
          "FAUCET_UNAVAILABLE",
          "The faucet is temporarily unavailable. Please try again shortly.",
        );
      default: {
        const exhaustive: never = state;
        throw exhaustive;
      }
    }
  }

  public activateModulesAfterStateRestore(): Promise<void> {
    if(!this.initialized)
      return Promise.reject(new Error("cannot activate modules before the module manager is initialized"));

    this.stateRestoreReady = true;
    return this.queueLoad(() => this.activateLoadedModules(), true);
  }

  private queueLoad(operation: () => Promise<void>, recoverPreviousFailure: boolean): Promise<void> {
    let generation = ++this.loadGeneration;
    this.admissionState = {kind: "loading"};
    let previousLoad = recoverPreviousFailure
      ? this.loadingPromise.catch(() => undefined)
      : this.loadingPromise;
    let operationPromise = previousLoad.then(operation);
    let trackedPromise = operationPromise.then(
      () => {
        if(this.initialized && generation === this.loadGeneration)
          this.admissionState = {kind: "ready"};
      },
      (error) => {
        if(this.initialized && generation === this.loadGeneration)
          this.admissionState = {kind: "failed", error};
        throw error;
      },
    );
    this.loadingPromise = trackedPromise;
    return trackedPromise;
  }

  private closeAdmission(): void {
    this.loadGeneration++;
    this.admissionState = {kind: "closed"};
  }

  private closeHookAdmission(): void {
    this.ordinaryHookAdmissionOpen = false;
    this.terminalHookAdmissionOpen = false;
  }

  private async drainHookOperations(operations: Set<Promise<void>>): Promise<void> {
    while(operations.size > 0)
      await Promise.allSettled([...operations]);
  }

  private isTerminalHookAction(action: ModuleHookAction): boolean {
    return action === ModuleHookAction.SessionRewardFactor
      || action === ModuleHookAction.SessionRewarded
      || action === ModuleHookAction.SessionComplete;
  }

  private async loadModules(): Promise<void> {
    let loadedDict = Object.assign({}, this.loadedModules);
    let failures: ModuleFailure[] = [];
    for(let modName in faucetConfig.modules) {
      if(!faucetConfig.modules.hasOwnProperty(modName))
        continue;
      if(!faucetConfig.modules[modName].enabled)
        continue;
      
      let module: BaseModule
      if(!(module = loadedDict[modName])) {
        let modClass = MODULE_CLASSES[modName];
        if(!modClass) {
          ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.ERROR, "Cannot load module '" + modName + "': unknown module");
          continue;
        }
        module = this.loadedModules[modName] = new modClass(this, modName);
      }
      else {
        delete loadedDict[modName];
      }
      try {
        if(module.requiresCleanup())
          await module.disableModule();
        await module.setModuleConfig(faucetConfig.modules[modName]);
        if(!module.isEnabled()) {
          await module.enableModule();
          ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Enabled module: " + modName);
        }
        if(this.stateRestoreReady)
          await module.activateAfterStateRestore();
      } catch(ex) {
        failures.push({moduleName: modName, operation: module.isEnabled() ? "reload" : "start", error: ex});
      }
    }
    for(let modName in loadedDict) {
      let module = loadedDict[modName];
      try {
        if(module.isEnabled())
          await module.disableModule();
        delete this.loadedModules[modName];
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Disabled module: " + modName);
      } catch(ex) {
        failures.push({moduleName: modName, operation: "stop", error: ex});
      }
    }
    this.throwFailures(failures);
  }

  private async activateLoadedModules(): Promise<void> {
    let failures: ModuleFailure[] = [];
    for(let [moduleName, module] of Object.entries(this.loadedModules)) {
      if(!module.isEnabled() || module.requiresCleanup())
        continue;
      try {
        await module.activateAfterStateRestore();
      } catch(ex) {
        failures.push({moduleName, operation: "activate after state restore", error: ex});
      }
    }
    this.throwFailures(failures);
  }

  private throwFailures(failures: ModuleFailure[]): void {
    if(failures.length === 0)
      return;
    let details = failures.map((failure) => {
      return "module '" + failure.moduleName + "' could not " + failure.operation + ": " + String(failure.error);
    }).join("; ");
    throw new AggregateError(failures.map((failure) => failure.error), details);
  }

  public getModule<TModule extends BaseModule = BaseModule>(moduleName: string): TModule {
    return this.loadedModules[moduleName] as TModule;
  }

  public addActionHook(module: BaseModule | null, action: ModuleHookAction, priority: number, name: string, hook: Function) {
    let hookList = this.moduleHooks[action];
    if(!hookList)
      hookList = this.moduleHooks[action] = [];
    
    let hookReg: ModuleHookRegistration = {
      prio: priority,
      module: module,
      name: name,
      hook: hook,
    };

    let insertIdx = null;
    for(let i = 0; i < hookList.length; i++) {
      if(hookList[i].prio > priority) {
        insertIdx = i;
        break;
      }
    }
    if(insertIdx !== null) {
      hookList.splice(insertIdx, 0, hookReg);
    }
    else {
      hookList.push(hookReg);
    }
  }

  public removeActionHooks(module: BaseModule): void {
    for(let action in this.moduleHooks) {
      for(let i = this.moduleHooks[action].length - 1; i >= 0; i--) {
        if(this.moduleHooks[action][i].module === module)
          this.moduleHooks[action].splice(i, 1);
      }
    }
  }

  public getActionHooks(action: ModuleHookAction): ModuleHookRegistration[] {
    if(!this.moduleHooks[action])
      return [];
    return this.moduleHooks[action].slice();
  }

  public processActionHooks(
    localfns: {prio: number, hook: Function}[],
    action: ModuleHookAction,
    args: any[],
    invocationWrapper?: (invoke: () => unknown) => Promise<void>,
  ): Promise<void> {
    const terminalAction = this.isTerminalHookAction(action);
    if(
      action === ModuleHookAction.RewardProducerStop
      || !this.terminalHookAdmissionOpen
      || (!terminalAction && !this.ordinaryHookAdmissionOpen)
    ) {
      return Promise.reject(new FaucetError(
        "FAUCET_UNAVAILABLE",
        "The faucet is temporarily unavailable. Please try again shortly.",
      ));
    }

    const operation = this.runActionHooks(localfns, action, args, invocationWrapper);
    this.hookOperations.add(operation);
    if(!terminalAction)
      this.ordinaryHookOperations.add(operation);
    void operation.then(
      () => {
        this.hookOperations.delete(operation);
        this.ordinaryHookOperations.delete(operation);
      },
      () => {
        this.hookOperations.delete(operation);
        this.ordinaryHookOperations.delete(operation);
      },
    );
    return operation;
  }

  private async runActionHooks(
    localfns: {prio: number, hook: Function}[],
    action: ModuleHookAction,
    args: any[],
    invocationWrapper?: (invoke: () => unknown) => Promise<void>,
  ): Promise<void> {
    let hooks = this.getActionHooks(action);
    let localIdx = 0;
    let hookIdx = 0;
    let invokeHook = (hook: Function): Promise<void> => {
      const invoke = () => hook.apply(this, args);
      if(!invocationWrapper)
        return Promise.resolve().then(invoke).then(() => undefined);
      return Promise.resolve().then(() => invocationWrapper(invoke)).then(() => undefined);
    };
    do {
      let loopPrio: number;
      if(localfns.length > localIdx && (hookIdx >= hooks.length || localfns[localIdx].prio <= hooks[hookIdx].prio))
        loopPrio = localfns[localIdx].prio;
      else if(hooks.length > hookIdx && (localIdx >= localfns.length || hooks[hookIdx].prio < localfns[localIdx].prio))
        loopPrio = hooks[hookIdx].prio;
      else
        break;

      let promises: Promise<void>[] = [];
      while(localfns.length > localIdx && localfns[localIdx].prio == loopPrio) {
        let hook = localfns[localIdx].hook;
        promises.push(invokeHook(hook));
        localIdx++;
      }
      while(hooks.length > hookIdx && hooks[hookIdx].prio == loopPrio) {
        let hook = hooks[hookIdx].hook;
        promises.push(invokeHook(hook));
        hookIdx++;
      }

      let results = await Promise.allSettled(promises);
      let failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if(failures.length === 1)
        throw failures[0];
      if(failures.length > 1)
        throw new AggregateError(failures, "Multiple hooks failed at priority " + loopPrio);
    } while(localfns.length > localIdx || hooks.length > hookIdx);
  }
}
