import { AsyncLocalStorage } from "node:async_hooks";
import { FaucetError, PublicFaucetError } from "../common/FaucetError.js";
import { ServiceManager } from "../common/ServiceManager.js";
import { faucetConfig } from "../config/FaucetConfig.js";
import { ModuleHookAction, ModuleManager } from "../modules/ModuleManager.js";
import { EthClaimData, EthClaimManager } from "../eth/EthClaimManager.js";
import { FaucetDatabase } from "../db/FaucetDatabase.js";
import { getNewGuid } from "../utils/GuidUtils.js";
import { SessionManager } from "./SessionManager.js";
import { ISessionRewardFactor } from "./SessionRewardFactor.js";
import { FaucetLogLevel, FaucetProcess } from "../common/FaucetProcess.js";
import { FaucetStatsLog } from "../services/FaucetStatsLog.js";
import { normalizeIpAddress } from "../utils/IPAddress.js";

export enum FaucetSessionStatus {
  UNKNOWN = "unknown",
  STARTING = "starting",
  RUNNING = "running",
  COMMITTING = "committing",
  CLAIMABLE = "claimable",
  CLAIMING = "claiming",
  FINISHED = "finished",
  FAILED = "failed",
}

export interface FaucetSessionTask {
  module: string;
  name: string;
  timeout: number;
}

export interface FaucetSessionStoreData {
  sessionId: string;
  status: FaucetSessionStatus;
  startTime: number;
  targetAddr: string;
  dropAmount: string;
  remoteIP: string;
  tasks: any;
  data: any;
  claim: EthClaimData | null;
}

export interface IClientSessionInfo {
  session: string;
  status: string;
  start: number;
  tasks?: FaucetSessionTask[];
  balance: string;
  target: string;
  modules?: {[module: string]: any};
  failedCode?: string;
  failedReason?: string;
}

type SessionPersistenceState =
  | {kind: "absent"}
  | {kind: "durable"}
  | {kind: "uncertain", snapshot: FaucetSessionStoreData};

type FailurePersistenceState =
  | {kind: "none"}
  | {kind: "preparing"}
  | {
      kind: "pending";
      expectedStatus: FaucetSessionStatus;
      alreadyPersisted: boolean;
      sessionData: FaucetSessionStoreData;
    }
  | {kind: "complete"};

interface StartRollback {
  owner: string;
  callback: () => void | Promise<void>;
}

type RewardTerminalIntent =
  | {kind: "none"}
  | {kind: "complete"}
  | {kind: "failed", code: string, reason: string, stack?: string};

interface RewardTerminalContext {
  active: boolean;
  terminalIntent: RewardTerminalIntent;
}

export class FaucetSession {
  private manager: SessionManager;
  private status: FaucetSessionStatus;
  private sessionId: string;
  private startTime: number;
  private targetAddr: string;
  private dropAmount: bigint;
  private remoteIP: string;
  private blockingTasks: FaucetSessionTask[] = [];
  private sessionDataDict: {[key: string]: any} = {};
  private sessionModuleRefs: {[key: string]: any} = {};
  private sessionTimer: NodeJS.Timeout;
  private isDirty: boolean;
  private persistenceState: SessionPersistenceState = {kind: "absent"};
  private failurePersistence: FailurePersistenceState = {kind: "none"};
  private isDisposed: boolean;
  private saveTimer: NodeJS.Timeout;
  private remoteIpUpdatePromise: Promise<void> = Promise.resolve();
  private isRemoteIpUpdatePending = false;
  private completionPromise: Promise<void> | null = null;
  private persistencePromise: Promise<void> = Promise.resolve();
  private rewardFactorEvaluationDepth = 0;
  private cancelRewardBeforeAccounting = false;
  private readonly rewardFactorContext = new AsyncLocalStorage<RewardTerminalContext>();
  private readonly rewardAccountingContext = new AsyncLocalStorage<RewardTerminalContext>();
  private rewardContextsDisabled = false;
  private startRollbacks: StartRollback[] = [];

  public constructor(manager: SessionManager) {
    this.manager = manager;
    this.status = FaucetSessionStatus.UNKNOWN;
    this.isDirty = false;
    this.isDisposed = false;
  }

  public async startSession(remoteIP: string, userInput: any, overrides?: any): Promise<void> {
    if(this.status !== FaucetSessionStatus.UNKNOWN)
      throw new FaucetError("INVALID_STATE", "cannot start session: session already in '" + this.status + "' state");
    const moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.assertSessionAdmissionReady();

    this.status = FaucetSessionStatus.STARTING;
    this.sessionId = getNewGuid();
    this.startTime = Math.floor((new Date()).getTime() / 1000);
    this.remoteIP = this.normalizeRemoteIP(remoteIP);
    this.dropAmount = -1n;

    if(overrides) {
      for(let key in overrides) {
        this.setSessionData(key, overrides[key]);
      }
    }

    try {
      this.manager.beginAdmission(this);
      await moduleManager.processActionHooks([
        {prio: 1, hook: () => { // prio 1: check if faucet is in maintenance mode
          if(faucetConfig.denyNewSessions) {
            let denyMessage = typeof faucetConfig.denyNewSessions === "string" ? faucetConfig.denyNewSessions : "The faucet is currently not allowing new sessions";
            throw new PublicFaucetError({
              code: "FAUCET_DISABLED",
              message: denyMessage,
            });
          }
        }},
        {prio: 5, hook: () => { // prio 5: get target address from userInput if not set provided by a module
          let targetAddr = this.targetAddr || userInput.addr;
          if(typeof targetAddr !== "string")
            throw new FaucetError("INVALID_ADDR", "Missing target address.");
          if(!targetAddr.match(/^0x[0-9a-fA-F]{40}$/) || targetAddr.match(/^0x0{40}$/i))
            throw new FaucetError("INVALID_ADDR", "Invalid target address.");
          if(!this.targetAddr)
            this.setTargetAddr(targetAddr);
        }},
      ], ModuleHookAction.SessionStart, [this, userInput]);
    } catch(ex) {
      if(ex instanceof FaucetError)
        return await this.failStart(ex, ex.getCode(), ex.message);
      return await this.failStart(ex, "INTERNAL_ERROR", "sessionStart failed: " + String(ex));
    }

    if(this.status as FaucetSessionStatus === FaucetSessionStatus.FAILED)
      return;

    try {
      this.setAdmissionClaimCeiling(this.getClaimCeiling());
      this.status = FaucetSessionStatus.RUNNING;
      this.isDirty = true;
      this.manager.markAdmissionRunning(this);
      this.manager.notifySessionUpdate(this);
      await this.saveSession();
      this.startRollbacks = [];
      await this.tryProceedSession();
    } catch(ex) {
      if((this.status as FaucetSessionStatus) !== FaucetSessionStatus.FAILED)
        return await this.failStart(ex, "INTERNAL_ERROR", "session activation failed: " + String(ex));
      throw ex;
    }
  }

  public registerStartRollback(owner: string, callback: () => void | Promise<void>): void {
    if(this.status !== FaucetSessionStatus.STARTING)
      throw new FaucetError("INVALID_STATE", "Start rollbacks can only be registered while a session is starting.");
    if(typeof owner !== "string" || owner.length === 0 || typeof callback !== "function")
      throw new TypeError("A start rollback requires an owner and callback.");
    if(this.startRollbacks.some((rollback) => rollback.owner === owner))
      throw new Error("Start rollback owner is already registered: " + owner);
    this.startRollbacks.push({owner, callback});
  }

  private async failStart(error: unknown, code: string, reason: string): Promise<never> {
    try {
      await this.setSessionFailed(code, reason);
    } catch(cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Session start failed and cleanup did not complete: " + String(error) + "; " + String(cleanupError),
      );
    }
    throw error;
  }

  public async restoreSession(sessionData: FaucetSessionStoreData): Promise<void> {
    this.sessionId = sessionData.sessionId;
    this.status = sessionData.status;
    this.startTime = sessionData.startTime;
    this.targetAddr = this.normalizeTargetAddr(sessionData.targetAddr);
    this.dropAmount = BigInt(sessionData.dropAmount);
    this.remoteIP = this.normalizeRemoteIP(sessionData.remoteIP);
    this.blockingTasks = sessionData.tasks;
    this.sessionDataDict = sessionData.data || {};
    this.persistenceState = {kind: "durable"};

    try {
      this.manager.beginAdmission(this, true);
      await ServiceManager.GetService(ModuleManager).processActionHooks([], ModuleHookAction.SessionRestore, [this]);
      this.manager.markAdmissionRunning(this);
    } catch(ex) {
      this.manager.releaseAdmission(this);
      throw ex;
    }
    
    this.manager.notifySessionUpdate(this);
    this.resetSessionTimer();
  }

  public getStoreData(): FaucetSessionStoreData {
    return {
      sessionId: this.sessionId,
      status: this.status,
      startTime: this.startTime,
      targetAddr: this.targetAddr,
      dropAmount: this.dropAmount.toString(),
      remoteIP: this.remoteIP,
      tasks: this.blockingTasks,
      data: this.sessionDataDict,
      claim: null,
    };
  }

  private getStoreSnapshot(): FaucetSessionStoreData {
    const sessionData = this.getStoreData();
    return {
      ...sessionData,
      tasks: JSON.parse(JSON.stringify(sessionData.tasks)),
      data: JSON.parse(JSON.stringify(sessionData.data)),
      claim: sessionData.claim === null
        ? null
        : JSON.parse(JSON.stringify(sessionData.claim)),
    };
  }

  public saveSession(): Promise<void> {
    if(this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    let savePromise = this.persistencePromise.then(() => this.persistSession());
    this.persistencePromise = savePromise.catch(() => undefined);
    return savePromise;
  }

  private async persistSession(): Promise<void> {
    if(this.failurePersistence.kind === "pending") {
      await this.persistFailedSession();
      await this.runStartRollbacks();
      return;
    }
    if(this.failurePersistence.kind === "complete") {
      await this.runStartRollbacks();
      return;
    }
    await this.persistRunningSession();
  }

  private async persistRunningSession(): Promise<void> {
    if(!this.isDirty || this.isDisposed || this.status !== FaucetSessionStatus.RUNNING)
      return;

    const sessionData = this.getStoreSnapshot();
    this.isDirty = false;
    try {
      if(this.persistenceState.kind === "uncertain") {
        const reconciliation = await this.reconcileUncertainInsert();
        if(reconciliation !== "absent")
          return;
      }

      if(this.persistenceState.kind === "absent") {
        this.persistenceState = {kind: "uncertain", snapshot: sessionData};
        try {
          await ServiceManager.GetService(FaucetDatabase).insertRunningSession(sessionData);
          this.persistenceState = {kind: "durable"};
        } catch(insertError) {
          let reconciliationError: unknown;
          try {
            const reconciliation = await this.reconcileUncertainInsert();
            if(reconciliation !== "absent")
              return;
          } catch(ex) {
            reconciliationError = ex;
          }
          if(reconciliationError)
            throw new AggregateError([insertError, reconciliationError], "Could not determine whether the running session was inserted");
          throw insertError;
        }
      } else if(!await ServiceManager.GetService(FaucetDatabase).updateRunningSession(sessionData)) {
        this.isDirty = true;
        await this.synchronizeTerminalState();
      }
    } catch(ex) {
      this.isDirty = true;
      throw ex;
    }
  }

  private async reconcileUncertainInsert(): Promise<"absent" | "durable" | "terminal"> {
    if(this.persistenceState.kind !== "uncertain")
      throw new Error("Session insert reconciliation requires uncertain persistence state.");

    const snapshot = this.persistenceState.snapshot;
    const storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(this.sessionId);
    if(!storedSession) {
      this.persistenceState = {kind: "absent"};
      return "absent";
    }
    if(this.sessionDataEquals(storedSession, snapshot)) {
      this.persistenceState = {kind: "durable"};
      return "durable";
    }
    if(this.isTerminalStatus(storedSession.status)) {
      this.persistenceState = {kind: "durable"};
      await this.synchronizeTerminalState(storedSession);
      return "terminal";
    }
    throw new Error("The stored session does not match the uncertain insert.");
  }

  private lazySaveSession() {
    this.isDirty = true;
    if(this.saveTimer || this.isRemoteIpUpdatePending || !this.manager.canApplyRewards())
      return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveSession().catch((ex) => {
        ServiceManager.GetService(FaucetProcess).emitLog(
          FaucetLogLevel.ERROR,
          "Could not save session " + this.sessionId + ": " + String(ex),
        );
      });
    }, faucetConfig.sessionSaveTime * 1000);
  }

  public setSessionFailed(code: string, reason: string, stack?: string): Promise<void> {
    const terminalContext = this.getActiveRewardTerminalContext();
    if(terminalContext) {
      if(terminalContext.terminalIntent.kind !== "failed")
        terminalContext.terminalIntent = {kind: "failed", code, reason, stack};
      return Promise.resolve();
    }
    if(this.completionPromise)
      return this.completionPromise;
    if(!this.manager.canAcceptRewardOperations())
      return Promise.resolve();
    if(this.shouldCancelRewardBeforeQueuedTerminal())
      this.cancelRewardBeforeAccounting = true;
    return this.trackCompletion(this.manager.runRewardOperation(() => this.finishFailedSession(code, reason, stack)));
  }

  public tryApplyTimeout(timeout: number): Promise<boolean> {
    if(this.failurePersistence.kind === "pending")
      return this.saveSession().then(() => false);
    if(this.completionPromise || this.status !== FaucetSessionStatus.RUNNING)
      return Promise.resolve(false);

    let timedOut = false;
    let completion: Promise<void>;
    completion = Promise.resolve().then(async () => {
      await this.saveSession();
      if(this.status !== FaucetSessionStatus.RUNNING)
        return;

      let transitioned: boolean;
      try {
        transitioned = await ServiceManager.GetService(FaucetDatabase).tryTimeoutSession(
          this.getStoreData(),
          timeout,
        );
      } catch(transitionError) {
        let storedSession: FaucetSessionStoreData;
        try {
          storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(this.sessionId);
        } catch(readError) {
          throw new AggregateError([transitionError, readError], "Could not reconcile the timeout transition");
        }
        if(this.isMatchingTimeout(storedSession)) {
          timedOut = true;
          this.persistenceState = {kind: "durable"};
          await this.finishFailedSession(
            "SESSION_TIMEOUT",
            "Session timed out",
            undefined,
            true,
          );
          return;
        }
        if(storedSession && this.isTerminalStatus(storedSession.status)) {
          await this.synchronizeTerminalState(storedSession);
          return;
        }
        throw transitionError;
      }
      if(!transitioned) {
        const storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(this.sessionId);
        if(storedSession && storedSession.status !== FaucetSessionStatus.RUNNING)
          await this.synchronizeTerminalState();
        return;
      }

      timedOut = true;
      await this.finishFailedSession(
        "SESSION_TIMEOUT",
        "Session timed out",
        undefined,
        true,
      );
    }).finally(() => {
      if(!this.isDisposed && this.completionPromise === completion)
        this.completionPromise = null;
    });
    this.completionPromise = completion;
    return completion.then(() => timedOut);
  }

  private async finishFailedSession(
    code: string,
    reason: string,
    stack?: string,
    alreadyPersisted = false,
    runCompletionHooks = true,
    persistedStatus?: FaucetSessionStatus,
  ): Promise<void> {
    if(this.isDisposed)
      return;

    let cleanupErrors: unknown[] = [];
    if(this.failurePersistence.kind === "none") {
      const oldStatus = this.status;
      const expectedStatus = persistedStatus
        ?? (oldStatus === FaucetSessionStatus.COMMITTING ? FaucetSessionStatus.RUNNING : oldStatus);
      this.failurePersistence = {kind: "preparing"};
      this.sessionDataDict["failed.code"] = code;
      this.sessionDataDict["failed.reason"] = reason;
      if(stack === undefined)
        delete this.sessionDataDict["failed.stack"];
      else
        this.sessionDataDict["failed.stack"] = stack;
      this.status = FaucetSessionStatus.FAILED;
      this.isDirty = true;
      this.resetSessionTimer();
      if(this.saveTimer) {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }

      if(runCompletionHooks && (oldStatus === FaucetSessionStatus.RUNNING || oldStatus === FaucetSessionStatus.COMMITTING)) {
        try {
          await ServiceManager.GetService(ModuleManager).processActionHooks([], ModuleHookAction.SessionComplete, [this]);
        } catch(ex) {
          cleanupErrors.push(ex);
        }
      }
      this.failurePersistence = {
        kind: "pending",
        expectedStatus,
        alreadyPersisted,
        sessionData: this.getStoreSnapshot(),
      };
    }

    await this.persistencePromise;
    try {
      await this.persistFailedSession();
    } catch(ex) {
      cleanupErrors.push(ex);
    }
    if(this.failurePersistence.kind === "complete") {
      try {
        await this.runStartRollbacks();
      } catch(ex) {
        cleanupErrors.push(ex);
      }
    }
    try {
      ServiceManager.GetService(FaucetProcess).emitLog(
        FaucetLogLevel.INFO,
        "Session " + this.sessionId + " failed: [" + code + "] " + reason,
      );
    } catch(ex) {
      cleanupErrors.push(ex);
    }
    if(cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "Session failure cleanup did not complete: " + cleanupErrors.map(String).join("; "),
      );
    }
  }

  private async persistFailedSession(): Promise<void> {
    if(this.failurePersistence.kind !== "pending")
      return;
    const failure = this.failurePersistence;
    if(failure.alreadyPersisted || this.persistenceState.kind === "absent") {
      if(failure.alreadyPersisted)
        this.persistenceState = {kind: "durable"};
      this.finalizeFailedSession();
      return;
    }
    if(this.persistenceState.kind === "uncertain") {
      const reconciliation = await this.reconcileUncertainInsert();
      if(reconciliation === "terminal")
        return;
      if(reconciliation === "absent") {
        this.finalizeFailedSession();
        return;
      }
    }

    let transitionError: unknown;
    let transitioned = false;
    try {
      transitioned = await ServiceManager.GetService(FaucetDatabase).transitionSession(
        failure.sessionData,
        failure.expectedStatus,
      );
    } catch(ex) {
      transitionError = ex;
    }
    if(transitioned) {
      this.persistenceState = {kind: "durable"};
      this.finalizeFailedSession();
      return;
    }

    let storedSession: FaucetSessionStoreData;
    try {
      storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(this.sessionId);
    } catch(readError) {
      if(transitionError)
        throw new AggregateError([transitionError, readError], "Could not reconcile terminal session persistence");
      throw readError;
    }
    if(storedSession && this.sessionDataEquals(storedSession, failure.sessionData)) {
      this.persistenceState = {kind: "durable"};
      this.finalizeFailedSession();
      return;
    }
    if(storedSession && this.isTerminalStatus(storedSession.status)) {
      await this.synchronizeTerminalState(storedSession);
      return;
    }
    if(transitionError)
      throw transitionError;
    throw new Error("Session persistence ownership was lost before the terminal state became durable.");
  }

  private finalizeFailedSession(): void {
    this.failurePersistence = {kind: "complete"};
    this.isDirty = false;
    this.manager.releaseAdmission(this);
    this.manager.notifySessionUpdate(this);
    this.isDisposed = true;
    this.disableRewardContexts();
  }

  private async runStartRollbacks(): Promise<void> {
    if(
      this.startRollbacks.length === 0
      || this.failurePersistence.kind !== "complete"
      || this.persistenceState.kind === "uncertain"
    ) {
      return;
    }

    if(
      this.persistenceState.kind === "durable"
      && this.status !== FaucetSessionStatus.FAILED
    ) {
      if(this.isTerminalStatus(this.status))
        this.startRollbacks = [];
      return;
    }

    const rollbacks = this.startRollbacks.splice(0).reverse();
    let failures: unknown[] = [];
    for(let rollback of rollbacks) {
      try {
        await rollback.callback();
      } catch(ex) {
        failures.push(new Error(
          "Start rollback '" + rollback.owner + "' failed: " + String(ex),
          {cause: ex},
        ));
      }
    }
    if(failures.length > 0)
      throw new AggregateError(failures, failures.map(String).join("; "));
  }

  private async synchronizeTerminalState(observedSession?: FaucetSessionStoreData): Promise<void> {
    const storedSession = observedSession
      ?? await ServiceManager.GetService(FaucetDatabase).getSession(this.sessionId);
    if(!storedSession || !this.isTerminalStatus(storedSession.status))
      throw new Error("Session persistence ownership was lost without a terminal database state.");

    this.status = storedSession.status;
    this.startTime = storedSession.startTime;
    this.targetAddr = this.normalizeTargetAddr(storedSession.targetAddr);
    this.dropAmount = BigInt(storedSession.dropAmount);
    this.remoteIP = this.normalizeRemoteIP(storedSession.remoteIP);
    this.blockingTasks = storedSession.tasks || [];
    this.sessionDataDict = storedSession.data || {};
    this.isDirty = false;
    this.persistenceState = {kind: "durable"};
    this.failurePersistence = {kind: "complete"};
    this.resetSessionTimer();
    this.manager.releaseAdmission(this);
    this.manager.notifySessionUpdate(this);
    this.isDisposed = true;
    this.disableRewardContexts();
  }

  private disableRewardContexts(): void {
    if(this.rewardContextsDisabled)
      return;
    this.rewardContextsDisabled = true;
    this.rewardFactorContext.disable();
    this.rewardAccountingContext.disable();
  }

  private sessionDataEquals(left: FaucetSessionStoreData, right: FaucetSessionStoreData): boolean {
    return left.sessionId === right.sessionId
      && left.status === right.status
      && left.startTime === right.startTime
      && left.targetAddr === right.targetAddr
      && left.dropAmount === right.dropAmount
      && left.remoteIP === right.remoteIP
      && JSON.stringify(left.tasks) === JSON.stringify(right.tasks)
      && JSON.stringify(left.data) === JSON.stringify(right.data)
      && JSON.stringify(left.claim) === JSON.stringify(right.claim);
  }

  private isTerminalStatus(status: FaucetSessionStatus): boolean {
    return status === FaucetSessionStatus.CLAIMABLE
      || status === FaucetSessionStatus.CLAIMING
      || status === FaucetSessionStatus.FINISHED
      || status === FaucetSessionStatus.FAILED;
  }

  private isMatchingTimeout(session: FaucetSessionStoreData | null): boolean {
    return session?.status === FaucetSessionStatus.FAILED
      && session.claim === null
      && session.data?.["failed.code"] === "SESSION_TIMEOUT"
      && session.data?.["failed.reason"] === "Session timed out";
  }

  private trackCompletion(completion: Promise<void>): Promise<void> {
    this.completionPromise = completion;
    void completion.catch(() => {
      if(!this.isDisposed && this.completionPromise === completion)
        this.completionPromise = null;
    });
    return completion;
  }

  private resetSessionTimer() {
    if(this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
    let now = Math.floor((new Date()).getTime() / 1000);

    if(this.status === FaucetSessionStatus.RUNNING && this.manager.canApplyRewards()) {
      let minTaskTimeout = 0;
      this.blockingTasks.forEach((task) => {
        if(task.timeout > now && (minTaskTimeout === 0 || task.timeout < minTaskTimeout))
          minTaskTimeout = task.timeout;
      });
      let sessionTimeout = this.startTime + faucetConfig.sessionTimeout;
      let timerDelay = (Math.min(minTaskTimeout, sessionTimeout) - now) + 1;
      if(timerDelay < 1)
        timerDelay = 1;
      this.sessionTimer = setTimeout(() => {
        this.tryProceedSession().catch((ex) => {
          ServiceManager.GetService(FaucetProcess).emitLog(
            FaucetLogLevel.ERROR,
            "Could not advance session " + this.sessionId + ": " + String(ex),
          );
        });
      }, timerDelay * 1000);
    }
  }

  public quiesceForShutdown(): void {
    if(this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
    if(this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  public async tryProceedSession(): Promise<void> {
    let now = Math.floor((new Date()).getTime() / 1000);
    let sessionTimeout = this.startTime + faucetConfig.sessionTimeout;

    if(this.status === FaucetSessionStatus.RUNNING) {
      if(now >= sessionTimeout) {
        return await this.setSessionFailed("SESSION_TIMEOUT", "session timeout");
      }

      for(let i = this.blockingTasks.length - 1; i >= 0; i--) {
        if(this.blockingTasks[i].timeout > 0 && this.blockingTasks[i].timeout < now) {
          this.blockingTasks.splice(i, 1);
        }
      }
      if(this.blockingTasks.length === 0) {
        await this.completeSession();
      }
      else {
        this.resetSessionTimer();
      }
    }
  }

  public completeSession(): Promise<void> {
    const terminalContext = this.getActiveRewardTerminalContext();
    if(terminalContext) {
      if(terminalContext.terminalIntent.kind === "none")
        terminalContext.terminalIntent = {kind: "complete"};
      return Promise.resolve();
    }
    if(this.completionPromise)
      return this.completionPromise;
    if(this.status !== FaucetSessionStatus.RUNNING)
      return Promise.resolve();
    if(!this.manager.canAcceptRewardOperations())
      return Promise.resolve();

    if(this.shouldCancelRewardBeforeQueuedTerminal())
      this.cancelRewardBeforeAccounting = true;
    return this.trackCompletion(this.manager.runRewardOperation(() => this.finishSession()));
  }

  private async finishSession(grantDefaultReward = true): Promise<void> {
    if(grantDefaultReward && this.dropAmount === -1n && this.rewardFactorEvaluationDepth === 0) {
      await this.applyReward(BigInt(faucetConfig.maxDropAmount));
    }

    if(this.status !== FaucetSessionStatus.RUNNING)
      return;

    if(this.dropAmount < BigInt(faucetConfig.minDropAmount)) {
      return await this.finishFailedSession("AMOUNT_TOO_LOW", "drop amount lower than minimum");
    }
    
    this.manager.markAdmissionCommitting(this);
    this.status = FaucetSessionStatus.COMMITTING;
    this.sessionDataDict["close.time"] = Math.floor((new Date()).getTime() / 1000);
    this.isDirty = true;
    this.resetSessionTimer();
    if(this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    try {
      await ServiceManager.GetService(ModuleManager).processActionHooks([], ModuleHookAction.SessionComplete, [this]);
      await this.persistencePromise;
      const claimableData = {
        ...this.getStoreSnapshot(),
        status: FaucetSessionStatus.CLAIMABLE,
      };
      const database = ServiceManager.GetService(FaucetDatabase);
      let transitioned: boolean;
      try {
        transitioned = await database.transitionSession(
          claimableData,
          FaucetSessionStatus.RUNNING,
        );
      } catch(transitionError) {
        let storedSession: FaucetSessionStoreData;
        try {
          storedSession = await database.getSession(this.sessionId);
        } catch(readError) {
          throw new AggregateError([transitionError, readError], "Could not reconcile the claimable transition");
        }
        if(storedSession && this.sessionDataEquals(storedSession, claimableData)) {
          transitioned = true;
        } else if(storedSession && this.isTerminalStatus(storedSession.status)) {
          await this.synchronizeTerminalState(storedSession);
          return;
        } else {
          throw transitionError;
        }
      }
      if(!transitioned) {
        await this.synchronizeTerminalState();
        return;
      }
    } catch(ex) {
      let reason = ex instanceof Error ? ex.message : String(ex);
      await this.finishFailedSession(
        "SESSION_COMPLETE",
        "sessionComplete failed: " + reason,
        undefined,
        false,
        false,
        this.status === FaucetSessionStatus.COMMITTING
          ? FaucetSessionStatus.RUNNING
          : FaucetSessionStatus.CLAIMABLE,
      );
      throw ex;
    }

    this.status = FaucetSessionStatus.CLAIMABLE;
    this.isDirty = false;
    this.persistenceState = {kind: "durable"};
    this.resetSessionTimer();
    this.manager.releaseAdmission(this);
    this.manager.notifySessionUpdate(this);
    this.isDisposed = true;
    this.disableRewardContexts();
    this.runPostCommitOperation("log claimable session", () => {
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Session " + this.sessionId + " is claimable");
    });
    this.runPostCommitOperation("record session statistics", () => {
      ServiceManager.GetService(FaucetStatsLog).addSessionStats(this);
    });
  }

  private runPostCommitOperation(operation: string, callback: () => void): void {
    try {
      callback();
    } catch(ex) {
      try {
        ServiceManager.GetService(FaucetProcess).emitLog(
          FaucetLogLevel.ERROR,
          "Could not " + operation + " for session " + this.sessionId + ": " + String(ex),
        );
      } catch {}
    }
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public getSessionStatus(): FaucetSessionStatus {
    return this.status;
  }

  public getStartTime(): number {
    return this.startTime;
  }

  public getRemoteIP(): string {
    return this.remoteIP;
  }

  public async updateRemoteIP(remoteIP: string): Promise<void> {
    remoteIP = this.normalizeRemoteIP(remoteIP);
    let updatePromise = this.remoteIpUpdatePromise.then(() => this.applyRemoteIpUpdate(remoteIP));
    this.remoteIpUpdatePromise = updatePromise.catch(() => undefined);
    return updatePromise;
  }

  public getTargetAddr(): string {
    return this.targetAddr;
  }

  public setTargetAddr(addr: string) {
    addr = this.normalizeTargetAddr(addr);
    if(this.targetAddr && this.targetAddr !== addr)
      throw new FaucetError("INVALID_STATE", "cannot change target address: already set.");
    if(this.targetAddr)
      return;
    this.targetAddr = addr;
    this.manager.bindAdmissionSubjects(this, [{kind: "address", value: addr}]);
  }

  public getClaimCeiling(): bigint {
    let overrideMaxDropAmount = this.getSessionData<string | number | bigint>("overrideMaxDropAmount");
    if(typeof overrideMaxDropAmount !== "undefined")
      return BigInt(overrideMaxDropAmount);
    return BigInt(faucetConfig.maxDropAmount);
  }

  public reserveAdmissionClaimCeiling(amount: bigint): void {
    this.manager.reserveAdmissionClaimCeiling(this, amount);
  }

  private setAdmissionClaimCeiling(amount: bigint): void {
    this.manager.setAdmissionClaimCeiling(this, amount);
  }

  public setMaxDropAmountOverride(amount: bigint): void {
    this.setSessionData("overrideMaxDropAmount", amount.toString());
    this.reserveAdmissionClaimCeiling(amount);
  }

  public getSessionData<T = any>(key: string, defval?: T): T {
    return key in this.sessionDataDict ? this.sessionDataDict[key] : defval;
  }

  public setSessionData(key: string, value: any) {
    this.sessionDataDict[key] = value;
    this.lazySaveSession();
  }

  public getSessionModuleRef(key: string): any {
    return this.sessionModuleRefs[key];
  }

  public setSessionModuleRef(key: string, value: any) {
    this.sessionModuleRefs[key] = value;
  }

  public getBlockingTasks(): FaucetSessionTask[] {
    return this.blockingTasks.slice();
  }

  public addBlockingTask(moduleName: string, taskName: string, timeLimit: number) {
    this.blockingTasks.push({
      module: moduleName,
      name: taskName,
      timeout: timeLimit ? Math.floor((new Date()).getTime() / 1000) + timeLimit : 0,
    });
    this.resetSessionTimer();
  }

  public resolveBlockingTask(moduleName: string, taskName: string) {
    for(let i = this.blockingTasks.length - 1; i >= 0; i--) {
      if(this.blockingTasks[i].module === moduleName && this.blockingTasks[i].name === taskName) {
        this.blockingTasks.splice(i, 1);
      }
    }
    this.resetSessionTimer();
    this.lazySaveSession();
  }

  public getDropAmount(): bigint {
    return this.dropAmount < 0n ? 0n : this.dropAmount;
  }

  public setDropAmount(amount: bigint): Promise<bigint> {
    if(!this.manager.canAcceptRewardOperations())
      return Promise.resolve(0n);
    return this.manager.runRewardOperation(() => this.applyDropAmount(amount));
  }

  private async applyDropAmount(amount: bigint): Promise<bigint> {
    if(this.dropAmount !== -1n)
      return 0n;
    if(!this.canStartReward())
      return 0n;
    this.dropAmount = 0n;
    if(amount > 0n)
      return await this.applyReward(amount);
    this.lazySaveSession();
    return 0n;
  }

  public addReward(amount: bigint): Promise<bigint> {
    if(!this.manager.canAcceptRewardOperations())
      return Promise.resolve(0n);
    return this.manager.runRewardOperation(() => this.applyReward(amount));
  }

  private async applyReward(amount: bigint): Promise<bigint> {
    if(!this.canStartReward() || typeof amount !== "bigint" || amount <= 0n)
      return 0n;
    
    let rewardFactors: ISessionRewardFactor[] = [];
    const factorHookContexts: RewardTerminalContext[] = [];
    let factorHookFailure: {error: unknown} | null = null;
    this.rewardFactorEvaluationDepth++;
    try {
      await ServiceManager.GetService(ModuleManager).processActionHooks(
        [],
        ModuleHookAction.SessionRewardFactor,
        [this, rewardFactors],
        (invoke) => this.runRewardHook(
          this.rewardFactorContext,
          factorHookContexts,
          invoke,
        ),
      );
    } catch(ex) {
      factorHookFailure = {error: ex};
    } finally {
      this.rewardFactorEvaluationDepth--;
    }
    const factorTerminated = await this.applyRewardFactorTerminalIntent(
      this.collectRewardTerminalIntent(factorHookContexts),
    );
    if(factorHookFailure)
      throw factorHookFailure.error;
    if(factorTerminated)
      return 0n;
    if(!this.canStartReward() || this.cancelRewardBeforeAccounting)
      return 0n;

    let rewardFactor = 1;
    let validRewardFactors = true;
    for(let factor of rewardFactors) {
      if(!factor || typeof factor.factor !== "number" || !Number.isFinite(factor.factor) || factor.factor < 0) {
        validRewardFactors = false;
        break;
      }
      rewardFactor *= factor.factor;
    }
    const scaledRewardFactor = Math.floor(rewardFactor * 100000);
    const safeScaledRewardFactor = validRewardFactors
      && Number.isFinite(scaledRewardFactor)
      && Number.isSafeInteger(scaledRewardFactor)
      && scaledRewardFactor >= 0
      ? scaledRewardFactor
      : 0;

    let rewardAmount = amount * BigInt(safeScaledRewardFactor) / 100000n;
    if(!this.canCommitReward())
      return 0n;

    if(this.dropAmount === -1n)
      this.dropAmount = 0n;
    this.dropAmount += rewardAmount;
    this.sessionDataDict["reward.factors"] = rewardFactors;
    this.isDirty = true;
    const accountingHookContexts: RewardTerminalContext[] = [];
    let accountingFailure: {error: unknown} | null = null;
    try {
      await ServiceManager.GetService(ModuleManager).processActionHooks(
        [],
        ModuleHookAction.SessionRewarded,
        [this, rewardAmount, rewardFactors],
        (invoke) => this.runRewardHook(
          this.rewardAccountingContext,
          accountingHookContexts,
          invoke,
        ),
      );
    } catch(ex) {
      accountingFailure = {error: ex};
    }
    if(accountingFailure) {
      const reason = accountingFailure.error instanceof Error
        ? accountingFailure.error.message
        : String(accountingFailure.error);
      await this.finishFailedSession("REWARD_ACCOUNTING", "reward accounting failed: " + reason);
      throw accountingFailure.error;
    }
    await this.applyRewardTerminalIntent(this.collectRewardTerminalIntent(accountingHookContexts));
    if(this.isDirty && this.canCommitReward())
      this.lazySaveSession();
    return rewardAmount;
  }

  private getActiveRewardTerminalContext(): RewardTerminalContext | null {
    const factorContext = this.rewardFactorContext.getStore();
    if(factorContext?.active)
      return factorContext;
    const accountingContext = this.rewardAccountingContext.getStore();
    return accountingContext?.active ? accountingContext : null;
  }

  private shouldCancelRewardBeforeQueuedTerminal(): boolean {
    return this.rewardFactorEvaluationDepth > 0 && !this.rewardFactorContext.getStore();
  }

  private runRewardHook(
    storage: AsyncLocalStorage<RewardTerminalContext>,
    contexts: RewardTerminalContext[],
    invoke: () => unknown,
  ): Promise<void> {
    const context: RewardTerminalContext = {
      active: true,
      terminalIntent: {kind: "none"},
    };
    contexts.push(context);
    return storage.run(context, () => {
      let result: unknown;
      try {
        result = invoke();
      } catch(ex) {
        context.active = false;
        return Promise.reject(ex);
      }

      if(result === null || (typeof result !== "object" && typeof result !== "function")) {
        context.active = false;
        return Promise.resolve();
      }

      let then: unknown;
      try {
        then = (result as {then?: unknown}).then;
      } catch(ex) {
        context.active = false;
        return Promise.reject(ex);
      }
      if(typeof then !== "function") {
        context.active = false;
        return Promise.resolve();
      }

      return new Promise<unknown>((resolve, reject) => {
        try {
          Reflect.apply(then, result, [resolve, reject]);
        } catch(ex) {
          reject(ex);
        }
      }).finally(() => {
        context.active = false;
      }).then(() => undefined);
    });
  }

  private collectRewardTerminalIntent(contexts: RewardTerminalContext[]): RewardTerminalIntent {
    let terminalIntent: RewardTerminalIntent = {kind: "none"};
    for(let context of contexts) {
      if(context.terminalIntent.kind === "failed") {
        if(terminalIntent.kind !== "failed")
          terminalIntent = context.terminalIntent;
      }
      else if(context.terminalIntent.kind === "complete" && terminalIntent.kind === "none") {
        terminalIntent = context.terminalIntent;
      }
    }
    return terminalIntent;
  }

  private async applyRewardFactorTerminalIntent(intent: RewardTerminalIntent): Promise<boolean> {
    switch(intent.kind) {
      case "none":
        return false;
      case "complete":
        if(!this.completionPromise)
          await this.finishSession(false);
        return true;
      case "failed":
        await this.finishFailedSession(intent.code, intent.reason, intent.stack);
        return true;
      default: {
        const _exhaustive: never = intent;
        return _exhaustive;
      }
    }
  }

  private async applyRewardTerminalIntent(intent: RewardTerminalIntent): Promise<void> {
    switch(intent.kind) {
      case "none":
        return;
      case "complete":
        await this.finishSession();
        return;
      case "failed":
        await this.finishFailedSession(intent.code, intent.reason, intent.stack);
        return;
      default: {
        const _exhaustive: never = intent;
        return _exhaustive;
      }
    }
  }

  public subPenalty(amount: bigint): Promise<bigint> {
    if(!this.manager.canAcceptRewardOperations())
      return Promise.resolve(0n);
    return this.manager.runRewardOperation(() => this.applyPenalty(amount));
  }

  private async applyPenalty(amount: bigint): Promise<bigint> {
    if(!this.canStartReward())
      return 0n;
    
    if(this.dropAmount === -1n)
      this.dropAmount = 0n;
    if(amount > this.dropAmount)
      amount = this.dropAmount;
    this.dropAmount -= amount;
    this.lazySaveSession();
    return amount;
  }

  private canStartReward(): boolean {
    return this.manager.canApplyRewards() && this.canCommitReward();
  }

  private canCommitReward(): boolean {
    return this.status === FaucetSessionStatus.STARTING || this.status === FaucetSessionStatus.RUNNING;
  }

  public async getSessionInfo(): Promise<IClientSessionInfo> {
    let moduleData: any = {};
    await ServiceManager.GetService(ModuleManager).processActionHooks([], ModuleHookAction.SessionInfo, [this, moduleData]);
    let sessionInfo: IClientSessionInfo = {
      session: this.getSessionId(),
      status: this.getSessionStatus(),
      start: this.getStartTime(),
      tasks: this.getBlockingTasks(),
      balance: this.getDropAmount().toString(),
      target: this.getTargetAddr(),
      modules: moduleData
    };
    if(this.status === FaucetSessionStatus.FAILED) {
      sessionInfo.failedCode = this.getSessionData("failed.code");
      sessionInfo.failedReason = this.getSessionData("failed.reason");
    }
    return sessionInfo;
  }

  private async applyRemoteIpUpdate(remoteIP: string): Promise<void> {
    if(this.remoteIP === remoteIP)
      return;

    let oldRemoteIP = this.remoteIP;
    let admissionMove = this.manager.prepareRemoteIpChange(this, oldRemoteIP, remoteIP);
    if(this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.isRemoteIpUpdatePending = true;
    this.remoteIP = remoteIP;
    this.isDirty = true;

    try {
      await ServiceManager.GetService(ModuleManager).processActionHooks([], ModuleHookAction.SessionIpChange, [this]);
      await this.saveSession();
      this.manager.commitRemoteIpChange(admissionMove);
    } catch(ex) {
      this.remoteIP = oldRemoteIP;
      this.isDirty = true;
      this.manager.abortRemoteIpChange(admissionMove);
      throw ex;
    } finally {
      this.isRemoteIpUpdatePending = false;
      if(this.isDirty)
        this.lazySaveSession();
    }
  }

  private normalizeRemoteIP(remoteIP: string): string {
    let normalizedRemoteIP = normalizeIpAddress(remoteIP);
    if(!normalizedRemoteIP)
      throw new FaucetError("INVALID_REMOTE_IP", "Unable to determine a valid client IP address.");
    return normalizedRemoteIP;
  }

  private normalizeTargetAddr(addr: string): string {
    return typeof addr === "string" ? addr.toLowerCase() : addr;
  }

}
