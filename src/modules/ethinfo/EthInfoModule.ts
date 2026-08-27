import { ServiceManager } from "../../common/ServiceManager.js";
import { EthWalletManager } from "../../eth/EthWalletManager.js";
import { FaucetSession } from "../../session/FaucetSession.js";
import { BaseModule } from "../BaseModule.js";
import { ModuleHookAction } from "../ModuleManager.js";
import { defaultConfig, IEthInfoConfig } from './EthInfoConfig.js';
import { FaucetError, PublicFaucetError } from '../../common/FaucetError.js';
import { BoundedAsyncWork, BoundedAsyncWorkContext } from '../../utils/BoundedAsyncWork.js';

interface EthInfoRuntime {
  walletManager: EthWalletManager;
  config: IEthInfoConfig;
  sourceConfig: IEthInfoConfig; // BaseModule restores this exact object after a failed reload.
}

export class EthInfoModule extends BaseModule<IEthInfoConfig> {
  protected readonly moduleDefaultConfig = defaultConfig;
  private readonly lookups = new BoundedAsyncWork<EthInfoRuntime>();

  protected override startModule(): Promise<void> {
    this.lookups.start(() => this.createRuntime(), this.getLimits());
    this.moduleManager.addActionHook(this, ModuleHookAction.SessionStart, 7, "ETH Info check", (session: FaucetSession, userInput: any) => this.processSessionStart(session, userInput));
    return Promise.resolve();
  }

  protected override stopModule(): Promise<void> {
    return this.lookups.stop();
  }

  protected override async onConfigReload(): Promise<void> {
    if(this.lookups.currentMatches((runtime) => runtime.sourceConfig === this.moduleConfig))
      return;
    await this.lookups.replace(() => this.createRuntime(), this.getLimits());
  }

  private createRuntime(): EthInfoRuntime {
    return {
      walletManager: ServiceManager.GetService(EthWalletManager),
      config: {...this.moduleConfig},
      sourceConfig: this.moduleConfig,
    };
  }

  private getLimits() {
    return {
      maxInflight: this.moduleConfig.maxConcurrentLookups,
      timeoutMs: this.moduleConfig.requestTimeout,
    };
  }

  private async processSessionStart(session: FaucetSession, userInput: any): Promise<void> {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    try {
      await this.lookups.run((runtime, context) => {
        return this.checkWallet(runtime, session.getTargetAddr(), context);
      });
    } catch(ex) {
      if(ex instanceof FaucetError)
        throw ex;
      throw new FaucetError("ETHINFO_CHECK", "Could not check wallet: " + String(ex));
    }
  }

  private async checkWallet(
    runtime: EthInfoRuntime,
    targetAddr: string,
    context: BoundedAsyncWorkContext,
  ): Promise<void> {
    const ethWalletManager = runtime.walletManager;
    const config = runtime.config;

    if(config.maxBalance && config.maxBalance > 0) {
      let walletBalance: bigint;
      try {
        walletBalance = await ethWalletManager.getWalletBalance(targetAddr);
        context.assertActive();
      } catch(ex) {
        throw new FaucetError("BALANCE_ERROR", "Could not get balance of Wallet " + targetAddr + ": " + String(ex));
      }
      if(walletBalance > config.maxBalance) {
        throw new PublicFaucetError({
          code: "BALANCE_LIMIT",
          message: "You're already holding " + ethWalletManager.readableAmount(walletBalance) + " in your wallet. Please give others a chance to get some funds too.",
        });
      }
    }

    if(config.denyContract) {
      try {
        if(await ethWalletManager.checkIsContract(targetAddr)) {
          throw new FaucetError("CONTRACT_ADDR", "Cannot start session for " + targetAddr + " (address is a contract)");
        }
        context.assertActive();
      } catch(ex) {
        if(!(ex instanceof FaucetError))
          ex = new FaucetError("CONTRACT_LIMIT", "Could not check contract status of wallet " + targetAddr + ": " + String(ex));
        throw ex;
      }
    }
  }

}
