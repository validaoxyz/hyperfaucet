
import Web3, { ContractAbi, AbiFragment, HttpProvider, TransactionReceipt, TransactionNotFound } from 'web3';
import * as EthCom from '@ethereumjs/common';
import * as EthTx from '@ethereumjs/tx';
import * as EthUtil from '@ethereumjs/util';
import { Contract } from 'web3-eth-contract';
import { faucetConfig } from '../config/FaucetConfig.js';
import { ServiceManager } from '../common/ServiceManager.js';
import { FaucetProcess, FaucetLogLevel } from '../common/FaucetProcess.js';
import { FaucetStatus, FaucetStatusLevel } from '../services/FaucetStatus.js';
import { strFormatPlaceholder } from '../utils/StringUtils.js';
import { sleepPromise } from '../utils/PromiseUtils.js';
import { SignedClaimTransaction } from './EthClaim.js';
import { Erc20Abi } from '../abi/ERC20.js';
import IpcProvider from 'web3-providers-ipc';
import WebSocketProvider from 'web3-providers-ws';
import { RpcEndpointPool } from './RpcEndpointPool.js';

export interface WalletState {
  ready: boolean;
  nonce: number;
  balance: bigint;
  nativeBalance: bigint;
}

interface FaucetTokenState {
  address: string;
  decimals: number;
  getBalance(addr: string): Promise<bigint>;
  getTransferData(addr: string, amount: bigint): string;
}

interface ClaimReservation {
  nonce: number;
  faucetAmount: bigint;
  maximumFee: bigint;
}

export interface ClaimSettlement {
  outcome: "transferred" | "reverted";
  fee: bigint;
}

export enum FaucetCoinType {
  NATIVE = "native",
  ERC20 = "erc20",
}

export interface TransactionResult {
  txHash: string;
  txPromise: Promise<{
    status: boolean;
    block: number;
    fee: bigint;
    receipt: TransactionReceipt;
  }>;
}

export interface Web3ProviderHandle {
  provider: any;
  dispose(): void;
}

type Web3ProviderFactory = (
  rpcHost: string,
  signal: AbortSignal | undefined,
  socketAutoReconnect: boolean,
) => any;

export class EthWalletManager {

  private static getWeb3Provider(
    rpcHost: string,
    signal?: AbortSignal,
    socketAutoReconnect = true,
  ): any {
    if(rpcHost.match(/^wss?:\/\//i)) {
      const reconnectOptions = socketAutoReconnect ? undefined : {autoReconnect: false};
      return new WebSocketProvider(rpcHost, undefined, reconnectOptions);
    }
    else if(rpcHost.match(/^\//))
      return new IpcProvider(
        rpcHost,
        undefined,
        socketAutoReconnect ? undefined : {autoReconnect: false},
      );
    else
      return new HttpProvider(rpcHost, signal ? {providerOptions: {signal}} : undefined);
  }

  public static createWeb3ProviderHandle(
    rpcHost: any,
    configName: string,
    providerFactory: Web3ProviderFactory = EthWalletManager.getWeb3Provider,
  ): Web3ProviderHandle {
    if(rpcHost && typeof rpcHost === "object") {
      return {
        provider: rpcHost,
        dispose: () => undefined,
      };
    }
    if(typeof rpcHost !== "string" || rpcHost.length === 0)
      throw new Error(configName + " must be a provider object, secure URL, or absolute IPC path");

    const isIpc = rpcHost.startsWith("/");
    let protocol: string | null = null;
    if(!isIpc) {
      try {
        protocol = new URL(rpcHost).protocol;
      } catch(ex) {
        throw new Error(configName + " must be a provider object, secure URL, or absolute IPC path");
      }
      if(protocol !== "https:" && protocol !== "wss:")
        throw new Error(configName + " must use HTTPS or WSS");
    }

    const controller = protocol === "https:" ? new AbortController() : null;
    const provider = providerFactory(rpcHost, controller?.signal, false);
    return {
      provider,
      dispose: () => {
        if(controller) {
          controller.abort(new Error(configName + " was stopped"));
          return;
        }
        if(isIpc || protocol === "wss:") {
          try {
            provider.clearQueues(new Error(configName + " was stopped"));
          } finally {
            provider.disconnect();
          }
        }
      },
    };
  }

  private initialized: boolean;
  private rpcPool: RpcEndpointPool;
  private chainCommon: EthCom.Common;
  private walletKey: Buffer;
  private walletAddr: string;
  private walletState: WalletState;
  private tokenState: FaucetTokenState;
  private lastWalletRefresh: number;
  private txReceiptPollInterval = 12000;
  private reservedClaims = new Map<string, ClaimReservation>();
  private faucetProcess: FaucetProcess;
  private readonly reloadHandler = () => {
    if(!this.initialized)
      return;
    this.startWeb3();
    this.lastWalletRefresh = 0;
  };

  private get web3(): Web3 {
    return this.rpcPool.getActiveWeb3();
  }

  public getRpcPool(): RpcEndpointPool {
    return this.rpcPool;
  }

  public async initialize(): Promise<void> {
    if(this.initialized)
      return;
    this.initialized = true;

    this.walletState = {
      ready: false,
      nonce: 0,
      balance: 0n,
      nativeBalance: 0n,
    };

    this.startWeb3();
    if(typeof faucetConfig.ethChainId === "number")
      this.initChainCommon(BigInt(faucetConfig.ethChainId));

    let privkey = faucetConfig.ethWalletKey;
    if(privkey.match(/^0x/))
      privkey = privkey.substring(2);
    this.walletKey = Buffer.from(privkey, "hex");
    this.walletAddr = EthUtil.toChecksumAddress(EthUtil.bytesToHex(EthUtil.privateToAddress(this.walletKey)));

    await this.loadWalletState();

    this.faucetProcess = ServiceManager.GetService(FaucetProcess);
    this.faucetProcess.addListener("reload", this.reloadHandler);
  }

  public dispose(): void {
    if(!this.initialized)
      return;
    this.initialized = false;
    this.faucetProcess?.removeListener("reload", this.reloadHandler);
    this.faucetProcess = null;
    if(this.rpcPool) {
      this.rpcPool.dispose();
      this.rpcPool = null;
    }
  }

  private initChainCommon(chainId: bigint) {
    if(this.chainCommon && this.chainCommon.chainId() === chainId)
      return;
    ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Web3 ChainCommon initialized with chainId " + chainId);
    this.chainCommon = EthCom.createCustomCommon({
      chainId: chainId.toString(),
    }, EthCom.Mainnet);
  }

  private startWeb3() {
    if(this.rpcPool)
      this.rpcPool.dispose();
    this.rpcPool = new RpcEndpointPool();
    this.rpcPool.initialize(faucetConfig.ethRpcHost);

    if(faucetConfig.faucetCoinType !== FaucetCoinType.NATIVE)
      this.initWeb3Token();
    else
      this.tokenState = null;
  }

  private initWeb3Token() {
    switch(faucetConfig.faucetCoinType) {
      case FaucetCoinType.ERC20:
        let tokenAddr = faucetConfig.faucetCoinContract;
        // Build a fresh contract on each call so it always uses the active web3 instance,
        // surviving RPC failover.
        let buildContract = () => new this.web3.eth.Contract(Erc20Abi, tokenAddr, {
          from: this.walletAddr,
        });
        this.tokenState = {
          address: tokenAddr,
          decimals: 0,
          getBalance: (addr: string) => buildContract().methods.balanceOf(addr).call() as Promise<bigint>,
          getTransferData: (addr: string, amount: bigint) => buildContract().methods['transfer'](addr, amount).encodeABI(),
        };
        buildContract().methods.decimals().call().then((res) => {
          this.tokenState.decimals = Number(res);
        });
        break;
      default:
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.ERROR, "Unknown coin type: " + faucetConfig.faucetCoinType);
        return;
    }
  }

  public getWalletState(): WalletState {
    return this.walletState;
  }

  public getLastWalletRefresh(): number {
    return this.lastWalletRefresh;
  }

  public loadWalletState(): Promise<void> {
    this.lastWalletRefresh = Math.floor(new Date().getTime() / 1000);
    let chainIdPromise = typeof faucetConfig.ethChainId === "number" ? Promise.resolve(faucetConfig.ethChainId) : this.web3.eth.getChainId();
    let tokenBalancePromise = this.tokenState?.getBalance(this.walletAddr);
    return Promise.all([
      this.web3.eth.getBalance(this.walletAddr, "latest"),
      this.web3.eth.getTransactionCount(this.walletAddr, "pending"),
      chainIdPromise,
      tokenBalancePromise,
    ]).catch((ex) => {
      if(ex.toString().match(/"pending" is not yet supported|pending state is not available|pending block is not available/i)) {
        return Promise.all([
          this.web3.eth.getBalance(this.walletAddr, "latest"),
          this.web3.eth.getTransactionCount(this.walletAddr, "latest"),
          chainIdPromise,
          tokenBalancePromise,
        ]);
      }
      else
        throw ex;
    }).then((res) => {
      this.initChainCommon(BigInt(res[2]));
      Object.assign(this.walletState, {
        ready: true,
        balance: this.tokenState ? BigInt(res[3]) : BigInt(res[0]),
        nativeBalance: BigInt(res[0]),
        nonce: Number(res[1]),
      });
      this.reservedClaims.forEach((reservation) => {
        this.walletState.nonce = Math.max(this.walletState.nonce, reservation.nonce + 1);
        this.applyClaimReservation(reservation, -1n);
      });
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Wallet " + this.walletAddr + ":  " + this.readableAmount(this.walletState.balance) + "  [Nonce: " + this.walletState.nonce + "]");
    }, (err) => {
      Object.assign(this.walletState, {
        ready: false,
        balance: 0n,
        nativeBalance: 0n,
        nonce: 0,
      });
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.ERROR, "Error loading wallet state for " + this.walletAddr + ": " + err.toString());
    }).then(() => {
      this.updateFaucetStatus();
    });
  }

  private updateFaucetStatus() {
    let statusMessage: string = null;
    let statusLevel: FaucetStatusLevel = null;
    let blocksSessionStart = false;
    if(this.walletState) {
      if(!statusLevel && !this.walletState.ready) {
        if(typeof faucetConfig.rpcConnectionError === "string")
          statusMessage = faucetConfig.rpcConnectionError;
        else if(faucetConfig.rpcConnectionError)
          statusMessage = "The faucet could not connect to the network RPC";
        if(statusMessage) {
          statusMessage = strFormatPlaceholder(statusMessage);
          statusLevel = FaucetStatusLevel.ERROR;
        }
      }
      if(!statusLevel && (
        this.walletState.balance <= faucetConfig.noFundsBalance ||
        this.walletState.nativeBalance <= BigInt(faucetConfig.ethTxGasLimit) * BigInt(faucetConfig.ethTxMaxFee)
      )) {
        if(typeof faucetConfig.noFundsError === "string")
          statusMessage = faucetConfig.noFundsError;
        else if(faucetConfig.noFundsError)
          statusMessage = "The faucet is out of funds!";
        if(statusMessage) {
          statusMessage = strFormatPlaceholder(statusMessage);
          statusLevel = FaucetStatusLevel.ERROR;
          blocksSessionStart = true;
        }
      }
      if(!statusLevel && this.walletState.balance <= faucetConfig.lowFundsBalance) {
        if(typeof faucetConfig.lowFundsWarning === "string")
          statusMessage = faucetConfig.lowFundsWarning;
        else if(faucetConfig.lowFundsWarning)
          statusMessage = "The faucet is running out of funds! Faucet Balance: {1}";
        if(statusMessage) {
          statusMessage = strFormatPlaceholder(statusMessage, this.readableAmount(this.walletState.balance));
          statusLevel = FaucetStatusLevel.WARNING;
        }
      }
    }
    const walletStatus = ServiceManager.GetService(FaucetStatus).setFaucetStatus("wallet", statusMessage, statusLevel);
    if(walletStatus)
      walletStatus.blocksSessionStart = blocksSessionStart;
  }

  public getFaucetAddress(): string {
    return this.walletAddr;
  }

  public getTokenAddress(): string {
    return this.tokenState ? this.tokenState.address : null;
  }

  public getFaucetDecimals(native?: boolean): number {
    return ((this.tokenState && !native) ? this.tokenState.decimals : 18) || 18;
  }

  public decimalUnitAmount(amount: bigint, native?: boolean): number {
    let decimals = this.getFaucetDecimals(native);
    let factor = Math.pow(10, decimals);
    return parseInt(amount.toString()) / factor;
  }

  public readableAmount(amount: bigint, native?: boolean): string {
    let amountStr = (Math.floor(this.decimalUnitAmount(amount, native) * 1000) / 1000).toString();
    return amountStr + " " + (native ? "ETH" : faucetConfig.faucetCoinSymbol);
  }

  public async getWalletBalance(addr: string): Promise<bigint> {
    if(this.tokenState)
      return await this.tokenState.getBalance(addr);
    else
      return BigInt(await this.web3.eth.getBalance(addr));
  }

  public checkIsContract(addr: string): Promise<boolean> {
    return this.web3.eth.getCode(addr).then((res) => res && !!res.match(/^0x[0-9a-f]{2,}$/) && !res.match(/^0xef0100/));
  }

  public getFaucetBalance(native?: boolean): bigint | null {
    if(native)
      return this.walletState?.nativeBalance;
    else
      return this.walletState?.balance;
  }

  public getContractInterface(addr: string, abi: AbiFragment[]): Contract<ContractAbi> {
    return new this.web3.eth.Contract(abi, addr, {
      from: this.walletAddr,
    });
  }

  public async watchClaimTx(transaction: SignedClaimTransaction, signal?: AbortSignal): Promise<{
    status: boolean;
    block: number;
    fee: bigint;
    receipt: TransactionReceipt;
  }> {
    this.assertClaimTransaction(transaction);
    let receipt = await this.awaitTransactionReceipt(transaction.txHash, transaction.txNonce, true, signal);
    this.throwIfAborted(signal);

    let txfee = BigInt(receipt.effectiveGasPrice) * BigInt(receipt.gasUsed);
    return {
      status: Number(receipt.status) > 0,
      block: Number(receipt.blockNumber),
      fee: txfee,
      receipt: receipt,
    };
  }

  public async prepareClaimTx(target: string, amount: bigint): Promise<SignedClaimTransaction> {
    let txNonce = this.walletState.nonce;
    let txHex: string;
    if(this.tokenState)
      txHex = await this.buildEthTx(this.tokenState.address, 0n, txNonce, this.tokenState.getTransferData(target, amount));
    else
      txHex = await this.buildEthTx(target, amount, txNonce);

    txHex = "0x" + txHex;
    return {
      txHash: Web3.utils.keccak256(txHex),
      txHex,
      txNonce,
    };
  }

  public canReserveClaimTx(transaction: SignedClaimTransaction, amount: bigint): boolean {
    let reservation = this.getClaimReservation(transaction, amount);
    let faucetCost = reservation.faucetAmount + (this.tokenState ? 0n : reservation.maximumFee);
    let nativeCost = reservation.maximumFee + (this.tokenState ? 0n : reservation.faucetAmount);
    return this.walletState.balance - BigInt(faucetConfig.spareFundsAmount) >= faucetCost
      && this.walletState.nativeBalance >= nativeCost;
  }

  public getClaimCoinType(transaction: SignedClaimTransaction): FaucetCoinType {
    let parsedTransaction = this.parseClaimTransaction(transaction);
    return parsedTransaction.value > 0n ? FaucetCoinType.NATIVE : FaucetCoinType.ERC20;
  }

  public reserveClaimTx(transaction: SignedClaimTransaction, amount: bigint): void {
    let reservation = this.getClaimReservation(transaction, amount);
    let hash = transaction.txHash.toLowerCase();
    if(this.reservedClaims.has(hash))
      return;

    this.reservedClaims.set(hash, reservation);
    this.walletState.nonce = Math.max(this.walletState.nonce, transaction.txNonce + 1);
    this.applyClaimReservation(reservation, -1n);
    this.updateFaucetStatus();
  }

  public cancelClaimTx(transaction: SignedClaimTransaction): void {
    let reservation = this.reservedClaims.get(transaction.txHash.toLowerCase());
    if(!reservation)
      return;

    this.reservedClaims.delete(transaction.txHash.toLowerCase());
    this.applyClaimReservation(reservation, 1n);
    this.updateFaucetStatus();
  }

  public releaseClaimTx(transaction: SignedClaimTransaction, settlement: ClaimSettlement): void {
    if(typeof settlement?.fee !== "bigint" || settlement.fee < 0n)
      throw new Error("Invalid claim settlement fee");
    let reservation = this.reservedClaims.get(transaction.txHash.toLowerCase());
    if(!reservation)
      return;

    this.reservedClaims.delete(transaction.txHash.toLowerCase());
    let feeAdjustment = reservation.maximumFee - settlement.fee;
    this.walletState.nativeBalance += feeAdjustment;
    if(this.tokenState) {
      if(settlement.outcome === "reverted")
        this.walletState.balance += reservation.faucetAmount;
    } else {
      this.walletState.balance += feeAdjustment;
      if(settlement.outcome === "reverted") {
        this.walletState.balance += reservation.faucetAmount;
        this.walletState.nativeBalance += reservation.faucetAmount;
      }
    }
    this.updateFaucetStatus();
  }

  public async broadcastClaimTx(transaction: SignedClaimTransaction): Promise<void> {
    this.assertClaimTransaction(transaction);
    let rpcHash = await this.rpcPool.broadcastSendRawTransaction(transaction.txHex);
    if(typeof rpcHash !== "string" || rpcHash.toLowerCase() !== transaction.txHash.toLowerCase())
      throw new Error("RPC returned a transaction hash that does not match the signed claim transaction");
  }

  public async sendCustomTx(target: string, amount: bigint, data?: string, gasLimit?: number): Promise<TransactionResult> {
    let txHex = await this.buildEthTx(target, amount, this.walletState.nonce, data, gasLimit);
    let txResult = await this.sendTransaction(txHex, this.walletState.nonce);
    this.walletState.nonce++;
    return {
      txHash: txResult[0],
      txPromise : txResult[1].then((receipt) => {
        let txfee = BigInt(receipt.effectiveGasPrice) * BigInt(receipt.gasUsed);
        this.walletState.nativeBalance -= txfee;
        if(!this.tokenState)
          this.walletState.balance -= txfee;
        return {
          status: Number(receipt.status) > 0,
          block: Number(receipt.blockNumber),
          fee: txfee,
          receipt: receipt,
        };
      }),
    };
  }

  private async buildEthTx(target: string, amount: bigint, nonce: number, data?: string, gasLimit?: number): Promise<string> {
    if(target.match(/^0X/))
      target = "0x" + target.substring(2);

    let tx: EthTx.LegacyTx | EthTx.FeeMarket1559Tx;
    if(faucetConfig.ethLegacyTx) {
      // legacy transaction
      let gasPrice = await this.web3.eth.getGasPrice();
      gasPrice += BigInt(faucetConfig.ethTxPrioFee);
      if(faucetConfig.ethTxMaxFee > 0 && gasPrice > faucetConfig.ethTxMaxFee)
        gasPrice = BigInt(faucetConfig.ethTxMaxFee);

      tx = EthTx.createLegacyTx({
        nonce: nonce,
        gasLimit: gasLimit || faucetConfig.ethTxGasLimit,
        gasPrice: gasPrice,
        to: target as EthUtil.PrefixedHexString,
        value: "0x" + amount.toString(16) as EthUtil.PrefixedHexString,
        data: (data ? data : "0x") as EthUtil.PrefixedHexString
      }, {
        common: this.chainCommon
      });
    }
    else {
      // eip1559 transaction
      tx = EthTx.createFeeMarket1559Tx({
        nonce: nonce,
        gasLimit: gasLimit || faucetConfig.ethTxGasLimit,
        maxPriorityFeePerGas: faucetConfig.ethTxPrioFee,
        maxFeePerGas: faucetConfig.ethTxMaxFee,
        to: target as EthUtil.PrefixedHexString,
        value: "0x" + amount.toString(16) as EthUtil.PrefixedHexString,
        data: (data ? data : "0x") as EthUtil.PrefixedHexString
      }, {
        common: this.chainCommon
      });
    }

    tx = tx.sign(this.walletKey);
    return Buffer.from(tx.serialize()).toString('hex');
  }

  private getClaimReservation(transaction: SignedClaimTransaction, amount: bigint): ClaimReservation {
    if(typeof amount !== "bigint" || amount < 0n)
      throw new Error("Invalid claim amount");
    let parsedTransaction = this.parseClaimTransaction(transaction);
    let feePerGas = "maxFeePerGas" in parsedTransaction
      ? parsedTransaction.maxFeePerGas
      : parsedTransaction.gasPrice;
    return {
      nonce: transaction.txNonce,
      faucetAmount: amount,
      maximumFee: parsedTransaction.gasLimit * feePerGas,
    };
  }

  private applyClaimReservation(reservation: ClaimReservation, direction: -1n | 1n): void {
    this.walletState.balance += direction * reservation.faucetAmount;
    this.walletState.nativeBalance += direction * reservation.maximumFee;
    if(this.tokenState)
      return;
    this.walletState.balance += direction * reservation.maximumFee;
    this.walletState.nativeBalance += direction * reservation.faucetAmount;
  }

  private assertClaimTransaction(transaction: SignedClaimTransaction): void {
    this.parseClaimTransaction(transaction);
  }

  private parseClaimTransaction(transaction: SignedClaimTransaction): ReturnType<typeof EthTx.createTxFromRLP> {
    if(!transaction || !Number.isSafeInteger(transaction.txNonce) || transaction.txNonce < 0 ||
      typeof transaction.txHex !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(transaction.txHex) ||
      typeof transaction.txHash !== "string" || !/^0x[0-9a-f]{64}$/i.test(transaction.txHash))
      throw new Error("Invalid signed claim transaction");
    if(Web3.utils.keccak256(transaction.txHex).toLowerCase() !== transaction.txHash.toLowerCase())
      throw new Error("Stored claim transaction hash does not match its signed bytes");

    let parsedTransaction: ReturnType<typeof EthTx.createTxFromRLP>;
    try {
      parsedTransaction = EthTx.createTxFromRLP(EthUtil.hexToBytes(transaction.txHex as EthUtil.PrefixedHexString), {
        common: this.chainCommon,
      });
    } catch(ex) {
      throw new Error("Stored claim transaction bytes are invalid");
    }
    if(!parsedTransaction.isSigned() || parsedTransaction.nonce !== BigInt(transaction.txNonce))
      throw new Error("Stored claim transaction nonce does not match its signed bytes");
    if(parsedTransaction.getSenderAddress().toString().toLowerCase() !== this.walletAddr.toLowerCase())
      throw new Error("Stored claim transaction was not signed by the faucet wallet");
    if(!("maxFeePerGas" in parsedTransaction) && !("gasPrice" in parsedTransaction))
      throw new Error("Stored claim transaction uses an unsupported fee model");
    return parsedTransaction;
  }

  private async sendTransaction(txhex: string, txnonce: number): Promise<[string, Promise<TransactionReceipt>]> {
    let txHash = await this.rpcPool.broadcastSendRawTransaction("0x" + txhex);

    return [txHash, this.awaitTransactionReceipt(txHash, txnonce)];
  }

  private async awaitTransactionReceipt(txhash: string, txnonce: number, retryAllErrors: boolean = false, signal?: AbortSignal): Promise<TransactionReceipt> {

    while(true) {
      this.throwIfAborted(signal);
      let receipt: TransactionReceipt;
      try {
        receipt = await this.web3.eth.getTransactionReceipt(txhash);
        this.throwIfAborted(signal);
        return receipt;
      } catch(ex) {
        if(retryAllErrors || ex instanceof TransactionNotFound || ex.toString().match(/CONNECTION ERROR/) || ex.toString().match(/invalid json response/)) {
          // just retry when RPC connection issue
          if(retryAllErrors && !(ex instanceof TransactionNotFound))
            ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.WARNING, "Claim receipt lookup for " + txhash + " failed; keeping it in reconciliation: " + ex.toString());
        } else {
          ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.ERROR, "Error while polling transaction receipt for " + txhash + ": " + ex.toString());
          console.log("err ", ex);
          throw ex;
        }
      }

      await this.waitForReceiptPoll(signal);
    }
  }

  private waitForReceiptPoll(signal?: AbortSignal): Promise<void> {
    if(!signal)
      return sleepPromise(this.txReceiptPollInterval);
    this.throwIfAborted(signal);

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;
      let onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(this.getAbortError(signal));
      };
      timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, this.txReceiptPollInterval);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if(signal?.aborted)
      throw this.getAbortError(signal);
  }

  private getAbortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error("Claim receipt watch aborted");
  }

}
