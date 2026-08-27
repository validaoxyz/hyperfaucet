import { ServiceManager } from '../../common/ServiceManager.js';
import { FaucetLogLevel, FaucetProcess } from '../../common/FaucetProcess.js';
import { FetchUtil } from '../../utils/FetchUtil.js';
import { IHyperliquidStakeConfig } from './HyperliquidStakeConfig.js';
import { HyperliquidStakeModule } from './HyperliquidStakeModule.js';

export interface IHyperliquidStakeInfo {
  address: string;
  delegated: number; // staked HYPE counted for the boost (filtered by validatorFilter when set)
  totalDelegated: number; // staked HYPE across all validators
  stakedUsd: number;
  tokenPrice: number;
  time: number;
  error?: string;
}

export interface IHyperliquidStakeBoost {
  factor: number;
  stakedUsd: number;
  nextTierUsd: number | null; // stake value that unlocks the next factor (null when on the top tier)
  nextTierFactor: number | null;
}

interface IDelegatorSummaryResponse {
  delegated: string | number;
  undelegated: string | number;
  totalPendingWithdrawal: string | number;
  nPendingWithdrawals: number;
}

interface IDelegationEntry {
  validator: string;
  amount: string | number;
  lockedUntilTimestamp?: number;
}

interface IInfoApiRequest {
  type: string;
  [key: string]: unknown;
}

interface ILookupContext {
  generation: number;
  signal: AbortSignal;
  config: IHyperliquidStakeConfig;
}

export class HyperliquidStakeLookupInvalidatedError extends Error {
  public constructor() {
    super("Hyperliquid stake lookup was invalidated");
    this.name = "HyperliquidStakeLookupInvalidatedError";
  }
}

const MAX_STAKE_CACHE_ENTRIES = 10000;
const MAX_FORCED_REFRESH_ENTRIES = 10000;
const MAX_INFO_API_RESPONSE_BYTES = 2 * 1024 * 1024;

export class HyperliquidStakeResolver {
  private module: HyperliquidStakeModule;
  private stakeCache = new Map<string, IHyperliquidStakeInfo>();
  private stakePromises = new Map<string, Promise<IHyperliquidStakeInfo>>();
  private forcedRefreshTimes = new Map<string, number>();
  private priceCache: {price: number, time: number} = null;
  private pricePromise: Promise<number> = null;
  private spotMarketKey: {key: string, time: number} = null;
  private generation = 1;
  private generationController = new AbortController();
  private acceptingLookups = true;
  private ownedWork = new Set<Promise<unknown>>();

  public constructor(module: HyperliquidStakeModule) {
    this.module = module;
  }

  private now(): number {
    return Math.floor(new Date().getTime() / 1000);
  }

  public getCachedStakeInfo(address: string): IHyperliquidStakeInfo | null {
    let cached = this.stakeCache.get(address.toLowerCase());
    return cached || null;
  }

  public getFreshCachedStakeInfo(address: string): IHyperliquidStakeInfo | null {
    let cached = this.getCachedStakeInfo(address);
    if(!this.isStakeInfoFresh(cached))
      return null;
    return cached;
  }

  public isStakeInfoFresh(stakeInfo: IHyperliquidStakeInfo | null): boolean {
    return !!stakeInfo &&
      Number.isSafeInteger(stakeInfo.time) &&
      stakeInfo.time > this.now() - this.module.getModuleConfig().stakeCacheTime;
  }

  public getInflightCount(): number {
    return this.stakePromises.size;
  }

  // seconds until this address may force another refresh (0 = allowed now).
  // The cooldown is global per address, so rotating sessions can't bypass it.
  public getForcedRefreshCooldown(address: string): number {
    let cacheKey = address.toLowerCase();
    let lastRefresh = this.forcedRefreshTimes.get(cacheKey) || 0;
    let cooldown = lastRefresh + this.module.getModuleConfig().refreshCooldown - this.now();
    if(cooldown <= 0)
      this.forcedRefreshTimes.delete(cacheKey);
    return cooldown > 0 ? cooldown : 0;
  }

  public async getStakeInfo(address: string, forceRefresh?: boolean): Promise<IHyperliquidStakeInfo> {
    let context = this.createLookupContext();
    let cacheKey = address.toLowerCase();
    let cached = this.stakeCache.get(cacheKey);
    if(!forceRefresh && this.isStakeInfoFresh(cached))
      return cached;
    let pending = this.stakePromises.get(cacheKey);
    if(pending)
      return pending;
    if(this.stakePromises.size >= context.config.maxConcurrentLookups)
      throw new Error("stake lookup capacity reached");
    if(forceRefresh)
      this.recordForcedRefresh(cacheKey);

    let stakePromise: Promise<IHyperliquidStakeInfo>;
    stakePromise = this.fetchStakeInfo(cacheKey, context).then((stakeInfo) => {
      this.assertCurrent(context);
      this.stakeCache.delete(cacheKey);
      this.stakeCache.set(cacheKey, stakeInfo);
      this.pruneStakeCache();
      return stakeInfo;
    }).finally(() => {
      if(this.stakePromises.get(cacheKey) === stakePromise)
        this.stakePromises.delete(cacheKey);
    });
    this.stakePromises.set(cacheKey, stakePromise);
    this.trackWork(stakePromise);
    return stakePromise;
  }

  private async fetchStakeInfo(address: string, context: ILookupContext): Promise<IHyperliquidStakeInfo> {
    let config = context.config;
    let [tokenPrice, summary] = await Promise.all([
      this.getTokenPriceForContext(context),
      this.queryInfoApi<IDelegatorSummaryResponse>({type: "delegatorSummary", user: address}, context),
    ]);
    this.assertCurrent(context);

    let totalDelegated = this.parseAmount(summary?.delegated);
    let delegated = totalDelegated;
    if(config.validatorFilter && config.validatorFilter.length > 0) {
      let delegations = await this.queryInfoApi<IDelegationEntry[]>({type: "delegations", user: address}, context);
      this.assertCurrent(context);
      let filter = config.validatorFilter.map((addr) => addr.toLowerCase());
      delegated = (delegations || [])
        .filter((entry) => filter.indexOf((entry.validator || "").toLowerCase()) !== -1)
        .reduce((sum, entry) => sum + this.parseAmount(entry.amount), 0);
    }

    let stakedUsd = delegated * tokenPrice;
    if(!Number.isFinite(stakedUsd))
      throw new Error("stake value is not finite");

    ServiceManager.GetService(FaucetProcess).emitLog(
      FaucetLogLevel.INFO,
      "Fetched hyperliquid stake for " + address + ": " + delegated + " HYPE staked (" + stakedUsd.toFixed(2) + " USD)"
    );

    return {
      address: address,
      delegated: delegated,
      totalDelegated: totalDelegated,
      stakedUsd: stakedUsd,
      tokenPrice: tokenPrice,
      time: this.now(),
    };
  }

  public async getTokenPrice(): Promise<number> {
    return this.getTokenPriceForContext(this.createLookupContext());
  }

  private async getTokenPriceForContext(context: ILookupContext): Promise<number> {
    let config = context.config;
    if(config.fixedTokenPrice > 0)
      return config.fixedTokenPrice;
    if(this.priceCache && this.priceCache.time > this.now() - config.priceCacheTime)
      return this.priceCache.price;
    if(this.pricePromise)
      return this.pricePromise;

    let pricePromise: Promise<number>;
    pricePromise = this.fetchTokenPrice(context).then((price) => {
      this.assertCurrent(context);
      this.priceCache = {price: price, time: this.now()};
      return price;
    }).finally(() => {
      if(this.pricePromise === pricePromise)
        this.pricePromise = null;
    });
    this.pricePromise = pricePromise;
    this.trackWork(pricePromise);
    return pricePromise;
  }

  private async fetchTokenPrice(context: ILookupContext): Promise<number> {
    let spotKey = await this.resolveSpotMarketKey(context);
    let mids = await this.queryInfoApi<{[market: string]: string}>({type: "allMids"}, context);
    this.assertCurrent(context);
    if(!mids)
      throw new Error("no allMids response");
    // prefer the spot HYPE/USDC mid; the "HYPE" key is the perp mid, which can
    // deviate on basis and funding
    let price = spotKey ? this.parsePositiveNumber(mids[spotKey]) : null;
    if(price === null)
      price = this.parsePositiveNumber(mids["HYPE"]);
    if(price === null)
      throw new Error("no HYPE price in allMids response");
    return price;
  }

  private async resolveSpotMarketKey(context: ILookupContext): Promise<string> {
    // a resolved key is stable, so it lives for a day. An unresolved key (transient
    // spotMeta error or unexpected schema) only lives for one price-cache period,
    // so a single blip doesn't pin every valuation to the perp mid for 24h.
    let keyTtl = this.spotMarketKey?.key ? 86400 : context.config.priceCacheTime;
    if(this.spotMarketKey && this.spotMarketKey.time > this.now() - keyTtl)
      return this.spotMarketKey.key;
    let key: string = null;
    try {
      let spotMeta = await this.queryInfoApi<{tokens: {name: string, index: number}[], universe: {tokens: number[], index: number}[]}>({type: "spotMeta"}, context);
      this.assertCurrent(context);
      let hypeToken = (spotMeta?.tokens || []).find((token) => token.name === "HYPE");
      if(hypeToken) {
        let pair = (spotMeta?.universe || []).find((market) => market.tokens && market.tokens[0] === hypeToken.index && market.tokens[1] === 0);
        if(pair)
          key = "@" + pair.index;
      }
    } catch(ex) {
      this.assertCurrent(context);
      key = null; // fall back to the perp mid
    }
    this.assertCurrent(context);
    this.spotMarketKey = {key: key, time: this.now()};
    return key;
  }

  private async queryInfoApi<TRsp>(request: IInfoApiRequest, context: ILookupContext): Promise<TRsp> {
    this.assertCurrent(context);
    let rsp;
    try {
      rsp = await FetchUtil.fetchWithTimeout(context.config.infoApiUrl, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(request),
        redirect: "error",
        signal: context.signal,
        size: MAX_INFO_API_RESPONSE_BYTES,
      }, context.config.requestTimeout);
    } catch(ex) {
      this.assertCurrent(context);
      throw ex;
    }
    this.assertCurrent(context);
    if(rsp.status !== 200)
      throw new Error("info api error " + rsp.status + " for " + request.type + " request");
    let result = await rsp.json() as TRsp;
    this.assertCurrent(context);
    return result;
  }

  private createLookupContext(): ILookupContext {
    if(!this.acceptingLookups || this.generationController.signal.aborted)
      throw new HyperliquidStakeLookupInvalidatedError();
    let moduleConfig = this.module.getModuleConfig();
    return {
      generation: this.generation,
      signal: this.generationController.signal,
      config: {
        ...moduleConfig,
        boostFactor: {...moduleConfig.boostFactor},
        validatorFilter: [...(moduleConfig.validatorFilter || [])],
      },
    };
  }

  private assertCurrent(context: ILookupContext): void {
    if(
      !this.acceptingLookups ||
      context.generation !== this.generation ||
      context.signal.aborted
    )
      throw new HyperliquidStakeLookupInvalidatedError();
  }

  private trackWork<T>(promise: Promise<T>): void {
    this.ownedWork.add(promise);
    promise.then(
      () => this.ownedWork.delete(promise),
      () => this.ownedWork.delete(promise),
    );
  }

  private parseAmount(amount: string | number): number {
    if(typeof amount !== "string" && typeof amount !== "number")
      throw new Error("invalid stake amount in info api response");
    if(typeof amount === "string" && amount.trim().length === 0)
      throw new Error("invalid stake amount in info api response");
    let parsed = typeof amount === "number" ? amount : Number(amount);
    if(!Number.isFinite(parsed) || parsed < 0)
      throw new Error("invalid stake amount in info api response");
    return parsed;
  }

  private parsePositiveNumber(value: unknown): number | null {
    if(typeof value !== "string" && typeof value !== "number")
      return null;
    if(typeof value === "string" && value.trim().length === 0)
      return null;
    let parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  private pruneStakeCache() {
    while(this.stakeCache.size > MAX_STAKE_CACHE_ENTRIES) {
      let oldestAddress = this.stakeCache.keys().next().value;
      if(!oldestAddress)
        break;
      this.stakeCache.delete(oldestAddress);
    }
  }

  private recordForcedRefresh(address: string): void {
    this.forcedRefreshTimes.delete(address);
    while(this.forcedRefreshTimes.size >= MAX_FORCED_REFRESH_ENTRIES) {
      let oldestAddress = this.forcedRefreshTimes.keys().next().value;
      if(!oldestAddress)
        break;
      this.forcedRefreshTimes.delete(oldestAddress);
    }
    this.forcedRefreshTimes.set(address, this.now());
  }

  public getStakeBoost(stakeInfo: IHyperliquidStakeInfo | null): IHyperliquidStakeBoost {
    let config = this.module.getModuleConfig();
    let stakedUsd = stakeInfo && Number.isFinite(stakeInfo.stakedUsd) && stakeInfo.stakedUsd >= 0 ? stakeInfo.stakedUsd : 0;
    let factor = 1;
    let nextTierUsd: number = null;
    let nextTierFactor: number = null;
    let tiers = Object.keys(config.boostFactor || {}).map((tier) => Number(tier)).sort((a, b) => a - b);
    tiers.forEach((tier) => {
      if(stakedUsd >= tier) {
        if(config.boostFactor[tier] > factor)
          factor = config.boostFactor[tier];
      }
      else if(nextTierUsd === null) {
        nextTierUsd = tier;
        nextTierFactor = config.boostFactor[tier];
      }
    });
    return {
      factor: factor,
      stakedUsd: stakedUsd,
      nextTierUsd: nextTierUsd,
      nextTierFactor: nextTierFactor,
    };
  }

  private clearCurrentState(): void {
    this.stakeCache.clear();
    this.stakePromises.clear();
    this.forcedRefreshTimes.clear();
    this.priceCache = null;
    this.pricePromise = null;
    this.spotMarketKey = null;
  }

  private async rotateGeneration(acceptingLookups: boolean): Promise<void> {
    let oldController = this.generationController;
    let workToDrain = [...this.ownedWork];

    this.generation++;
    this.acceptingLookups = false;
    this.clearCurrentState();
    oldController.abort();

    await Promise.allSettled(workToDrain);
    this.generationController = new AbortController();
    this.acceptingLookups = acceptingLookups;
  }

  public async reload(): Promise<void> {
    await this.rotateGeneration(true);
  }

  public async stop(): Promise<void> {
    await this.rotateGeneration(false);
  }
}
