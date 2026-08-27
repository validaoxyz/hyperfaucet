import { AsyncLocalStorage } from 'node:async_hooks';
import { ENS } from 'web3-eth-ens';
import { FaucetSession } from "../../session/FaucetSession.js";
import { BaseModule } from "../BaseModule.js";
import { ModuleHookAction } from "../ModuleManager.js";
import { defaultConfig, IEnsNameConfig } from './EnsNameConfig.js';
import { FaucetError } from '../../common/FaucetError.js';
import { EthWalletManager, Web3ProviderHandle } from '../../eth/EthWalletManager.js';
import {
  BoundedAsyncWork,
  BoundedAsyncWorkContext,
  BoundedAsyncWorkInvalidatedError,
} from '../../utils/BoundedAsyncWork.js';

interface EnsRuntime {
  ens: ENS;
  provider: Web3ProviderHandle;
  workContexts: AsyncLocalStorage<BoundedAsyncWorkContext>;
  sourceConfig: IEnsNameConfig; // BaseModule restores this exact object after a failed reload.
}

export class EnsNameModule extends BaseModule<IEnsNameConfig> {
  protected readonly moduleDefaultConfig = defaultConfig;
  private readonly lookups = new BoundedAsyncWork<EnsRuntime>();
  private publishedRequired: boolean | null = null;

  protected override startModule(): Promise<void> {
    const config = this.moduleConfig;
    this.validateConfig(config);
    this.lookups.start(
      () => this.createRuntime(config),
      this.getLimits(config),
      (runtime) => this.disposeRuntime(runtime),
    );
    this.publishedRequired = !!config.required;
    this.moduleManager.addActionHook(
      this, ModuleHookAction.ClientConfig, 1, "ens config", 
      async (clientConfig: any) => {
        clientConfig[this.moduleName] = {
          required: this.getPublishedRequired(),
        };
      }
    );
    this.moduleManager.addActionHook(this, ModuleHookAction.SessionStart, 3, "resolve ens name", (session: FaucetSession, userInput: any) => this.processSessionStart(session, userInput));
    return Promise.resolve();
  }

  protected override stopModule(): Promise<void> {
    this.publishedRequired = null;
    return this.lookups.stop();
  }

  protected override async onConfigReload(): Promise<void> {
    const config = this.moduleConfig;
    this.validateConfig(config);
    if(this.lookups.currentMatches((runtime) => runtime.sourceConfig === config))
      return;
    await this.lookups.replace(
      () => this.createRuntime(config),
      this.getLimits(config),
      (runtime) => this.disposeRuntime(runtime),
    );
    this.publishedRequired = !!config.required;
  }

  private createRuntime(config: IEnsNameConfig): EnsRuntime {
    const provider = EthWalletManager.createWeb3ProviderHandle(config.rpcHost, "ensname rpcHost");
    const workContexts = new AsyncLocalStorage<BoundedAsyncWorkContext>();
    try {
      return {
        ens: this.createEns(
          config.ensAddr || "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e",
          this.createGuardedProvider(provider.provider, workContexts),
        ),
        provider,
        workContexts,
        sourceConfig: config,
      };
    } catch(ex) {
      this.disposeFailedProvider(provider, workContexts, ex);
    }
  }

  private createEns(registryAddress: string, provider: any): ENS {
    return new ENS(registryAddress, provider);
  }

  private createGuardedProvider(
    provider: any,
    workContexts: AsyncLocalStorage<BoundedAsyncWorkContext>,
  ): any {
    const methods = new Map<PropertyKey, Function>();
    return new Proxy(provider, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target);
        if(typeof value !== "function" || property === "constructor")
          return value;
        let method = methods.get(property);
        if(!method) {
          method = (...args: any[]) => {
            if(property === "request" || property === "send" || property === "sendAsync") {
              const context = workContexts.getStore();
              if(!context)
                throw new Error("ENS provider request has no active work context");
              context.assertActive();
            }
            return Reflect.apply(value, target, args);
          };
          methods.set(property, method);
        }
        return method;
      },
    });
  }

  private disposeRuntime(runtime: EnsRuntime): void {
    try {
      runtime.provider.dispose();
    } finally {
      runtime.workContexts.disable();
    }
  }

  private disposeFailedProvider(
    provider: Web3ProviderHandle,
    workContexts: AsyncLocalStorage<BoundedAsyncWorkContext>,
    constructionError: unknown,
  ): never {
    try {
      provider.dispose();
    } catch(disposeError) {
      throw new AggregateError(
        [constructionError, disposeError],
        "ensname runtime construction and provider cleanup failed",
      );
    } finally {
      workContexts.disable();
    }
    throw constructionError;
  }

  private getLimits(config: IEnsNameConfig) {
    return {
      maxInflight: config.maxConcurrentLookups,
      timeoutMs: config.requestTimeout,
    };
  }

  private validateConfig(config: IEnsNameConfig): void {
    if(config.ensAddr !== null && !/^0x[0-9a-f]{40}$/i.test(config.ensAddr))
      throw new Error("ensname ensAddr must be null or an EVM address");
  }

  private getPublishedRequired(): boolean {
    if(this.publishedRequired === null)
      throw new BoundedAsyncWorkInvalidatedError();
    return this.publishedRequired;
  }

  private async processSessionStart(session: FaucetSession, userInput: any): Promise<void> {
    const targetAddr = userInput.addr;
    const isEnsName = typeof targetAddr === "string" && /^[-a-zA-Z0-9@:%._\+~#=]{1,256}\.eth$/.test(targetAddr);
    try {
      if(!isEnsName) {
        if(this.getPublishedRequired())
          throw new FaucetError("REQUIRE_ENSNAME", "Only ENS Names allowed.");
        return;
      }

      await this.lookups.run(async (runtime, context) => {
        const resolvedAddr = await runtime.workContexts.run(
          context,
          () => runtime.ens.getAddress(targetAddr),
        );
        if(typeof resolvedAddr !== "string")
          throw new Error("ENS resolver returned a non-string address");
        context.assertActive();
        session.setTargetAddr(resolvedAddr);
      });
    } catch(ex) {
      if(ex instanceof FaucetError)
        throw ex;
      if(isEnsName)
        throw new FaucetError("INVALID_ENSNAME", "Could not resolve ENS Name '" + targetAddr + "': " + String(ex));
      throw ex;
    }
  }

}
