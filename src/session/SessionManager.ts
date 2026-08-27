import { FaucetLogLevel, FaucetProcess } from "../common/FaucetProcess.js";
import { ServiceManager } from "../common/ServiceManager.js";
import { faucetConfig } from "../config/FaucetConfig.js";
import { FaucetDatabase } from "../db/FaucetDatabase.js";
import { FaucetError } from "../common/FaucetError.js";
import { FaucetSession, FaucetSessionStatus, FaucetSessionStoreData } from "./FaucetSession.js";
import {
  AdmissionLedger,
  AdmissionSubject,
  AdmissionSubjectMove,
  AdmissionUsage,
  AdmissionUsageOptions,
  admissionSubject,
} from "./AdmissionLedger.js";

export class SessionManager {
  private initialized: boolean;
  private faucetSessions: {[sessionId: string]: FaucetSession} = {};
  private cleanupTimer: NodeJS.Timeout;
  private readonly admissionLedger = new AdmissionLedger();
  private rewardOperation: Promise<void> = Promise.resolve();
  private rewardOperationsOpen = true;
  private rewardOperationAdmissionOpen = true;
  private timeoutOperations = new Set<Promise<void>>();
  private sessionStartAdmissionOpen = true;
  private sessionStartOperations = new Set<Promise<FaucetSession>>();

  public async initialize(): Promise<void> {
    if(this.initialized)
      return;
    this.initialized = true;
    this.rewardOperationsOpen = true;
    this.rewardOperationAdmissionOpen = true;
    this.sessionStartAdmissionOpen = true;

    let storedSessions = await ServiceManager.GetService(FaucetDatabase).getSessions([
      FaucetSessionStatus.RUNNING,
    ]);
    if(storedSessions.length > 0) {
      await Promise.all(storedSessions.map((storedSession) => {
        let session = new FaucetSession(this);
        return session.restoreSession(storedSession);
      }));
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Restored " + storedSessions.length + " sessions from database.");
    }

    this.cleanupTimer = setInterval(() => {
      this.processSessionTimeouts().catch((err) => {
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.ERROR, "Error while processing session timeouts: " + err.toString());
      });
    }, 120 * 1000);
  }

  public async dispose(): Promise<void> {
    this.stopRewardOperations();
    await this.waitForRewardProducers();
    if(this.rewardOperationAdmissionOpen)
      this.rewardOperationAdmissionOpen = false;
    await this.rewardOperation;
    this.initialized = false;
  }

  public notifySessionUpdate(session: FaucetSession) {
    switch(session.getSessionStatus()) {
      case FaucetSessionStatus.RUNNING:
        if(!this.faucetSessions[session.getSessionId()])
          this.faucetSessions[session.getSessionId()] = session;
        break;
      default:
        if(this.faucetSessions[session.getSessionId()])
          delete this.faucetSessions[session.getSessionId()];
        break;
    }
  }

  public beginAdmission(session: FaucetSession, restored = false): void {
    let subjects = [admissionSubject.ip(session.getRemoteIP())];
    if(session.getTargetAddr())
      subjects.push(admissionSubject.address(session.getTargetAddr()));
    this.admissionLedger.begin(
      session.getSessionId(),
      session.getStartTime(),
      session.getClaimCeiling(),
      subjects,
      restored,
    );
  }

  public bindAdmissionSubjects(session: FaucetSession, subjects: AdmissionSubject[]): void {
    this.admissionLedger.bind(session.getSessionId(), subjects);
  }

  public getPriorAdmissionUsage(
    session: FaucetSession,
    subjects: AdmissionSubject[],
    options?: AdmissionUsageOptions,
  ): AdmissionUsage {
    return this.admissionLedger.getPriorUsage(session.getSessionId(), subjects, options);
  }

  public markAdmissionRunning(session: FaucetSession): void {
    this.admissionLedger.markRunning(session.getSessionId());
  }

  public markAdmissionCommitting(session: FaucetSession): void {
    this.admissionLedger.markCommitting(session.getSessionId());
  }

  public releaseAdmission(session: FaucetSession): void {
    this.admissionLedger.release(session.getSessionId());
  }

  public setAdmissionClaimCeiling(session: FaucetSession, amount: bigint): void {
    this.admissionLedger.setClaimCeiling(session.getSessionId(), amount);
  }

  public reserveAdmissionClaimCeiling(session: FaucetSession, amount: bigint): void {
    this.admissionLedger.reserveClaimCeiling(session.getSessionId(), amount);
  }

  public runRewardOperation<T>(operation: () => Promise<T>): Promise<T> {
    if(!this.rewardOperationAdmissionOpen)
      return Promise.reject(new Error("Reward operation admission is closed."));
    const result = this.rewardOperation.then(() => Promise.resolve().then(operation));
    this.rewardOperation = result.then(() => undefined, () => undefined);
    return result;
  }

  public stopRewardOperations(): void {
    this.rewardOperationsOpen = false;
    this.sessionStartAdmissionOpen = false;
    if(this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    Object.values(this.faucetSessions).forEach((session) => session.quiesceForShutdown());
  }

  public async drainRewardProducers(): Promise<void> {
    await this.waitForRewardProducers();
  }

  private async waitForRewardProducers(): Promise<void> {
    while(this.timeoutOperations.size > 0 || this.sessionStartOperations.size > 0) {
      await Promise.allSettled([
        ...this.timeoutOperations,
        ...this.sessionStartOperations,
      ]);
    }
  }

  public canApplyRewards(): boolean {
    return this.rewardOperationsOpen;
  }

  public canAcceptRewardOperations(): boolean {
    return this.rewardOperationAdmissionOpen;
  }

  public drainRewardOperations(): Promise<void> {
    this.rewardOperationAdmissionOpen = false;
    return this.rewardOperation;
  }

  public prepareRemoteIpChange(session: FaucetSession, oldRemoteIp: string, newRemoteIp: string): AdmissionSubjectMove {
    return this.admissionLedger.prepareMove(
      session.getSessionId(),
      admissionSubject.ip(oldRemoteIp),
      admissionSubject.ip(newRemoteIp),
    );
  }

  public commitRemoteIpChange(move: AdmissionSubjectMove): void {
    this.admissionLedger.commitMove(move);
  }

  public abortRemoteIpChange(move: AdmissionSubjectMove): void {
    this.admissionLedger.abortMove(move);
  }

  public getSession(sessionId: string, states?: FaucetSessionStatus[]): FaucetSession {
    if(this.faucetSessions[sessionId]) {
      if(!states || states.indexOf(this.faucetSessions[sessionId].getSessionStatus()) !== -1)
        return this.faucetSessions[sessionId];
      else
        return null;
    }
    return undefined;
  }

  public async getSessionData(sessionId: string): Promise<FaucetSessionStoreData> {
    if(this.faucetSessions[sessionId])
      return this.faucetSessions[sessionId].getStoreData()
    return await ServiceManager.GetService(FaucetDatabase).getSession(sessionId);
  }

  public getActiveSessions(): FaucetSession[] {
    return Object.values(this.faucetSessions).filter((session) => session.getSessionStatus() === FaucetSessionStatus.RUNNING);
  }

  public async getUnclaimedBalance(): Promise<bigint> {
    let totalBalance = 0n;
    Object.values(this.faucetSessions).forEach((session) => {
      if(session.getSessionStatus() !== FaucetSessionStatus.CLAIMING)
        totalBalance += session.getDropAmount();
    });
    totalBalance += await ServiceManager.GetService(FaucetDatabase).getClaimableAmount();
    return totalBalance;
  }

  public createSession(remoteIP: string, userInput: any, overrides?: any): Promise<FaucetSession> {
    if(!this.sessionStartAdmissionOpen) {
      return Promise.reject(new FaucetError(
        "FAUCET_UNAVAILABLE",
        "The faucet is temporarily unavailable. Please try again shortly.",
      ));
    }

    const operation = this.startSession(remoteIP, userInput, overrides);
    this.sessionStartOperations.add(operation);
    void operation.then(
      () => this.sessionStartOperations.delete(operation),
      () => this.sessionStartOperations.delete(operation),
    );
    return operation;
  }

  private async startSession(remoteIP: string, userInput: any, overrides?: any): Promise<FaucetSession> {
    let session = new FaucetSession(this);
    await session.startSession(remoteIP, userInput, overrides);
    ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "New session for " + session.getTargetAddr() + " (IP: " + session.getRemoteIP() + ", ID: " + session.getSessionId() + ")");
    return session;
  }

  public async saveAllSessions(): Promise<void> {
    const sessions = Object.values(this.faucetSessions);
    const results = await Promise.allSettled(sessions.map((session) => {
      return Promise.resolve().then(() => session.saveSession());
    }));
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);

    if(errors.length === 1)
      throw errors[0];
    if(errors.length > 1)
      throw new AggregateError(errors, "One or more active sessions failed to save");
  }

  public processSessionTimeouts(): Promise<void> {
    if(!this.rewardOperationsOpen)
      return Promise.resolve();

    const operation = this.applySessionTimeouts();
    this.timeoutOperations.add(operation);
    void operation.then(
      () => this.timeoutOperations.delete(operation),
      () => this.timeoutOperations.delete(operation),
    );
    return operation;
  }

  private async applySessionTimeouts(): Promise<void> {
    let faucetDatabase = ServiceManager.GetService(FaucetDatabase);
    let timedOutSessions = await faucetDatabase.getTimedOutSessions(faucetConfig.sessionTimeout);
    if(timedOutSessions.length === 0)
      return;

    let closedSessionCount = 0;
    for(let i = 0; i < timedOutSessions.length; i++) {
      let timedOutSessionData = timedOutSessions[i];
      let timedOut = await this.runRewardOperation(async () => {
        let timedOutSession = this.getSession(timedOutSessionData.sessionId);
        if(timedOutSession)
          return await timedOutSession.tryApplyTimeout(faucetConfig.sessionTimeout);
        return await faucetDatabase.tryTimeoutSession(timedOutSessionData, faucetConfig.sessionTimeout);
      });
      if(timedOut)
        closedSessionCount++;
    }

    if(closedSessionCount > 0) {
      ServiceManager.GetService(FaucetProcess).emitLog(
        FaucetLogLevel.INFO,
        "Closed " + closedSessionCount + " sessions (session timeout)",
      );
    }
  }


}
