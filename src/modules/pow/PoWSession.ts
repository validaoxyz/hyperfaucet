import { PromiseDfd } from "../../utils/PromiseDfd.js";
import { PoWClient } from "./PoWClient.js";
import { PoWServerWorker } from "./PoWServerWorker.js";
import { isValidReportedHashrate } from "./PoWConfig.js";

interface IPoWSessionPropValue {
  value: any;
  dirty: boolean;
}

interface IPendingReward {
  result: PromiseDfd<[bigint, bigint]>;
  timeout: NodeJS.Timeout;
}

interface IPendingSessionClose {
  type: string;
  reason: string;
  sentType?: string;
}

const DEFAULT_REWARD_ACK_TIMEOUT_MS = 30_000;

export class PoWSession {
  private sessionId: string;
  private worker: PoWServerWorker;
  private sessionData: {[key: string]: IPoWSessionPropValue} = {};
  private currentActiveClient: PoWClient;
  private verifyStats: {missed: number, pending: number} = {missed: 0, pending: 0};
  private idleTimeout: NodeJS.Timeout;
  private balance: bigint = BigInt(0);
  private rewardCounter = 0;
  private rewardRequests = new Map<number, IPendingReward>();
  private sessionCloseDfd: PromiseDfd<any>;
  private pendingSessionClose: IPendingSessionClose;
  private securityDecisionCount = 0;
  private disposed = false;
  private readonly rewardAckTimeoutMs: number;

  public constructor(sessionId: string, worker: PoWServerWorker, rewardAckTimeoutMs = DEFAULT_REWARD_ACK_TIMEOUT_MS) {
    this.sessionId = sessionId;
    this.worker = worker;
    this.rewardAckTimeoutMs = rewardAckTimeoutMs;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public getWorker(): PoWServerWorker {
    return this.worker;
  }

  public loadSessionData(data: any) {
    for(let key in data) {
      if(key === "_balance")
        this.balance = BigInt(data[key]);
      else if(key === "pow.idleTimer")
        continue;
      else
        this.sessionData[key] = {
          value: data[key],
          dirty: false
        };
    }

    if(Object.prototype.hasOwnProperty.call(data, "pow.hashrates") || Object.prototype.hasOwnProperty.call(data, "pow.hashrate")) {
      let reportedHashrates = this.reportedHashrate;
      this.reportedHashrate = reportedHashrates;
    }
  }

  public getSessionProp(key: string): any {
    return this.sessionData[key]?.value;
  }

  private setSessionProp(key: string, value: any) {
    if(this.sessionData[key] && this.sessionData[key].value === value)
      return;
    this.sessionData[key] = {
      value: value,
      dirty: true
    };
  }

  public getDropAmount(): bigint {
    return this.balance;
  }

  public async subPenalty(amount: bigint, type: string) {
    return this.addReward(amount * -1n, type);
  }

  public addReward(amount: bigint, type: string): Promise<bigint> {
    if(this.disposed)
      return Promise.reject(new Error("PoW session is disposed"));

    let dirtyProps = this.getDirtyProps(true);
    let reqId = this.rewardCounter++;
    let result = new PromiseDfd<[bigint, bigint]>();
    let timeout = setTimeout(() => {
      this.rejectReward(reqId, new Error("PoW reward acknowledgement timed out"));
    }, this.rewardAckTimeoutMs);
    timeout.unref?.();
    this.rewardRequests.set(reqId, {result, timeout});

    try {
      this.worker.sendSessionReward(this.sessionId, reqId, amount, type, dirtyProps);
    } catch(error) {
      this.rejectReward(reqId, this.toError(error));
    }

    return result.promise.then(([rewardAmount, balance]) => {
      this.balance = balance;
      return rewardAmount;
    });
  }

  public processReward(reqId: number, amount: bigint, balance: bigint) {
    let pending = this.takeReward(reqId);
    pending?.result.resolve([amount, balance]);
  }

  public processRewardError(reqId: number, message: string): void {
    this.rejectReward(reqId, new Error(message || "PoW reward failed"));
  }

  public dispose(reason: string): void {
    if(this.disposed)
      return;
    this.disposed = true;

    for(let reqId of [...this.rewardRequests.keys()])
      this.rejectReward(reqId, new Error(reason));
    this.sessionCloseDfd?.resolve(null);
  }

  private rejectReward(reqId: number, error: Error): boolean {
    let pending = this.takeReward(reqId);
    if(!pending)
      return false;
    pending.result.reject(error);
    return true;
  }

  private takeReward(reqId: number): IPendingReward | undefined {
    let pending = this.rewardRequests.get(reqId);
    if(!pending)
      return undefined;
    this.rewardRequests.delete(reqId);
    clearTimeout(pending.timeout);
    return pending;
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  public get startTime(): number {
    return this.getSessionProp("_startTime");
  }

  public get activeClient(): PoWClient {
    return this.currentActiveClient;
  }

  public set activeClient(value: PoWClient) {
    this.currentActiveClient = value;
    if(value)
      this.setSessionProp("pow.idleTime", null);
    else
      this.setSessionProp("pow.idleTime", Math.floor(new Date().getTime() / 1000));
  }

  public get idleTime(): number {
    return this.getSessionProp("pow.idleTime");
  }

  public get idleTimer(): NodeJS.Timeout {
    return this.idleTimeout;
  }

  public set idleTimer(value: NodeJS.Timeout) {
    this.idleTimeout = value;
  }

  public get lastNonce(): number {
    return this.getSessionProp("pow.lastNonce") || 0;
  }

  public set lastNonce(value: number) {
    this.setSessionProp("pow.lastNonce", value);
  }

  public get shareCount(): number {
    return this.getSessionProp("pow.shareCount") || 0;
  }

  public set shareCount(value: number) {
    this.setSessionProp("pow.shareCount", value);
  }

  public get missedVerifications(): number {
    return this.verifyStats.missed;
  }

  public set missedVerifications(value: number) {
    this.verifyStats.missed = value;
  }

  public get pendingVerifications(): number {
    return this.verifyStats.pending;
  }

  public set pendingVerifications(value: number) {
    this.verifyStats.pending = value;
  }

  public get reportedHashrate(): number[] {
    let values = this.getSessionProp("pow.hashrates");
    if(!Array.isArray(values))
      return [];
    return values.filter(isValidReportedHashrate).slice(-5);
  }

  public set reportedHashrate(value: number[]) {
    value = value.filter(isValidReportedHashrate).slice(-5);
    let avgCount = 0;
    let avgSum = 0;
    value.forEach((val) => {
      avgCount++;
      avgSum += val;
    });
    this.setSessionProp("pow.hashrates", value);
    this.setSessionProp("pow.hashrate", avgCount > 0 ? avgSum / avgCount : 0);
  }

  public get preImage(): string {
    return this.getSessionProp("pow.preimage") || null;
  }

  public set preImage(value: string) {
    this.setSessionProp("pow.preimage", value);
  }

  public getDirtyProps(reset: boolean = true): {[key: string]: any} {
    let dirtyProps: {[key: string]: any} = {};
    for(let key in this.sessionData) {
      if(this.sessionData[key].dirty) {
        dirtyProps[key] = this.sessionData[key].value;
        if(reset)
          this.sessionData[key].dirty = false;
      }
    }
    return dirtyProps;
  }

  public slashSession(reason: string) {
    return this.closeSession("slashed", reason);
  }

  public holdBenignCloseForSecurityDecision(): () => void {
    if(this.disposed)
      return () => undefined;

    this.securityDecisionCount++;
    let released = false;
    return () => {
      if(released)
        return;
      released = true;
      this.securityDecisionCount = Math.max(0, this.securityDecisionCount - 1);
      this.trySendSessionClose();
    };
  }

  public async closeSession(type?: string, reason?: string): Promise<any> {
    if(this.disposed)
      return null;

    let closeType = type || "closed";
    let closeReason = reason || "";
    if(!this.sessionCloseDfd)
      this.sessionCloseDfd = new PromiseDfd<any>();

    if(!this.pendingSessionClose) {
      this.pendingSessionClose = {type: closeType, reason: closeReason};
    }
    else if(closeType === "slashed" && this.pendingSessionClose.type !== "slashed") {
      this.pendingSessionClose.type = closeType;
      this.pendingSessionClose.reason = closeReason;
    }

    this.trySendSessionClose();
    return this.sessionCloseDfd.promise;
  }

  private trySendSessionClose(): void {
    let close = this.pendingSessionClose;
    if(
      this.disposed ||
      !close ||
      close.sentType === close.type ||
      (close.type !== "slashed" && this.securityDecisionCount > 0)
    )
      return;

    let dirtyProps = this.getDirtyProps(true);
    this.worker.sendSessionAbort(this.sessionId, close.type, close.reason, dirtyProps);
    close.sentType = close.type;
  }

  public processSessionClose(info: any) {
    if(this.sessionCloseDfd) {
      this.sessionCloseDfd.resolve(info);
    }
  }
}
