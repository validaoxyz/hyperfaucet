import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { awaitSleepPromise, bindTestStubs, unbindTestStubs, loadDefaultTestConfig } from '../common.js';
import { ServiceManager } from '../../src/common/ServiceManager.js';
import { FaucetDatabase } from '../../src/db/FaucetDatabase.js';
import { ModuleManager } from '../../src/modules/ModuleManager.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { faucetConfig } from '../../src/config/FaucetConfig.js';
import { FaucetError } from '../../src/common/FaucetError.js';
import { FakeProvider } from '../stubs/FakeProvider.js';
import { IMainnetWalletConfig } from '../../src/modules/mainnet-wallet/MainnetWalletConfig.js';
import { MainnetWalletModule } from '../../src/modules/mainnet-wallet/MainnetWalletModule.js';
import { PromiseDfd } from '../../src/utils/PromiseDfd.js';


describe("Faucet module: mainnet-wallet", () => {
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

  it("Start session with passing mainnet txcount & balance check", async () => {
    faucetConfig.modules["mainnet-wallet"] = {
      enabled: true,
      rpcHost: fakeProvider,
      minTxCount: 10,
      minBalance: 1000,
    } as IMainnetWalletConfig;
    fakeProvider.injectResponse("eth_getBalance", "1000");
    fakeProvider.injectResponse("eth_getTransactionCount", "0xa");
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    let balanceReq = fakeProvider.getLastRequest("eth_getBalance");
    expect(balanceReq).to.not.equal(null, "no eth_getBalance request");
    expect(balanceReq.params[0]).to.equal("0x0000000000000000000000000000000000001337", "unexpected target address in eth_getBalance request");
    let txcountReq = fakeProvider.getLastRequest("eth_getTransactionCount");
    expect(txcountReq).to.not.equal(null, "no eth_getTransactionCount request");
    expect(txcountReq.params[0]).to.equal("0x0000000000000000000000000000000000001337", "unexpected target address in eth_getCode request");
  });

  it("Start session with too low mainnet balance", async () => {
    faucetConfig.modules["mainnet-wallet"] = {
      enabled: true,
      rpcHost: fakeProvider,
      minTxCount: 0,
      minBalance: 1000,
    } as IMainnetWalletConfig;
    fakeProvider.injectResponse("eth_getBalance", "999");
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
    expect(error?.getCode()).to.equal("MAINNET_BALANCE_LIMIT", "unexpected error code");
  });

  it("Start session with too low mainnet txcount", async () => {
    faucetConfig.modules["mainnet-wallet"] = {
      enabled: true,
      rpcHost: fakeProvider,
      minTxCount: 10,
      minBalance: 0,
    } as IMainnetWalletConfig;
    fakeProvider.injectResponse("eth_getTransactionCount", "0x5");
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
    expect(error?.getCode()).to.equal("MAINNET_TXCOUNT_LIMIT", "unexpected error code");
  });

  it("Start session with too low erc20 token balance", async () => {
    faucetConfig.modules["mainnet-wallet"] = {
      enabled: true,
      rpcHost: fakeProvider,
      minTxCount: 0,
      minErc20Balances: [
        {
          address: "0x0000000000000000000000000000000000000042",
          name: "TestToken",
          decimals: 12,
          minBalance: 2000000000000, // 5 TestToken
        }
      ],
    } as IMainnetWalletConfig;
    fakeProvider.injectResponse("eth_call", (payload) => {
      switch(payload.params[0].data.substring(0, 10)) {
        case "0x70a08231": // balanceOf()
          return "0x000000000000000000000000000000000000000000000000000000e8d4a51000"; // 1000000000000
        default:
          console.log("unknown call: ", payload);
      }
    });
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
    expect(error?.getCode()).to.equal("MAINNET_BALANCE_LIMIT", "unexpected error code");
  });

  it("Start session with RPC issue during balance check", async () => {
    faucetConfig.modules["mainnet-wallet"] = {
      enabled: true,
      rpcHost: fakeProvider,
      minTxCount: 0,
      minBalance: 1000,
    } as IMainnetWalletConfig;
    fakeProvider.injectResponse("eth_getBalance", (payload) => {
      throw new Error("RPC error");  
    });
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
    expect(error?.getCode()).to.equal("MAINNET_BALANCE_CHECK", "unexpected error code");
  });

  it("Start session with RPC issue during tx count check", async () => {
    faucetConfig.modules["mainnet-wallet"] = {
      enabled: true,
      rpcHost: fakeProvider,
      minTxCount: 10,
      minBalance: 0,
    } as IMainnetWalletConfig;
    fakeProvider.injectResponse("eth_getTransactionCount", () => {
      throw new Error("RPC error");
    });
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
    expect(error?.getCode()).to.equal("MAINNET_TXCOUNT_CHECK", "unexpected error code");
  });

  it("Start session with RPC issue during erc20 token balance check", async () => {
    faucetConfig.modules["mainnet-wallet"] = {
      enabled: true,
      rpcHost: fakeProvider,
      minTxCount: 0,
      minErc20Balances: [
        {
          address: "0x0000000000000000000000000000000000000042",
          name: "TestToken",
          decimals: 12,
          minBalance: 2000000000000, // 5 TestToken
        }
      ],
    } as IMainnetWalletConfig;
    fakeProvider.injectResponse("eth_call", (payload) => {
      switch(payload.params[0].data.substring(0, 10)) {
        case "0x70a08231": // balanceOf()
          throw new Error("RPC error");
        default:
          console.log("unknown call: ", payload);
      }
    });
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
    expect(error?.getCode()).to.equal("MAINNET_BALANCE_CHECK", "unexpected error code");
  });

  it("rejects a cleartext remote RPC endpoint", async () => {
    faucetConfig.modules["mainnet-wallet"] = {
      enabled: true,
      rpcHost: "http://rpc.example.test",
      minTxCount: 0,
      minBalance: 0,
      minErc20Balances: [],
    } as IMainnetWalletConfig;

    let error: unknown;
    try {
      await ServiceManager.GetService(ModuleManager).initialize();
    } catch(ex) {
      error = ex;
    }
    expect(String(error)).to.include("must use HTTPS or WSS");
  });

  it("retains capacity after timeout until the underlying RPC settles", async () => {
    const pendingResponse = new PromiseDfd<any>();
    const firstRequestReached = new PromiseDfd<void>();
    let balanceRequests = 0;
    const provider = {
      request: sinon.stub().callsFake((payload: any) => {
        if(payload.method !== "eth_getBalance")
          throw new Error("unexpected RPC method " + payload.method);
        balanceRequests++;
        if(balanceRequests === 1) {
          firstRequestReached.resolve();
          return pendingResponse.promise;
        }
        return Promise.resolve({jsonrpc: "2.0", id: payload.id, result: "1000"});
      }),
    };
    const requestTimeout = 5_000;
    faucetConfig.modules["mainnet-wallet"] = {
      enabled: true,
      rpcHost: provider,
      requestTimeout,
      maxConcurrentLookups: 1,
      minTxCount: 0,
      minBalance: 1000,
      minErc20Balances: [],
    } as IMainnetWalletConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    const module = ServiceManager.GetService(ModuleManager).getModule<MainnetWalletModule>("mainnet-wallet");
    const sessionManager = ServiceManager.GetService(SessionManager);
    const startSession = () => sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    const timeoutStub = globalStubs["global.setTimeout"];
    const timeoutCall = timeoutStub.callCount;
    let fireTimeout: (() => void) | undefined;
    timeoutStub.onCall(timeoutCall).callsFake((callback: () => void) => {
      fireTimeout = callback;
      return 0;
    });

    const timedOutSession = startSession();
    await firstRequestReached.promise;
    expect(timeoutStub.getCall(timeoutCall).args[1]).to.equal(requestTimeout, "captured the wrong timeout");
    if(!fireTimeout)
      throw new Error("mainnet-wallet timeout callback was not captured");
    fireTimeout();
    let timeoutError: unknown;
    try {
      await timedOutSession;
    } catch(ex) {
      timeoutError = ex;
    }
    expect(timeoutError).to.be.instanceOf(FaucetError);
    expect((timeoutError as FaucetError).getCode()).to.equal("MAINNET_WALLET_CHECK");
    expect((sessionManager as any).admissionLedger.reservations.size).to.equal(0, "timeout retained session admission");

    let capacityError: unknown;
    try {
      await startSession();
    } catch(ex) {
      capacityError = ex;
    }
    expect(capacityError).to.be.instanceOf(FaucetError);
    expect((capacityError as FaucetError).getCode()).to.equal("MAINNET_WALLET_CHECK");
    expect(balanceRequests).to.equal(1, "capacity rejection started another RPC");
    expect((sessionManager as any).admissionLedger.reservations.size).to.equal(0, "capacity rejection retained session admission");

    pendingResponse.resolve({jsonrpc: "2.0", id: "late", result: "1000"});
    await awaitSleepPromise(100, () => (module as any).lookups.getInflightCount() === 0);
    expect((module as any).lookups.getInflightCount()).to.equal(0, "settled RPC retained capacity");
    const recovered = await startSession();
    expect(recovered.getSessionStatus()).to.equal("claimable");
    expect(balanceRequests).to.equal(2, "settled RPC did not release module capacity");
  });

});
