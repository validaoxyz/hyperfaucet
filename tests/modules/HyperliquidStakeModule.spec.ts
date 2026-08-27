import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { awaitSleepPromise, bindTestStubs, unbindTestStubs, loadDefaultTestConfig, returnDelayedPromise } from '../common.js';
import { FetchUtil } from '../../src/utils/FetchUtil.js';
import { ServiceManager } from '../../src/common/ServiceManager.js';
import { FaucetDatabase } from '../../src/db/FaucetDatabase.js';
import { ModuleManager } from '../../src/modules/ModuleManager.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { faucetConfig } from '../../src/config/FaucetConfig.js';
import { FaucetWebApi } from '../../src/webserv/FaucetWebApi.js';
import { IHyperliquidStakeConfig } from '../../src/modules/hyperliquid-stake/HyperliquidStakeConfig.js';
import { HyperliquidStakeModule } from '../../src/modules/hyperliquid-stake/HyperliquidStakeModule.js';
import { PublicFaucetError } from '../../src/common/FaucetError.js';
import { ISessionRewardFactor } from '../../src/session/SessionRewardFactor.js';


describe("Faucet module: hyperliquid-stake", () => {
  let globalStubs;

  beforeEach(async () => {
    globalStubs = bindTestStubs({
      "fetch": sinon.stub(FetchUtil, "fetch"),
    });
    loadDefaultTestConfig();
    faucetConfig.maxDropAmount = 100;
    faucetConfig.minDropAmount = 10;
    await ServiceManager.GetService(FaucetDatabase).initialize();
  });
  afterEach(async () => {
    let dbService = ServiceManager.GetService(FaucetDatabase);
    await ServiceManager.DisposeAllServices();
    await dbService.closeDatabase();
    await unbindTestStubs(globalStubs);
  });

  function moduleConfig(overrides?: Partial<IHyperliquidStakeConfig>): IHyperliquidStakeConfig {
    return Object.assign({
      enabled: true,
      infoApiUrl: "https://unit-test.local/info",
      boostFactor: {
        10000: 2,
        50000: 3,
      },
      validatorFilter: [],
      fixedTokenPrice: 0,
      priceCacheTime: 300,
      stakeCacheTime: 600,
      refreshCooldown: 300,
      requiredStakeUsd: 0,
      failOnApiError: false,
      requestTimeout: 1000,
      guestLookupRateLimit: 6,
      maxConcurrentLookups: 8,
    }, overrides || {}) as IHyperliquidStakeConfig;
  }

  function stubInfoApi(data: {delegated?: string, price?: string, perpPrice?: string, delegations?: {validator: string, amount: string}[], noSpotMeta?: boolean}) {
    globalStubs["fetch"].callsFake((url: string, init: any) => {
      let request = JSON.parse(init.body);
      let payload: any;
      switch(request.type) {
        case "delegatorSummary":
          payload = {delegated: data.delegated || "0", undelegated: "0", totalPendingWithdrawal: "0", nPendingWithdrawals: 0};
          break;
        case "allMids":
          payload = {"BTC": "100000.0", "HYPE": data.perpPrice || data.price || "40.0", "@107": data.price || "40.0"};
          break;
        case "spotMeta":
          if(data.noSpotMeta)
            return returnDelayedPromise(false, "spotMeta unavailable");
          payload = {tokens: [{name: "USDC", index: 0}, {name: "HYPE", index: 150}], universe: [{tokens: [150, 0], index: 107}]};
          break;
        case "delegations":
          payload = data.delegations || [];
          break;
        default:
          return returnDelayedPromise(false, "unexpected request type " + request.type);
      }
      return returnDelayedPromise(true, {
        status: 200,
        json: () => Promise.resolve(payload),
      });
    });
  }

  async function runTestSession(addr?: string, expectedStatus?: string): Promise<any> {
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: addr || "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal(expectedStatus || "claimable", "unexpected session status");
    return testSession;
  }

  it("Check client config exports", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig({refreshCooldown: 42, requiredStakeUsd: 5});
    await ServiceManager.GetService(ModuleManager).initialize();
    let clientConfig = await ServiceManager.GetService(FaucetWebApi).onGetFaucetConfig();
    expect(!!clientConfig.modules['hyperliquid-stake']).to.equal(true, "no hyperliquid-stake config exported");
    expect(clientConfig.modules['hyperliquid-stake'].refreshTimeout).to.equal(42, "client config mismatch: refreshTimeout");
    expect(clientConfig.modules['hyperliquid-stake'].requiredStakeUsd).to.equal(5, "client config mismatch: requiredStakeUsd");
    expect(JSON.stringify(clientConfig.modules['hyperliquid-stake'].boostFactor)).to.equal(JSON.stringify({10000: 2, 50000: 3}), "client config mismatch: boostFactor");
    expect(clientConfig.modules['hyperliquid-stake'].restrictedToValidators).to.equal(false, "client config mismatch: restrictedToValidators");
  }).timeout(5000);

  it("Reject a cleartext info API URL", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig({infoApiUrl: "http://unit-test.local/info"});
    let error: Error | null = null;
    try {
      await ServiceManager.GetService(ModuleManager).initialize();
    } catch(ex) {
      error = ex;
    }
    expect(error?.message).to.include("must use HTTPS");
  });

  it("Reject credentials embedded in the info API URL", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig({infoApiUrl: "https://user:password@unit-test.local/info"});
    let error: Error | null = null;
    try {
      await ServiceManager.GetService(ModuleManager).initialize();
    } catch(ex) {
      error = ex;
    }
    expect(error?.message).to.include("must not contain credentials");
  });

  it("Apply 2x boost at the first stake tier", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig();
    stubInfoApi({delegated: "500", price: "40.0"}); // 20,000 USD staked
    await ServiceManager.GetService(ModuleManager).initialize();
    let testSession = await runTestSession();
    let stakeInfo = testSession.getSessionData("hlstake.data");
    expect(stakeInfo?.delegated).to.equal(500, "unexpected delegated amount");
    expect(stakeInfo?.stakedUsd).to.equal(20000, "unexpected staked usd value");
    expect(testSession.getDropAmount()).to.equal(200n, "boost factor 2 not applied to drop amount");
    for(let call of globalStubs["fetch"].getCalls()) {
      expect(call.args[0]).to.equal("https://unit-test.local/info");
      expect(call.args[1].redirect).to.equal("error");
      expect(call.args[1].size).to.equal(2 * 1024 * 1024);
      expect(call.args[1].signal).to.be.instanceOf(AbortSignal);
    }
  }).timeout(5000);

  it("Apply 3x boost at the second stake tier boundary", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig();
    stubInfoApi({delegated: "1250", price: "40.0"}); // exactly 50,000 USD staked
    await ServiceManager.GetService(ModuleManager).initialize();
    let testSession = await runTestSession();
    expect(testSession.getDropAmount()).to.equal(300n, "boost factor 3 not applied to drop amount");
  }).timeout(5000);

  it("Stop applying a stake boost after its snapshot expires", async () => {
    const clock = sinon.useFakeTimers({now: Date.UTC(2026, 7, 22), toFake: ["Date"]});
    try {
      faucetConfig.modules["hyperliquid-stake"] = moduleConfig({fixedTokenPrice: 40, stakeCacheTime: 600});
      stubInfoApi({delegated: "500"});
      await ServiceManager.GetService(ModuleManager).initialize();

      let module = ServiceManager.GetService(ModuleManager).getModule<HyperliquidStakeModule>("hyperliquid-stake");
      let stakeInfo = await module.getStakeResolver().getStakeInfo("0x0000000000000000000000000000000000001337");
      let session = {
        getSessionData: (key: string, fallback?: unknown) => key === "hlstake.data" ? stakeInfo : fallback,
      };
      let rewardFactors: ISessionRewardFactor[] = [];
      (module as any).processSessionRewardFactor(session, rewardFactors);
      expect(rewardFactors).to.deep.equal([{factor: 2, module: "hyperliquid-stake"}], "fresh stake boost was not applied");

      clock.tick(600_000);
      rewardFactors = [];
      (module as any).processSessionRewardFactor(session, rewardFactors);
      expect(rewardFactors).to.deep.equal([], "expired stake boost remained active");
    } finally {
      clock.restore();
    }
  }).timeout(5000);

  it("Apply no boost below the first tier", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig();
    stubInfoApi({delegated: "249", price: "40.0"}); // 9,960 USD staked
    await ServiceManager.GetService(ModuleManager).initialize();
    let testSession = await runTestSession();
    expect(testSession.getDropAmount()).to.equal(100n, "unexpected boost below first tier");
  }).timeout(5000);

  it("Count only filtered validators when validatorFilter is set", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig({
      validatorFilter: ["0x00000000000000000000000000000000000000A1"],
    });
    stubInfoApi({
      delegated: "1000",
      price: "40.0",
      delegations: [
        {validator: "0x00000000000000000000000000000000000000a1", amount: "300"}, // 12,000 USD
        {validator: "0x00000000000000000000000000000000000000b2", amount: "700"},
      ],
    });
    await ServiceManager.GetService(ModuleManager).initialize();
    let testSession = await runTestSession();
    let stakeInfo = testSession.getSessionData("hlstake.data");
    expect(stakeInfo?.delegated).to.equal(300, "validator filter not applied");
    expect(stakeInfo?.totalDelegated).to.equal(1000, "unexpected total delegated amount");
    expect(testSession.getDropAmount()).to.equal(200n, "unexpected boost with validator filter");
  }).timeout(5000);

  it("Continue without boost on api error (fail-open)", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig();
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    await ServiceManager.GetService(ModuleManager).initialize();
    let testSession = await runTestSession();
    let stakeInfo = testSession.getSessionData("hlstake.data");
    expect(!!stakeInfo?.error).to.equal(true, "no error marker in stake info");
    expect(testSession.getDropAmount()).to.equal(100n, "unexpected boost on api error");
  }).timeout(5000);

  it("Deny session on api error when failOnApiError is set", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig({failOnApiError: true});
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    await ServiceManager.GetService(ModuleManager).initialize();
    let error;
    try {
      await runTestSession();
    } catch(ex) {
      error = ex;
    }
    expect(!!error).to.equal(true, "no error thrown");
    expect(error.getCode()).to.equal("STAKE_CHECK_FAILED", "unexpected error code");
  }).timeout(5000);

  it("Deny session below required stake", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig({requiredStakeUsd: 30000});
    stubInfoApi({delegated: "500", price: "40.0"}); // 20,000 USD staked
    await ServiceManager.GetService(ModuleManager).initialize();
    let error: unknown;
    try {
      await runTestSession();
    } catch(ex) {
      error = ex;
    }
    expect(error instanceof PublicFaucetError).to.equal(true, "unexpected error type");
    if(!(error instanceof PublicFaucetError))
      throw new Error("expected a public stake requirement error");
    expect(error.getCode()).to.equal("STAKE_REQUIRED", "unexpected error code");
    expect(error.publicData).to.deep.equal({
      address: "0x0000000000000000000000000000000000001337",
    });
  }).timeout(5000);

  it("Cache the token price between sessions", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig();
    stubInfoApi({delegated: "500", price: "40.0"});
    await ServiceManager.GetService(ModuleManager).initialize();
    await runTestSession("0x0000000000000000000000000000000000001337");
    let callCount1 = globalStubs["fetch"].callCount;
    expect(callCount1).to.equal(3, "unexpected fetch count after session 1 (spot meta + price + summary)");
    await runTestSession("0x0000000000000000000000000000000000001338");
    expect(globalStubs["fetch"].callCount).to.equal(4, "unexpected fetch count after session 2 (cached price, new summary)");
  }).timeout(5000);

  it("Value stake at the spot mid, not the perp mid", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig();
    stubInfoApi({delegated: "500", price: "40.0", perpPrice: "60.0"}); // spot $20,000 vs perp $30,000
    await ServiceManager.GetService(ModuleManager).initialize();
    let testSession = await runTestSession();
    let stakeInfo = testSession.getSessionData("hlstake.data");
    expect(stakeInfo?.stakedUsd).to.equal(20000, "spot mid not used for valuation");
  }).timeout(5000);

  it("Fall back to the perp mid when spot metadata is unavailable", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig();
    stubInfoApi({delegated: "500", price: "40.0", noSpotMeta: true});
    await ServiceManager.GetService(ModuleManager).initialize();
    let testSession = await runTestSession();
    let stakeInfo = testSession.getSessionData("hlstake.data");
    expect(stakeInfo?.stakedUsd).to.equal(20000, "perp fallback not applied");
  }).timeout(5000);

  it("Enforce and expire the forced-refresh cooldown per address across sessions", async () => {
    const clock = sinon.useFakeTimers({now: Date.UTC(2026, 7, 22), toFake: ["Date"]});
    try {
      faucetConfig.modules["hyperliquid-stake"] = moduleConfig({fixedTokenPrice: 40});
      globalStubs["fetch"].resolves({
        status: 200,
        json: () => Promise.resolve({delegated: "500", undelegated: "0", totalPendingWithdrawal: "0", nPendingWithdrawals: 0}),
      });
      await ServiceManager.GetService(ModuleManager).initialize();
      let module = ServiceManager.GetService(ModuleManager).getModule<HyperliquidStakeModule>("hyperliquid-stake");
      let resolver = module.getStakeResolver();
      let refreshes: Map<string, number> = (resolver as any).forcedRefreshTimes;
      let address = "0x0000000000000000000000000000000000001337";
      expect(resolver.getForcedRefreshCooldown(address)).to.equal(0, "unexpected initial cooldown");
      await resolver.getStakeInfo(address, true);
      expect(resolver.getForcedRefreshCooldown(address)).to.equal(300, "no cooldown after forced refresh");
      expect(resolver.getForcedRefreshCooldown("0x0000000000000000000000000000000000001338")).to.equal(0, "cooldown leaked to another address");

      clock.tick(301_000);
      expect(resolver.getForcedRefreshCooldown(address)).to.equal(0, "expired forced refresh still imposed a cooldown");
      expect(refreshes.size).to.equal(0, "expired forced refresh still consumed tracking state");
    } finally {
      clock.restore();
    }
  }).timeout(5000);

  it("Bound and clear forced-refresh tracking", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig();
    stubInfoApi({delegated: "500", price: "40.0"});
    await ServiceManager.GetService(ModuleManager).initialize();
    let resolver = ServiceManager.GetService(ModuleManager).getModule<HyperliquidStakeModule>("hyperliquid-stake").getStakeResolver();
    let refreshes: Map<string, number> = (resolver as any).forcedRefreshTimes;
    let now = Math.floor(new Date().getTime() / 1000);
    for(let i = 0; i < 10005; i++)
      refreshes.set("0x" + i.toString(16).padStart(40, "0"), now);

    await resolver.getStakeInfo("0x00000000000000000000000000000000000fffff".substring(0, 42), true);
    expect(refreshes.size).to.equal(10000, "forced-refresh tracking exceeded its cap");
    await resolver.reload();
    expect(refreshes.size).to.equal(0, "forced-refresh tracking survived cache reset");
  }).timeout(10000);

  it("Keeps lookup admission closed until the previous generation drains", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig({fixedTokenPrice: 40});
    let releaseFetch: () => void;
    const fetchDrain = new Promise<void>((resolve) => releaseFetch = resolve);
    let observeAbort: () => void;
    const abortObserved = new Promise<void>((resolve) => observeAbort = resolve);
    globalStubs["fetch"].callsFake((url: string, init: any) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        observeAbort();
        fetchDrain.then(() => reject(new Error("aborted")));
      }, {once: true});
    }));
    await ServiceManager.GetService(ModuleManager).initialize();
    const resolver = ServiceManager.GetService(ModuleManager)
      .getModule<HyperliquidStakeModule>("hyperliquid-stake")
      .getStakeResolver();
    const oldLookup = resolver.getStakeInfo("0x0000000000000000000000000000000000001337").catch((error) => error);
    await awaitSleepPromise(1000, () => globalStubs["fetch"].callCount === 1);

    let reloadSettled = false;
    const reload = resolver.reload().then(() => reloadSettled = true);
    await abortObserved;
    const duringDrain = await resolver.getStakeInfo("0x0000000000000000000000000000000000001338").catch((error) => error);
    expect(duringDrain?.name).to.equal("HyperliquidStakeLookupInvalidatedError");
    expect(globalStubs["fetch"].callCount).to.equal(1, "new work reached the provider during the drain");
    await Promise.resolve();
    expect(reloadSettled).to.equal(false, "reload completed before the owned request drained");

    releaseFetch();
    expect((await oldLookup)?.name).to.equal("HyperliquidStakeLookupInvalidatedError");
    await reload;
    globalStubs["fetch"].resetBehavior();
    globalStubs["fetch"].resolves({
      status: 200,
      json: () => Promise.resolve({delegated: "500", undelegated: "0", totalPendingWithdrawal: "0", nPendingWithdrawals: 0}),
    });
    const fresh = await resolver.getStakeInfo("0x0000000000000000000000000000000000001338");
    expect(fresh.stakedUsd).to.equal(20000);
  }).timeout(5000);

  it("Serve stake info via web api for cached addresses", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig();
    stubInfoApi({delegated: "500", price: "40.0"});
    await ServiceManager.GetService(ModuleManager).initialize();
    await runTestSession("0x0000000000000000000000000000000000001337");
    let module = ServiceManager.GetService(ModuleManager).getModule<HyperliquidStakeModule>("hyperliquid-stake");
    let rsp = await (module as any).processGetStakeInfo({method: "GET"}, {query: {address: "0x0000000000000000000000000000000000001337"}});
    expect(rsp.stakeInfo?.stakedUsd).to.equal(20000, "unexpected staked usd value from api");
    expect(rsp.boost?.factor).to.equal(2, "unexpected boost factor from api");
    let invalidRsp = await (module as any).processGetStakeInfo({method: "GET"}, {query: {address: "not-an-address"}});
    expect(invalidRsp.code).to.equal("INVALID_ADDRESS", "unexpected response for invalid address");
  }).timeout(5000);

  it("Deny session on api error when stake is required (gate fails closed)", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig({requiredStakeUsd: 30000, failOnApiError: false});
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    await ServiceManager.GetService(ModuleManager).initialize();
    let error;
    try {
      await runTestSession();
    } catch(ex) {
      error = ex;
    }
    expect(!!error).to.equal(true, "no error thrown: the eligibility gate failed open on an api error");
    expect(error.getCode()).to.equal("STAKE_CHECK_FAILED", "unexpected error code");
  }).timeout(5000);

  it("Retry a failed spot market lookup after the short negative ttl", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig();
    stubInfoApi({delegated: "500", price: "40.0", perpPrice: "60.0", noSpotMeta: true});
    await ServiceManager.GetService(ModuleManager).initialize();
    let module = ServiceManager.GetService(ModuleManager).getModule<HyperliquidStakeModule>("hyperliquid-stake");
    let resolver = module.getStakeResolver();
    let info1 = await resolver.getStakeInfo("0x0000000000000000000000000000000000001337");
    expect(info1.stakedUsd).to.equal(30000, "perp fallback not used while spotMeta is unavailable");
    // spotMeta recovers, but the negative cache is still fresh: no immediate refetch
    stubInfoApi({delegated: "500", price: "40.0", perpPrice: "60.0"});
    (module.getStakeResolver() as any).priceCache = null;
    let info2 = await resolver.getStakeInfo("0x0000000000000000000000000000000000001338");
    expect(info2.stakedUsd).to.equal(30000, "negative spot-key cache not honored within its ttl");
    // age the negative cache past priceCacheTime: the next price fetch must retry spotMeta
    (module.getStakeResolver() as any).spotMarketKey.time -= 301;
    (module.getStakeResolver() as any).priceCache = null;
    let info3 = await resolver.getStakeInfo("0x0000000000000000000000000000000000001339");
    expect(info3.stakedUsd).to.equal(20000, "spot market key not re-resolved after the negative ttl expired");
  }).timeout(5000);

  it("Limit live guest lookups per ip and degrade to cache-only", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig({guestLookupRateLimit: 2});
    stubInfoApi({delegated: "500", price: "40.0"});
    await ServiceManager.GetService(ModuleManager).initialize();
    let module = ServiceManager.GetService(ModuleManager).getModule<HyperliquidStakeModule>("hyperliquid-stake");
    let req = (ip: string) => ({method: "GET", socket: {remoteAddress: ip}});
    let rsp1 = await (module as any).processGetStakeInfo(req("9.9.9.9"), {query: {address: "0x0000000000000000000000000000000000002001"}});
    expect(rsp1.stakeInfo?.stakedUsd).to.equal(20000, "first live guest lookup not served");
    let rsp2 = await (module as any).processGetStakeInfo(req("9.9.9.9"), {query: {address: "0x0000000000000000000000000000000000002002"}});
    expect(rsp2.stakeInfo?.stakedUsd).to.equal(20000, "second live guest lookup not served");
    let fetchCount = globalStubs["fetch"].callCount;
    let rsp3 = await (module as any).processGetStakeInfo(req("9.9.9.9"), {query: {address: "0x0000000000000000000000000000000000002003"}});
    expect(rsp3.stakeInfo).to.equal(null, "over-limit guest lookup was not degraded to cache-only");
    expect(globalStubs["fetch"].callCount).to.equal(fetchCount, "over-limit guest lookup still hit the info api");
    // a different ip has its own budget
    let rsp4 = await (module as any).processGetStakeInfo(req("9.9.9.10"), {query: {address: "0x0000000000000000000000000000000000002004"}});
    expect(rsp4.stakeInfo?.stakedUsd).to.equal(20000, "per-ip budget leaked across ips");
  }).timeout(5000);

  it("Cap the stake cache size under distinct-address flooding", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig();
    stubInfoApi({delegated: "500", price: "40.0"});
    await ServiceManager.GetService(ModuleManager).initialize();
    let module = ServiceManager.GetService(ModuleManager).getModule<HyperliquidStakeModule>("hyperliquid-stake");
    let resolver = module.getStakeResolver();
    let cache: Map<string, any> = (resolver as any).stakeCache;
    let now = Math.floor(new Date().getTime() / 1000);
    for(let i = 0; i < 10005; i++) {
      // all entries stay inside the age-based retention window (stakeCacheTime * 10),
      // so only the size cap can evict; times rise with i so entry 0 is the oldest
      cache.set("0x" + i.toString(16).padStart(40, "0"), {address: "0x" + i.toString(16).padStart(40, "0"), delegated: 0, totalDelegated: 0, stakedUsd: 0, tokenPrice: 40, time: now - 5000 + Math.floor(i / 3)});
    }
    await resolver.getStakeInfo("0x00000000000000000000000000000000000fffff".substring(0, 42));
    expect(cache.size).to.equal(10000, "stake cache size cap not enforced");
    expect(cache.has("0x" + (0).toString(16).padStart(40, "0"))).to.equal(false, "oldest cache entry not evicted first");
    expect(cache.has("0x" + (10004).toString(16).padStart(40, "0"))).to.equal(true, "recent cache entry evicted");
  }).timeout(10000);

  it("Do not let guests bypass the stake cache", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig();
    stubInfoApi({delegated: "500", price: "40.0"});
    await ServiceManager.GetService(ModuleManager).initialize();
    let module = ServiceManager.GetService(ModuleManager).getModule<HyperliquidStakeModule>("hyperliquid-stake");
    let req = () => ({method: "GET", socket: {remoteAddress: "9.9.9.9"}});
    let addr = "0x0000000000000000000000000000000000003001";
    await (module as any).processGetStakeInfo(req(), {query: {address: addr}});
    let fetchCount = globalStubs["fetch"].callCount;
    let now = Math.floor(new Date().getTime() / 1000);
    // the refresh query is intentionally cache-only for anonymous callers
    let rsp1 = await (module as any).processGetStakeInfo(req(), {query: {address: addr, refresh: "1"}});
    expect(globalStubs["fetch"].callCount).to.equal(fetchCount, "guest refresh bypassed the cache");
    expect(rsp1.cooldown > now).to.equal(true, "cache expiry not reported after guest lookup");
    let rsp2 = await (module as any).processGetStakeInfo(req(), {query: {address: addr, refresh: "1"}});
    expect(globalStubs["fetch"].callCount).to.equal(fetchCount, "repeated guest refresh hit the info api");
    expect(rsp2.stakeInfo?.stakedUsd).to.equal(20000, "cached stake info not served");
  }).timeout(5000);

  it("Serve stake refresh via web api with the session/address cooldown clamp", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig();
    stubInfoApi({delegated: "500", price: "40.0"});
    await ServiceManager.GetService(ModuleManager).initialize();
    let testSession = await runTestSession("0x0000000000000000000000000000000000001337");
    let module = ServiceManager.GetService(ModuleManager).getModule<HyperliquidStakeModule>("hyperliquid-stake");
    let sessionStub = sinon.stub(ServiceManager.GetService(SessionManager), "getSession").returns(testSession);
    try {
      let now = Math.floor(new Date().getTime() / 1000);
      // session start stamped hlstake.refresh, so the first refresh is in cooldown
      let rsp1 = await (module as any).processRefreshStakeInfo({method: "GET"}, {query: {session: "test"}});
      expect(rsp1.code).to.equal("REFRESH_COOLDOWN", "no cooldown right after session start");
      expect(rsp1.cooldown > now).to.equal(true, "cooldown is not an absolute epoch after session start");
      // session cooldown expired: refresh performs a live lookup and restamps
      testSession.setSessionData("hlstake.refresh", now - 400);
      let fetchCount = globalStubs["fetch"].callCount;
      let rsp2 = await (module as any).processRefreshStakeInfo({method: "GET"}, {query: {session: "test"}});
      expect(rsp2.code).to.equal(undefined, "refresh after cooldown was rejected");
      expect(globalStubs["fetch"].callCount).to.equal(fetchCount + 1, "refresh did not perform a live lookup");
      expect(rsp2.stakeInfo?.stakedUsd).to.equal(20000, "unexpected refreshed stake info");
      expect(rsp2.boost?.factor).to.equal(2, "unexpected refreshed boost");
      expect(rsp2.cooldown > now).to.equal(true, "no absolute cooldown epoch in refresh response");
      // the global per-address cooldown (stamped by the forced refresh) outlasts a
      // reset session cooldown: max() clamp keeps the refresh rejected
      testSession.setSessionData("hlstake.refresh", now - 400);
      let rsp3 = await (module as any).processRefreshStakeInfo({method: "GET"}, {query: {session: "test"}});
      expect(rsp3.code).to.equal("REFRESH_COOLDOWN", "per-address cooldown not clamped into session refresh");
      // no session -> INVALID_SESSION
      sessionStub.returns(null);
      let rsp4 = await (module as any).processRefreshStakeInfo({method: "GET"}, {query: {session: "test"}});
      expect(rsp4.code).to.equal("INVALID_SESSION", "missing session not rejected");
    } finally {
      sessionStub.restore();
    }
  }).timeout(5000);

  it("Back off to cache-only when too many lookups are in flight", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig();
    stubInfoApi({delegated: "500", price: "40.0"});
    await ServiceManager.GetService(ModuleManager).initialize();
    let module = ServiceManager.GetService(ModuleManager).getModule<HyperliquidStakeModule>("hyperliquid-stake");
    let resolver = module.getStakeResolver();
    let req = {method: "GET", socket: {remoteAddress: "9.9.9.9"}};
    // saturate the in-flight tracker with pending lookups
    let pending: Map<string, Promise<any>> = (resolver as any).stakePromises;
    for(let i = 0; i < 8; i++)
      pending.set("0x" + (9000 + i).toString(16).padStart(40, "0"), new Promise(() => {}));
    try {
      expect(resolver.getInflightCount()).to.equal(8, "in-flight tracker not saturated");
      let fetchCount = globalStubs["fetch"].callCount;
      let rsp = await (module as any).processGetStakeInfo(req, {query: {address: "0x0000000000000000000000000000000000004001"}});
      expect(rsp.stakeInfo).to.equal(null, "saturated guest lookup was not degraded to cache-only");
      expect(globalStubs["fetch"].callCount).to.equal(fetchCount, "saturated guest lookup still hit the info api");
    } finally {
      pending.clear();
    }
    // the tracker releases its slot once a lookup settles
    await resolver.getStakeInfo("0x0000000000000000000000000000000000004002");
    expect(resolver.getInflightCount()).to.equal(0, "in-flight slot not released after lookup settled");
  }).timeout(5000);

  it("Share the live lookup budget between guests and session admission", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig({guestLookupRateLimit: 1});
    stubInfoApi({delegated: "500", price: "40.0"});
    await ServiceManager.GetService(ModuleManager).initialize();
    let module = ServiceManager.GetService(ModuleManager).getModule<HyperliquidStakeModule>("hyperliquid-stake");
    let guestResponse = await (module as any).processGetStakeInfo(
      {method: "GET", socket: {remoteAddress: "8.8.8.8"}},
      {query: {address: "0x0000000000000000000000000000000000005001"}}
    );
    expect(guestResponse.stakeInfo?.stakedUsd).to.equal(20000, "guest lookup failed");
    let fetchCount = globalStubs["fetch"].callCount;

    let session = await runTestSession("0x0000000000000000000000000000000000005002");
    expect(globalStubs["fetch"].callCount).to.equal(fetchCount, "session admission bypassed the shared IP budget");
    expect(session.getSessionData("hlstake.data")?.error).to.equal("Stake lookup unavailable", "rate-limited admission did not use the configured fail-open policy");
    expect(session.getDropAmount()).to.equal(100n, "rate-limited admission received a stake boost");
  }).timeout(5000);

  it("Reject non-finite stake values from the info api", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig();
    stubInfoApi({delegated: "Infinity", price: "40.0"});
    await ServiceManager.GetService(ModuleManager).initialize();
    let session = await runTestSession();
    expect(session.getSessionData("hlstake.data")?.error).to.equal("Stake lookup unavailable", "non-finite stake value was accepted");
    expect(session.getDropAmount()).to.equal(100n, "non-finite stake value affected the reward");
  }).timeout(5000);

  it("Abort timed out info api requests", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig({requestTimeout: 20, failOnApiError: true});
    let abortedRequests = 0;
    globalStubs["fetch"].callsFake((url: string, init: any) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        abortedRequests++;
        reject(new Error("aborted"));
      }, {once: true});
    }));
    await ServiceManager.GetService(ModuleManager).initialize();
    let error;
    try {
      await runTestSession();
    } catch(ex) {
      error = ex;
    }
    expect(error?.getCode()).to.equal("STAKE_CHECK_FAILED", "timed out stake request did not fail under failOnApiError");
    expect(abortedRequests).to.be.greaterThan(0, "request timeout did not abort the underlying fetch");
  }).timeout(5000);

  it("Reject non-finite stake configuration", async () => {
    faucetConfig.modules["hyperliquid-stake"] = moduleConfig({fixedTokenPrice: Infinity});
    let error;
    try {
      await ServiceManager.GetService(ModuleManager).initialize();
    } catch(ex) {
      error = ex;
    }
    expect(String(error)).to.match(/fixedTokenPrice/, "non-finite fixed token price was accepted");
  }).timeout(5000);

});
