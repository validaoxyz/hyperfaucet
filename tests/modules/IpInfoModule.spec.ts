import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import YAML from 'yaml'
import { awaitSleepPromise, bindTestStubs, unbindTestStubs, loadDefaultTestConfig, returnDelayedPromise } from '../common.js';
import { FetchUtil } from '../../src/utils/FetchUtil.js';
import { ServiceManager } from '../../src/common/ServiceManager.js';
import { FaucetDatabase } from '../../src/db/FaucetDatabase.js';
import { ModuleHookAction, ModuleManager } from '../../src/modules/ModuleManager.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { faucetConfig } from '../../src/config/FaucetConfig.js';
import { FaucetError, PublicFaucetError } from '../../src/common/FaucetError.js';
import { IIPInfoConfig } from '../../src/modules/ipinfo/IPInfoConfig.js';
import { FaucetSession } from '../../src/session/FaucetSession.js';
import { IPInfoModule } from '../../src/modules/ipinfo/IPInfoModule.js';
import { IPInfoResolver } from '../../src/modules/ipinfo/IPInfoResolver.js';
import { sleepPromise } from '../../src/utils/PromiseUtils.js';
import { FaucetProcess } from '../../src/common/FaucetProcess.js';


describe("Faucet module: ipinfo", () => {
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

  const testIPInfoResponse = {
    "status":"success",
    "query":"8.8.8.8",
    "country":"United States",
    "countryCode":"US",
    "region":"VA",
    "regionName":"Virginia",
    "city":"Ashburn",
    "zip":"20149",
    "lat":39.03,"lon":-77.5,
    "timezone":"America/New_York",
    "isp":"Google LLC",
    "org":"Google Public DNS",
    "as":"AS15169 Google LLC",
    "asname":"GOOGLE",
    "proxy":false,"hosting":true
  };

  function tmpFile(prefix?: string, suffix?: string, tmpdir?: string): string {
    prefix = (typeof prefix !== 'undefined') ? prefix : 'tmp.';
    suffix = (typeof suffix !== 'undefined') ? suffix : '';
    tmpdir = tmpdir ? tmpdir : os.tmpdir();
    return path.join(tmpdir, prefix + crypto.randomBytes(16).toString('hex') + suffix);
  }

  it("Rejects a cleartext IP info endpoint", async () => {
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "http://test-api-info-check.com/{ip}",
      cacheTime: 86400,
      required: false,
      restrictions: null,
      restrictionsPattern: {},
      restrictionsFile: null,
    } as IIPInfoConfig;

    let error: Error | null = null;
    try {
      await ServiceManager.GetService(ModuleManager).initialize();
    } catch(ex) {
      error = ex;
    }
    expect(error?.message).to.include("ipinfo apiUrl must use HTTPS");
  });

  it("Rejects an IP placeholder in the provider authority", async () => {
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://{ip}/lookup",
      cacheTime: 86400,
      required: false,
      restrictions: null,
      restrictionsPattern: {},
      restrictionsFile: null,
    } as IIPInfoConfig;

    let error: Error | null = null;
    try {
      await ServiceManager.GetService(ModuleManager).initialize();
    } catch(ex) {
      error = ex;
    }
    expect(error?.message).to.include("must not place {ip} in the URL authority");
  });

  it("Normalizes the default HTTPS provider response", async () => {
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://api.ipapi.is/?q={ip}",
      cacheTime: 86400,
      required: true,
      restrictions: { hosting: 50 },
      restrictionsPattern: {},
      restrictionsFile: null,
    } as IIPInfoConfig;
    globalStubs["fetch"].resolves({
      json: () => Promise.resolve({
        ip: "8.8.8.8",
        is_datacenter: true,
        is_proxy: false,
        is_vpn: false,
        is_tor: false,
        company_name: "Google LLC",
        asn_num: 15169,
        asn_org: "Google LLC",
        cc: "US",
        lat: 37.4,
        lon: -122.1,
      }),
    });
    await ServiceManager.GetService(ModuleManager).initialize();

    let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let ipInfo = testSession.getSessionData<any>("ipinfo.data");
    expect(testSession.getDropAmount()).to.equal(50n, "hosting restriction was not applied");
    expect(ipInfo.countryCode).to.equal("US");
    expect(ipInfo.as).to.equal("AS15169 Google LLC");
    expect(globalStubs["fetch"].firstCall.args[0]).to.equal("https://api.ipapi.is/?q=8.8.8.8");
    expect(globalStubs["fetch"].firstCall.args[1].redirect).to.equal("error");
    expect(globalStubs["fetch"].firstCall.args[1].size).to.equal(64 * 1024);
    expect(globalStubs["fetch"].firstCall.args[1].signal).to.be.instanceOf(AbortSignal);
  });

  it("Rejects unbound or incomplete IP classification responses", async () => {
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://test-api-info-check.com/{ip}",
      cacheTime: 86400,
      required: false,
      restrictions: null,
      restrictionsPattern: {},
      restrictionsFile: null,
    } as IIPInfoConfig;
    globalStubs["fetch"].onFirstCall().resolves({
      json: () => Promise.resolve({...testIPInfoResponse, query: "1.1.1.1"}),
    });
    globalStubs["fetch"].onSecondCall().resolves({
      json: () => Promise.resolve({...testIPInfoResponse, query: "8.8.4.4", hosting: undefined}),
    });
    await ServiceManager.GetService(ModuleManager).initialize();
    let resolver = ServiceManager.GetService(ModuleManager).getModule<any>("ipinfo").ipInfoResolver;

    let mismatched = await resolver.getIpInfo("8.8.8.8");
    let incomplete = await resolver.getIpInfo("8.8.4.4");

    expect(mismatched.status).to.include("does not match the requested IP");
    expect(incomplete.status).to.include("missing classification flags");
  });

  it("Caps distinct in-flight IP lookups", async () => {
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://test-api-info-check.com/{ip}",
      cacheTime: 86400,
      required: false,
      restrictions: null,
      restrictionsPattern: {},
      restrictionsFile: null,
    } as IIPInfoConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    let resolver = ServiceManager.GetService(ModuleManager).getModule<any>("ipinfo").ipInfoResolver;
    let pending: Map<string, Promise<any>> = resolver.ipInfoPromises;
    for(let i = 0; i < 64; i++)
      pending.set("192.0.2." + i, new Promise(() => {}));
    try {
      let result = await resolver.getIpInfo("8.8.8.8");
      expect(result.status).to.include("capacity reached");
      expect(globalStubs["fetch"].callCount).to.equal(0, "capacity overflow reached the provider");
    } finally {
      pending.clear();
    }
  });

  it("Aborts and drains IP lookups when the generation changes", async () => {
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://old-info.test/{ip}",
      cacheTime: 86400,
      required: false,
      restrictions: null,
      restrictionsPattern: {},
      restrictionsFile: null,
    } as IIPInfoConfig;
    let abortObserved = false;
    globalStubs["fetch"].onFirstCall().callsFake((url: string, init: any) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        abortObserved = true;
        reject(new Error("aborted"));
      }, {once: true});
    }));
    globalStubs["fetch"].onSecondCall().resolves({
      json: () => Promise.resolve({...testIPInfoResponse, query: "8.8.4.4"}),
    });
    await ServiceManager.GetService(ModuleManager).initialize();
    let resolver = ServiceManager.GetService(ModuleManager).getModule<any>("ipinfo").ipInfoResolver;
    let oldLookup = resolver.getIpInfo("8.8.4.4");
    await awaitSleepPromise(1000, () => globalStubs["fetch"].callCount === 1);

    await resolver.reload("https://new-info.test/{ip}", 60);
    let oldError: Error | null = null;
    try {
      await oldLookup;
    } catch(ex) {
      oldError = ex;
    }
    let fresh = await resolver.getIpInfo("8.8.4.4");

    expect(abortObserved).to.equal(true, "generation change did not abort the provider request");
    expect(oldError?.name).to.equal("IPInfoLookupInvalidatedError");
    expect(fresh.status).to.equal("success");
    expect(globalStubs["fetch"].secondCall.args[0]).to.equal("https://new-info.test/8.8.4.4");
  });

  it("Does not serve a cache write completed by an invalidated generation", async () => {
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://old-info.test/{ip}",
      cacheTime: 86400,
      required: false,
      restrictions: null,
      restrictionsPattern: {},
      restrictionsFile: null,
    } as IIPInfoConfig;
    globalStubs["fetch"].onFirstCall().resolves({
      status: 200,
      json: () => Promise.resolve({...testIPInfoResponse, query: "8.8.8.8", countryCode: "US"}),
    });
    globalStubs["fetch"].onSecondCall().resolves({
      status: 200,
      json: () => Promise.resolve({...testIPInfoResponse, query: "8.8.8.8", countryCode: "CA"}),
    });
    await ServiceManager.GetService(ModuleManager).initialize();
    const module = ServiceManager.GetService(ModuleManager).getModule<any>("ipinfo");
    const resolver: IPInfoResolver = module.ipInfoResolver;
    const db = module.ipInfoDb;
    const originalSetIPInfo = db.setIPInfo.bind(db);
    let releaseWrite: () => void;
    const writeGate = new Promise<void>((resolve) => releaseWrite = resolve);
    let observeWrite: () => void;
    const writeStarted = new Promise<void>((resolve) => observeWrite = resolve);
    const setStub = sinon.stub(db, "setIPInfo").callsFake(async (ip: string, info: any, duration?: number) => {
      observeWrite();
      await writeGate;
      await originalSetIPInfo(ip, info, duration);
    });

    try {
      const oldLookup = resolver.getIpInfo("8.8.8.8").catch((error) => error);
      await writeStarted;
      const reload = resolver.reload("https://new-info.test/{ip}", 60);
      let admissionError: Error | null = null;
      try {
        resolver.getIpInfo("8.8.4.4");
      } catch(error) {
        admissionError = error as Error;
      }
      expect(admissionError?.name).to.equal("IPInfoLookupInvalidatedError");

      releaseWrite();
      expect((await oldLookup)?.name).to.equal("IPInfoLookupInvalidatedError");
      await reload;
      const fresh = await resolver.getIpInfo("8.8.8.8");
      expect(fresh.countryCode).to.equal("CA", "the invalidated provider result was served from cache");
      expect(globalStubs["fetch"].callCount).to.equal(2, "fresh generation did not bypass the stale cache row");
    } finally {
      setStub.restore();
    }
  });

  it("Applies a rolling provider request budget", async () => {
    let now = 0;
    const fakeDb = {
      getIPInfo: sinon.stub().resolves(null),
      setIPInfo: sinon.stub().resolves(),
    } as any;
    const resolver = new IPInfoResolver(fakeDb, "https://provider.test/{ip}", 60, {
      maxProviderRequests: 2,
      providerWindowMs: 1000,
      initialProviderBackoffMs: 1000,
      maxProviderBackoffMs: 4000,
      now: () => now,
    });
    globalStubs["fetch"].callsFake((url: string) => {
      const ip = new URL(url).pathname.substring(1);
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({...testIPInfoResponse, query: ip}),
      });
    });

    expect((await resolver.getIpInfo("8.8.8.8")).status).to.equal("success");
    expect((await resolver.getIpInfo("8.8.4.4")).status).to.equal("success");
    const limited = await resolver.getIpInfo("1.1.1.1");
    expect(limited.status).to.include("provider request budget reached");
    expect(globalStubs["fetch"].callCount).to.equal(2);

    now = 1000;
    expect((await resolver.getIpInfo("1.0.0.1")).status).to.equal("success");
    expect(globalStubs["fetch"].callCount).to.equal(3);
    await resolver.stop();
  });

  it("Backs off provider requests after an outage and recovers on success", async () => {
    let now = 0;
    const fakeDb = {
      getIPInfo: sinon.stub().resolves(null),
      setIPInfo: sinon.stub().resolves(),
    } as any;
    const resolver = new IPInfoResolver(fakeDb, "https://provider.test/{ip}", 60, {
      maxProviderRequests: 10,
      providerWindowMs: 60_000,
      providerFailureThreshold: 1,
      initialProviderBackoffMs: 1000,
      maxProviderBackoffMs: 4000,
      now: () => now,
    });
    globalStubs["fetch"].onFirstCall().rejects(new Error("provider unavailable"));
    globalStubs["fetch"].onSecondCall().resolves({
      status: 200,
      json: () => Promise.resolve({...testIPInfoResponse, query: "1.1.1.1"}),
    });

    expect((await resolver.getIpInfo("8.8.8.8")).status).to.include("provider unavailable");
    now = 999;
    expect((await resolver.getIpInfo("8.8.4.4")).status).to.include("provider backoff active");
    expect(globalStubs["fetch"].callCount).to.equal(1);

    now = 1000;
    expect((await resolver.getIpInfo("1.1.1.1")).status).to.equal("success");
    expect(globalStubs["fetch"].callCount).to.equal(2);
    await resolver.stop();
  });

  it("Request IP info on session start", async () => {
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://test-api-info-check.com/{ip}",
      cacheTime: 86400,
      required: false,
      restrictions: null,
      restrictionsPattern: {},
      restrictionsFile: null,
    } as IIPInfoConfig;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve(testIPInfoResponse)
    }));
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    let ipInfo = testSession.getSessionData("ipinfo.data");
    expect(!!ipInfo).to.equal(true, "no ipinfo object found");
    
  });

  it("Start session with failed IP info request (failed status)", async () => {
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://test-api-info-check.com/{ip}",
      cacheTime: 86400,
      required: true,
      restrictions: null,
      restrictionsPattern: {},
      restrictionsFile: null,
    } as IIPInfoConfig;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve({status: "failed"})
    }));
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let error: FaucetError | null = null;
    try {
      await sessionManager.createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("INVALID_IPINFO", "unexpected error code");
  });

  it("Start session with failed IP info request (api error)", async () => {
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://test-api-info-check.com/{ip}",
      cacheTime: 86400,
      required: true,
      restrictions: null,
      restrictionsPattern: {},
      restrictionsFile: null,
    } as IIPInfoConfig;
    globalStubs["fetch"].returns(returnDelayedPromise(false, "something bad happened"));
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let error: FaucetError | null = null;
    try {
      await sessionManager.createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("INVALID_IPINFO", "unexpected error code");
  });

  it("Start session from blocked IP", async () => {
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://test-api-info-check.com/{ip}",
      cacheTime: 86400,
      required: true,
      restrictions: {
        hosting: 50,
        US: {
          reward: 1,
          blocked: true,
        },
      },
      restrictionsPattern: {},
      restrictionsFile: null,
    } as IIPInfoConfig;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve(testIPInfoResponse)
    }));
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let error: FaucetError | null = null;
    try {
      await sessionManager.createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof PublicFaucetError).to.equal(true, "unexpected error type");
    if(!(error instanceof PublicFaucetError))
      throw new Error("expected a public IP restriction error");
    expect(error?.getCode()).to.equal("IPINFO_RESTRICTION", "unexpected error code");
    expect(error.publicData).to.deep.equal({
      address: "0x0000000000000000000000000000000000001337",
      ipflags: [true, false],
    });
  });

  it("check ipinfo caching (no double request for same IP)", async () => {
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://test-api-info-check.com/{ip}",
      cacheTime: 86400,
      required: true,
      restrictions: {
        hosting: 100,
        proxy: 50,
        DE: 50,
      },
      restrictionsPattern: {},
      restrictionsFile: null,
    } as IIPInfoConfig;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve(testIPInfoResponse)
    }));
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession1 = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession1.getSessionStatus()).to.equal("claimable", "unexpected session 1 status");
    expect(globalStubs["fetch"].callCount).to.equal(1, "unexpected fetch call count after session 2 start");
    await sleepPromise(50);
    let testSession2 = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001338",
    });
    expect(testSession2.getSessionStatus()).to.equal("claimable", "unexpected session 2 status");
    expect(globalStubs["fetch"].callCount).to.equal(1, "unexpected fetch call count after session 2 start");
  });

  it("expires IP info using the configured cache time", async () => {
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://test-api-info-check.com/{ip}",
      cacheTime: 1,
      required: true,
      restrictions: {
        hosting: 100,
        proxy: 50,
        DE: 50,
      },
      restrictionsPattern: {},
      restrictionsFile: null,
    } as IIPInfoConfig;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve(testIPInfoResponse)
    }));
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession1 = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession1.getSessionStatus()).to.equal("claimable", "unexpected session 1 status");
    expect(globalStubs["fetch"].callCount).to.equal(1, "unexpected fetch call count after session 2 start");

    let ipinfoModule = ServiceManager.GetService(ModuleManager).getModule<any>("ipinfo");
    ipinfoModule.ipInfoDb.now = () => Math.floor(Date.now() / 1000) + 2;
    await ipinfoModule.ipInfoDb.cleanStore();

    let testSession2 = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001338",
    });
    expect(testSession2.getSessionStatus()).to.equal("claimable", "unexpected session 2 status");
    expect(globalStubs["fetch"].callCount).to.equal(2, "unexpected fetch call count after session 2 start");
  });

  it("check ipinfo based restriction (no restriction)", async () => {
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://test-api-info-check.com/{ip}",
      cacheTime: 86400,
      required: false,
      restrictions: {
        hosting: 100,
        proxy: 50,
        DE: 50,
      },
      restrictionsPattern: {},
      restrictionsFile: null,
    } as IIPInfoConfig;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve(testIPInfoResponse)
    }));
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(testSession.getDropAmount()).to.equal(100n, "unexpected drop amount");
  });

  it("check ipinfo based restriction (50% restriction)", async () => {
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://test-api-info-check.com/{ip}",
      cacheTime: 86400,
      required: false,
      restrictions: {
        hosting: 50,
        US: 75,
      },
      restrictionsPattern: {},
      restrictionsFile: null,
    } as IIPInfoConfig;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve(testIPInfoResponse)
    }));
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(testSession.getDropAmount()).to.equal(50n, "unexpected drop amount");
  });

  it("check ipinfo-pattern based restriction (50% restriction)", async () => {
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://test-api-info-check.com/{ip}",
      cacheTime: 86400,
      required: false,
      restrictions: null,
      restrictionsPattern: {
        "^.*Google.*$": 50
      },
      restrictionsFile: null,
    } as IIPInfoConfig;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve(testIPInfoResponse)
    }));
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(testSession.getDropAmount()).to.equal(50n, "unexpected drop amount");
  });

  it("check ipinfo-pattern based restriction (50% restriction, from yaml file)", async () => {
    let patternFile = tmpFile("powfaucet-", "-ipinfo.txt");
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://test-api-info-check.com/{ip}",
      cacheTime: 86400,
      required: false,
      restrictions: null,
      restrictionsPattern: {},
      restrictionsFile: {
        refresh: 10,
        yaml: patternFile,
      },
    } as IIPInfoConfig;
    let restrictions = {
      restrictions: [
        {
          pattern: "^.*Google.*$",
          reward: 50,
        }
      ]
    };
    fs.writeFileSync(patternFile, YAML.stringify(restrictions));
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve(testIPInfoResponse)
    }));
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(testSession.getDropAmount()).to.equal(50n, "unexpected drop amount");
  });

  it("check ipinfo-pattern based restriction (50% restriction, from list file)", async () => {
    let patternFile = tmpFile("powfaucet-", "-ipinfo.txt");
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://test-api-info-check.com/{ip}",
      cacheTime: 86400,
      required: false,
      restrictions: null,
      restrictionsPattern: {},
      restrictionsFile: {
        refresh: 10,
        file: patternFile,
      },
    } as IIPInfoConfig;
    let restrictions = [
      "junk_line",
      "50: ^.*Google.*$"
    ];
    fs.writeFileSync(patternFile, restrictions.join("\n"));
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve(testIPInfoResponse)
    }));
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(testSession.getDropAmount()).to.equal(50n, "unexpected drop amount");
  });

  it("check refreshed restrictions on running session (block session)", async () => {
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://test-api-info-check.com/{ip}",
      cacheTime: 86400,
      required: false,
      restrictions: {
      },
      restrictionsPattern: {},
      restrictionsFile: null,
    } as IIPInfoConfig;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve(testIPInfoResponse)
    }));
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test1", 1);
    });
    ServiceManager.GetService(ModuleManager).getModule<any>("ipinfo").sessionRewardFactorCacheTimeout = 0;
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status before restriction update");
    await testSession.addReward(50n);
    (faucetConfig.modules["ipinfo"] as any).restrictions["US"] = {
      blocked: true,
    };
    ServiceManager.GetService(FaucetProcess).emit("reload");
    await sleepPromise(1000);
    let rejectedReward = await testSession.addReward(10n);
    await sleepPromise(100);
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status after restriction update");
    expect(rejectedReward).to.equal(0n, "reward was committed after the restriction closed the session");
    expect(testSession.getDropAmount()).to.equal(50n, "closed session balance changed after persistence");
  });

  it("check refreshed restrictions on running session (kill session)", async () => {
    faucetConfig.modules["ipinfo"] = {
      enabled: true,
      apiUrl: "https://test-api-info-check.com/{ip}",
      cacheTime: 86400,
      required: false,
      restrictions: {
      },
      restrictionsPattern: {},
      restrictionsFile: null,
    } as IIPInfoConfig;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve(testIPInfoResponse)
    }));
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test1", 1);
    });
    ServiceManager.GetService(ModuleManager).getModule<any>("ipinfo").sessionRewardFactorCacheTimeout = 0;
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status before restriction update");
    await testSession.addReward(50n);
    (faucetConfig.modules["ipinfo"] as any).restrictions["US"] = {
      blocked: "kill",
      message: "bye bye"
    };
    await sleepPromise(1000);
    await testSession.addReward(10n);
    await sleepPromise(100);
    expect(testSession.getSessionStatus()).to.equal("failed", "unexpected session status after restriction update");
  });

});
