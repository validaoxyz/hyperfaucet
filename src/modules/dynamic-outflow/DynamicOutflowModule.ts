import { clearInterval } from "timers";
import { ServiceManager } from "../../common/ServiceManager.js";
import { FaucetDatabase } from "../../db/FaucetDatabase.js";
import { EthWalletManager } from "../../eth/EthWalletManager.js";
import { EthClaimManager } from "../../eth/EthClaimManager.js";
import { SessionManager } from "../../session/SessionManager.js";
import { faucetConfig } from "../../config/FaucetConfig.js";
import { BaseModule } from "../BaseModule.js";
import { ModuleHookAction } from "../ModuleManager.js";
import { defaultConfig, IDynamicOutflowConfig, validateDynamicOutflowConfig } from "./DynamicOutflowConfig.js";
import { FaucetSession } from "../../session/FaucetSession.js";
import { ISessionRewardFactor } from "../../session/SessionRewardFactor.js";
import { FaucetLogLevel, FaucetProcess } from "../../common/FaucetProcess.js";

interface DynamicOutflowState {
  budget: bigint; // remaining outflow budget (wei); negative = mining outpaces the target drain rate
  updateTime: number;
}

interface DynamicOutflowRuntimeState {
  outflowState: DynamicOutflowState;
  outflowRate: bigint | null;
  outflowRateTime: number;
}

type DynamicOutflowWriteOwnership =
  | {kind: "certain", durableJson: string | null}
  | {
      kind: "uncertain";
      previousJson: string | null;
      nextJson: string;
      previousRuntime: DynamicOutflowRuntimeState;
      nextRuntime: DynamicOutflowRuntimeState;
      writeError: unknown;
    };

export class DynamicOutflowModule extends BaseModule<IDynamicOutflowConfig> {
  protected readonly moduleDefaultConfig = defaultConfig;

  private outflowState: DynamicOutflowState;
  private outflowRate: bigint = null; // wei per second; null until the wallet balance is known
  private outflowRateTime = 0; // last successful rate computation; a stale rate fails closed
  private refreshTimer: NodeJS.Timeout;
  private refreshPromise: Promise<void> = null;
  private stateOperationPromise: Promise<void> = Promise.resolve();
  private writeOwnership: DynamicOutflowWriteOwnership = {kind: "certain", durableJson: null};

  protected override async startModule(): Promise<void> {
    validateDynamicOutflowConfig(this.moduleConfig);
    await this.runStateOperation(() => this.loadOutflowState());
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionRewardFactor, 5, "dynamic outflow",
      (session: FaucetSession, rewardFactors: ISessionRewardFactor[]) => this.processSessionRewardFactor(session, rewardFactors)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionRewarded, 5, "dynamic outflow",
      (session: FaucetSession, amount: bigint) => this.processSessionRewarded(session, amount)
    );
  }

  protected override async stopModule(): Promise<void> {
    if(this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if(this.refreshPromise) {
      try {
        await this.refreshPromise;
      } catch(ex) {
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.WARNING, "Dynamic outflow refresh failed during shutdown: " + String(ex));
      }
    }
    await this.saveOutflowState();
  }

  protected override async onConfigReload(): Promise<void> {
    validateDynamicOutflowConfig(this.moduleConfig);
    // the timer cadence must follow refreshInterval: isRateStale() reads the new
    // interval, so a timer left on the old cadence would trip the fail-closed
    // staleness check between ticks after a live reload lowers the interval
    if(!this.isStateRestoreComplete())
      return;
    this.scheduleRateRefresh();
    await this.refreshOutflowRate();
  }

  protected override async onStateRestoreComplete(): Promise<void> {
    this.scheduleRateRefresh();
    await this.refreshOutflowRate();
  }

  private scheduleRateRefresh(): void {
    if(this.refreshTimer)
      clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => this.runScheduledRateRefresh(), this.moduleConfig.refreshInterval * 1000);
  }

  private runScheduledRateRefresh(): void {
    this.refreshOutflowRate().catch((ex) => {
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.ERROR, "Could not refresh dynamic outflow rate: " + String(ex));
    });
  }

  private now(): number {
    return Math.floor(new Date().getTime() / 1000);
  }

  private async loadOutflowState(): Promise<void> {
    await this.reconcileWriteOwnership();
    let stateJson = this.normalizeStoredJson(
      await ServiceManager.GetService(FaucetDatabase).getKeyValueEntry("DynamicOutflow.state"),
    );
    this.writeOwnership = {kind: "certain", durableJson: stateJson};
    if(stateJson) {
      let stateObj = JSON.parse(stateJson);
      let budget = BigInt(stateObj.budget);
      this.outflowState = {
        // never restore a positive burst buffer: a crash between debits and the periodic
        // save could otherwise replay budget that was already spent
        budget: budget > 0n ? 0n : budget,
        updateTime: this.now(),
      };
    }
    else {
      this.outflowState = {
        budget: 0n,
        updateTime: this.now(),
      };
    }
  }

  private async saveOutflowState(): Promise<void> {
    await this.runStateOperation(() => this.persistOutflowState());
  }

  private async persistOutflowState(previousRuntime = this.getRuntimeSnapshot()): Promise<void> {
    if(!this.outflowState)
      return;
    await this.reconcileWriteOwnership();
    if(this.writeOwnership.kind !== "certain")
      throw new Error("Dynamic outflow state write ownership is uncertain");

    const previousJson = this.writeOwnership.durableJson;
    const nextRuntime = this.getRuntimeSnapshot();
    const nextJson = this.serializeState(nextRuntime.outflowState);
    const database = ServiceManager.GetService(FaucetDatabase);
    try {
      await database.setKeyValueEntry("DynamicOutflow.state", nextJson);
      this.writeOwnership = {kind: "certain", durableJson: nextJson};
    } catch(writeError) {
      const uncertain: DynamicOutflowWriteOwnership = {
        kind: "uncertain",
        previousJson,
        nextJson,
        previousRuntime,
        nextRuntime,
        writeError,
      };
      this.writeOwnership = uncertain;
      let observedJson: string | null;
      try {
        observedJson = this.normalizeStoredJson(await database.getKeyValueEntry("DynamicOutflow.state"));
      } catch(readError) {
        throw new AggregateError(
          [writeError, readError],
          "Dynamic outflow state write is uncertain: " + String(writeError) + "; reconciliation failed: " + String(readError),
        );
      }
      if(observedJson === nextJson) {
        this.setRuntimeSnapshot(nextRuntime);
        this.writeOwnership = {kind: "certain", durableJson: nextJson};
        return;
      }
      if(observedJson === previousJson) {
        this.setRuntimeSnapshot(previousRuntime);
        this.writeOwnership = {kind: "certain", durableJson: previousJson};
        throw writeError;
      }
      throw new Error("Dynamic outflow state write ownership is uncertain because durable state diverged");
    }
  }

  private refreshOutflowRate(): Promise<void> {
    if(this.refreshPromise)
      return this.refreshPromise;
    this.refreshPromise = this.runStateOperation(() => this.computeOutflowRate()).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async computeOutflowRate(): Promise<void> {
    let walletBalance = ServiceManager.GetService(EthWalletManager).getFaucetBalance();
    if(walletBalance === null || walletBalance === undefined)
      return; // rpc not ready yet, keep the previous rate

    let previousRuntime = this.getRuntimeSnapshot();
    try {
      // accrue budget with the previous rate before the rate changes
      this.updateOutflowBudget();

      // unencumbered-balance recipe kept in sync manually with FaucetBalanceModule.
      // refreshBalanceRestriction and EthWalletRefill.tryRefillWallet (upstream files
      // stay pristine for rebasing, so no shared accessor)
      let effectiveBalance = BigInt(walletBalance);
      effectiveBalance -= BigInt(await ServiceManager.GetService(SessionManager).getUnclaimedBalance() ?? 0n); // balance from active & claimable sessions
      effectiveBalance -= BigInt(ServiceManager.GetService(EthClaimManager).getQueuedAmount() ?? 0n); // pending transaction amounts
      effectiveBalance -= BigInt(faucetConfig.spareFundsAmount);
      if(effectiveBalance < 0n)
        effectiveBalance = 0n;

      this.outflowRate = effectiveBalance / BigInt(this.moduleConfig.targetDrainTime);
      this.outflowRateTime = this.now();
      await this.persistOutflowState(previousRuntime);
    } catch(ex) {
      if(this.writeOwnership.kind === "certain")
        this.setRuntimeSnapshot(previousRuntime);
      throw ex;
    }
  }

  private isRateStale(): boolean {
    // fail closed when the wallet accounting hasn't refreshed for two poll intervals
    return this.now() - this.outflowRateTime > (this.moduleConfig.refreshInterval * 2) + 30;
  }

  private updateOutflowBudget() {
    if(this.writeOwnership.kind === "uncertain")
      return;
    let now = this.now();
    let timeDiff = now - this.outflowState.updateTime;
    if(timeDiff <= 0)
      return;
    this.outflowState.updateTime = now;
    if(this.outflowRate === null)
      return;

    this.outflowState.budget += this.outflowRate * BigInt(timeDiff);
    let upperLimit = this.outflowRate * BigInt(this.moduleConfig.burstWindow);
    if(this.outflowState.budget > upperLimit)
      this.outflowState.budget = upperLimit;
  }

  private processSessionRewardFactor(session: FaucetSession, rewardFactors: ISessionRewardFactor[]): void {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    let restriction = this.getOutflowRestriction();
    if(restriction < 1) {
      rewardFactors.push({
        factor: restriction,
        module: this.moduleName,
      });
    }
  }

  private async processSessionRewarded(session: FaucetSession, amount: bigint): Promise<void> {
    if(session && session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    if(amount <= 0n)
      return;
    await this.runStateOperation(async () => {
      let previousRuntime = this.getRuntimeSnapshot();
      try {
        this.updateOutflowBudget();
        // debt is never forgiven: every credited amount stays on the budget, no matter how
        // deep it goes. The restriction only reaches 0 below the cutoff; recovery takes
        // exactly debt/rate seconds, so the long-run rate is strictly conserved.
        this.outflowState.budget -= amount;
        await this.persistOutflowState(previousRuntime);
      } catch(ex) {
        if(this.writeOwnership.kind === "certain")
          this.setRuntimeSnapshot(previousRuntime);
        throw ex;
      }
    });
  }

  private runStateOperation<T>(operation: () => Promise<T>): Promise<T> {
    let result = this.stateOperationPromise.catch(() => undefined).then(async () => {
      await this.reconcileWriteOwnership();
      return operation();
    });
    this.stateOperationPromise = result.then(() => undefined, () => undefined);
    return result;
  }

  public getOutflowRestriction(): number {
    if(this.writeOwnership.kind === "uncertain")
      return 0;
    this.updateOutflowBudget();
    if(this.outflowRate === null)
      return 0; // wallet accounting not initialized yet, fail closed
    if(this.isRateStale())
      return 0; // wallet accounting stopped refreshing, fail closed
    if(this.outflowRate === 0n)
      return 0; // no mineable balance left
    if(this.outflowState.budget >= 0n)
      return 1;

    let cutoffBudget = this.outflowRate * BigInt(this.moduleConfig.cutoffWindow);
    let overdraft = this.outflowState.budget * -1n;
    if(overdraft >= cutoffBudget)
      return 0;
    return Number(10000n - (10000n * overdraft / cutoffBudget)) / 10000;
  }

  public getOutflowDebugState(): {now: number, budget: string, updateTime: number, rate: string, restriction: number, targetDrainTime: number} {
    this.updateOutflowBudget();
    return {
      now: this.now(),
      budget: this.outflowState.budget.toString(),
      updateTime: this.outflowState.updateTime,
      rate: this.outflowRate !== null ? this.outflowRate.toString() : null,
      restriction: this.getOutflowRestriction(),
      targetDrainTime: this.moduleConfig.targetDrainTime,
    };
  }

  private async reconcileWriteOwnership(): Promise<void> {
    if(this.writeOwnership.kind === "certain")
      return;
    const uncertain = this.writeOwnership;
    let observedJson: string | null;
    try {
      observedJson = this.normalizeStoredJson(
        await ServiceManager.GetService(FaucetDatabase).getKeyValueEntry("DynamicOutflow.state"),
      );
    } catch(readError) {
      throw new AggregateError(
        [uncertain.writeError, readError],
        "Dynamic outflow state write ownership remains uncertain: " + String(readError),
      );
    }
    if(observedJson === uncertain.nextJson) {
      this.setRuntimeSnapshot(uncertain.nextRuntime);
      this.writeOwnership = {kind: "certain", durableJson: uncertain.nextJson};
      return;
    }
    if(observedJson === uncertain.previousJson) {
      this.setRuntimeSnapshot(uncertain.previousRuntime);
      this.writeOwnership = {kind: "certain", durableJson: uncertain.previousJson};
      return;
    }
    throw new Error("Dynamic outflow state write ownership remains uncertain because durable state diverged");
  }

  private serializeState(state: DynamicOutflowState): string {
    return JSON.stringify({
      budget: state.budget.toString(),
      updateTime: state.updateTime,
    });
  }

  private normalizeStoredJson(stateJson: string | null | undefined): string | null {
    return stateJson === null || stateJson === undefined ? null : stateJson;
  }

  private getRuntimeSnapshot(): DynamicOutflowRuntimeState {
    return {
      outflowState: {...this.outflowState},
      outflowRate: this.outflowRate,
      outflowRateTime: this.outflowRateTime,
    };
  }

  private setRuntimeSnapshot(runtime: DynamicOutflowRuntimeState): void {
    this.outflowState = {...runtime.outflowState};
    this.outflowRate = runtime.outflowRate;
    this.outflowRateTime = runtime.outflowRateTime;
  }
}
