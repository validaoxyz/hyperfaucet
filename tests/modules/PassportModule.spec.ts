import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventEmitter } from 'node:events';
import { awaitSleepPromise, bindTestStubs, unbindTestStubs, loadDefaultTestConfig, returnDelayedPromise } from '../common.js';
import { FetchUtil } from '../../src/utils/FetchUtil.js';
import { ServiceManager } from '../../src/common/ServiceManager.js';
import { FaucetDatabase } from '../../src/db/FaucetDatabase.js';
import { ModuleHookAction, ModuleManager } from '../../src/modules/ModuleManager.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { faucetConfig } from '../../src/config/FaucetConfig.js';
import { DATA as testData } from './PassportModule.data.js';
import { FaucetSession } from '../../src/session/FaucetSession.js';
import { FaucetWebApi } from '../../src/webserv/FaucetWebApi.js';
import { FaucetHttpResponse } from '../../src/webserv/FaucetHttpServer.js';
import { toClientFailure } from '../../src/webserv/PublicErrors.js';
import { PublicFaucetError } from '../../src/common/FaucetError.js';
import {
  PassportLookupCapacityError,
  PassportLookupInvalidatedError,
  PassportResolver,
  type IPassportInfo,
} from '../../src/modules/passport/PassportResolver.js';
import { PassportModule } from '../../src/modules/passport/PassportModule.js';
import { PassportDB } from '../../src/modules/passport/PassportDB.js';
import {
  PassportDIDKitVerifier,
  PassportVerificationUnavailableError,
} from '../../src/modules/passport/PassportDIDKitVerifier.js';
import type { PassportWorkerRequest } from '../../src/modules/passport/PassportWorker.js';
import { PromiseDfd } from '../../src/utils/PromiseDfd.js';
import { PASSPORT_SCORE_SCALE } from '../../src/modules/passport/PassportConfig.js';

class TestPassportWorker extends EventEmitter {
  public readonly messages: PassportWorkerRequest[] = [];
  public terminateCalls = 0;
  public onPostMessage?: (message: PassportWorkerRequest) => void;
  public terminateImpl: () => Promise<number> = () => Promise.resolve(0);

  public postMessage(message: PassportWorkerRequest): void {
    this.messages.push(message);
    this.onPostMessage?.(message);
  }

  public terminate(): Promise<number> {
    this.terminateCalls++;
    return this.terminateImpl();
  }

  public send(message: unknown): void {
    this.emit("message", message);
  }
}


describe("Faucet module: passport", () => {
  let globalStubs;

  beforeEach(async () => {
    globalStubs = bindTestStubs({
      "fetch": sinon.stub(FetchUtil, "fetch"),
    });
    loadDefaultTestConfig();
    await ServiceManager.GetService(FaucetDatabase).initialize();
  });
  afterEach(async () => {
    let dbService = ServiceManager.GetService(FaucetDatabase);
    await ServiceManager.DisposeAllServices();
    await dbService.closeDatabase();
    await unbindTestStubs(globalStubs);
  });

  function tmpFolder(prefix?: string, suffix?: string, tmpdir?: string): string {
    prefix = (typeof prefix !== 'undefined') ? prefix : 'tmp.';
    suffix = (typeof suffix !== 'undefined') ? suffix : '';
    tmpdir = tmpdir ? tmpdir : os.tmpdir();
    return path.join(tmpdir, prefix + crypto.randomBytes(16).toString('hex') + suffix);
  }

  async function createRunningPassportSession(): Promise<FaucetSession> {
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession) => {
      session.addBlockingTask("test", "test", 1);
    });
    return ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
    });
  }

  function cloneScorerResponse(): any {
    return JSON.parse(JSON.stringify((testData as any).testPassport1Rsp));
  }

  function scorerResponseForAddress(address: string): any {
    let response = cloneScorerResponse();
    for(let item of response.items)
      item.credential.credentialSubject.id = "did:pkh:eip155:1:" + address;
    return response;
  }

  it("Check client config exports", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      refreshCooldown: 30,
      trustedIssuers: [ "did:key:z6MkghvGHLobLEdj1bgRLhS4LPGJAvbMA1tn2zcRyqmYU5LC" ],
      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
      requireMinScore: 5,
      skipHostingCheckScore: 10,
      skipProxyCheckScore: 20,
      allowGuestRefresh: true,
      guestRefreshCooldown: 60,
    } as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let clientConfig = await ServiceManager.GetService(FaucetWebApi).onGetFaucetConfig();
    expect(!!clientConfig.modules['passport']).to.equal(true, "no passport config exported");
    expect(clientConfig.modules['passport'].refreshTimeout).to.equal(30, "client config mismatch: refreshTimeout");
    expect(clientConfig.modules['passport'].manualVerification).to.equal(true, "client config mismatch: manualVerification");
    expect(JSON.stringify(clientConfig.modules['passport'].stampScoring)).to.equal(JSON.stringify((faucetConfig.modules["passport"] as any).stampScoring), "client config mismatch: stampScoring");
    expect(JSON.stringify(clientConfig.modules['passport'].overrideScores)).to.equal(JSON.stringify([10, 20, 5]), "client config mismatch: overrideScores");
    expect(clientConfig.modules['passport'].guestRefresh).to.equal(60, "client config mismatch: guestRefresh");
  }).timeout(6000); // might take longer than the other passport tests, because the didkit lib is loaded when the module gets enabled first

  it("Start session with successful passport request", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
      skipHostingCheckScore: 2,
      skipProxyCheckScore: 2,
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve((testData as any).testPassport1Rsp)
    }));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(globalStubs["fetch"].callCount).to.equal(1, "unexpected fetch call count");
    expect(globalStubs["fetch"].firstCall.args[1].redirect).to.equal("error");
    expect(globalStubs["fetch"].firstCall.args[1].size).to.equal(256 * 1024);
    expect(globalStubs["fetch"].firstCall.args[1].signal).to.be.instanceOf(AbortSignal);
    let passportData = testSession.getSessionData("passport.data");
    expect(passportData?.found).to.equal(true, "no passport data found")
    let passportScore = testSession.getSessionData("passport.score");
    expect(passportScore?.score).to.equal(2, "unexpected passport score");
    expect(passportScore?.factor).to.equal(4, "unexpected passport factor");
    let clientInfo = await testSession.getSessionInfo();
    expect(!!(clientInfo.modules as any)["passport"]).to.equal(false, "unexpected passport info in client session info");
    expect(testSession.getSessionData("ipinfo.override_hosting")).to.equal(false, "unexpected ipinfo.override_hosting value");
    expect(testSession.getSessionData("ipinfo.override_proxy")).to.equal(false, "unexpected ipinfo.override_proxy value");
  });

  it("Start session with too low passport score", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
      requireMinScore: 4,
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve((testData as any).testPassport1Rsp)
    }));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);

    let error: unknown;
    try {
      await sessionManager.createSession("::ffff:8.8.8.8", {
        addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
      });
    } catch(ex) {
      error = ex;
    }

    expect(error).to.be.instanceOf(PublicFaucetError, "passport score failure was not explicitly public");
    expect(toClientFailure(error, "while testing passport score", true)).to.deep.equal({
      failedCode: "PASSPORT_SCORE",
      failedReason: "You need a passport score of at least 4 to use this faucet.",
      failedData: {address: "0x332e43696a505ef45b9319973785f837ce5267b9"},
    });
  });

  it("Start session with passport api error", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    let passportData = testSession.getSessionData("passport.data");
    expect(passportData?.found).to.equal(false, "unexpected passport data found")
    let passportScore = testSession.getSessionData("passport.score");
    expect(passportScore?.score).to.equal(0, "unexpected passport score");
    expect(passportScore?.factor).to.equal(1, "unexpected passport factor");
  });

  it("Send passport info to client for running sessions", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve((testData as any).testPassport1Rsp)
    }));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
    let clientInfo = await testSession.getSessionInfo();
    expect(!!(clientInfo.modules as any)["passport"]).to.equal(true, "missing passport info in client session info");
    expect((clientInfo.modules as any)["passport"].score).to.equal(2, "unexpected passport score");
    expect((clientInfo.modules as any)["passport"].factor).to.equal(4, "unexpected passport factor");
  });

  it("Get passport details for running session", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve((testData as any).testPassport1Rsp)
    }));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
    
    let passportDetailsRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: "/api/getPassportInfo?session=" + testSession.getSessionId(),
    } as any, undefined);
    expect(passportDetailsRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(passportDetailsRsp.passport?.found).to.equal(true, "no passport details returned");
    expect(passportDetailsRsp.score.score).to.equal(2, "unexpected passport score");
    expect(passportDetailsRsp.score.factor).to.equal(4, "unexpected passport factor");
  });

  it("Get passport details for unknown session", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
    } as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportDetailsRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: "/api/getPassportInfo?session=62dff880-ffe6-4472-a19a-0859e134456f",
    } as any, undefined);
    expect(passportDetailsRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(!!passportDetailsRsp.error).to.equal(true, "no error returned");
    expect(passportDetailsRsp.code).to.equal("INVALID_SESSION", "unexpected error code");
  });

  it("Get passport details for session without passport", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x1eA692E68a7765dE26FC03A6D74EE5B56A7e2b4d",
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
    testSession.setSessionData("passport.data", null);
    
    let passportDetailsRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: "/api/getPassportInfo?session=" + testSession.getSessionId(),
    } as any, undefined);
    expect(passportDetailsRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(!!passportDetailsRsp.error).to.equal(true, "no error returned");
    expect(passportDetailsRsp.code).to.equal("INVALID_PASSPORT", "unexpected error code");
  });

  it("Get passport details for address (disabled)", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test", 1);
    });
    
    let passportDetailsRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: "/api/getPassportInfo?address=0x332E43696A505EF45b9319973785F837ce5267b9",
    } as any, undefined);
    expect(passportDetailsRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(!!passportDetailsRsp.error).to.equal(true, "no error returned");
    expect(passportDetailsRsp.code).to.equal("NOT_ALLOWED", "unexpected error code");
  });

  it("Get passport details for address (invalid address)", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      allowGuestRefresh: true,
      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test", 1);
    });
    
    let passportDetailsRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: "/api/getPassportInfo?address=0x332E43696A505EF45b9319973785F837ce5267xx",
    } as any, undefined);
    expect(passportDetailsRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(!!passportDetailsRsp.error).to.equal(true, "no error returned");
    expect(passportDetailsRsp.code).to.equal("INVALID_ADDRESS", "unexpected error code");
  });

  it("Get passport details for address (valid)", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      allowGuestRefresh: true,
      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve((testData as any).testPassport1Rsp)
    }));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test", 1);
    });
    
    let passportDetailsRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: "/api/getPassportInfo?address=0x332E43696A505EF45b9319973785F837ce5267b9",
    } as any, undefined);
    expect(passportDetailsRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(passportDetailsRsp.passport).to.equal(null, "unexpected response");
  });

  it("Refresh passport details for unknown session", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
    } as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportDetailsRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: "/api/refreshPassport?session=62dff880-ffe6-4472-a19a-0859e134456f",
    } as any, undefined);
    expect(passportDetailsRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(!!passportDetailsRsp.error).to.equal(true, "no error returned");
    expect(passportDetailsRsp.code).to.equal("INVALID_SESSION", "unexpected error code");
  });

  it("Get passport details for session without passport info", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.reject("strange api error")
    }));
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");

    let passportDetailsRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: "/api/getPassportInfo?session=" + testSession.getSessionId(),
    } as any, undefined);
    expect(passportDetailsRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(passportDetailsRsp.passport?.found).to.equal(false, "no passport details returned");
    expect(passportDetailsRsp.score.score).to.equal(0, "unexpected passport score");
    expect(passportDetailsRsp.score.factor).to.equal(1, "unexpected passport factor");
  });

  it("Check passport cache (DB cache)", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",

      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve((testData as any).testPassport1Rsp)
    }));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session1 status");
    expect(globalStubs["fetch"].callCount).to.equal(1, "unexpected fetch call count after session1 start");
    testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session2 status");
    expect(globalStubs["fetch"].callCount).to.equal(1, "unexpected fetch call count after session2 start");
    let passportData = testSession.getSessionData("passport.data");
    expect(passportData?.found).to.equal(true, "no passport data found")
    let passportScore = testSession.getSessionData("passport.score");
    expect(passportScore?.score).to.equal(2, "unexpected passport score");
    expect(passportScore?.factor).to.equal(4, "unexpected passport factor");
    let clientInfo = await testSession.getSessionInfo();
    expect(!!(clientInfo.modules as any)["passport"]).to.equal(false, "unexpected passport info in client session info");
  });

  it("Check passport cache (DB cache)", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",

      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve((testData as any).testPassport1Rsp)
    }));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session1 status");
    expect(globalStubs["fetch"].callCount).to.equal(1, "unexpected fetch call count after session1 start");
    testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session2 status");
    expect(globalStubs["fetch"].callCount).to.equal(1, "unexpected fetch call count after session2 start");
    let passportData = testSession.getSessionData("passport.data");
    expect(passportData?.found).to.equal(true, "no passport data found")
    let passportScore = testSession.getSessionData("passport.score");
    expect(passportScore?.score).to.equal(2, "unexpected passport score");
    expect(passportScore?.factor).to.equal(4, "unexpected passport factor");
    let clientInfo = await testSession.getSessionInfo();
    expect(!!(clientInfo.modules as any)["passport"]).to.equal(false, "unexpected passport info in client session info");
  });

  it("Check passport cache (DB cache, race condition)", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",

      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve((testData as any).testPassport1Rsp)
    }));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let [testSession] = await Promise.all([
      sessionManager.createSession("::ffff:8.8.8.8", {
        addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
      }),
      sessionManager.createSession("::ffff:8.8.8.8", {
        addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
      })
    ]);
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session1 status");
    expect(globalStubs["fetch"].callCount).to.equal(1, "unexpected fetch call count after session start");
    let passportData = testSession.getSessionData("passport.data");
    expect(passportData?.found).to.equal(true, "no passport data found")
    let passportScore = testSession.getSessionData("passport.score");
    expect(passportScore?.score).to.equal(2, "unexpected passport score");
    expect(passportScore?.factor).to.equal(4, "unexpected passport factor");
  });

  it("Refresh passport for a running session (automatic refresh)", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      refreshCooldown: 0,
      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
    let passportData = testSession.getSessionData("passport.data");
    expect(passportData?.found).to.equal(false, "unexpected passport data found")

    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve((testData as any).testPassport1Rsp)
    }));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    let passportRefreshRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: "/api/refreshPassport?session=" + testSession.getSessionId(),
    } as any, undefined);
    expect(passportRefreshRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(passportRefreshRsp.passport?.found).to.equal(true, "no passport details returned in refresh result");
    expect(passportRefreshRsp.score.score).to.equal(2, "unexpected passport score in refresh result");
    expect(passportRefreshRsp.score.factor).to.equal(4, "unexpected passport factor in refresh result");
    let now = Math.floor(new Date().getTime() / 1000);
    expect(Math.abs(passportRefreshRsp.cooldown - now)).to.be.lessThan(2, "unexpected cooldown");
    passportData = testSession.getSessionData("passport.data");
    expect(passportData?.found).to.equal(true, "no passport data found after refresh")
    let passportScore = testSession.getSessionData("passport.score");
    expect(passportScore?.score).to.equal(2, "unexpected passport score");
    expect(passportScore?.factor).to.equal(4, "unexpected passport factor");
  });

  it("Refresh passport for a running session (manual refresh)", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      refreshCooldown: 0,
      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    let verifyCredential = sinon.stub(PassportDIDKitVerifier.prototype, "verifyCredential")
      .resolves(JSON.stringify({checks: ["proof"], errors: []}));
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
    let passportData = testSession.getSessionData("passport.data");
    expect(passportData?.found).to.equal(false, "unexpected passport data found")

    let passport = (testData as any).testPassport1Json;
    let passportRefreshRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "POST",
      url: "/api/refreshPassport?session=" + testSession.getSessionId(),
    } as any, Buffer.from(JSON.stringify(JSON.stringify(passport))));
    expect(passportRefreshRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(passportRefreshRsp.passport?.found).to.equal(true, "no passport details returned in refresh result");
    expect(passportRefreshRsp.score.score).to.equal(2, "unexpected passport score in refresh result");
    expect(passportRefreshRsp.score.factor).to.equal(4, "unexpected passport factor in refresh result");
    let now = Math.floor(new Date().getTime() / 1000);
    expect(Math.abs(passportRefreshRsp.cooldown - now)).to.be.lessThan(2, "unexpected cooldown");
    passportData = testSession.getSessionData("passport.data");
    expect(passportData?.found).to.equal(true, "no passport data found after refresh")
    let passportScore = testSession.getSessionData("passport.score");
    expect(passportScore?.score).to.equal(2, "unexpected passport score");
    expect(passportScore?.factor).to.equal(4, "unexpected passport factor");
    expect(verifyCredential.callCount).to.equal(passport.stamps.length, "not every submitted stamp reached DIDKit");
    for(let [index, stamp] of passport.stamps.entries()) {
      expect(JSON.parse(verifyCredential.getCall(index).args[0])).to.deep.equal(stamp.credential);
      expect(JSON.parse(verifyCredential.getCall(index).args[1])).to.deep.equal({
        proofPurpose: stamp.credential.proof.proofPurpose,
      });
    }
  });

  it("Refresh passport for a running session (manual refresh, no newer stamp)", async () => {
    let tmpdir = tmpFolder("powfaucet", "passports");
    fs.mkdirSync(tmpdir);
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      cachePath: tmpdir,
      refreshCooldown: 0,
      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve((testData as any).testPassport1Rsp)
    }));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
    let passportData = testSession.getSessionData("passport.data");
    expect(passportData?.found).to.equal(true, "no passport data found")

    let passportRefreshRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "POST",
      url: "/api/refreshPassport?session=" + testSession.getSessionId(),
    } as any, Buffer.from(JSON.stringify(JSON.stringify((testData as any).testPassport1Json))));
    expect(passportRefreshRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(passportRefreshRsp.passport?.found).to.equal(true, "no passport details returned in refresh result");
    expect(passportRefreshRsp.score.score).to.equal(2, "unexpected passport score in refresh result");
    expect(passportRefreshRsp.score.factor).to.equal(4, "unexpected passport factor in refresh result");
    let now = Math.floor(new Date().getTime() / 1000);
    expect(Math.abs(passportRefreshRsp.cooldown - now)).to.be.lessThan(2, "unexpected cooldown");
    passportData = testSession.getSessionData("passport.data");
    expect(passportData?.found).to.equal(true, "no passport data found after refresh")
    let passportScore = testSession.getSessionData("passport.score");
    expect(passportScore?.score).to.equal(2, "unexpected passport score");
    expect(passportScore?.factor).to.equal(4, "unexpected passport factor");
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it("Refresh passport for a running session (manual refresh, invalid json)", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      refreshCooldown: 0,
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
    let passportData = testSession.getSessionData("passport.data");
    expect(passportData?.found).to.equal(false, "unexpected passport data found");

    let passportRefreshRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "POST",
      url: "/api/refreshPassport?session=" + testSession.getSessionId(),
    } as any, Buffer.from(JSON.stringify(JSON.stringify({not: "a_passport", json: 1}))));
    expect(passportRefreshRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(!!passportRefreshRsp.error).to.equal(true, "no error returned");
    expect(passportRefreshRsp.code).to.equal("PASSPORT_VALIDATION", "unexpected error code returned");
  });

  it("Refresh passport for a running session (manual refresh, invalid json 1)", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      refreshCooldown: 0,
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
    let passportData = testSession.getSessionData("passport.data");
    expect(passportData?.found).to.equal(false, "unexpected passport data found");

    let passportRefreshRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "POST",
      url: "/api/refreshPassport?session=" + testSession.getSessionId(),
    } as any, Buffer.from(JSON.stringify(JSON.stringify((testData as any).invalidPassportJson1))));
    expect(passportRefreshRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(!!passportRefreshRsp.error).to.equal(true, "no error returned");
    expect(passportRefreshRsp.code).to.equal("PASSPORT_VALIDATION", "unexpected error code returned");
    expect(passportRefreshRsp.errors.length).to.equal(1, "unexpected number of verification errors returned");
  });
  it("Refresh passport for a running session (manual refresh, invalid json 2)", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      refreshCooldown: 0,
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
    let passportData = testSession.getSessionData("passport.data");
    expect(passportData?.found).to.equal(false, "unexpected passport data found");

    let passportRefreshRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "POST",
      url: "/api/refreshPassport?session=" + testSession.getSessionId(),
    } as any, Buffer.from(JSON.stringify(JSON.stringify((testData as any).invalidPassportJson2))));
    expect(passportRefreshRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(!!passportRefreshRsp.error).to.equal(true, "no error returned");
    expect(passportRefreshRsp.code).to.equal("PASSPORT_VALIDATION", "unexpected error code returned");
    expect(passportRefreshRsp.errors.length).to.equal(1, "unexpected number of verification errors returned");
    expect(passportRefreshRsp.errors[0]).to.match(/duplicate provider/, "unexpected verification error returned");
  });
  it("Refresh passport for a running session (manual refresh, invalid json 3)", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      refreshCooldown: 0,
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
    let passportData = testSession.getSessionData("passport.data");
    expect(passportData?.found).to.equal(false, "unexpected passport data found");

    let passportRefreshRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "POST",
      url: "/api/refreshPassport?session=" + testSession.getSessionId(),
    } as any, Buffer.from(JSON.stringify(JSON.stringify((testData as any).invalidPassportJson3))));
    expect(passportRefreshRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(!!passportRefreshRsp.error).to.equal(true, "no error returned");
    expect(passportRefreshRsp.code).to.equal("PASSPORT_VALIDATION", "unexpected error code returned");
    expect(passportRefreshRsp.errors.length).to.equal(1, "unexpected number of verification errors returned");
    expect(passportRefreshRsp.errors[0]).to.match(/not signed for expected wallet/, "unexpected verification error returned");
  });
  it("Refresh passport for a running session (manual refresh, invalid json 4)", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      refreshCooldown: 0,
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
    let passportData = testSession.getSessionData("passport.data");
    expect(passportData?.found).to.equal(false, "unexpected passport data found");

    let passportRefreshRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "POST",
      url: "/api/refreshPassport?session=" + testSession.getSessionId(),
    } as any, Buffer.from(JSON.stringify(JSON.stringify((testData as any).invalidPassportJson4))));
    expect(passportRefreshRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(!!passportRefreshRsp.error).to.equal(true, "no error returned");
    expect(passportRefreshRsp.code).to.equal("PASSPORT_VALIDATION", "unexpected error code returned");
    expect(passportRefreshRsp.errors.length).to.equal(2, "unexpected number of verification errors returned");
    expect(passportRefreshRsp.errors[0]).to.match(/issuer not trusted/, "unexpected verification error returned");
    expect(passportRefreshRsp.errors[1]).to.match(/invalid proof verificationMethod/, "unexpected verification error returned");
  });
  it("Refresh passport for a running session (manual refresh, invalid json 5)", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      refreshCooldown: 0,
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x332E43696A505EF45b9319973785F837ce5267b9",
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
    let passportData = testSession.getSessionData("passport.data");
    expect(passportData?.found).to.equal(false, "unexpected passport data found");

    let passportRefreshRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "POST",
      url: "/api/refreshPassport?session=" + testSession.getSessionId(),
    } as any, Buffer.from(JSON.stringify(JSON.stringify((testData as any).invalidPassportJson5))));
    expect(passportRefreshRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(!!passportRefreshRsp.error).to.equal(true, "no error returned");
    expect(passportRefreshRsp.code).to.equal("PASSPORT_VALIDATION", "unexpected error code returned");
    expect(passportRefreshRsp.errors.length).to.equal(3, "unexpected number of verification errors returned");
    expect(passportRefreshRsp.errors[0]).to.match(/integrity check failed/, "unexpected verification error returned");
    expect(passportRefreshRsp.errors[1]).to.match(/integrity check failed/, "unexpected verification error returned");
    expect(passportRefreshRsp.errors[2]).to.match(/integrity check failed/, "unexpected verification error returned");
  });

  it("Rejects an empty guest manual passport without poisoning the scorer cache", async () => {
    let address = "0x332E43696A505EF45b9319973785F837ce5267b9";
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      allowGuestRefresh: true,
      refreshCooldown: 0,
      guestRefreshCooldown: 0,
    } as any;
    globalStubs["fetch"].resolves({
      status: 200,
      json: () => Promise.resolve(cloneScorerResponse()),
    });
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportModule = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport");
    let setPassportInfo = sinon.spy(passportModule.getPassportDb(), "setPassportInfo");
    let verifyCredential = sinon.stub(PassportDIDKitVerifier.prototype, "verifyCredential");
    let request = (method: string) => ({
      method,
      url: "/api/refreshPassport?address=" + address,
      socket: {remoteAddress: "::ffff:8.8.8.8"},
      headers: {},
    } as any);
    let emptyPassport = JSON.stringify({issuanceDate: null, expiryDate: null, stamps: []});

    let rejected = await ServiceManager.GetService(FaucetWebApi).onApiRequest(
      request("POST"),
      Buffer.from(JSON.stringify(emptyPassport)),
    );
    let cachedAfterPost = await ServiceManager.GetService(FaucetDatabase).getDatabase().get(
      "SELECT Address FROM PassportCache WHERE Address = ?",
      [address.toLowerCase()],
    );
    let scorerResult = await ServiceManager.GetService(FaucetWebApi).onApiRequest(request("GET"), undefined);

    expect(rejected.code).to.equal("PASSPORT_VALIDATION");
    expect(rejected.errors).to.deep.equal(["Passport must contain at least one stamp"]);
    expect(verifyCredential.callCount).to.equal(0, "empty passport reached DIDKit");
    expect(cachedAfterPost).to.equal(null, "empty manual passport wrote a cache row");
    expect(scorerResult.passport?.found).to.equal(true, "manual rejection poisoned the later scorer lookup");
    expect(globalStubs["fetch"].callCount).to.equal(1);
    expect(setPassportInfo.callCount).to.equal(1, "manual rejection reached the cache writer");
  });

  it("Refresh passport without session (disabled)", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      refreshCooldown: 0,
      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportRefreshRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: "/api/refreshPassport?address=0x332E43696A505EF45b9319973785F837ce5267b9",
    } as any, undefined);
    expect(passportRefreshRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(!!passportRefreshRsp.error).to.equal(true, "no error returned");
    expect(passportRefreshRsp.code).to.equal("NOT_ALLOWED", "unexpected error code returned");
    expect(passportRefreshRsp.error).to.match(/not allowed without active session/, "unexpected error returned");
  });

  it("Refresh passport without session (invalid address)", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      refreshCooldown: 0,
      allowGuestRefresh: true,
      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportRefreshRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: "/api/refreshPassport?address=0x332E43696A505EF45b9319973785F837ce5267xx",
    } as any, undefined);
    expect(passportRefreshRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(!!passportRefreshRsp.error).to.equal(true, "no error returned");
    expect(passportRefreshRsp.code).to.equal("INVALID_ADDRESS", "unexpected error code returned");
    expect(passportRefreshRsp.error).to.match(/Invalid address/, "unexpected error returned");
  });

  it("Refresh passport without session (cooldown)", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      refreshCooldown: 0,
      allowGuestRefresh: true,
      guestRefreshCooldown: 10,
      stampScoring: {
        "TwitterTweetGT10": 1,
        "TwitterFollowerGT100": 1,
      },
      boostFactor: {
        2: 4,
      },
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(true, {
      json: () => Promise.resolve((testData as any).testPassport1Rsp)
    }));
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportRefreshRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: "/api/refreshPassport?address=0x332E43696A505EF45b9319973785F837ce5267b9",
    } as any, undefined);
    expect(passportRefreshRsp instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(passportRefreshRsp.passport?.found).to.equal(true, "no passport details returned in refresh result");
    expect(passportRefreshRsp.score.score).to.equal(2, "unexpected passport score in refresh result");
    expect(passportRefreshRsp.score.factor).to.equal(4, "unexpected passport factor in refresh result");

    let passportRefreshRsp2 = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: "/api/refreshPassport?address=0x332E43696A505EF45b9319973785F837ce5267b9",
    } as any, undefined);
    expect(passportRefreshRsp2 instanceof FaucetHttpResponse).to.equal(false, "unexpected plain http response");
    expect(!!passportRefreshRsp2.error).to.equal(true, "no error returned");
    expect(passportRefreshRsp2.code).to.equal("REFRESH_COOLDOWN", "unexpected error code returned");
    expect(passportRefreshRsp2.error).to.match(/has been refreshed recently/, "unexpected error returned");

  });

  it("Rejects scorer credentials that are not exactly bound to the requested wallet", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
    } as any;
    let requestedAddress = "0x332E43696A505EF45b9319973785F837ce5267b9";
    let variants = [
      (response: any) => response.items[0].credential.credentialSubject.id = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
      (response: any) => response.items[0].credential.issuer = "did:key:untrusted",
      (response: any) => response.items[0].credential.proof.verificationMethod = "did:key:other#key",
      (response: any) => response.items[0].provider = "DifferentProvider",
      (response: any) => response.items[0].credential.proof.proofPurpose = "authentication",
      (response: any) => delete response.items[0].credential.credentialSubject.hash,
    ];
    variants.forEach((mutate, index) => {
      let response = cloneScorerResponse();
      mutate(response);
      globalStubs["fetch"].onCall(index).resolves({
        status: 200,
        json: () => Promise.resolve(response),
      });
    });
    await ServiceManager.GetService(ModuleManager).initialize();
    let resolver = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport").getPassportResolver();

    for(let i = 0; i < variants.length; i++) {
      let result = await resolver.getPassport(requestedAddress, true);
      expect(result.found).to.equal(false, "invalid scorer binding variant " + i + " was accepted");
    }
    expect(globalStubs["fetch"].callCount).to.equal(variants.length);
  });

  it("Rejects manual credentials without a stable deduplication hash", async () => {
    faucetConfig.modules["passport"] = {enabled: true} as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let resolver = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport").getPassportResolver();
    let verifyCredential = sinon.stub(PassportDIDKitVerifier.prototype, "verifyCredential")
      .resolves(JSON.stringify({checks: ["proof"], errors: []}));
    let passport = JSON.parse(JSON.stringify((testData as any).testPassport1Json));
    passport.stamps = passport.stamps.slice(0, 1);
    delete passport.stamps[0].credential.credentialSubject.hash;
    delete passport.stamps[0].credential.credentialSubject.nullifiers;

    let result = await resolver.verifyUserPassport(
      "0x332E43696A505EF45b9319973785F837ce5267b9",
      JSON.stringify(passport),
    );

    expect(result.valid).to.equal(false);
    expect(result.errors[0]).to.include("missing stamp hash");
    expect(verifyCredential.callCount).to.equal(0, "unclaimable credential reached DIDKit");
  });

  it("Does not expose DIDKit verification details in manual passport errors", async () => {
    faucetConfig.modules["passport"] = {enabled: true} as any;
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    let resolver = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport").getPassportResolver();
    let didkitDetail = "private didkit verification diagnostic";
    sinon.stub(PassportDIDKitVerifier.prototype, "verifyCredential").resolves(JSON.stringify({
      checks: ["proof"],
      errors: [didkitDetail],
    }));
    let passport = JSON.parse(JSON.stringify((testData as any).testPassport1Json));
    passport.stamps = passport.stamps.slice(0, 1);

    let result = await resolver.verifyUserPassport(
      "0x332E43696A505EF45b9319973785F837ce5267b9",
      JSON.stringify(passport),
    );

    expect(result.valid).to.equal(false);
    expect(result.errors).to.deep.equal([
      "Stamp '" + passport.stamps[0].provider + "' invalid: integrity check failed",
    ]);
    expect(JSON.stringify(result)).to.not.include(didkitDetail, "DIDKit diagnostic entered the public verification DTO");
  });

  it("Rate limits guest passport lookups per IP before scorer admission", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      allowGuestRefresh: true,
      refreshCooldown: 0,
      guestRefreshCooldown: 0,
      guestLookupRateLimit: 1,
    } as any;
    globalStubs["fetch"].resolves({
      status: 200,
      json: () => Promise.resolve(cloneScorerResponse()),
    });
    await ServiceManager.GetService(ModuleManager).initialize();
    let webApi = ServiceManager.GetService(FaucetWebApi);
    let request = (address: string) => ({
      method: "GET",
      url: "/api/refreshPassport?address=" + address,
      socket: {remoteAddress: "9.9.9.9"},
      headers: {},
    } as any);

    let first = await webApi.onApiRequest(request("0x332E43696A505EF45b9319973785F837ce5267b9"), undefined);
    let fetchCount = globalStubs["fetch"].callCount;
    let second = await webApi.onApiRequest(request("0x0000000000000000000000000000000000000002"), undefined);

    expect(first.passport?.found).to.equal(true, "admitted guest lookup failed");
    expect(second.code).to.equal("PASSPORT_RATE_LIMITED");
    expect(globalStubs["fetch"].callCount).to.equal(fetchCount, "rate-limited guest reached the scorer");
  });

  it("Shares the live lookup budget between guests and uncached session starts", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      allowGuestRefresh: true,
      refreshCooldown: 0,
      guestRefreshCooldown: 0,
      guestLookupRateLimit: 1,
      automaticLookupConcurrency: 4,
    } as any;
    globalStubs["fetch"].callsFake((url: string) => {
      let address = url.substring(url.lastIndexOf("/") + 1);
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve(scorerResponseForAddress(address)),
      });
    });
    await ServiceManager.GetService(ModuleManager).initialize();

    let cachedAddress = "0x332E43696A505EF45b9319973785F837ce5267b9";
    let guestResponse = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: "/api/refreshPassport?address=" + cachedAddress,
      socket: {remoteAddress: "::ffff:8.8.8.8"},
      headers: {},
    } as any);
    expect(guestResponse.passport?.found).to.equal(true, "guest lookup did not populate the cache");
    expect(globalStubs["fetch"].callCount).to.equal(1);

    let sessionManager = ServiceManager.GetService(SessionManager);
    let cachedSession = await sessionManager.createSession("8.8.8.8", {addr: cachedAddress});
    expect(cachedSession.getSessionData("passport.data")?.found).to.equal(true, "cached session start was rate limited");
    expect(globalStubs["fetch"].callCount).to.equal(1, "cached session start reached the scorer");

    let limitedSession = await sessionManager.createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000000002",
    });
    expect(limitedSession.getSessionData("passport.data")?.found).to.equal(false, "rate-limited session received passport credit");
    expect(globalStubs["fetch"].callCount).to.equal(1, "session start bypassed the shared canonical-IP budget");

    let otherIpSession = await sessionManager.createSession("8.8.4.4", {
      addr: "0x0000000000000000000000000000000000000003",
    });
    expect(otherIpSession.getSessionData("passport.data")?.found).to.equal(true, "lookup budget leaked across IPs");
    expect(globalStubs["fetch"].callCount).to.equal(2);
  });

  it("Caps automatic scorer lookups across distinct wallets", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      automaticLookupConcurrency: 1,
    } as any;
    let releaseFetch: (response: any) => void;
    globalStubs["fetch"].callsFake(() => new Promise((resolve) => {
      releaseFetch = resolve;
    }));
    await ServiceManager.GetService(ModuleManager).initialize();
    let resolver = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport").getPassportResolver();
    let firstLookup = resolver.getPassport("0x332E43696A505EF45b9319973785F837ce5267b9", true);
    await awaitSleepPromise(1000, () => globalStubs["fetch"].callCount === 1);
    expect(globalStubs["fetch"].callCount).to.equal(1, "first lookup did not reach the scorer");

    let capacityError: Error | null = null;
    try {
      await resolver.getPassport("0x0000000000000000000000000000000000000002", true);
    } catch(ex) {
      capacityError = ex;
    }
    releaseFetch({status: 200, json: () => Promise.resolve(cloneScorerResponse())});
    let firstResult = await firstLookup;

    expect(capacityError?.name).to.equal("PassportLookupCapacityError");
    expect(globalStubs["fetch"].callCount).to.equal(1, "capacity overflow reached the scorer");
    expect(firstResult.found).to.equal(true);
  });

  it("Serves cached passports while automatic scorer capacity is full", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      automaticLookupConcurrency: 1,
    } as any;
    let cachedAddress = "0x332E43696A505EF45b9319973785F837ce5267b9";
    let pendingAddress = "0x0000000000000000000000000000000000000002";
    globalStubs["fetch"].onFirstCall().resolves({
      status: 200,
      json: () => Promise.resolve(scorerResponseForAddress(cachedAddress)),
    });
    let releaseFetch: (response: any) => void;
    globalStubs["fetch"].onSecondCall().callsFake(() => new Promise((resolve) => {
      releaseFetch = resolve;
    }));
    await ServiceManager.GetService(ModuleManager).initialize();
    let resolver = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport").getPassportResolver();
    expect((await resolver.getPassport(cachedAddress, true)).found).to.equal(true);

    let pendingLookup = resolver.getPassport(pendingAddress, true);
    await awaitSleepPromise(1000, () => globalStubs["fetch"].callCount === 2);
    let cachedResult = await resolver.getPassport(cachedAddress);

    expect(cachedResult.found).to.equal(true, "scorer saturation blocked a cached passport");
    expect(globalStubs["fetch"].callCount).to.equal(2, "cached lookup reached the scorer");
    releaseFetch({
      status: 200,
      json: () => Promise.resolve(scorerResponseForAddress(pendingAddress)),
    });
    expect((await pendingLookup).found).to.equal(true);
  });

  it("Bounds distinct held cache probes before pending-map and scorer admission", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      cacheLookupConcurrency: 4,
      automaticLookupConcurrency: 1,
    } as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportModule = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport");
    let resolver = passportModule.getPassportResolver() as any;
    let probeGate = new PromiseDfd<null>();
    let getPassportInfo = sinon.stub(passportModule.getPassportDb(), "getPassportInfo").returns(probeGate.promise);
    let scorerAdmission = sinon.spy(() => true);

    let lookups = Array.from({length: 1000}, (_, index) => {
      let address = "0x" + (index + 1).toString(16).padStart(40, "0");
      return passportModule.getPassportResolver().getPassport(address, false, scorerAdmission)
        .then(() => null, (error) => error as Error);
    });

    expect(getPassportInfo.callCount).to.equal(4, "cache probe capacity did not bound physical DB reads");
    expect(resolver.passportCache.size).to.equal(4, "rejected probes entered the pending promise map");
    expect(resolver.activeCacheLookups).to.equal(4);
    expect(resolver.ownedWork.size).to.be.at.most(8, "rejected probes entered resolver-owned work");
    expect(scorerAdmission.callCount).to.equal(0, "rate admission ran before a cache probe completed");

    let reloadSettled = false;
    let reload = passportModule.getPassportResolver().reload().then(() => {
      reloadSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reloadSettled).to.equal(false, "reload returned while physical cache reads were held");
    probeGate.resolve(null);
    let results = await Promise.all(lookups);
    await reload;

    expect(results.filter((result) => result instanceof PassportLookupCapacityError)).to.have.length(996);
    expect(results.filter((result) => result instanceof PassportLookupInvalidatedError)).to.have.length(4);
    expect(scorerAdmission.callCount).to.equal(0, "invalidated probes consumed scorer rate budget");
    expect(resolver.passportCache.size).to.equal(0);
    expect(resolver.activeCacheLookups).to.equal(0);
    expect(resolver.ownedWork.size).to.equal(0);
  });

  it("Bounds held getCachedPassport probes without growing the pending map", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      cacheLookupConcurrency: 3,
    } as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportModule = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport");
    let resolver = passportModule.getPassportResolver() as any;
    let probeGate = new PromiseDfd<null>();
    let getPassportInfo = sinon.stub(passportModule.getPassportDb(), "getPassportInfo").returns(probeGate.promise);

    let lookups = Array.from({length: 1000}, (_, index) => {
      let address = "0x" + (index + 1).toString(16).padStart(40, "0");
      return passportModule.getPassportResolver().getCachedPassport(address)
        .then((result) => result, (error) => error as Error);
    });

    expect(getPassportInfo.callCount).to.equal(3, "getCachedPassport bypassed cache probe capacity");
    expect(resolver.passportCache.size).to.equal(0, "getCachedPassport inserted pending map entries");
    expect(resolver.activeCacheLookups).to.equal(3);
    expect(resolver.ownedWork.size).to.be.at.most(6, "rejected cached probes entered resolver-owned work");
    probeGate.resolve(null);
    let results = await Promise.all(lookups);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(results.filter((result) => result instanceof PassportLookupCapacityError)).to.have.length(997);
    expect(results.filter((result) => result === null)).to.have.length(3);
    expect(resolver.activeCacheLookups).to.equal(0);
    expect(resolver.ownedWork.size).to.equal(0);
  });

  it("Aborts and drains scorer lookups when the generation changes", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
    } as any;
    let abortObserved = false;
    globalStubs["fetch"].onFirstCall().callsFake((url: string, init: any) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        abortObserved = true;
        reject(new Error("aborted"));
      }, {once: true});
    }));
    globalStubs["fetch"].onSecondCall().resolves({
      status: 200,
      json: () => Promise.resolve(cloneScorerResponse()),
    });
    await ServiceManager.GetService(ModuleManager).initialize();
    let resolver = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport").getPassportResolver();
    let oldLookup = resolver.getPassport("0x332E43696A505EF45b9319973785F837ce5267b9", true);
    await awaitSleepPromise(1000, () => globalStubs["fetch"].callCount === 1);
    expect(globalStubs["fetch"].callCount).to.equal(1, "lookup did not reach the scorer");

    await resolver.reload();
    let oldError: Error | null = null;
    try {
      await oldLookup;
    } catch(ex) {
      oldError = ex;
    }
    let fresh = await resolver.getPassport("0x332E43696A505EF45b9319973785F837ce5267b9", true);

    expect(abortObserved).to.equal(true, "generation change did not abort the scorer request");
    expect(oldError?.name).to.equal("PassportLookupInvalidatedError");
    expect(fresh.found).to.equal(true);
  });

  it("Drains old resolver and verifier work before activating and publishing a new generation", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
    } as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportModule = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport");
    let resolver = passportModule.getPassportResolver() as any;
    let passportDb = passportModule.getPassportDb();
    let oldCacheGeneration = resolver.cacheGeneration as string;
    let oldTrustGeneration = resolver.trustGeneration as string;
    let oldController = resolver.generationController as AbortController;
    let oldVerifier = resolver.didkitVerifier as PassportDIDKitVerifier;

    let releaseLookup: () => void;
    let lookupGate = new Promise<null>((resolve) => {
      releaseLookup = () => resolve(null);
    });
    let getPassportInfo = sinon.stub(passportDb, "getPassportInfo").returns(lookupGate);
    let oldLookup = passportModule.getPassportResolver()
      .getPassport("0x0000000000000000000000000000000000000001", true)
      .then(() => null, (error) => error as Error);
    expect(getPassportInfo.callCount).to.equal(1, "old lookup did not enter resolver-owned work");

    let releaseVerifier: () => void;
    let verifierGate = new Promise<void>((resolve) => {
      releaseVerifier = resolve;
    });
    sinon.stub(oldVerifier, "stop").returns(verifierGate);
    let nextTrustGeneration = "ab".repeat(32);
    sinon.stub(resolver, "getTrustGeneration").returns(nextTrustGeneration);
    let activationGate = new PromiseDfd<string>();
    let activateGeneration = sinon.stub(passportDb, "activateCacheGeneration").returns(activationGate.promise);

    let reloadSettled = false;
    let reload = passportModule.getPassportResolver().reload().then(() => {
      reloadSettled = true;
    });
    await awaitSleepPromise(1000, () => !resolver.acceptingLookups && oldController.signal.aborted);
    let activationStartedBeforeLookupDrain = activateGeneration.callCount > 0;
    let admissionClosedBeforeDrain = !resolver.acceptingLookups && oldController.signal.aborted;

    releaseLookup();
    let oldLookupError = await oldLookup;
    let activationStartedBeforeVerifierDrain = activateGeneration.callCount > 0;
    releaseVerifier();
    await awaitSleepPromise(1000, () => activateGeneration.callCount === 1);

    let publishedBeforeActivation =
      reloadSettled
      || resolver.cacheGeneration !== oldCacheGeneration
      || resolver.trustGeneration !== oldTrustGeneration
      || resolver.generationController !== oldController
      || resolver.didkitVerifier !== oldVerifier
      || resolver.acceptingLookups;
    let activationArgs = activateGeneration.firstCall.args;
    activationGate.resolve(activationArgs[0]);
    await reload;

    expect(admissionClosedBeforeDrain).to.equal(true, "reload did not close admission and abort the old controller first");
    expect(oldLookupError?.name).to.equal("PassportLookupInvalidatedError");
    expect(activationStartedBeforeLookupDrain).to.equal(false, "cache activation raced old resolver work");
    expect(activationStartedBeforeVerifierDrain).to.equal(false, "cache activation raced old verifier drainage");
    expect(publishedBeforeActivation).to.equal(false, "new resolver state was published before cache activation completed");
    expect(activationArgs[0]).to.not.equal(oldCacheGeneration);
    expect(activationArgs[1]).to.equal(nextTrustGeneration);
    expect(activationArgs[2]).to.equal(true);
    expect(resolver.cacheGeneration).to.equal(activationArgs[0]);
    expect(resolver.trustGeneration).to.equal(nextTrustGeneration);
    expect(resolver.generationController).to.not.equal(oldController);
    expect(resolver.didkitVerifier).to.not.equal(oldVerifier);
    expect(resolver.acceptingLookups).to.equal(true);
  });

  it("Serializes overlapping Passport reloads across generation publication", async () => {
    faucetConfig.modules["passport"] = {enabled: true} as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportModule = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport");
    let resolver = passportModule.getPassportResolver() as any;
    let firstActivation = new PromiseDfd<string>();
    let secondActivation = new PromiseDfd<string>();
    let activateGeneration = sinon.stub(passportModule.getPassportDb(), "activateCacheGeneration");
    activateGeneration.onFirstCall().returns(firstActivation.promise);
    activateGeneration.onSecondCall().returns(secondActivation.promise);

    let firstReload = passportModule.getPassportResolver().reload();
    await awaitSleepPromise(1000, () => activateGeneration.callCount === 1);
    let secondReload = passportModule.getPassportResolver().reload();
    let secondStartedBeforeFirstPublished = activateGeneration.callCount > 1;
    let firstActivationArgs = activateGeneration.firstCall.args;
    firstActivation.resolve(firstActivationArgs[0]);
    await awaitSleepPromise(1000, () => activateGeneration.callCount === 2);
    await firstReload;

    let firstPublishedController = resolver.generationController as AbortController;
    let firstPublishedVerifier = resolver.didkitVerifier as PassportDIDKitVerifier;
    let firstPublishedGeneration = resolver.cacheGeneration as string;
    let secondActivationArgs = activateGeneration.secondCall.args;
    secondActivation.resolve(secondActivationArgs[0]);
    await secondReload;

    expect(secondStartedBeforeFirstPublished).to.equal(false, "second reload bypassed the lifecycle queue");
    expect(firstActivationArgs[2]).to.equal(true);
    expect(secondActivationArgs[2]).to.equal(true);
    expect(firstPublishedGeneration).to.equal(firstActivationArgs[0]);
    expect(firstPublishedController.signal.aborted).to.equal(true, "second reload did not abort the generation published by the first");
    expect(resolver.generationController).to.not.equal(firstPublishedController);
    expect(resolver.didkitVerifier).to.not.equal(firstPublishedVerifier);
    expect(resolver.cacheGeneration).to.equal(secondActivationArgs[0]);
    expect(resolver.acceptingLookups).to.equal(true);
    activateGeneration.restore();
  });

  it("Serializes Passport stop behind an overlapping reload", async () => {
    faucetConfig.modules["passport"] = {enabled: true} as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportModule = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport");
    let resolver = passportModule.getPassportResolver() as any;
    let firstActivation = new PromiseDfd<string>();
    let stopActivation = new PromiseDfd<string>();
    let activateGeneration = sinon.stub(passportModule.getPassportDb(), "activateCacheGeneration");
    activateGeneration.onFirstCall().returns(firstActivation.promise);
    activateGeneration.onSecondCall().returns(stopActivation.promise);

    let reload = passportModule.getPassportResolver().reload();
    await awaitSleepPromise(1000, () => activateGeneration.callCount === 1);
    let stop = passportModule.getPassportResolver().stop();
    let stopStartedBeforeReloadPublished = activateGeneration.callCount > 1;
    let reloadActivationArgs = activateGeneration.firstCall.args;
    firstActivation.resolve(reloadActivationArgs[0]);
    await awaitSleepPromise(1000, () => activateGeneration.callCount === 2);
    await reload;

    let reloadedController = resolver.generationController as AbortController;
    let stopActivationArgs = activateGeneration.secondCall.args;
    stopActivation.resolve(reloadActivationArgs[0]);
    await stop;

    expect(stopStartedBeforeReloadPublished).to.equal(false, "stop bypassed the reload lifecycle queue");
    expect(reloadActivationArgs[2]).to.equal(true);
    expect(stopActivationArgs[2]).to.equal(false);
    expect(reloadedController.signal.aborted).to.equal(true, "stop did not abort the reloaded generation");
    expect(resolver.cacheGeneration).to.equal(reloadActivationArgs[0], "same-trust stop did not keep the active cache generation");
    expect(resolver.acceptingLookups).to.equal(false);
    activateGeneration.restore();
  });

  it("Recovers the Passport rotation queue after activation failure without retaining later-generation work", async () => {
    faucetConfig.modules["passport"] = {enabled: true} as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportModule = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport");
    let resolver = passportModule.getPassportResolver() as any;
    let firstActivation = new PromiseDfd<string>();
    let activationFailure = new Error("test activation failure");
    let activationCall = 0;
    let activateGeneration = sinon.stub(passportModule.getPassportDb(), "activateCacheGeneration").callsFake(
      async (cacheGeneration) => {
        activationCall++;
        if(activationCall === 1)
          return firstActivation.promise;
        if(activationCall === 2)
          throw activationFailure;
        return cacheGeneration;
      },
    );

    let firstReload = passportModule.getPassportResolver().reload();
    await awaitSleepPromise(1000, () => activateGeneration.callCount === 1);
    let firstActivationArgs = activateGeneration.firstCall.args;
    firstActivation.resolve(firstActivationArgs[0]);
    await firstReload;
    let firstController = resolver.generationController as AbortController;
    let firstPublishedGeneration = resolver.cacheGeneration as string;

    let lookupGate = new PromiseDfd<null>();
    let getPassportInfo = sinon.stub(passportModule.getPassportDb(), "getPassportInfo").returns(lookupGate.promise);
    let laterLookup = passportModule.getPassportResolver()
      .getPassport("0x0000000000000000000000000000000000000002", true)
      .then(() => null, (error) => error as Error);
    expect(getPassportInfo.callCount).to.equal(1, "later generation lookup was not admitted");

    let failedReload = passportModule.getPassportResolver().reload().then(() => null, (error) => error as Error);
    let activationStartedBeforeLaterWorkDrained = activateGeneration.callCount > 1;
    lookupGate.resolve(null);
    let laterLookupError = await laterLookup;
    let reloadError = await failedReload;
    let rejectedNewLookup: Error | null = null;
    try {
      passportModule.getPassportResolver().getPassport("0x0000000000000000000000000000000000000003", true);
    } catch(error) {
      rejectedNewLookup = error as Error;
    }
    let ownedAfterFailure = resolver.ownedWork.size as number;
    let acceptingAfterFailure = resolver.acceptingLookups as boolean;
    let generationAfterFailure = resolver.cacheGeneration as string;

    let recoveryReload = passportModule.getPassportResolver().reload();
    await recoveryReload;
    let recoveryActivationArgs = activateGeneration.thirdCall.args;

    expect(activationStartedBeforeLaterWorkDrained).to.equal(false, "activation raced later-generation work");
    expect(laterLookupError?.name).to.equal("PassportLookupInvalidatedError");
    expect(reloadError).to.equal(activationFailure);
    expect(firstController.signal.aborted).to.equal(true);
    expect(acceptingAfterFailure).to.equal(false, "activation failure reopened admission");
    expect(generationAfterFailure).to.equal(firstPublishedGeneration, "failed activation published a new generation");
    expect(ownedAfterFailure).to.equal(0, "failed activation retained later-generation work");
    expect(rejectedNewLookup?.name).to.equal("PassportLookupInvalidatedError");
    expect(recoveryActivationArgs[2]).to.equal(true);
    expect(resolver.cacheGeneration).to.equal(recoveryActivationArgs[0]);
    expect(resolver.acceptingLookups).to.equal(true, "rotation queue did not recover after rejection");
    activateGeneration.restore();
  });

  it("Rejects invalid passport workload limits", async () => {
    let invalidLimits = [
      {cacheLookupConcurrency: 0},
      {cacheLookupConcurrency: 65},
      {automaticLookupConcurrency: 0},
      {automaticLookupConcurrency: 65},
    ];
    for(let invalidLimit of invalidLimits) {
      faucetConfig.modules["passport"] = {enabled: true, ...invalidLimit} as any;
      let error: Error | null = null;
      try {
        await ServiceManager.GetService(ModuleManager).initialize();
      } catch(ex) {
        error = ex;
      }
      expect(error?.message, JSON.stringify(invalidLimit)).to.include(Object.keys(invalidLimit)[0]);
    }
  });

  it("Applies the default and accepts the maximum Passport cache probe limit", async () => {
    faucetConfig.modules["passport"] = {enabled: true} as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportModule = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport");
    expect(passportModule.getModuleConfig().cacheLookupConcurrency).to.equal(16);

    await passportModule.setModuleConfig({
      ...passportModule.getModuleConfig(),
      cacheLookupConcurrency: 64,
    });
    expect(passportModule.getModuleConfig().cacheLookupConcurrency).to.equal(64);
  });

  it("Rejects malformed passport score and reward configuration", async () => {
    let invalidConfigs: {label: string, config: Record<string, unknown>}[] = [
      {label: "negative minimum score", config: {requireMinScore: -1}},
      {label: "negative-zero minimum score", config: {requireMinScore: -0}},
      {label: "negative underflow minimum score", config: {requireMinScore: -1e-400}},
      {label: "overprecise minimum score", config: {requireMinScore: 0.0000001}},
      {label: "non-finite proxy override", config: {skipProxyCheckScore: Number.NaN}},
      {label: "non-finite hosting override", config: {skipHostingCheckScore: Number.POSITIVE_INFINITY}},
      {label: "finite boost factor outside the reward scale", config: {boostFactor: {"1": Number.MAX_VALUE}}},
      {label: "null stamp map", config: {stampScoring: null}},
      {label: "array stamp map", config: {stampScoring: [1]}},
      {label: "negative stamp score", config: {stampScoring: {Google: -1}}},
      {label: "negative-zero stamp score", config: {stampScoring: {Google: -0}}},
      {label: "overprecise stamp score", config: {stampScoring: {Google: 0.0000001}}},
      {label: "non-finite stamp score", config: {stampScoring: {Google: Number.POSITIVE_INFINITY}}},
      {label: "finite stamp score that can overflow the total", config: {stampScoring: {Google: Number.MAX_VALUE}}},
      {label: "empty stamp provider", config: {stampScoring: {"": 1}}},
      {label: "null boost map", config: {boostFactor: null}},
      {label: "array boost map", config: {boostFactor: [2]}},
      {label: "negative boost threshold", config: {boostFactor: {"-1": 2}}},
      {label: "positive-sign boost threshold", config: {boostFactor: {"+1": 2}}},
      {label: "negative-zero boost threshold", config: {boostFactor: {"-0": 2}}},
      {label: "negative underflow boost threshold", config: {boostFactor: {"-1e-400": 2}}},
      {label: "exponent boost threshold", config: {boostFactor: {"1e-6": 2}}},
      {label: "hex boost threshold", config: {boostFactor: {"0x1": 2}}},
      {label: "whitespace boost threshold", config: {boostFactor: {" 1": 2}}},
      {label: "leading-zero boost threshold", config: {boostFactor: {"01": 2}}},
      {label: "trailing-zero boost threshold", config: {boostFactor: {"1.0": 2}}},
      {label: "overprecise boost threshold", config: {boostFactor: {"0.0000001": 2}}},
      {label: "non-numeric boost threshold", config: {boostFactor: {invalid: 2}}},
      {label: "sub-unit boost factor", config: {boostFactor: {"1": 0.5}}},
      {label: "non-finite boost factor", config: {boostFactor: {"1": Number.POSITIVE_INFINITY}}},
      {label: "string guest flag", config: {allowGuestRefresh: "false"}},
      {label: "numeric scorer key", config: {scorerApiKey: 1}},
      {label: "empty scorer key", config: {scorerApiKey: ""}},
      {label: "oversized scorer key", config: {scorerApiKey: "x".repeat(4097)}},
      {label: "numeric cache path", config: {cachePath: 1}},
      {label: "empty cache path", config: {cachePath: ""}},
      {label: "nul cache path", config: {cachePath: "cache\0path"}},
      {label: "oversized cache path", config: {cachePath: "x".repeat(4097)}},
    ];

    for(let invalid of invalidConfigs) {
      faucetConfig.modules["passport"] = {enabled: true, ...invalid.config} as any;
      let error: Error | null = null;
      try {
        await ServiceManager.GetService(ModuleManager).initialize();
      } catch(ex) {
        error = ex;
      }
      expect(error, invalid.label).to.be.instanceOf(Error);
      expect(error?.message, invalid.label).to.include("passport.");
    }
  });

  it("Accepts bounded fractional passport score and reward configuration", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      maxPassportStamps: 2,
      stampScoring: {
        Google: 123456.123456,
        Github: 0.5,
      },
      boostFactor: {
        "0.5": 1.25,
      },
    } as any;

    await ServiceManager.GetService(ModuleManager).initialize();
  });

  it("Accumulates and compares fractional Passport scores in fixed-point units", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      stampScoring: {
        first: 0.1,
        second: 0.2,
      },
      boostFactor: {
        "0.3": 1.5,
      },
      requireMinScore: 0.3,
      skipProxyCheckScore: 0.3,
      skipHostingCheckScore: 0.3,
    } as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let resolver = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport").getPassportResolver();
    let now = Math.floor(Date.now() / 1000);
    let calculation = resolver.getPassportScoreCalculation({
      found: true,
      parsed: now,
      newest: now,
      stamps: [
        {provider: "first", expiration: now + 60},
        {provider: "second", expiration: now + 60},
      ],
    });

    expect(calculation.scoreUnits).to.equal(3 * PASSPORT_SCORE_SCALE / 10);
    expect(calculation.score.score).to.equal(0.3, "fixed-point score changed at the DTO boundary");
    expect(calculation.score.factor).to.equal(1.5, "exact fractional threshold was not selected");
  });

  it("Recomputes Passport scores and expires stamps at the exact expiration second", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      stampScoring: {first: 1},
      boostFactor: {"1": 2},
    } as any;
    let currentTime = 999;
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime")
      .callsFake(() => currentTime);
    await ServiceManager.GetService(ModuleManager).initialize();
    let resolver = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport").getPassportResolver();
    let passportInfo: IPassportInfo = {
      found: true,
      parsed: currentTime,
      newest: currentTime,
      stamps: [{provider: "first", expiration: 1000}],
    };

    expect(resolver.getPassportScore(passportInfo)).to.deep.equal({score: 1, factor: 2});
    currentTime = 1000;
    expect(resolver.getPassportScore(passportInfo)).to.deep.equal({score: 0, factor: 1});

    let verifyCredential = sinon.stub(PassportDIDKitVerifier.prototype, "verifyCredential")
      .resolves(JSON.stringify({checks: ["proof"], errors: []}));
    let passport = JSON.parse(JSON.stringify((testData as any).testPassport1Json));
    passport.stamps = passport.stamps.slice(0, 1);
    passport.stamps[0].credential.expirationDate = new Date(currentTime * 1000).toISOString();
    let verification = await resolver.verifyUserPassport(
      "0x332E43696A505EF45b9319973785F837ce5267b9",
      JSON.stringify(passport),
    );

    expect(verification.valid).to.equal(false);
    expect(verification.errors[0]).to.include("stamp expired");
    expect(verifyCredential.callCount).to.equal(0, "exactly expired stamp reached DIDKit");
  });

  it("Caps retained session stamps after maxPassportStamps decreases", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      maxPassportStamps: 4,
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    await ServiceManager.GetService(ModuleManager).initialize();
    let session = await createRunningPassportSession();
    let now = Math.floor(Date.now() / 1000);
    let retainedPassport: IPassportInfo = {
      found: true,
      parsed: now,
      newest: now,
      stamps: [
        {provider: "first", expiration: now + 3600},
        {provider: "expired", expiration: now - 1},
        {provider: "third", expiration: now + 3600},
        {provider: "fourth", expiration: now + 3600},
      ],
    };
    session.setSessionData("passport.data", retainedPassport);

    let passportModule = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport");
    let maxStampScore = Math.floor(Number.MAX_SAFE_INTEGER / 2 / PASSPORT_SCORE_SCALE);
    await passportModule.setModuleConfig({
      ...passportModule.getModuleConfig(),
      maxPassportStamps: 2,
      stampScoring: {
        first: maxStampScore,
        expired: maxStampScore - 1,
        third: maxStampScore,
        fourth: 3,
      },
    });

    let sessionInfo = await session.getSessionInfo();
    let score = (sessionInfo.modules as {passport: {score: number}}).passport.score;
    expect(score).to.equal(maxStampScore, "scoring did not preserve the first-entry slice");
    expect(Number.isFinite(score)).to.equal(true, "capped score was not finite");
    expect(Number.isSafeInteger(score)).to.equal(true, "capped score was not a safe integer");
    expect(retainedPassport.stamps).to.have.length(4, "reload rewrote retained session data");
  });

  it("Invalidates cached scores before reload and rollback drains", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      stampScoring: {first: 1},
    } as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportModule = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport");
    let resolver = passportModule.getPassportResolver();
    let passportInfo: IPassportInfo = {
      found: true,
      parsed: 1,
      newest: 1,
      stamps: [{provider: "first", expiration: Math.floor(Date.now() / 1000) + 3600}],
    };
    expect(resolver.getPassportScore(passportInfo).score).to.equal(1);

    let rejectNewReload: (error: Error) => void;
    let releaseRollback: () => void;
    let newReloadGate = new Promise<void>((resolve, reject) => {
      rejectNewReload = reject;
    });
    let rollbackGate = new Promise<void>((resolve) => {
      releaseRollback = resolve;
    });
    let reloadResolver = sinon.stub(resolver, "reload");
    reloadResolver.onFirstCall().returns(newReloadGate);
    reloadResolver.onSecondCall().returns(rollbackGate);

    let reloadResult = passportModule.setModuleConfig({
      ...passportModule.getModuleConfig(),
      stampScoring: {first: 2},
    }).then(() => null, (error) => error as Error);
    await awaitSleepPromise(1000, () => reloadResolver.callCount === 1);
    let newConfigScore = resolver.getPassportScore(passportInfo).score;

    rejectNewReload(new Error("test reload failure"));
    await awaitSleepPromise(1000, () => reloadResolver.callCount === 2);
    let restoredConfigScore = resolver.getPassportScore(passportInfo).score;
    releaseRollback();
    let reloadError = await reloadResult;

    expect(reloadResolver.callCount).to.equal(2, "configuration rollback did not reload the resolver");
    expect(newConfigScore).to.equal(2, "new configuration reused the old cached score during reload drain");
    expect(restoredConfigScore).to.equal(1, "rollback reused the new cached score during resolver drain");
    expect(reloadError?.message).to.equal("test reload failure");
    expect(passportModule.getModuleConfig().stampScoring.first).to.equal(1, "failed reload did not restore configuration");
  });

  it("Reject manual passports above the configured stamp limit", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      maxPassportStamps: 2,
    } as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let resolver = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport").getPassportResolver();
    let result = await resolver.verifyUserPassport(
      "0x332E43696A505EF45b9319973785F837ce5267b9",
      JSON.stringify((testData as any).testPassport1Json)
    );
    expect(result.valid).to.equal(false, "oversized passport was accepted");
    expect(result.errors[0]).to.match(/Invalid Passport JSON/, "unexpected stamp-limit error");
  });

  it("Reject manual passport request bodies above the configured byte limit", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      refreshCooldown: 0,
      maxPassportBytes: 1024,
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    await ServiceManager.GetService(ModuleManager).initialize();
    let session = await createRunningPassportSession();
    let response = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "POST",
      url: "/api/refreshPassport?session=" + session.getSessionId(),
    } as any, Buffer.from(JSON.stringify("x".repeat(2048))));
    expect(response.code).to.equal("PASSPORT_VALIDATION", "oversized passport request was accepted");
    expect(response.error).to.match(/size limit/, "unexpected passport byte-limit error");
  });

  it("Rate limit repeated manual verification attempts", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      refreshCooldown: 30,
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    await ServiceManager.GetService(ModuleManager).initialize();
    let session = await createRunningPassportSession();
    let request = {
      method: "POST",
      url: "/api/refreshPassport?session=" + session.getSessionId(),
    } as any;
    let body = Buffer.from("{");
    let firstResponse = await ServiceManager.GetService(FaucetWebApi).onApiRequest(request, body);
    expect(firstResponse.code).to.equal("PASSPORT_VALIDATION", "first invalid passport attempt returned an unexpected response");
    let secondResponse = await ServiceManager.GetService(FaucetWebApi).onApiRequest(request, body);
    expect(secondResponse.code).to.equal("REFRESH_COOLDOWN", "repeated manual verification bypassed the cooldown");
    expect(secondResponse.cooldown).to.be.greaterThan(Math.floor(Date.now() / 1000), "manual verification cooldown was not returned");
  });

  it("Anchor manual cooldowns at completion and block duplicate work in flight", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      refreshCooldown: 30,
    } as any;
    globalStubs["fetch"].returns(returnDelayedPromise(false, "test api error"));
    await ServiceManager.GetService(ModuleManager).initialize();
    let session = await createRunningPassportSession();
    let passportModule = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport");
    let resolver = passportModule.getPassportResolver();
    let currentTime = 1000;
    sinon.stub(Date.prototype, "getTime").callsFake(() => currentTime * 1000);

    let releaseVerification: (result: any) => void;
    let pendingVerification = new Promise<any>((resolve) => {
      releaseVerification = resolve;
    });
    let verifyUserPassport = sinon.stub(resolver, "verifyUserPassport");
    verifyUserPassport.onFirstCall().returns(pendingVerification);
    verifyUserPassport.resolves({valid: false, errors: ["expected verification failure"]});
    let request = {
      method: "POST",
      url: "/api/refreshPassport?session=" + session.getSessionId(),
    } as any;
    let body = Buffer.from(JSON.stringify(JSON.stringify((testData as any).testPassport1Json)));

    let firstRequest = ServiceManager.GetService(FaucetWebApi).onApiRequest(request, body);
    expect(verifyUserPassport.callCount).to.equal(1, "manual verification did not start");
    currentTime = 1031;
    let duplicateResponse = await ServiceManager.GetService(FaucetWebApi).onApiRequest(request, body);
    expect(duplicateResponse.code).to.equal("REFRESH_COOLDOWN", "in-flight verification admitted duplicate work");
    expect(verifyUserPassport.callCount).to.equal(1, "duplicate request reached passport verification");

    releaseVerification({valid: false, errors: ["expected verification failure"]});
    let failedResponse = await firstRequest;
    expect(failedResponse.cooldown).to.equal(1061, "failed verification kept its admission-time cooldown");
    let failedRetry = await ServiceManager.GetService(FaucetWebApi).onApiRequest(request, body);
    expect(failedRetry.code).to.equal("REFRESH_COOLDOWN");
    expect(failedRetry.cooldown).to.equal(failedResponse.cooldown, "returned cooldown did not match the stored completion anchor");

    currentTime = failedResponse.cooldown;
    let parseManualPassportPayload = sinon.stub(passportModule as any, "parseManualPassportPayload").callsFake(() => {
      currentTime += 31;
      return {kind: "invalid", error: "Invalid passport request"};
    });
    let invalidResponse = await ServiceManager.GetService(FaucetWebApi).onApiRequest(request, body);
    expect(invalidResponse.code).to.equal("PASSPORT_VALIDATION");
    expect(invalidResponse.cooldown).to.equal(currentTime + 30, "invalid payload kept its admission-time cooldown");
    let invalidRetry = await ServiceManager.GetService(FaucetWebApi).onApiRequest(request, body);
    expect(invalidRetry.code).to.equal("REFRESH_COOLDOWN");
    expect(invalidRetry.cooldown).to.equal(invalidResponse.cooldown);
    expect(parseManualPassportPayload.callCount).to.equal(1, "invalid retry reached payload parsing during cooldown");
  });

  it("Bound concurrent manual DIDKit verification", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      manualVerificationConcurrency: 1,
      maxPassportBytes: 1024 * 1024,
    } as any;
    globalStubs["PassportResolver.getVerifyTime"] = sinon.stub(PassportResolver.prototype as any, "getVerifyTime").returns(1686844923);
    await ServiceManager.GetService(ModuleManager).initialize();
    let resolver = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport").getPassportResolver();
    let releaseFirstVerification: (result: string) => void;
    let firstVerification = new Promise<string>((resolve) => {
      releaseFirstVerification = resolve;
    });
    let validDIDKitResult = JSON.stringify({checks: ["proof"], errors: []});
    let verifyCredential = sinon.stub(PassportDIDKitVerifier.prototype, "verifyCredential");
    verifyCredential.onFirstCall().returns(firstVerification);
    verifyCredential.resolves(validDIDKitResult);
    let parsePassportJson = sinon.spy(resolver as any, "parsePassportJson");
    let passportJson = JSON.stringify((testData as any).testPassport1Json);
    let firstResultPromise = resolver.verifyUserPassport("0x332E43696A505EF45b9319973785F837ce5267b9", passportJson);
    await awaitSleepPromise(1000, () => verifyCredential.callCount > 0);
    let parseCallsBeforeRejectedRequest = parsePassportJson.callCount;
    let secondResult = await resolver.verifyUserPassport(
      "0x332E43696A505EF45b9319973785F837ce5267b9",
      "x".repeat(1024 * 1024),
    );
    expect(secondResult.code).to.equal("PASSPORT_BUSY", "concurrent manual verification entered DIDKit");
    expect(parsePassportJson.callCount).to.equal(
      parseCallsBeforeRejectedRequest,
      "concurrent manual verification parsed its passport before admission",
    );
    releaseFirstVerification(validDIDKitResult);
    let firstResult = await firstResultPromise;
    expect(firstResult.valid).to.equal(true, "admitted manual verification failed");
  }).timeout(5000);

  it("starts the verification deadline only after worker initialization", async () => {
    let worker = new TestPassportWorker();
    let verifier = new PassportDIDKitVerifier({
      verifyTimeoutMs: 20,
      initTimeoutMs: 100,
      maxPendingVerifications: 1,
      workerFactory: () => worker,
    });
    let verification = verifier.verifyCredential("credential", "options");
    void verification.catch(() => undefined);

    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(worker.messages).to.deep.equal([], "queued verification was dispatched before worker readiness");

      worker.onPostMessage = (message) => setTimeout(() => worker.send({
        action: "verified",
        data: {reqId: message.data.reqId, result: "verified"},
      }), 10);
      worker.send({action: "init"});

      expect(await verification).to.equal("verified");
      expect(worker.messages).to.have.length(1);
    } finally {
      await verifier.stop();
    }
  });

  it("keeps worker initialization independently bounded", async () => {
    let worker = new TestPassportWorker();
    let verifier = new PassportDIDKitVerifier({
      verifyTimeoutMs: 100,
      initTimeoutMs: 5,
      maxPendingVerifications: 1,
      restartBackoffMs: 1_000,
      workerFactory: () => worker,
    });

    try {
      let error = await verifier.verifyCredential("credential", "options").then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).to.be.instanceOf(PassportVerificationUnavailableError);
      expect((error as Error).message).to.include("initialization timed out");
      expect(worker.messages).to.deep.equal([], "unready worker received verification work");
      expect(worker.terminateCalls).to.equal(1);
    } finally {
      await verifier.stop();
    }
  });

  it("Terminates a timed-out DIDKit worker generation and recovers capacity", async () => {
    let workers: TestPassportWorker[] = [];
    let verifier = new PassportDIDKitVerifier({
      verifyTimeoutMs: 20,
      initTimeoutMs: 100,
      maxPendingVerifications: 2,
      restartBackoffMs: 1,
      maxRestartBackoffMs: 1,
      workerFactory: () => {
        let worker = new TestPassportWorker();
        let workerIndex = workers.push(worker) - 1;
        if(workerIndex > 0) {
          worker.onPostMessage = (message) => setTimeout(() => worker.send({
            action: "verified",
            data: {reqId: message.data.reqId, result: "recovered"},
          }), 0);
        }
        setTimeout(() => worker.send({action: "init"}), 0);
        return worker;
      },
    });

    let timedOutError: Error | null = null;
    try {
      await verifier.verifyCredential("credential", "options");
    } catch(ex) {
      timedOutError = ex;
    }
    await awaitSleepPromise(1000, () => workers.length >= 2);
    expect(timedOutError).to.be.instanceOf(PassportVerificationUnavailableError);
    expect(timedOutError?.message).to.include("timed out");
    expect(workers[0].terminateCalls).to.equal(1, "timed-out worker was not terminated");
    expect(workers.length).to.be.greaterThanOrEqual(2, "worker capacity was not recreated");

    let recovered = await verifier.verifyCredential("credential", "options");
    expect(recovered).to.equal("recovered");
    await verifier.stop();
  });

  it("Rejects generation-owned DIDKit work after worker errors and exits", async () => {
    for(let failure of ["error", "exit"] as const) {
      let workers: TestPassportWorker[] = [];
      let verifier = new PassportDIDKitVerifier({
        verifyTimeoutMs: 1000,
        initTimeoutMs: 100,
        maxPendingVerifications: 1,
        restartBackoffMs: 1,
        maxRestartBackoffMs: 1,
        workerFactory: () => {
          let worker = new TestPassportWorker();
          workers.push(worker);
          setTimeout(() => worker.send({action: "init"}), 0);
          return worker;
        },
      });
      let pending = verifier.verifyCredential("credential", "options");
      let rejected = pending.catch((error) => error as Error);
      await awaitSleepPromise(1000, () => workers[0]?.messages.length === 1);
      expect(workers[0]?.messages.length).to.equal(1, failure + " test did not dispatch verification");
      if(failure === "error")
        workers[0].emit("error", new Error("worker error"));
      else
        workers[0].emit("exit", 1);

      let error = await rejected;
      await awaitSleepPromise(1000, () => workers.length >= 2);
      expect(error).to.be.instanceOf(PassportVerificationUnavailableError);
      expect(workers[0].terminateCalls).to.equal(1, failure + " did not terminate the failed generation");
      expect(workers.length).to.be.greaterThanOrEqual(2, failure + " did not recover worker capacity");
      await verifier.stop();
    }
  });

  it("Stays fail closed after termination rejection until reload drains the old generation", async () => {
    let workers: TestPassportWorker[] = [];
    let firstWorker = new TestPassportWorker();
    let terminationAttempt = 0;
    firstWorker.terminateImpl = () => {
      terminationAttempt++;
      return terminationAttempt === 1
        ? Promise.reject(new Error("termination rejected"))
        : Promise.resolve(0);
    };
    let verifier = new PassportDIDKitVerifier({
      verifyTimeoutMs: 1000,
      initTimeoutMs: 100,
      maxPendingVerifications: 1,
      restartBackoffMs: 1,
      maxRestartBackoffMs: 1,
      workerFactory: () => {
        let worker = workers.length === 0 ? firstWorker : new TestPassportWorker();
        workers.push(worker);
        if(worker !== firstWorker) {
          worker.onPostMessage = (message) => setTimeout(() => worker.send({
            action: "verified",
            data: {reqId: message.data.reqId, result: "recovered"},
          }), 0);
        }
        setTimeout(() => worker.send({action: "init"}), 0);
        return worker;
      },
    });

    let pending = verifier.verifyCredential("credential", "options");
    let rejected = pending.catch((error) => error as Error);
    await awaitSleepPromise(1000, () => firstWorker.messages.length === 1);
    firstWorker.emit("error", new Error("worker failed"));
    expect(await rejected).to.be.instanceOf(PassportVerificationUnavailableError);
    await new Promise((resolve) => setTimeout(resolve, 0));

    let blocked = await verifier.verifyCredential("credential", "options").catch((error) => error as Error);
    expect(blocked).to.be.instanceOf(PassportVerificationUnavailableError);
    expect(workers.length).to.equal(1, "replacement worker started before old termination was proven");

    await verifier.reload();
    expect(firstWorker.terminateCalls).to.equal(2, "reload did not retry the rejected termination");
    expect(await verifier.verifyCredential("credential", "options")).to.equal("recovered");
    expect(workers.length).to.equal(2, "reload did not restore verifier capacity after draining the old worker");
    await verifier.stop();
  });

  it("Keeps shutdown retryable when worker termination rejects", async () => {
    let worker = new TestPassportWorker();
    let terminationAttempt = 0;
    worker.terminateImpl = () => {
      terminationAttempt++;
      return terminationAttempt === 1
        ? Promise.reject(new Error("termination rejected"))
        : Promise.resolve(0);
    };
    let verifier = new PassportDIDKitVerifier({
      verifyTimeoutMs: 1000,
      initTimeoutMs: 100,
      maxPendingVerifications: 1,
      workerFactory: () => {
        setTimeout(() => worker.send({action: "init"}), 0);
        return worker;
      },
    });
    let pending = verifier.verifyCredential("credential", "options");
    let rejected = pending.catch((error) => error as Error);
    await awaitSleepPromise(1000, () => worker.messages.length === 1);

    let firstStop = verifier.stop();
    expect(await rejected).to.be.instanceOf(PassportVerificationUnavailableError);
    expect(await firstStop.catch((error) => error as Error)).to.have.property("message", "termination rejected");
    expect(worker.terminateCalls).to.equal(1);

    let secondStop = verifier.stop();
    expect(secondStop).to.not.equal(firstStop, "failed stop returned a permanently rejected drain promise");
    await secondStop;
    expect(worker.terminateCalls).to.equal(2, "shutdown did not retry the rejected termination");
    expect(verifier.stop()).to.equal(secondStop, "successful shutdown did not keep its drain promise");
  });

  it("Awaits DIDKit worker termination during reload and rejects old-generation work", async () => {
    let workers: TestPassportWorker[] = [];
    let releaseTermination: (code: number) => void;
    let firstWorker = new TestPassportWorker();
    firstWorker.terminateImpl = () => new Promise<number>((resolve) => {
      releaseTermination = resolve;
    });
    workers.push(firstWorker);
    let verifier = new PassportDIDKitVerifier({
      verifyTimeoutMs: 1000,
      initTimeoutMs: 100,
      maxPendingVerifications: 1,
      workerFactory: () => {
        let worker = workers.shift() || new TestPassportWorker();
        if(worker !== firstWorker) {
          worker.onPostMessage = (message) => setTimeout(() => worker.send({
            action: "verified",
            data: {reqId: message.data.reqId, result: "fresh"},
          }), 0);
        }
        setTimeout(() => worker.send({action: "init"}), 0);
        return worker;
      },
    });
    let inFlight = verifier.verifyCredential("credential", "options");
    let rejected = inFlight.catch((error) => error as Error);
    await awaitSleepPromise(1000, () => firstWorker.messages.length === 1);

    let reloadSettled = false;
    let reload = verifier.reload().then(() => {
      reloadSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reloadSettled).to.equal(false, "reload returned before worker termination completed");
    expect(await rejected).to.be.instanceOf(PassportVerificationUnavailableError);
    releaseTermination(0);
    await reload;
    expect(firstWorker.terminateCalls).to.equal(1);

    let fresh = await verifier.verifyCredential("credential", "options");
    expect(fresh).to.equal("fresh");
    let firstStop = verifier.stop();
    expect(verifier.stop()).to.equal(firstStop, "stop did not return its owned drain promise");
    await firstStop;
  });

  it("Records transient scorer failures as errors and retries instead of caching absence", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      cacheTime: 86400,
    } as any;
    globalStubs["fetch"].onFirstCall().rejects(new Error("temporary scorer failure"));
    globalStubs["fetch"].onSecondCall().resolves({
      status: 200,
      json: () => Promise.resolve(cloneScorerResponse()),
    });
    await ServiceManager.GetService(ModuleManager).initialize();
    let resolver = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport").getPassportResolver();
    let address = "0x332E43696A505EF45b9319973785F837ce5267b9";

    let failedLookup = await resolver.getPassport(address);
    let errorRow = await ServiceManager.GetService(FaucetDatabase).getDatabase().get(
      "SELECT Outcome FROM PassportCache WHERE Address = ?",
      [address.toLowerCase()],
    ) as any;
    let retriedLookup = await resolver.getPassport(address);

    expect(failedLookup.found).to.equal(false);
    expect(errorRow?.Outcome).to.equal("error", "transient failure was stored as a successful empty lookup");
    expect(retriedLookup.found).to.equal(true, "error cache row suppressed a later scorer retry");
    expect(globalStubs["fetch"].callCount).to.equal(2);
  });

  it("coalesces concurrent database initialization until the database is ready", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    await database.closeDatabase();
    let initializationStarted = new PromiseDfd<void>();
    let initializationGate = new PromiseDfd<void>();
    let initDatabase = sinon.stub(database as any, "initDatabase").callsFake(async () => {
      initializationStarted.resolve();
      await initializationGate.promise;
    });
    let firstSettled = false;
    let secondSettled = false;

    let first = database.initialize().then(() => {
      firstSettled = true;
    });
    let second = database.initialize().then(() => {
      secondSettled = true;
    });
    await initializationStarted.promise;

    expect(initDatabase.calledOnce).to.equal(true, "concurrent initialize opened twice");
    expect(firstSettled).to.equal(false);
    expect(secondSettled).to.equal(false);
    expect((database as any).initialized).to.equal(false, "database published readiness before open");
    expect((database as any).cleanupTimer).to.equal(null, "database scheduled cleanup before open");

    initializationGate.resolve();
    await Promise.all([first, second]);

    expect((database as any).initialized).to.equal(true);
    expect((database as any).cleanupTimer).to.not.equal(null);
  });

  it("coalesces concurrent database closes", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    let closeSpy = sinon.spy(driver, "close");

    let first = database.closeDatabase();
    let second = database.closeDatabase();

    expect(second).to.equal(first, "concurrent closes did not share ownership");
    await Promise.all([first, second]);
    expect(closeSpy.calledOnce).to.equal(true, "concurrent closes closed the driver more than once");
  });

  it("awaits SQLite worker termination and blocks reinitialization until close completes", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let worker = (database as any).dbWorker;
    let terminate = worker.terminate.bind(worker);
    let terminationStarted = new PromiseDfd<void>();
    let terminationGate = new PromiseDfd<void>();
    sinon.stub(worker, "terminate").callsFake(async () => {
      terminationStarted.resolve();
      await terminationGate.promise;
      return terminate();
    });
    let closeSettled = false;

    let close = database.closeDatabase().then(() => {
      closeSettled = true;
    });
    await terminationStarted.promise;
    expect(closeSettled).to.equal(false, "database close returned before worker termination");
    let initializationError = await database.initialize()
      .then(() => null, (error) => error as Error);
    expect(initializationError?.message).to.equal(
      "Database cannot initialize while close is in progress or database resources remain.",
    );

    terminationGate.resolve();
    await close;
    expect(closeSettled).to.equal(true);
  });

  it("keeps failed SQLite worker termination retryable and blocks reinitialization", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let worker = (database as any).dbWorker;
    let terminate = worker.terminate.bind(worker);
    let terminationFailure = new Error("test database worker termination failure");
    let terminateStub = sinon.stub(worker, "terminate");
    terminateStub.onFirstCall().rejects(terminationFailure);
    terminateStub.onSecondCall().callsFake(() => terminate());

    let closeError = await database.closeDatabase()
      .then(() => null, (error) => error as Error);
    expect(closeError).to.be.instanceOf(AggregateError);
    expect((database as any).dbWorker).to.equal(worker, "failed close discarded worker ownership");

    let initializationError = await database.initialize()
      .then(() => null, (error) => error as Error);
    expect(initializationError?.message).to.equal(
      "Database cannot initialize while close is in progress or database resources remain.",
    );

    await database.closeDatabase();
    expect(terminateStub.callCount).to.equal(2, "retry close did not retry worker termination");
    expect((database as any).dbWorker).to.equal(null);
  });

  it("drains database initialization before closing without scheduling late cleanup", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    await database.closeDatabase();
    let initializationStarted = new PromiseDfd<void>();
    let initializationGate = new PromiseDfd<void>();
    let upgradeSchema = (database as any).upgradeSchema.bind(database);
    sinon.stub(database as any, "upgradeSchema").callsFake(async () => {
      initializationStarted.resolve();
      await initializationGate.promise;
      await upgradeSchema();
    });

    let initialization = database.initialize();
    await initializationStarted.promise;
    let driver = database.getDatabase();
    let closeSpy = sinon.spy(driver, "close");
    let close = database.closeDatabase();
    await Promise.resolve();

    expect(closeSpy.called).to.equal(false, "driver closed underneath schema initialization");
    initializationGate.resolve();
    let initializationError = await initialization.then(() => null, (error) => error as Error);
    let closeError = await close.then(() => null, (error) => error as Error);

    expect(initializationError?.message).to.equal(
      "Database initialization completed after shutdown began.",
    );
    expect(closeError).to.be.instanceOf(AggregateError);
    expect(closeSpy.calledOnce).to.equal(true);
    expect((database as any).initialized).to.equal(false);
    expect((database as any).cleanupTimer).to.equal(null, "shutdown race scheduled a cleanup timer");
  });

  it("retries a failed module database initialization before publishing it", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let module = {getModuleName: () => "passport-init-retry"} as any;
    let initializationFailure = new Error("test module database initialization failure");
    let initSchema = sinon.stub(PassportDB.prototype, "initSchema");
    initSchema.onFirstCall().callsFake(async () => {
      throw initializationFailure;
    });
    initSchema.onSecondCall().resolves();

    let firstError = await database.createModuleDb(PassportDB, module)
      .then(() => null, (error) => error as Error);
    let initialized = await database.createModuleDb(PassportDB, module);
    let reused = await database.createModuleDb(PassportDB, module);

    expect(firstError).to.equal(initializationFailure);
    expect(initSchema.callCount).to.equal(2, "failed module database remained cached");
    expect(reused).to.equal(initialized, "successful module database was not published");
  });

  it("coalesces concurrent module database initialization", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let module = {getModuleName: () => "passport-init-concurrent"} as any;
    let initializationGate = new PromiseDfd<void>();
    let initSchema = sinon.stub(PassportDB.prototype, "initSchema")
      .callsFake(() => initializationGate.promise);

    let first = database.createModuleDb(PassportDB, module);
    let second = database.createModuleDb(PassportDB, module);
    await Promise.resolve();
    expect(initSchema.callCount).to.equal(1, "concurrent calls started separate schema initialization");

    initializationGate.resolve();
    let [firstDb, secondDb] = await Promise.all([first, second]);

    expect(firstDb).to.equal(secondDb, "concurrent calls received different module databases");
  });

  it("drains an in-flight module database initialization before closing", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    let module = {getModuleName: () => "passport-init-shutdown"} as any;
    let initializationStarted = new PromiseDfd<void>();
    let initializationGate = new PromiseDfd<void>();
    sinon.stub(PassportDB.prototype, "initSchema").callsFake(async () => {
      initializationStarted.resolve();
      await initializationGate.promise;
    });
    let closeSpy = sinon.spy(driver, "close");

    let initialization = database.createModuleDb(PassportDB, module);
    await initializationStarted.promise;
    let close = database.closeDatabase();
    let lateInitializationError = await database.createModuleDb(PassportDB, {
      getModuleName: () => "passport-init-after-shutdown",
    } as any).then(() => null, (error) => error as Error);
    await Promise.resolve();

    expect(closeSpy.called).to.equal(false, "driver closed before module initialization drained");
    expect(lateInitializationError?.message).to.equal(
      "Module database passport-init-after-shutdown cannot initialize before database readiness or during shutdown.",
    );

    initializationGate.resolve();
    let initializationError = await initialization.then(() => null, (error) => error as Error);
    let closeError = await close.then(() => null, (error) => error as Error);

    expect(initializationError?.message).to.equal(
      "Module database passport-init-shutdown finished initializing after database shutdown began.",
    );
    expect(closeError).to.be.instanceOf(AggregateError);
    expect(closeSpy.calledOnce).to.equal(true, "driver was not closed after initialization drained");
  });

  it("closes the driver after an in-flight module database initialization fails", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    let module = {getModuleName: () => "passport-init-shutdown-failure"} as any;
    let initializationStarted = new PromiseDfd<void>();
    let initializationGate = new PromiseDfd<void>();
    let initializationFailure = new Error("test shutdown initialization failure");
    sinon.stub(PassportDB.prototype, "initSchema").callsFake(async () => {
      initializationStarted.resolve();
      await initializationGate.promise;
      throw initializationFailure;
    });
    let closeSpy = sinon.spy(driver, "close");

    let initialization = database.createModuleDb(PassportDB, module);
    await initializationStarted.promise;
    let close = database.closeDatabase();
    await Promise.resolve();
    expect(closeSpy.called).to.equal(false, "driver closed before failed initialization drained");

    initializationGate.resolve();
    let initializationError = await initialization.then(() => null, (error) => error as Error);
    let closeError = await close.then(() => null, (error) => error as Error);

    expect(initializationError).to.equal(initializationFailure);
    expect(closeError).to.be.instanceOf(AggregateError);
    expect(closeSpy.calledOnce).to.equal(true, "initialization failure prevented driver close");
  });

  it("permits reinitialization after clean close without reusing a published module database", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let module = {getModuleName: () => "passport-reopened-driver"} as any;
    let initSchema = sinon.stub(PassportDB.prototype, "initSchema").resolves();

    let beforeClose = await database.createModuleDb(PassportDB, module);
    await database.closeDatabase();
    await database.initialize();
    let afterReopen = await database.createModuleDb(PassportDB, module);

    expect(afterReopen).to.not.equal(beforeClose);
    expect(initSchema.callCount).to.equal(2, "reopened driver reused the prior module database");
  });

  it("rejects an incompatible current SQLite Passport schema", async () => {
    let databaseService = ServiceManager.GetService(FaucetDatabase);
    let database = databaseService.getDatabase();
    await database.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", ["passport", 3]);
    await database.exec(`
      CREATE TABLE PassportCache (
        Address TEXT NOT NULL UNIQUE,
        Json TEXT NOT NULL,
        Timeout INTEGER NOT NULL,
        Outcome TEXT NOT NULL DEFAULT 'error',
        TrustGeneration TEXT NOT NULL DEFAULT '',
        CacheGeneration TEXT NOT NULL DEFAULT '',
        OwnershipExpiry INTEGER NULL,
        PRIMARY KEY(Address)
      );
      CREATE INDEX PassportCacheTimeIdx ON PassportCache (Timeout ASC);
      CREATE TABLE PassportStamps (
        StampHash TEXT COLLATE NOCASE NOT NULL UNIQUE,
        Address TEXT NOT NULL,
        Timeout INTEGER NOT NULL,
        PRIMARY KEY(StampHash)
      );
      CREATE INDEX PassportStampsTimeIdx ON PassportStamps (Timeout ASC);
      CREATE TABLE PassportCacheState (
        Id INTEGER NOT NULL,
        CacheGeneration TEXT NOT NULL,
        TrustGeneration TEXT NOT NULL,
        PRIMARY KEY(Id)
      );
      INSERT INTO PassportCacheState (Id, CacheGeneration, TrustGeneration) VALUES (1, '', '');
    `);
    let passportDb = new PassportDB(
      {getModuleName: () => "passport"} as any,
      databaseService,
    );

    let schemaError = await passportDb.initSchema().then(() => null, (error) => error as Error);

    expect(schemaError?.message).to.equal(
      "Passport schema primary key PassportStamps.StampHash has an incompatible definition.",
    );
    expect((await database.get(
      "SELECT Version FROM SchemaVersion WHERE Module = ?",
      ["passport"],
    ) as Record<string, unknown>).Version).to.equal(3);
  });

  it("rejects a generated column in a current SQLite Passport schema", async () => {
    let databaseService = ServiceManager.GetService(FaucetDatabase);
    let database = databaseService.getDatabase();
    let module = {getModuleName: () => "passport"} as any;
    await new PassportDB(module, databaseService).initSchema();
    await database.exec(`
      ALTER TABLE PassportCache
      ADD COLUMN Poison TEXT GENERATED ALWAYS AS (Address) VIRTUAL
    `);

    let schemaError = await new PassportDB(module, databaseService).initSchema()
      .then(() => null, (error) => error as Error);

    expect(schemaError?.message).to.equal(
      "Passport schema table PassportCache contains unsupported hidden column Poison.",
    );
    expect((await database.get(
      "SELECT Version FROM SchemaVersion WHERE Module = ?",
      ["passport"],
    ) as Record<string, unknown>).Version).to.equal(3);
  });

  it("rejects a future Passport schema version", async () => {
    let databaseService = ServiceManager.GetService(FaucetDatabase);
    let database = databaseService.getDatabase();
    await database.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", ["passport", 4]);
    let passportDb = new PassportDB(
      {getModuleName: () => "passport"} as any,
      databaseService,
    );

    let schemaError = await passportDb.initSchema().then(() => null, (error) => error as Error);

    expect(schemaError?.message).to.equal(
      "Module passport has an unsupported schema version; expected a safe integer from 0 through 3.",
    );
    expect(await database.all("PRAGMA table_xinfo(PassportCache)")).to.deep.equal([]);
  });

  it("rejects a version 1 SQLite Passport schema missing its ownership ledger", async () => {
    let databaseService = ServiceManager.GetService(FaucetDatabase);
    let database = databaseService.getDatabase();
    await database.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", ["passport", 1]);
    await database.exec(`
      CREATE TABLE PassportCache (
        Address TEXT NOT NULL UNIQUE,
        Json TEXT NOT NULL,
        Timeout INTEGER NOT NULL,
        PRIMARY KEY(Address)
      )
    `);
    let passportDb = new PassportDB(
      {getModuleName: () => "passport"} as any,
      databaseService,
    );

    let schemaError = await passportDb.initSchema().then(() => null, (error) => error as Error);

    expect(schemaError?.message).to.equal(
      "Passport schema version 1 is missing required table PassportStamps.",
    );
    expect(await database.all("PRAGMA table_xinfo(PassportStamps)")).to.deep.equal([]);
  });

  it("rejects a version 2 SQLite Passport schema missing its state table", async () => {
    let databaseService = ServiceManager.GetService(FaucetDatabase);
    let database = databaseService.getDatabase();
    await database.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", ["passport", 2]);
    await database.exec(`
      CREATE TABLE PassportCache (
        Address TEXT NOT NULL UNIQUE,
        Json TEXT NOT NULL,
        Timeout INTEGER NOT NULL,
        Outcome TEXT NOT NULL DEFAULT 'error',
        TrustGeneration TEXT NOT NULL DEFAULT '',
        CacheGeneration TEXT NOT NULL DEFAULT '',
        OwnershipExpiry INTEGER NULL,
        PRIMARY KEY(Address)
      );
      CREATE TABLE PassportStamps (
        StampHash TEXT NOT NULL UNIQUE,
        Address TEXT NOT NULL,
        Timeout INTEGER NOT NULL,
        PRIMARY KEY(StampHash)
      )
    `);
    let passportDb = new PassportDB(
      {getModuleName: () => "passport"} as any,
      databaseService,
    );

    let schemaError = await passportDb.initSchema().then(() => null, (error) => error as Error);

    expect(schemaError?.message).to.equal(
      "Passport schema version 2 is missing required table PassportCacheState.",
    );
    expect(await database.all("PRAGMA table_xinfo(PassportCacheState)")).to.deep.equal([]);
  });

  it("rejects a partial SQLite Passport cleanup index", async () => {
    let databaseService = ServiceManager.GetService(FaucetDatabase);
    let database = databaseService.getDatabase();
    let module = {getModuleName: () => "passport"} as any;
    await new PassportDB(module, databaseService).initSchema();
    await database.exec("DROP INDEX PassportCacheTimeIdx");
    await database.exec(`
      CREATE INDEX PassportCacheTimeIdx ON PassportCache (Timeout ASC)
      WHERE Timeout > 0
    `);

    let schemaError = await new PassportDB(module, databaseService).initSchema()
      .then(() => null, (error) => error as Error);

    expect(schemaError?.message).to.equal(
      "Passport schema index PassportCacheTimeIdx has an incompatible definition.",
    );
  });

  it("loops SQLite Passport cleanup batches through a tie-heavy backlog", async () => {
    let databaseService = ServiceManager.GetService(FaucetDatabase);
    let database = databaseService.getDatabase();
    let passportDb = new PassportDB(
      {getModuleName: () => "passport"} as any,
      databaseService,
    );
    await passportDb.initSchema();
    sinon.stub(passportDb as any, "now").returns(1000);
    let rowCount = 1001;
    await database.run([
      "WITH RECURSIVE Rows(RowNumber) AS (",
      "SELECT 0 UNION ALL SELECT RowNumber + 1 FROM Rows WHERE RowNumber + 1 < ?",
      ") INSERT INTO PassportCache (Address, Json, Timeout)",
      "SELECT printf('0x%040x', RowNumber), '{}', 999 FROM Rows",
    ].join(" "), [rowCount]);
    await database.run([
      "WITH RECURSIVE Rows(RowNumber) AS (",
      "SELECT 0 UNION ALL SELECT RowNumber + 1 FROM Rows WHERE RowNumber + 1 < ?",
      ") INSERT INTO PassportStamps (StampHash, Address, Timeout)",
      "SELECT printf('cleanup-%04d', RowNumber),",
      "printf('0x%040x', RowNumber), 999 FROM Rows",
    ].join(" "), [rowCount]);

    await passportDb.cleanStore();

    expect((await database.get("SELECT COUNT(*) AS Count FROM PassportCache") as {Count: number}).Count)
      .to.equal(0);
    expect((await database.get("SELECT COUNT(*) AS Count FROM PassportStamps") as {Count: number}).Count)
      .to.equal(0);
  });

  it("caps Passport cleanup at 10000 rows per table and resumes on the next run", async () => {
    let databaseService = ServiceManager.GetService(FaucetDatabase);
    let driver = databaseService.getDatabase();
    let passportDb = new PassportDB(
      {getModuleName: () => "passport-cleanup-ceiling"} as any,
      databaseService,
    );
    sinon.stub(passportDb as any, "now").returns(1000);
    let cacheBatches = 0;
    let stampBatches = 0;
    sinon.stub(driver, "run").callsFake(async (sql) => {
      if(String(sql).includes("DELETE FROM PassportCache")) {
        cacheBatches++;
        return {changes: cacheBatches <= 10 ? 1000 : 1, lastInsertRowid: 0};
      }
      if(String(sql).includes("DELETE FROM PassportStamps")) {
        stampBatches++;
        return {changes: stampBatches <= 10 ? 1000 : 1, lastInsertRowid: 0};
      }
      throw new Error("unexpected cleanup query");
    });

    await passportDb.cleanStore();
    expect(cacheBatches).to.equal(10);
    expect(stampBatches).to.equal(10);

    await passportDb.cleanStore();
    expect(cacheBatches).to.equal(11, "next run did not resume cache cleanup");
    expect(stampBatches).to.equal(11, "next run did not resume stamp cleanup");
  });

  it("Drops ambiguous version 1 cache rows during the outcome-schema migration", async () => {
    let database = ServiceManager.GetService(FaucetDatabase).getDatabase();
    await database.exec(`
      CREATE TABLE PassportCache (
        Address TEXT NOT NULL UNIQUE,
        Json TEXT NOT NULL,
        Timeout INTEGER NOT NULL,
        PRIMARY KEY(Address)
      );
      CREATE TABLE PassportStamps (
        StampHash TEXT NOT NULL UNIQUE,
        Address TEXT NOT NULL,
        Timeout INTEGER NOT NULL,
        PRIMARY KEY(StampHash)
      );
    `);
    await database.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", ["passport", 1]);
    await database.run(
      "INSERT INTO PassportCache (Address, Json, Timeout) VALUES (?, ?, ?)",
      [
        "0x00000000000000000000000000000000000000aa",
        JSON.stringify({found: false, parsed: 1, newest: 0}),
        Math.floor(Date.now() / 1000) + 86400,
      ],
    );
    faucetConfig.modules["passport"] = {enabled: true} as any;

    await ServiceManager.GetService(ModuleManager).initialize();
    let oldRow = await database.get("SELECT Address FROM PassportCache");
    let schemaVersion = await database.get(
      "SELECT Version FROM SchemaVersion WHERE Module = ?",
      ["passport"],
    ) as any;

    expect(oldRow).to.equal(null, "ambiguous legacy absence survived migration");
    expect(schemaVersion?.Version).to.equal(3);
  });

  it("Resumes SQLite Passport migrations after every committed schema and state mutation", async () => {
    let databaseService = ServiceManager.GetService(FaucetDatabase);
    let database = databaseService.getDatabase();
    let fixtures = [0, 1];

    for(let fixtureVersion of fixtures) {
      await database.exec("DROP TABLE IF EXISTS PassportCacheState");
      await database.exec("DROP TABLE IF EXISTS PassportStamps");
      await database.exec("DROP TABLE IF EXISTS PassportCache");
      await database.run("DELETE FROM SchemaVersion WHERE Module = ?", ["passport"]);

      if(fixtureVersion === 1) {
        await database.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", ["passport", 1]);
        await database.exec(`
          CREATE TABLE PassportCache (
            Address TEXT NOT NULL UNIQUE,
            Json TEXT NOT NULL,
            Timeout INTEGER NOT NULL,
            PRIMARY KEY(Address)
          )`);
        await database.exec(`
          CREATE TABLE PassportStamps (
            StampHash TEXT NOT NULL UNIQUE,
            Address TEXT NOT NULL,
            Timeout INTEGER NOT NULL,
            PRIMARY KEY(StampHash)
          )`);
        await database.run(
          "INSERT INTO PassportCache (Address, Json, Timeout) VALUES (?, ?, ?)",
          [
            "0x00000000000000000000000000000000000000aa",
            JSON.stringify({found: true, parsed: 1, newest: 1}),
            Math.floor(Date.now() / 1000) + 300,
          ],
        );
        await database.run(
          "INSERT INTO PassportStamps (StampHash, Address, Timeout) VALUES (?, ?, ?)",
          [
            "restart-stamp",
            "0x00000000000000000000000000000000000000bb",
            Math.floor(Date.now() / 1000) + 300,
          ],
        );
      }

      let passportDb = new PassportDB(
        {getModuleName: () => "passport"} as any,
        databaseService,
      );
      let originalExec = database.exec.bind(database);
      let originalRun = database.run.bind(database);
      let interruptedStatements = new Set<string>();
      let shouldInterrupt = (sql: string): boolean => {
        let statement = sql.replace(/\s+/g, " ").trim();
        return statement.startsWith('CREATE TABLE "Passport')
          || statement.startsWith('ALTER TABLE "PassportCache" ADD COLUMN')
          || statement.startsWith('CREATE INDEX "Passport')
          || statement === "DELETE FROM PassportCache"
          || statement.startsWith("INSERT INTO PassportCacheState");
      };
      let execStub = sinon.stub(database, "exec").callsFake(async (sql) => {
        await originalExec(sql);
        let statement = String(sql).replace(/\s+/g, " ").trim();
        if(shouldInterrupt(statement) && !interruptedStatements.has(statement)) {
          interruptedStatements.add(statement);
          throw new Error("injected SQLite Passport migration interruption");
        }
      });
      let runStub = sinon.stub(database, "run").callsFake(async (sql, values) => {
        let result = await originalRun(sql, values);
        let statement = String(sql).replace(/\s+/g, " ").trim();
        if(shouldInterrupt(statement) && !interruptedStatements.has(statement)) {
          interruptedStatements.add(statement);
          throw new Error("injected SQLite Passport migration interruption");
        }
        return result;
      });

      let completed = false;
      try {
        for(let attempt = 0; attempt < 20 && !completed; attempt++) {
          try {
            await passportDb.initSchema();
            completed = true;
          } catch(error) {
            expect(String(error)).to.include("injected SQLite Passport migration interruption");
            let version = await database.get(
              "SELECT Version FROM SchemaVersion WHERE Module = ?",
              ["passport"],
            ) as Record<string, unknown>;
            expect(version.Version).to.equal(fixtureVersion);
          }
        }
      } finally {
        execStub.restore();
        runStub.restore();
      }

      expect(completed, `v${fixtureVersion}`).to.equal(true);
      expect((await database.get(
        "SELECT Version FROM SchemaVersion WHERE Module = ?",
        ["passport"],
      ) as Record<string, unknown>).Version).to.equal(3);
      expect((await database.all("PRAGMA table_info(PassportCache)"))
        .map((column) => column.name)).to.include.members([
          "Outcome",
          "TrustGeneration",
          "CacheGeneration",
          "OwnershipExpiry",
        ]);
      expect(await database.get(
        "SELECT CacheGeneration, TrustGeneration FROM PassportCacheState WHERE Id = 1",
      )).to.deep.equal({CacheGeneration: "", TrustGeneration: ""});
      if(fixtureVersion === 1) {
        expect(Array.from(interruptedStatements).some(
          (statement) => statement.includes('ADD COLUMN "Outcome"'),
        )).to.equal(true, "partial column migration was not exercised");
        expect(Array.from(interruptedStatements).some(
          (statement) => statement.startsWith('CREATE TABLE "PassportCacheState"'),
        )).to.equal(true, "partial state-table migration was not exercised");
        expect(Array.from(interruptedStatements).some(
          (statement) => statement.startsWith("INSERT INTO PassportCacheState"),
        )).to.equal(true, "partial state-row migration was not exercised");
        expect(await database.get("SELECT Address FROM PassportCache")).to.equal(null);
        expect(await database.get(
          "SELECT Address FROM PassportStamps WHERE StampHash = ?",
          ["restart-stamp"],
        )).to.deep.equal({Address: "0x00000000000000000000000000000000000000bb"});
      }
    }
  });

  it("Rejects an incompatible partial SQLite Passport schema before changing it", async () => {
    let databaseService = ServiceManager.GetService(FaucetDatabase);
    let database = databaseService.getDatabase();
    await database.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", ["passport", 1]);
    await database.exec(`
      CREATE TABLE PassportCache (
        Address TEXT NOT NULL UNIQUE,
        Json TEXT NOT NULL,
        Timeout INTEGER NOT NULL,
        Outcome INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(Address)
      );
      CREATE TABLE PassportStamps (
        StampHash TEXT NOT NULL UNIQUE,
        Address TEXT NOT NULL,
        Timeout INTEGER NOT NULL,
        PRIMARY KEY(StampHash)
      )
    `);
    await database.run(
      "INSERT INTO PassportCache (Address, Json, Timeout) VALUES (?, ?, ?)",
      [
        "0x00000000000000000000000000000000000000aa",
        JSON.stringify({found: true, parsed: 1, newest: 1}),
        Math.floor(Date.now() / 1000) + 300,
      ],
    );
    let before = await database.all("PRAGMA table_info(PassportCache)");
    let passportDb = new PassportDB(
      {getModuleName: () => "passport"} as any,
      databaseService,
    );

    let migrationError = await passportDb.initSchema().then(() => null, (error) => error);

    expect(String(migrationError)).to.include(
      "Passport schema column PassportCache.Outcome has an incompatible definition.",
    );
    expect(await database.all("PRAGMA table_info(PassportCache)")).to.deep.equal(before);
    expect(await database.get("SELECT Address FROM PassportCache")).to.deep.equal({
      Address: "0x00000000000000000000000000000000000000aa",
    });
    expect(await database.all("PRAGMA table_info(PassportCacheState)")).to.deep.equal([]);
    expect((await database.get(
      "SELECT Version FROM SchemaVersion WHERE Module = ?",
      ["passport"],
    ) as Record<string, unknown>).Version).to.equal(1);
  });

  it("Rejects a SQLite Passport stamp primary key with NOCASE collation", async () => {
    let databaseService = ServiceManager.GetService(FaucetDatabase);
    let database = databaseService.getDatabase();
    await database.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", ["passport", 1]);
    await database.exec(`
      CREATE TABLE PassportCache (
        Address TEXT NOT NULL UNIQUE,
        Json TEXT NOT NULL,
        Timeout INTEGER NOT NULL,
        PRIMARY KEY(Address)
      );
      CREATE TABLE PassportStamps (
        StampHash TEXT COLLATE NOCASE NOT NULL UNIQUE,
        Address TEXT NOT NULL,
        Timeout INTEGER NOT NULL,
        PRIMARY KEY(StampHash)
      )
    `);
    await database.run(
      "INSERT INTO PassportCache (Address, Json, Timeout) VALUES (?, ?, ?)",
      [
        "0x00000000000000000000000000000000000000aa",
        JSON.stringify({found: true, parsed: 1, newest: 1}),
        Math.floor(Date.now() / 1000) + 300,
      ],
    );
    let primaryIndex = (await database.all("PRAGMA index_list(PassportStamps)"))
      .find((index) => index.origin === "pk") as Record<string, unknown>;
    let before = await database.all(`PRAGMA index_xinfo("${primaryIndex.name}")`);
    let passportDb = new PassportDB(
      {getModuleName: () => "passport"} as any,
      databaseService,
    );

    let migrationError = await passportDb.initSchema().then(() => null, (error) => error);

    expect(String(migrationError)).to.include(
      "Passport schema primary key PassportStamps.StampHash has an incompatible definition.",
    );
    expect(await database.all(`PRAGMA index_xinfo("${primaryIndex.name}")`)).to.deep.equal(before);
    expect(await database.get("SELECT Address FROM PassportCache")).to.deep.equal({
      Address: "0x00000000000000000000000000000000000000aa",
    });
    expect(await database.all("PRAGMA table_xinfo(PassportCacheState)")).to.deep.equal([]);
    expect((await database.get(
      "SELECT Version FROM SchemaVersion WHERE Module = ?",
      ["passport"],
    ) as Record<string, unknown>).Version).to.equal(1);
  });

  it("Rejects an unexpected required SQLite Passport column before changing the schema", async () => {
    let databaseService = ServiceManager.GetService(FaucetDatabase);
    let database = databaseService.getDatabase();
    await database.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", ["passport", 1]);
    await database.exec(`
      CREATE TABLE PassportCache (
        Address TEXT NOT NULL UNIQUE,
        Json TEXT NOT NULL,
        Timeout INTEGER NOT NULL,
        Poison TEXT NOT NULL,
        PRIMARY KEY(Address)
      );
      CREATE TABLE PassportStamps (
        StampHash TEXT NOT NULL UNIQUE,
        Address TEXT NOT NULL,
        Timeout INTEGER NOT NULL,
        PRIMARY KEY(StampHash)
      )
    `);
    await database.run(
      "INSERT INTO PassportCache (Address, Json, Timeout, Poison) VALUES (?, ?, ?, ?)",
      [
        "0x00000000000000000000000000000000000000aa",
        JSON.stringify({found: true, parsed: 1, newest: 1}),
        Math.floor(Date.now() / 1000) + 300,
        "required",
      ],
    );
    let before = await database.all("PRAGMA table_xinfo(PassportCache)");
    let passportDb = new PassportDB(
      {getModuleName: () => "passport"} as any,
      databaseService,
    );

    let migrationError = await passportDb.initSchema().then(() => null, (error) => error);

    expect(String(migrationError)).to.include(
      "Passport schema table PassportCache contains unexpected column Poison.",
    );
    expect(await database.all("PRAGMA table_xinfo(PassportCache)")).to.deep.equal(before);
    expect(await database.get("SELECT Address, Poison FROM PassportCache")).to.deep.equal({
      Address: "0x00000000000000000000000000000000000000aa",
      Poison: "required",
    });
    expect(await database.all("PRAGMA table_xinfo(PassportCacheState)")).to.deep.equal([]);
    expect((await database.get(
      "SELECT Version FROM SchemaVersion WHERE Module = ?",
      ["passport"],
    ) as Record<string, unknown>).Version).to.equal(1);
  });

  it("Invalidates positive cache rows when the trust generation changes", async () => {
    faucetConfig.modules["passport"] = {enabled: true, scorerApiKey: "test-api-key"} as any;
    globalStubs["fetch"].onFirstCall().resolves({
      status: 200,
      json: () => Promise.resolve(cloneScorerResponse()),
    });
    globalStubs["fetch"].onSecondCall().resolves({
      status: 200,
      json: () => Promise.resolve({items: []}),
    });
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportModule = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport");
    let resolver = passportModule.getPassportResolver();
    let address = "0x332E43696A505EF45b9319973785F837ce5267b9";
    let first = await resolver.getPassport(address);
    let firstTrustRow = await ServiceManager.GetService(FaucetDatabase).getDatabase().get(
      "SELECT TrustGeneration FROM PassportCache WHERE Address = ?",
      [address.toLowerCase()],
    ) as any;

    await passportModule.setModuleConfig({
      ...passportModule.getModuleConfig(),
      trustedIssuers: [],
    });
    let second = await resolver.getPassport(address);
    let secondTrustRow = await ServiceManager.GetService(FaucetDatabase).getDatabase().get(
      "SELECT TrustGeneration FROM PassportCache WHERE Address = ?",
      [address.toLowerCase()],
    ) as any;

    expect(first.found).to.equal(true);
    expect(second.found).to.equal(false, "positive row survived an incompatible trust reload");
    expect(globalStubs["fetch"].callCount).to.equal(2, "trust reload reused the old positive cache row");
    expect(secondTrustRow?.TrustGeneration).to.not.equal(firstTrustRow?.TrustGeneration);
  });

  it("Keeps stale SQLite cache rows inert across same-trust reuse and failed activation restart", async () => {
    faucetConfig.modules["passport"] = {enabled: true} as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportModule = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport");
    let passportDb = passportModule.getPassportDb();
    let resolver = passportModule.getPassportResolver() as any;
    let driver = ServiceManager.GetService(FaucetDatabase).getDatabase();
    let activeGeneration = resolver.cacheGeneration as string;
    let trustGeneration = resolver.trustGeneration as string;
    let staleGeneration = "11111111-1111-4111-8111-111111111111";
    let invalidatedGeneration = "22222222-2222-4222-8222-222222222222";
    let restartedGeneration = "33333333-3333-4333-8333-333333333333";
    let restartedTrustGeneration = "cd".repeat(32);
    let activeAddress = "0x0000000000000000000000000000000000000001";
    let staleAddress = "0x0000000000000000000000000000000000000002";
    let timeout = Math.floor(Date.now() / 1000) + 300;

    expect(await passportDb.setPassportInfo({
      address: activeAddress,
      outcome: "empty",
      info: {found: false, parsed: 1, newest: 0},
      duration: 300,
      cacheGeneration: activeGeneration,
      trustGeneration,
    })).to.equal(true);
    await driver.run(
      `INSERT INTO PassportCache
       (Address, Json, Timeout, Outcome, TrustGeneration, OwnershipExpiry, CacheGeneration)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        staleAddress,
        JSON.stringify({found: false, parsed: 2, newest: 0}),
        timeout,
        "empty",
        trustGeneration,
        null,
        staleGeneration,
      ],
    );

    let reusedGeneration = await passportDb.activateCacheGeneration(
      invalidatedGeneration,
      trustGeneration,
      false,
    );
    let rowsAfterReuse = await driver.all(
      "SELECT Address, CacheGeneration, TrustGeneration FROM PassportCache ORDER BY Address",
    );
    let activeAfterReuse = await passportDb.getPassportInfo(activeAddress, activeGeneration, trustGeneration);

    let publishedGeneration = await passportDb.activateCacheGeneration(
      invalidatedGeneration,
      trustGeneration,
      true,
    );
    let rowsAfterInvalidation = await driver.all(
      "SELECT Address, CacheGeneration, TrustGeneration FROM PassportCache ORDER BY Address",
    );
    let activeUnderInvalidatedGeneration = await passportDb.getPassportInfo(
      activeAddress,
      invalidatedGeneration,
      trustGeneration,
    );

    let run = driver.run.bind(driver);
    let activationFailure = new Error("test SQLite activation failure");
    let failActivation = sinon.stub(driver, "run").callsFake(async (sql, args) => {
      if(sql.includes("UPDATE PassportCacheState"))
        throw activationFailure;
      return run(sql, args);
    });
    let failedActivation = await passportDb.activateCacheGeneration(
      restartedGeneration,
      restartedTrustGeneration,
      true,
    ).then(() => null, (error) => error as Error);
    failActivation.restore();
    let stateAfterFailure = await driver.get(
      "SELECT CacheGeneration, TrustGeneration FROM PassportCacheState WHERE Id = 1",
    );
    let rowsAfterFailure = await driver.all(
      "SELECT Address, CacheGeneration, TrustGeneration FROM PassportCache ORDER BY Address",
    );

    let restartedPassportDb = new PassportDB(passportModule, ServiceManager.GetService(FaucetDatabase));
    await restartedPassportDb.initSchema();
    let restarted = await restartedPassportDb.activateCacheGeneration(
      restartedGeneration,
      restartedTrustGeneration,
      true,
    );
    let stateAfterRestart = await driver.get(
      "SELECT CacheGeneration, TrustGeneration FROM PassportCacheState WHERE Id = 1",
    );
    let rowsAfterRestart = await driver.all(
      "SELECT Address, CacheGeneration, TrustGeneration FROM PassportCache ORDER BY Address",
    );

    expect(reusedGeneration).to.equal(activeGeneration, "same-trust activation replaced the active generation");
    expect(activeAfterReuse?.info.parsed).to.equal(1, "same-trust activation lost the active cache row");
    expect(rowsAfterReuse).to.deep.equal([
      {Address: activeAddress, CacheGeneration: activeGeneration, TrustGeneration: trustGeneration},
      {Address: staleAddress, CacheGeneration: staleGeneration, TrustGeneration: trustGeneration},
    ]);
    expect(publishedGeneration).to.equal(invalidatedGeneration);
    expect(rowsAfterInvalidation).to.deep.equal(rowsAfterReuse, "explicit invalidation rewrote SQLite cache rows");
    expect(activeUnderInvalidatedGeneration).to.equal(null, "old active row remained readable after invalidation");
    expect(failedActivation).to.equal(activationFailure);
    expect(stateAfterFailure).to.deep.equal({
      CacheGeneration: invalidatedGeneration,
      TrustGeneration: trustGeneration,
    });
    expect(rowsAfterFailure).to.deep.equal(rowsAfterReuse, "failed activation changed SQLite cache rows");
    expect(restarted).to.equal(restartedGeneration);
    expect(stateAfterRestart).to.deep.equal({
      CacheGeneration: restartedGeneration,
      TrustGeneration: restartedTrustGeneration,
    });
    expect(rowsAfterRestart).to.deep.equal(rowsAfterReuse, "restart activation revived or rewrote a stale SQLite row");
  });

  it("Expires positive cache credit with stamp ownership and rechecks transfer", async () => {
    let dbNow = 1000;
    sinon.stub(PassportDB.prototype as any, "now").callsFake(() => dbNow);
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      cacheTime: 86400,
      stampDeduplicationTime: 2,
    } as any;
    let addressA = "0x00000000000000000000000000000000000000aa";
    let addressB = "0x00000000000000000000000000000000000000bb";
    globalStubs["fetch"].onFirstCall().resolves({
      status: 200,
      json: () => Promise.resolve(scorerResponseForAddress(addressA)),
    });
    globalStubs["fetch"].onSecondCall().resolves({
      status: 200,
      json: () => Promise.resolve(scorerResponseForAddress(addressB)),
    });
    globalStubs["fetch"].onThirdCall().resolves({
      status: 200,
      json: () => Promise.resolve(scorerResponseForAddress(addressB)),
    });
    await ServiceManager.GetService(ModuleManager).initialize();
    let resolver = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport").getPassportResolver();

    await resolver.getPassport(addressA);
    let duplicate = await resolver.getPassport(addressB);
    expect(duplicate.stamps?.every((stamp) => stamp.duplicate === addressA)).to.equal(true);
    let cacheRow = await ServiceManager.GetService(FaucetDatabase).getDatabase().get(
      "SELECT Timeout, OwnershipExpiry FROM PassportCache WHERE Address = ?",
      [addressB],
    ) as any;
    expect(cacheRow.Timeout).to.equal(1002, "positive cache outlived stamp ownership");
    expect(cacheRow.OwnershipExpiry).to.equal(1002);

    dbNow = 1002;
    let transferred = await resolver.getPassport(addressB);
    expect(transferred.stamps?.some((stamp) => stamp.duplicate)).to.equal(false, "expired ownership was not rechecked");
    expect(globalStubs["fetch"].callCount).to.equal(3, "ownership expiry did not force a fresh scorer lookup");
    let stampHash = cloneScorerResponse().items[0].credential.credentialSubject.hash;
    let owner = await ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport")
      .getPassportDb().getPassportStamps([stampHash]);
    expect(owner[stampHash]).to.equal(addressB, "expired stamp ownership did not transfer");
  });

  it("Rejects a cache write carrying an old resolver generation after reload", async () => {
    faucetConfig.modules["passport"] = {enabled: true} as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportModule = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport");
    let resolver: any = passportModule.getPassportResolver();
    let passportDb = passportModule.getPassportDb();
    let oldCacheGeneration = resolver.cacheGeneration as string;
    let oldTrustGeneration = resolver.trustGeneration as string;
    let releaseOldWrite: () => void;
    let oldWrite = new Promise<boolean>((resolve, reject) => {
      releaseOldWrite = () => passportDb.setPassportInfo({
        address: "0x00000000000000000000000000000000000000aa",
        outcome: "success",
        info: {found: true, parsed: 1, newest: 1, stamps: []},
        duration: 60,
        cacheGeneration: oldCacheGeneration,
        trustGeneration: oldTrustGeneration,
      }).then(resolve, reject);
    });

    await resolver.reload();
    releaseOldWrite();
    expect(await oldWrite).to.equal(false, "old generation repopulated the cache after reload");
    let staleRow = await ServiceManager.GetService(FaucetDatabase).getDatabase().get(
      "SELECT Address FROM PassportCache WHERE Address = ?",
      ["0x00000000000000000000000000000000000000aa"],
    );
    expect(staleRow).to.equal(null);
  });

  it("Rejects positive lookup credit when stamp ownership expires before the cache write", async () => {
    let dbNow = 1000;
    sinon.stub(PassportDB.prototype as any, "now").callsFake(() => dbNow);
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
      stampDeduplicationTime: 1,
    } as any;
    globalStubs["fetch"].resolves({
      status: 200,
      json: () => Promise.resolve(cloneScorerResponse()),
    });
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportModule = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport");
    let passportDb = passportModule.getPassportDb();
    let claimStamps = passportDb.claimPassportStampsWithExpiry.bind(passportDb);
    sinon.stub(passportDb, "claimPassportStampsWithExpiry").callsFake(async (stampHashes, address, duration) => {
      let claims = await claimStamps(stampHashes, address, duration);
      dbNow++;
      return claims;
    });

    let lookupError = await passportModule.getPassportResolver()
      .getPassport("0x332E43696A505EF45b9319973785F837ce5267b9")
      .then(() => null, (error) => error as Error);
    let cacheRow = await ServiceManager.GetService(FaucetDatabase).getDatabase().get(
      "SELECT Address FROM PassportCache WHERE Address = ?",
      ["0x332e43696a505ef45b9319973785f837ce5267b9"],
    );

    expect(lookupError).to.be.instanceOf(Error, "expired ownership returned positive lookup credit");
    expect(cacheRow).to.equal(null, "expired ownership was written to the positive cache");
  });

  it("Rejects positive lookup credit when a stamp has no authoritative owner", async () => {
    faucetConfig.modules["passport"] = {
      enabled: true,
      scorerApiKey: "test-api-key",
    } as any;
    globalStubs["fetch"].resolves({
      status: 200,
      json: () => Promise.resolve(cloneScorerResponse()),
    });
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportModule = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport");
    sinon.stub(passportModule.getPassportDb(), "claimPassportStampsWithExpiry").callsFake(async (stampHashes) => {
      return Object.fromEntries(stampHashes.map((stampHash) => [stampHash, {address: null, expiresAt: null}]));
    });

    let lookupError = await passportModule.getPassportResolver()
      .getPassport("0x332E43696A505EF45b9319973785F837ce5267b9")
      .then(() => null, (error) => error as Error);
    let cacheRow = await ServiceManager.GetService(FaucetDatabase).getDatabase().get(
      "SELECT Address FROM PassportCache WHERE Address = ?",
      ["0x332e43696a505ef45b9319973785f837ce5267b9"],
    );

    expect(lookupError).to.be.instanceOf(Error, "ownerless stamp returned positive lookup credit");
    expect(cacheRow).to.equal(null, "ownerless stamp was written to the positive cache");
  });

  it("Reclaims a stamp when cleanup runs between ownership claim steps", async () => {
    let dbNow = 1000;
    sinon.stub(PassportDB.prototype as any, "now").callsFake(() => dbNow);
    faucetConfig.modules["passport"] = {enabled: true} as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportDb = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport").getPassportDb();
    let driver = ServiceManager.GetService(FaucetDatabase).getDatabase();
    let stampHash = "cleanup-race-stamp";
    let oldOwner = "0x0000000000000000000000000000000000000001";
    let claimant = "0x0000000000000000000000000000000000000002";
    await driver.run(
      "INSERT INTO PassportStamps (StampHash, Address, Timeout) VALUES (?, ?, ?)",
      [stampHash, oldOwner, dbNow - 1],
    );
    let run = driver.run.bind(driver);
    let cleanupRan = false;
    sinon.stub(driver, "run").callsFake(async (sql, args) => {
      if(!cleanupRan && sql.includes("UPDATE PassportStamps SET Address")) {
        cleanupRan = true;
        await passportDb.cleanStore();
      }
      return run(sql, args);
    });

    let claims = await passportDb.claimPassportStampsWithExpiry([stampHash], claimant, 60);

    expect(cleanupRan).to.equal(true, "cleanup interleaving was not exercised");
    expect(claims[stampHash].address).to.equal(claimant);
    expect(claims[stampHash].expiresAt).to.equal(dbNow + 60);
  });

  it("Retries and fails closed when a stamp claim disappears", async () => {
    faucetConfig.modules["passport"] = {enabled: true} as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportDb = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport").getPassportDb();
    let driver = ServiceManager.GetService(FaucetDatabase).getDatabase();
    let stampHash = "vanishing-stamp";
    let claimant = "0x0000000000000000000000000000000000000002";
    let run = driver.run.bind(driver);
    let all = driver.all.bind(driver);
    let claimReads = 0;
    sinon.stub(driver, "all").callsFake(async (sql, args) => {
      if(sql.includes("RequestedHash")) {
        claimReads++;
        await run("DELETE FROM PassportStamps WHERE StampHash = ?", [stampHash]);
      }
      return all(sql, args);
    });

    let claimError = await passportDb.claimPassportStampsWithExpiry([stampHash], claimant, 60)
      .then(() => null, (error) => error as Error);

    expect(claimError).to.be.instanceOf(Error, "missing stamp ownership was returned as an unowned claim");
    expect(claimReads).to.equal(2, "stamp claim did not use the bounded retry");
  });

  it("Assign each stamp hash to one normalized address atomically", async () => {
    faucetConfig.modules["passport"] = {enabled: true} as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportDb = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport").getPassportDb();
    let stampHash = "test-stamp-hash";
    let addressA = "0x00000000000000000000000000000000000000AA";
    let addressB = "0x00000000000000000000000000000000000000bb";
    let [claimA, claimB] = await Promise.all([
      passportDb.claimPassportStamps([stampHash, stampHash], addressA, 60),
      passportDb.claimPassportStamps([stampHash], addressB, 60),
    ]);
    expect(claimA[stampHash]).to.equal(claimB[stampHash], "concurrent claims observed different owners");
    expect([addressA.toLowerCase(), addressB.toLowerCase()]).to.include(claimA[stampHash], "stamp owner was not normalized");
    let persisted = await passportDb.getPassportStamps([stampHash]);
    expect(persisted[stampHash]).to.equal(claimA[stampHash], "atomic stamp owner was not persisted");
  });

  it("Treats mixed-case SQLite stamp hashes as distinct identities", async () => {
    faucetConfig.modules["passport"] = {enabled: true} as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportDb = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport").getPassportDb();
    let upperHash = "CaseSensitiveStamp";
    let lowerHash = "casesensitivestamp";
    let addressA = "0x00000000000000000000000000000000000000aa";
    let addressB = "0x00000000000000000000000000000000000000bb";

    await passportDb.claimPassportStamps([upperHash], addressA, 60);
    await passportDb.claimPassportStamps([lowerHash], addressB, 60);
    let claims = await passportDb.getPassportStamps([upperHash, lowerHash]);

    expect(claims).to.deep.equal({
      [upperHash]: addressA,
      [lowerHash]: addressB,
    });
  });

  it("Preserves full-width multibyte SQLite stamp identities", async () => {
    faucetConfig.modules["passport"] = {enabled: true} as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportDb = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport").getPassportDb();
    let multibyteHash = "€".repeat(250);
    let sharedPrefix = "é".repeat(125);
    let longHashA = sharedPrefix + "A";
    let longHashB = sharedPrefix + "B";
    let addressA = "0x00000000000000000000000000000000000000aa";
    let addressB = "0x00000000000000000000000000000000000000bb";
    let addressC = "0x00000000000000000000000000000000000000cc";

    expect(multibyteHash.length).to.equal(250);
    expect(Buffer.byteLength(multibyteHash, "utf8")).to.equal(750);
    expect(Buffer.byteLength(sharedPrefix, "utf8")).to.equal(250);
    await passportDb.claimPassportStamps([multibyteHash], addressA, 60);
    await passportDb.claimPassportStamps([longHashA], addressB, 60);
    await passportDb.claimPassportStamps([longHashB], addressC, 60);
    let claims = await passportDb.getPassportStamps([multibyteHash, longHashA, longHashB]);

    expect(claims).to.deep.equal({
      [multibyteHash]: addressA,
      [longHashA]: addressB,
      [longHashB]: addressC,
    });
  });

  it("Rejects a Passport stamp identity above the 1000-byte database capacity", async () => {
    faucetConfig.modules["passport"] = {enabled: true} as any;
    await ServiceManager.GetService(ModuleManager).initialize();
    let passportDb = ServiceManager.GetService(ModuleManager).getModule<PassportModule>("passport").getPassportDb();
    let oversizedHash = "😀".repeat(251);
    let address = "0x00000000000000000000000000000000000000aa";

    expect(Buffer.byteLength(oversizedHash, "utf8")).to.equal(1004);
    let claimError = await passportDb.claimPassportStamps([oversizedHash], address, 60)
      .then(() => null, (error) => error as Error);

    expect(claimError?.message).to.equal("invalid passport stamp hash batch");
  });

});
