import { IncomingMessage } from 'http';
import { ServiceManager } from '../../common/ServiceManager.js';
import { FaucetLogLevel, FaucetProcess } from '../../common/FaucetProcess.js';
import { FaucetError, PublicFaucetError } from '../../common/FaucetError.js';
import { BaseModule } from '../BaseModule.js';
import { ModuleHookAction } from '../ModuleManager.js';
import { defaultConfig, IHyperliquidStakeConfig } from './HyperliquidStakeConfig.js';
import { FaucetSession, FaucetSessionStatus } from '../../session/FaucetSession.js';
import { ISessionRewardFactor } from '../../session/SessionRewardFactor.js';
import { FaucetWebApi, IFaucetApiUrl } from '../../webserv/FaucetWebApi.js';
import { SessionManager } from '../../session/SessionManager.js';
import {
  HyperliquidStakeLookupInvalidatedError,
  HyperliquidStakeResolver,
  IHyperliquidStakeInfo,
} from './HyperliquidStakeResolver.js';

interface ILookupCounter {
  windowStart: number;
  count: number;
}

const LOOKUP_WINDOW_SECONDS = 60;
const MAX_LOOKUP_COUNTERS = 10000;

export class HyperliquidStakeModule extends BaseModule<IHyperliquidStakeConfig> {
  protected readonly moduleDefaultConfig = defaultConfig;

  private stakeResolver?: HyperliquidStakeResolver;
  private lookupCounters = new Map<string, ILookupCounter>();

  protected override async startModule(): Promise<void> {
    this.validateConfig();
    this.stakeResolver = new HyperliquidStakeResolver(this);
    this.moduleManager.addActionHook(
      this, ModuleHookAction.ClientConfig, 1, "hyperliquid stake config",
      async (clientConfig: any) => {
        clientConfig[this.moduleName] = {
          boostFactor: this.moduleConfig.boostFactor,
          refreshTimeout: this.moduleConfig.refreshCooldown,
          requiredStakeUsd: this.moduleConfig.requiredStakeUsd,
          restrictedToValidators: (this.moduleConfig.validatorFilter && this.moduleConfig.validatorFilter.length > 0),
        };
      }
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionStart, 8, "hyperliquid stake",
      (session: FaucetSession) => this.processSessionStart(session)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionInfo, 1, "hyperliquid stake state",
      async (session: FaucetSession, moduleState: any) => this.processSessionInfo(session, moduleState)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionRewardFactor, 5, "hyperliquid stake boost",
      (session: FaucetSession, rewardFactors: ISessionRewardFactor[]) => this.processSessionRewardFactor(session, rewardFactors)
    );
    ServiceManager.GetService(FaucetWebApi).registerApiEndpoint(
      "getStakeInfo",
      (req: IncomingMessage, url: IFaucetApiUrl, body: Buffer) => this.processGetStakeInfo(req, url, body)
    );
    ServiceManager.GetService(FaucetWebApi).registerApiEndpoint(
      "refreshStakeInfo",
      (req: IncomingMessage, url: IFaucetApiUrl, body: Buffer) => this.processRefreshStakeInfo(req, url, body)
    );
  }

  protected override async stopModule(): Promise<void> {
    this.lookupCounters.clear();
    ServiceManager.GetService(FaucetWebApi).removeApiEndpoint("getStakeInfo");
    ServiceManager.GetService(FaucetWebApi).removeApiEndpoint("refreshStakeInfo");
    await this.stakeResolver?.stop();
    this.stakeResolver = undefined;
  }

  protected override async onConfigReload(): Promise<void> {
    this.validateConfig();
    this.lookupCounters.clear();
    if(this.stakeResolver)
      await this.stakeResolver.reload();
  }

  private validateConfig(): void {
    let infoApiUrl: URL;
    try {
      infoApiUrl = new URL(this.moduleConfig.infoApiUrl);
    } catch(ex) {
      throw new Error("hyperliquid-stake.infoApiUrl must be a valid HTTPS URL");
    }
    if(infoApiUrl.protocol !== "https:")
      throw new Error("hyperliquid-stake.infoApiUrl must use HTTPS");
    if(infoApiUrl.username || infoApiUrl.password)
      throw new Error("hyperliquid-stake.infoApiUrl must not contain credentials");

    let nonNegativeValues: {[key: string]: number} = {
      fixedTokenPrice: this.moduleConfig.fixedTokenPrice,
      priceCacheTime: this.moduleConfig.priceCacheTime,
      stakeCacheTime: this.moduleConfig.stakeCacheTime,
      refreshCooldown: this.moduleConfig.refreshCooldown,
      requiredStakeUsd: this.moduleConfig.requiredStakeUsd,
    };
    for(let [key, value] of Object.entries(nonNegativeValues)) {
      if(!Number.isFinite(value) || value < 0)
        throw new Error("hyperliquid-stake." + key + " must be a finite non-negative number");
    }
    if(!Number.isSafeInteger(this.moduleConfig.requestTimeout) || this.moduleConfig.requestTimeout < 1 || this.moduleConfig.requestTimeout > 120000)
      throw new Error("hyperliquid-stake.requestTimeout must be an integer between 1 and 120000");
    if(!Number.isSafeInteger(this.moduleConfig.guestLookupRateLimit) || this.moduleConfig.guestLookupRateLimit < 0)
      throw new Error("hyperliquid-stake.guestLookupRateLimit must be a non-negative integer");
    if(!Number.isSafeInteger(this.moduleConfig.maxConcurrentLookups) || this.moduleConfig.maxConcurrentLookups < 1 || this.moduleConfig.maxConcurrentLookups > 64)
      throw new Error("hyperliquid-stake.maxConcurrentLookups must be an integer between 1 and 64");
    for(let [threshold, factor] of Object.entries(this.moduleConfig.boostFactor || {})) {
      let parsedThreshold = Number(threshold);
      if(threshold.trim().length === 0 || !Number.isFinite(parsedThreshold) || parsedThreshold < 0 || !Number.isFinite(factor) || factor < 1)
        throw new Error("hyperliquid-stake.boostFactor contains a non-finite or invalid tier");
    }
  }

  public getStakeResolver(): HyperliquidStakeResolver {
    if(!this.stakeResolver)
      throw new Error("hyperliquid stake resolver is not running");
    return this.stakeResolver;
  }

  private async processSessionStart(session: FaucetSession): Promise<void> {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    let targetAddr = session.getTargetAddr();
    let stakeInfo: IHyperliquidStakeInfo;
    let cachedStakeInfo = this.stakeResolver.getFreshCachedStakeInfo(targetAddr);
    if(cachedStakeInfo) {
      stakeInfo = cachedStakeInfo;
    } else if(!this.consumeLiveLookupBudget(session.getRemoteIP())) {
      stakeInfo = this.handleSessionLookupFailure(targetAddr, "Stake lookup rate limit reached");
    } else {
      try {
        stakeInfo = await this.stakeResolver.getStakeInfo(targetAddr);
      } catch(ex) {
        stakeInfo = this.handleSessionLookupFailure(targetAddr, ex);
      }
    }
    session.setSessionData("hlstake.refresh", Math.floor(new Date().getTime() / 1000));
    session.setSessionData("hlstake.data", stakeInfo);

    if(this.moduleConfig.requiredStakeUsd > 0 && !stakeInfo.error && stakeInfo.stakedUsd < this.moduleConfig.requiredStakeUsd) {
      throw new PublicFaucetError({
        code: "STAKE_REQUIRED",
        message: "You need at least $" + this.moduleConfig.requiredStakeUsd + " of staked HYPE on Hyperliquid to use this faucet.",
        data: {address: targetAddr},
      });
    }
  }

  private handleSessionLookupFailure(targetAddr: string, cause: unknown): IHyperliquidStakeInfo {
    this.logLookupFailure(targetAddr, cause);
    if(
      cause instanceof HyperliquidStakeLookupInvalidatedError ||
      this.moduleConfig.failOnApiError ||
      this.moduleConfig.requiredStakeUsd > 0
    )
      throw new FaucetError("STAKE_CHECK_FAILED", "Could not verify staked HYPE. Please try again in a few minutes.");

    return {
      address: targetAddr.toLowerCase(),
      delegated: 0,
      totalDelegated: 0,
      stakedUsd: 0,
      tokenPrice: 0,
      time: Math.floor(new Date().getTime() / 1000),
      error: "Stake lookup unavailable",
    };
  }

  private logLookupFailure(targetAddr: string, cause: unknown): void {
    let detail = cause instanceof Error ? cause.message : String(cause);
    detail = detail.replace(/[\r\n\t]+/g, " ").slice(0, 256) || "unknown error";
    ServiceManager.GetService(FaucetProcess).emitLog(
      FaucetLogLevel.WARNING,
      "Hyperliquid stake lookup failed for " + targetAddr + ": " + detail,
    );
  }

  private async processSessionInfo(session: FaucetSession, moduleState: any): Promise<void> {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    if(session.getSessionStatus() !== FaucetSessionStatus.RUNNING)
      return;
    let stakeInfo: IHyperliquidStakeInfo = session.getSessionData("hlstake.data");
    moduleState[this.moduleName] = {
      stakeInfo: stakeInfo || null,
      boost: this.stakeResolver.getStakeBoost(
        stakeInfo && !stakeInfo.error && this.stakeResolver.isStakeInfoFresh(stakeInfo) ? stakeInfo : null,
      ),
    };
  }

  private processSessionRewardFactor(session: FaucetSession, rewardFactors: ISessionRewardFactor[]): void {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    let stakeInfo: IHyperliquidStakeInfo = session.getSessionData("hlstake.data");
    if(!stakeInfo || stakeInfo.error || !this.stakeResolver.isStakeInfoFresh(stakeInfo))
      return;
    let boost = this.stakeResolver.getStakeBoost(stakeInfo);
    if(boost.factor !== 1) {
      rewardFactors.push({
        factor: boost.factor,
        module: this.moduleName,
      });
    }
  }

  private async processGetStakeInfo(req: IncomingMessage, url: IFaucetApiUrl, body: Buffer): Promise<any> {
    let sessionId = url.query['session'] as string;
    let stakeInfo: IHyperliquidStakeInfo;

    if(sessionId) {
      let session: FaucetSession;
      if(!(session = ServiceManager.GetService(SessionManager).getSession(sessionId, [FaucetSessionStatus.RUNNING]))) {
        return {
          code: "INVALID_SESSION",
          error: "Session not found"
        };
      }
      stakeInfo = session.getSessionData("hlstake.data");
    }
    else {
      let address = url.query['address'] as string;
      if(!address || !address.match(/^0x[0-9a-fA-F]{40}$/) || address.match(/^0x0{40}$/i)) {
        return {
          code: "INVALID_ADDRESS",
          error: "Invalid address"
        };
      }
      stakeInfo = this.stakeResolver.getFreshCachedStakeInfo(address);
      if(!stakeInfo && this.consumeLiveLookupBudget(this.getRequestIp(req))) {
        try {
          stakeInfo = await this.stakeResolver.getStakeInfo(address);
        } catch(ex) {
          stakeInfo = this.stakeResolver.getCachedStakeInfo(address);
        }
      }
      else if(!stakeInfo) {
        stakeInfo = this.stakeResolver.getCachedStakeInfo(address);
      }
      let now = Math.floor(new Date().getTime() / 1000);
      let refreshAt = stakeInfo ? stakeInfo.time + this.moduleConfig.stakeCacheTime : 0;
      return {
        stakeInfo: stakeInfo || null,
        boost: this.stakeResolver.getStakeBoost(
          stakeInfo && !stakeInfo.error && this.stakeResolver.isStakeInfoFresh(stakeInfo) ? stakeInfo : null,
        ),
        cooldown: refreshAt > now ? refreshAt : 0,
      };
    }

    return {
      stakeInfo: stakeInfo || null,
      boost: this.stakeResolver.getStakeBoost(
        stakeInfo && !stakeInfo.error && this.stakeResolver.isStakeInfoFresh(stakeInfo) ? stakeInfo : null,
      ),
    };
  }

  private getRequestIp(req: IncomingMessage): string {
    try {
      return ServiceManager.GetService(FaucetWebApi).getRemoteAddr(req) || "unknown";
    } catch(ex) {
      return "unknown";
    }
  }

  private consumeLiveLookupBudget(remoteIp: string): boolean {
    let limit = this.moduleConfig.guestLookupRateLimit;
    if(!limit || limit <= 0)
      return true;
    let now = Math.floor(new Date().getTime() / 1000);
    let counter = this.lookupCounters.get(remoteIp);
    if(!counter || now - counter.windowStart >= LOOKUP_WINDOW_SECONDS) {
      this.lookupCounters.delete(remoteIp);
      while(this.lookupCounters.size >= MAX_LOOKUP_COUNTERS) {
        let oldestIp = this.lookupCounters.keys().next().value;
        if(!oldestIp)
          break;
        this.lookupCounters.delete(oldestIp);
      }
      counter = {windowStart: now, count: 0};
      this.lookupCounters.set(remoteIp, counter);
    }
    if(counter.count >= limit)
      return false;
    counter.count++;
    return true;
  }

  private async processRefreshStakeInfo(req: IncomingMessage, url: IFaucetApiUrl, body: Buffer): Promise<any> {
    let sessionId = url.query['session'] as string;
    let session: FaucetSession;
    if(!sessionId || !(session = ServiceManager.GetService(SessionManager).getSession(sessionId, [FaucetSessionStatus.RUNNING]))) {
      return {
        code: "INVALID_SESSION",
        error: "Session not found"
      };
    }

    let now = Math.floor(new Date().getTime() / 1000);
    let lastRefresh = session.getSessionData("hlstake.refresh") || 0;
    let sessionCooldown = lastRefresh + this.moduleConfig.refreshCooldown - now;
    let addressCooldown = this.stakeResolver.getForcedRefreshCooldown(session.getTargetAddr());
    let cooldown = Math.max(sessionCooldown, addressCooldown);
    if(cooldown > 0) {
      return {
        code: "REFRESH_COOLDOWN",
        error: "Stake refresh is rate limited. Please wait " + cooldown + " sec",
        cooldown: now + cooldown,
      };
    }

    if(!this.consumeLiveLookupBudget(session.getRemoteIP())) {
      return {
        code: "STAKE_CHECK_RATE_LIMITED",
        error: "Stake lookup is rate limited. Please try again later.",
      };
    }

    let stakeInfo: IHyperliquidStakeInfo;
    try {
      stakeInfo = await this.stakeResolver.getStakeInfo(session.getTargetAddr(), true);
    } catch(ex) {
      this.logLookupFailure(session.getTargetAddr(), ex);
      return {
        code: "STAKE_CHECK_FAILED",
        error: "Could not verify staked HYPE. Please try again in a few minutes.",
      };
    }
    session.setSessionData("hlstake.refresh", now);
    session.setSessionData("hlstake.data", stakeInfo);

    return {
      stakeInfo: stakeInfo,
      boost: this.stakeResolver.getStakeBoost(stakeInfo.error ? null : stakeInfo),
      cooldown: now + this.moduleConfig.refreshCooldown,
    };
  }
}
