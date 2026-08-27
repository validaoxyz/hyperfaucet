import { IncomingMessage } from 'http';
import { clearInterval } from 'timers';
import { TransactionReceipt } from 'web3';
import { WebSocket } from 'ws';
import { faucetConfig } from "../config/FaucetConfig.js";
import { FaucetLogLevel, FaucetProcess } from "../common/FaucetProcess.js";
import { ServiceManager } from "../common/ServiceManager.js";
import { FaucetStatsLog } from "../services/FaucetStatsLog.js";
import { FaucetDatabase } from "../db/FaucetDatabase.js";
import { FaucetSessionStatus, FaucetSessionStoreData } from "../session/FaucetSession.js";
import { FaucetError } from '../common/FaucetError.js';
import { ModuleHookAction, ModuleManager } from '../modules/ModuleManager.js';
import { FaucetHttpServer } from '../webserv/FaucetHttpServer.js';
import { EthClaimNotificationClient, IEthClaimNotificationData } from './EthClaimNotificationClient.js';
import { EthWalletManager } from "./EthWalletManager.js";
import { EthWalletRefill } from './EthWalletRefill.js';
import {
  ActiveSignedClaimData,
  ClaimTxStatus,
  ConfirmedClaimData,
  EthClaimData,
  EthClaimInfo,
  FailedClaimData,
  isActiveSignedClaimData,
  isClaimData,
  PendingClaimData,
  PreparedClaimData,
  QueuedClaimData,
  RevertedClaimData,
  SignedClaimTransaction,
} from './EthClaim.js';

export {
  ClaimTxStatus,
  EthClaimData,
  EthClaimInfo,
  SignedClaimTransaction,
} from './EthClaim.js';

interface ClaimReceiptResult {
  status: boolean;
  block: number;
  fee: bigint;
  receipt: TransactionReceipt;
}

export type SessionClaimHookArgs = [
  claimInfo: EthClaimInfo,
  userInput: unknown,
  sessionData: FaucetSessionStoreData,
];

export class EthClaimManager {
  private initialized: boolean;
  private queueInterval: NodeJS.Timeout;
  private claimTxDict: {[session: string]: EthClaimInfo} = {};
  private claimTxQueue: EthClaimInfo[] = [];
  private pendingTxQueue: {[hash: string]: EthClaimInfo} = {};
  private historyTxDict: {[nonce: number]: EthClaimInfo} = {};
  private historyCleanupTimers = new Map<number, NodeJS.Timeout>();
  private confirmedCompletionTasks = new Map<string, Promise<void>>();
  private claimHttpServer: FaucetHttpServer;
  private queueTask: Promise<void> = null;
  private activeMutations = new Set<Promise<unknown>>();
  private lifecycleController = new AbortController();
  private shutdownPromise: Promise<void> = null;
  private lastClaimTxIdx: number = 1;
  private lastProcessedClaimTxIdx: number = 0;
  private lastConfirmedClaimTxIdx: number = 0;
  private lastClaimNotification: IEthClaimNotificationData;
  private broadcastRetryDelay = 2000;

  public async initialize(): Promise<void> {
    if(this.initialized)
      return;
    if(this.shutdownPromise)
      await this.shutdownPromise;

    this.resetRuntimeState();
    this.initialized = true;
    this.lifecycleController = new AbortController();
    this.shutdownPromise = null;

    let maxQueueIdx = 0;
    let storedSessions = await ServiceManager.GetService(FaucetDatabase).getSessions([
      FaucetSessionStatus.CLAIMING,
    ]);
    if(!this.initialized)
      return;

    let confirmedClaims: EthClaimInfo[] = [];
    for(let sessionData of storedSessions) {
      let storedClaim = sessionData.claim as unknown;
      let storedClaimIdx = this.getStoredClaimIdx(storedClaim);
      if(storedClaimIdx > maxQueueIdx)
        maxQueueIdx = storedClaimIdx;

      if(!isClaimData(storedClaim)) {
        this.logLegacyClaimQuarantine(sessionData.sessionId, storedClaim);
        continue;
      }

      let claimInfo: EthClaimInfo = {
        session: sessionData.sessionId,
        target: sessionData.targetAddr,
        amount: sessionData.dropAmount,
        claim: storedClaim,
      };
      switch(claimInfo.claim.claimStatus) {
        case ClaimTxStatus.QUEUE:
          this.claimTxQueue.push(claimInfo);
          this.claimTxDict[claimInfo.session] = claimInfo;
          break;
        case ClaimTxStatus.PREPARED:
        case ClaimTxStatus.PENDING:
          try {
            ServiceManager.GetService(EthWalletManager).reserveClaimTx(claimInfo.claim, BigInt(claimInfo.amount));
            this.claimTxDict[claimInfo.session] = claimInfo;
            this.pendingTxQueue[claimInfo.claim.txHash] = claimInfo;
            this.startClaimReconciliation(claimInfo);
          } catch(ex) {
            ServiceManager.GetService(FaucetProcess).emitLog(
              FaucetLogLevel.ERROR,
              "Claim " + claimInfo.session + " has invalid persisted signed transaction data and was quarantined. Manual reconciliation is required before changing the session: " + ex.toString()
            );
          }
          break;
        case ClaimTxStatus.CONFIRMED:
          this.claimTxDict[claimInfo.session] = claimInfo;
          confirmedClaims.push(claimInfo);
          break;
        default:
          ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.ERROR, "Cannot restore active claim " + claimInfo.session + ": unexpected terminal status '" + claimInfo.claim.claimStatus + "'");
          break;
      }
    }

    this.claimTxQueue.sort((a, b) => a.claim.claimIdx - b.claim.claimIdx);
    this.lastClaimTxIdx = maxQueueIdx + 1;

    for(let claimInfo of confirmedClaims)
      this.startConfirmedClaimCompletion(claimInfo);

    if(!this.initialized)
      return;
    this.claimHttpServer = ServiceManager.GetService(FaucetHttpServer);
    this.claimHttpServer.addWssEndpoint("claim", /^\/ws\/claim($|\?)/, (req, ws, ip) => this.processClaimNotificationWebSocket(req, ws, ip));
    this.queueInterval = setInterval(() => this.processQueue(), 2000);
  }

  public dispose(): Promise<void> {
    if(this.shutdownPromise)
      return this.shutdownPromise;
    if(!this.initialized)
      return Promise.resolve();

    this.initialized = false;
    this.lifecycleController.abort(new Error("Claim manager is shutting down"));
    this.claimHttpServer?.removeWssEndpoint("claim");
    this.claimHttpServer = null;

    EthClaimNotificationClient.resetClaimNotification();
    if(this.queueInterval) {
      clearInterval(this.queueInterval);
      this.queueInterval = null;
    }
    this.historyCleanupTimers.forEach((timer) => clearTimeout(timer));
    this.historyCleanupTimers.clear();

    this.shutdownPromise = this.drainMutations();
    return this.shutdownPromise;
  }

  private resetRuntimeState(): void {
    this.claimTxDict = {};
    this.claimTxQueue = [];
    this.pendingTxQueue = {};
    this.historyTxDict = {};
    this.confirmedCompletionTasks.clear();
    this.queueTask = null;
    this.lastClaimTxIdx = 1;
    this.lastProcessedClaimTxIdx = 0;
    this.lastConfirmedClaimTxIdx = 0;
    this.lastClaimNotification = null;
  }

  private getStoredClaimIdx(claim: unknown): number {
    if(!claim || typeof claim !== "object")
      return 0;
    let claimIdx = (claim as {claimIdx?: unknown}).claimIdx;
    return Number.isSafeInteger(claimIdx) && Number(claimIdx) > 0 ? Number(claimIdx) : 0;
  }

  private logLegacyClaimQuarantine(sessionId: string, claim: unknown): void {
    let status = claim && typeof claim === "object" ? (claim as {claimStatus?: unknown}).claimStatus : undefined;
    let statusLabel = typeof status === "string" ? status : "unknown";
    let processingWarning = statusLabel === "processing"
      ? " Legacy PROCESSING may already have reached the network and must never be replayed."
      : "";
    ServiceManager.GetService(FaucetProcess).emitLog(
      FaucetLogLevel.ERROR,
      "Claim " + sessionId + " uses legacy claim state '" + statusLabel + "' and was quarantined." + processingWarning + " Inspect the wallet nonce and chain history, then resolve the session manually."
    );
  }

  private async processClaimNotificationWebSocket(req: IncomingMessage, ws: WebSocket, remoteIp: string): Promise<void> {
    let sessionId: string;
    try {
      let urlParts = req.url.split("?");
      let url = new URLSearchParams(urlParts[1]);
      sessionId = url.get("session");

      let sessionInfo: FaucetSessionStoreData;
      if(!sessionId || !(sessionInfo = await ServiceManager.GetService(FaucetDatabase).getSession(sessionId)))
        throw "session not found";
      if(sessionInfo.status !== FaucetSessionStatus.CLAIMING)
        throw "session not claiming";

      new EthClaimNotificationClient(ws, sessionInfo.claim.claimIdx);
    } catch(ex) {
      ws.send(JSON.stringify({
        action: "error",
        data: { reason: ex.toString() },
      }));
      ws.close();
    }
  }

  public getTransactionQueue(queueOnly?: boolean): EthClaimInfo[] {
    let transactions = this.claimTxQueue.slice();
    if(!queueOnly) {
      transactions.push(...Object.values(this.pendingTxQueue));
      transactions.push(...Object.values(this.historyTxDict));
    }
    return transactions;
  }

  public getQueuedAmount(): bigint {
    let queuedAmount = this.claimTxQueue.reduce(
      (total, claimTx) => total + BigInt(claimTx.amount),
      0n,
    );
    return Object.values(this.pendingTxQueue).reduce(
      (total, claimTx) => total + BigInt(claimTx.amount),
      queuedAmount,
    );
  }

  public getLastProcessedClaimIdx(): number {
    return this.lastProcessedClaimTxIdx;
  }

  public createSessionClaim(sessionData: FaucetSessionStoreData, userInput: unknown): Promise<EthClaimInfo> {
    if(!this.initialized)
      return Promise.reject(new FaucetError("SHUTTING_DOWN", "cannot claim session: faucet is shutting down"));
    return this.trackMutation(this.createSessionClaimInternal(sessionData, userInput));
  }

  private async createSessionClaimInternal(sessionData: FaucetSessionStoreData, userInput: unknown): Promise<EthClaimInfo> {
    if(sessionData.status !== FaucetSessionStatus.CLAIMABLE)
      throw new FaucetError("NOT_CLAIMABLE", "cannot claim session: not claimable (state: " + sessionData.status + ")");
    if(BigInt(sessionData.dropAmount) < BigInt(faucetConfig.minDropAmount))
      throw new FaucetError("AMOUNT_TOO_LOW", "drop amount lower than minimum");

    let maxDropAmount = BigInt(faucetConfig.maxDropAmount);
    if(sessionData.data["overrideMaxDropAmount"])
      maxDropAmount = BigInt(sessionData.data["overrideMaxDropAmount"]);
    let amount = BigInt(sessionData.dropAmount) > maxDropAmount ? maxDropAmount.toString() : sessionData.dropAmount;

    let claimInfo: EthClaimInfo = {
      session: sessionData.sessionId,
      target: sessionData.targetAddr,
      amount,
      claim: null,
    };

    try {
      let hookArgs: SessionClaimHookArgs = [claimInfo, userInput, sessionData];
      await ServiceManager.GetService(ModuleManager).processActionHooks([], ModuleHookAction.SessionClaim, hookArgs);
    } catch(ex) {
      if(ex instanceof FaucetError)
        throw ex;
      throw new FaucetError("INTERNAL_ERROR", "claimSession failed: " + ex.toString());
    }

    if(!this.initialized)
      throw new FaucetError("SHUTTING_DOWN", "cannot claim session: faucet is shutting down");

    if(this.claimTxDict[sessionData.sessionId])
      throw new FaucetError("RACE_CLAIMING", "cannot claim session: already claiming (race condition)");

    let queuedClaim: QueuedClaimData = {
      claimFormat: 2,
      claimIdx: this.lastClaimTxIdx++,
      claimStatus: ClaimTxStatus.QUEUE,
      claimTime: Math.floor(Date.now() / 1000),
    };
    claimInfo.claim = queuedClaim;

    let created = await ServiceManager.GetService(FaucetDatabase).tryCreateClaim(claimInfo.session, claimInfo.amount, queuedClaim);
    if(!created)
      throw new FaucetError("RACE_CLAIMING", "cannot claim session: claim state changed concurrently");

    sessionData.status = FaucetSessionStatus.CLAIMING;
    sessionData.dropAmount = claimInfo.amount;
    sessionData.claim = queuedClaim;
    this.claimTxQueue.push(claimInfo);
    this.claimTxDict[claimInfo.session] = claimInfo;
    return claimInfo;
  }

  public processQueue(): Promise<void> {
    if(!this.initialized)
      return Promise.resolve();
    if(this.queueTask)
      return this.queueTask;

    let task = this.trackMutation(this.processQueueInternal());
    this.queueTask = task;
    void task.then(
      () => { if(this.queueTask === task) this.queueTask = null; },
      () => { if(this.queueTask === task) this.queueTask = null; }
    );
    return task;
  }

  private async processQueueInternal(): Promise<void> {

    try {
      let walletState = ServiceManager.GetService(EthWalletManager).getWalletState();
      while(this.initialized && Object.keys(this.pendingTxQueue).length < faucetConfig.ethMaxPending && this.claimTxQueue.length > 0) {
        if(faucetConfig.ethQueueNoFunds && (
          !walletState.ready ||
          walletState.balance - BigInt(faucetConfig.spareFundsAmount) < BigInt(this.claimTxQueue[0].amount) ||
          walletState.nativeBalance <= BigInt(faucetConfig.ethTxGasLimit) * BigInt(faucetConfig.ethTxMaxFee)
        ))
          break;

        let claimTx = this.claimTxQueue.shift();
        this.lastProcessedClaimTxIdx = claimTx.claim.claimIdx;
        await this.processQueueTx(claimTx);
      }

      if(!this.initialized)
        return;

      let now = Math.floor(Date.now() / 1000);
      let walletRefreshTime = walletState.ready ? 600 : 10;
      let walletManager = ServiceManager.GetService(EthWalletManager);
      if(Object.keys(this.pendingTxQueue).length === 0 && now - walletManager.getLastWalletRefresh() > walletRefreshTime)
        await this.untilShutdown(walletManager.loadWalletState());

      if(faucetConfig.ethRefillContract && walletState.ready)
        await this.untilShutdown(ServiceManager.GetService(EthWalletRefill).processWalletRefill());

      if(!this.lastClaimNotification || this.lastClaimNotification.processedIdx !== this.lastProcessedClaimTxIdx || this.lastClaimNotification.confirmedIdx !== this.lastConfirmedClaimTxIdx) {
        this.lastClaimNotification = {
          processedIdx: this.lastProcessedClaimTxIdx,
          confirmedIdx: this.lastConfirmedClaimTxIdx,
        };
        EthClaimNotificationClient.broadcastClaimNotification(this.lastClaimNotification);
      }
    } catch(ex) {
      if(!this.initialized)
        return;
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.ERROR, "Exception in transaction queue processing: " + ex.toString() + (ex?.stack ? "\r\n   Stack Trace: " + ex.stack : ""));
    }
  }

  private async processQueueTx(claimTx: EthClaimInfo): Promise<void> {
    if(claimTx.claim.claimStatus !== ClaimTxStatus.QUEUE)
      return;

    let walletManager = ServiceManager.GetService(EthWalletManager);
    let walletState = walletManager.getWalletState();
    if(!walletState.ready) {
      await this.failQueuedClaim(claimTx, "Network RPC is currently unreachable.");
      return;
    }
    let transaction: SignedClaimTransaction;
    try {
      transaction = await this.untilShutdown(walletManager.prepareClaimTx(claimTx.target, BigInt(claimTx.amount)));
    } catch(ex) {
      if(!this.initialized)
        return;
      await this.failQueuedClaim(claimTx, "Transaction preparation failed: " + ex.toString());
      return;
    }
    if(!walletManager.canReserveClaimTx(transaction, BigInt(claimTx.amount))) {
      await this.failQueuedClaim(claimTx, "Faucet wallet is out of funds.");
      return;
    }

    let preparedClaim: PreparedClaimData = {
      claimFormat: 2,
      claimIdx: claimTx.claim.claimIdx,
      claimStatus: ClaimTxStatus.PREPARED,
      claimTime: claimTx.claim.claimTime,
      ...transaction,
    };
    walletManager.reserveClaimTx(preparedClaim, BigInt(claimTx.amount));
    try {
      if(!await this.transitionClaim(claimTx, claimTx.claim, preparedClaim)) {
        walletManager.cancelClaimTx(preparedClaim);
        return;
      }
    } catch(ex) {
      walletManager.cancelClaimTx(preparedClaim);
      throw ex;
    }
    if(!this.initialized)
      return;

    this.pendingTxQueue[preparedClaim.txHash] = claimTx;
    this.startClaimReconciliation(claimTx);
  }

  private async failQueuedClaim(claimTx: EthClaimInfo, message: string): Promise<void> {
    if(claimTx.claim.claimStatus !== ClaimTxStatus.QUEUE)
      return;
    let failedClaim: FailedClaimData = {
      claimFormat: 2,
      claimIdx: claimTx.claim.claimIdx,
      claimStatus: ClaimTxStatus.FAILED,
      claimTime: claimTx.claim.claimTime,
      txError: message,
    };
    if(await this.transitionClaim(claimTx, claimTx.claim, failedClaim))
      delete this.claimTxDict[claimTx.session];
  }

  private startClaimReconciliation(claimTx: EthClaimInfo): void {
    if(!this.initialized)
      return;
    void this.trackMutation(this.rebroadcastClaim(claimTx)).catch((ex) => this.logReconciliationError(claimTx, ex));
    void this.trackMutation(this.awaitTxReceipt(claimTx)).catch((ex) => this.logReconciliationError(claimTx, ex));
  }

  private async rebroadcastClaim(claimTx: EthClaimInfo): Promise<void> {
    let walletManager = ServiceManager.GetService(EthWalletManager);
    while(this.initialized && this.claimTxDict[claimTx.session] === claimTx && isActiveSignedClaimData(claimTx.claim)) {
      let transaction = this.getSignedTransaction(claimTx.claim);
      try {
        await this.untilShutdown(walletManager.broadcastClaimTx(transaction));
        if(!this.initialized)
          return;
        if(claimTx.claim.claimStatus === ClaimTxStatus.PREPARED) {
          let preparedClaim = claimTx.claim;
          let pendingClaim: PendingClaimData = {
            ...preparedClaim,
            claimStatus: ClaimTxStatus.PENDING,
          };
          await this.transitionClaim(claimTx, preparedClaim, pendingClaim);
        }
        ServiceManager.GetService(FaucetProcess).emitLog(
          FaucetLogLevel.INFO,
          "Submitted claim transaction " + claimTx.session + " [" + walletManager.readableAmount(BigInt(claimTx.amount)) + "] to: " + claimTx.target + ": " + transaction.txHash
        );
        return;
      } catch(ex) {
        if(!this.initialized)
          return;
        ServiceManager.GetService(FaucetProcess).emitLog(
          FaucetLogLevel.WARNING,
          "Claim transaction " + transaction.txHash + " has no trustworthy broadcast acknowledgement; retrying the same signed bytes: " + ex.toString()
        );
        await this.waitForRetry();
      }
    }
  }

  private async awaitTxReceipt(claimTx: EthClaimInfo): Promise<void> {
    let walletManager = ServiceManager.GetService(EthWalletManager);
    while(this.initialized && this.claimTxDict[claimTx.session] === claimTx && isActiveSignedClaimData(claimTx.claim)) {
      let transaction = this.getSignedTransaction(claimTx.claim);
      try {
        let receipt = await this.untilShutdown(walletManager.watchClaimTx(transaction, this.lifecycleController.signal));
        if(!this.initialized)
          return;
        await this.settleClaim(claimTx, receipt);
        return;
      } catch(ex) {
        if(!this.initialized)
          return;
        ServiceManager.GetService(FaucetProcess).emitLog(
          FaucetLogLevel.WARNING,
          "Claim transaction " + transaction.txHash + " receipt reconciliation failed; the claim remains active: " + ex.toString()
        );
        await this.waitForRetry();
      }
    }
  }

  private async settleClaim(claimTx: EthClaimInfo, txData: ClaimReceiptResult): Promise<void> {
    for(let attempt = 0; attempt < 3; attempt++) {
      if(!isActiveSignedClaimData(claimTx.claim))
        return;
      let currentClaim = claimTx.claim;
      let terminalClaim: ConfirmedClaimData | RevertedClaimData;
      if(txData.status) {
        terminalClaim = {
          ...currentClaim,
          claimStatus: ClaimTxStatus.CONFIRMED,
          txBlock: txData.block,
          txFee: txData.fee.toString(),
        };
      } else {
        terminalClaim = {
          ...currentClaim,
          claimStatus: ClaimTxStatus.REVERTED,
          txBlock: txData.block,
          txFee: txData.fee.toString(),
          txError: "Transaction reverted",
        };
      }

      if(!await this.transitionClaim(claimTx, currentClaim, terminalClaim))
        continue;

      if(terminalClaim.claimStatus === ClaimTxStatus.CONFIRMED) {
        await this.getConfirmedClaimCompletion(claimTx);
      } else {
        this.finishClaimReconciliation(claimTx, terminalClaim);
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.WARNING, "Claim transaction for " + claimTx.target + " reverted: " + terminalClaim.txHash);
      }
      return;
    }
  }

  private finishClaimReconciliation(claimTx: EthClaimInfo, terminalClaim: ConfirmedClaimData | RevertedClaimData): void {
    if(this.pendingTxQueue[terminalClaim.txHash] === claimTx)
      delete this.pendingTxQueue[terminalClaim.txHash];
    if(this.claimTxDict[claimTx.session] === claimTx)
      delete this.claimTxDict[claimTx.session];
    ServiceManager.GetService(EthWalletManager).releaseClaimTx(
      terminalClaim,
      {
        outcome: terminalClaim.claimStatus === ClaimTxStatus.CONFIRMED ? "transferred" : "reverted",
        fee: BigInt(terminalClaim.txFee),
      },
    );
    if(terminalClaim.claimStatus === ClaimTxStatus.CONFIRMED)
      this.lastConfirmedClaimTxIdx = terminalClaim.claimIdx;

    this.historyTxDict[terminalClaim.txNonce] = claimTx;
    let existingTimer = this.historyCleanupTimers.get(terminalClaim.txNonce);
    if(existingTimer)
      clearTimeout(existingTimer);
    if(!this.initialized)
      return;

    let cleanupTimer = setTimeout(() => {
      if(this.historyTxDict[terminalClaim.txNonce] === claimTx)
        delete this.historyTxDict[terminalClaim.txNonce];
      if(this.historyCleanupTimers.get(terminalClaim.txNonce) === cleanupTimer)
        this.historyCleanupTimers.delete(terminalClaim.txNonce);
    }, 30 * 60 * 1000);
    this.historyCleanupTimers.set(terminalClaim.txNonce, cleanupTimer);
  }

  private startConfirmedClaimCompletion(claimTx: EthClaimInfo): void {
    void this.trackMutation(this.getConfirmedClaimCompletion(claimTx)).catch((ex) => {
      this.logReconciliationError(claimTx, ex);
    });
  }

  private getConfirmedClaimCompletion(claimTx: EthClaimInfo): Promise<void> {
    let existing = this.confirmedCompletionTasks.get(claimTx.session);
    if(existing)
      return existing;
    let task = this.completeConfirmedClaim(claimTx).finally(() => {
      if(this.confirmedCompletionTasks.get(claimTx.session) === task)
        this.confirmedCompletionTasks.delete(claimTx.session);
    });
    this.confirmedCompletionTasks.set(claimTx.session, task);
    return task;
  }

  private async completeConfirmedClaim(claimTx: EthClaimInfo): Promise<void> {
    while(this.initialized && claimTx.claim.claimStatus === ClaimTxStatus.CONFIRMED) {
      try {
        await ServiceManager.GetService(ModuleManager).processActionHooks(
          [],
          ModuleHookAction.SessionClaimed,
          [claimTx],
        );
        if(!this.initialized)
          return;
        if(!await this.finalizeConfirmedClaim(claimTx))
          return;

        this.finishClaimReconciliation(claimTx, claimTx.claim);
        try {
          ServiceManager.GetService(FaucetStatsLog).addClaimStats(claimTx);
        } catch(ex) {
          ServiceManager.GetService(FaucetProcess).emitLog(
            FaucetLogLevel.ERROR,
            "Could not record claim statistics for " + claimTx.session + ": " + ex.toString(),
          );
        }
        return;
      } catch(ex) {
        if(!this.initialized)
          return;
        ServiceManager.GetService(FaucetProcess).emitLog(
          FaucetLogLevel.ERROR,
          "Post-confirmation accounting failed for claim " + claimTx.session + "; the durable claim remains pending finalization: " + ex.toString(),
        );
        await this.waitForRetry();
      }
    }
  }

  private async finalizeConfirmedClaim(claimTx: EthClaimInfo): Promise<boolean> {
    let database = ServiceManager.GetService(FaucetDatabase);
    while(this.initialized && claimTx.claim.claimStatus === ClaimTxStatus.CONFIRMED) {
      try {
        if(await database.finalizeConfirmedClaim(claimTx.session, claimTx.claim))
          return true;
      } catch {}

      let storedSession: FaucetSessionStoreData;
      try {
        storedSession = await database.getSession(claimTx.session);
      } catch(ex) {
        if(!this.initialized)
          return false;
        await this.waitForRetry();
        continue;
      }
      if(!storedSession || !isClaimData(storedSession.claim))
        return false;
      claimTx.claim = storedSession.claim;
      if(
        storedSession.status === FaucetSessionStatus.FINISHED
        && storedSession.claim.claimStatus === ClaimTxStatus.CONFIRMED
      ) {
        return true;
      }
      if(
        storedSession.status === FaucetSessionStatus.CLAIMING
        && storedSession.claim.claimStatus === ClaimTxStatus.CONFIRMED
      ) {
        await this.waitForRetry();
        continue;
      }
      this.reconcileObservedTerminal(claimTx, storedSession.claim);
      return false;
    }
    return false;
  }

  private async transitionClaim(claimTx: EthClaimInfo, expectedClaim: EthClaimData, claim: EthClaimData): Promise<boolean> {
    let database = ServiceManager.GetService(FaucetDatabase);
    while(this.initialized) {
      let transitionError: unknown;
      try {
        if(await database.compareAndSetClaim(claimTx.session, expectedClaim, claim)) {
          claimTx.claim = claim;
          return true;
        }
      } catch(ex) {
        transitionError = ex;
      }

      let storedSession: FaucetSessionStoreData;
      try {
        storedSession = await database.getSession(claimTx.session);
      } catch(ex) {
        if(!this.initialized)
          return false;
        await this.waitForRetry();
        continue;
      }
      if(storedSession && isClaimData(storedSession.claim)) {
        claimTx.claim = storedSession.claim;
        if(
          this.claimDataEquals(storedSession.claim, claim)
          && !(
            claim.claimStatus === ClaimTxStatus.CONFIRMED
            && storedSession.status === FaucetSessionStatus.FINISHED
          )
        )
          return true;
        if(
          storedSession.status === FaucetSessionStatus.CLAIMING
          && this.claimDataEquals(storedSession.claim, expectedClaim)
        ) {
          await this.waitForRetry();
          continue;
        }
        this.reconcileObservedTerminal(claimTx, storedSession.claim);
      }
      if(transitionError)
        throw transitionError;
      return false;
    }
    return false;
  }

  private claimDataEquals(left: EthClaimData, right: EthClaimData): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  private reconcileObservedTerminal(claimTx: EthClaimInfo, claim: EthClaimData): void {
    let ownsClaim = this.claimTxDict[claimTx.session] === claimTx;
    if(claim.claimStatus === ClaimTxStatus.CONFIRMED) {
      if(ownsClaim)
        this.startConfirmedClaimCompletion(claimTx);
    } else if(claim.claimStatus === ClaimTxStatus.REVERTED) {
      ownsClaim ||= this.pendingTxQueue[claim.txHash] === claimTx;
      if(ownsClaim)
        this.finishClaimReconciliation(claimTx, claim);
    } else if(claim.claimStatus === ClaimTxStatus.FAILED && ownsClaim) {
      delete this.claimTxDict[claimTx.session];
      this.claimTxQueue = this.claimTxQueue.filter((queuedClaim) => queuedClaim !== claimTx);
    }
  }

  private getSignedTransaction(claim: ActiveSignedClaimData): SignedClaimTransaction {
    return {
      txHash: claim.txHash,
      txHex: claim.txHex,
      txNonce: claim.txNonce,
    };
  }

  private logReconciliationError(claimTx: EthClaimInfo, error: unknown): void {
    ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.ERROR, "Unexpected reconciliation error for claim " + claimTx.session + ": " + error?.toString());
  }

  private trackMutation<T>(task: Promise<T>): Promise<T> {
    this.activeMutations.add(task);
    void task.then(
      () => this.activeMutations.delete(task),
      () => this.activeMutations.delete(task)
    );
    return task;
  }

  private async drainMutations(): Promise<void> {
    while(this.activeMutations.size > 0)
      await Promise.allSettled(Array.from(this.activeMutations));
  }

  private untilShutdown<T>(task: Promise<T>): Promise<T> {
    let signal = this.lifecycleController.signal;
    if(signal.aborted)
      return Promise.reject(signal.reason);

    return new Promise<T>((resolve, reject) => {
      let onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      task.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  private waitForRetry(): Promise<void> {
    let signal = this.lifecycleController.signal;
    if(signal.aborted)
      return Promise.resolve();

    return new Promise((resolve) => {
      let timer: NodeJS.Timeout;
      let complete = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", complete);
        resolve();
      };
      timer = setTimeout(complete, this.broadcastRetryDelay);
      signal.addEventListener("abort", complete, { once: true });
    });
  }
}
