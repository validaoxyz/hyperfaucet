import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { bindTestStubs, loadDefaultTestConfig, unbindTestStubs } from './common.js';
import { ServiceManager } from '../src/common/ServiceManager.js';
import { FAUCETSTATUS_CACHE_TIME, FaucetWebApi } from '../src/webserv/FaucetWebApi.js';
import { IncomingHttpHeaders, IncomingMessage } from 'http';
import { Socket } from 'net';
import { FaucetDatabase } from '../src/db/FaucetDatabase.js';
import { ModuleHookAction, ModuleManager } from '../src/modules/ModuleManager.js';
import { faucetConfig } from '../src/config/FaucetConfig.js';
import { FaucetHttpResponse } from '../src/webserv/FaucetHttpServer.js';
import { FaucetSession, FaucetSessionStatus, FaucetSessionStoreData } from '../src/session/FaucetSession.js';
import { getNewGuid } from '../src/utils/GuidUtils.js';
import { SessionManager } from '../src/session/SessionManager.js';
import { EthClaimManager } from '../src/eth/EthClaimManager.js';
import { FaucetError, PublicFaucetError } from '../src/common/FaucetError.js';
import { EthWalletManager } from '../src/eth/EthWalletManager.js';
import { FakeProvider } from './stubs/FakeProvider.js';
import { PUBLIC_CLAIM_FAILED_MESSAGE, PUBLIC_INTERNAL_ERROR_MESSAGE } from '../src/webserv/PublicErrors.js';
import { FaucetProcess } from '../src/common/FaucetProcess.js';
import { FaucetStatus, FaucetStatusLevel } from '../src/services/FaucetStatus.js';

describe("Faucet Web API", () => {
  let globalStubs;

  beforeEach(async () => {
    globalStubs = bindTestStubs({});
    loadDefaultTestConfig();
    faucetConfig.pseudonymKey = "test-pseudonym-key";
    await ServiceManager.GetService(FaucetDatabase).initialize();
    await ServiceManager.GetService(ModuleManager).initialize();
    await ServiceManager.GetService(EthClaimManager).initialize();
  });
  afterEach(async () => {
    let dbService = ServiceManager.GetService(FaucetDatabase);
    await ServiceManager.DisposeAllServices();
    await dbService.closeDatabase();
    await unbindTestStubs(globalStubs);
  });

  function encodeApiRequest(options: {
    url: string;
    remoteAddr: string;
    method?: string;
    headers?: IncomingHttpHeaders;
  }): IncomingMessage {
    let socketData = {
      remoteAddress: options.remoteAddr,
    };
    let socket: Socket = socketData as any;
    Object.setPrototypeOf(socket, Socket.prototype);
    let messageData = {
      method: options.method || "GET",
      socket: socket,
      url: options.url,
      headers: options.headers || {},
    };
    let message: IncomingMessage = messageData as any;
    Object.setPrototypeOf(message, IncomingMessage.prototype);
    return message;
  }

  async function addTestSession(data: Partial<FaucetSessionStoreData>): Promise<FaucetSessionStoreData> {
    let sessionData: FaucetSessionStoreData = Object.assign({
      sessionId: getNewGuid(),
      startTime: Math.floor(new Date().getTime() / 1000),
      status: FaucetSessionStatus.CLAIMABLE,
      dropAmount: "100",
      remoteIP: "8.8.8.8",
      targetAddr: "0x0000000000000000000000000000000000001337",
      tasks: [],
      data: {},
      claim: null,
    }, data);
    await ServiceManager.GetService(FaucetDatabase).updateSession(sessionData);
    return sessionData;
  }

  function decodeJsonHttpResponse(response: FaucetHttpResponse): any {
    expect(response).to.be.instanceOf(FaucetHttpResponse, "expected an HTTP response envelope");
    expect(response.headers["Cache-Control"]).to.equal("no-store", "status response may be cached");
    return JSON.parse(response.body);
  }

  it("check unknown endpoint call", async () => {
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/unknown_Endpoint_126368?x=y&z",
      remoteAddr: "8.8.8.8"
    }));
    expect(apiResponse instanceof FaucetHttpResponse).equal(true, "no api error response");
    expect(apiResponse.code).equal(404, "unexpected response code");
  });

  it("check null endpoint call", async () => {
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api",
      remoteAddr: "8.8.8.8"
    }));
    expect(apiResponse instanceof FaucetHttpResponse).equal(true, "no api error response");
    expect(apiResponse.code).equal(404, "unexpected response code");
  });

  it("check /api/getVersion", async () => {
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getVersion",
      remoteAddr: "8.8.8.8"
    }));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse).equal(faucetConfig.faucetVersion, "unexpected response value");
  });

  it("check /api/getMaxReward", async () => {
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getMaxReward",
      remoteAddr: "8.8.8.8"
    }));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse).equal(faucetConfig.maxDropAmount, "unexpected response value");
  });

  it("check /api/getFaucetConfig", async () => {
    let fakeProvider = new FakeProvider();
    fakeProvider.injectResponse("eth_chainId", 1337);
    fakeProvider.injectResponse("eth_getBalance", "1000");
    fakeProvider.injectResponse("eth_getTransactionCount", 42);

    faucetConfig.ethWalletKey = "feedbeef12340000feedbeef12340000feedbeef12340000feedbeef12340000";
    faucetConfig.ethRpcHost = fakeProvider as any;
    faucetConfig.faucetHomeHtml = "test123 {faucetWallet}"

    let walletManager = ServiceManager.GetService(EthWalletManager);
    walletManager.initialize();

    let releaseConfigHook: () => void;
    let configHookGate = new Promise<void>((resolve) => {
      releaseConfigHook = resolve;
    });
    ServiceManager.GetService(ModuleManager).addActionHook(
      null,
      ModuleHookAction.ClientConfig,
      100,
      "gated-test-config",
      async (moduleConfig: Record<string, unknown>) => {
        await configHookGate;
        moduleConfig["gated-test"] = {ready: true};
      },
    );
    let webApi = new FaucetWebApi();
    let responseSettled = false;
    let responsePromise = webApi.onApiRequest(encodeApiRequest({
      url: "/api/getFaucetConfig?cliver=0.0.1337",
      remoteAddr: "8.8.8.8"
    })).finally(() => {
      responseSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(responseSettled).to.equal(false, "client config returned before module hooks completed");
    releaseConfigHook();
    let apiResponse = await responsePromise;
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.faucetTitle).equal(faucetConfig.faucetTitle, "unexpected response value");
    expect(apiResponse.faucetHtml).to.contain(walletManager.getFaucetAddress(), "unexpected response value");
    expect(apiResponse.modules["gated-test"]).to.deep.equal({ready: true});
    const obsoleteImageField = "faucet" + "Image";
    expect(apiResponse).not.to.have.property(obsoleteImageField);
    expect(apiResponse).not.to.have.property("resultSharing");
  });

  it("check /api/getFaucetConfig (with session)", async () => {
    let webApi = new FaucetWebApi();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });

    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getFaucetConfig?cliver=0.0.1337&session=" + testSession.getSessionId(),
      remoteAddr: "8.8.8.8"
    }));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.faucetTitle).equal(faucetConfig.faucetTitle, "unexpected response value");
  });

  it("check /api/startSession", async () => {
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      method: "POST",
      url: "/api/startSession",
      remoteAddr: "8.8.8.8"
    }), Buffer.from(JSON.stringify({
      addr: "0x0000000000000000000000000000000000001337"
    })));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.status).equal("claimable", "unexpected response session status");
  });

  it("rejects session admission while the faucet reports that it is empty", async () => {
    const emptyMessage = "The faucet is empty. Wait for it to be refilled and try again";
    const emptyStatus = ServiceManager.GetService(FaucetStatus).setFaucetStatus(
      "wallet",
      emptyMessage,
      FaucetStatusLevel.ERROR,
    );
    emptyStatus.blocksSessionStart = true;
    const sessionManager = ServiceManager.GetService(SessionManager);
    const createSession = sinon.spy(sessionManager, "createSession");

    try {
      const apiResponse = await new FaucetWebApi().onApiRequest(encodeApiRequest({
        method: "POST",
        url: "/api/startSession",
        remoteAddr: "8.8.8.8",
      }), Buffer.from(JSON.stringify({
        addr: "0x0000000000000000000000000000000000001337",
      })));

      expect(apiResponse).deep.include({
        status: FaucetSessionStatus.FAILED,
        failedCode: "FAUCET_EMPTY",
        failedReason: emptyMessage,
      });
      expect(createSession.called).to.equal(false, "empty faucet reached session admission");
    }
    finally {
      createSession.restore();
    }
  });

  it("check /api/startSession (behind proxy)", async () => {
    faucetConfig.httpProxyCount = 2
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      method: "POST",
      url: "/api/startSession",
      remoteAddr: "8.8.8.8",
      headers: {
        "x-forwarded-for": "1.2.3.4, 2.2.2.2, 3.3.3.3",
      },
    }), Buffer.from(JSON.stringify({
      addr: "0x0000000000000000000000000000000000001337"
    })));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.status).equal("claimable", "unexpected response session status");

    let sessionData = await ServiceManager.GetService(SessionManager).getSessionData(apiResponse.session);
    expect(!!sessionData).equal(true, "session not found");
    expect(sessionData.remoteIP).equal("2.2.2.2", "session remote ip mismatch");
  });

  it("rejects an incomplete trusted proxy chain", async () => {
    faucetConfig.httpProxyCount = 2;
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      method: "POST",
      url: "/api/startSession",
      remoteAddr: "10.0.0.3",
      headers: {
        "x-forwarded-for": "1.2.3.4",
      },
    }), Buffer.from(JSON.stringify({
      addr: "0x0000000000000000000000000000000000001337",
    })));

    expect(apiResponse.status).equal(FaucetSessionStatus.FAILED);
    expect(apiResponse.failedCode).equal("INVALID_REMOTE_IP");
    expect(apiResponse.failedReason).equal("Unable to determine a valid client IP address.");
  });

  it("check /api/startSession (invalid method)", async () => {
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      method: "GET",
      url: "/api/startSession",
      remoteAddr: "8.8.8.8"
    }));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse instanceof FaucetHttpResponse).equal(true, "unexpected api response type");
    expect(apiResponse.code).equal(405, "unexpected response http code");
    expect(apiResponse.reason).equal("Method Not Allowed", "unexpected response http reason");
    expect(apiResponse.headers.Allow).equal("POST", "unexpected Allow header");
  });

  it("check /api/startSession (invalid input data)", async () => {
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      method: "POST",
      url: "/api/startSession",
      remoteAddr: "8.8.8.8"
    }), Buffer.from(JSON.stringify({
    })));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.failedCode).equal("INVALID_ADDR", "unexpected api error code");
  });

  it("check /api/startSession (unexpected error)", async () => {
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      throw "unexpected test error";
    });
    const logSpy = sinon.spy(ServiceManager.GetService(FaucetProcess), "emitLog");
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      method: "POST",
      url: "/api/startSession",
      remoteAddr: "8.8.8.8"
    }), Buffer.from(JSON.stringify({
      addr: "0x0000000000000000000000000000000000001337"
    })));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.failedCode).equal("INTERNAL_ERROR", "unexpected api error code");
    expect(apiResponse.failedReason).equal(PUBLIC_INTERNAL_ERROR_MESSAGE, "unexpected public error message");
    const unexpectedErrorLog = logSpy.getCalls().find((call) => call.args[1]?.includes("Unexpected error while starting a faucet session"));
    expect(unexpectedErrorLog).not.to.equal(undefined, "unexpected error was not logged");
    expect(unexpectedErrorLog.args[1]).to.contain("unexpected test error", "logged error lacks diagnostic detail");
    logSpy.restore();
  });

  it("redacts ordinary faucet error text and arbitrary data", async () => {
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      let error = new FaucetError("BALANCE_ERROR", "private RPC marker");
      error.data = { secret: "private arbitrary data" };
      throw error;
    });
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      method: "POST",
      url: "/api/startSession",
      remoteAddr: "8.8.8.8"
    }), Buffer.from(JSON.stringify({
      addr: "0x0000000000000000000000000000000000001337"
    })));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.failedCode).equal("BALANCE_ERROR", "unexpected api error code");
    expect(apiResponse.failedReason).equal("Could not get wallet balance.", "raw faucet error text reached the client");
    expect(apiResponse).not.to.have.property("failedData", "ordinary faucet error data reached the client");
    expect(JSON.stringify(apiResponse)).not.to.contain("private", "private faucet error detail reached the client");
  });

  it("projects approved public faucet error data field by field", async () => {
    const address = "0x0000000000000000000000000000000000001337";
    const data = { address, secret: "private marker" };
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", () => {
      throw new PublicFaucetError({
        code: "STAKE_REQUIRED",
        message: "You need at least $10 of staked HYPE to use this faucet.",
        data,
      });
    });
    const webApi = new FaucetWebApi();
    const apiResponse = await webApi.onApiRequest(encodeApiRequest({
      method: "POST",
      url: "/api/startSession",
      remoteAddr: "8.8.8.8",
    }), Buffer.from(JSON.stringify({ addr: address })));

    expect(apiResponse).deep.include({
      status: FaucetSessionStatus.FAILED,
      failedCode: "STAKE_REQUIRED",
      failedReason: "You need at least $10 of staked HYPE to use this faucet.",
    });
    expect(apiResponse.failedData).deep.equal({ address });
    expect(JSON.stringify(apiResponse)).not.to.contain("private marker");
  });

  it("rewrites an unknown stored start failure", async () => {
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.setSessionFailed("TEST_ERROR", "test failure");
    });
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      method: "POST",
      url: "/api/startSession",
      remoteAddr: "8.8.8.8"
    }), Buffer.from(JSON.stringify({
      addr: "0x0000000000000000000000000000000000001337"
    })));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.failedCode).equal("INTERNAL_ERROR", "unexpected api error code");
    expect(apiResponse.failedReason).equal(PUBLIC_INTERNAL_ERROR_MESSAGE, "unknown stored failure reason reached the client");
    expect(JSON.stringify(apiResponse)).not.to.contain("test failure");
  });

  it("check /api/getSession", async () => {
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test1", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getSession?session=" + testSession.getSessionId(),
      remoteAddr: "8.8.8.8"
    }));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.status).equal("running", "invalid response: unexpected session status");
    expect(apiResponse.session).equal(testSession.getSessionId(), "invalid response: unexpected session id");
    expect(apiResponse.target).equal("0x0000000000000000000000000000000000001337", "invalid response: unexpected target addr");
  });

  it("check /api/getSession (unknown session)", async () => {
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getSession?session=69c21b43-7c5c-4ced-ac12-2ee12facaf17",
      remoteAddr: "8.8.8.8"
    }));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.error).equal("Session not found", "invalid error response");
  });

  it("uses a fixed fallback for a known getSession faucet error", async () => {
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test1", 1);
    });
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionInfo, 100, "test-task", (session: FaucetSession) => {
      throw new FaucetError("BALANCE_ERROR", "private RPC marker");
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getSession?session=" + testSession.getSessionId(),
      remoteAddr: "8.8.8.8"
    }));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.status).equal("failed", "invalid response status");
    expect(apiResponse.failedCode).equal("BALANCE_ERROR", "invalid error code");
    expect(apiResponse.failedReason).equal("Could not get wallet balance.", "raw faucet error text reached the client");
  });

  it("check /api/getSession (unexpected error)", async () => {
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test1", 1);
    });
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionInfo, 100, "test-task", (session: FaucetSession) => {
      throw "test error";
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getSession?session=" + testSession.getSessionId(),
      remoteAddr: "8.8.8.8"
    }));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.status).equal("failed", "invalid response status");
    expect(apiResponse.failedCode).equal("INTERNAL_ERROR", "invalid error code");
    expect(apiResponse.failedReason).equal(PUBLIC_INTERNAL_ERROR_MESSAGE, "unexpected public error message");
  });

  it("check /api/claimReward", async () => {
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      method: "POST",
      url: "/api/claimReward",
      remoteAddr: "8.8.8.8"
    }), Buffer.from(JSON.stringify({
      session: testSession.getSessionId(),
    })));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.status).equal("claiming", "invalid session status");
    expect(apiResponse.claimStatus).equal("queue", "invalid queue status");
  });

  it("check /api/claimReward (invalid method)", async () => {
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      method: "GET",
      url: "/api/claimReward",
      remoteAddr: "8.8.8.8"
    }));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse instanceof FaucetHttpResponse).equal(true, "unexpected api response type");
    expect(apiResponse.code).equal(405, "unexpected response http code");
    expect(apiResponse.reason).equal("Method Not Allowed", "unexpected response http reason");
    expect(apiResponse.headers.Allow).equal("POST", "unexpected Allow header");
  });

  it("check /api/claimReward (invalid input data)", async () => {
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      method: "POST",
      url: "/api/claimReward",
      remoteAddr: "8.8.8.8"
    }), Buffer.from(JSON.stringify({
      session: "94c63444-9bc1-45b3-a63c-35366de6814a"
    })));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.failedCode).equal("INVALID_SESSION", "unexpected api error code");
  });

  it("uses a fixed fallback for a known claimReward faucet error", async () => {
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionClaim, 100, "test-task", (session: FaucetSession) => {
      throw new FaucetError("BALANCE_ERROR", "private RPC marker");
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      method: "POST",
      url: "/api/claimReward",
      remoteAddr: "8.8.8.8"
    }), Buffer.from(JSON.stringify({
      session: testSession.getSessionId(),
    })));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.status).equal("failed", "invalid session status");
    expect(apiResponse.failedCode).equal("BALANCE_ERROR", "invalid error code");
    expect(apiResponse.failedReason).equal("Could not get wallet balance.", "raw faucet error text reached the client");
  });

  it("check /api/claimReward (unexpected error)", async () => {
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionClaim, 100, "test-task", (session: FaucetSession) => {
      throw "test error";
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      method: "POST",
      url: "/api/claimReward",
      remoteAddr: "8.8.8.8"
    }), Buffer.from(JSON.stringify({
      session: testSession.getSessionId(),
    })));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.status).equal("failed", "invalid session status");
    expect(apiResponse.failedCode).equal("INTERNAL_ERROR", "invalid error code");
    expect(apiResponse.failedReason).equal(PUBLIC_INTERNAL_ERROR_MESSAGE, "unexpected public error message");
  });

  it("check /api/getSessionStatus (running session)", async () => {
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test1", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    testSession.setSessionData("cliver", "2.5.1");
    testSession.setSessionData("pow.lastNonce", 42);
    testSession.setSessionData("pow.hashrate", 1337);
    testSession.setSessionData("reward.factors", [{ factor: 1.5, module: "test", name: "Test boost" }]);
    testSession.setSessionData("passport.score", { nonce: 7, score: 20, factor: 1.25 });
    testSession.setSessionData("voucherCode", "do-not-return-this-voucher");
    testSession.setSessionData("failed.stack", "do-not-return-this-stack");
    testSession.setSessionData("authenticatoor.data", { token: "do-not-return-this-token" });
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getSessionStatus?session=" + testSession.getSessionId() + "&details=true",
      remoteAddr: "8.8.8.8"
    }));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.status).equal("running", "invalid response: unexpected session status");
    expect(apiResponse.session).equal(testSession.getSessionId(), "invalid response: unexpected session id");
    expect(apiResponse.target).equal("0x0000000000000000000000000000000000001337", "invalid response: unexpected target addr");
    expect(!!apiResponse.details).equal(true, "invalid response: missing details");
    expect(apiResponse.details).deep.equal({
      clientVersion: "2.5.1",
      closeTime: undefined,
      proofOfWork: {
        lastNonce: 42,
        hashrate: 1337,
        idleTime: undefined,
      },
      rewardFactors: [{ factor: 1.5, module: "test", name: "Test boost" }],
      passportScore: 20,
      claim: undefined,
    }, "unexpected public details DTO");
    const serializedDetails = JSON.stringify(apiResponse.details);
    expect(serializedDetails).not.to.contain("do-not-return-this-voucher", "voucher credential leaked");
    expect(serializedDetails).not.to.contain("do-not-return-this-stack", "stack trace leaked");
    expect(serializedDetails).not.to.contain("do-not-return-this-token", "authentication data leaked");
  });

  it("supports legacy numeric passport scores in public session details", async () => {
    const sessionData = await addTestSession({
      data: {
        "passport.score": 15,
      },
    });
    const webApi = new FaucetWebApi();
    const response = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getSessionStatus?session=" + sessionData.sessionId + "&details=true",
      remoteAddr: "8.8.8.8",
    }));

    expect(response.details.passportScore).to.equal(15);
  });

  it("requires details=true exactly and redacts raw claim data", async () => {
    const sessionData = await addTestSession({
      status: FaucetSessionStatus.CLAIMING,
      data: {
        "cliver": "2.5.1",
        "github.uid": 1234,
        "zupass.data": { token: "private-zupass-token" },
      },
      claim: {
        claimIdx: 7,
        claimStatus: "failed",
        claimTime: 123456,
        txHash: "0xhash",
        txHex: "private-signed-transaction",
        txNonce: 9,
        txBlock: 10,
        txFee: "11",
        txError: "private RPC claim error",
      } as any,
    });
    const webApi = new FaucetWebApi();

    for(const queryValue of ["1", "false", "TRUE"]) {
      const response = await webApi.onApiRequest(encodeApiRequest({
        url: "/api/getSessionStatus?session=" + sessionData.sessionId + "&details=" + queryValue,
        remoteAddr: "8.8.8.8",
      }));
      expect(response).not.to.have.property("details", `details=${queryValue} unexpectedly enabled details`);
    }

    const response = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getSessionStatus?session=" + sessionData.sessionId + "&details=true",
      remoteAddr: "8.8.8.8",
    }));
    expect(response.details.claim).deep.equal({
      index: 7,
      status: "failed",
      time: 123456,
      hash: "0xhash",
      nonce: 9,
      block: 10,
      fee: "11",
      error: PUBLIC_CLAIM_FAILED_MESSAGE,
    }, "unexpected public claim DTO");
    expect(response.claimMessage).to.equal(PUBLIC_CLAIM_FAILED_MESSAGE, "raw claim error reached the public session status");
    expect(response.details).not.to.have.property("data", "raw session data was returned");
    expect(JSON.stringify(response.details)).not.to.contain("private-signed-transaction", "signed transaction leaked");
    expect(JSON.stringify(response.details)).not.to.contain("private-zupass-token", "authentication data leaked");
    expect(JSON.stringify(response)).not.to.contain("private RPC claim error", "raw claim error leaked to the client");
  });

  it("check /api/getSessionStatus (claiming session)", async () => {
    faucetConfig.minDropAmount = 10;
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    await ServiceManager.GetService(EthClaimManager).createSessionClaim(testSession.getStoreData(), {});
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getSessionStatus?session=" + testSession.getSessionId(),
      remoteAddr: "8.8.8.8"
    }));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.status).equal("claiming", "invalid response: unexpected session status");
    expect(apiResponse.session).equal(testSession.getSessionId(), "invalid response: unexpected session id");
    expect(apiResponse.target).equal("0x0000000000000000000000000000000000001337", "invalid response: unexpected target addr");
    expect(apiResponse.claimStatus).equal("queue", "invalid response: unexpected claim status");
  });

  it("rewrites an unknown stored session-status failure", async () => {
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test1", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    await testSession.setSessionFailed("TEST_ERROR", "test error");
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getSessionStatus?session=" + testSession.getSessionId(),
      remoteAddr: "8.8.8.8"
    }));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.status).equal("failed", "invalid response: unexpected session status");
    expect(apiResponse.session).equal(testSession.getSessionId(), "invalid response: unexpected session id");
    expect(apiResponse.failedCode).equal("INTERNAL_ERROR", "invalid response: unexpected failedCode");
    expect(apiResponse.failedReason).equal(PUBLIC_INTERNAL_ERROR_MESSAGE, "unknown stored failure reason reached the client");
    expect(JSON.stringify(apiResponse)).not.to.contain("test error");
  });

  it("redacts persisted internal failure details", async () => {
    const sessionData = await addTestSession({
      status: FaucetSessionStatus.FAILED,
      data: {
        "failed.code": "INTERNAL_ERROR",
        "failed.reason": "private database connection error",
        "failed.stack": "private stack trace",
      },
    });
    const webApi = new FaucetWebApi();
    const apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getSessionStatus?session=" + sessionData.sessionId + "&details=true",
      remoteAddr: "8.8.8.8",
    }));

    expect(apiResponse.failedCode).equal("INTERNAL_ERROR", "invalid response: unexpected failedCode");
    expect(apiResponse.failedReason).equal(PUBLIC_INTERNAL_ERROR_MESSAGE, "internal failure reason leaked");
    expect(JSON.stringify(apiResponse)).not.to.contain("private stack trace", "internal stack leaked");
  });

  it("uses a fixed fallback for a known stored failure", async () => {
    const sessionData = await addTestSession({
      status: FaucetSessionStatus.FAILED,
      data: {
        "failed.code": "BALANCE_ERROR",
        "failed.reason": "private upstream RPC marker",
        "failed.data": { secret: "private arbitrary data" },
      },
    });
    const webApi = new FaucetWebApi();
    const apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getSessionStatus?session=" + sessionData.sessionId,
      remoteAddr: "8.8.8.8",
    }));

    expect(apiResponse.failedCode).equal("BALANCE_ERROR");
    expect(apiResponse.failedReason).equal("Could not get wallet balance.");
    expect(apiResponse).not.to.have.property("failedData");
    expect(JSON.stringify(apiResponse)).not.to.contain("private");
  });

  it("check /api/getSessionStatus (unknown session)", async () => {
    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getSessionStatus?session=69c21b43-7c5c-4ced-ac12-2ee12facaf17",
      remoteAddr: "8.8.8.8"
    }));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse instanceof FaucetHttpResponse).equal(true, "unexpected api response type");
    expect(apiResponse.code).equal(404, "unexpected response http code");
    expect(apiResponse.reason).equal("Session not found", "unexpected response http reason");
  });

  it("check /api/getFaucetStatus", async () => {
    let sessionTime = Math.floor(new Date().getTime() / 1000) - 42;
    await addTestSession({
      sessionId: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
      startTime: sessionTime,
      status: FaucetSessionStatus.RUNNING,
      tasks: [ {"module":"pow","name":"mining","timeout":sessionTime + 3600} ],
      data: {
        "pow.hashrate": 20,
        "pow.lastNonce": 42,
        "ipinfo.data": {
          status: "success", country: "United States", countryCode: "US",
          region: "Virginia", regionCode: "VA", city: "Ashburn", cityCode: "Ashburn",
          locLat: 39.03, locLon: -77.5, zone: "America/New_York",
          isp: "Google LLC", org: "Google Public DNS", as: "AS15169 Google LLC",
          proxy: false, hosting: true,
        },
      }
    });
    await ServiceManager.GetService(SessionManager).initialize();

    let webApi = new FaucetWebApi();
    let httpResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getFaucetStatus",
      remoteAddr: "8.8.8.8"
    })) as FaucetHttpResponse;
    let apiResponse = decodeJsonHttpResponse(httpResponse);
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.status.unclaimedBalance).equal("100", "value mismatch: unclaimedBalance");
    expect(apiResponse.status.queuedBalance).equal("0", "value mismatch: queuedBalance");
    expect(apiResponse.sessions.length).equal(1, "value mismatch: sessions.length");
    expect(apiResponse.sessions[0].id).equal("a1b2957df7d645efef5f", "value mismatch: session.id");
    expect(apiResponse.sessions[0].start).equal(sessionTime, "value mismatch: session.start");
    expect(apiResponse.sessions[0].target).equal("0x0000000000000000000000000000000000001337", "value mismatch: session.target");
    expect(apiResponse.sessions[0].ip).equal("68d.863.f36.ef1", "value mismatch: session.ip");
    expect(apiResponse.sessions[0].balance).equal("100", "value mismatch: session.balance");
    expect(apiResponse.sessions[0].nonce).equal(42, "value mismatch: session.nonce");
    expect(apiResponse.sessions[0].status).equal("running", "value mismatch: session.status");
    expect(apiResponse.sessions[0]).not.to.have.property("ipInfo", "masked status leaked IP intelligence");

    faucetConfig.faucetSecret = "rotated-session-signing-secret";
    delete (webApi as any).cachedStatusData["faucet"];
    httpResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getFaucetStatus",
      remoteAddr: "8.8.8.8"
    })) as FaucetHttpResponse;
    apiResponse = decodeJsonHttpResponse(httpResponse);
    expect(apiResponse.sessions[0].id).equal("a1b2957df7d645efef5f", "public ID depends on the session-signing secret");
    expect(apiResponse.sessions[0].ip).equal("68d.863.f36.ef1", "public IP alias depends on the session-signing secret");
  });

  it("check /api/getFaucetStatus (caching)", async () => {
    let sessionTime = Math.floor(new Date().getTime() / 1000) - 42;
    await addTestSession({
      sessionId: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
      startTime: sessionTime,
      status: FaucetSessionStatus.RUNNING,
      tasks: [ {"module":"pow","name":"mining","timeout":sessionTime + 3600} ],
      data: {
        "pow.hashrate": 20,
        "pow.lastNonce": 42,
        "ipinfo.data": {
          status: "success", country: "United States", countryCode: "US",
          region: "Virginia", regionCode: "VA", city: "Ashburn", cityCode: "Ashburn",
          locLat: 39.03, locLon: -77.5, zone: "America/New_York",
          isp: "Google LLC", org: "Google Public DNS", as: "AS15169 Google LLC",
          proxy: false, hosting: true,
        },
      }
    });
    await ServiceManager.GetService(SessionManager).initialize();

    let webApi = new FaucetWebApi();
    let httpResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getFaucetStatus",
      remoteAddr: "8.8.8.8"
    })) as FaucetHttpResponse;
    let apiResponse = decodeJsonHttpResponse(httpResponse);
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.status.unclaimedBalance).equal("100", "value mismatch for 1st call");
    
    (webApi as any).cachedStatusData["faucet"].data.status.unclaimedBalance = "1337";

    httpResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getFaucetStatus",
      remoteAddr: "8.8.8.8"
    })) as FaucetHttpResponse;
    apiResponse = decodeJsonHttpResponse(httpResponse);
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.status.unclaimedBalance).equal("1337", "value mismatch for 2nd call");

    (webApi as any).cachedStatusData["faucet"].time = Math.floor(new Date().getTime() / 1000) - (FAUCETSTATUS_CACHE_TIME + 1);

    httpResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getFaucetStatus",
      remoteAddr: "8.8.8.8"
    })) as FaucetHttpResponse;
    apiResponse = decodeJsonHttpResponse(httpResponse);
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.status.unclaimedBalance).equal("100", "value mismatch for 3rd call");
  });

  it("check /api/getFaucetStatus (valid admin token)", async () => {
    let sessionTime = Math.floor(new Date().getTime() / 1000) - 42;
    await addTestSession({
      sessionId: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
      startTime: sessionTime,
      status: FaucetSessionStatus.RUNNING,
      tasks: [ {"module":"pow","name":"mining","timeout":sessionTime + 3600} ],
      data: {
        "pow.hashrate": 20,
        "pow.lastNonce": 42,
        "ipinfo.data": {
          status: "success", country: "United States", countryCode: "US",
          region: "Virginia", regionCode: "VA", city: "Ashburn", cityCode: "Ashburn",
          locLat: 39.03, locLon: -77.5, zone: "America/New_York",
          isp: "Google LLC", org: "Google Public DNS", as: "AS15169 Google LLC",
          proxy: false, hosting: true,
        },
      }
    });
    await ServiceManager.GetService(SessionManager).initialize();
    faucetConfig.statusAdminToken = "test-status-admin-token";

    let webApi = new FaucetWebApi();
    let httpResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getFaucetStatus",
      remoteAddr: "8.8.8.8",
      headers: { authorization: "Bearer test-status-admin-token" },
    })) as FaucetHttpResponse;
    let apiResponse = decodeJsonHttpResponse(httpResponse);
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.status.unclaimedBalance).equal("100", "value mismatch: unclaimedBalance");
    expect(apiResponse.status.queuedBalance).equal("0", "value mismatch: queuedBalance");
    expect(apiResponse.sessions.length).equal(1, "value mismatch: sessions.length");
    expect(apiResponse.sessions[0].id).equal("f081154a-3b93-4972-9ae7-b83f3307bb0f", "value mismatch: session.id");
    expect(apiResponse.sessions[0].start).equal(sessionTime, "value mismatch: session.start");
    expect(apiResponse.sessions[0].target).equal("0x0000000000000000000000000000000000001337", "value mismatch: session.target");
    expect(apiResponse.sessions[0].ip).equal("8.8.8.8", "value mismatch: session.ip");
    expect(apiResponse.sessions[0].balance).equal("100", "value mismatch: session.balance");
    expect(apiResponse.sessions[0].nonce).equal(42, "value mismatch: session.nonce");
    expect(apiResponse.sessions[0].status).equal("running", "value mismatch: session.status");
    expect(apiResponse.sessions[0].ipInfo.city).equal("Ashburn", "unmasked status lost operator IP intelligence");

    (ServiceManager.GetService(EthClaimManager) as any).claimTxQueue.push({
      session: "claim-session",
      target: "0x0000000000000000000000000000000000001337",
      amount: "1",
      claim: {
        claimIdx: 1,
        claimStatus: "pending",
        claimTime: sessionTime,
        txHex: "signed-transaction-for-operator",
      },
    });
    httpResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getFaucetStatus",
      remoteAddr: "8.8.8.8",
      headers: { authorization: "Bearer test-status-admin-token" },
    })) as FaucetHttpResponse;
    apiResponse = decodeJsonHttpResponse(httpResponse);
    expect(apiResponse.claims[0].txhex).equal("signed-transaction-for-operator", "admin status lost signed transaction diagnostics");
  });

  it("check /api/getFaucetStatus (invalid admin token)", async () => {
    await ServiceManager.GetService(SessionManager).initialize();
    faucetConfig.statusAdminToken = "test-status-admin-token";

    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getFaucetStatus",
      remoteAddr: "8.8.8.8",
      headers: { authorization: "Bearer invalid" },
    }));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.code).equal(403, "invalid response code");
    expect(apiResponse.reason).equal("Access denied", "invalid response reason");
    expect(apiResponse.headers["Cache-Control"]).equal("no-store", "denied status response may be cached");
  });

  it("disables admin status when no token is configured and ignores legacy query keys", async () => {
    const sessionData = await addTestSession({
      sessionId: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
      remoteIP: "8.8.8.8",
    });
    faucetConfig.statusAdminToken = null;
    let webApi = new FaucetWebApi();

    const deniedResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getFaucetStatus",
      remoteAddr: "8.8.8.8",
      headers: { authorization: "Bearer any-token" },
    }));
    expect(deniedResponse.code).equal(403, "admin status was not disabled");

    const publicResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getFaucetStatus?key=legacy-query-capability",
      remoteAddr: "8.8.8.8",
    })) as FaucetHttpResponse;
    const publicData = decodeJsonHttpResponse(publicResponse);
    expect(publicData.sessions[0].id).not.to.equal(sessionData.sessionId, "legacy query key enabled unmasked status");
    expect(publicData.sessions[0].ip).not.to.equal(sessionData.remoteIP, "legacy query key exposed a raw IP");
  });

  it("check /api/getQueueStatus", async () => {
    faucetConfig.minDropAmount = 100;
    let claimTime = Math.floor(new Date().getTime() / 1000);
    let testSession = await addTestSession({
      sessionId: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
      startTime: claimTime - 42,
      status: FaucetSessionStatus.CLAIMABLE,
    });
    await ServiceManager.GetService(EthClaimManager).createSessionClaim(testSession, {});

    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getQueueStatus",
      remoteAddr: "8.8.8.8"
    }));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.claims.length).equal(1, "unexpected response value");
    expect(apiResponse.claims[0].status).equal("queue", "unexpected claim status");
    expect(apiResponse.claims[0].session).equal("a1b2957df7d645efef5f", "value mismatch: claim.session");
    expect(apiResponse.claims[0].time).equal(claimTime, "value mismatch: claim.time");
    expect(apiResponse.claims[0].target).equal("0x0000000000000000000000000000000000001337", "value mismatch: claim.target");
    expect(apiResponse.claims[0]).not.to.have.property("txhex", "public queue leaked signed transaction bytes");
  });

  it("check /api/getQueueStatus (caching)", async () => {
    faucetConfig.minDropAmount = 100;
    let claimTime = Math.floor(new Date().getTime() / 1000);
    let testSession = await addTestSession({
      sessionId: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
      startTime: claimTime - 42,
      status: FaucetSessionStatus.CLAIMABLE,
    });
    await ServiceManager.GetService(EthClaimManager).createSessionClaim(testSession, {});

    let webApi = new FaucetWebApi();
    let apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getQueueStatus",
      remoteAddr: "8.8.8.8"
    }));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.claims.length).equal(1, "value mismatch for 1st call");
    
    (webApi as any).cachedStatusData["queue"].data.claims = [];

    apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getQueueStatus",
      remoteAddr: "8.8.8.8"
    }));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.claims.length).equal(0, "value mismatch for 2nd call");

    (webApi as any).cachedStatusData["queue"].time = Math.floor(new Date().getTime() / 1000) - (FAUCETSTATUS_CACHE_TIME + 1);

    apiResponse = await webApi.onApiRequest(encodeApiRequest({
      url: "/api/getQueueStatus",
      remoteAddr: "8.8.8.8"
    }));
    expect(!!apiResponse).equal(true, "no api response");
    expect(apiResponse.claims.length).equal(1, "value mismatch for 3rd call");
  });

});
