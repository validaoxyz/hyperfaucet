import * as http from 'node:http';
import { FaucetWorkers, IFaucetChildProcess } from '../../common/FaucetWorker.js';
import { ServiceManager } from '../../common/ServiceManager.js';
import { PromiseDfd } from '../../utils/PromiseDfd.js';
import { Socket } from 'node:net';
import { FaucetSession, FaucetSessionStatus } from '../../session/FaucetSession.js';
import { IPoWConfig } from './PoWConfig.js';
import { PoWModule } from './PoWModule.js';
import { FaucetLogLevel, FaucetProcess } from '../../common/FaucetProcess.js';
import { EthClaimManager } from '../../eth/EthClaimManager.js';
import { EthWalletManager } from '../../eth/EthWalletManager.js';
import { ProcessLoadTracker } from '../../utils/ProcessLoadTracker.js';
import { FaucetStatsLog } from '../../services/FaucetStatsLog.js';
import { toStoredClientFailure } from '../../webserv/PublicErrors.js';

const MAX_UINT256 = (1n << 256n) - 1n;
const SESSION_TEARDOWN_TIMEOUT_MS = 5_000;

type PoWServerLifecycle = "starting" | "ready" | "closing" | "closed";

interface IPendingSessionCloseAck {
  sessionId: string;
  result: PromiseDfd<void>;
  timeout: NodeJS.Timeout;
}

type PendingSessionDestroy = {
  failed: boolean;
  result: PromiseDfd<void>;
} & (
  | {kind: "waiting"}
  | {kind: "queued"}
  | {kind: "sending"; timeout: NodeJS.Timeout}
  | {kind: "awaiting-child-close"; error: Error}
);
type SendingSessionDestroy = Extract<PendingSessionDestroy, {kind: "sending"}>;

export class PoWServer {
  private module: PoWModule;
  private serverId: string;
  private worker: IFaucetChildProcess;
  private readyDfd: PromiseDfd<void>;
  private shutdownDfd: PromiseDfd<void>;
  private lifecycle: PoWServerLifecycle = "starting";
  private lifecycleError: Error | null = null;
  private sessions: {[sessionId: string]: FaucetSession} = {};
  private acceptingMessages = true;
  private messageOperations = new Set<Promise<void>>();
  private sessionMessageOperations = new Map<string, Set<Promise<void>>>();
  private pendingSessionDestroys = new Map<string, PendingSessionDestroy>();
  private pendingSessionCloseAcks = new Map<number, IPendingSessionCloseAck>();
  private nextSessionCloseId = 1;
  private firstMessageOperationError: Error | null = null;
  private messageOperationErrorCount = 0;
  private shutdownPromise: Promise<void> | null = null;
  private readonly workerMessageHandler: (message: any, handle?: any) => void;

  public constructor(module: PoWModule, serverId: string, worker?: IFaucetChildProcess) {
    this.module = module;
    this.serverId = serverId;
    this.worker = worker || ServiceManager.GetService(FaucetWorkers).createChildProcess("pow-server");
    this.readyDfd = new PromiseDfd<void>();
    this.shutdownDfd = new PromiseDfd<void>();
    void this.readyDfd.promise.catch(() => undefined);
    this.workerMessageHandler = (message, handle) => this.onMessage(message, handle);
    this.worker.childProcess.on("message", this.workerMessageHandler);
    this.worker.childProcess.once("close", () => {
      this.acceptingMessages = false;
      this.worker.childProcess.off("message", this.workerMessageHandler);
      this.closeLifecycle("closed");
      this.resolveSessionCloseAcksAfterWorkerClose();
      this.completeSessionDestroysAfterWorkerClose();
      this.sessions = {};
      this.shutdownDfd.resolve();
    });
  }

  public getServerId(): string {
    return this.serverId;
  }

  private sendMessage(message: any) {
    if(!this.acceptingMessages)
      return;
    this.worker.childProcess.send(message);
  }

  private sendMessageConfirmed(message: any): Promise<void> {
    if(!this.acceptingMessages)
      return Promise.reject(new Error("PoW worker is not accepting messages"));

    let sendAttempt = new Promise<void>((resolve, reject) => {
      try {
        this.worker.childProcess.send(message, (error) => error ? reject(error) : resolve());
      } catch(error) {
        reject(error);
      }
    });
    return Promise.race([sendAttempt, this.shutdownDfd.promise]);
  }

  private onMessage(message: any, handle?: any) {
    if(!this.acceptingMessages)
      return;
    switch(message.action) {
      case "init":
        if(this.lifecycle !== "starting")
          break;
        this.sendMessage({
          action: "pow-update-config",
          config: this.module.getModuleConfig(),
        });
        this.lifecycle = "ready";
        this.readyDfd.resolve();
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Started PoW worker process [" + this.serverId + "]");
        break;
      case "pow-session-abort":
        if(this.pendingSessionDestroys.has(message.sessionId))
          break;
        this.trackMessageOperation(
          this.onSessionAbort(message.sessionId, message.type, message.reason, message.dirtyProps),
          "session abort",
          message.sessionId,
        );
        break;
      case "pow-session-reward":
        if(this.pendingSessionDestroys.has(message.sessionId))
          break;
        this.trackMessageOperation(
          this.onSessionReward(message.sessionId, message.reqId, message.amount, message.type, message.dirtyProps),
          "session reward",
          message.sessionId,
        );
        break;
      case "pow-session-close-ack":
        this.onSessionCloseAck(message.closeId, message.sessionId);
        break;
      case "pow-session-flush":
        this.onSessionFlush(message.sessionId, message.dirtyProps);
        break;
      case "pow-sysload":
        this.onSysLoad(message.cpu, message.memory, message.eventLoopLag, message.activeSessions);
        break;
    }
  }

  private trackMessageOperation(operation: Promise<void>, description: string, sessionId?: string): void {
    this.messageOperations.add(operation);
    let sessionOperations: Set<Promise<void>> | undefined;
    if(sessionId) {
      sessionOperations = this.sessionMessageOperations.get(sessionId);
      if(!sessionOperations) {
        sessionOperations = new Set<Promise<void>>();
        this.sessionMessageOperations.set(sessionId, sessionOperations);
      }
      sessionOperations.add(operation);
    }
    void operation.catch((error) => {
      let errorMessage = error instanceof Error ? error.message : String(error);
      if(!this.firstMessageOperationError) {
        this.firstMessageOperationError = new Error(
          "PoW server " + description + " failed: " + errorMessage,
          {cause: error},
        );
      }
      if(this.messageOperationErrorCount < Number.MAX_SAFE_INTEGER)
        this.messageOperationErrorCount++;
      try {
        ServiceManager.GetService(FaucetProcess).emitLog(
          FaucetLogLevel.ERROR,
          "PoW server " + description + " failed: " + errorMessage,
        );
      } catch {}
    });
    let releaseOperation = () => {
      this.messageOperations.delete(operation);
      if(!sessionId || !sessionOperations)
        return;
      sessionOperations.delete(operation);
      if(sessionOperations.size === 0)
        this.sessionMessageOperations.delete(sessionId);
      this.flushPendingSessionDestroy(sessionId);
    };
    void operation.then(releaseOperation, releaseOperation);
  }

  private async onSessionAbort(sessionId: string, type: string, reason: string, dirtyProps: {[key: string]: any}) {
    let session = this.sessions[sessionId];
    if(!session)
      return;

    for(let key in dirtyProps) {
      session.setSessionData(key, dirtyProps[key]);
    }

    let ethWalletManager = ServiceManager.GetService(EthWalletManager);
    switch(type) {
      case "slashed": {
        let forfeitPromise = session.subPenalty(MAX_UINT256);
        let failurePromise = session.setSessionFailed("SLASHED", reason);
        await forfeitPromise;
        await failurePromise;
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "session slashed: " + session.getSessionId() + " (" + reason + ") " + ethWalletManager.readableAmount(session.getDropAmount()));
        break;
      }
      case "timeout":
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "session idle timeout: " + session.getSessionId() + " (" + reason + ") " + ethWalletManager.readableAmount(session.getDropAmount()));
        break;
      case "closed":
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "session client closed: " + session.getSessionId() + " (" + reason + ") " + ethWalletManager.readableAmount(session.getDropAmount()));
        break;
    }

    await this.module.processPoWSessionClose(session);

    let sessionInfo = await session.getSessionInfo();
    if(sessionInfo.status === FaucetSessionStatus.FAILED)
      Object.assign(sessionInfo, toStoredClientFailure(sessionInfo.failedCode));
    await this.sendSessionClose({
      action: "pow-session-close",
      sessionId: sessionId,
      info: sessionInfo,
    });
  }

  private async sendSessionClose(message: {action: "pow-session-close"; sessionId: string; info: unknown}): Promise<void> {
    if(!this.acceptingMessages)
      return;

    let closeId = this.nextSessionCloseId++;
    let result = new PromiseDfd<void>();
    void result.promise.catch(() => undefined);
    let timeout = setTimeout(() => {
      let timedOut = this.takeSessionCloseAck(closeId);
      if(timedOut)
        timedOut.result.reject(new Error("PoW worker did not acknowledge session close"));
    }, SESSION_TEARDOWN_TIMEOUT_MS);
    timeout.unref?.();
    let pending: IPendingSessionCloseAck = {sessionId: message.sessionId, result, timeout};
    this.pendingSessionCloseAcks.set(closeId, pending);

    try {
      await Promise.race([
        pending.result.promise,
        this.sendMessageConfirmed({...message, closeId}).then(() => pending.result.promise),
      ]);
    } catch(error) {
      this.takeSessionCloseAck(closeId);
      this.beginShutdownAfterIpcFailure("session close", error);
      await this.shutdownDfd.promise;
      throw this.toError(error);
    }
  }

  private onSessionCloseAck(closeId: unknown, sessionId: unknown): void {
    if(!Number.isSafeInteger(closeId) || typeof sessionId !== "string")
      return;
    let pending = this.pendingSessionCloseAcks.get(closeId as number);
    if(!pending || pending.sessionId !== sessionId)
      return;
    this.takeSessionCloseAck(closeId as number)?.result.resolve();
  }

  private takeSessionCloseAck(closeId: number): IPendingSessionCloseAck | undefined {
    let pending = this.pendingSessionCloseAcks.get(closeId);
    if(!pending)
      return undefined;
    this.pendingSessionCloseAcks.delete(closeId);
    clearTimeout(pending.timeout);
    return pending;
  }

  private resolveSessionCloseAcksAfterWorkerClose(): void {
    for(let closeId of [...this.pendingSessionCloseAcks.keys()])
      this.takeSessionCloseAck(closeId)?.result.resolve();
  }

  private beginShutdownAfterIpcFailure(description: string, error: unknown): void {
    try {
      ServiceManager.GetService(FaucetProcess).emitLog(
        FaucetLogLevel.ERROR,
        "PoW worker " + description + " failed: " + this.toError(error).message,
      );
    } catch {}
    this.module.stopServer(this);
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  private async onSessionReward(sessionId: string, reqId: number, rawAmount: unknown, type: string, dirtyProps: {[key: string]: any}): Promise<void> {
    try {
      if(typeof rawAmount !== "string" || rawAmount.length > 128 || !/^-?\d+$/.test(rawAmount))
        throw new Error("Invalid PoW reward amount");
      let amount = BigInt(rawAmount);
      let session = this.sessions[sessionId];
      if(!session)
        throw new Error("PoW reward session is no longer available");

      for(let key in dirtyProps)
        session.setSessionData(key, dirtyProps[key]);

      let appliedAmount: bigint;
      if(amount < 0n)
        appliedAmount = (await session.subPenalty(amount * -1n)) * -1n;
      else
        appliedAmount = await session.addReward(amount);

      let faucetStats = ServiceManager.GetService(FaucetStatsLog);
      switch(type) {
        case "verify":
          if(appliedAmount > 0n) {
            faucetStats.statVerifyReward += appliedAmount;
            faucetStats.statVerifyCount++;
          } else {
            faucetStats.statVerifyPenalty += appliedAmount;
            faucetStats.statVerifyMisses++;
          }
          break;
        case "share":
          faucetStats.statShareRewards += appliedAmount;
          faucetStats.statShareCount++;
          break;
      }

      let balance = session.getDropAmount().toString();
      this.sendMessage({
        action: "pow-session-reward",
        sessionId: sessionId,
        reqId: reqId,
        amount: appliedAmount.toString(),
        balance: balance,
      });
    } catch(error) {
      this.sendMessage({
        action: "pow-session-reward-error",
        sessionId,
        reqId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private onSessionFlush(sessionId: string, dirtyProps: {[key: string]: any}) {
    let session = this.sessions[sessionId];
    if(!session)
      return;

    for(let key in dirtyProps) {
      session.setSessionData(key, dirtyProps[key]);
    }
  }

  public getSessionCount(): number {
    return Object.keys(this.sessions).length;
  }

  public isAcceptingSessions(): boolean {
    return this.lifecycle === "starting" || this.lifecycle === "ready";
  }

  public getReadyPromise(): Promise<void> {
    return this.readyDfd.promise;
  }

  public shutdown(): Promise<void> {
    if(!this.shutdownPromise) {
      this.closeLifecycle("closing");
      this.shutdownPromise = this.performShutdown();
    }
    return this.shutdownPromise;
  }

  private closeLifecycle(state: "closing" | "closed"): void {
    if(this.lifecycle === "closed")
      return;

    if(this.lifecycle === "starting") {
      this.lifecycleError = new Error("PoW worker closed before becoming ready");
      this.readyDfd.reject(this.lifecycleError);
    }
    else if(!this.lifecycleError) {
      this.lifecycleError = new Error("PoW worker is not accepting sessions");
    }
    this.lifecycle = state;
  }

  private async waitUntilReady(): Promise<void> {
    if(this.lifecycle === "closing" || this.lifecycle === "closed")
      throw this.lifecycleError;
    await this.readyDfd.promise;
    if(this.lifecycle !== "ready")
      throw this.lifecycleError || new Error("PoW worker is not accepting sessions");
  }

  private async performShutdown(): Promise<void> {
    let shutdownErrors: unknown[] = [];
    let shutdownSignalFailed = false;
    let shutdownSignalError: unknown;
    let shutdownSignal = Promise.resolve();
    if(this.acceptingMessages) {
      shutdownSignal = this.sendMessageConfirmed({
        action: "pow-shutdown",
      }).catch((error) => {
        shutdownSignalFailed = true;
        shutdownSignalError = error;
      });
    }

    let shutdownTimeout = setTimeout(() => {
      this.worker.childProcess.kill();
    }, 5000);

    await this.shutdownDfd.promise;
    clearTimeout(shutdownTimeout);
    await shutdownSignal;
    if(shutdownSignalFailed)
      shutdownErrors.push(shutdownSignalError);

    await Promise.allSettled([...this.messageOperations]);
    if(this.firstMessageOperationError) {
      shutdownErrors.push(this.messageOperationErrorCount === 1
        ? this.firstMessageOperationError
        : new Error(
            this.messageOperationErrorCount + " PoW message operations failed; first failure: " + this.firstMessageOperationError.message,
            {cause: this.firstMessageOperationError},
          ));
    }

    ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Stopped PoW worker process [" + this.serverId + "]");
    if(shutdownErrors.length === 1)
      throw shutdownErrors[0];
    if(shutdownErrors.length > 1)
      throw new AggregateError(shutdownErrors, "PoW shutdown failed after the worker and message handlers stopped");
  }

  public updateConfig(config: IPoWConfig) {
    this.sendMessage({
      action: "pow-update-config",
      config: config,
    });
  }

  public async registerSession(session: FaucetSession) {
    let sessionId = session.getSessionId();
    this.sessions[sessionId] = session;
    try {
      await this.waitUntilReady();
      this.sendMessage({
        action: "pow-register-session",
        sessionId: sessionId,
        data: {
          "_startTime": session.getStartTime(),
          "_balance": session.getDropAmount().toString(),
          "pow.idleTime": session.getSessionData("pow.idleTime"),
          "pow.lastNonce": session.getSessionData("pow.lastNonce"),
          "pow.shareCount": session.getSessionData("pow.shareCount"),
          "pow.hashrates": session.getSessionData("pow.hashrates"),
          "pow.hashrate": session.getSessionData("pow.hashrate"),
          "pow.preimage": session.getSessionData("pow.preimage"),
        }
      });
    } catch(error) {
      if(this.sessions[sessionId] === session)
        delete this.sessions[sessionId];
      throw error;
    }
  }

  public destroySession(sessionId: string, failed: boolean): Promise<void> {
    let session = this.sessions[sessionId];
    if(!session)
      return Promise.resolve();

    let pendingDestroy = this.pendingSessionDestroys.get(sessionId);
    if(pendingDestroy) {
      if(failed && (pendingDestroy.kind === "waiting" || pendingDestroy.kind === "queued"))
        pendingDestroy.failed = true;
      return pendingDestroy.result.promise;
    }

    pendingDestroy = {
      failed,
      result: new PromiseDfd<void>(),
      kind: "waiting",
    };
    void pendingDestroy.result.promise.catch(() => undefined);
    this.pendingSessionDestroys.set(sessionId, pendingDestroy);
    this.flushPendingSessionDestroy(sessionId);
    return pendingDestroy.result.promise;
  }

  private flushPendingSessionDestroy(sessionId: string): void {
    let pendingDestroy = this.pendingSessionDestroys.get(sessionId);
    if(
      !pendingDestroy ||
      pendingDestroy.kind !== "waiting" ||
      this.sessionMessageOperations.get(sessionId)?.size ||
      this.shutdownPromise
    )
      return;

    let session = this.sessions[sessionId];
    if(!session) {
      this.pendingSessionDestroys.delete(sessionId);
      pendingDestroy.result.resolve();
      return;
    }

    let queued: PendingSessionDestroy = {...pendingDestroy, kind: "queued"};
    this.pendingSessionDestroys.set(sessionId, queued);
    queueMicrotask(() => {
      let current = this.pendingSessionDestroys.get(sessionId);
      if(current?.result !== queued.result || current.kind !== "queued")
        return;
      let timeout = setTimeout(() => {
        let active = this.pendingSessionDestroys.get(sessionId);
        if(active?.result === current.result && active.kind === "sending") {
          this.waitForWorkerCloseAfterDestroyFailure(
            sessionId,
            active,
            new Error("PoW worker did not confirm session destruction"),
          );
        }
      }, SESSION_TEARDOWN_TIMEOUT_MS);
      timeout.unref?.();
      let sending: SendingSessionDestroy = {
        failed: current.failed,
        result: current.result,
        kind: "sending",
        timeout,
      };
      this.pendingSessionDestroys.set(sessionId, sending);
      void this.sendMessageConfirmed({
        action: "pow-destroy-session",
        sessionId: sessionId,
        failed: sending.failed,
      }).then(
        () => this.completeSentSessionDestroy(sessionId, sending),
        (error) => this.waitForWorkerCloseAfterDestroyFailure(sessionId, sending, error),
      );
    });
  }

  private completeSentSessionDestroy(sessionId: string, sending: SendingSessionDestroy): void {
    let current = this.pendingSessionDestroys.get(sessionId);
    if(current?.result !== sending.result || current.kind !== "sending")
      return;
    clearTimeout(current.timeout);
    this.pendingSessionDestroys.delete(sessionId);
    delete this.sessions[sessionId];
    sending.result.resolve();
  }

  private waitForWorkerCloseAfterDestroyFailure(
    sessionId: string,
    sending: SendingSessionDestroy,
    error: unknown,
  ): void {
    let current = this.pendingSessionDestroys.get(sessionId);
    if(current?.result !== sending.result || current.kind !== "sending")
      return;
    clearTimeout(current.timeout);
    this.pendingSessionDestroys.set(sessionId, {
      failed: current.failed,
      result: current.result,
      kind: "awaiting-child-close",
      error: this.toError(error),
    });
    this.beginShutdownAfterIpcFailure("session destruction", error);
  }

  private completeSessionDestroysAfterWorkerClose(): void {
    for(let [sessionId, pendingDestroy] of this.pendingSessionDestroys) {
      this.pendingSessionDestroys.delete(sessionId);
      delete this.sessions[sessionId];
      switch(pendingDestroy.kind) {
        case "waiting":
        case "queued":
          pendingDestroy.result.resolve();
          break;
        case "sending":
          clearTimeout(pendingDestroy.timeout);
          pendingDestroy.result.resolve();
          break;
        case "awaiting-child-close":
          pendingDestroy.result.reject(pendingDestroy.error);
          break;
        default: {
          let exhaustive: never = pendingDestroy;
          throw new Error("Unknown pending PoW session destroy state: " + String(exhaustive));
        }
      }
    }
  }

  public async connect(sessionId: string, req: http.IncomingMessage, socket: Socket, head: Buffer) {
    socket.pause();
    socket.removeAllListeners();

    try {
      await this.waitUntilReady();

      this.worker.childProcess.send({
        action: "pow-connect",
        sessionId: sessionId,
        url: req.url,
        method: req.method,
        headers: req.headers,
        head: head.toString('base64'),
      }, socket, {
        keepOpen: true
      });
    } catch(error) {
      try {
        socket.destroy();
      } catch {}
      throw error;
    }

    setTimeout(() => {
      socket.destroy();
    }, 100);
  }

  private onSysLoad(cpu: number, memory: {heapUsed: number, heapTotal: number}, eventLoopLag: number, activeSessions: string[]) {
    ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, 
      ProcessLoadTracker.formatLoadStats(
        `PoW server [${this.serverId}]`,
        { timestamp: Math.floor(Date.now() / 1000), cpu, eventLoopLag, memory },
        { Sessions: `${activeSessions.length}/${this.getSessionCount()}` }
      )
    );

    const activeSessionIds = new Set<string>(activeSessions);
    for(let sessionId in this.sessions) {
      let session = this.sessions[sessionId];
      if(!session)
        continue;

      session.setSessionModuleRef("pow.clientActive", activeSessionIds.has(sessionId));
    }
  }
}
