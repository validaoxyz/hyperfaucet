import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { bindTestStubs, unbindTestStubs, loadDefaultTestConfig, awaitSleepPromise } from '../common.js';
import { ServiceManager } from '../../src/common/ServiceManager.js';
import { FaucetDatabase } from '../../src/db/FaucetDatabase.js';
import { ModuleHookAction, ModuleManager } from '../../src/modules/ModuleManager.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { faucetConfig } from '../../src/config/FaucetConfig.js';
import {
  applyPoWPercentage,
  defaultConfig as defaultPoWConfig,
  IPoWConfig,
  percentageToBasisPoints,
  PoWHashAlgo,
  validatePoWConfig,
} from '../../src/modules/pow/PoWConfig.js';
import { FaucetWebApi } from '../../src/webserv/FaucetWebApi.js';
import { disposeFakeWebSockets, FakeWebSocket, injectFakeWebSocket } from '../stubs/FakeWebSocket.js';
import { PoWModule } from '../../src/modules/pow/PoWModule.js';
import { PoWServer } from '../../src/modules/pow/PoWServer.js';
import { PoWServerWorker } from '../../src/modules/pow/PoWServerWorker.js';
import { PoWValidator } from '../../src/modules/pow/validator/PoWValidator.js';
import { PoWShareVerification } from '../../src/modules/pow/PoWShareVerification.js';
import { PoWSession } from '../../src/modules/pow/PoWSession.js';
import { PromiseDfd } from '../../src/utils/PromiseDfd.js';
import { EventEmitter } from 'node:events';
import { MessageChannel, MessagePort } from 'node:worker_threads';
import { IPoWValidatorValidateRequest, IPoWValidatorLimits } from '../../src/modules/pow/validator/IPoWValidator.js';
import { PoWValidatorWorker } from '../../src/modules/pow/validator/PoWValidatorWorker.js';
import { FaucetError } from '../../src/common/FaucetError.js';
import { PUBLIC_INTERNAL_ERROR_MESSAGE } from '../../src/webserv/PublicErrors.js';
import { FaucetLogLevel, FaucetProcess } from '../../src/common/FaucetProcess.js';

function createTestPoWConfig(overrides: Partial<IPoWConfig> = {}): IPoWConfig {
  return {
    ...defaultPoWConfig,
    enabled: true,
    powShareReward: 10,
    powHashAlgo: PoWHashAlgo.SCRYPT,
    powScryptParams: {
      cpuAndMemory: 4096,
      blockSize: 8,
      parallelization: 1,
      keyLength: 16,
    },
    powDifficulty: 11,
    ...overrides,
  };
}

function createValidationRequest(shareId: string, nonce: number, config: IPoWConfig): IPoWValidatorValidateRequest {
  return {
    shareId,
    nonce,
    data: "",
    preimage: "preimage",
    algo: config.powHashAlgo,
    params: {...config.powScryptParams},
    difficulty: config.powDifficulty,
  };
}

function createValidationLimits(config: IPoWConfig): IPoWValidatorLimits {
  return {
    maxGlobalPending: config.verifyLocalMaxQueue,
    maxSessionPending: config.verifyLocalMaxPendingPerSession,
    maxSessionDutyCyclePercent: config.verifyLocalMaxSessionDutyCyclePercent,
    timeoutMs: config.verifyLocalTimeout * 1000,
  };
}

function createFakeValidatorWorker() {
  let worker = new EventEmitter() as EventEmitter & {
    postMessage: sinon.SinonSpy;
    terminate: sinon.SinonStub;
  };
  worker.postMessage = sinon.spy();
  worker.terminate = sinon.stub().resolves(0);
  return worker;
}

function createStoppingPoWModule(overrides: Record<string, unknown> = {}) {
  return {
    ...overrides,
    stopServer: sinon.spy((server: PoWServer) => {
      void server.shutdown().catch(() => undefined);
    }),
  } as any;
}

function createPeerGuardScenario(
  overrides: Partial<IPoWConfig> = {},
  sendVerifyMessage: sinon.SinonSpy = sinon.spy(),
) {
  let localValidation = new PromiseDfd<boolean>();
  let releaseVerifierGuard = sinon.spy();
  let verifier = {
    pendingVerifications: 0,
    missedVerifications: 0,
    activeClient: {sendMessage: sendVerifyMessage},
    getSessionId: () => "verifier",
    getDropAmount: () => 10n,
    addReward: sinon.stub().callsFake(async (amount: bigint) => amount),
    subPenalty: sinon.stub().resolves(0n),
    slashSession: sinon.stub().resolves(),
    holdBenignCloseForSecurityDecision: sinon.stub().returns(releaseVerifierGuard),
  } as any;
  let submitter = {
    preImage: "preimage",
    activeClient: {sendMessage: sinon.spy()},
    getSessionId: () => "submitter",
    getDropAmount: () => 0n,
    addReward: sinon.stub().callsFake(async (amount: bigint) => amount),
    slashSession: sinon.stub().resolves(),
  } as any;
  let cancelValidation = sinon.spy();
  let config = createTestPoWConfig({
    verifyMinerPercent: 100,
    verifyMinerPeerCount: 1,
    verifyMinerIndividuals: 1,
    verifyMinerMissPenaltyPerc: 0,
    ...overrides,
  });
  let server = {
    getModuleConfig: () => config,
    getValidator: () => ({
      tryValidateShare: () => ({kind: "accepted", promise: localValidation.promise}),
      cancelValidation,
    }),
    getActiveClients: () => [{getPoWSession: () => verifier}],
    getPoWSession: (sessionId: string) => sessionId === "verifier" ? verifier : null,
    getClientPoWParams: () => ({a: PoWHashAlgo.SCRYPT, n: 4096, r: 8, p: 1, l: 16}),
  } as any;
  let verification = new PoWShareVerification(server, submitter, 1, "");
  let result = verification.startVerification().then(
    (value) => value,
    (error) => error,
  );
  let verifyRequest = sendVerifyMessage.firstCall?.args[1];
  return {
    cancelValidation,
    localValidation,
    releaseVerifierGuard,
    result,
    server,
    verifier,
    verifyRequest,
  };
}

function waitForWorkerValidation(port: MessagePort, shareId: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let onMessage = (message: any) => {
      if(message?.data?.shareId !== shareId)
        return;

      port.off("message", onMessage);
      if(message.action === "validated")
        resolve(message.data.isValid);
      else
        reject(new Error("PoW worker validation failed"));
    };
    port.on("message", onMessage);
  });
}


describe("Faucet module: pow", () => {
  let globalStubs;

  beforeEach(async () => {
    globalStubs = bindTestStubs();
    loadDefaultTestConfig();
    await ServiceManager.GetService(FaucetDatabase).initialize();
  });
  afterEach(async () => {
    let dbService = ServiceManager.GetService(FaucetDatabase);
    await ServiceManager.DisposeAllServices();
    await dbService.closeDatabase();
    await unbindTestStubs(globalStubs);
    disposeFakeWebSockets();
  });

  it("Check client config exports (scrypt)", async () => {
    faucetConfig.modules["pow"] = {
      enabled: true,
      powShareReward: 10,
      powSessionTimeout: 60,
      powHashAlgo: PoWHashAlgo.SCRYPT,
      powScryptParams: {
        cpuAndMemory: 4096,
        blockSize: 8,
        parallelization: 1,
        keyLength: 16,
      },
      powDifficulty: 11,
      powHashrateSoftLimit: 1337,
    } as IPoWConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let clientConfig = await ServiceManager.GetService(FaucetWebApi).onGetFaucetConfig();
    expect(!!clientConfig.modules['pow']).to.equal(true, "no pow config exported");
    expect(clientConfig.modules['pow'].powTimeout).to.equal(60, "client config mismatch: powTimeout");
    expect(clientConfig.modules['pow'].powParams.a).to.equal(PoWHashAlgo.SCRYPT, "client config mismatch: powParams.a");
    expect(clientConfig.modules['pow'].powParams.n).to.equal(4096, "client config mismatch: powParams.n");
    expect(clientConfig.modules['pow'].powParams.r).to.equal(8, "client config mismatch: powParams.r");
    expect(clientConfig.modules['pow'].powParams.p).to.equal(1, "client config mismatch: powParams.p");
    expect(clientConfig.modules['pow'].powParams.l).to.equal(16, "client config mismatch: powParams.l");
    expect(clientConfig.modules['pow'].powDifficulty).to.equal(11, "client config mismatch: powDifficulty");
    expect(clientConfig.modules['pow'].powHashrateLimit).to.equal(1337, "client config mismatch: powHashrateLimit");
  });

  it("Check client config exports (cryptonight)", async () => {
    faucetConfig.modules["pow"] = {
      enabled: true,
      powShareReward: 10,
      powSessionTimeout: 60,
      powHashAlgo: PoWHashAlgo.CRYPTONIGHT,
      powCryptoNightParams: {
        algo: 0,
        variant: 1,
        height: 10,
      },
      powDifficulty: 11,
      powHashrateSoftLimit: 1337,
    } as IPoWConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let clientConfig = await ServiceManager.GetService(FaucetWebApi).onGetFaucetConfig();
    expect(!!clientConfig.modules['pow']).to.equal(true, "no pow config exported");
    expect(clientConfig.modules['pow'].powTimeout).to.equal(60, "client config mismatch: powTimeout");
    expect(clientConfig.modules['pow'].powParams.a).to.equal(PoWHashAlgo.CRYPTONIGHT, "client config mismatch: powParams.a");
    expect(clientConfig.modules['pow'].powParams.c).to.equal(0, "client config mismatch: powParams.c");
    expect(clientConfig.modules['pow'].powParams.v).to.equal(1, "client config mismatch: powParams.v");
    expect(clientConfig.modules['pow'].powParams.h).to.equal(10, "client config mismatch: powParams.h");
    expect(clientConfig.modules['pow'].powDifficulty).to.equal(11, "client config mismatch: powDifficulty");
    expect(clientConfig.modules['pow'].powHashrateLimit).to.equal(1337, "client config mismatch: powHashrateLimit");
  });

  it("Check client config exports (argon2)", async () => {
    faucetConfig.modules["pow"] = {
      enabled: true,
      powShareReward: 10,
      powSessionTimeout: 60,
      powHashAlgo: PoWHashAlgo.ARGON2,
      powArgon2Params: {
        type: 0,
        version: 13,
        timeCost: 4,
        memoryCost: 4096,
        parallelization: 1,
        keyLength: 16,
      },
      powDifficulty: 11,
      powHashrateSoftLimit: 1337,
    } as IPoWConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let clientConfig = await ServiceManager.GetService(FaucetWebApi).onGetFaucetConfig();
    expect(!!clientConfig.modules['pow']).to.equal(true, "no pow config exported");
    expect(clientConfig.modules['pow'].powTimeout).to.equal(60, "client config mismatch: powTimeout");
    expect(clientConfig.modules['pow'].powParams.a).to.equal(PoWHashAlgo.ARGON2, "client config mismatch: powParams.a");
    expect(clientConfig.modules['pow'].powParams.t).to.equal(0, "client config mismatch: powParams.t");
    expect(clientConfig.modules['pow'].powParams.v).to.equal(13, "client config mismatch: powParams.v");
    expect(clientConfig.modules['pow'].powParams.i).to.equal(4, "client config mismatch: powParams.i");
    expect(clientConfig.modules['pow'].powParams.m).to.equal(4096, "client config mismatch: powParams.m");
    expect(clientConfig.modules['pow'].powParams.p).to.equal(1, "client config mismatch: powParams.p");
    expect(clientConfig.modules['pow'].powParams.l).to.equal(16, "client config mismatch: powParams.l");
    expect(clientConfig.modules['pow'].powDifficulty).to.equal(11, "client config mismatch: powDifficulty");
    expect(clientConfig.modules['pow'].powHashrateLimit).to.equal(1337, "client config mismatch: powHashrateLimit");
  });

  it("Start mining session and check session params", async () => {
    faucetConfig.modules["pow"] = {
      enabled: true,
    } as IPoWConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
    let clientInfo = await testSession.getSessionInfo();
    expect(!!(clientInfo.modules as any)["pow"]).to.equal(true, "missing pow info in client session info");
    expect((clientInfo.modules as any)["pow"].lastNonce).to.equal(0, "invalid pow info in client session info: lastNonce");
    expect((clientInfo.modules as any)["pow"].preImage).to.equal(testSession.getSessionData("pow.preimage"), "invalid pow info in client session info: preImage");
    expect((clientInfo.modules as any)["pow"].shareCount).to.equal(0, "invalid pow info in client session info: shareCount");
  });

  it("Start mining session and connect mining client", async () => {
    faucetConfig.modules["pow"] = {
      enabled: true,
    } as IPoWConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
    let fakeWs = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");
    expect(fakeWs.isReady).to.equal(true, "websocket was closed");
    let errorMsg = fakeWs.getSentMessage("error");
    expect(errorMsg.length).to.equal(0, "a unexpected error message has been sent: " + (errorMsg.length ? errorMsg[0].data.code : ""));
  });

  it("Connect invalid mining client (missing session id)", async () => {
    faucetConfig.modules["pow"] = {
      enabled: true,
    } as IPoWConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let fakeWs = await injectFakeWebSocket("/ws/pow", "8.8.8.8");
    expect(fakeWs.isReady).to.equal(false, "websocket not closed");
    let errorMsg = fakeWs.getSentMessage("error");
    expect(errorMsg.length).to.equal(1, "no error message sent");
    expect(errorMsg[0].data.code).to.equal("INVALID_SESSION", "unexpected error code");
  });

  it("Connect invalid mining client (unknown session id)", async () => {
    faucetConfig.modules["pow"] = {
      enabled: true,
    } as IPoWConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let fakeWs = await injectFakeWebSocket("/ws/pow?session=e36ec5e6-12ee-4015-951f-b018b37de451", "8.8.8.8");
    expect(fakeWs.isReady).to.equal(false, "websocket not closed");
    let errorMsg = fakeWs.getSentMessage("error");
    expect(errorMsg.length).to.equal(1, "no error message sent");
    expect(errorMsg[0].data.code).to.equal("INVALID_SESSION", "unexpected error code");
  });

  it("projects remote-IP update failures before writing the websocket 403 response", async () => {
    faucetConfig.modules["pow"] = createTestPoWConfig();
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    let rawOrdinaryMarker = "RAW_ORDINARY_REMOTE_IP_MARKER";
    let rawUnexpectedMarker = "RAW_UNEXPECTED_REMOTE_IP_MARKER";
    sinon.stub(testSession, "updateRemoteIP")
      .onFirstCall().rejects(new FaucetError("INVALID_REMOTE_IP", rawOrdinaryMarker))
      .onSecondCall().rejects(new Error(rawUnexpectedMarker));
    let powModule = moduleManager.getModule<PoWModule>("pow");

    let requestFailure = async () => {
      let socket = {write: sinon.spy(), end: sinon.spy()} as any;
      await (powModule as any).processPoWClientWebSocket(
        {url: "/ws/pow?session=" + testSession.getSessionId()} as any,
        socket,
        Buffer.alloc(0),
        "8.8.4.4",
      );
      expect(socket.end.calledOnce).to.equal(true);
      let response = socket.write.firstCall.args[0] as string;
      return {response, body: JSON.parse(response.split("\r\n\r\n")[1])};
    };

    let ordinaryFailure = await requestFailure();
    expect(ordinaryFailure.body).to.deep.equal({
      action: "error",
      data: {code: "INVALID_REMOTE_IP", message: "Unable to determine a valid client IP address."},
    });
    expect(ordinaryFailure.response).not.to.contain(rawOrdinaryMarker);

    let unexpectedFailure = await requestFailure();
    expect(unexpectedFailure.body).to.deep.equal({
      action: "error",
      data: {code: "INTERNAL_ERROR", message: PUBLIC_INTERNAL_ERROR_MESSAGE},
    });
    expect(unexpectedFailure.response).not.to.contain(rawUnexpectedMarker);
  });

  it("Connect multiple mining clients for same session", async () => {
    faucetConfig.modules["pow"] = {
      enabled: true,
    } as IPoWConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
    let fakeWs = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");
    await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");
    expect(fakeWs.isReady).to.equal(false, "websocket not closed");
    let errorMsg = fakeWs.getSentMessage("error");
    expect(errorMsg.length).to.equal(1, "no error message sent");
    expect(errorMsg[0].data.code).to.equal("CLIENT_KILLED", "unexpected error code");
  });

  describe("Local validation ownership", () => {
    it("filters persisted hashrate outliers", () => {
      let session = new PoWSession("session", {} as any);
      session.loadSessionData({
        "pow.hashrates": [-1, 12, 1e300],
        "pow.hashrate": 1e300,
      });

      expect(session.reportedHashrate).to.deep.equal([12]);
      expect(session.getSessionProp("pow.hashrate")).to.equal(12);
      expect(session.getDirtyProps(false)["pow.hashrate"]).to.equal(12);
      session.reportedHashrate = [-1, 20, 1e300];
      expect(session.reportedHashrate).to.deep.equal([20]);
      expect(session.getSessionProp("pow.hashrate")).to.equal(20);
    });

    it("uses exact basis points for decimal verification percentages", () => {
      let config = createTestPoWConfig({
        powShareReward: 10_000,
        verifyMinerRewardPerc: 0.29,
        verifyMinerMissPenaltyPerc: 12.34,
      });

      expect(() => validatePoWConfig(config)).not.to.throw();
      expect(percentageToBasisPoints(0.29)).to.equal(29n);
      expect(applyPoWPercentage(10_000n, 0.29)).to.equal(29n);
      expect(() => validatePoWConfig({...config, verifyMinerRewardPerc: 0.291})).to.throw(/two decimal places/);
      expect(() => validatePoWConfig({...config, verifyMinerMissPenaltyPerc: 101})).to.throw(/between 0 and 100/);
    });

    it("validates queue, timeout, and difficulty policy before startup", async () => {
      let config = createTestPoWConfig();
      let invalidConfigs: Array<[string, IPoWConfig]> = [
        ["powSessionTimeout", {...config, powSessionTimeout: 0}],
        ["powIdleTimeout", {...config, powIdleTimeout: Number.POSITIVE_INFINITY}],
        ["powPingInterval", {...config, powPingInterval: 0}],
        ["powPingTimeout", {...config, powPingTimeout: -1}],
        ["powHashrateSoftLimit", {...config, powHashrateSoftLimit: Number.NaN}],
        ["powHashrateHardLimit", {...config, powHashrateHardLimit: -1}],
        ["powDifficulty", {...config, powDifficulty: 1.5}],
        ["powDifficulty", {...config, powDifficulty: 129}],
        ["powDifficulty", {...config, powHashAlgo: PoWHashAlgo.CRYPTONIGHT, powDifficulty: 257}],
        ["powDifficulty", {...config, powHashAlgo: PoWHashAlgo.ARGON2, powDifficulty: 129}],
        ["powDifficulty", {...config, powHashAlgo: PoWHashAlgo.NICKMINER, powDifficulty: 256}],
        ["powScryptParams.cpuAndMemory", {
          ...config,
          powScryptParams: {...config.powScryptParams, cpuAndMemory: 3},
        }],
        ["powScryptParams.blockSize", {
          ...config,
          powScryptParams: {...config.powScryptParams, blockSize: 0},
        }],
        ["powArgon2Params.timeCost", {
          ...config,
          powArgon2Params: {...config.powArgon2Params, timeCost: 0},
        }],
        ["powArgon2Params.memoryCost", {
          ...config,
          powArgon2Params: {...config.powArgon2Params, memoryCost: 0},
        }],
        ["powArgon2Params.parallelization", {
          ...config,
          powArgon2Params: {...config.powArgon2Params, parallelization: 0},
        }],
        ["powArgon2Params.keyLength", {
          ...config,
          powArgon2Params: {...config.powArgon2Params, keyLength: 0},
        }],
        ["powNickMinerParams.count", {
          ...config,
          powNickMinerParams: {...config.powNickMinerParams, count: 0},
        }],
        ["powNickMinerParams.relevantDifficulty", {
          ...config,
          powNickMinerParams: {...config.powNickMinerParams, relevantDifficulty: 256},
        }],
        ["verifyLocalMaxQueue", {...config, verifyLocalMaxQueue: 0}],
        ["verifyLocalMaxPendingPerSession", {...config, verifyLocalMaxPendingPerSession: 0}],
        ["verifyLocalMaxSessionDutyCyclePercent", {
          ...config,
          verifyLocalMaxSessionDutyCyclePercent: undefined,
        } as IPoWConfig],
        ["verifyLocalMaxSessionDutyCyclePercent", {...config, verifyLocalMaxSessionDutyCyclePercent: 0}],
        ["verifyLocalMaxSessionDutyCyclePercent", {...config, verifyLocalMaxSessionDutyCyclePercent: 51}],
        ["verifyLocalMaxPendingPerSession", {
          ...config,
          verifyLocalMaxQueue: 4,
          verifyLocalMaxPendingPerSession: 4,
        }],
        ["verifyLocalTimeout", {...config, verifyLocalTimeout: 0}],
        ["verifyMinerMaxPending", {...config, verifyMinerMaxPending: -1}],
        ["verifyMinerTimeout", {...config, verifyMinerTimeout: 0}],
      ];

      for(let [fieldName, invalidConfig] of invalidConfigs)
        expect(() => validatePoWConfig(invalidConfig)).to.throw(fieldName);

      expect(defaultPoWConfig.verifyLocalMaxSessionDutyCyclePercent).to.be.within(1, 50);
      expect(() => validatePoWConfig({...config, powDifficulty: 128})).not.to.throw();
      expect(() => validatePoWConfig({
        ...config,
        powHashAlgo: PoWHashAlgo.CRYPTONIGHT,
        powDifficulty: 256,
      })).not.to.throw();
      expect(() => validatePoWConfig({
        ...config,
        powHashAlgo: PoWHashAlgo.ARGON2,
        powDifficulty: 128,
      })).not.to.throw();
      expect(() => validatePoWConfig({
        ...config,
        powHashAlgo: PoWHashAlgo.NICKMINER,
        powDifficulty: 255,
        powNickMinerParams: {...config.powNickMinerParams, relevantDifficulty: 255},
      })).not.to.throw();

      faucetConfig.modules["pow"] = {...config, powDifficulty: Number.NaN} as IPoWConfig;
      let startupError: unknown;
      try {
        await ServiceManager.GetService(ModuleManager).initialize();
      }
      catch(error) {
        startupError = error;
      }
      expect(startupError).to.be.instanceOf(Error);
      expect((startupError as Error).message).to.contain("powDifficulty");
    });

    it("owns reward acknowledgements before dispatch and releases them on timeout or disposal", async () => {
      let immediateSession: PoWSession;
      let immediateWorker = {
        sendSessionReward: (_sessionId: string, reqId: number) => immediateSession.processReward(reqId, 3n, 7n),
      } as any;
      immediateSession = new PoWSession("immediate", immediateWorker, 20);
      expect(await immediateSession.addReward(3n, "share")).to.equal(3n);
      expect(immediateSession.getDropAmount()).to.equal(7n);

      let silentWorker = {sendSessionReward: sinon.spy()} as any;
      let timedSession = new PoWSession("timed", silentWorker, 5);
      let timedResult = timedSession.addReward(1n, "share").then(
        () => null,
        (error) => error,
      );
      expect(await timedResult).to.be.instanceOf(Error).with.property("message", "PoW reward acknowledgement timed out");

      let disposedSession = new PoWSession("disposed", silentWorker, 1_000);
      let disposedResult = disposedSession.addReward(1n, "share").then(
        () => null,
        (error) => error,
      );
      disposedSession.dispose("session destroyed");
      expect(await disposedResult).to.be.instanceOf(Error).with.property("message", "session destroyed");
    });

    it("gives a terminal slash precedence over a pending benign close", async () => {
      let worker = {sendSessionAbort: sinon.spy()} as any;
      let session = new PoWSession("session", worker);
      let releaseClose = session.holdBenignCloseForSecurityDecision();

      let benignClose = session.closeSession("closed");
      await Promise.resolve();
      expect(worker.sendSessionAbort.called).to.equal(false);

      let terminalClose = session.slashSession("invalid PoW result hash");
      expect(worker.sendSessionAbort.calledOnce).to.equal(true);
      expect(worker.sendSessionAbort.firstCall.args.slice(0, 3)).to.deep.equal([
        "session",
        "slashed",
        "invalid PoW result hash",
      ]);
      releaseClose();
      expect(worker.sendSessionAbort.calledOnce).to.equal(true);

      session.processSessionClose({status: "failed"});
      expect(await benignClose).to.deep.equal({status: "failed"});
      expect(await terminalClose).to.deep.equal({status: "failed"});
    });

    it("acknowledges main-process reward failures explicitly", async () => {
      let childProcess = new EventEmitter() as any;
      childProcess.send = sinon.spy();
      new PoWServer({} as any, "test-server", {childProcess} as any);

      childProcess.emit("message", {
        action: "pow-session-reward",
        sessionId: "missing-session",
        reqId: 17,
        amount: "1",
        type: "share",
        dirtyProps: {},
      });
      await Promise.resolve();

      expect(childProcess.send.calledOnce).to.equal(true);
      expect(childProcess.send.firstCall.args[0]).to.deep.equal({
        action: "pow-session-reward-error",
        sessionId: "missing-session",
        reqId: 17,
        message: "PoW reward session is no longer available",
      });
    });

    it("uses exact set membership for reported active PoW sessions", () => {
      let childProcess = new EventEmitter() as any;
      childProcess.send = sinon.spy();
      childProcess.kill = sinon.spy();
      let server = new PoWServer({} as any, "membership-server", {childProcess} as any);
      let activeSession = {setSessionModuleRef: sinon.spy()} as any;
      let inactiveSession = {setSessionModuleRef: sinon.spy()} as any;
      let numericTextSession = {setSessionModuleRef: sinon.spy()} as any;
      (server as any).sessions = {
        active: activeSession,
        inactive: inactiveSession,
        "1": numericTextSession,
      };
      let indexOfReads = 0;
      let reportedSessions = new Proxy(
        ["active", "active", "unknown", 1] as unknown as string[],
        {
          get(target, property, receiver) {
            if(property === "indexOf")
              indexOfReads++;
            return Reflect.get(target, property, receiver);
          },
        },
      );
      let emitLog = sinon.spy(ServiceManager.GetService(FaucetProcess), "emitLog");

      (server as any).onSysLoad(
        12.5,
        {heapUsed: 1024, heapTotal: 2048},
        1.25,
        reportedSessions,
      );

      expect(activeSession.setSessionModuleRef.calledOnceWithExactly("pow.clientActive", true)).to.equal(true);
      expect(inactiveSession.setSessionModuleRef.calledOnceWithExactly("pow.clientActive", false)).to.equal(true);
      expect(numericTextSession.setSessionModuleRef.calledOnceWithExactly("pow.clientActive", false)).to.equal(
        true,
        "numeric telemetry changed string session identity",
      );
      expect(indexOfReads).to.equal(0, "system-load membership performed an array scan per registered session");
      let loadMessage = emitLog.getCalls()
        .map((call) => String(call.args[1]))
        .find((message) => message.includes("PoW server [membership-server]"));
      expect(loadMessage).to.include("Sessions: 4/3");

      childProcess.emit("close");
    });

    it("reserves full-balance forfeiture before terminal failure accounting", async () => {
      let penalty = new PromiseDfd<bigint>();
      let failure = new PromiseDfd<void>();
      let childProcess = new EventEmitter() as any;
      childProcess.send = sinon.spy((message, callback) => {
        callback?.(null);
        if(message.action === "pow-session-close")
          setImmediate(() => childProcess.emit("message", {
            action: "pow-session-close-ack",
            sessionId: message.sessionId,
            closeId: message.closeId,
          }));
      });
      let module = createStoppingPoWModule({processPoWSessionClose: sinon.stub().resolves()});
      let server = new PoWServer(module, "test-server", {childProcess} as any);
      let session = {
        getSessionId: () => "session",
        getDropAmount: () => 0n,
        subPenalty: sinon.stub().returns(penalty.promise),
        setSessionFailed: sinon.stub().returns(failure.promise),
        getSessionInfo: sinon.stub().resolves({
          status: "failed",
          failedCode: "SLASHED",
          failedReason: "RAW_POW_CLOSE_MARKER",
        }),
      } as any;
      (server as any).sessions.session = session;

      childProcess.emit("message", {
        action: "pow-session-abort",
        sessionId: "session",
        type: "slashed",
        reason: "invalid PoW result hash",
        dirtyProps: {},
      });
      await Promise.resolve();

      expect(session.subPenalty.calledOnceWithExactly((1n << 256n) - 1n)).to.equal(true);
      expect(session.setSessionFailed.calledOnceWithExactly("SLASHED", "invalid PoW result hash")).to.equal(true);
      expect(module.processPoWSessionClose.called).to.equal(false);

      penalty.resolve(0n);
      failure.resolve();
      await awaitSleepPromise(100, () => childProcess.send.calledOnce);
      expect(module.processPoWSessionClose.calledOnceWithExactly(session)).to.equal(true);
      expect(childProcess.send.firstCall.args[0]).to.deep.include({
        action: "pow-session-close",
        sessionId: "session",
      });
      expect(childProcess.send.firstCall.args[0].info).to.deep.include({
        failedCode: "SLASHED",
        failedReason: "invalid PoW verification result",
      });
      expect(JSON.stringify(childProcess.send.firstCall.args[0])).not.to.contain("RAW_POW_CLOSE_MARKER");
    });

    it("drains admitted session work before destroying the child session", async () => {
      let failure = new PromiseDfd<void>();
      let closeAcknowledgement = new PromiseDfd<void>();
      let ipcOrder: string[] = [];
      let childProcess = new EventEmitter() as any;
      childProcess.send = sinon.spy((message, callback) => {
        ipcOrder.push(message.action);
        callback?.(null);
        if(message.action === "pow-session-close") {
          void closeAcknowledgement.promise.then(() => {
            ipcOrder.push("pow-session-close-ack");
            childProcess.emit("message", {
              action: "pow-session-close-ack",
              sessionId: message.sessionId,
              closeId: message.closeId,
            });
          });
        }
      });
      let module = createStoppingPoWModule({processPoWSessionClose: sinon.stub().resolves()});
      let server = new PoWServer(module, "test-server", {childProcess} as any);
      let session = {
        getSessionId: () => "session",
        getDropAmount: () => 0n,
        subPenalty: sinon.stub().resolves(0n),
        setSessionFailed: sinon.stub().returns(failure.promise),
        addReward: sinon.spy(),
        getSessionInfo: sinon.stub().resolves({status: "failed", failedCode: "SLASHED"}),
      } as any;
      (server as any).sessions.session = session;

      childProcess.emit("message", {
        action: "pow-session-abort",
        sessionId: "session",
        type: "slashed",
        reason: "invalid PoW result hash",
        dirtyProps: {},
      });
      let destroySettled = false;
      let destroy = server.destroySession("session", true).then(() => {
        destroySettled = true;
      });
      childProcess.emit("message", {
        action: "pow-session-reward",
        sessionId: "session",
        reqId: 1,
        amount: "1",
        type: "share",
        dirtyProps: {},
      });
      await Promise.resolve();

      expect(destroySettled).to.equal(false, "session destruction overtook admitted abort work");
      expect(childProcess.send.called).to.equal(false, "child session was destroyed before its close acknowledgement");
      expect(session.addReward.called).to.equal(false, "new session work entered after destruction was requested");

      failure.resolve();
      await awaitSleepPromise(100, () => childProcess.send.calledOnce);
      expect(childProcess.send.calledOnce).to.equal(true, "parent did not send the close request");
      expect(destroySettled).to.equal(false, "session destruction overtook the child close acknowledgement");
      closeAcknowledgement.resolve();
      await destroy;
      expect(ipcOrder).to.deep.equal([
        "pow-session-close",
        "pow-session-close-ack",
        "pow-destroy-session",
      ]);
      expect(childProcess.send.secondCall.args[0]).to.deep.equal({
        action: "pow-destroy-session",
        sessionId: "session",
        failed: true,
      });
      expect(server.getSessionCount()).to.equal(0);
      childProcess.emit("close");
    });

    it("acknowledges a child session close after dependent promise work drains", async () => {
      let validatorWorker = createFakeValidatorWorker();
      globalStubs["FaucetWorkers.createWorker"].returns(validatorWorker);
      let channel = new MessageChannel();
      let worker = new PoWServerWorker(channel.port1 as any);
      let closeResult = new PromiseDfd<void>();
      let order: string[] = [];
      void closeResult.promise.then(() => order.push("close-continuation"));
      (worker as any).sessions.session = {
        processSessionClose: () => closeResult.resolve(),
      };
      sinon.stub(worker as any, "sendMessage").callsFake((message: any) => {
        if(message.action === "pow-session-close-ack")
          order.push("acknowledgement");
      });

      try {
        let acknowledgement = (worker as any).onPoWSessionClose("session", {status: "failed"}, 7);
        await Promise.resolve();
        expect(order).to.deep.equal(["close-continuation"]);
        await acknowledgement;
        expect(order).to.deep.equal(["close-continuation", "acknowledgement"]);
      } finally {
        (worker as any).sessions = {};
        await (worker as any).onPoWShutdown();
        channel.port1.close();
        channel.port2.close();
      }
    });

    it("shuts down when a session-close IPC callback fails", async () => {
      let sendFailure = new Error("close callback failed");
      let childProcess = new EventEmitter() as any;
      childProcess.kill = sinon.spy();
      childProcess.send = sinon.spy((message, callback) => {
        if(message.action === "pow-session-close")
          setImmediate(() => callback(sendFailure));
      });
      let module = createStoppingPoWModule({processPoWSessionClose: sinon.stub().resolves()});
      let server = new PoWServer(module, "test-server", {childProcess} as any);
      (server as any).sessions.session = {
        getSessionId: () => "session",
        getDropAmount: () => 0n,
        subPenalty: sinon.stub().resolves(0n),
        setSessionFailed: sinon.stub().resolves(),
        getSessionInfo: sinon.stub().resolves({status: "failed", failedCode: "SLASHED"}),
      };

      childProcess.emit("message", {
        action: "pow-session-abort",
        sessionId: "session",
        type: "slashed",
        reason: "invalid PoW result hash",
        dirtyProps: {},
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(childProcess.send.calledWith({action: "pow-shutdown"})).to.equal(true);

      childProcess.emit("close");
      let shutdownError = await server.shutdown().then(() => null, (error) => error as Error);
      expect(shutdownError).to.be.instanceOf(Error);
      expect(shutdownError.message).to.include("session abort failed: close callback failed");
      expect(server.getSessionCount()).to.equal(0);
    });

    it("bounds session-close teardown when send or acknowledgement stays pending", async () => {
      let clock = sinon.useFakeTimers();

      try {
        for(let confirmSend of [false, true]) {
          let childProcess = new EventEmitter() as any;
          childProcess.kill = sinon.spy();
          childProcess.send = sinon.spy((message, callback) => {
            if(confirmSend && message.action === "pow-session-close")
              callback(null);
          });
          let module = createStoppingPoWModule({processPoWSessionClose: sinon.stub().resolves()});
          let server = new PoWServer(module, "test-server", {childProcess} as any);
          (server as any).sessions.session = {
            getSessionId: () => "session",
            getDropAmount: () => 0n,
            subPenalty: sinon.stub().resolves(0n),
            setSessionFailed: sinon.stub().resolves(),
            getSessionInfo: sinon.stub().resolves({status: "failed", failedCode: "SLASHED"}),
          };

          childProcess.emit("message", {
            action: "pow-session-abort",
            sessionId: "session",
            type: "slashed",
            reason: "invalid PoW result hash",
            dirtyProps: {},
          });
          await clock.tickAsync(0);
          expect(childProcess.send.firstCall.args[0]).to.deep.include({
            action: "pow-session-close",
            sessionId: "session",
          });

          await clock.tickAsync(4_999);
          expect(module.stopServer.called).to.equal(false);
          await clock.tickAsync(1);
          expect(module.stopServer.calledOnceWithExactly(server)).to.equal(true);
          expect(childProcess.send.calledWith({action: "pow-shutdown"})).to.equal(true);

          childProcess.emit("close");
          let shutdownError = await server.shutdown().then(() => null, (error) => error as Error);
          expect(shutdownError).to.be.instanceOf(Error);
          expect(shutdownError.message).to.include("PoW worker did not acknowledge session close");
        }
      } finally {
        clock.restore();
      }
    });

    it("keeps a destroy tombstone through asynchronous IPC failure and child closure", async () => {
      let sendFailure = new Error("destroy callback failed");
      let childProcess = new EventEmitter() as any;
      childProcess.kill = sinon.spy();
      childProcess.send = sinon.spy((message, callback) => {
        if(message.action === "pow-destroy-session")
          setImmediate(() => callback(sendFailure));
      });
      let server = new PoWServer(createStoppingPoWModule(), "test-server", {childProcess} as any);
      let session = {addReward: sinon.spy()} as any;
      (server as any).sessions.session = session;

      let destroy = server.destroySession("session", false);
      expect(server.destroySession("session", true)).to.equal(destroy, "duplicate destruction created a second owner");
      let destroySettled = false;
      void destroy.then(
        () => destroySettled = true,
        () => destroySettled = true,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(server.destroySession("session", false)).to.equal(destroy, "failed send replaced the destroy owner");
      expect(destroySettled).to.equal(false, "failed destroy settled before child closure");
      expect(childProcess.send.firstCall.args[0]).to.deep.equal({
        action: "pow-destroy-session",
        sessionId: "session",
        failed: true,
      });
      expect(childProcess.send.getCalls().filter((call) => call.args[0].action === "pow-destroy-session"))
        .to.have.length(1);
      expect(childProcess.send.calledWith({action: "pow-shutdown"})).to.equal(true);
      expect(server.getSessionCount()).to.equal(1, "failed send discarded the parent session before child closure");
      childProcess.emit("message", {
        action: "pow-session-reward",
        sessionId: "session",
        reqId: 1,
        amount: "1",
        type: "share",
        dirtyProps: {},
      });
      expect(session.addReward.called).to.equal(false, "failed teardown reopened session message admission");

      childProcess.emit("close");
      expect(await destroy.then(() => null, (error) => error)).to.equal(sendFailure);
      expect(server.getSessionCount()).to.equal(0);
    });

    it("keeps a destroy tombstone through synchronous IPC failure", async () => {
      let sendFailure = new Error("destroy send threw");
      let childProcess = new EventEmitter() as any;
      childProcess.kill = sinon.spy();
      childProcess.send = sinon.spy((message) => {
        if(message.action === "pow-destroy-session")
          throw sendFailure;
      });
      let server = new PoWServer(createStoppingPoWModule(), "test-server", {childProcess} as any);
      (server as any).sessions.session = {};

      let destroy = server.destroySession("session", true);
      let destroySettled = false;
      void destroy.then(
        () => destroySettled = true,
        () => destroySettled = true,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(server.destroySession("session", false)).to.equal(destroy, "failed send replaced the destroy owner");
      expect(destroySettled).to.equal(false, "failed destroy settled before child closure");
      expect(childProcess.send.getCalls().filter((call) => call.args[0].action === "pow-destroy-session"))
        .to.have.length(1);
      expect(childProcess.send.calledWith({action: "pow-shutdown"})).to.equal(true);
      expect(server.getSessionCount()).to.equal(1);

      childProcess.emit("close");
      expect(await destroy.then(() => null, (error) => error)).to.equal(sendFailure);
      expect(server.getSessionCount()).to.equal(0);
    });

    it("bounds destroy confirmation and ignores a late callback", async () => {
      let clock = sinon.useFakeTimers();
      let destroyCallback: (error: Error | null) => void;
      let childProcess = new EventEmitter() as any;
      childProcess.kill = sinon.spy();
      childProcess.send = sinon.spy((message, callback) => {
        if(message.action === "pow-destroy-session")
          destroyCallback = callback;
      });
      let module = createStoppingPoWModule();
      let server = new PoWServer(module, "test-server", {childProcess} as any);
      (server as any).sessions.session = {};

      try {
        let destroy = server.destroySession("session", false);
        let destroySettled = false;
        void destroy.then(
          () => destroySettled = true,
          () => destroySettled = true,
        );
        await clock.tickAsync(0);
        await clock.tickAsync(4_999);
        expect(destroySettled).to.equal(false);
        expect(module.stopServer.called).to.equal(false);

        await clock.tickAsync(1);
        expect(module.stopServer.calledOnceWithExactly(server)).to.equal(true);
        expect(server.destroySession("session", true)).to.equal(destroy);
        expect(childProcess.send.getCalls().filter((call) => call.args[0].action === "pow-destroy-session"))
          .to.have.length(1);
        expect(destroySettled).to.equal(false, "timed-out destroy settled before child closure");

        destroyCallback(null);
        await clock.tickAsync(0);
        expect(destroySettled).to.equal(false, "late callback reopened timed-out destruction");
        expect(server.getSessionCount()).to.equal(1);

        childProcess.emit("close");
        let destroyError = await destroy.then(() => null, (error) => error as Error);
        expect(destroyError).to.be.instanceOf(Error);
        expect(destroyError.message).to.equal("PoW worker did not confirm session destruction");
        expect(server.getSessionCount()).to.equal(0);
        await server.shutdown();
      } finally {
        clock.restore();
      }
    });

    it("accepts child closure as completion while a destroy send callback is pending", async () => {
      let callback: (error: Error | null) => void;
      let childProcess = new EventEmitter() as any;
      childProcess.kill = sinon.spy();
      childProcess.send = sinon.spy((message, sendCallback) => {
        if(message.action === "pow-destroy-session")
          callback = sendCallback;
      });
      let server = new PoWServer({} as any, "test-server", {childProcess} as any);
      (server as any).sessions.session = {};

      let destroy = server.destroySession("session", false);
      await Promise.resolve();
      childProcess.emit("close");
      await destroy;
      expect(server.getSessionCount()).to.equal(0);

      callback(new Error("late callback failure"));
      await Promise.resolve();
      expect((server as any).pendingSessionDestroys).to.have.property("size", 0);
    });

    it("waits for in-flight main-process message work after the PoW child closes", async () => {
      let penalty = new PromiseDfd<bigint>();
      let handlerFinished = new PromiseDfd<void>();
      let childProcess = new EventEmitter() as any;
      childProcess.send = sinon.spy();
      childProcess.kill = sinon.spy();
      let module = {
        processPoWSessionClose: sinon.stub().callsFake(async () => handlerFinished.resolve()),
      } as any;
      let server = new PoWServer(module, "test-server", {childProcess} as any);
      let session = {
        getSessionId: () => "session",
        getDropAmount: () => 0n,
        subPenalty: sinon.stub().returns(penalty.promise),
        setSessionFailed: sinon.stub().resolves(),
        getSessionInfo: sinon.stub().resolves({status: "failed"}),
      } as any;
      (server as any).sessions.session = session;

      childProcess.emit("message", {
        action: "pow-session-abort",
        sessionId: "session",
        type: "slashed",
        reason: "invalid PoW result hash",
        dirtyProps: {},
      });
      await Promise.resolve();
      let shutdownSettled = false;
      let shutdown = server.shutdown().then(() => shutdownSettled = true);
      childProcess.emit("close");
      await Promise.resolve();
      await Promise.resolve();

      let settledAtChildClose = shutdownSettled;
      penalty.resolve(0n);
      await handlerFinished.promise;
      await shutdown;

      expect(settledAtChildClose).to.equal(false, "PoW shutdown ignored its in-flight abort handler");
      expect(session.setSessionFailed.calledOnceWithExactly("SLASHED", "invalid PoW result hash")).to.equal(true);
      expect(module.processPoWSessionClose.calledOnceWithExactly(session)).to.equal(true);
    });

    it("retains constant-size evidence while logging and draining rejected message work", async () => {
      const rejectionCount = 256;
      let finalPenalty = new PromiseDfd<bigint>();
      let penaltyCallCount = 0;
      let childProcess = new EventEmitter() as any;
      childProcess.send = sinon.spy();
      childProcess.kill = sinon.spy();
      let module = {processPoWSessionClose: sinon.stub().resolves()} as any;
      let server = new PoWServer(module, "test-server", {childProcess} as any);
      let session = {
        getSessionId: () => "session",
        getDropAmount: () => 0n,
        subPenalty: sinon.stub().callsFake(() => {
          penaltyCallCount++;
          return penaltyCallCount === rejectionCount
            ? finalPenalty.promise
            : Promise.reject(new Error("tracked handler failure " + penaltyCallCount));
        }),
        setSessionFailed: sinon.stub().resolves(),
        getSessionInfo: sinon.stub().resolves({status: "failed"}),
      } as any;
      (server as any).sessions.session = session;
      let emitLog = sinon.spy(ServiceManager.GetService(FaucetProcess), "emitLog");
      let rejectedHandlerLogs = () => emitLog.getCalls().filter((call) =>
        call.args[0] === FaucetLogLevel.ERROR &&
        String(call.args[1]).startsWith("PoW server session abort failed:"),
      ).length;

      for(let idx = 0; idx < rejectionCount; idx++) {
        childProcess.emit("message", {
          action: "pow-session-abort",
          sessionId: "session",
          type: "slashed",
          reason: "invalid PoW result hash",
          dirtyProps: {},
        });
      }
      await awaitSleepPromise(1000, () => rejectedHandlerLogs() === rejectionCount - 1);

      expect((server as any).messageOperationErrorCount).to.equal(rejectionCount - 1);
      expect((server as any).firstMessageOperationError).to.be.instanceOf(Error);
      expect((server as any).messageOperationErrors).to.equal(undefined);
      let firstRetainedError = (server as any).firstMessageOperationError;

      let shutdownSettled = false;
      let shutdown = server.shutdown().then(
        () => null,
        (error) => error,
      ).finally(() => shutdownSettled = true);
      childProcess.emit("close");
      await Promise.resolve();
      await Promise.resolve();
      expect(shutdownSettled).to.equal(false, "PoW shutdown ignored the final rejected message operation");

      finalPenalty.reject(new Error("tracked handler failure " + rejectionCount));
      let shutdownError = await shutdown;

      expect(rejectedHandlerLogs()).to.equal(rejectionCount, "not every rejected message operation was logged");
      expect((server as any).messageOperationErrorCount).to.equal(rejectionCount);
      expect((server as any).firstMessageOperationError).to.equal(firstRetainedError);
      expect((server as any).messageOperations).to.have.property("size", 0);
      expect(shutdownError).to.be.instanceOf(Error);
      expect((shutdownError as Error).message).to.equal(
        rejectionCount + " PoW message operations failed; first failure: PoW server session abort failed: tracked handler failure 1",
      );
    });

    it("quiesces PoW producers before removing session hooks", async () => {
      faucetConfig.modules["pow"] = createTestPoWConfig();
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let powModule = moduleManager.getModule<PoWModule>("pow");
      let shutdownGate = new PromiseDfd<void>();
      let server = {
        getServerId: () => "shutdown-server",
        shutdown: sinon.stub().returns(shutdownGate.promise),
      } as any;
      (powModule as any).powServers[server.getServerId()] = server;

      let quiescenceSettled = false;
      let quiescence = moduleManager.quiesceRewardProducers().then(() => quiescenceSettled = true);
      await awaitSleepPromise(100, () => server.shutdown.calledOnce);

      expect(server.shutdown.calledOnceWithExactly()).to.equal(true);
      expect(quiescenceSettled).to.equal(false, "producer quiescence ignored the active PoW server");
      expect(moduleManager.getActionHooks(ModuleHookAction.SessionComplete).some((hook) => hook.module === powModule)).to.equal(
        true,
        "session completion hooks were removed before reward producers drained",
      );

      shutdownGate.resolve();
      await quiescence;
      expect((powModule as any).powServers).to.deep.equal({});
      expect(moduleManager.getActionHooks(ModuleHookAction.SessionComplete).some((hook) => hook.module === powModule)).to.equal(true);

      await moduleManager.dispose();
      expect(moduleManager.getActionHooks(ModuleHookAction.SessionComplete).some((hook) => hook.module === powModule)).to.equal(false);
      expect(server.shutdown.callCount).to.equal(1, "module stop restarted an already quiesced producer");
    });

    it("releases a real pre-init PoW SessionStart before draining the full start operation", async () => {
      faucetConfig.modules["pow"] = createTestPoWConfig();
      let childProcess = new EventEmitter() as any;
      childProcess.send = sinon.spy();
      childProcess.kill = sinon.spy();
      globalStubs["FaucetWorkers.createChildProcess"].returns({
        childProcess,
        controller: new AbortController(),
      });
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let powModule = moduleManager.getModule<PoWModule>("pow");
      let sessionManager = ServiceManager.GetService(SessionManager);
      await sessionManager.initialize();
      let start = sessionManager.createSession("8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      }).then(
        () => null,
        (error) => error,
      );
      await awaitSleepPromise(100, () => Object.keys((powModule as any).powServers).length === 1);
      expect(Object.keys((powModule as any).powServers)).to.have.length(1);

      sessionManager.stopRewardOperations();
      let quiescence = moduleManager.quiesceRewardProducers();
      let startDrainSettled = false;
      let startDrain = sessionManager.drainRewardProducers().finally(() => startDrainSettled = true);
      await awaitSleepPromise(100, () => childProcess.send.calledWith({action: "pow-shutdown"}));

      try {
        expect(childProcess.send.calledWith({action: "pow-shutdown"})).to.equal(true);
        await awaitSleepPromise(100, () => startDrainSettled);
        expect(startDrainSettled).to.equal(true, "PoW shutdown did not release the accepted start hook");
      } finally {
        childProcess.emit("close");
        await Promise.allSettled([quiescence, startDrain]);
      }
      let startError = await start;

      expect(startError).to.be.instanceOf(Error).with.property("message", "PoW worker closed before becoming ready");
      expect(startDrainSettled).to.equal(true);
      expect((powModule as any).powServers).to.deep.equal({});
      expect(await sessionManager.createSession("8.8.4.4", {
        addr: "0x0000000000000000000000000000000000007331",
      }).then(() => null, (error) => (error as any).getCode?.())).to.equal("FAUCET_UNAVAILABLE");
    });

    it("does not allocate a PoW server when a captured SessionStart hook resumes after quiescence", async () => {
      faucetConfig.modules["pow"] = createTestPoWConfig();
      let childProcess = new EventEmitter() as any;
      childProcess.send = sinon.spy();
      childProcess.kill = sinon.spy();
      globalStubs["FaucetWorkers.createChildProcess"].returns({
        childProcess,
        controller: new AbortController(),
      });
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let powModule = moduleManager.getModule<PoWModule>("pow");
      let releaseEarlierHook = new PromiseDfd<void>();
      let earlierHookEntered = new PromiseDfd<void>();
      moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 5, "hold before PoW", async () => {
        earlierHookEntered.resolve();
        await releaseEarlierHook.promise;
      });
      let sessionManager = ServiceManager.GetService(SessionManager);
      await sessionManager.initialize();
      let start = sessionManager.createSession("8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      }).then(
        () => null,
        (error) => error,
      );
      await earlierHookEntered.promise;

      sessionManager.stopRewardOperations();
      let quiescenceSettled = false;
      let quiescence = moduleManager.quiesceRewardProducers().finally(() => quiescenceSettled = true);
      await powModule.quiesceRewardProducer();
      expect((powModule as any).powServers).to.deep.equal({});

      releaseEarlierHook.resolve();
      await awaitSleepPromise(100, () => quiescenceSettled || Object.keys((powModule as any).powServers).length > 0);
      let allocatedAfterQuiescence = Object.keys((powModule as any).powServers).length > 0;
      try {
        expect(allocatedAfterQuiescence).to.equal(false, "captured SessionStart allocated after PoW admission closed");
      } finally {
        if(allocatedAfterQuiescence)
          childProcess.emit("close");
        await Promise.allSettled([quiescence, sessionManager.drainRewardProducers()]);
      }
      let startError = await start;

      expect(startError).to.be.instanceOf(Error).with.property("message", "PoW session admission is closed");
      expect(quiescenceSettled).to.equal(true);
      expect(globalStubs["FaucetWorkers.createChildProcess"].called).to.equal(false);
      expect((powModule as any).powServers).to.deep.equal({});
    });

    it("closes PoW connection admission and drains accepted pre-allocation handlers", async () => {
      let powModule = new PoWModule(ServiceManager.GetService(ModuleManager), "pow");
      let releaseRemoteIpUpdate = new PromiseDfd<void>();
      let server = {
        getServerId: () => "late-server",
        connect: sinon.stub().resolves(),
        shutdown: sinon.stub().resolves(),
      } as any;
      let getPoWServer = sinon.stub(powModule as any, "getPoWServerForSession").callsFake(async () => {
        (powModule as any).powServers[server.getServerId()] = server;
        return server;
      });
      let session = {
        getSessionId: () => "late-upgrade",
        updateRemoteIP: sinon.stub().returns(releaseRemoteIpUpdate.promise),
        setSessionData: sinon.spy(),
      } as any;
      sinon.stub(ServiceManager.GetService(SessionManager), "getSession").returns(session);
      let acceptedSocket = {
        write: sinon.spy(),
        end: sinon.spy(),
      } as any;

      let acceptedUpgrade = (powModule as any).processPoWClientWebSocket(
        {url: "/ws/pow?session=late-upgrade&cliver=test"} as any,
        acceptedSocket,
        Buffer.alloc(0),
        "8.8.8.8",
      );
      await awaitSleepPromise(100, () => session.updateRemoteIP.calledOnce);
      expect(session.updateRemoteIP.calledOnce).to.equal(true);

      let quiescenceSettled = false;
      let quiescence = powModule.quiesceRewardProducer().finally(() => quiescenceSettled = true);
      let rejectedSocket = {
        write: sinon.spy(),
        end: sinon.spy(),
      } as any;
      let rejectedUpgrade = (powModule as any).processPoWClientWebSocket(
        {url: "/ws/pow?session=late-upgrade&cliver=test"} as any,
        rejectedSocket,
        Buffer.alloc(0),
        "8.8.4.4",
      );

      expect(rejectedSocket.end.calledOnceWithExactly()).to.equal(true, "quiescence left PoW connection admission open");
      expect(rejectedSocket.write.firstCall.args[0]).to.contain("503 Service Unavailable");
      await Promise.resolve();
      expect(session.updateRemoteIP.calledOnce).to.equal(true, "a post-quiescence connection reached session work");
      await Promise.resolve();
      await Promise.resolve();
      expect(quiescenceSettled).to.equal(false, "quiescence did not wait for an already accepted PoW handler");
      expect(getPoWServer.called).to.equal(false);

      releaseRemoteIpUpdate.resolve();
      await Promise.all([acceptedUpgrade, rejectedUpgrade]);
      await quiescence;

      expect(acceptedSocket.end.calledOnceWithExactly()).to.equal(true);
      expect(acceptedSocket.write.firstCall.args[0]).to.contain("503 Service Unavailable");
      expect(getPoWServer.called).to.equal(false, "a pre-allocation handler created a server after admission closed");
      expect(server.connect.called).to.equal(false);
      expect(server.shutdown.called).to.equal(false);
      expect((powModule as any).powServers).to.deep.equal({});
      await powModule.quiesceRewardProducer();
      expect(server.shutdown.callCount).to.equal(0, "repeated quiescence touched an unallocated server");
    });

    it("starts server shutdown before draining a tracked handler waiting for worker initialization", async () => {
      let powModule = new PoWModule(ServiceManager.GetService(ModuleManager), "pow");
      (powModule as any).moduleConfig = createTestPoWConfig();
      let childProcess = new EventEmitter() as any;
      childProcess.send = sinon.spy();
      childProcess.kill = sinon.spy();
      globalStubs["FaucetWorkers.createChildProcess"].returns({
        childProcess,
        controller: new AbortController(),
      });
      let session = {
        getSessionId: () => "tracked-pending-init",
        getStartTime: () => 1,
        getDropAmount: () => 0n,
        getSessionData: sinon.stub(),
        getSessionModuleRef: sinon.stub().returns(null),
        setSessionModuleRef: sinon.spy(),
        updateRemoteIP: sinon.stub().resolves(),
        setSessionData: sinon.spy(),
      } as any;
      sinon.stub(ServiceManager.GetService(SessionManager), "getSession").returns(session);
      let socket = {
        write: sinon.spy(),
        end: sinon.spy(),
        pause: sinon.spy(),
        removeAllListeners: sinon.spy(),
        destroy: sinon.spy(),
      } as any;

      let handler = (powModule as any).processPoWClientWebSocket(
        {url: "/ws/pow?session=tracked-pending-init&cliver=test", method: "GET", headers: {}} as any,
        socket,
        Buffer.alloc(0),
        "8.8.8.8",
      ).then(
        () => null,
        (error) => error,
      );
      await awaitSleepPromise(100, () => Object.keys((powModule as any).powServers).length === 1);
      expect(Object.keys((powModule as any).powServers)).to.have.length(1);

      let quiescenceSettled = false;
      let quiescence = powModule.quiesceRewardProducer().then(
        () => null,
        (error) => error,
      ).finally(() => quiescenceSettled = true);
      await awaitSleepPromise(100, () => childProcess.send.calledWith({action: "pow-shutdown"}));

      expect(childProcess.send.calledWith({action: "pow-shutdown"})).to.equal(true);
      expect(await handler).to.be.instanceOf(Error).with.property("message", "PoW worker closed before becoming ready");
      expect(socket.destroy.calledOnceWithExactly()).to.equal(true);
      expect(quiescenceSettled).to.equal(false, "quiescence stopped waiting before the child closed");

      childProcess.emit("close");
      expect(await quiescence).to.equal(null);
      expect((powModule as any).powServers).to.deep.equal({});
    });

    it("does not register sessions on a server whose shutdown is still pending", async () => {
      let powModule = new PoWModule(ServiceManager.GetService(ModuleManager), "pow");
      (powModule as any).moduleConfig = createTestPoWConfig({powSessionsPerServer: 1});
      let createChild = () => {
        let childProcess = new EventEmitter() as any;
        childProcess.send = sinon.spy();
        childProcess.kill = sinon.spy();
        return childProcess;
      };
      let fullChild = createChild();
      let drainingChild = createChild();
      let replacementChild = createChild();
      let fullServer = new PoWServer(powModule, "full-server", {childProcess: fullChild} as any);
      let drainingServer = new PoWServer(powModule, "draining-server", {childProcess: drainingChild} as any);
      (fullServer as any).sessions.existing = {};
      (powModule as any).powServers = {
        [fullServer.getServerId()]: fullServer,
        [drainingServer.getServerId()]: drainingServer,
      };
      globalStubs["FaucetWorkers.createChildProcess"].returns({
        childProcess: replacementChild,
        controller: new AbortController(),
      });
      let registerSession = sinon.stub(PoWServer.prototype, "registerSession").resolves();
      let session = {
        getSessionId: () => "new-session",
        getSessionModuleRef: sinon.stub().returns(null),
        setSessionModuleRef: sinon.spy(),
      } as any;

      (powModule as any).stopServer(drainingServer);
      expect(drainingChild.send.calledOnce).to.equal(true);
      expect(drainingChild.send.firstCall.args[0]).to.deep.equal({action: "pow-shutdown"});
      expect(drainingChild.send.firstCall.args[1]).to.be.a("function");
      expect((powModule as any).powServers[drainingServer.getServerId()]).to.equal(
        drainingServer,
        "the draining server left the registry before shutdown settled",
      );

      let selectedServer = await (powModule as any).getPoWServerForSession(session, true);

      expect(selectedServer).not.to.equal(drainingServer, "new work was admitted after pow-shutdown");
      expect(selectedServer).not.to.equal(fullServer, "the full server accepted another session");
      expect(registerSession.calledOnce).to.equal(true);
      expect(registerSession.calledOn(selectedServer)).to.equal(true);
      expect((drainingServer as any).isAcceptingSessions()).to.equal(false);

      drainingChild.emit("close");
      await awaitSleepPromise(100, () => !(powModule as any).powServers[drainingServer.getServerId()]);
      expect((powModule as any).powServers[drainingServer.getServerId()]).to.equal(undefined);

      let quiescence = powModule.quiesceRewardProducer();
      await awaitSleepPromise(100, () =>
        fullChild.send.calledWith({action: "pow-shutdown"}) &&
        replacementChild.send.calledWith({action: "pow-shutdown"}),
      );
      fullChild.emit("close");
      replacementChild.emit("close");
      await quiescence;
      expect((powModule as any).powServers).to.deep.equal({});
    });

    it("rejects accepted setup and drains quiescence when the child closes before initialization", async () => {
      let powModule = new PoWModule(ServiceManager.GetService(ModuleManager), "pow");
      (powModule as any).moduleConfig = createTestPoWConfig();
      let childProcess = new EventEmitter() as any;
      childProcess.send = sinon.spy();
      childProcess.kill = sinon.spy();
      globalStubs["FaucetWorkers.createChildProcess"].returns({
        childProcess,
        controller: new AbortController(),
      });
      let session = {
        getSessionId: () => "pending-init-session",
        getStartTime: () => 1,
        getDropAmount: () => 0n,
        getSessionData: sinon.stub(),
        getSessionModuleRef: sinon.stub().returns(null),
        setSessionModuleRef: sinon.spy(),
      } as any;

      let setupError: unknown;
      let setupSettled = false;
      void (powModule as any).getPoWServerForSession(session, true).then(
        () => setupSettled = true,
        (error) => {
          setupError = error;
          setupSettled = true;
        },
      );
      await Promise.resolve();
      let server = Object.values((powModule as any).powServers)[0] as PoWServer;
      let socket = {
        pause: sinon.spy(),
        removeAllListeners: sinon.spy(),
        destroy: sinon.spy(),
      } as any;
      let connectionError: unknown;
      let connectionSettled = false;
      void server.connect(
        session.getSessionId(),
        {url: "/ws/pow", method: "GET", headers: {}} as any,
        socket,
        Buffer.alloc(0),
      ).then(
        () => connectionSettled = true,
        (error) => {
          connectionError = error;
          connectionSettled = true;
        },
      );
      let quiescence = powModule.quiesceRewardProducer().then(
        () => null,
        (error) => error,
      );
      await awaitSleepPromise(100, () => childProcess.send.calledWith({action: "pow-shutdown"}));
      expect(childProcess.send.calledWith({action: "pow-shutdown"})).to.equal(true);

      let futureReadyError: unknown;
      let futureReadySettled = false;
      void server.getReadyPromise().then(
        () => futureReadySettled = true,
        (error) => {
          futureReadyError = error;
          futureReadySettled = true;
        },
      );
      childProcess.emit("close");
      let quiescenceError = await quiescence;
      await awaitSleepPromise(100, () => setupSettled && connectionSettled && futureReadySettled);

      expect(setupSettled).to.equal(true, "registration remained pending after pre-init child close");
      expect(connectionSettled).to.equal(true, "connection remained pending after pre-init child close");
      expect(futureReadySettled).to.equal(true, "future readiness remained pending after pre-init child close");
      expect(setupError).to.be.instanceOf(Error).with.property("message", "PoW worker closed before becoming ready");
      expect(connectionError).to.equal(setupError);
      expect(futureReadyError).to.equal(setupError);
      expect(quiescenceError).to.equal(null);
      expect(socket.destroy.calledOnceWithExactly()).to.equal(true, "failed connection retained its detached socket");
      expect(server.getSessionCount()).to.equal(0, "failed registration retained session ownership");
      expect(server.isAcceptingSessions()).to.equal(false, "a closed child remained selectable");
      expect((powModule as any).powServers).to.deep.equal({});
    });

    it("owns pre-init close rejection when no readiness waiter exists", async () => {
      let childProcess = new EventEmitter() as any;
      childProcess.send = sinon.spy();
      childProcess.kill = sinon.spy();
      let server = new PoWServer({} as any, "uninitialized-server", {childProcess} as any);
      let unhandled: unknown[] = [];
      let onUnhandled = (error: unknown) => unhandled.push(error);
      process.on("unhandledRejection", onUnhandled);
      try {
        childProcess.emit("close");
        await new Promise<void>((resolve) => setImmediate(resolve));

        let futureError = await server.getReadyPromise().then(() => null, (error) => error);
        expect(futureError).to.be.instanceOf(Error).with.property("message", "PoW worker closed before becoming ready");
        expect(server.isAcceptingSessions()).to.equal(false);
        expect(unhandled).to.deep.equal([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });

    it("continues draining every PoW server after one shutdown fails", async () => {
      let powModule = new PoWModule(ServiceManager.GetService(ModuleManager), "pow");
      let pendingShutdown = new PromiseDfd<void>();
      let shutdownFailure = new Error("first PoW server shutdown failed");
      let failedServer = {
        getServerId: () => "failed-server",
        shutdown: sinon.stub().rejects(shutdownFailure),
      } as any;
      let pendingServer = {
        getServerId: () => "pending-server",
        shutdown: sinon.stub().returns(pendingShutdown.promise),
      } as any;
      (powModule as any).powServers = {
        [failedServer.getServerId()]: failedServer,
        [pendingServer.getServerId()]: pendingServer,
      };

      let quiescenceSettled = false;
      let quiescence = powModule.quiesceRewardProducer().then(
        () => null,
        (error) => error,
      ).finally(() => quiescenceSettled = true);
      await Promise.resolve();
      await Promise.resolve();

      expect(quiescenceSettled).to.equal(false, "one failed server released producer quiescence early");
      expect(pendingServer.shutdown.calledOnceWithExactly()).to.equal(true);
      pendingShutdown.resolve();
      expect(await quiescence).to.equal(shutdownFailure);
      expect((powModule as any).powServers).to.deep.equal({});
    });

    it("waits for child closure when PoW shutdown signaling fails", async () => {
      for(let failureMode of ["throw", "callback"] as const) {
        let shutdownSignalFailure = new Error("PoW shutdown signal failed: " + failureMode);
        let childProcess = new EventEmitter() as any;
        childProcess.send = sinon.stub().callsFake((_message, callback) => {
          if(failureMode === "throw")
            throw shutdownSignalFailure;
          queueMicrotask(() => callback(shutdownSignalFailure));
        });
        childProcess.kill = sinon.spy();
        let server = new PoWServer({} as any, "test-server", {childProcess} as any);

        let shutdownSettled = false;
        let shutdown = server.shutdown().then(
          () => null,
          (error) => error,
        ).finally(() => shutdownSettled = true);
        await Promise.resolve();
        await Promise.resolve();

        expect(childProcess.send.firstCall.args[1]).to.be.a("function");
        expect(shutdownSettled).to.equal(false, "failed shutdown signaling skipped child-process closure");
        childProcess.emit("close");
        expect(await shutdown).to.equal(shutdownSignalFailure);
        expect(childProcess.kill.called).to.equal(false);
      }
    });

    it("terminates a timed-out validator generation before accepting replacement work", async () => {
      let firstWorker = createFakeValidatorWorker();
      let secondWorker = createFakeValidatorWorker();
      let termination = new PromiseDfd<number>();
      firstWorker.terminate.returns(termination.promise);
      let workerFactory = sinon.stub().returns(secondWorker);
      let config = createTestPoWConfig({verifyLocalTimeout: 0.005});
      let validator = new PoWValidator({
        worker: firstWorker as any,
        workerFactory: workerFactory as any,
        initTimeoutMs: 100,
      });
      let limits = createValidationLimits(config);

      firstWorker.emit("message", {action: "init"});
      let firstAdmission = validator.tryValidateShare("session-1", createValidationRequest("share-1", 1, config), limits);
      if(firstAdmission.kind !== "accepted")
        throw new Error("expected first validation to be admitted");
      let firstResult = firstAdmission.promise.then(
        () => null,
        (error) => error,
      );

      await awaitSleepPromise(100, () => firstWorker.terminate.calledOnce);
      expect(await firstResult).to.be.instanceOf(Error).with.property("message", "PoW validation timed out");
      expect(firstWorker.terminate.calledOnce).to.equal(true);
      expect(workerFactory.called).to.equal(false);
      expect(validator.tryValidateShare("session-2", createValidationRequest("share-2", 2, config), limits)).to.deep.equal({
        kind: "rejected",
        reason: "unavailable",
      });

      termination.resolve(0);
      await awaitSleepPromise(100, () => workerFactory.calledOnce);
      secondWorker.emit("message", {action: "init"});
      let secondAdmission = validator.tryValidateShare("session-2", createValidationRequest("share-2", 2, config), limits);
      if(secondAdmission.kind !== "accepted")
        throw new Error("expected replacement validation to be admitted");
      secondWorker.emit("message", {action: "validated", data: {shareId: "share-2", isValid: true}});
      expect(await secondAdmission.promise).to.equal(true);
      await validator.dispose();
    });

    it("fails closed without a replacement when worker termination fails", async () => {
      let firstWorker = createFakeValidatorWorker();
      firstWorker.terminate.rejects(new Error("termination failed"));
      let workerFactory = sinon.stub();
      let config = createTestPoWConfig();
      let validator = new PoWValidator({
        worker: firstWorker as any,
        workerFactory: workerFactory as any,
      });
      firstWorker.emit("message", {action: "init"});
      let admission = validator.tryValidateShare(
        "session-1",
        createValidationRequest("share-1", 1, config),
        createValidationLimits(config),
      );
      if(admission.kind !== "accepted")
        throw new Error("expected validation to be admitted");
      let result = admission.promise.catch((error) => error);

      firstWorker.emit("error", new Error("worker failed"));
      expect(await result).to.be.instanceOf(Error).with.property("message", "worker failed");
      await awaitSleepPromise(100, () => firstWorker.terminate.calledOnce);
      await Promise.resolve();

      expect(workerFactory.called).to.equal(false);
      expect(firstWorker.listenerCount("message")).to.equal(0);
      expect(firstWorker.listenerCount("error")).to.equal(0);
      expect(firstWorker.listenerCount("exit")).to.equal(0);
      expect(validator.tryValidateShare(
        "session-2",
        createValidationRequest("share-2", 2, config),
        createValidationLimits(config),
      )).to.deep.equal({kind: "rejected", reason: "unavailable"});

      let disposeError = await validator.dispose().catch((error) => error);
      expect(disposeError).to.be.instanceOf(Error).with.property("message", "termination failed");
    });

    it("awaits validator and server-worker teardown before closing the owner port", async () => {
      let worker = createFakeValidatorWorker();
      let termination = new PromiseDfd<number>();
      worker.terminate.returns(termination.promise);
      let validator = new PoWValidator({worker: worker as any});
      worker.emit("message", {action: "init"});

      let validatorDisposed = false;
      let disposePromise = validator.dispose().then(() => {
        validatorDisposed = true;
      });
      await awaitSleepPromise(100, () => worker.terminate.calledOnce);
      expect(worker.terminate.calledOnce).to.equal(true);
      expect(validatorDisposed).to.equal(false);
      expect(worker.listenerCount("message")).to.equal(0);
      expect(worker.listenerCount("error")).to.equal(0);
      expect(worker.listenerCount("exit")).to.equal(0);
      termination.resolve(0);
      await disposePromise;

      let serverTeardown = new PromiseDfd<void>();
      let port = {close: sinon.spy()};
      let serverWorker = Object.create(PoWServerWorker.prototype) as any;
      serverWorker.validator = {dispose: sinon.stub().returns(serverTeardown.promise)};
      serverWorker.sessions = {};
      serverWorker.loadTracker = {stop: sinon.spy()};
      serverWorker.wss = {close: sinon.spy()};
      serverWorker.server = {close: sinon.spy()};
      serverWorker.port = port;

      let shutdownPromise = serverWorker.onPoWShutdown();
      await Promise.resolve();
      expect(port.close.called).to.equal(false);
      serverTeardown.resolve();
      await shutdownPromise;
      expect(port.close.calledOnce).to.equal(true);
    });

    it("dispatches one validation at a time in round-robin session order", async () => {
      let clock = sinon.useFakeTimers({now: 0});
      let worker = createFakeValidatorWorker();
      let config = createTestPoWConfig({
        verifyLocalMaxQueue: 5,
        verifyLocalMaxPendingPerSession: 3,
      });
      let validator = new PoWValidator({worker: worker as any});
      try {
        worker.emit("message", {action: "init"});
        let limits = createValidationLimits(config);
        let admissions = [
          validator.tryValidateShare("session-a", createValidationRequest("a-1", 1, config), limits),
          validator.tryValidateShare("session-a", createValidationRequest("a-2", 2, config), limits),
          validator.tryValidateShare("session-a", createValidationRequest("a-3", 3, config), limits),
          validator.tryValidateShare("session-b", createValidationRequest("b-1", 4, config), limits),
        ];
        if(admissions.some((admission) => admission.kind !== "accepted"))
          throw new Error("expected all validations to be admitted");

        let dispatchedShareIds = () => worker.postMessage.getCalls().map((call) => call.args[0].data.shareId);
        expect(dispatchedShareIds()).to.deep.equal(["a-1"]);
        worker.emit("message", {action: "validated", data: {shareId: "a-1", isValid: true}});
        expect(dispatchedShareIds()).to.deep.equal(["a-1", "b-1"]);
        worker.emit("message", {action: "validated", data: {shareId: "b-1", isValid: true}});
        expect(dispatchedShareIds()).to.deep.equal(["a-1", "b-1"]);
        clock.tick(3);
        expect(dispatchedShareIds()).to.deep.equal(["a-1", "b-1", "a-2"]);
        worker.emit("message", {action: "validated", data: {shareId: "a-2", isValid: true}});
        clock.tick(3);
        expect(dispatchedShareIds()).to.deep.equal(["a-1", "b-1", "a-2", "a-3"]);
        worker.emit("message", {action: "validated", data: {shareId: "a-3", isValid: true}});

        expect(await Promise.all(admissions.map((admission) => {
          if(admission.kind !== "accepted")
            throw new Error("expected validation to be admitted");
          return admission.promise;
        }))).to.deep.equal([true, true, true, true]);
      }
      finally {
        await validator.dispose();
        clock.restore();
      }
    });

    it("meters sustained same-session refills by measured validator work", async () => {
      let clock = sinon.useFakeTimers({now: 0});
      let worker = createFakeValidatorWorker();
      let config = createTestPoWConfig({
        verifyLocalMaxQueue: 4,
        verifyLocalMaxPendingPerSession: 3,
        verifyLocalMaxSessionDutyCyclePercent: 50,
      });
      let validator = new PoWValidator({worker: worker as any});
      try {
        expect(config.powHashrateHardLimit).to.equal(0);
        worker.emit("message", {action: "init"});
        let limits = {...createValidationLimits(config), timeoutMs: 10_000};
        let first = validator.tryValidateShare("session-a", createValidationRequest("a-1", 1, config), limits);
        let second = validator.tryValidateShare("session-a", createValidationRequest("a-2", 2, config), limits);
        if(first.kind !== "accepted" || second.kind !== "accepted")
          throw new Error("expected initial validations to be admitted");

        let dispatchedShareIds = () => worker.postMessage.getCalls().map((call) => call.args[0].data.shareId);
        expect(dispatchedShareIds()).to.deep.equal(["a-1"]);
        clock.tick(100);
        worker.emit("message", {action: "validated", data: {shareId: "a-1", isValid: true}});
        expect(validator.tryValidateShare(
          "session-a",
          createValidationRequest("blocked-refill", 3, config),
          limits,
        )).to.deep.equal({kind: "rejected", reason: "session-rate"});
        clock.tick(99);
        expect(dispatchedShareIds()).to.deep.equal(["a-1"]);
        clock.tick(1);
        expect(dispatchedShareIds()).to.deep.equal(["a-1", "a-2"]);

        let third = validator.tryValidateShare("session-a", createValidationRequest("a-3", 3, config), limits);
        if(third.kind !== "accepted")
          throw new Error("expected refill during active work to be queued");
        clock.tick(100);
        worker.emit("message", {action: "validated", data: {shareId: "a-2", isValid: true}});
        expect(dispatchedShareIds()).to.deep.equal(["a-1", "a-2"]);
        clock.tick(99);
        expect(dispatchedShareIds()).to.deep.equal(["a-1", "a-2"]);
        clock.tick(1);
        expect(dispatchedShareIds()).to.deep.equal(["a-1", "a-2", "a-3"]);
        worker.emit("message", {action: "validated", data: {shareId: "a-3", isValid: true}});

        expect(await Promise.all([first.promise, second.promise, third.promise])).to.deep.equal([true, true, true]);
      }
      finally {
        await validator.dispose();
        clock.restore();
      }
    });

    it("expires or cancels queued work without restarting unrelated in-flight work", async () => {
      let worker = createFakeValidatorWorker();
      let config = createTestPoWConfig({
        verifyLocalMaxQueue: 4,
        verifyLocalMaxPendingPerSession: 2,
      });
      let validator = new PoWValidator({worker: worker as any});
      worker.emit("message", {action: "init"});
      let longLimits = {...createValidationLimits(config), timeoutMs: 1_000};
      let shortLimits = {...longLimits, timeoutMs: 5};
      let active = validator.tryValidateShare("session-a", createValidationRequest("active", 1, config), longLimits);
      let expiring = validator.tryValidateShare("session-b", createValidationRequest("expiring", 2, config), shortLimits);
      let cancelled = validator.tryValidateShare("session-c", createValidationRequest("cancelled", 3, config), longLimits);
      if(active.kind !== "accepted" || expiring.kind !== "accepted" || cancelled.kind !== "accepted")
        throw new Error("expected all validations to be admitted");
      let expiringResult = expiring.promise.catch((error) => error);
      let cancelledResult = cancelled.promise.catch((error) => error);

      validator.cancelValidation("cancelled", "queued validation cancelled");
      expect(await cancelledResult).to.be.instanceOf(Error).with.property("message", "queued validation cancelled");
      expect(worker.terminate.called).to.equal(false);
      expect(worker.postMessage.getCalls().map((call) => call.args[0].data.shareId)).to.deep.equal(["active"]);

      expect(await expiringResult).to.be.instanceOf(Error).with.property("message", "PoW validation timed out");
      expect(worker.terminate.called).to.equal(false);
      expect(validator.getValidationQueueLength()).to.equal(1);

      worker.emit("message", {action: "validated", data: {shareId: "active", isValid: true}});
      expect(await active.promise).to.equal(true);
      await validator.dispose();
    });

    it("treats the difficulty mask as an exclusive upper bound", async () => {
      let channel = new MessageChannel();
      let worker = new PoWValidatorWorker(channel.port1);
      let nextHash = "0020ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
      let workerState = worker as unknown as {
        hashFn: Record<string, Promise<() => string>>;
      };
      workerState.hashFn[PoWHashAlgo.SCRYPT.toString()] = Promise.resolve(() => nextHash);
      let config = createTestPoWConfig({powDifficulty: 11});

      try {
        let boundaryRequest = createValidationRequest("boundary", 1, config);
        boundaryRequest.preimage = "cHJlaW1hZ2U=";
        let boundaryResult = waitForWorkerValidation(channel.port2, boundaryRequest.shareId);
        channel.port2.postMessage({action: "validate", data: boundaryRequest});
        expect(await boundaryResult).to.equal(false);

        nextHash = "001fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
        let belowRequest = createValidationRequest("below-boundary", 2, config);
        belowRequest.preimage = "cHJlaW1hZ2U=";
        let belowResult = waitForWorkerValidation(channel.port2, belowRequest.shareId);
        channel.port2.postMessage({action: "validate", data: belowRequest});
        expect(await belowResult).to.equal(true);
      }
      finally {
        channel.port1.close();
        channel.port2.close();
      }
    });

    it("cancels all work owned by a validator generation when a session is destroyed", async () => {
      let firstWorker = createFakeValidatorWorker();
      let secondWorker = createFakeValidatorWorker();
      let config = createTestPoWConfig({
        verifyLocalMaxQueue: 2,
        verifyLocalMaxPendingPerSession: 1,
      });
      let validator = new PoWValidator({
        worker: firstWorker as any,
        workerFactory: (() => secondWorker) as any,
      });
      firstWorker.emit("message", {action: "init"});
      let limits = createValidationLimits(config);
      let first = validator.tryValidateShare("closing-session", createValidationRequest("share-1", 1, config), limits);
      let second = validator.tryValidateShare("other-session", createValidationRequest("share-2", 2, config), limits);
      if(first.kind !== "accepted" || second.kind !== "accepted")
        throw new Error("expected both validations to be admitted");
      let firstResult = first.promise.catch((error) => error);
      let secondResult = second.promise.catch((error) => error);

      validator.cancelSession("closing-session", "session destroyed");
      expect(await firstResult).to.be.instanceOf(Error).with.property("message", "session destroyed");
      expect(await secondResult).to.be.instanceOf(Error).with.property("message", "session destroyed");
      expect(firstWorker.terminate.calledOnce).to.equal(true);
      expect(validator.getValidationQueueLength()).to.equal(0);
      await validator.dispose();
    });

    it("binds peer verification to the complete frozen share policy", async () => {
      let localValidation = new PromiseDfd<boolean>();
      let config = createTestPoWConfig({
        powShareReward: 10_000,
        verifyMinerPercent: 100,
        verifyMinerPeerCount: 1,
        verifyMinerIndividuals: 1,
        verifyMinerRewardPerc: 0.29,
        verifyMinerMissPenaltyPerc: 0,
      });
      let currentConfig = config;
      let submitter = {
        preImage: "frozen-preimage",
        activeClient: {sendMessage: sinon.spy()},
        addReward: sinon.stub().callsFake(async (amount: bigint) => amount),
        slashSession: sinon.stub().resolves(),
        getSessionId: () => "submitter",
        getDropAmount: () => 0n,
      } as any;
      let verifier = {
        pendingVerifications: 0,
        missedVerifications: 0,
        activeClient: {sendMessage: sinon.spy()},
        getSessionId: () => "verifier",
        getDropAmount: () => 0n,
        addReward: sinon.stub().callsFake(async (amount: bigint) => amount),
        subPenalty: sinon.stub().resolves(0n),
        slashSession: sinon.stub().resolves(),
      } as any;
      let server = {
        getModuleConfig: () => currentConfig,
        getValidator: () => ({tryValidateShare: () => ({kind: "accepted", promise: localValidation.promise})}),
        getActiveClients: () => [{getPoWSession: () => verifier}],
        getPoWSession: (sessionId: string) => sessionId === "verifier" ? verifier : null,
        getClientPoWParams: (policy: IPoWConfig) => ({
          a: PoWHashAlgo.SCRYPT,
          n: policy.powScryptParams.cpuAndMemory,
          r: policy.powScryptParams.blockSize,
          p: policy.powScryptParams.parallelization,
          l: policy.powScryptParams.keyLength,
        }),
      } as any;

      let verification = new PoWShareVerification(server, submitter, 7, "frozen-data");
      let shareResult = verification.startVerification();
      let verifyRequest = verifier.activeClient.sendMessage.firstCall.args[1];
      expect(verifyRequest.policy.params).to.deep.equal({a: PoWHashAlgo.SCRYPT, n: 4096, r: 8, p: 1, l: 16});
      expect(verifyRequest.policy.difficulty).to.equal(11);

      currentConfig = createTestPoWConfig({
        powShareReward: 1,
        powHashAlgo: PoWHashAlgo.ARGON2,
        powDifficulty: 30,
        verifyMinerRewardPerc: 100,
      });
      expect(await PoWShareVerification.processVerificationResult({
        shareId: verifyRequest.shareId,
        verifierId: "verifier",
        policyId: "wrong-policy",
        isValid: true,
      })).to.equal(0n);

      localValidation.resolve(true);
      expect(await PoWShareVerification.processVerificationResult({
        shareId: verifyRequest.shareId,
        verifierId: "verifier",
        policyId: verifyRequest.policy.id,
        isValid: true,
      })).to.equal(29n);
      expect(verifier.addReward.firstCall.args).to.deep.equal([29n, "verify"]);
      expect((await shareResult).reward).to.equal(10_000n);
    });

    it("gives an invalid peer verdict precedence over the verifier's benign close", async () => {
      let localValidation = new PromiseDfd<boolean>();
      let verifierWorker = {sendSessionAbort: sinon.spy()} as any;
      let verifier = new PoWSession("verifier", verifierWorker);
      verifier.loadSessionData({_balance: "10"});
      verifier.activeClient = {sendMessage: sinon.spy()} as any;
      let submitter = {
        preImage: "preimage",
        activeClient: {sendMessage: sinon.spy()},
        getSessionId: () => "submitter",
        getDropAmount: () => 0n,
        addReward: sinon.stub().callsFake(async (amount: bigint) => amount),
        slashSession: sinon.stub().resolves(),
      } as any;
      let config = createTestPoWConfig({
        verifyMinerPercent: 100,
        verifyMinerPeerCount: 1,
        verifyMinerIndividuals: 1,
        verifyMinerMissPenaltyPerc: 0,
      });
      let server = {
        getModuleConfig: () => config,
        getValidator: () => ({tryValidateShare: () => ({kind: "accepted", promise: localValidation.promise})}),
        getActiveClients: () => [{getPoWSession: () => verifier}],
        getPoWSession: (sessionId: string) => sessionId === "verifier" ? verifier : null,
        getClientPoWParams: () => ({a: PoWHashAlgo.SCRYPT, n: 4096, r: 8, p: 1, l: 16}),
      } as any;
      let verification = new PoWShareVerification(server, submitter, 1, "");
      let shareResult = verification.startVerification();
      let verifyRequest = (verifier.activeClient.sendMessage as sinon.SinonSpy).firstCall.args[1];

      let benignClose = verifier.closeSession("closed");
      expect(verifierWorker.sendSessionAbort.called).to.equal(false);
      let peerVerdict = PoWShareVerification.processVerificationResult({
        shareId: verifyRequest.shareId,
        verifierId: "verifier",
        policyId: verifyRequest.policy.id,
        isValid: false,
      });
      expect(verifierWorker.sendSessionAbort.called).to.equal(false);

      localValidation.resolve(true);
      await awaitSleepPromise(100, () => verifierWorker.sendSessionAbort.calledOnce);
      expect(verifierWorker.sendSessionAbort.firstCall.args.slice(0, 3)).to.deep.equal([
        "verifier",
        "slashed",
        "invalid PoW verification result",
      ]);
      verifier.processSessionClose({status: "failed"});

      expect(await peerVerdict).to.equal(0n);
      expect(await benignClose).to.deep.equal({status: "failed"});
      expect((await shareResult).isValid).to.equal(true);
    });

    it("releases assigned verifier close guards exactly once on response and timeout", async () => {
      let response = createPeerGuardScenario();
      let peerVerdict = PoWShareVerification.processVerificationResult({
        shareId: response.verifyRequest.shareId,
        verifierId: "verifier",
        policyId: response.verifyRequest.policy.id,
        isValid: true,
      });
      expect(response.releaseVerifierGuard.called).to.equal(false);
      response.localValidation.resolve(true);
      expect(await peerVerdict).to.equal(1n);
      expect(await response.result).to.deep.equal({isValid: true, reward: 10n});
      expect(response.releaseVerifierGuard.calledOnce).to.equal(true);
      expect(await PoWShareVerification.processVerificationResult({
        shareId: response.verifyRequest.shareId,
        verifierId: "verifier",
        policyId: response.verifyRequest.policy.id,
        isValid: true,
      })).to.equal(0n);
      expect(response.releaseVerifierGuard.calledOnce).to.equal(true);

      let timeout = createPeerGuardScenario({verifyMinerTimeout: 0.001});
      await awaitSleepPromise(100, () => timeout.releaseVerifierGuard.calledOnce);
      expect(timeout.releaseVerifierGuard.calledOnce).to.equal(true);
      expect(await PoWShareVerification.processVerificationResult({
        shareId: timeout.verifyRequest.shareId,
        verifierId: "verifier",
        policyId: timeout.verifyRequest.policy.id,
        isValid: true,
      })).to.equal(0n);
      expect(timeout.releaseVerifierGuard.calledOnce).to.equal(true);
      timeout.localValidation.resolve(true);
      expect(await timeout.result).to.deep.equal({isValid: true, reward: 10n});
    });

    it("holds the verifier close guard until the exact reward is applied", async () => {
      let rewardSettlement = new PromiseDfd<bigint>();
      let scenario = createPeerGuardScenario();
      scenario.verifier.addReward.resetBehavior();
      scenario.verifier.addReward.returns(rewardSettlement.promise);

      let peerVerdict = PoWShareVerification.processVerificationResult({
        shareId: scenario.verifyRequest.shareId,
        verifierId: "verifier",
        policyId: scenario.verifyRequest.policy.id,
        isValid: true,
      });
      scenario.localValidation.resolve(true);

      await awaitSleepPromise(100, () => scenario.verifier.addReward.calledOnce);
      expect(scenario.verifier.addReward.firstCall.args).to.deep.equal([1n, "verify"]);
      expect(scenario.releaseVerifierGuard.called).to.equal(false);

      expect(await PoWShareVerification.processVerificationResult({
        shareId: scenario.verifyRequest.shareId,
        verifierId: "verifier",
        policyId: scenario.verifyRequest.policy.id,
        isValid: true,
      })).to.equal(0n);
      expect(scenario.releaseVerifierGuard.called).to.equal(false);

      PoWShareVerification.cancelSession(scenario.server, "verifier", "verifier destroyed");
      expect(scenario.releaseVerifierGuard.called).to.equal(false);

      rewardSettlement.resolve(1n);
      expect(await peerVerdict).to.equal(1n);
      expect(scenario.releaseVerifierGuard.calledOnce).to.equal(true);
      expect(await scenario.result).to.deep.equal({isValid: true, reward: 10n});
    });

    it("keeps a benign verifier close pending until reward persistence settles", async () => {
      let localValidation = new PromiseDfd<boolean>();
      let verifierWorker = {
        sendSessionAbort: sinon.spy(),
        sendSessionReward: sinon.spy(),
      } as any;
      let verifier = new PoWSession("verifier", verifierWorker);
      verifier.loadSessionData({_balance: "10"});
      verifier.activeClient = {sendMessage: sinon.spy()} as any;
      let submitter = {
        preImage: "preimage",
        activeClient: {sendMessage: sinon.spy()},
        getSessionId: () => "submitter",
        getDropAmount: () => 0n,
        addReward: sinon.stub().callsFake(async (amount: bigint) => amount),
        slashSession: sinon.stub().resolves(),
      } as any;
      let config = createTestPoWConfig({
        verifyMinerPercent: 100,
        verifyMinerPeerCount: 1,
        verifyMinerIndividuals: 1,
        verifyMinerRewardPerc: 50,
        verifyMinerMissPenaltyPerc: 0,
      });
      let server = {
        getModuleConfig: () => config,
        getValidator: () => ({tryValidateShare: () => ({kind: "accepted", promise: localValidation.promise})}),
        getActiveClients: () => [{getPoWSession: () => verifier}],
        getPoWSession: (sessionId: string) => sessionId === "verifier" ? verifier : null,
        getClientPoWParams: () => ({a: PoWHashAlgo.SCRYPT, n: 4096, r: 8, p: 1, l: 16}),
      } as any;
      let verification = new PoWShareVerification(server, submitter, 1, "");
      let shareResult = verification.startVerification();
      let verifyRequest = (verifier.activeClient.sendMessage as sinon.SinonSpy).firstCall.args[1];

      let benignClose = verifier.closeSession("closed");
      let peerVerdict = PoWShareVerification.processVerificationResult({
        shareId: verifyRequest.shareId,
        verifierId: "verifier",
        policyId: verifyRequest.policy.id,
        isValid: true,
      });
      localValidation.resolve(true);

      await awaitSleepPromise(100, () => verifierWorker.sendSessionReward.calledOnce);
      expect(verifierWorker.sendSessionReward.firstCall.args.slice(0, 4)).to.deep.equal([
        "verifier",
        0,
        5n,
        "verify",
      ]);
      expect(verifierWorker.sendSessionAbort.called).to.equal(false);

      let rewardRequestId = verifierWorker.sendSessionReward.firstCall.args[1];
      verifier.processReward(rewardRequestId, 3n, 13n);
      expect(await peerVerdict).to.equal(3n);
      await awaitSleepPromise(100, () => verifierWorker.sendSessionAbort.calledOnce);
      expect(verifierWorker.sendSessionAbort.firstCall.args.slice(0, 3)).to.deep.equal([
        "verifier",
        "closed",
        "",
      ]);
      verifier.processSessionClose({status: "closed"});
      expect(await benignClose).to.deep.equal({status: "closed"});
      expect(await shareResult).to.deep.equal({isValid: true, reward: 10n});
    });

    it("releases verifier ownership and rejects when reward persistence fails", async () => {
      let scenario = createPeerGuardScenario();
      scenario.verifier.addReward.resetBehavior();
      scenario.verifier.addReward.rejects(new Error("reward persistence failed"));

      let peerVerdict = PoWShareVerification.processVerificationResult({
        shareId: scenario.verifyRequest.shareId,
        verifierId: "verifier",
        policyId: scenario.verifyRequest.policy.id,
        isValid: true,
      }).catch((error) => error);
      scenario.localValidation.resolve(true);

      expect(await peerVerdict).to.be.instanceOf(Error).with.property("message", "reward persistence failed");
      expect(scenario.releaseVerifierGuard.calledOnce).to.equal(true);
      expect(await PoWShareVerification.processVerificationResult({
        shareId: scenario.verifyRequest.shareId,
        verifierId: "verifier",
        policyId: scenario.verifyRequest.policy.id,
        isValid: true,
      })).to.equal(0n);
      expect(scenario.releaseVerifierGuard.calledOnce).to.equal(true);
      expect(await scenario.result).to.deep.equal({isValid: true, reward: 10n});
    });

    it("holds a timed-out verifier's benign close until its miss penalty settles", async () => {
      let localValidation = new PromiseDfd<boolean>();
      let verifierWorker = {
        sendSessionAbort: sinon.spy(),
        sendSessionReward: sinon.spy(),
      } as any;
      let verifier = new PoWSession("verifier", verifierWorker);
      verifier.loadSessionData({_balance: "10"});
      verifier.activeClient = {sendMessage: sinon.spy()} as any;
      let submitter = {
        preImage: "preimage",
        activeClient: {sendMessage: sinon.spy()},
        getSessionId: () => "submitter",
        getDropAmount: () => 0n,
        addReward: sinon.stub().callsFake(async (amount: bigint) => amount),
        slashSession: sinon.stub().resolves(),
      } as any;
      let config = createTestPoWConfig({
        verifyMinerPercent: 100,
        verifyMinerPeerCount: 1,
        verifyMinerIndividuals: 1,
        verifyMinerMissPenaltyPerc: 50,
        verifyMinerTimeout: 0.001,
      });
      let server = {
        getModuleConfig: () => config,
        getValidator: () => ({tryValidateShare: () => ({kind: "accepted", promise: localValidation.promise})}),
        getActiveClients: () => [{getPoWSession: () => verifier}],
        getPoWSession: (sessionId: string) => sessionId === "verifier" ? verifier : null,
        getClientPoWParams: () => ({a: PoWHashAlgo.SCRYPT, n: 4096, r: 8, p: 1, l: 16}),
      } as any;
      let verification = new PoWShareVerification(server, submitter, 1, "");
      let shareResult = verification.startVerification();

      let benignClose = verifier.closeSession("closed");
      expect(verifierWorker.sendSessionAbort.called).to.equal(false);
      await awaitSleepPromise(100, () => verifierWorker.sendSessionReward.calledOnce);
      expect(verifierWorker.sendSessionReward.firstCall.args.slice(0, 4)).to.deep.equal([
        "verifier",
        0,
        -5n,
        "verify",
      ]);
      await Promise.resolve();
      expect(verifierWorker.sendSessionAbort.called).to.equal(false);

      let penaltyRequestId = verifierWorker.sendSessionReward.firstCall.args[1];
      verifier.processReward(penaltyRequestId, -5n, 5n);
      await awaitSleepPromise(100, () => verifierWorker.sendSessionAbort.calledOnce);
      expect(verifier.getDropAmount()).to.equal(5n);
      expect(verifierWorker.sendSessionAbort.firstCall.args.slice(0, 3)).to.deep.equal([
        "verifier",
        "closed",
        "",
      ]);
      verifier.processSessionClose({status: "closed"});
      expect(await benignClose).to.deep.equal({status: "closed"});

      localValidation.resolve(true);
      expect(await shareResult).to.deep.equal({isValid: true, reward: 10n});
    });

    it("releases a timed-out verifier guard exactly once when its miss penalty rejects", async () => {
      let penalty = new PromiseDfd<bigint>();
      let scenario = createPeerGuardScenario({verifyMinerTimeout: 0.001});
      scenario.verifier.subPenalty.resetBehavior();
      scenario.verifier.subPenalty.returns(penalty.promise);

      await awaitSleepPromise(100, () => scenario.verifier.subPenalty.calledOnce);
      expect(scenario.releaseVerifierGuard.called).to.equal(false);
      penalty.reject(new Error("miss penalty failed"));
      await awaitSleepPromise(100, () => scenario.releaseVerifierGuard.calledOnce);
      expect(scenario.releaseVerifierGuard.calledOnce).to.equal(true);

      PoWShareVerification.cancelSession(scenario.server, "verifier", "verifier destroyed");
      expect(scenario.releaseVerifierGuard.calledOnce).to.equal(true);
      scenario.localValidation.resolve(true);
      expect(await scenario.result).to.deep.equal({isValid: true, reward: 10n});
    });

    it("releases assigned verifier close guards exactly once on cancellation and setup failure", async () => {
      let verifierCancellation = createPeerGuardScenario();
      PoWShareVerification.cancelSession(verifierCancellation.server, "verifier", "verifier destroyed");
      PoWShareVerification.cancelSession(verifierCancellation.server, "verifier", "verifier destroyed again");
      expect(verifierCancellation.releaseVerifierGuard.calledOnce).to.equal(true);
      verifierCancellation.localValidation.resolve(true);
      expect(await verifierCancellation.result).to.deep.equal({isValid: true, reward: 10n});

      let shareCancellation = createPeerGuardScenario();
      PoWShareVerification.cancelSession(shareCancellation.server, "submitter", "share cancelled");
      expect(await shareCancellation.result).to.be.instanceOf(Error).with.property("message", "share cancelled");
      PoWShareVerification.cancelAll(shareCancellation.server, "cancelled again");
      expect(shareCancellation.releaseVerifierGuard.calledOnce).to.equal(true);
      shareCancellation.localValidation.resolve(true);

      let sendFailure = new Error("verify dispatch failed");
      let setupFailure = createPeerGuardScenario({}, sinon.stub().throws(sendFailure));
      expect(await setupFailure.result).to.equal(sendFailure);
      expect(setupFailure.cancelValidation.calledOnce).to.equal(true);
      PoWShareVerification.cancelAll(setupFailure.server, "cancelled after setup failure");
      expect(setupFailure.releaseVerifierGuard.calledOnce).to.equal(true);
    });

    it("cancels deferred share settlement when its session is destroyed", async () => {
      let localValidation = new PromiseDfd<boolean>();
      let submitter = {
        preImage: "preimage",
        getSessionId: () => "submitter",
        addReward: sinon.spy(),
      } as any;
      let config = createTestPoWConfig({verifyMinerPercent: 0});
      let server = {
        getModuleConfig: () => config,
        getValidator: () => ({tryValidateShare: () => ({kind: "accepted", promise: localValidation.promise})}),
        getActiveClients: () => [],
        getClientPoWParams: () => ({a: PoWHashAlgo.SCRYPT, n: 4096, r: 8, p: 1, l: 16}),
      } as any;
      let verification = new PoWShareVerification(server, submitter, 1, "");
      let result = verification.startVerification().catch((error) => error);

      PoWShareVerification.cancelSession(server, "submitter", "session destroyed");
      expect(await result).to.be.instanceOf(Error).with.property("message", "session destroyed");
      localValidation.resolve(true);
      await Promise.resolve();
      expect(submitter.addReward.called).to.equal(false);
    });

    it("releases peer-verification ownership when the verifier session is destroyed", async () => {
      let localValidation = new PromiseDfd<boolean>();
      let submitter = {
        preImage: "preimage",
        activeClient: {sendMessage: sinon.spy()},
        getSessionId: () => "submitter",
        getDropAmount: () => 0n,
        addReward: sinon.stub().callsFake(async (amount: bigint) => amount),
        slashSession: sinon.stub().resolves(),
      } as any;
      let verifier = {
        pendingVerifications: 0,
        missedVerifications: 0,
        activeClient: {sendMessage: sinon.spy()},
        getSessionId: () => "verifier",
        getDropAmount: () => 10n,
        subPenalty: sinon.spy(),
      } as any;
      let config = createTestPoWConfig({
        verifyMinerPercent: 100,
        verifyMinerPeerCount: 1,
        verifyMinerIndividuals: 1,
        verifyMinerMissPenaltyPerc: 50,
      });
      let server = {
        getModuleConfig: () => config,
        getValidator: () => ({tryValidateShare: () => ({kind: "accepted", promise: localValidation.promise})}),
        getActiveClients: () => [{getPoWSession: () => verifier}],
        getPoWSession: (sessionId: string) => sessionId === "verifier" ? verifier : null,
        getClientPoWParams: () => ({a: PoWHashAlgo.SCRYPT, n: 4096, r: 8, p: 1, l: 16}),
      } as any;
      let verification = new PoWShareVerification(server, submitter, 1, "");
      let result = verification.startVerification();
      expect(verifier.pendingVerifications).to.equal(1);

      PoWShareVerification.cancelSession(server, "verifier", "verifier destroyed");
      expect(verifier.pendingVerifications).to.equal(0);
      expect(verification.getMinerVerifyCount()).to.equal(0);
      localValidation.resolve(true);
      expect((await result).reward).to.equal(10n);
      expect(verifier.subPenalty.called).to.equal(false);
    });

    it("rejects work when the local validation queue is full", async () => {
      let worker = createFakeValidatorWorker();
      let config = createTestPoWConfig({
        verifyLocalMaxQueue: 2,
        verifyLocalMaxPendingPerSession: 1,
      });
      let server = {
        getModuleConfig: () => config,
        getActiveClients: () => [],
        getPoWSession: () => null,
        getClientPoWParams: () => ({a: PoWHashAlgo.SCRYPT, n: 4096, r: 8, p: 1, l: 16}),
      } as any;
      let validator = new PoWValidator({worker: worker as any});
      server.getValidator = () => validator;

      let limits = createValidationLimits(config);
      expect(validator.tryValidateShare("session-1", createValidationRequest("pre-init", 1, config), limits)).to.deep.equal({
        kind: "rejected",
        reason: "unavailable",
      });
      worker.emit("message", {action: "init"});
      let firstValidation = validator.tryValidateShare("session-1", createValidationRequest("share-1", 1, config), limits);
      expect(firstValidation.kind).to.equal("accepted");
      expect(validator.tryValidateShare("session-1", createValidationRequest("same-session", 2, config), limits)).to.deep.equal({
        kind: "rejected",
        reason: "session-capacity",
      });
      let secondValidation = validator.tryValidateShare("session-2", createValidationRequest("share-2", 2, config), limits);
      expect(secondValidation.kind).to.equal("accepted");
      expect(validator.tryValidateShare("session-3", createValidationRequest("share-3", 3, config), limits)).to.deep.equal({
        kind: "rejected",
        reason: "global-capacity",
      });
      expect(validator.getValidationQueueLength()).to.equal(2);

      let submitter = {
        preImage: "preimage",
        getSessionId: () => "session-3",
        addReward: sinon.spy(),
      } as any;
      let busyVerification = new PoWShareVerification(server, submitter, 2, "");
      let busyError: unknown;
      try {
        await busyVerification.startVerification();
      }
      catch(error) {
        busyError = error;
      }
      expect(busyError).to.be.instanceOf(Error);
      if(busyError instanceof Error)
        expect(busyError.message).to.equal("PoW validation unavailable: global-capacity");
      expect(submitter.addReward.called).to.equal(false);

      expect(worker.postMessage.callCount).to.equal(1);
      worker.emit("message", {
        action: "validated",
        data: {shareId: "share-1", isValid: true},
      });
      if(firstValidation.kind !== "accepted")
        throw new Error("expected first validation to be admitted");
      expect(await firstValidation.promise).to.equal(true);
      expect(worker.postMessage.callCount).to.equal(2);
      expect(validator.getValidationQueueLength()).to.equal(1);
      let thirdValidation = validator.tryValidateShare("session-3", createValidationRequest("share-3", 3, config), limits);
      if(secondValidation.kind !== "accepted" || thirdValidation.kind !== "accepted")
        throw new Error("expected remaining validations to be admitted");
      worker.emit("message", {action: "validated", data: {shareId: "share-2", isValid: true}});
      worker.emit("message", {action: "validated", data: {shareId: "share-3", isValid: true}});
      expect(await secondValidation.promise).to.equal(true);
      expect(await thirdValidation.promise).to.equal(true);

      await validator.dispose();
    });

    it("does not settle or reward a share when peer telemetry times out", async () => {
      let localValidation = new PromiseDfd<boolean>();
      let submitterBalance = 0n;
      let submitter = {
        preImage: "preimage",
        activeClient: {sendMessage: sinon.spy()},
        addReward: sinon.stub().callsFake(async (amount: bigint) => {
          submitterBalance += amount;
          return amount;
        }),
        slashSession: sinon.stub().resolves(),
        getSessionId: () => "submitter",
        getDropAmount: () => submitterBalance,
      } as any;
      let verifier = {
        pendingVerifications: 0,
        missedVerifications: 0,
        activeClient: {sendMessage: sinon.spy()},
        getSessionId: () => "verifier",
        getDropAmount: () => 0n,
        subPenalty: sinon.stub().resolves(0n),
        slashSession: sinon.stub().resolves(),
      } as any;
      let config = createTestPoWConfig({
        verifyMinerPercent: 100,
        verifyMinerPeerCount: 1,
        verifyMinerIndividuals: 1,
        verifyMinerMaxPending: 5,
        verifyMinerMaxMissed: 5,
        verifyMinerMissPenaltyPerc: 0,
        verifyMinerTimeout: 0.001,
      });
      let server = {
        getModuleConfig: () => config,
        getValidator: () => ({tryValidateShare: () => ({kind: "accepted", promise: localValidation.promise})}),
        getActiveClients: () => [{getPoWSession: () => verifier}],
        getPoWSession: (sessionId: string) => sessionId === "verifier" ? verifier : null,
        getClientPoWParams: () => ({a: PoWHashAlgo.SCRYPT, n: 4096, r: 8, p: 1, l: 16}),
      } as any;

      let verification = new PoWShareVerification(server, submitter, 1, "");
      let resultPromise = verification.startVerification();
      let verifyMessage = verifier.activeClient.sendMessage.firstCall.args[1];
      await awaitSleepPromise(20, () => verifier.subPenalty.called);

      expect(submitter.addReward.called).to.equal(false);
      expect(verifier.subPenalty.calledOnce).to.equal(true);
      expect(await PoWShareVerification.processVerificationResult({
        shareId: verifyMessage.shareId,
        verifierId: "verifier",
        policyId: verifyMessage.policy.id,
        isValid: true,
      })).to.equal(0n);

      localValidation.resolve(true);
      let result = await resultPromise;
      expect(result.isValid).to.equal(true);
      expect(result.reward).to.equal(10n);
      expect(submitter.addReward.calledOnce).to.equal(true);
    });
  });

  describe("Mining websocket protocol", () => {

    it("rearms the idle timeout when a mining client disconnects", async () => {
      faucetConfig.modules["pow"] = createTestPoWConfig({powIdleTimeout: 0.05});
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
      let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");

      fakeSocket.emit("close");
      await awaitSleepPromise(500, () => testSession.getSessionStatus() !== "running");
      expect(testSession.getSessionStatus()).not.to.equal("running");
    });

    it("returns one correlated error when verification settlement fails", async () => {
      faucetConfig.modules["pow"] = createTestPoWConfig();
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
      let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");
      let verificationStub = sinon.stub(PoWShareVerification, "processVerificationResult").rejects(new Error("verification failure"));
      try {
        fakeSocket.emit("message", JSON.stringify({
          id: 71,
          action: "verifyResult",
          data: {shareId: "share", policyId: "policy", isValid: true},
        }));
        await awaitSleepPromise(100, () => fakeSocket.getSentMessage("error").length > 0);
        let responses = fakeSocket.getSentMessage().filter((message) => message.rsp === 71);
        expect(responses).to.have.length(1);
        expect(responses[0].action).to.equal("error");
        expect(responses[0].data.code).to.equal("VERIFY_FAILED");
        expect(fakeSocket.isReady).to.equal(true);
      }
      finally {
        verificationStub.restore();
      }
    });

    it("acknowledges settled zero-reward, late, and duplicate verification results", async () => {
      faucetConfig.modules["pow"] = createTestPoWConfig();
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
      let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");
      let settlement = new PromiseDfd<bigint>();
      let verificationStub = sinon.stub(PoWShareVerification, "processVerificationResult");
      verificationStub.onFirstCall().returns(settlement.promise);
      verificationStub.onSecondCall().resolves(0n);
      verificationStub.onThirdCall().resolves(0n);
      try {
        let verificationData = {shareId: "share", policyId: "policy", isValid: true};
        fakeSocket.emit("message", JSON.stringify({
          id: 72,
          action: "verifyResult",
          data: verificationData,
        }));
        await Promise.resolve();
        expect(fakeSocket.getSentMessage().some((message) => message.rsp === 72)).to.equal(false);

        settlement.resolve(0n);
        await awaitSleepPromise(100, () => fakeSocket.getSentMessage().some((message) => message.rsp === 72));

        fakeSocket.emit("message", JSON.stringify({id: 73, action: "verifyResult", data: verificationData}));
        fakeSocket.emit("message", JSON.stringify({id: 74, action: "verifyResult", data: verificationData}));
        await awaitSleepPromise(100, () => [72, 73, 74].every((id) =>
          fakeSocket.getSentMessage().some((message) => message.rsp === id)
        ));

        for(let id of [72, 73, 74]) {
          let responses = fakeSocket.getSentMessage().filter((message) => message.rsp === id);
          expect(responses).to.have.length(1);
          expect(responses[0].action).to.equal("ok");
        }
        expect(fakeSocket.getSentMessage("updateBalance")).to.have.length(0);
      }
      finally {
        verificationStub.restore();
      }
    });

    it("correlates malformed verification errors when the request has an id", async () => {
      faucetConfig.modules["pow"] = createTestPoWConfig();
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
      let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");

      fakeSocket.emit("message", JSON.stringify({id: 75, action: "verifyResult", data: null}));
      fakeSocket.emit("message", JSON.stringify({
        id: 76,
        action: "verifyResult",
        data: {shareId: "share", policyId: "policy", isValid: "yes"},
      }));
      await awaitSleepPromise(100, () => [75, 76].every((id) =>
        fakeSocket.getSentMessage("error").some((message) => message.rsp === id)
      ));

      for(let id of [75, 76]) {
        let responses = fakeSocket.getSentMessage().filter((message) => message.rsp === id);
        expect(responses).to.have.length(1);
        expect(responses[0].action).to.equal("error");
        expect(responses[0].data.code).to.equal("INVALID_VERIFYRESULT");
      }
    });

    it("check ping timeout handling", async () => {
      faucetConfig.modules["pow"] = {
        enabled: true,
        powPingInterval: 1,
        powPingTimeout: 2,
      } as IPoWConfig;
      globalStubs["FakeWebSocket.ping"] = sinon.stub(FakeWebSocket.prototype, "ping");
      globalStubs["FakeWebSocket.pong"] = sinon.stub(FakeWebSocket.prototype, "pong");
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
      expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
      let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");
      fakeSocket.emit("pong");
      fakeSocket.emit("ping");
      expect(globalStubs["FakeWebSocket.pong"].called).to.equal(true, "pong not called");
      expect(globalStubs["FakeWebSocket.ping"].called).to.equal(false, "unexpected ping call");
      await awaitSleepPromise(1100, () => globalStubs["FakeWebSocket.ping"].called);
      expect(fakeSocket.isReady).to.equal(true, "client not ready");
      expect(globalStubs["FakeWebSocket.ping"].called).to.equal(true, "ping not called");
      expect(fakeSocket.isReady).to.equal(true, "unexpected close call");
      await awaitSleepPromise(3000, () => !fakeSocket.isReady);
      expect(fakeSocket.isReady).to.equal(false, "client is still ready");
    }).timeout(5000);

    it("check invalid message handling", async () => {
      faucetConfig.modules["pow"] = {
        enabled: true,
      } as IPoWConfig;
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
      expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
      let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");
      fakeSocket.emit("message", "invalid stuff (not json)");
      //expect(fakeSocket.isReady).to.equal(false, "client is still ready");
      let errorMsg = fakeSocket.getSentMessage("error");
      expect(errorMsg.length).to.equal(1, "no error message sent");
      expect(errorMsg[0].data.code).to.equal("CLIENT_KILLED", "unexpected error code");
    });

    it("check unknown action handling", async () => {
      faucetConfig.modules["pow"] = {
        enabled: true,
      } as IPoWConfig;
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
      expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
      let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");
      fakeSocket.emit("message", JSON.stringify({
        id: 42,
        action: "unknownAction"
      }))
      expect(fakeSocket.isReady).to.equal(true, "client is not ready");
      let errorMsg = fakeSocket.getSentMessage("error");
      expect(errorMsg.length).to.equal(1, "no error message sent");
      expect(errorMsg[0].rsp).to.equal(42, "invalid response id");
      expect(errorMsg[0].data.code).to.equal("INVALID_ACTION", "unexpected error code");
    });

    it("check action 'foundShare': invalid share data", async () => {
      faucetConfig.modules["pow"] = {
        enabled: true,
      } as IPoWConfig;
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
      expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
      let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");
      fakeSocket.emit("message", JSON.stringify({
        id: 42,
        action: "foundShare",
      }))
      expect(fakeSocket.isReady).to.equal(true, "client is not ready");
      let errorMsg = fakeSocket.getSentMessage("error");
      expect(errorMsg.length).to.equal(1, "no error message sent");
      expect(errorMsg[0].rsp).to.equal(42, "invalid response id");
      expect(errorMsg[0].data.code).to.equal("INVALID_SHARE", "unexpected error code");
      expect(errorMsg[0].data.message).to.equal("Invalid share data", "unexpected error message");
    });

    it("check action 'foundShare': invalid share params", async () => {
      faucetConfig.modules["pow"] = {
        enabled: true,
        powHashAlgo: PoWHashAlgo.SCRYPT,
        powScryptParams: {
          cpuAndMemory: 4096,
          blockSize: 8,
          parallelization: 1,
          keyLength: 16,
        },
        powDifficulty: 11,
      } as IPoWConfig;
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
      expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
      let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");
      fakeSocket.emit("message", JSON.stringify({
        id: 42,
        action: "foundShare",
        data: {
          nonce: 1337,
          params: "invalid_params_str",
          hashrate: 12,
        }
      }))
      expect(fakeSocket.isReady).to.equal(true, "client is not ready");
      let errorMsg = fakeSocket.getSentMessage("error");
      expect(errorMsg.length).to.equal(1, "no error message sent");
      expect(errorMsg[0].rsp).to.equal(42, "invalid response id");
      expect(errorMsg[0].data.code).to.equal("INVALID_SHARE", "unexpected error code");
      expect(errorMsg[0].data.message).to.equal("Invalid share params", "unexpected error message");
    });

    it("check action 'foundShare': rejects malformed nonces without consuming nonce state", async () => {
      faucetConfig.modules["pow"] = createTestPoWConfig();
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      }, {
        "pow.preimage": "oXwNMIuRUOc=",
      });
      let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");

      let invalidNonces: unknown[] = ["5f4", -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null];
      invalidNonces.forEach((nonce, index) => {
        fakeSocket.emit("message", JSON.stringify({
          id: 40 + index,
          action: "foundShare",
          data: {
            nonce,
            params: "scrypt|4096|8|1|16|11",
            hashrate: 12,
          }
        }));
      });

      let errorMessages = fakeSocket.getSentMessage("error");
      expect(errorMessages.length).to.equal(invalidNonces.length);
      errorMessages.forEach((message) => {
        expect(message.data.code).to.equal("INVALID_SHARE");
        expect(message.data.message).to.equal("Invalid nonce");
      });

      let okReady = fakeSocket.waitForSentMessageCount("ok", 1);
      fakeSocket.emit("message", JSON.stringify({
        id: 50,
        action: "foundShare",
        data: {
          nonce: 1524,
          params: "scrypt|4096|8|1|16|11",
          hashrate: 12,
        }
      }));
      await okReady;
      await new Promise<void>((resolve) => setImmediate(resolve));
      let okMessages = fakeSocket.getSentMessage("ok");
      expect(okMessages).to.have.length(1);
      expect(okMessages[0].rsp).to.equal(50);
    });

    it("check action 'foundShare': ignores untrusted hashrate outliers", async () => {
      faucetConfig.modules["pow"] = createTestPoWConfig();
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let sessionManager = ServiceManager.GetService(SessionManager);
      let testCases = [
        {ip: "::ffff:8.8.8.8", address: "0x0000000000000000000000000000000000001337", hashrate: -1},
        {ip: "::ffff:8.8.4.4", address: "0x0000000000000000000000000000000000001338", hashrate: 1e300},
      ];

      for(let testCase of testCases) {
        let session = await sessionManager.createSession(testCase.ip, {
          addr: testCase.address,
        }, {
          "pow.preimage": "oXwNMIuRUOc=",
        });
        let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + session.getSessionId(), testCase.ip);
        fakeSocket.emit("message", JSON.stringify({
          action: "foundShare",
          data: {
            nonce: 1524,
            params: "scrypt|4096|8|1|16|11",
            hashrate: testCase.hashrate,
          }
        }));
        await awaitSleepPromise(1000, () => session.getDropAmount() > 0n);
        expect(session.getDropAmount()).to.equal(10n);
        expect(session.getSessionData("pow.hashrate")).to.equal(0);
      }
    });

    it("check action 'foundShare': nonce too low", async () => {
      faucetConfig.modules["pow"] = {
        enabled: true,
        powHashAlgo: PoWHashAlgo.SCRYPT,
        powScryptParams: {
          cpuAndMemory: 4096,
          blockSize: 8,
          parallelization: 1,
          keyLength: 16,
        },
        powDifficulty: 11,
      } as IPoWConfig;
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      }, {
        "pow.lastNonce": 1337,
      });
      expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
      let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");
      fakeSocket.emit("message", JSON.stringify({
        id: 42,
        action: "foundShare",
        data: {
          nonce: 1337,
          params: "scrypt|4096|8|1|16|11",
          hashrate: 12,
        }
      }))
      expect(fakeSocket.isReady).to.equal(true, "client is not ready");
      let errorMsg = fakeSocket.getSentMessage("error");
      expect(errorMsg.length).to.equal(1, "no error message sent");
      expect(errorMsg[0].rsp).to.equal(42, "invalid response id");
      expect(errorMsg[0].data.code).to.equal("INVALID_SHARE", "unexpected error code");
      expect(errorMsg[0].data.message).to.matches(/Nonce too low/i, "unexpected error message");
    });

    it("check action 'foundShare': nonce too high", async () => {
      faucetConfig.modules["pow"] = {
        enabled: true,
        powHashAlgo: PoWHashAlgo.SCRYPT,
        powScryptParams: {
          cpuAndMemory: 4096,
          blockSize: 8,
          parallelization: 1,
          keyLength: 16,
        },
        powDifficulty: 11,
        powHashrateHardLimit: 100,
      } as IPoWConfig;
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      }, {
        "pow.preimage": "oXwNMIuRUOc=",
      });
      expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
      let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");
      fakeSocket.emit("message", JSON.stringify({
        id: 42,
        action: "foundShare",
        data: {
          nonce: 133700,
          params: "scrypt|4096|8|1|16|11",
          hashrate: 12,
        }
      }))
      expect(fakeSocket.isReady).to.equal(true, "client is not ready");
      let errorMsg = fakeSocket.getSentMessage("error");
      expect(errorMsg.length).to.equal(1, "no error message sent");
      expect(errorMsg[0].rsp).to.equal(42, "invalid response id");
      expect(errorMsg[0].data.code).to.equal("HASHRATE_LIMIT", "unexpected error code");
      expect(errorMsg[0].data.message).to.matches(/Nonce too high/i, "unexpected error message");

      let okReady = fakeSocket.waitForSentMessageCount("ok", 1);
      fakeSocket.emit("message", JSON.stringify({
        id: 43,
        action: "foundShare",
        data: {
          nonce: 1524,
          params: "scrypt|4096|8|1|16|11",
          hashrate: 12,
        }
      }));
      await okReady;
      await new Promise<void>((resolve) => setImmediate(resolve));
      let okMessages = fakeSocket.getSentMessage("ok");
      expect(okMessages).to.have.length(1);
      expect(okMessages[0].rsp).to.equal(43);
    });

    it("check action 'foundShare': valid share, local verification, scrypt", async () => {
      faucetConfig.modules["pow"] = {
        enabled: true,
        powShareReward: 10,
        powHashAlgo: PoWHashAlgo.SCRYPT,
        powScryptParams: {
          cpuAndMemory: 4096,
          blockSize: 8,
          parallelization: 1,
          keyLength: 16,
        },
        powDifficulty: 11,
        powHashrateHardLimit: 100,
        verifyLocalLowPeerPercent: 100,
      } as IPoWConfig;
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      }, {
        "pow.preimage": "oXwNMIuRUOc=",
      });
      expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
      let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");
      let okReady = fakeSocket.waitForSentMessageCount("ok", 1);
      fakeSocket.emit("message", JSON.stringify({
        id: 42,
        action: "foundShare",
        data: {
          nonce: 1524,
          params: "scrypt|4096|8|1|16|11",
          hashrate: 12,
        }
      }))
      expect(fakeSocket.isReady).to.equal(true, "client is not ready");
      await okReady;
      await new Promise<void>((resolve) => setImmediate(resolve));
      let okMsg = fakeSocket.getSentMessage("ok");
      expect(okMsg.length).to.equal(1, "no ok message sent");
      expect(okMsg[0].rsp).to.equal(42, "invalid response id");
      let balanceMsg = fakeSocket.getSentMessage("updateBalance");
      expect(balanceMsg.length).to.equal(1, "no updateBalance message sent");
      expect(balanceMsg[0].data.balance).to.equal("10", "invalid updateBalance message: unexpected balance");
      expect(balanceMsg[0].data.reason).to.matches(/valid share/, "invalid updateBalance message: unexpected reason");
    });

    it("check action 'foundShare': invalid share, local verification, scrypt", async () => {
      faucetConfig.modules["pow"] = {
        enabled: true,
        powHashAlgo: PoWHashAlgo.SCRYPT,
        powScryptParams: {
          cpuAndMemory: 4096,
          blockSize: 8,
          parallelization: 1,
          keyLength: 16,
        },
        powDifficulty: 11,
        powHashrateHardLimit: 100,
        verifyLocalLowPeerPercent: 100,
      } as IPoWConfig;
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      }, {
        "pow.preimage": "oXwNMIuRUOc=",
      });
      expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
      let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");
      let terminalErrorsReady = fakeSocket.waitForSentMessageCount("error", 2);
      fakeSocket.emit("message", JSON.stringify({
        id: 42,
        action: "foundShare",
        data: {
          nonce: 1526,
          params: "scrypt|4096|8|1|16|11",
          hashrate: 12,
        }
      }))
      expect(fakeSocket.isReady).to.equal(true, "client is not ready");
      await terminalErrorsReady;
      await awaitSleepPromise(100, () => !fakeSocket.isReady);
      expect(fakeSocket.isReady).to.equal(false, "invalid-share client remained connected");
      await new Promise<void>((resolve) => setImmediate(resolve));
      let errorMsg = fakeSocket.getSentMessage("error");
      expect(errorMsg.length).to.equal(2, "unexpected number of error messages sent");
      expect(errorMsg[0].rsp).to.equal(42, "invalid response id");
      expect(errorMsg[0].data.code).to.equal("WRONG_SHARE", "unexpected error1 code");
      expect(errorMsg[0].data.message).to.matches(/verification failed/i, "unexpected error1 message");
      expect(errorMsg[1].data.code).to.equal("CLIENT_KILLED", "unexpected error2 code");
      expect(errorMsg[1].data.message).to.matches(/session failed/i, "unexpected error2 message");
      expect(testSession.getSessionStatus()).to.equal("failed", "invalid share did not fail the session");
      expect((await testSession.getSessionInfo()).failedCode).to.equal("SLASHED");
      expect(testSession.getDropAmount()).to.equal(0n, "unexpected drop amount");
    });

    it("forfeits the balance when an invalid share races a benign close", async () => {
      let validationGate = new PromiseDfd<void>();
      let invalidValidationStarted = new PromiseDfd<void>();
      let benignCloseStarted = new PromiseDfd<void>();
      let validateStub;
      let closeSessionStub;
      let sendSessionAbortSpy;
      let awaitSignal = <T>(signal: Promise<T>, description: string, timeoutMs = 2_000): Promise<T> => {
        return new Promise((resolve, reject) => {
          let timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs);
          signal.then((value) => {
            clearTimeout(timeout);
            resolve(value);
          }, (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });
      };

      try {
        let originalValidate = (PoWValidatorWorker.prototype as any).onCtrlValidate;
        validateStub = sinon.stub(PoWValidatorWorker.prototype as any, "onCtrlValidate").callsFake(
          async function(this: PoWValidatorWorker, request: IPoWValidatorValidateRequest) {
            if(request.nonce === 1526) {
              invalidValidationStarted.resolve();
              await validationGate.promise;
            }
            return originalValidate.call(this, request);
          },
        );
        let originalCloseSession = PoWSession.prototype.closeSession;
        closeSessionStub = sinon.stub(PoWSession.prototype, "closeSession").callsFake(
          function(this: PoWSession, type?: string, reason?: string) {
            let closeResult = originalCloseSession.call(this, type, reason);
            if((type || "closed") === "closed")
              benignCloseStarted.resolve();
            return closeResult;
          },
        );
        sendSessionAbortSpy = sinon.spy(PoWServerWorker.prototype, "sendSessionAbort");

        faucetConfig.modules["pow"] = createTestPoWConfig({
          powShareReward: 10,
          powHashrateHardLimit: 100,
          verifyMinerPercent: 0,
        });
        let moduleManager = ServiceManager.GetService(ModuleManager);
        await moduleManager.initialize();
        let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
          addr: "0x0000000000000000000000000000000000001337",
        }, {
          "pow.preimage": "oXwNMIuRUOc=",
        });
        expect(await testSession.addReward(10n)).to.equal(10n);
        expect(testSession.getDropAmount()).to.equal(10n);
        let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");

        fakeSocket.emit("message", JSON.stringify({
          id: 42,
          action: "foundShare",
          data: {
            nonce: 1526,
            params: "scrypt|4096|8|1|16|11",
            hashrate: 12,
          },
        }));
        await awaitSignal(invalidValidationStarted.promise, "invalid-share validation");
        fakeSocket.emit("message", JSON.stringify({id: 43, action: "closeSession"}));
        await awaitSignal(benignCloseStarted.promise, "benign close admission");

        expect(testSession.getSessionStatus()).to.equal("running");
        expect(testSession.getDropAmount()).to.equal(10n);
        expect(fakeSocket.getSentMessage("ok").some((message) => message.rsp === 43)).to.equal(false);
        expect(sendSessionAbortSpy.getCalls().some((call) => (
          call.args[0] === testSession.getSessionId() && call.args[1] === "closed"
        ))).to.equal(false, "benign close escaped its security-decision guard");

        let terminalErrorsReady = fakeSocket.waitForSentMessageCount("error", 2, 3_000);
        validationGate.resolve();
        await terminalErrorsReady;
        let sessionAbortCalls = sendSessionAbortSpy.getCalls().filter((call) => call.args[0] === testSession.getSessionId());
        expect(sessionAbortCalls.filter((call) => call.args[1] === "slashed")).to.have.length(1);
        expect(sessionAbortCalls.some((call) => call.args[1] === "closed")).to.equal(false);
        expect({
          status: testSession.getSessionStatus(),
          balance: testSession.getDropAmount(),
          failure: testSession.getSessionData("failed.code"),
        }).to.deep.equal({status: "failed", balance: 0n, failure: "SLASHED"});
      }
      finally {
        validationGate.resolve();
        validateStub?.restore();
        closeSessionStub?.restore();
        sendSessionAbortSpy?.restore();
      }
    }).timeout(10_000);

    it("check action 'foundShare': valid share, local verification, cryptonight", async () => {
      faucetConfig.modules["pow"] = {
        enabled: true,
        powShareReward: 10,
        powHashAlgo: PoWHashAlgo.CRYPTONIGHT,
        powCryptoNightParams: {
          algo: 0,
          variant: 0,
          height: 0,
        },
        powDifficulty: 11,
        powHashrateHardLimit: 100,
        verifyLocalLowPeerPercent: 100,
      } as IPoWConfig;
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      }, {
        "pow.preimage": "2TobvsN38W8=",
      });
      expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
      let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");
      let okReady = fakeSocket.waitForSentMessageCount("ok", 1);
      fakeSocket.emit("message", JSON.stringify({
        id: 42,
        action: "foundShare",
        data: {
          nonce: 1944,
          params: "cryptonight|0|0|0|11",
          hashrate: 12,
        }
      }))
      expect(fakeSocket.isReady).to.equal(true, "client is not ready");
      await okReady;
      await new Promise<void>((resolve) => setImmediate(resolve));
      let okMsg = fakeSocket.getSentMessage("ok");
      expect(okMsg.length).to.equal(1, "no ok message sent");
      expect(okMsg[0].rsp).to.equal(42, "invalid response id");
      let balanceMsg = fakeSocket.getSentMessage("updateBalance");
      expect(balanceMsg.length).to.equal(1, "no updateBalance message sent");
      expect(balanceMsg[0].data.balance).to.equal("10", "invalid updateBalance message: unexpected balance");
      expect(balanceMsg[0].data.reason).to.matches(/valid share/, "invalid updateBalance message: unexpected reason");
    });

    it("check action 'foundShare': invalid share, local verification, cryptonight", async () => {
      faucetConfig.modules["pow"] = {
        enabled: true,
        powHashAlgo: PoWHashAlgo.CRYPTONIGHT,
        powCryptoNightParams: {
          algo: 0,
          variant: 0,
          height: 0,
        },
        powDifficulty: 11,
        powHashrateHardLimit: 100,
        verifyLocalLowPeerPercent: 100,
      } as IPoWConfig;
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      }, {
        "pow.preimage": "oXwNMIuRUOc=",
      });
      expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
      let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");
      let terminalErrorsReady = fakeSocket.waitForSentMessageCount("error", 2);
      fakeSocket.emit("message", JSON.stringify({
        id: 42,
        action: "foundShare",
        data: {
          nonce: 1526,
          params: "cryptonight|0|0|0|11",
          hashrate: 12,
        }
      }))
      expect(fakeSocket.isReady).to.equal(true, "client is not ready");
      await terminalErrorsReady;
      await awaitSleepPromise(100, () => !fakeSocket.isReady);
      expect(fakeSocket.isReady).to.equal(false, "invalid-share client remained connected");
      await new Promise<void>((resolve) => setImmediate(resolve));
      let errorMsg = fakeSocket.getSentMessage("error");
      expect(errorMsg.length).to.equal(2, "unexpected number of error messages sent");
      expect(errorMsg[0].rsp).to.equal(42, "invalid response id");
      expect(errorMsg[0].data.code).to.equal("WRONG_SHARE", "unexpected error1 code");
      expect(errorMsg[0].data.message).to.matches(/verification failed/i, "unexpected error1 message");
      expect(errorMsg[1].data.code).to.equal("CLIENT_KILLED", "unexpected error2 code");
      expect(errorMsg[1].data.message).to.matches(/session failed/i, "unexpected error2 message");
      expect(testSession.getDropAmount()).to.equal(0n, "unexpected drop amount");
    });

    it("check action 'foundShare': valid share, local verification, argon2", async () => {
      faucetConfig.modules["pow"] = {
        enabled: true,
        powShareReward: 10,
        powHashAlgo: PoWHashAlgo.ARGON2,
        powArgon2Params: {
          type: 0,
          version: 13,
          timeCost: 4,
          memoryCost: 4096,
          parallelization: 1,
          keyLength: 16,
        },
        powDifficulty: 11,
        powHashrateHardLimit: 100,
        verifyLocalLowPeerPercent: 100,
      } as IPoWConfig;
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      }, {
        "pow.preimage": "2TobvsN38W8=",
      });
      expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
      let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");
      let okReady = fakeSocket.waitForSentMessageCount("ok", 1);
      fakeSocket.emit("message", JSON.stringify({
        id: 42,
        action: "foundShare",
        data: {
          nonce: 2034,
          params: "argon2|0|13|4|4096|1|16|11",
          hashrate: 12,
        }
      }))
      expect(fakeSocket.isReady).to.equal(true, "client is not ready");
      await okReady;
      await new Promise<void>((resolve) => setImmediate(resolve));
      let okMsg = fakeSocket.getSentMessage("ok");
      expect(okMsg.length).to.equal(1, "no ok message sent");
      expect(okMsg[0].rsp).to.equal(42, "invalid response id");
      let balanceMsg = fakeSocket.getSentMessage("updateBalance");
      expect(balanceMsg.length).to.equal(1, "no updateBalance message sent");
      expect(balanceMsg[0].data.balance).to.equal("10", "invalid updateBalance message: unexpected balance");
      expect(balanceMsg[0].data.reason).to.matches(/valid share/, "invalid updateBalance message: unexpected reason");
    });

    it("check action 'foundShare': invalid share, local verification, argon2", async () => {
      faucetConfig.modules["pow"] = {
        enabled: true,
        powHashAlgo: PoWHashAlgo.ARGON2,
        powArgon2Params: {
          type: 0,
          version: 13,
          timeCost: 4,
          memoryCost: 4096,
          parallelization: 1,
          keyLength: 16,
        },
        powDifficulty: 11,
        powHashrateHardLimit: 100,
        verifyLocalLowPeerPercent: 100,
      } as IPoWConfig;
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      }, {
        "pow.preimage": "oXwNMIuRUOc=",
      });
      expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
      let fakeSocket = await injectFakeWebSocket("/ws/pow?session=" + testSession.getSessionId(), "8.8.8.8");
      let terminalErrorsReady = fakeSocket.waitForSentMessageCount("error", 2);
      fakeSocket.emit("message", JSON.stringify({
        id: 42,
        action: "foundShare",
        data: {
          nonce: 1526,
          params: "argon2|0|13|4|4096|1|16|11",
          hashrate: 12,
        }
      }))
      expect(fakeSocket.isReady).to.equal(true, "client is not ready");
      await terminalErrorsReady;
      await awaitSleepPromise(100, () => !fakeSocket.isReady);
      expect(fakeSocket.isReady).to.equal(false, "invalid-share client remained connected");
      await new Promise<void>((resolve) => setImmediate(resolve));
      let errorMsg = fakeSocket.getSentMessage("error");
      expect(errorMsg.length).to.equal(2, "unexpected number of error messages sent");
      expect(errorMsg[0].rsp).to.equal(42, "invalid response id");
      expect(errorMsg[0].data.code).to.equal("WRONG_SHARE", "unexpected error1 code");
      expect(errorMsg[0].data.message).to.matches(/verification failed/i, "unexpected error1 message");
      expect(errorMsg[1].data.code).to.equal("CLIENT_KILLED", "unexpected error2 code");
      expect(errorMsg[1].data.message).to.matches(/session failed/i, "unexpected error2 message");
      expect(testSession.getDropAmount()).to.equal(0n, "unexpected drop amount");
    });

    it("check action 'verifyResult': peer approval cannot authorize invalid work", async () => {
      faucetConfig.modules["pow"] = createTestPoWConfig({
        verifyLocalPercent: 0,
        verifyLocalLowPeerPercent: 0,
        verifyMinerIndividuals: 1,
        verifyMinerPeerCount: 1,
        verifyMinerPercent: 100,
        verifyMinerRewardPerc: 50,
        verifyMinerMissPenaltyPerc: 0,
      });
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let sessionManager = ServiceManager.GetService(SessionManager);
      let submitter = await sessionManager.createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      }, {
        "pow.preimage": "oXwNMIuRUOc=",
      });
      let submitterSocket = await injectFakeWebSocket("/ws/pow?session=" + submitter.getSessionId(), "8.8.8.8");
      let verifier = await sessionManager.createSession("::ffff:8.8.4.4", {
        addr: "0x0000000000000000000000000000000000001338",
      });
      let verifierSocket = await injectFakeWebSocket("/ws/pow?session=" + verifier.getSessionId(), "8.8.4.4");

      submitterSocket.emit("message", JSON.stringify({
        id: 42,
        action: "foundShare",
        data: {
          nonce: 1526,
          params: "scrypt|4096|8|1|16|11",
          hashrate: 12,
        }
      }));
      await awaitSleepPromise(1000, () => verifierSocket.getSentMessage("verify").length > 0);
      let verifyMessage = verifierSocket.getSentMessage("verify")[0];
      verifierSocket.emit("message", JSON.stringify({
        id: 43,
        action: "verifyResult",
        data: {
          shareId: verifyMessage.data.shareId,
          policyId: verifyMessage.data.policy.id,
          isValid: true,
        }
      }));

      await awaitSleepPromise(1000, () => !submitterSocket.isReady);
      expect(submitter.getDropAmount()).to.equal(0n);
      expect(submitterSocket.getSentMessage("ok").length).to.equal(0);
      expect(submitterSocket.getSentMessage("error").some((message) => message.data.code === "WRONG_SHARE")).to.equal(true);
      await awaitSleepPromise(1000, () => !verifierSocket.isReady);
      expect(verifier.getDropAmount()).to.equal(0n);
      expect(verifierSocket.getSentMessage("updateBalance").length).to.equal(0);
      let verifierResponses = verifierSocket.getSentMessage().filter((message) => message.rsp === 43);
      expect(verifierResponses).to.have.length(1);
      expect(verifierResponses[0].action).to.equal("ok");
    }).timeout(5000);

    it("check action 'verifyResult': valid share verification", async () => {
      faucetConfig.modules["pow"] = {
        enabled: true,
        powShareReward: 10,
        powHashAlgo: PoWHashAlgo.SCRYPT,
        powScryptParams: {
          cpuAndMemory: 4096,
          blockSize: 8,
          parallelization: 1,
          keyLength: 16,
        },
        powDifficulty: 11,
        powHashrateHardLimit: 100,
        verifyMinerIndividuals: 1,
        verifyMinerPeerCount: 1,
        verifyMinerPercent: 100,
        verifyMinerRewardPerc: 50,
        verifyMinerMissPenaltyPerc: 0,
      } as IPoWConfig;
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession1 = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      }, {
        "pow.preimage": "oXwNMIuRUOc=",
      });
      let fakeSocket1 = await injectFakeWebSocket("/ws/pow?session=" + testSession1.getSessionId(), "8.8.8.8");
      expect(testSession1.getSessionStatus()).to.equal("running", "unexpected session status");
      let testSession2 = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.4.4", {
        addr: "0x0000000000000000000000000000000000001338",
      });
      let fakeSocket2 = await injectFakeWebSocket("/ws/pow?session=" + testSession2.getSessionId(), "8.8.4.4");
      expect(testSession2.getSessionStatus()).to.equal("running", "unexpected session status");
      fakeSocket1.emit("message", JSON.stringify({
        id: 42,
        action: "foundShare",
        data: {
          nonce: 1524,
          params: "scrypt|4096|8|1|16|11",
          hashrate: 12,
        }
      }));
      expect(fakeSocket1.isReady).to.equal(true, "client is not ready");
      await awaitSleepPromise(500, () => fakeSocket2.getSentMessage("verify").length > 0);
      let verifyMsg = fakeSocket2.getSentMessage("verify");
      expect(verifyMsg.length).to.equal(1, "unexpected number of verify messages sent");
      expect(verifyMsg[0].data.preimage).to.equal("oXwNMIuRUOc=", "invalid verify message: preimage mismatch");
      expect(verifyMsg[0].data.nonce).to.equal(1524, "invalid verify message: nonce mismatch");
      // send verify result
      fakeSocket2.emit("message", JSON.stringify({
        id: 43,
        action: "verifyResult",
        data: {
          shareId: verifyMsg[0].data.shareId,
          policyId: verifyMsg[0].data.policy.id,
          isValid: true,
        }
      }));
      await awaitSleepPromise(500, () => fakeSocket2.getSentMessage("updateBalance").length > 0);
      let balanceMsg1 = fakeSocket2.getSentMessage("updateBalance");
      expect(balanceMsg1.length).to.equal(1, "no updateBalance message sent");
      expect(balanceMsg1[0].data.balance).to.equal("5", "invalid updateBalance message: unexpected balance");
      expect(balanceMsg1[0].data.reason).to.matches(/valid verification/, "invalid updateBalance message: unexpected reason");
      let verifierResponses = fakeSocket2.getSentMessage().filter((message) => message.rsp === 43);
      expect(verifierResponses).to.have.length(1);
      expect(verifierResponses[0].action).to.equal("ok");
      await awaitSleepPromise(500, () => fakeSocket1.getSentMessage("ok").length > 0);
      let okMsg2 = fakeSocket1.getSentMessage("ok");
      expect(okMsg2.length).to.equal(1, "no ok message2 sent");
      expect(okMsg2[0].rsp).to.equal(42, "invalid response id in ok msg2");
    }).retries(3);

    it("check action 'verifyResult': invalid share verification", async () => {
      faucetConfig.modules["pow"] = {
        enabled: true,
        powShareReward: 10,
        powHashAlgo: PoWHashAlgo.SCRYPT,
        powScryptParams: {
          cpuAndMemory: 4096,
          blockSize: 8,
          parallelization: 1,
          keyLength: 16,
        },
        powDifficulty: 11,
        powHashrateHardLimit: 100,
        verifyMinerIndividuals: 1,
        verifyMinerPeerCount: 1,
        verifyMinerPercent: 100,
        verifyMinerRewardPerc: 50,
        verifyMinerMissPenaltyPerc: 0,
      } as IPoWConfig;
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession1 = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      }, {
        "pow.preimage": "oXwNMIuRUOc=",
      });
      let fakeSocket1 = await injectFakeWebSocket("/ws/pow?session=" + testSession1.getSessionId(), "8.8.8.8");
      expect(testSession1.getSessionStatus()).to.equal("running", "unexpected session status");
      let testSession2 = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.4.4", {
        addr: "0x0000000000000000000000000000000000001338",
      });
      let fakeSocket2 = await injectFakeWebSocket("/ws/pow?session=" + testSession2.getSessionId(), "8.8.4.4");
      expect(testSession2.getSessionStatus()).to.equal("running", "unexpected session status");
      fakeSocket1.emit("message", JSON.stringify({
        id: 42,
        action: "foundShare",
        data: {
          nonce: 1524,
          params: "scrypt|4096|8|1|16|11",
          hashrate: 12,
        }
      }));
      expect(fakeSocket1.isReady).to.equal(true, "client is not ready");
      await awaitSleepPromise(1000, () => fakeSocket2.getSentMessage("verify").length > 0);
      let verifyMsg = fakeSocket2.getSentMessage("verify");
      expect(verifyMsg.length).to.equal(1, "unexpected number of verify messages sent");
      expect(verifyMsg[0].data.preimage).to.equal("oXwNMIuRUOc=", "invalid verify message: preimage mismatch");
      expect(verifyMsg[0].data.nonce).to.equal(1524, "invalid verify message: nonce mismatch");
      // send verify result
      fakeSocket2.emit("message", JSON.stringify({
        id: 43,
        action: "verifyResult",
        data: {
          shareId: verifyMsg[0].data.shareId,
          policyId: verifyMsg[0].data.policy.id,
          isValid: false,
        }
      }));
      await awaitSleepPromise(1000, () => !fakeSocket2.isReady);
      let errorMsg = fakeSocket2.getSentMessage("error");
      expect(errorMsg.length).to.equal(1, "unexpected number of error messages sent");
      expect(errorMsg[0].data.code).to.equal("CLIENT_KILLED", "unexpected error2 code");
      expect(errorMsg[0].data.message).to.matches(/session failed/i, "unexpected error2 message");
      let verifierResponses = fakeSocket2.getSentMessage().filter((message) => message.rsp === 43);
      expect(verifierResponses).to.have.length(1);
      expect(verifierResponses[0].action).to.equal("ok");
      await awaitSleepPromise(500, () => fakeSocket1.getSentMessage("ok").length > 0);
      let okMsg2 = fakeSocket1.getSentMessage("ok");
      expect(okMsg2.length).to.equal(1, "no ok message sent");
      expect(okMsg2[0].rsp).to.equal(42, "invalid response id");
    }).timeout(5000).retries(3);

    it("check timed out share verification", async () => {
      faucetConfig.modules["pow"] = {
        enabled: true,
        powShareReward: 10,
        powHashAlgo: PoWHashAlgo.SCRYPT,
        powScryptParams: {
          cpuAndMemory: 4096,
          blockSize: 8,
          parallelization: 1,
          keyLength: 16,
        },
        powDifficulty: 11,
        powHashrateHardLimit: 100,
        verifyMinerIndividuals: 1,
        verifyMinerPeerCount: 1,
        verifyMinerPercent: 100,
        verifyMinerRewardPerc: 50,
        verifyMinerMissPenaltyPerc: 50,
        verifyMinerTimeout: 1,
      } as IPoWConfig;
      let moduleManager = ServiceManager.GetService(ModuleManager);
      await moduleManager.initialize();
      let testSession1 = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      }, {
        "pow.preimage": "oXwNMIuRUOc=",
      });
      let fakeSocket1 = await injectFakeWebSocket("/ws/pow?session=" + testSession1.getSessionId(), "8.8.8.8");
      expect(testSession1.getSessionStatus()).to.equal("running", "unexpected session status");
      let testSession2 = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.4.4", {
        addr: "0x0000000000000000000000000000000000001338",
      }, {
        "pow.preimage": "oXwNMIuRUOc=",
      });
      let fakeSocket2 = await injectFakeWebSocket("/ws/pow?session=" + testSession2.getSessionId(), "8.8.4.4");
      expect(testSession2.getSessionStatus()).to.equal("running", "unexpected session status");
      fakeSocket2.emit("message", JSON.stringify({
        id: 43,
        action: "foundShare",
        data: {
          nonce: 1524,
          params: "scrypt|4096|8|1|16|11",
          hashrate: 12,
        }
      }));
      await awaitSleepPromise(500, () => testSession2.getDropAmount() > 0n);
      expect(testSession2.getDropAmount()).to.equal(10n, "invalid drop amount");

      fakeSocket1.emit("message", JSON.stringify({
        id: 42,
        action: "foundShare",
        data: {
          nonce: 1524,
          params: "scrypt|4096|8|1|16|11",
          hashrate: 12,
        }
      }));
      expect(fakeSocket1.isReady).to.equal(true, "client is not ready");
      await awaitSleepPromise(500, () => fakeSocket2.getSentMessage("verify").length > 0);
      let verifyMsg = fakeSocket2.getSentMessage("verify");
      expect(verifyMsg.length).to.equal(1, "unexpected number of verify messages sent");
      expect(verifyMsg[0].data.preimage).to.equal("oXwNMIuRUOc=", "invalid verify message: preimage mismatch");
      expect(verifyMsg[0].data.nonce).to.equal(1524, "invalid verify message: nonce mismatch");
      await awaitSleepPromise(1500, () => fakeSocket1.getSentMessage("ok").length > 0);
      let okMsg2 = fakeSocket1.getSentMessage("ok");
      expect(okMsg2.length).to.equal(1, "no ok message sent");
      expect(okMsg2[0].rsp).to.equal(42, "invalid response id");
      await awaitSleepPromise(1500, () => fakeSocket2.getSentMessage("updateBalance").length > 1);
      let balanceMsg = fakeSocket2.getSentMessage("updateBalance");
      expect(balanceMsg.length).to.equal(2, "no updateBalance message sent");
      expect(balanceMsg[1].data.balance).to.equal("5", "invalid updateBalance message: unexpected balance");
      expect(balanceMsg[1].data.reason).to.matches(/verify miss/, "invalid updateBalance message: unexpected reason");
    }).timeout(5000).retries(3);

  });

});
