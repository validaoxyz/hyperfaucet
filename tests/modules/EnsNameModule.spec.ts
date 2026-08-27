import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { bindTestStubs, unbindTestStubs, loadDefaultTestConfig } from '../common.js';
import { ServiceManager } from '../../src/common/ServiceManager.js';
import { FaucetDatabase } from '../../src/db/FaucetDatabase.js';
import { ModuleManager } from '../../src/modules/ModuleManager.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { faucetConfig } from '../../src/config/FaucetConfig.js';
import { FaucetError } from '../../src/common/FaucetError.js';
import { FaucetWebApi } from '../../src/webserv/FaucetWebApi.js';
import { IEnsNameConfig } from '../../src/modules/ensname/EnsNameConfig.js';
import { EnsNameModule } from '../../src/modules/ensname/EnsNameModule.js';
import { EthWalletManager } from '../../src/eth/EthWalletManager.js';
import { FakeProvider } from '../stubs/FakeProvider.js';
import { PromiseDfd } from '../../src/utils/PromiseDfd.js';
import { BoundedAsyncWorkInvalidatedError } from '../../src/utils/BoundedAsyncWork.js';

const ENS_RESOLVER_CALL = "0x0178b8bf";
const ENS_INTERFACE_CALL = "0x01ffc9a7";
const ENS_ADDRESS_CALL = "0xf1cb7e06";
const ENS_RESOLVER_RESULT = "0x0000000000000000000000004976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41";
const ENS_INTERFACE_RESULT = "0x0000000000000000000000000000000000000000000000000000000000000001";
const ENS_ADDRESS_RESULT = "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000014332e43696a505ef45b9319973785f837ce5267b9000000000000000000000000";

function createSequencedEnsProvider(blockedCall: string) {
  const blockedResponse = new PromiseDfd<string>();
  const blockedCallReached = new PromiseDfd<void>();
  const calls: string[] = [];
  const request = async (payload: any): Promise<any> => {
    if(Array.isArray(payload))
      return Promise.all(payload.map(request));

    let result: any;
    if(payload.method === "eth_blockNumber")
      result = "0x1206917";
    else if(payload.method === "net_version")
      result = "1";
    else if(payload.method === "eth_chainId")
      result = "0x1";
    else if(payload.method === "eth_call") {
      const call = payload.params[0].data.substring(0, 10);
      calls.push(call);
      if(call === blockedCall) {
        blockedCallReached.resolve();
        result = await blockedResponse.promise;
      } else if(call === ENS_RESOLVER_CALL)
        result = ENS_RESOLVER_RESULT;
      else if(call === ENS_INTERFACE_CALL)
        result = ENS_INTERFACE_RESULT;
      else if(call === ENS_ADDRESS_CALL)
        result = ENS_ADDRESS_RESULT;
      else
        throw new Error("unexpected ENS call " + call);
    } else {
      throw new Error("unexpected ENS RPC method " + payload.method);
    }
    return {jsonrpc: "2.0", id: payload.id, result};
  };
  return {
    provider: {request},
    calls,
    blockedResponse,
    blockedCallReached,
  };
}


describe("Faucet module: ensname", () => {
  let globalStubs;
  let fakeProvider;

  beforeEach(async () => {
    globalStubs = bindTestStubs();
    fakeProvider = new FakeProvider();
    loadDefaultTestConfig();
    await ServiceManager.GetService(FaucetDatabase).initialize();
  });
  afterEach(async () => {
    let dbService = ServiceManager.GetService(FaucetDatabase);
    await ServiceManager.DisposeAllServices();
    await dbService.closeDatabase();
    await unbindTestStubs(globalStubs);
  });

  async function assertTimeoutStopsBeforeNextRequest(blockedCall: string, forbiddenCall: string): Promise<void> {
    const rpc = createSequencedEnsProvider(blockedCall);
    const requestTimeout = 50;
    faucetConfig.modules["ensname"] = {
      enabled: true,
      rpcHost: rpc.provider,
      ensAddr: null,
      required: false,
      requestTimeout,
      maxConcurrentLookups: 1,
    } as IEnsNameConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    const module = ServiceManager.GetService(ModuleManager).getModule<EnsNameModule>("ensname");
    const session = {setTargetAddr: sinon.spy()};
    const timeoutStub = globalStubs["global.setTimeout"];
    const timeoutCall = timeoutStub.callCount;
    let fireTimeout: (() => void) | undefined;
    timeoutStub.onCall(timeoutCall).callsFake((callback: () => void) => {
      fireTimeout = callback;
      return 0;
    });

    const lookup = (module as any).processSessionStart(session, {addr: "timed.eth"});
    await rpc.blockedCallReached.promise;
    expect(rpc.calls).to.include(blockedCall, "lookup never reached the blocked ENS request");
    expect(timeoutStub.getCall(timeoutCall).args[1]).to.equal(requestTimeout, "captured the wrong timeout");
    const physicalWork = [...(module as any).lookups.current.active][0] as Promise<unknown> | undefined;
    if(!physicalWork)
      throw new Error("blocked ENS request was not tracked");
    if(!fireTimeout)
      throw new Error("ENS timeout callback was not captured");
    fireTimeout();

    let error: unknown;
    try {
      await lookup;
    } catch(ex) {
      error = ex;
    }
    expect(error).to.be.instanceOf(FaucetError);
    expect((error as FaucetError).getCode()).to.equal("INVALID_ENSNAME");
    expect((module as any).lookups.getInflightCount()).to.equal(1, "timeout released physical ENS capacity");
    expect(rpc.calls).to.not.include(forbiddenCall);

    rpc.blockedResponse.resolve(
      blockedCall === ENS_RESOLVER_CALL ? ENS_RESOLVER_RESULT : ENS_INTERFACE_RESULT,
    );
    await Promise.allSettled([physicalWork]);
    expect((module as any).lookups.getInflightCount()).to.equal(0, "settled ENS request retained capacity");
    expect(rpc.calls).to.not.include(forbiddenCall, "timed-out ENS lookup issued a later provider request");
    expect(session.setTargetAddr.called).to.equal(false);
  }

  it("Check client config exports", async () => {
    faucetConfig.modules["ensname"] = {
      enabled: true,
      rpcHost: fakeProvider,
      ensAddr: null,
      required: true,
    } as IEnsNameConfig;
    fakeProvider.injectResponse("net_version", "5");
    await ServiceManager.GetService(ModuleManager).initialize();
    let clientConfig = await ServiceManager.GetService(FaucetWebApi).onGetFaucetConfig();
    expect(!!clientConfig.modules['ensname']).to.equal(true, "no ensname config exported");
    expect(clientConfig.modules['ensname'].required).to.equal(true, "client config mismatch: required");
  });

  it("Start session with optional ENS name", async () => {
    faucetConfig.modules["ensname"] = {
      enabled: true,
      rpcHost: fakeProvider,
      ensAddr: null,
      required: false,
    } as IEnsNameConfig;
    fakeProvider.injectResponse("net_version", "5");
    fakeProvider.injectResponse("eth_blockNumber", "0x1206917");
    fakeProvider.injectResponse("eth_call", (payload) => {
      switch(payload.params[0].data.substring(0, 10)) {
        case "0x0178b8bf":
          return "0x0000000000000000000000004976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41";
        case "0x01ffc9a7":
          return "0x0000000000000000000000000000000000000000000000000000000000000001";
        case "0xf1cb7e06":
          return "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000014332e43696a505ef45b9319973785f837ce5267b9000000000000000000000000";
        default:
          console.log("unknown call: ", payload);
      }
    });
    //fakeProvider.injectResponse("eth_call", "0x0000000000000000000000004b1488b7a6b320d2d721406204abc3eeaa9ad329");
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "pk910.eth",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(testSession.getTargetAddr()).to.equal("0x332e43696a505ef45b9319973785f837ce5267b9", "unexpected session status");
  });

  it("Start session without required ENS name", async () => {
    faucetConfig.modules["ensname"] = {
      enabled: true,
      rpcHost: fakeProvider,
      ensAddr: null,
      required: true,
    } as IEnsNameConfig;
    fakeProvider.injectResponse("net_version", "5");
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
    expect(error?.getCode()).to.equal("REQUIRE_ENSNAME", "unexpected error code");
  });

  it("Start session with invalid ENS name", async () => {
    faucetConfig.modules["ensname"] = {
      enabled: true,
      rpcHost: fakeProvider,
      ensAddr: null,
      required: true,
    } as IEnsNameConfig;
    fakeProvider.injectResponse("net_version", "5");
    fakeProvider.injectResponse("eth_call", "0x0000000000000000000000000000000000000000000000000000000000000000");
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let error: FaucetError | null = null;
    try {
      await sessionManager.createSession("::ffff:8.8.8.8", {
        addr: "test.eth",
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("INVALID_ENSNAME", "unexpected error code");
  });

  it("does not issue the interface request after a resolver timeout", async () => {
    await assertTimeoutStopsBeforeNextRequest(ENS_RESOLVER_CALL, ENS_INTERFACE_CALL);
  });

  it("does not issue the address request after an interface timeout", async () => {
    await assertTimeoutStopsBeforeNextRequest(ENS_INTERFACE_CALL, ENS_ADDRESS_CALL);
  });

  it("Rejects a cleartext remote RPC endpoint", async () => {
    faucetConfig.modules["ensname"] = {
      enabled: true,
      rpcHost: "http://rpc.example.test",
      ensAddr: null,
      required: false,
    } as IEnsNameConfig;

    let error: unknown;
    try {
      await ServiceManager.GetService(ModuleManager).initialize();
    } catch(ex) {
      error = ex;
    }
    expect(String(error)).to.include("must use HTTPS or WSS");
  });

  it("keeps the last-good resolver when reload endpoint validation fails", async () => {
    faucetConfig.modules["ensname"] = {
      enabled: true,
      rpcHost: fakeProvider,
      ensAddr: null,
      required: false,
    } as IEnsNameConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    const module = ServiceManager.GetService(ModuleManager).getModule<EnsNameModule>("ensname");
    const oldRuntime = (module as any).lookups.current.runtime;
    const oldDispose = sinon.spy(oldRuntime.provider, "dispose");

    let error: unknown;
    try {
      await module.setModuleConfig({...module.getModuleConfig(), rpcHost: "http://rpc.example.test"});
    } catch(ex) {
      error = ex;
    }
    expect(String(error)).to.include("must use HTTPS or WSS");
    expect((module as any).lookups.current.runtime).to.equal(oldRuntime);
    expect(oldDispose.called).to.equal(false, "invalid replacement disposed the last-good provider");

    sinon.stub(oldRuntime.ens, "getAddress").resolves("0x0000000000000000000000000000000000001337");
    const session = {setTargetAddr: sinon.spy()};
    await (module as any).processSessionStart(session, {addr: "still-live.eth"});
    expect(session.setTargetAddr.calledOnce).to.equal(true, "last-good resolver stopped accepting lookups");
  });

  for(const lastGoodRequired of [false, true]) {
    it(`uses the last-good ${lastGoodRequired ? "required" : "optional"} policy without lookup capacity after a failed reload`, async () => {
      faucetConfig.modules["ensname"] = {
        enabled: true,
        rpcHost: fakeProvider,
        ensAddr: null,
        required: lastGoodRequired,
        requestTimeout: 1_000,
        maxConcurrentLookups: 1,
      } as IEnsNameConfig;
      await ServiceManager.GetService(ModuleManager).initialize();
      const module = ServiceManager.GetService(ModuleManager).getModule<EnsNameModule>("ensname");
      const oldRuntime = (module as any).lookups.current.runtime;
      const slowLookup = new PromiseDfd<string>();
      sinon.stub(oldRuntime.ens, "getAddress").returns(slowLookup.promise);
      const lookupSession = {setTargetAddr: sinon.spy()};
      const lookup = (module as any).processSessionStart(lookupSession, {addr: "busy.eth"});

      try {
        expect((module as any).lookups.getInflightCount()).to.equal(1);
        const constructionFailure = new Error("candidate resolver construction failed");
        const addressSession = {setTargetAddr: sinon.spy()};
        let policyResult: Promise<void> | undefined;
        sinon.stub(EthWalletManager, "createWeb3ProviderHandle").callsFake(() => {
          policyResult = (module as any).processSessionStart(addressSession, {
            addr: "0x0000000000000000000000000000000000001337",
          });
          throw constructionFailure;
        });

        let reloadError: unknown;
        try {
          await module.setModuleConfig({
            ...module.getModuleConfig(),
            required: !lastGoodRequired,
            rpcHost: new FakeProvider(),
          });
        } catch(error) {
          reloadError = error;
        }

        if(!policyResult)
          throw new Error("candidate resolver factory was not invoked");
        let policyError: unknown;
        try {
          await policyResult;
        } catch(error) {
          policyError = error;
        }

        expect(reloadError).to.equal(constructionFailure);
        if(lastGoodRequired) {
          expect(policyError).to.be.instanceOf(FaucetError);
          expect((policyError as FaucetError).getCode()).to.equal("REQUIRE_ENSNAME");
        } else {
          expect(policyError).to.equal(undefined);
        }
        expect(addressSession.setTargetAddr.called).to.equal(false);
        expect((module as any).lookups.getInflightCount()).to.equal(1, "address policy check changed ENS capacity");
        expect((module as any).lookups.current.runtime).to.equal(oldRuntime);
        expect(module.getModuleConfig().required).to.equal(lastGoodRequired);
      } finally {
        slowLookup.resolve("0x0000000000000000000000000000000000001338");
        await Promise.allSettled([lookup]);
      }
    });
  }

  it("disposes a staged provider when resolver construction fails", async () => {
    faucetConfig.modules["ensname"] = {
      enabled: true,
      rpcHost: fakeProvider,
      ensAddr: null,
      required: false,
    } as IEnsNameConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    const module = ServiceManager.GetService(ModuleManager).getModule<EnsNameModule>("ensname");
    const oldRuntime = (module as any).lookups.current.runtime;
    const oldDispose = sinon.spy(oldRuntime.provider, "dispose");
    const nextProvider = new FakeProvider();
    const stagedDispose = sinon.spy();
    const providerFactory = sinon.stub(EthWalletManager, "createWeb3ProviderHandle").returns({
      provider: nextProvider,
      dispose: stagedDispose,
    });
    const ensFactory = sinon.stub(module as any, "createEns").throws(new Error("resolver construction failed"));

    let error: unknown;
    try {
      await module.setModuleConfig({...module.getModuleConfig(), rpcHost: nextProvider});
    } catch(ex) {
      error = ex;
    } finally {
      ensFactory.restore();
      providerFactory.restore();
    }
    expect(String(error)).to.include("resolver construction failed");
    expect(stagedDispose.calledOnce).to.equal(true, "partially staged provider was not disposed");
    expect(oldDispose.called).to.equal(false, "constructor failure disposed the last-good provider");
    expect((module as any).lookups.current.runtime).to.equal(oldRuntime);
  });

  for(const oldRequired of [false, true]) {
    it(`keeps the old ${oldRequired ? "required" : "optional"} policy during resolver rotation`, async () => {
      faucetConfig.modules["ensname"] = {
        enabled: true,
        rpcHost: fakeProvider,
        ensAddr: null,
        required: oldRequired,
        requestTimeout: 1000,
        maxConcurrentLookups: 1,
      } as IEnsNameConfig;
      await ServiceManager.GetService(ModuleManager).initialize();
      const module = ServiceManager.GetService(ModuleManager).getModule<EnsNameModule>("ensname");
      const oldRuntime = (module as any).lookups.current.runtime;
      const oldLookup = new PromiseDfd<string>();
      sinon.stub(oldRuntime.ens, "getAddress").returns(oldLookup.promise);
      const oldSession = {setTargetAddr: sinon.spy()};

      const oldResult = (module as any).processSessionStart(oldSession, {addr: "old.eth"});
      const nextProvider = new FakeProvider();
      let reloadSettled = false;
      const reload = module.setModuleConfig({
        ...module.getModuleConfig(),
        rpcHost: nextProvider,
        required: !oldRequired,
      }).then(() => {
        reloadSettled = true;
      });

      let oldError: unknown;
      try {
        await oldResult;
      } catch(ex) {
        oldError = ex;
      }
      const inflightDuringRotation = (module as any).lookups.getInflightCount();
      let oldPolicyError: unknown;
      try {
        await (module as any).processSessionStart({setTargetAddr: sinon.spy()}, {
          addr: "0x0000000000000000000000000000000000001337",
        });
      } catch(error) {
        oldPolicyError = error;
      }
      const reloadSettledDuringRotation = reloadSettled;

      oldLookup.resolve("0x0000000000000000000000000000000000001337");
      await reload;
      let newPolicyError: unknown;
      try {
        await (module as any).processSessionStart({setTargetAddr: sinon.spy()}, {
          addr: "0x0000000000000000000000000000000000001337",
        });
      } catch(error) {
        newPolicyError = error;
      }

      expect(oldError).to.be.instanceOf(FaucetError);
      expect((oldError as FaucetError).getCode()).to.equal("INVALID_ENSNAME");
      expect(oldSession.setTargetAddr.called).to.equal(false, "old generation changed the session target");
      expect(reloadSettledDuringRotation).to.equal(false, "policy published before the old RPC drained");
      expect(reloadSettled).to.equal(true);
      expect(inflightDuringRotation).to.equal(1);
      if(oldRequired) {
        expect(oldPolicyError).to.be.instanceOf(FaucetError);
        expect((oldPolicyError as FaucetError).getCode()).to.equal("REQUIRE_ENSNAME");
        expect(newPolicyError).to.equal(undefined);
      } else {
        expect(oldPolicyError).to.equal(undefined);
        expect(newPolicyError).to.be.instanceOf(FaucetError);
        expect((newPolicyError as FaucetError).getCode()).to.equal("REQUIRE_ENSNAME");
      }

      const newRuntime = (module as any).lookups.current.runtime;
      sinon.stub(newRuntime.ens, "getAddress").resolves("0x0000000000000000000000000000000000001338");
      const newSession = {setTargetAddr: sinon.spy()};
      await (module as any).processSessionStart(newSession, {addr: "new.eth"});
      expect(newSession.setTargetAddr.calledOnceWith("0x0000000000000000000000000000000000001338"))
        .to.equal(true, "new endpoint did not own the next lookup");
    });
  }

  it("fails closed for plain addresses as soon as resolver shutdown starts", async () => {
    faucetConfig.modules["ensname"] = {
      enabled: true,
      rpcHost: fakeProvider,
      ensAddr: null,
      required: false,
      requestTimeout: 1_000,
      maxConcurrentLookups: 1,
    } as IEnsNameConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    const module = ServiceManager.GetService(ModuleManager).getModule<EnsNameModule>("ensname");
    const runtime = (module as any).lookups.current.runtime;
    const slowLookup = new PromiseDfd<string>();
    sinon.stub(runtime.ens, "getAddress").returns(slowLookup.promise);
    const lookup = (module as any).processSessionStart(
      {setTargetAddr: sinon.spy()},
      {addr: "stopping.eth"},
    );
    expect((module as any).lookups.getInflightCount()).to.equal(1);

    const disabling = module.disableModule();
    let policyError: unknown;
    try {
      await (module as any).processSessionStart({setTargetAddr: sinon.spy()}, {
        addr: "0x0000000000000000000000000000000000001337",
      });
    } catch(error) {
      policyError = error;
    }

    slowLookup.resolve("0x0000000000000000000000000000000000001338");
    const [lookupResult, disableResult] = await Promise.allSettled([lookup, disabling]);
    expect(policyError).to.be.instanceOf(BoundedAsyncWorkInvalidatedError);
    expect(lookupResult.status).to.equal("rejected");
    if(lookupResult.status === "rejected") {
      expect(lookupResult.reason).to.be.instanceOf(FaucetError);
      expect((lookupResult.reason as FaucetError).getCode()).to.equal("INVALID_ENSNAME");
    }
    expect(disableResult.status).to.equal("fulfilled");
  });

  it("keeps plain-address policy fail closed after stop failure and republishes on restart", async () => {
    faucetConfig.modules["ensname"] = {
      enabled: true,
      rpcHost: fakeProvider,
      ensAddr: null,
      required: false,
    } as IEnsNameConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    const module = ServiceManager.GetService(ModuleManager).getModule<EnsNameModule>("ensname");
    const runtime = (module as any).lookups.current.runtime;
    const stopFailure = new Error("provider disposal failed");
    sinon.stub(runtime.provider, "dispose").onFirstCall().throws(stopFailure);

    let stopError: unknown;
    try {
      await module.disableModule();
    } catch(error) {
      stopError = error;
    }
    let stoppedPolicyError: unknown;
    try {
      await (module as any).processSessionStart({setTargetAddr: sinon.spy()}, {
        addr: "0x0000000000000000000000000000000000001337",
      });
    } catch(error) {
      stoppedPolicyError = error;
    }

    expect(stopError).to.equal(stopFailure);
    expect(stoppedPolicyError).to.be.instanceOf(BoundedAsyncWorkInvalidatedError);
    await module.disableModule();
    await module.enableModule();

    let restartedPolicyError: unknown;
    try {
      await (module as any).processSessionStart({setTargetAddr: sinon.spy()}, {
        addr: "0x0000000000000000000000000000000000001337",
      });
    } catch(error) {
      restartedPolicyError = error;
    }
    expect(restartedPolicyError).to.equal(undefined);
  });

  it("rejects a resolver handoff invalidated before session mutation", async () => {
    faucetConfig.modules["ensname"] = {
      enabled: true,
      rpcHost: fakeProvider,
      ensAddr: null,
      required: false,
      requestTimeout: 1_000,
      maxConcurrentLookups: 1,
    } as IEnsNameConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    const module = ServiceManager.GetService(ModuleManager).getModule<EnsNameModule>("ensname");
    const oldRuntime = (module as any).lookups.current.runtime;
    const oldLookup = new PromiseDfd<string>();
    const oldSession = {setTargetAddr: sinon.spy()};
    const nextProvider = new FakeProvider();
    let reload: Promise<void> | undefined;
    sinon.stub(oldRuntime.ens, "getAddress").returns(oldLookup.promise);

    oldLookup.promise.then(() => {
      reload = module.setModuleConfig({
        ...module.getModuleConfig(),
        rpcHost: nextProvider,
      });
    });
    const oldResult = (module as any).processSessionStart(oldSession, {addr: "old.eth"});
    oldLookup.resolve("0x0000000000000000000000000000000000001337");

    let oldError: unknown;
    try {
      await oldResult;
    } catch(ex) {
      oldError = ex;
    }
    expect(oldError).to.be.instanceOf(FaucetError);
    expect((oldError as FaucetError).getCode()).to.equal("INVALID_ENSNAME");
    expect(oldSession.setTargetAddr.called).to.equal(false, "invalidated handoff changed the session target");
    if(!reload)
      throw new Error("resolver rotation did not start at the handoff");
    await reload;
    expect((module as any).lookups.current.runtime).to.not.equal(oldRuntime);
  });


});
