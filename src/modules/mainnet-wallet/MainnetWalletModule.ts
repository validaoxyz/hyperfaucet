import Web3 from 'web3';
import { ServiceManager } from "../../common/ServiceManager.js";
import { EthWalletManager, Web3ProviderHandle } from "../../eth/EthWalletManager.js";
import { FaucetSession } from "../../session/FaucetSession.js";
import { BaseModule } from "../BaseModule.js";
import { ModuleHookAction } from "../ModuleManager.js";
import { defaultConfig, IMainnetWalletConfig } from './MainnetWalletConfig.js';
import { FaucetError, PublicFaucetError } from '../../common/FaucetError.js';
import { Erc20Abi } from '../../abi/ERC20.js';
import { BoundedAsyncWork, BoundedAsyncWorkContext } from '../../utils/BoundedAsyncWork.js';

interface MainnetWalletRuntime {
  web3: Web3;
  config: IMainnetWalletConfig;
  provider: Web3ProviderHandle;
  sourceConfig: IMainnetWalletConfig; // BaseModule restores this exact object after a failed reload.
}

export class MainnetWalletModule extends BaseModule<IMainnetWalletConfig> {
  protected readonly moduleDefaultConfig = defaultConfig;
  private readonly lookups = new BoundedAsyncWork<MainnetWalletRuntime>();

  protected override startModule(): Promise<void> {
    this.lookups.start(() => this.createRuntime(), this.getLimits(), (runtime) => runtime.provider.dispose());
    this.moduleManager.addActionHook(this, ModuleHookAction.SessionStart, 7, "Mainnet Wallet check", (session: FaucetSession, userInput: any) => this.processSessionStart(session, userInput));
    return Promise.resolve();
  }

  protected override stopModule(): Promise<void> {
    return this.lookups.stop();
  }

  protected override async onConfigReload(): Promise<void> {
    if(this.lookups.currentMatches((runtime) => runtime.sourceConfig === this.moduleConfig))
      return;
    await this.lookups.replace(
      () => this.createRuntime(),
      this.getLimits(),
      (runtime) => runtime.provider.dispose(),
    );
  }

  private createRuntime(): MainnetWalletRuntime {
    const sourceConfig = this.moduleConfig;
    const config = this.copyConfig(this.moduleConfig);
    const provider = EthWalletManager.createWeb3ProviderHandle(config.rpcHost, "mainnet-wallet rpcHost");
    try {
      return {
        web3: this.createWeb3(provider.provider),
        config,
        provider,
        sourceConfig,
      };
    } catch(ex) {
      this.disposeFailedProvider(provider, ex);
    }
  }

  private createWeb3(provider: any): Web3 {
    return new Web3(provider);
  }

  private copyConfig(config: IMainnetWalletConfig): IMainnetWalletConfig {
    return {
      ...config,
      minErc20Balances: (config.minErc20Balances || []).map((token) => ({...token})),
    };
  }

  private disposeFailedProvider(provider: Web3ProviderHandle, constructionError: unknown): never {
    try {
      provider.dispose();
    } catch(disposeError) {
      throw new AggregateError(
        [constructionError, disposeError],
        "mainnet-wallet runtime construction and provider cleanup failed",
      );
    }
    throw constructionError;
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
      throw new FaucetError("MAINNET_WALLET_CHECK", "Could not check mainnet wallet: " + String(ex));
    }
  }

  private async checkWallet(
    runtime: MainnetWalletRuntime,
    targetAddr: string,
    context: BoundedAsyncWorkContext,
  ): Promise<void> {
    const config = runtime.config;
    const web3 = runtime.web3;

    if(config.minBalance > 0) {
      let minBalance = BigInt(config.minBalance);
      let walletBalance: bigint;
      try {
        walletBalance = BigInt(await web3.eth.getBalance(targetAddr));
        context.assertActive();
      } catch(ex) {
        throw new FaucetError("MAINNET_BALANCE_CHECK", "Could not get balance of mainnet wallet " + targetAddr + ": " + String(ex));
      }
      if(walletBalance < minBalance) {
        throw new PublicFaucetError({
          code: "MAINNET_BALANCE_LIMIT",
          message: "You need to hold at least " + ServiceManager.GetService(EthWalletManager).readableAmount(minBalance, true) + " in your wallet on mainnet to use this faucet.",
        });
      }
    }

    if(config.minTxCount > 0) {
      let walletTxCount: bigint;
      try {
        walletTxCount = await web3.eth.getTransactionCount(targetAddr);
        context.assertActive();
      } catch(ex) {
        throw new FaucetError("MAINNET_TXCOUNT_CHECK", "Could not get tx-count of mainnet wallet " + targetAddr + ": " + String(ex));
      }
      if(walletTxCount < config.minTxCount) {
        throw new PublicFaucetError({
          code: "MAINNET_TXCOUNT_LIMIT",
          message: "You need to submit at least " + config.minTxCount + " transactions from your wallet on mainnet to use this faucet.",
        });
      }
    }

    if(config.minErc20Balances.length > 0) {
      let faucetAddress = ServiceManager.GetService(EthWalletManager).getFaucetAddress();
      for(let i = 0; i < config.minErc20Balances.length; i++) {
        let erc20Token = config.minErc20Balances[i];
        let minBalance = BigInt(erc20Token.minBalance);

        let walletBalance: bigint;
        try {
          let tokenContract = new web3.eth.Contract(Erc20Abi, erc20Token.address, {
            from: faucetAddress,
          });

          walletBalance = BigInt(await tokenContract.methods.balanceOf(targetAddr).call());
          context.assertActive();
        } catch(ex) {
          throw new FaucetError("MAINNET_BALANCE_CHECK", "Could not get token balance of mainnet wallet " + targetAddr + ": " + String(ex));
        }
        if(walletBalance < minBalance) {
          let factor = Math.pow(10, erc20Token.decimals || 18);
          let amountStr = (Math.floor(parseInt(minBalance.toString()) / factor * 1000) / 1000).toString();
          throw new PublicFaucetError({
            code: "MAINNET_BALANCE_LIMIT",
            message: "You need to hold at least " + amountStr + " " + erc20Token.name + " in your wallet on mainnet to use this faucet.",
          });
        }
      }
    }
  }

}
