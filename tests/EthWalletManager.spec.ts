import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { unbindTestStubs, awaitSleepPromise, bindTestStubs, loadDefaultTestConfig } from './common.js';
import { faucetConfig } from '../src/config/FaucetConfig.js';
import { EthWalletManager, FaucetCoinType } from '../src/eth/EthWalletManager.js';
import { ServiceManager } from '../src/common/ServiceManager.js';
import { ClaimTxStatus, EthClaimManager } from '../src/eth/EthClaimManager.js';
import { sleepPromise } from '../src/utils/PromiseUtils.js';
import { FakeProvider } from './stubs/FakeProvider.js';
import { FaucetDatabase } from '../src/db/FaucetDatabase.js';
import { FaucetSessionStatus, FaucetSessionStoreData } from '../src/session/FaucetSession.js';
import { ModuleManager } from '../src/modules/ModuleManager.js';
import { FetchError } from 'node-fetch';
import { FaucetProcess } from '../src/common/FaucetProcess.js';
import { Web3 } from 'web3';
import { FaucetStatus } from '../src/services/FaucetStatus.js';

describe("ETH Wallet Manager", () => {
  let globalStubs;
  let fakeProvider;

  async function createStoredClaim(claimManager: EthClaimManager, sessionData: FaucetSessionStoreData) {
    await ServiceManager.GetService(FaucetDatabase).updateSession(sessionData);
    await claimManager.initialize();
    return claimManager.createSessionClaim(sessionData, {});
  }

  beforeEach(async () => {
    globalStubs = bindTestStubs({
    });
    fakeProvider = new FakeProvider();
    loadDefaultTestConfig();
    faucetConfig.faucetStats = null;
    faucetConfig.ethWalletKey = "feedbeef12340000feedbeef12340000feedbeef12340000feedbeef12340000";
    faucetConfig.ethRpcHost = fakeProvider;
    await ServiceManager.GetService(FaucetDatabase).initialize();
    await ServiceManager.GetService(ModuleManager).initialize();
  });
  afterEach(async () => {
    let dbService = ServiceManager.GetService(FaucetDatabase);
    await ServiceManager.DisposeAllServices();
    await dbService.closeDatabase();
    await unbindTestStubs(globalStubs);
  });

  it("check wallet state initialization", async () => {
    let ethWalletManager = new EthWalletManager();
    fakeProvider.injectResponse("eth_chainId", 1337);
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_getBalance", "1000");
    fakeProvider.injectResponse("eth_getTransactionCount", 42);
    await ethWalletManager.initialize();
    await ethWalletManager.loadWalletState();
    let walletState = ethWalletManager.getWalletState();
    expect(!!walletState).equal(true, "no wallet state");
    expect(walletState.ready).equal(true, "wallet state not ready");
    expect(walletState.nonce).equal(42, "unexpected nonce in wallet state");
    expect(walletState.balance).equal(1000n, "unexpected balance in wallet state");
    expect(walletState.nativeBalance).equal(1000n, "unexpected balance in wallet state");
    expect(ethWalletManager.getFaucetAddress()).equal("0xCA9456991E0AA5d5321e88Bba44d405aAb401193", "unexpected wallet address");
    expect(ethWalletManager.getFaucetBalance()).equal(1000n, "unexpected balance");
  });

  it("marks an empty-wallet status as blocking session start", async () => {
    const noFundsMessage = "No faucet funds";
    faucetConfig.noFundsBalance = 10;
    faucetConfig.noFundsError = noFundsMessage;
    faucetConfig.ethTxGasLimit = 1;
    faucetConfig.ethTxMaxFee = 1;
    fakeProvider.injectResponse("eth_chainId", 1337);
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_getBalance", "0");
    fakeProvider.injectResponse("eth_getTransactionCount", 42);

    const ethWalletManager = ServiceManager.GetService(EthWalletManager);
    await ethWalletManager.initialize();
    await ethWalletManager.loadWalletState();

    const statuses = ServiceManager.GetService(FaucetStatus).getFaucetStatus().status;
    expect(statuses).to.have.length(1);
    expect(statuses[0].text).to.equal(noFundsMessage);
    expect(statuses[0]).to.have.property("blocksSessionStart", true);
  });

  it("check wallet state initialization (pending not supported)", async () => {
    let ethWalletManager = new EthWalletManager();
    fakeProvider.injectResponse("eth_chainId", 1337);
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_getBalance", (payload) => {
      if(payload.params[1] === "pending")
        throw '"pending" is not yet supported';
      return "1000";
    });
    fakeProvider.injectResponse("eth_getTransactionCount", (payload) => {
      if(payload.params[1] === "pending")
        throw '"pending" is not yet supported';
      return 42;
    });
    await ethWalletManager.initialize();
    await ethWalletManager.loadWalletState();
    let walletState = ethWalletManager.getWalletState();
    expect(!!walletState).equal(true, "no wallet state");
    expect(walletState.ready).equal(true, "wallet state not ready");
    expect(walletState.nonce).equal(42, "unexpected nonce in wallet state");
    expect(walletState.balance).equal(1000n, "unexpected balance in wallet state");
    expect(walletState.nativeBalance).equal(1000n, "unexpected balance in wallet state");
    expect(ethWalletManager.getFaucetAddress()).equal("0xCA9456991E0AA5d5321e88Bba44d405aAb401193", "unexpected wallet address");
    expect(ethWalletManager.getFaucetBalance()).equal(1000n, "unexpected balance");
  });

  it("uses latest balance with pending nonce before applying reservations", async () => {
    faucetConfig.ethChainId = 1337;
    faucetConfig.ethTxGasLimit = 1;
    faucetConfig.ethTxMaxFee = 1;
    faucetConfig.ethTxPrioFee = 0;
    let balanceTags: string[] = [];
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_getBalance", (payload) => {
      balanceTags.push(payload.params[1]);
      return payload.params[1] === "pending" ? "900" : "1000";
    });
    fakeProvider.injectResponse("eth_getTransactionCount", (payload) => payload.params[1] === "pending" ? 42 : 41);

    let walletManager = new EthWalletManager();
    await walletManager.initialize();
    expect(balanceTags).to.deep.equal(["latest"], "wallet balance used pending state");
    expect(walletManager.getWalletState().nonce).to.equal(42, "wallet nonce did not include pending transactions");
    expect(walletManager.getWalletState().balance).to.equal(1000n, "wallet did not use canonical balance");

    let transaction = await walletManager.prepareClaimTx(
      "0x0000000000000000000000000000000000001337",
      100n,
    );
    walletManager.reserveClaimTx(transaction, 100n);
    expect(walletManager.getWalletState().balance).to.equal(899n, "principal and maximum fee were not reserved exactly once");
    expect(walletManager.getWalletState().nativeBalance).to.equal(899n, "native liability was not reserved exactly once");
    walletManager.dispose();
  });

  it("reserves native principal and maximum gas as one liability", async () => {
    faucetConfig.ethChainId = 1337;
    faucetConfig.ethTxGasLimit = 1;
    faucetConfig.ethTxMaxFee = 100;
    faucetConfig.ethTxPrioFee = 0;
    faucetConfig.spareFundsAmount = 0;
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_getBalance", "300");
    fakeProvider.injectResponse("eth_getTransactionCount", 1);

    let walletManager = new EthWalletManager();
    await walletManager.initialize();
    let first = await walletManager.prepareClaimTx("0x0000000000000000000000000000000000001337", 100n);
    expect(walletManager.getClaimCoinType(first)).to.equal(FaucetCoinType.NATIVE, "signed native claim was misclassified");
    expect(walletManager.canReserveClaimTx(first, 100n)).to.equal(true);
    walletManager.reserveClaimTx(first, 100n);
    expect(walletManager.getWalletState().balance).to.equal(100n);
    expect(walletManager.getWalletState().nativeBalance).to.equal(100n);
    await walletManager.loadWalletState();
    expect(walletManager.getWalletState().balance).to.equal(100n, "wallet refresh lost the principal and gas reservation");
    expect(walletManager.getWalletState().nativeBalance).to.equal(100n, "wallet refresh lost the native liability");

    let second = await walletManager.prepareClaimTx("0x0000000000000000000000000000000000001338", 100n);
    expect(walletManager.canReserveClaimTx(second, 100n)).to.equal(false, "a second claim reused reserved gas capacity");

    walletManager.releaseClaimTx(first, {outcome: "transferred", fee: 40n});
    expect(walletManager.getWalletState().balance).to.equal(160n);
    expect(walletManager.getWalletState().nativeBalance).to.equal(160n);
    walletManager.dispose();
  });

  it("reserves ERC20 principal and native gas in separate assets", async () => {
    faucetConfig.ethChainId = 1337;
    faucetConfig.ethTxGasLimit = 1;
    faucetConfig.ethTxMaxFee = 100;
    faucetConfig.ethTxPrioFee = 0;
    faucetConfig.spareFundsAmount = 0;
    faucetConfig.faucetCoinType = FaucetCoinType.ERC20;
    faucetConfig.faucetCoinContract = "0x0000000000000000000000000000000000004242";
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_getBalance", "150");
    fakeProvider.injectResponse("eth_getTransactionCount", 1);
    fakeProvider.injectResponse("eth_call", (payload) => {
      switch(payload.params[0].data.substring(0, 10)) {
        case "0x313ce567":
          return "0x0000000000000000000000000000000000000000000000000000000000000006";
        case "0x70a08231":
          return "0x00000000000000000000000000000000000000000000000000000000000003e8";
        default:
          return "0x";
      }
    });

    let walletManager = new EthWalletManager();
    await walletManager.initialize();
    let first = await walletManager.prepareClaimTx("0x0000000000000000000000000000000000001337", 100n);
    expect(walletManager.getClaimCoinType(first)).to.equal(FaucetCoinType.ERC20, "signed ERC20 claim was misclassified");
    expect(walletManager.canReserveClaimTx(first, 100n)).to.equal(true);
    walletManager.reserveClaimTx(first, 100n);
    expect(walletManager.getWalletState().balance).to.equal(900n);
    expect(walletManager.getWalletState().nativeBalance).to.equal(50n);

    let second = await walletManager.prepareClaimTx("0x0000000000000000000000000000000000001338", 100n);
    expect(walletManager.canReserveClaimTx(second, 100n)).to.equal(false, "an ERC20 claim reused reserved native gas capacity");

    walletManager.releaseClaimTx(first, {outcome: "transferred", fee: 40n});
    expect(walletManager.getWalletState().balance).to.equal(900n);
    expect(walletManager.getWalletState().nativeBalance).to.equal(110n);
    walletManager.dispose();
  });

  it("check wallet state initialization (fixed chainId)", async () => {
    let ethWalletManager = new EthWalletManager();
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_getBalance", (payload) => {
      if(payload.params[1] === "pending")
        throw '"pending" is not yet supported';
      return "1000";
    });
    fakeProvider.injectResponse("eth_getTransactionCount", (payload) => {
      if(payload.params[1] === "pending")
        throw '"pending" is not yet supported';
      return 42;
    });
    faucetConfig.ethChainId = 1337;
    await ethWalletManager.initialize();
    await ethWalletManager.loadWalletState();
    let walletState = ethWalletManager.getWalletState();
    expect(!!walletState).equal(true, "no wallet state");
    expect(walletState.ready).equal(true, "wallet state not ready");
    expect(walletState.nonce).equal(42, "unexpected nonce in wallet state");
    expect(walletState.balance).equal(1000n, "unexpected balance in wallet state");
    expect(walletState.nativeBalance).equal(1000n, "unexpected balance in wallet state");
    expect(ethWalletManager.getFaucetAddress()).equal("0xCA9456991E0AA5d5321e88Bba44d405aAb401193", "unexpected wallet address");
    expect(ethWalletManager.getFaucetBalance()).equal(1000n, "unexpected balance");
  });

  it("check wallet state initialization (erc20 token)", async () => {
    let ethWalletManager = new EthWalletManager();
    fakeProvider.injectResponse("eth_chainId", 1337);
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_getBalance", "1000");
    fakeProvider.injectResponse("eth_getTransactionCount", 42);
    fakeProvider.injectResponse("eth_call", (payload) => {
      switch(payload.params[0].data.substring(0, 10)) {
        case "0x313ce567": // decimals()
          return "0x0000000000000000000000000000000000000000000000000000000000000006"; // 6
        case "0x70a08231": // balanceOf()
          return "0x000000000000000000000000000000000000000000000000000000e8d4a51000"; // 1000000000000
        default:
          console.log("unknown call: ", payload);
      }
    });
    faucetConfig.faucetCoinType = FaucetCoinType.ERC20;
    faucetConfig.faucetCoinContract = "0x0000000000000000000000000000000000001337";
    await ethWalletManager.initialize();
    await ethWalletManager.loadWalletState();
    let walletState = ethWalletManager.getWalletState();
    expect(!!walletState).equal(true, "no wallet state");
    expect(walletState.ready).equal(true, "wallet state not ready");
    expect(walletState.nonce).equal(42, "unexpected nonce in wallet state");
    expect(walletState.balance).equal(1000000000000n, "unexpected balance in wallet state");
    expect(walletState.nativeBalance).equal(1000n, "unexpected balance in wallet state");
    expect(ethWalletManager.getTokenAddress()).equal("0x0000000000000000000000000000000000001337", "unexpected token address");
    expect(await ethWalletManager.getWalletBalance("0x0000000000000000000000000000000000000042")).equal(1000000000000n, "unexpected wallet token balance");
  });

  it("check wallet state initialization (unknown token)", async () => {
    let ethWalletManager = new EthWalletManager();
    fakeProvider.injectResponse("eth_chainId", 1337);
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_getBalance", "1000");
    fakeProvider.injectResponse("eth_getTransactionCount", 42);
    faucetConfig.faucetCoinType = "test" as any;
    faucetConfig.faucetCoinContract = "0x0000000000000000000000000000000000001337";
    await ethWalletManager.initialize();
    await ethWalletManager.loadWalletState();
    let walletState = ethWalletManager.getWalletState();
    expect(!!walletState).equal(true, "no wallet state");
    expect(walletState.ready).equal(true, "wallet state not ready");
    expect(walletState.nonce).equal(42, "unexpected nonce in wallet state");
    expect(walletState.balance).equal(1000n, "unexpected balance in wallet state");
    expect(walletState.nativeBalance).equal(1000n, "unexpected balance in wallet state");
    expect(ethWalletManager.getTokenAddress()).equal(null, "unexpected token address");
  });

  it("check wallet config refresh", async () => {
    let ethWalletManager = new EthWalletManager();
    fakeProvider.injectResponse("eth_chainId", 1337);
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_getBalance", "1000");
    fakeProvider.injectResponse("eth_getTransactionCount", 42);
    await ethWalletManager.initialize();
    await ethWalletManager.loadWalletState();
    ServiceManager.GetService(FaucetProcess).emit("reload");
    fakeProvider.injectResponse("eth_getBalance", "2000");
    await ethWalletManager.loadWalletState();
    let walletState = ethWalletManager.getWalletState();
    expect(!!walletState).equal(true, "no wallet state");
    expect(walletState.ready).equal(true, "wallet state not ready");
    expect(walletState.nonce).equal(42, "unexpected nonce in wallet state");
    expect(walletState.balance).equal(2000n, "unexpected balance in wallet state");
    expect(walletState.nativeBalance).equal(2000n, "unexpected balance in wallet state");
  });

  it("removes its reload listener on disposal", async () => {
    let walletManager = new EthWalletManager();
    fakeProvider.injectResponse("eth_chainId", 1337);
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_getBalance", "1000");
    fakeProvider.injectResponse("eth_getTransactionCount", 42);
    await walletManager.initialize();
    let restartSpy = sinon.spy(walletManager as any, "startWeb3");

    walletManager.dispose();
    ServiceManager.GetService(FaucetProcess).emit("reload");

    expect(restartSpy.called).to.equal(false, "disposed wallet reacted to a config reload");
  });

  it("check wallet state unavailability", async () => {
    let ethWalletManager = new EthWalletManager();
    fakeProvider.injectResponse("eth_chainId", 1337);
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_getBalance", () => {
      throw "request failed";
    });
    fakeProvider.injectResponse("eth_getTransactionCount", 42);
    await ethWalletManager.initialize();
    await ethWalletManager.loadWalletState();
    await ethWalletManager.loadWalletState();
    let walletState = ethWalletManager.getWalletState();
    expect(!!walletState).equal(true, "no wallet state");
    expect(walletState.ready).equal(false, "wallet state is ready");
    expect(walletState.nonce).equal(0, "unexpected nonce in wallet state");
    expect(walletState.balance).equal(0n, "unexpected balance in wallet state");
    expect(walletState.nativeBalance).equal(0n, "unexpected balance in wallet state");
  });

  it("rejects an RPC hash mismatch without mutating the signed claim", async () => {
    faucetConfig.ethChainId = 1337;
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_getBalance", "1000000000000000000");
    fakeProvider.injectResponse("eth_getTransactionCount", 42);
    let broadcastBytes: string = null;
    fakeProvider.injectResponse("eth_sendRawTransaction", (payload) => {
      broadcastBytes = payload.params[0];
      return "0x" + "ff".repeat(32);
    });

    let walletManager = ServiceManager.GetService(EthWalletManager);
    await walletManager.initialize();
    let transaction = Object.freeze(await walletManager.prepareClaimTx(
      "0x0000000000000000000000000000000000001337",
      1337n
    ));
    let transactionSnapshot = JSON.stringify(transaction);
    walletManager.reserveClaimTx(transaction, 1337n);

    let broadcastError: Error = null;
    try {
      await walletManager.broadcastClaimTx(transaction);
    } catch(ex) {
      broadcastError = ex;
    }

    expect(broadcastError?.message).to.match(/does not match/, "RPC hash mismatch was accepted");
    expect(broadcastBytes).to.equal(transaction.txHex, "wallet broadcast different bytes");
    expect(JSON.stringify(transaction)).to.equal(transactionSnapshot, "wallet API mutated the signed claim");

    let nonceError: Error = null;
    try {
      walletManager.reserveClaimTx({
        ...transaction,
        txNonce: transaction.txNonce + 1,
      }, 1337n);
    } catch(ex) {
      nonceError = ex;
    }
    expect(nonceError?.message).to.match(/nonce does not match/, "stored nonce was not checked against the signed bytes");
  });

  it("send ClaimTx transaction", async () => {
    faucetConfig.ethChainId = 1337;
    faucetConfig.spareFundsAmount = 0;
    faucetConfig.ethTxGasLimit = 21000;
    faucetConfig.ethTxMaxFee = 100000000000; // 100 gwei
    faucetConfig.ethTxPrioFee = 2000000000; // 2 gwei
    faucetConfig.minDropAmount = 1000;
    await ServiceManager.GetService(FaucetDatabase).initialize();
    let ethWalletManager = ServiceManager.GetService(EthWalletManager);
    let ethClaimManager = ServiceManager.GetService(EthClaimManager);
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_getBalance", "1000000000000000000"); // 1 ETH
    fakeProvider.injectResponse("eth_getTransactionCount", 42);
    let rawTxReq: any[] = [];
    fakeProvider.injectResponse("eth_sendRawTransaction", (payload) => {
      rawTxReq.push(payload);
      return Web3.utils.keccak256(payload.params[0]);
    });
    fakeProvider.injectResponse("eth_call", (payload) => {
      switch(payload.params[0].data.substring(0, 10)) {
        case "0x": // test call
          return "0x";
        default:
          console.log("unknown call: ", payload);
      }
    });
    fakeProvider.injectResponse("eth_getTransactionReceipt", (payload) => {
      return {
        "blockHash": "0xfce202c4104864d81d8bd78b7202a77e5dca634914a3fd6636f2765d65fa9a07",
        "blockNumber": "0x8aa5ae",
        "contractAddress": null,
        "cumulativeGasUsed": "0x1752665",
        "effectiveGasPrice": "0x3b9aca00", // 1 gwei
        "from": "0x917c0A57A0FaA917f8ac7cA8Dd52db0b906a59d2",
        "gasUsed": "0x5208", // 21000
        "logs": [],
        "logsBloom": "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        "status": "0x1",
        "to": "0x0000000000000000000000000000000000001337",
        "transactionHash": "0x1337b2933e4d908d44948ae7f8ec3184be10bbd67ba3c4b165be654281337337",
        "transactionIndex": "0x3d",
        "type": "0x2"
      };
    });
    await ethWalletManager.initialize();
    await ethWalletManager.loadWalletState();
    let testSessionData: FaucetSessionStoreData = {
      sessionId: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
      status: FaucetSessionStatus.CLAIMABLE,
      startTime: Math.floor(new Date().getTime() / 1000),
      targetAddr: "0X0000000000000000000000000000000000001337",
      dropAmount: "1337",
      remoteIP: "8.8.8.8",
      tasks: [], data: {}, claim: null,
    };
    let claimTx = await createStoredClaim(ethClaimManager, testSessionData);
    await ethClaimManager.processQueue();
    await awaitSleepPromise(200, () => claimTx.claim.claimStatus === ClaimTxStatus.CONFIRMED);
    expect(rawTxReq.length).to.equal(1, "unexpected transaction count");
    expect(rawTxReq[0].params[0]).to.equal("0x02f86f8205392a847735940085174876e80082520894000000000000000000000000000000000000133782053980c001a04787689fdfc3803c758feaaa7989761900c274488f1f656ec7aa277ae37294efa038b6fc22a7a4c1f0bf537a989f00c907413f5c3e333807e1bbadfb08f74926f5", "unexpected transaction hex");    
    expect(claimTx.claim.claimStatus).to.equal(ClaimTxStatus.CONFIRMED, "unexpected claimTx status");
    let walletState = ethWalletManager.getWalletState();
    expect(!!walletState).equal(true, "no wallet state");
    expect(walletState.ready).equal(true, "wallet state not ready");
    expect(walletState.nonce).equal(43, "unexpected nonce in wallet state");
    expect(walletState.balance).equal(999978999999998663n, "unexpected balance in wallet state");
    expect(walletState.nativeBalance).equal(999978999999998663n, "unexpected balance in wallet state");
  });

  it("send ClaimTx transaction (long confirmation time)", async () => {
    faucetConfig.ethChainId = 1337;
    faucetConfig.spareFundsAmount = 0;
    faucetConfig.ethTxGasLimit = 21000;
    faucetConfig.ethTxMaxFee = 100000000000; // 100 gwei
    faucetConfig.ethTxPrioFee = 2000000000; // 2 gwei
    faucetConfig.minDropAmount = 1000;
    await ServiceManager.GetService(FaucetDatabase).initialize();
    let ethWalletManager = ServiceManager.GetService(EthWalletManager);
    let ethClaimManager = ServiceManager.GetService(EthClaimManager);
    fakeProvider.injectResponse("eth_getBalance", "1000000000000000000"); // 1 ETH
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_getTransactionCount", 42);
    fakeProvider.injectResponse("eth_subscribe", () => { throw "not supported" });
    let rawTxReq: any[] = [];
    fakeProvider.injectResponse("eth_sendRawTransaction", (payload) => {
      rawTxReq.push(payload);
      return Web3.utils.keccak256(payload.params[0]);
    });
    fakeProvider.injectResponse("eth_call", (payload) => {
      switch(payload.params[0].data.substring(0, 10)) {
        case "0x": // test call
          return "0x";
        default:
          console.log("unknown call: ", payload);
      }
    });
    let receiptResponseMode = "null";
    fakeProvider.injectResponse("eth_getTransactionReceipt", (payload) => {
      if(receiptResponseMode === "null") {
        return null
      }
      return {
        "blockHash": "0xfce202c4104864d81d8bd78b7202a77e5dca634914a3fd6636f2765d65fa9a07",
        "blockNumber": "0x8aa5ae",
        "contractAddress": null,
        "cumulativeGasUsed": "0x1752665",
        "effectiveGasPrice": "0x3b9aca00", // 1 gwei
        "from": "0x917c0A57A0FaA917f8ac7cA8Dd52db0b906a59d2",
        "gasUsed": "0x5208", // 21000
        "logs": [],
        "logsBloom": "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        "status": "0x1",
        "to": "0x0000000000000000000000000000000000001337",
        "transactionHash": "0x1337b2933e4d908d44948ae7f8ec3184be10bbd67ba3c4b165be654281337337",
        "transactionIndex": "0x3d",
        "type": "0x2"
      };
    });
    await ethWalletManager.initialize();
    (ethWalletManager as any).txReceiptPollInterval = 100;
    await ethWalletManager.loadWalletState();
    let testSessionData: FaucetSessionStoreData = {
      sessionId: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
      status: FaucetSessionStatus.CLAIMABLE,
      startTime: Math.floor(new Date().getTime() / 1000),
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1337",
      remoteIP: "8.8.8.8",
      tasks: [], data: {}, claim: null,
    };
    let claimTx = await createStoredClaim(ethClaimManager, testSessionData);
    await ethClaimManager.processQueue();
    await sleepPromise(3000); // wait for timeout from web3js lib
    receiptResponseMode = "receipt"; // now return the receipt
    // Receipt confirmation is persisted before post-confirmation accounting.  Wait for
    // that accounting to release the reservation before asserting the settled balance.
    const settledBalance = 999978999999998663n;
    await awaitSleepPromise(2000, () =>
      claimTx.claim.claimStatus === ClaimTxStatus.CONFIRMED
      && ethWalletManager.getWalletState()?.balance === settledBalance
      && ethWalletManager.getWalletState()?.nativeBalance === settledBalance,
    );
    expect(rawTxReq.length).to.equal(1, "unexpected transaction count");
    expect(rawTxReq[0].params[0]).to.equal("0x02f86f8205392a847735940085174876e80082520894000000000000000000000000000000000000133782053980c001a04787689fdfc3803c758feaaa7989761900c274488f1f656ec7aa277ae37294efa038b6fc22a7a4c1f0bf537a989f00c907413f5c3e333807e1bbadfb08f74926f5", "unexpected transaction hex");    
    expect(claimTx.claim.claimStatus).to.equal(ClaimTxStatus.CONFIRMED, "unexpected claimTx status");
    let walletState = ethWalletManager.getWalletState();
    expect(!!walletState).equal(true, "no wallet state");
    expect(walletState.ready).equal(true, "wallet state not ready");
    expect(walletState.nonce).equal(43, "unexpected nonce in wallet state");
    expect(walletState.balance).equal(settledBalance, "unexpected balance in wallet state");
    expect(walletState.nativeBalance).equal(settledBalance, "unexpected balance in wallet state");
  }).timeout(10000);

  it("send ClaimTx transaction (legacy transaction)", async () => {
    faucetConfig.ethChainId = 1337;
    faucetConfig.spareFundsAmount = 0;
    faucetConfig.ethTxGasLimit = 21000;
    faucetConfig.ethTxMaxFee = 100000000000; // 100 gwei
    faucetConfig.ethTxPrioFee = 2000000000; // 2 gwei
    faucetConfig.ethLegacyTx = true;
    faucetConfig.minDropAmount = 1000;
    await ServiceManager.GetService(FaucetDatabase).initialize();
    let ethWalletManager = ServiceManager.GetService(EthWalletManager);
    let ethClaimManager = ServiceManager.GetService(EthClaimManager);
    fakeProvider.injectResponse("eth_getBalance", "1000000000000000000"); // 1 ETH
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_getTransactionCount", 42);
    fakeProvider.injectResponse("eth_gasPrice", "150000000000"); // 150 gwei
    let rawTxReq: any[] = [];
    fakeProvider.injectResponse("eth_sendRawTransaction", (payload) => {
      rawTxReq.push(payload);
      return Web3.utils.keccak256(payload.params[0]);
    });
    fakeProvider.injectResponse("eth_call", (payload) => {
      switch(payload.params[0].data.substring(0, 10)) {
        case "0x": // test call
          return "0x";
        default:
          console.log("unknown call: ", payload);
      }
    });
    fakeProvider.injectResponse("eth_getTransactionReceipt", (payload) => {
      return {
        "blockHash": "0xfce202c4104864d81d8bd78b7202a77e5dca634914a3fd6636f2765d65fa9a07",
        "blockNumber": "0x8aa5ae",
        "contractAddress": null,
        "cumulativeGasUsed": "0x1752665",
        "effectiveGasPrice": "0x3b9aca00", // 1 gwei
        "from": "0x917c0A57A0FaA917f8ac7cA8Dd52db0b906a59d2",
        "gasUsed": "0x5208", // 21000
        "logs": [],
        "logsBloom": "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        "status": "0x1",
        "to": "0x0000000000000000000000000000000000001337",
        "transactionHash": "0x1337b2933e4d908d44948ae7f8ec3184be10bbd67ba3c4b165be654281337337",
        "transactionIndex": "0x3d",
        "type": "0x2"
      };
    });
    await ethWalletManager.initialize();
    await ethWalletManager.loadWalletState();
    let testSessionData: FaucetSessionStoreData = {
      sessionId: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
      status: FaucetSessionStatus.CLAIMABLE,
      startTime: Math.floor(new Date().getTime() / 1000),
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1337",
      remoteIP: "8.8.8.8",
      tasks: [], data: {}, claim: null,
    };
    let claimTx = await createStoredClaim(ethClaimManager, testSessionData);
    await ethClaimManager.processQueue();
    await awaitSleepPromise(200, () => claimTx.claim.claimStatus === ClaimTxStatus.CONFIRMED);
    expect(rawTxReq.length).to.equal(1, "unexpected transaction count");
    expect(rawTxReq[0].params[0]).to.equal("0xf8682a85174876e80082520894000000000000000000000000000000000000133782053980820a96a0537845eca3779f6925b8ca8459bf20a72189ceb3746e62d50ae5b7cfec5c83e8a025ecaf297265b4a5e5fcdd3f66c0184c3c4f103cfd5bf5dc2ffc2da9c7fa8ee0", "unexpected transaction hex");
    expect(claimTx.claim.claimStatus).to.equal(ClaimTxStatus.CONFIRMED, "unexpected claimTx status");
    let walletState = ethWalletManager.getWalletState();
    expect(!!walletState).equal(true, "no wallet state");
    expect(walletState.ready).equal(true, "wallet state not ready");
    expect(walletState.nonce).equal(43, "unexpected nonce in wallet state");
    expect(walletState.balance).equal(999978999999998663n, "unexpected balance in wallet state");
    expect(walletState.nativeBalance).equal(999978999999998663n, "unexpected balance in wallet state");
  });

  it("keeps retrying the same prepared ClaimTx after an ambiguous RPC error", async () => {
    faucetConfig.ethChainId = 1337;
    faucetConfig.spareFundsAmount = 0;
    faucetConfig.ethTxGasLimit = 21000;
    faucetConfig.ethTxMaxFee = 100000000000; // 100 gwei
    faucetConfig.ethTxPrioFee = 2000000000; // 2 gwei
    faucetConfig.minDropAmount = 1000;
    await ServiceManager.GetService(FaucetDatabase).initialize();
    let ethWalletManager = ServiceManager.GetService(EthWalletManager);
    let ethClaimManager = ServiceManager.GetService(EthClaimManager);
    fakeProvider.injectResponse("eth_getBalance", "1000000000000000000"); // 1 ETH
    fakeProvider.injectResponse("eth_getTransactionCount", 42);
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_call", (payload) => {
      switch(payload.params[0].data.substring(0, 10)) {
        case "0x": // test call
          return "0x";
        default:
          console.log("unknown call: ", payload);
      }
    });
    let rawTransactions: string[] = [];
    fakeProvider.injectResponse("eth_sendRawTransaction", (payload) => {
      rawTransactions.push(payload.params[0]);
      throw "test error 57572x";
    });
    fakeProvider.injectResponse("eth_getTransactionReceipt", {
      _throw: new FetchError("invalid json response", "invalid-json"),
    });
    await ethWalletManager.initialize();
    (ethWalletManager as any).txReceiptPollInterval = 20;
    (ethClaimManager as any).broadcastRetryDelay = 20;
    await ethWalletManager.loadWalletState();
    let testSessionData: FaucetSessionStoreData = {
      sessionId: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
      status: FaucetSessionStatus.CLAIMABLE,
      startTime: Math.floor(new Date().getTime() / 1000),
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1337",
      remoteIP: "8.8.8.8",
      tasks: [], data: {}, claim: null,
    };
    let claimTx = await createStoredClaim(ethClaimManager, testSessionData);
    await ethClaimManager.processQueue();
    await awaitSleepPromise(250, () => rawTransactions.length >= 2);
    expect(rawTransactions.length).to.be.greaterThanOrEqual(2, "claim was not retried");
    expect(new Set(rawTransactions).size).to.equal(1, "claim retry changed the signed transaction bytes");
    expect(claimTx.claim.claimStatus).to.equal(ClaimTxStatus.PREPARED, "ambiguous send became terminal");
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(testSessionData.sessionId);
    expect(storedSession.claim.claimStatus).to.equal(ClaimTxStatus.PREPARED, "prepared transaction was not durable");
    expect(storedSession.claim.txHex).to.equal(rawTransactions[0], "persisted transaction differs from the broadcast bytes");
    let walletState = ethWalletManager.getWalletState();
    expect(!!walletState).equal(true, "no wallet state");
    expect(walletState.ready).equal(true, "wallet state not ready");
    expect(walletState.nonce).equal(43, "prepared nonce was not reserved");
    expect(walletState.balance).equal(997899999999998663n, "prepared principal and maximum fee were not reserved");
    expect(walletState.nativeBalance).equal(997899999999998663n, "prepared native liability was not reserved");
  });

  it("send ClaimTx transaction (RPC/HTTP error on send)", async () => {
    faucetConfig.ethChainId = 1337;
    faucetConfig.spareFundsAmount = 0;
    faucetConfig.ethTxGasLimit = 21000;
    faucetConfig.ethTxMaxFee = 100000000000; // 100 gwei
    faucetConfig.ethTxPrioFee = 2000000000; // 2 gwei
    faucetConfig.minDropAmount = 1000;
    await ServiceManager.GetService(FaucetDatabase).initialize();
    let ethWalletManager = ServiceManager.GetService(EthWalletManager);
    let ethClaimManager = ServiceManager.GetService(EthClaimManager);
    fakeProvider.injectResponse("eth_getBalance", "1000000000000000000"); // 1 ETH
    fakeProvider.injectResponse("eth_getTransactionCount", 42);
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_call", (payload) => {
      switch(payload.params[0].data.substring(0, 10)) {
        case "0x": // test call
          return "0x";
        default:
          console.log("unknown call: ", payload);
      }
    });
    let rpcResponseError = true;
    let rawTransactions: string[] = [];
    fakeProvider.injectResponse("eth_sendRawTransaction", (payload) => {
      rawTransactions.push(payload.params[0]);
      if(rpcResponseError) {
        return {
          _throw: new FetchError("invalid json response", "invalid-json"),
        }
      }
      return Web3.utils.keccak256(payload.params[0]);
    });
    fakeProvider.injectResponse("eth_getTransactionReceipt", () => {
      if(rpcResponseError) {
        return {
          _throw: new FetchError("invalid json response", "invalid-json"),
        };
      }
      return {
      "blockHash": "0xfce202c4104864d81d8bd78b7202a77e5dca634914a3fd6636f2765d65fa9a07",
      "blockNumber": "0x8aa5ae",
      "contractAddress": null,
      "cumulativeGasUsed": "0x1752665",
      "effectiveGasPrice": "0x3b9aca00", // 1 gwei
      "from": "0x917c0A57A0FaA917f8ac7cA8Dd52db0b906a59d2",
      "gasUsed": "0x5208", // 21000
      "logs": [],
      "logsBloom": "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
      "status": "0x1",
      "to": "0x0000000000000000000000000000000000001337",
      "transactionHash": "0x1337b2933e4d908d44948ae7f8ec3184be10bbd67ba3c4b165be654281337337",
      "transactionIndex": "0x3d",
      "type": "0x2"
      };
    });
    await ethWalletManager.initialize();
    (ethWalletManager as any).txReceiptPollInterval = 20;
    (ethClaimManager as any).broadcastRetryDelay = 20;
    await ethWalletManager.loadWalletState();
    let testSessionData: FaucetSessionStoreData = {
      sessionId: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
      status: FaucetSessionStatus.CLAIMABLE,
      startTime: Math.floor(new Date().getTime() / 1000),
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1337",
      remoteIP: "8.8.8.8",
      tasks: [], data: {}, claim: null,
    };
    let claimTx = await createStoredClaim(ethClaimManager, testSessionData);
    await ethClaimManager.processQueue();
    await awaitSleepPromise(250, () => rawTransactions.length >= 2);
    expect(rawTransactions.length).to.be.greaterThanOrEqual(2, "ambiguous send was not retried");
    expect(new Set(rawTransactions).size).to.equal(1, "ambiguous send was retried with different bytes");
    expect(claimTx.claim.claimStatus).to.equal(ClaimTxStatus.PREPARED, "claim advanced without a trustworthy acknowledgement");
    let signedBytes = rawTransactions[0];
    rpcResponseError = false;
    await awaitSleepPromise(1000, () => claimTx.claim.claimStatus === ClaimTxStatus.CONFIRMED);
    expect(claimTx.claim.claimStatus).to.equal(ClaimTxStatus.CONFIRMED, "accepted transaction was not reconciled");
    expect(rawTransactions.every((txHex) => txHex === signedBytes)).to.equal(true, "recovery resigned the claim");
    expect(claimTx.claim.txHex).to.equal(signedBytes, "terminal claim lost its signed transaction bytes");
    expect(claimTx.claim.txNonce).to.equal(42, "claim nonce changed during recovery");
  });

  it("send ClaimTx transaction (RPC/HTTP error on receipt poll)", async () => {
    faucetConfig.ethChainId = 1337;
    faucetConfig.spareFundsAmount = 0;
    faucetConfig.ethTxGasLimit = 21000;
    faucetConfig.ethTxMaxFee = 100000000000; // 100 gwei
    faucetConfig.ethTxPrioFee = 2000000000; // 2 gwei
    faucetConfig.minDropAmount = 1000;
    await ServiceManager.GetService(FaucetDatabase).initialize();
    let ethWalletManager = ServiceManager.GetService(EthWalletManager);
    let ethClaimManager = ServiceManager.GetService(EthClaimManager);
    fakeProvider.injectResponse("eth_getBalance", "1000000000000000000"); // 1 ETH
    fakeProvider.injectResponse("eth_getTransactionCount", 42);
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_call", (payload) => {
      switch(payload.params[0].data.substring(0, 10)) {
        case "0x": // test call
          return "0x";
        default:
          console.log("unknown call: ", payload);
      }
    });
    fakeProvider.injectResponse("eth_sendRawTransaction", (payload) => Web3.utils.keccak256(payload.params[0]));
    let rpcResponseError = true;
    fakeProvider.injectResponse("eth_getTransactionReceipt", (payload) => {
      if(rpcResponseError) {
        return {
          _throw: new FetchError("invalid json response", "invalid-json"),
        }
      }
      return {
        "blockHash": "0xfce202c4104864d81d8bd78b7202a77e5dca634914a3fd6636f2765d65fa9a07",
        "blockNumber": "0x8aa5ae",
        "contractAddress": null,
        "cumulativeGasUsed": "0x1752665",
        "effectiveGasPrice": "0x3b9aca00", // 1 gwei
        "from": "0x917c0A57A0FaA917f8ac7cA8Dd52db0b906a59d2",
        "gasUsed": "0x5208", // 21000
        "logs": [],
        "logsBloom": "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        "status": "0x1",
        "to": "0x0000000000000000000000000000000000001337",
        "transactionHash": "0x1337b2933e4d908d44948ae7f8ec3184be10bbd67ba3c4b165be654281337337",
        "transactionIndex": "0x3d",
        "type": "0x2"
      };
    });
    await ethWalletManager.initialize();
    (ethWalletManager as any).txReceiptPollInterval = 1000;
    await ethWalletManager.loadWalletState();
    let testSessionData: FaucetSessionStoreData = {
      sessionId: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
      status: FaucetSessionStatus.CLAIMABLE,
      startTime: Math.floor(new Date().getTime() / 1000),
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1337",
      remoteIP: "8.8.8.8",
      tasks: [], data: {}, claim: null,
    };
    let claimTx = await createStoredClaim(ethClaimManager, testSessionData);
    await ethClaimManager.processQueue();
    await awaitSleepPromise(7000, () => claimTx.claim.claimStatus !== ClaimTxStatus.PENDING);
    rpcResponseError = false;
    await awaitSleepPromise(5000, () => claimTx.claim.claimStatus === ClaimTxStatus.CONFIRMED);
    expect(claimTx.claim.claimStatus).to.equal(ClaimTxStatus.CONFIRMED, "unexpected claimTx status");
  }).timeout(15000);

  it("send ClaimTx transaction (reverted transaction)", async () => {
    faucetConfig.ethChainId = 1337;
    faucetConfig.spareFundsAmount = 0;
    faucetConfig.ethTxGasLimit = 21000;
    faucetConfig.ethTxMaxFee = 100000000000; // 100 gwei
    faucetConfig.ethTxPrioFee = 2000000000; // 2 gwei
    faucetConfig.minDropAmount = 1000;
    await ServiceManager.GetService(FaucetDatabase).initialize();
    let ethWalletManager = ServiceManager.GetService(EthWalletManager);
    let ethClaimManager = ServiceManager.GetService(EthClaimManager);
    fakeProvider.injectResponse("eth_getBalance", "1000000000000000000"); // 1 ETH
    fakeProvider.injectResponse("eth_getTransactionCount", 42);
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_call", (payload) => {
      switch(payload.params[0].data.substring(0, 10)) {
        case "0x": // test call
          return "0x";
        default:
          console.log("unknown call: ", payload);
      }
    });
    fakeProvider.injectResponse("eth_sendRawTransaction", (payload) => Web3.utils.keccak256(payload.params[0]));
    fakeProvider.injectResponse("eth_getTransactionReceipt", {
      "blockHash": "0xfce202c4104864d81d8bd78b7202a77e5dca634914a3fd6636f2765d65fa9a07",
      "blockNumber": "0x8aa5ae",
      "contractAddress": null,
      "cumulativeGasUsed": "0x1752665",
      "effectiveGasPrice": "0x3b9aca00", // 1 gwei
      "from": "0x917c0A57A0FaA917f8ac7cA8Dd52db0b906a59d2",
      "gasUsed": "0x5208", // 21000
      "logs": [],
      "logsBloom": "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
      "status": "0x0",
      "to": "0x0000000000000000000000000000000000001337",
      "transactionHash": "0x1337b2933e4d908d44948ae7f8ec3184be10bbd67ba3c4b165be654281337337",
      "transactionIndex": "0x3d",
      "type": "0x2"
    });
    await ethWalletManager.initialize();
    await ethWalletManager.loadWalletState();
    let testSessionData: FaucetSessionStoreData = {
      sessionId: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
      status: FaucetSessionStatus.CLAIMABLE,
      startTime: Math.floor(new Date().getTime() / 1000),
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1337",
      remoteIP: "8.8.8.8",
      tasks: [], data: {}, claim: null,
    };
    let claimTx = await createStoredClaim(ethClaimManager, testSessionData);
    await ethClaimManager.processQueue();
    await awaitSleepPromise(200, () => claimTx.claim.claimStatus === ClaimTxStatus.REVERTED);
    expect(claimTx.claim.claimStatus).to.equal(ClaimTxStatus.REVERTED, "unexpected claimTx status");
    expect(claimTx.claim.txError).to.equal("Transaction reverted", "unexpected revert reason");
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(testSessionData.sessionId);
    expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED, "reverted claim did not fail the session");
    expect(storedSession.claim.claimStatus).to.equal(ClaimTxStatus.REVERTED, "revert state was not durable");
    let walletState = ethWalletManager.getWalletState();
    expect(!!walletState).equal(true, "no wallet state");
    expect(walletState.ready).equal(true, "wallet state not ready");
    expect(walletState.nonce).equal(43, "unexpected nonce in wallet state");
    expect(walletState.balance).equal(999979000000000000n, "reverted payout reservation was not restored");
    expect(walletState.nativeBalance).equal(999979000000000000n, "reverted native payout reservation was not restored");
  });

  it("send ClaimTx transaction (erc20 token transfer)", async () => {
    faucetConfig.ethChainId = 1337;
    faucetConfig.spareFundsAmount = 0;
    faucetConfig.ethTxGasLimit = 21000;
    faucetConfig.ethTxMaxFee = 100000000000; // 100 gwei
    faucetConfig.ethTxPrioFee = 2000000000; // 2 gwei
    faucetConfig.minDropAmount = 1000;
    await ServiceManager.GetService(FaucetDatabase).initialize();
    let ethWalletManager = ServiceManager.GetService(EthWalletManager);
    let ethClaimManager = ServiceManager.GetService(EthClaimManager);
    fakeProvider.injectResponse("eth_chainId", 1337);
    fakeProvider.injectResponse("eth_getBalance", "1000000000000000000"); // 1 ETH
    fakeProvider.injectResponse("eth_getTransactionCount", 42);
    fakeProvider.injectResponse("eth_blockNumber", "0x1000");
    fakeProvider.injectResponse("eth_call", (payload) => {
      switch(payload.params[0].data.substring(0, 10)) {
        case "0x": // test call
          return "0x";
        case "0x313ce567": // decimals()
          return "0x0000000000000000000000000000000000000000000000000000000000000006"; // 6
        case "0x70a08231": // balanceOf()
          return "0x000000000000000000000000000000000000000000000000000000e8d4a51000"; // 1000000000000
        case "0xa9059cbb": // transfer()
          return "0x";
        default:
          console.log("unknown call: ", payload);
      }
    });
    let rawTxReq: any[] = [];
    fakeProvider.injectResponse("eth_sendRawTransaction", (payload) => {
      rawTxReq.push(payload);
      return Web3.utils.keccak256(payload.params[0]);
    });
    fakeProvider.injectResponse("eth_getTransactionReceipt", (payload) => {
      return {
        "blockHash": "0xfce202c4104864d81d8bd78b7202a77e5dca634914a3fd6636f2765d65fa9a07",
        "blockNumber": "0x8aa5ae",
        "contractAddress": null,
        "cumulativeGasUsed": "0x1752665",
        "effectiveGasPrice": "0x3b9aca00", // 1 gwei
        "from": "0x917c0A57A0FaA917f8ac7cA8Dd52db0b906a59d2",
        "gasUsed": "0x5208", // 21000
        "logs": [],
        "logsBloom": "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        "status": "0x1",
        "to": "0x0000000000000000000000000000000000004242",
        "transactionHash": "0x1337b2933e4d908d44948ae7f8ec3184be10bbd67ba3c4b165be654281331337",
        "transactionIndex": "0x3d",
        "type": "0x2"
      };
    });
    faucetConfig.faucetCoinType = FaucetCoinType.ERC20;
    faucetConfig.faucetCoinContract = "0x0000000000000000000000000000000000004242";
    await ethWalletManager.initialize();
    await ethWalletManager.loadWalletState();
    let testSessionData: FaucetSessionStoreData = {
      sessionId: "f081154a-3b93-4972-9ae7-b83f3307bb0f",
      status: FaucetSessionStatus.CLAIMABLE,
      startTime: Math.floor(new Date().getTime() / 1000),
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1337",
      remoteIP: "8.8.8.8",
      tasks: [], data: {}, claim: null,
    };
    let claimTx = await createStoredClaim(ethClaimManager, testSessionData);
    await ethClaimManager.processQueue();
    await awaitSleepPromise(200, () => claimTx.claim.claimStatus === ClaimTxStatus.CONFIRMED);
    expect(claimTx.claim.claimStatus).to.equal(ClaimTxStatus.CONFIRMED, "unexpected claimTx status");
    expect(rawTxReq.length).to.equal(1, "unexpected transaction count");
    expect(rawTxReq[0].params[0]).to.equal("0x02f8b28205392a847735940085174876e80082520894000000000000000000000000000000000000424280b844a9059cbb00000000000000000000000000000000000000000000000000000000000013370000000000000000000000000000000000000000000000000000000000000539c001a002eca862f97badedde37bfbfd0ec047dc16e33bd1f73e20d24e284c6950c685ea03f975804b22ab748a52098907c87fcdb40520a9f7c11fe54721fa037c81e8055", "unexpected transaction hex");
    let walletState = ethWalletManager.getWalletState();
    expect(!!walletState).equal(true, "no wallet state");
    expect(walletState.ready).equal(true, "wallet state not ready");
    expect(walletState.nonce).equal(43, "unexpected nonce in wallet state");
    expect(walletState.balance).equal(999999998663n, "unexpected balance in wallet state");
    expect(walletState.nativeBalance).equal(999979000000000000n, "unexpected balance in wallet state");
  });
});
