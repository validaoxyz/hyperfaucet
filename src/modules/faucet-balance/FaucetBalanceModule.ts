import { ServiceManager } from "../../common/ServiceManager.js";
import { EthWalletManager } from "../../eth/EthWalletManager.js";
import { FaucetSession } from "../../session/FaucetSession.js";
import { BaseModule } from "../BaseModule.js";
import { ModuleHookAction } from "../ModuleManager.js";
import { defaultConfig, IFaucetBalanceConfig } from './FaucetBalanceConfig.js';
import { ISessionRewardFactor } from "../../session/SessionRewardFactor.js";
import { EthClaimManager } from "../../eth/EthClaimManager.js";
import { faucetConfig } from "../../config/FaucetConfig.js";
import { SessionManager } from "../../session/SessionManager.js";

interface CompiledFixedRestriction {
  limit: bigint;
  rewardPercent: number;
}

interface CompiledBalanceRestrictions {
  fixed: CompiledFixedRestriction[];
  dynamicTarget: bigint | null;
}

const CANONICAL_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

export class FaucetBalanceModule extends BaseModule<IFaucetBalanceConfig> {
  protected readonly moduleDefaultConfig = defaultConfig;
  private balanceRestriction: number;
  private balanceRestrictionRefresh = 0;
  private fixedRestrictions: CompiledFixedRestriction[] = [];
  private dynamicTargetBalance: bigint | null = null;

  protected override startModule(): Promise<void> {
    this.applyCompiledConfig();
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionRewardFactor, 6, "faucet balance",
      (session: FaucetSession, rewardFactors: ISessionRewardFactor[]) => this.processSessionRewardFactor(session, rewardFactors)
    );
    return Promise.resolve();
  }

  protected override stopModule(): Promise<void> {
    // nothing to do
    return Promise.resolve();
  }

  protected override onConfigReload(): void {
    this.applyCompiledConfig();
    this.balanceRestrictionRefresh = 0;
  }

  private async processSessionRewardFactor(session: FaucetSession, rewardFactors: ISessionRewardFactor[]): Promise<void> {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    await this.refreshBalanceRestriction();
    if(this.balanceRestriction !== 100) {
      rewardFactors.push({
        factor: this.balanceRestriction / 100,
        module: this.moduleName,
      });
    }
  }

  private async refreshBalanceRestriction(): Promise<void> {
    let now = Math.floor((new Date()).getTime() / 1000);
    if(this.balanceRestrictionRefresh > now - 30)
      return;
      
    let faucetBalance = ServiceManager.GetService(EthWalletManager).getFaucetBalance();
    if(faucetBalance === null)
      return;
    
    this.balanceRestrictionRefresh = now;
    faucetBalance -= await ServiceManager.GetService(SessionManager).getUnclaimedBalance(); // subtract balance from active & claimable sessions
    faucetBalance -= ServiceManager.GetService(EthClaimManager).getQueuedAmount(); // subtract pending transaction amounts
    
    this.balanceRestriction = Math.min(
      this.getStaticBalanceRestriction(faucetBalance),
      this.getDynamicBalanceRestriction(faucetBalance)
    );
  }

  public getBalanceRestriction(): number {
    return this.balanceRestriction;
  }

  private getStaticBalanceRestriction(balance: bigint): number {
    let restrictedReward = 100;
    for(let restriction of this.fixedRestrictions) {
      if(balance <= restriction.limit && restriction.rewardPercent < restrictedReward)
        restrictedReward = restriction.rewardPercent;
    }
    return restrictedReward;
  }

  private getDynamicBalanceRestriction(balance: bigint): number {
    if(this.dynamicTargetBalance === null)
      return 100;
    if(balance >= this.dynamicTargetBalance)
      return 100;
    if(balance <= faucetConfig.spareFundsAmount)
      return 0;

    let mineableBalance = balance - BigInt(faucetConfig.spareFundsAmount);
    let balanceRestriction = parseInt((mineableBalance * 100000n / this.dynamicTargetBalance).toString()) / 1000;
    return balanceRestriction;
  }

  private applyCompiledConfig(): void {
    let compiled = this.compileRestrictions(this.moduleConfig);
    this.fixedRestrictions = compiled.fixed;
    this.dynamicTargetBalance = compiled.dynamicTarget;
  }

  private compileRestrictions(config: IFaucetBalanceConfig): CompiledBalanceRestrictions {
    if(config.fixedRestriction !== null && config.fixedRestriction !== undefined &&
      (typeof config.fixedRestriction !== "object" || Array.isArray(config.fixedRestriction)))
      throw new Error("faucet-balance fixedRestriction must be an object");

    let fixed = Object.entries(config.fixedRestriction ?? {}).map(([limit, rewardPercent]) => {
      if(!CANONICAL_DECIMAL_PATTERN.test(limit))
        throw new Error("faucet-balance fixedRestriction limits must be canonical non-negative decimal strings");
      if(typeof rewardPercent !== "number" || !Number.isFinite(rewardPercent) || rewardPercent < 0 || rewardPercent > 100)
        throw new Error("faucet-balance fixedRestriction percentages must be finite numbers from 0 to 100");
      return {
        limit: BigInt(limit),
        rewardPercent,
      };
    });
    fixed.sort((a, b) => a.limit < b.limit ? -1 : a.limit > b.limit ? 1 : 0);

    let dynamicTarget: bigint | null = null;
    if(config.dynamicRestriction !== null && config.dynamicRestriction !== undefined) {
      if(typeof config.dynamicRestriction !== "object" || Array.isArray(config.dynamicRestriction))
        throw new Error("faucet-balance dynamicRestriction must be an object");
      dynamicTarget = this.parseBalanceAmount("dynamicRestriction.targetBalance", config.dynamicRestriction.targetBalance);
      if(dynamicTarget <= 0n)
        throw new Error("faucet-balance dynamicRestriction.targetBalance must be greater than zero");
    }

    return {fixed, dynamicTarget};
  }

  private parseBalanceAmount(name: string, value: number | string): bigint {
    if(typeof value === "number") {
      if(!Number.isSafeInteger(value) || value < 0)
        throw new Error("faucet-balance " + name + " must be a non-negative safe integer or canonical decimal string");
      return BigInt(value);
    }
    if(typeof value !== "string" || !CANONICAL_DECIMAL_PATTERN.test(value))
      throw new Error("faucet-balance " + name + " must be a non-negative safe integer or canonical decimal string");
    return BigInt(value);
  }
}
