import { ModuleManager } from "./ModuleManager.js";

export interface IBaseModuleConfig {
  enabled: boolean;
}

type ModuleLifecycleState =
  | {kind: "disabled"}
  | {kind: "starting"}
  | {kind: "enabled", stateRestoreComplete: boolean}
  | {kind: "stopping", stateRestoreComplete: boolean}
  | {kind: "cleanup-required", stateRestoreComplete: boolean};

export abstract class BaseModule<TModCfg extends IBaseModuleConfig = IBaseModuleConfig> {
  protected abstract readonly moduleDefaultConfig: TModCfg;
  protected moduleManager: ModuleManager;
  protected moduleName: string;
  protected moduleConfig: TModCfg
  private lifecycle: ModuleLifecycleState = {kind: "disabled"};

  public constructor(manager: ModuleManager, name: string) {
    this.moduleManager = manager;
    this.moduleName = name;
  }

  public getModuleName(): string {
    return this.moduleName;
  }

  public async enableModule(): Promise<void> {
    if(this.lifecycle.kind !== "disabled")
      throw new Error("cannot enable module '" + this.moduleName + "' from state '" + this.lifecycle.kind + "'");

    this.lifecycle = {kind: "starting"};
    try {
      await this.startModule();
      this.lifecycle = {kind: "enabled", stateRestoreComplete: false};
    } catch(startError) {
      let rollbackFailed = false;
      let rollbackError: unknown;
      try {
        await this.stopModule();
      } catch(ex) {
        rollbackFailed = true;
        rollbackError = ex;
      }
      this.moduleManager.removeActionHooks(this);
      this.lifecycle = !rollbackFailed
        ? {kind: "disabled"}
        : {kind: "cleanup-required", stateRestoreComplete: false};

      if(rollbackFailed)
        throw new AggregateError([startError, rollbackError], "Module '" + this.moduleName + "' failed to start and roll back cleanly");
      throw startError;
    }
  }
  
  public async disableModule(): Promise<void> {
    if(this.lifecycle.kind !== "enabled" && this.lifecycle.kind !== "cleanup-required")
      throw new Error("cannot disable module '" + this.moduleName + "' from state '" + this.lifecycle.kind + "'");

    let stateRestoreComplete = this.lifecycle.stateRestoreComplete;
    this.lifecycle = {kind: "stopping", stateRestoreComplete};
    try {
      await this.stopModule();
      this.lifecycle = {kind: "disabled"};
    } catch(ex) {
      this.lifecycle = {kind: "cleanup-required", stateRestoreComplete};
      throw ex;
    } finally {
      this.moduleManager.removeActionHooks(this);
    }
  }

  public getModuleConfig(): TModCfg {
    return this.moduleConfig;
  }

  public async setModuleConfig(config: TModCfg): Promise<void> {
    let nextConfig = Object.assign({}, this.moduleDefaultConfig, config);
    if(this.lifecycle.kind === "disabled") {
      this.moduleConfig = nextConfig;
      return;
    }
    if(this.lifecycle.kind !== "enabled")
      throw new Error("cannot configure module '" + this.moduleName + "' while in state '" + this.lifecycle.kind + "'");

    let previousConfig = this.moduleConfig;
    this.moduleConfig = nextConfig;
    try {
      await this.onConfigReload();
    } catch(reloadError) {
      this.moduleConfig = previousConfig;
      try {
        await this.onConfigReload();
      } catch(rollbackError) {
        this.lifecycle = {
          kind: "cleanup-required",
          stateRestoreComplete: this.lifecycle.stateRestoreComplete,
        };
        this.moduleManager.removeActionHooks(this);
        throw new AggregateError([reloadError, rollbackError], "Module '" + this.moduleName + "' failed to reload and restore its prior configuration");
      }
      throw reloadError;
    }
  }

  public isEnabled(): boolean {
    return this.lifecycle.kind === "enabled" || this.lifecycle.kind === "cleanup-required";
  }

  public requiresCleanup(): boolean {
    return this.lifecycle.kind === "cleanup-required";
  }

  public async activateAfterStateRestore(): Promise<void> {
    if(this.lifecycle.kind !== "enabled")
      throw new Error("cannot activate module '" + this.moduleName + "' from state '" + this.lifecycle.kind + "'");
    if(this.lifecycle.stateRestoreComplete)
      return;

    try {
      await this.onStateRestoreComplete();
      this.lifecycle = {kind: "enabled", stateRestoreComplete: true};
    } catch(ex) {
      this.lifecycle = {kind: "cleanup-required", stateRestoreComplete: false};
      this.moduleManager.removeActionHooks(this);
      throw ex;
    }
  }

  protected isStateRestoreComplete(): boolean {
    return this.lifecycle.kind === "enabled" && this.lifecycle.stateRestoreComplete;
  }

  protected abstract startModule(): Promise<void>;
  protected abstract stopModule(): Promise<void>;
  protected onConfigReload(): void | Promise<void> {};
  protected onStateRestoreComplete(): void | Promise<void> {};
}
