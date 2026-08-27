import { Worker } from "node:worker_threads";

import { FaucetWorkers } from "../../../common/FaucetWorker.js";
import { ServiceManager } from "../../../common/ServiceManager.js";
import { PromiseDfd } from "../../../utils/PromiseDfd.js";
import {
  IPoWValidatorLimits,
  IPoWValidatorValidateRequest,
  PoWValidationAdmission,
} from "./IPoWValidator.js";

export interface IPoWValidatorOptions {
  worker?: Worker;
  workerFactory?: () => Worker;
  initTimeoutMs?: number;
}

interface IWorkerGeneration {
  id: number;
  worker: Worker;
  onMessage: (message: unknown) => void;
  onError: (error: Error) => void;
  onExit: (code: number) => void;
  listenersAttached: boolean;
  termination?: Promise<void>;
}

type ValidatorState =
  | {kind: "starting"; generation: IWorkerGeneration; timeout: NodeJS.Timeout}
  | {kind: "ready"; generation: IWorkerGeneration}
  | {kind: "restarting"; generation: IWorkerGeneration}
  | {kind: "failed"; error: Error; generation?: IWorkerGeneration}
  | {kind: "disposed"};

interface IPendingValidation {
  sessionId: string;
  generationId: number;
  maxSessionDutyCyclePercent: number;
  request: IPoWValidatorValidateRequest;
  result: PromiseDfd<boolean>;
  timeout: NodeJS.Timeout;
}

const DEFAULT_INIT_TIMEOUT_MS = 10_000;

export class PoWValidator {
  private readonly workerFactory: () => Worker;
  private readonly initTimeoutMs: number;
  private readonly pending = new Map<string, IPendingValidation>();
  private readonly pendingBySession = new Map<string, number>();
  private readonly queuedShareIdsBySession = new Map<string, string[]>();
  private readonly schedulingSessions: string[] = [];
  private readonly sessionDispatchReadyAt = new Map<string, number>();
  private activeShareId: string;
  private activeStartedAt: number;
  private dispatchTimer: NodeJS.Timeout;
  private state: ValidatorState = {kind: "failed", error: new Error("PoW validator not initialized")};
  private nextGenerationId = 0;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private disposePromise: Promise<void>;

  public constructor(options: IPoWValidatorOptions = {}) {
    this.workerFactory = options.workerFactory ?? (() => ServiceManager.GetService(FaucetWorkers).createWorker("pow-validator"));
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.startGeneration(options.worker);
  }

  public dispose(reason = "PoW validator disposed"): Promise<void> {
    if(this.disposePromise)
      return this.disposePromise;

    let generation = this.getOwnedGeneration();
    this.clearInitTimeout();
    this.clearDispatchTimer();
    this.state = {kind: "disposed"};
    this.rejectAll(new Error(reason));
    this.sessionDispatchReadyAt.clear();
    if(generation)
      this.removeGenerationListeners(generation);

    this.disposePromise = this.enqueueLifecycle(async () => {
      if(generation)
        await this.terminateGeneration(generation);
    });
    return this.disposePromise;
  }

  public getValidationQueueLength(): number {
    return this.pending.size;
  }

  public tryValidateShare(
    sessionId: string,
    request: IPoWValidatorValidateRequest,
    limits: IPoWValidatorLimits,
  ): PoWValidationAdmission {
    if(!this.isValidRequest(sessionId, request, limits))
      return {kind: "rejected", reason: "invalid-policy"};
    if(this.state.kind !== "ready")
      return {kind: "rejected", reason: "unavailable"};
    if(this.getSessionDispatchReadyAt(sessionId) > performance.now())
      return {kind: "rejected", reason: "session-rate"};
    if(this.pending.size >= limits.maxGlobalPending)
      return {kind: "rejected", reason: "global-capacity"};
    if((this.pendingBySession.get(sessionId) ?? 0) >= limits.maxSessionPending)
      return {kind: "rejected", reason: "session-capacity"};
    if(this.pending.has(request.shareId))
      return {kind: "rejected", reason: "invalid-policy"};

    let generation = this.state.generation;
    let result = new PromiseDfd<boolean>();
    let timeout = setTimeout(
      () => this.onValidationTimeout(request.shareId, generation.id),
      limits.timeoutMs,
    );
    timeout.unref?.();
    this.pending.set(request.shareId, {
      sessionId,
      generationId: generation.id,
      maxSessionDutyCyclePercent: limits.maxSessionDutyCyclePercent,
      request,
      result,
      timeout,
    });
    this.pendingBySession.set(sessionId, (this.pendingBySession.get(sessionId) ?? 0) + 1);

    this.enqueueValidation(sessionId, request.shareId);
    this.dispatchNextValidation();

    return {kind: "accepted", promise: result.promise};
  }

  public cancelValidation(shareId: string, reason = "PoW validation cancelled"): void {
    let validation = this.pending.get(shareId);
    if(!validation)
      return;

    let generation = this.getActiveGeneration();
    if(generation && generation.id === validation.generationId && this.activeShareId === shareId)
      this.requestRestart(generation, new Error(reason));
    else {
      this.rejectValidation(shareId, new Error(reason));
      this.dispatchNextValidation();
    }
  }

  public cancelSession(sessionId: string, reason = "PoW session closed"): void {
    let ownedShareIds = [...this.pending.entries()]
      .filter(([, validation]) => validation.sessionId === sessionId)
      .map(([shareId]) => shareId);
    if(ownedShareIds.length === 0) {
      this.sessionDispatchReadyAt.delete(sessionId);
      return;
    }

    let generation = this.getActiveGeneration();
    let activeValidation = this.activeShareId ? this.pending.get(this.activeShareId) : null;
    if(generation && activeValidation?.sessionId === sessionId && activeValidation.generationId === generation.id)
      this.requestRestart(generation, new Error(reason));
    else {
      for(let shareId of ownedShareIds)
        this.rejectValidation(shareId, new Error(reason));
      this.dispatchNextValidation();
    }
    this.sessionDispatchReadyAt.delete(sessionId);
  }

  private startGeneration(providedWorker?: Worker): void {
    if(this.state.kind === "disposed")
      return;

    let worker = providedWorker ?? this.workerFactory();
    let generation: IWorkerGeneration;
    generation = {
      id: ++this.nextGenerationId,
      worker,
      onMessage: (message) => this.onWorkerMessage(generation, message),
      onError: (error) => this.onWorkerFailure(generation, this.toError(error, "PoW validator worker failed")),
      onExit: (code) => this.onWorkerFailure(generation, new Error(`PoW validator exited with code ${code}`)),
      listenersAttached: true,
    };
    worker.on("message", generation.onMessage);
    worker.on("error", generation.onError);
    worker.on("exit", generation.onExit);

    let timeout = setTimeout(
      () => this.onWorkerFailure(generation, new Error("PoW validator initialization timed out")),
      this.initTimeoutMs,
    );
    timeout.unref?.();
    this.state = {kind: "starting", generation, timeout};
  }

  private onWorkerMessage(generation: IWorkerGeneration, message: unknown): void {
    if(!this.isCurrentGeneration(generation) || typeof message !== "object" || message === null)
      return;

    let workerMessage = message as {action?: unknown; data?: unknown};
    switch(workerMessage.action) {
      case "init":
        this.onWorkerReady(generation);
        break;
      case "validated":
        this.onWorkerValidated(generation, workerMessage.data);
        break;
      case "validation-error":
        this.onWorkerValidationError(generation, workerMessage.data);
        break;
    }
  }

  private onWorkerReady(generation: IWorkerGeneration): void {
    if(this.state.kind !== "starting" || this.state.generation !== generation)
      return;

    clearTimeout(this.state.timeout);
    this.state = {kind: "ready", generation};
    this.dispatchNextValidation();
  }

  private onWorkerValidated(generation: IWorkerGeneration, data: unknown): void {
    if(this.state.kind !== "ready" || this.state.generation !== generation || !this.isValidationResult(data))
      return;

    let validation = this.pending.get(data.shareId);
    if(!validation || validation.generationId !== generation.id || this.activeShareId !== data.shareId)
      return;

    this.releaseValidation(data.shareId);
    validation.result.resolve(data.isValid);
    this.dispatchNextValidation();
  }

  private onWorkerValidationError(generation: IWorkerGeneration, data: unknown): void {
    if(this.state.kind !== "ready" || this.state.generation !== generation || !this.hasShareId(data))
      return;

    let validation = this.pending.get(data.shareId);
    if(!validation || validation.generationId !== generation.id || this.activeShareId !== data.shareId)
      return;
    this.rejectValidation(data.shareId, new Error("PoW validation failed"));
    this.dispatchNextValidation();
  }

  private onValidationTimeout(shareId: string, generationId: number): void {
    let validation = this.pending.get(shareId);
    if(!validation || validation.generationId !== generationId)
      return;

    let generation = this.getActiveGeneration();
    if(generation && generation.id === generationId && this.activeShareId === shareId)
      this.requestRestart(generation, new Error("PoW validation timed out"));
    else {
      this.rejectValidation(shareId, new Error("PoW validation timed out"));
      this.dispatchNextValidation();
    }
  }

  private onWorkerFailure(generation: IWorkerGeneration, error: Error): void {
    if(!this.isCurrentGeneration(generation) || this.state.kind === "restarting")
      return;
    this.requestRestart(generation, error);
  }

  private requestRestart(generation: IWorkerGeneration, error: Error): void {
    if(!this.isCurrentGeneration(generation) || this.state.kind === "restarting" || this.state.kind === "disposed")
      return;

    this.clearInitTimeout();
    this.state = {kind: "restarting", generation};
    this.rejectAll(error);
    this.removeGenerationListeners(generation);

    this.enqueueLifecycle(async () => {
      try {
        await this.terminateGeneration(generation);
      }
      catch(terminationError) {
        if(this.state.kind === "restarting" && this.state.generation === generation) {
          this.state = {
            kind: "failed",
            generation,
            error: this.toError(terminationError, "PoW validator termination failed"),
          };
        }
        return;
      }

      if(this.state.kind !== "restarting" || this.state.generation !== generation)
        return;
      try {
        this.startGeneration();
      }
      catch(restartError) {
        this.state = {kind: "failed", error: this.toError(restartError, "PoW validator restart failed")};
      }
    });
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    let result = this.lifecycleTail.then(operation);
    this.lifecycleTail = result.catch(() => undefined);
    return result;
  }

  private terminateGeneration(generation: IWorkerGeneration): Promise<void> {
    if(generation.termination)
      return generation.termination;

    this.removeGenerationListeners(generation);
    generation.termination = Promise.resolve()
      .then(() => generation.worker.terminate())
      .then(() => undefined);
    return generation.termination;
  }

  private removeGenerationListeners(generation: IWorkerGeneration): void {
    if(!generation.listenersAttached)
      return;
    generation.listenersAttached = false;
    generation.worker.off("message", generation.onMessage);
    generation.worker.off("error", generation.onError);
    generation.worker.off("exit", generation.onExit);
  }

  private rejectAll(error: Error): void {
    this.clearDispatchTimer();
    for(let shareId of [...this.pending.keys()])
      this.rejectValidation(shareId, error);
    this.activeShareId = null;
    this.activeStartedAt = null;
    this.queuedShareIdsBySession.clear();
    this.schedulingSessions.length = 0;
  }

  private rejectValidation(shareId: string, error: Error): void {
    let validation = this.pending.get(shareId);
    if(!validation)
      return;
    this.releaseValidation(shareId);
    validation.result.reject(error);
  }

  private releaseValidation(shareId: string): void {
    let validation = this.pending.get(shareId);
    if(!validation)
      return;

    clearTimeout(validation.timeout);
    this.recordActiveSessionWork(shareId, validation);
    this.pending.delete(shareId);
    this.releaseScheduledValidation(validation.sessionId, shareId);
    let sessionPending = (this.pendingBySession.get(validation.sessionId) ?? 1) - 1;
    if(sessionPending > 0)
      this.pendingBySession.set(validation.sessionId, sessionPending);
    else
      this.pendingBySession.delete(validation.sessionId);
  }

  private enqueueValidation(sessionId: string, shareId: string): void {
    let queuedShareIds = this.queuedShareIdsBySession.get(sessionId);
    if(!queuedShareIds) {
      queuedShareIds = [];
      this.queuedShareIdsBySession.set(sessionId, queuedShareIds);
    }
    queuedShareIds.push(shareId);

    let activeSessionId = this.activeShareId
      ? this.pending.get(this.activeShareId)?.sessionId
      : null;
    if(activeSessionId !== sessionId && !this.schedulingSessions.includes(sessionId))
      this.schedulingSessions.push(sessionId);
  }

  private dispatchNextValidation(): void {
    if(this.state.kind !== "ready" || this.activeShareId)
      return;

    this.clearDispatchTimer();
    let sessionCount = this.schedulingSessions.length;
    let earliestReadyAt = Number.POSITIVE_INFINITY;
    for(let i = 0; i < sessionCount; i++) {
      let sessionId = this.schedulingSessions.shift();
      let queuedShareIds = this.queuedShareIdsBySession.get(sessionId);
      if(!queuedShareIds?.length)
        continue;

      let readyAt = this.getSessionDispatchReadyAt(sessionId);
      if(readyAt > performance.now()) {
        this.schedulingSessions.push(sessionId);
        earliestReadyAt = Math.min(earliestReadyAt, readyAt);
        continue;
      }

      let shareId = queuedShareIds.shift();
      if(queuedShareIds.length === 0)
        this.queuedShareIdsBySession.delete(sessionId);

      let validation = this.pending.get(shareId);
      if(!validation)
        continue;
      this.activeShareId = shareId;
      this.activeStartedAt = performance.now();

      try {
        this.state.generation.worker.postMessage({
          action: "validate",
          data: this.getValidationRequest(shareId),
        });
      }
      catch(error) {
        this.requestRestart(this.state.generation, this.toError(error, "PoW validator dispatch failed"));
      }
      return;
    }

    if(Number.isFinite(earliestReadyAt))
      this.scheduleDispatch(earliestReadyAt - performance.now());
  }

  private recordActiveSessionWork(shareId: string, validation: IPendingValidation): void {
    if(this.activeShareId !== shareId || this.activeStartedAt === null || this.activeStartedAt === undefined)
      return;

    let now = performance.now();
    let elapsedMs = Math.max(1, now - this.activeStartedAt);
    let cooldownMs = Math.ceil(
      elapsedMs * (100 - validation.maxSessionDutyCyclePercent) / validation.maxSessionDutyCyclePercent,
    );
    let currentReadyAt = this.sessionDispatchReadyAt.get(validation.sessionId) ?? 0;
    this.sessionDispatchReadyAt.set(validation.sessionId, Math.max(currentReadyAt, now + cooldownMs));
    this.activeStartedAt = null;
  }

  private getSessionDispatchReadyAt(sessionId: string): number {
    let readyAt = this.sessionDispatchReadyAt.get(sessionId) ?? 0;
    if(readyAt <= performance.now()) {
      this.sessionDispatchReadyAt.delete(sessionId);
      return 0;
    }
    return readyAt;
  }

  private scheduleDispatch(delayMs: number): void {
    this.dispatchTimer = setTimeout(() => {
      this.dispatchTimer = null;
      this.dispatchNextValidation();
    }, Math.max(1, Math.ceil(delayMs)));
    this.dispatchTimer.unref?.();
  }

  private clearDispatchTimer(): void {
    if(!this.dispatchTimer)
      return;
    clearTimeout(this.dispatchTimer);
    this.dispatchTimer = null;
  }

  private releaseScheduledValidation(sessionId: string, shareId: string): void {
    if(this.activeShareId === shareId) {
      this.activeShareId = null;
      let queuedShareIds = this.queuedShareIdsBySession.get(sessionId);
      if(queuedShareIds?.length && !this.schedulingSessions.includes(sessionId))
        this.schedulingSessions.push(sessionId);
      return;
    }

    let queuedShareIds = this.queuedShareIdsBySession.get(sessionId);
    if(!queuedShareIds)
      return;
    let queueIndex = queuedShareIds.indexOf(shareId);
    if(queueIndex !== -1)
      queuedShareIds.splice(queueIndex, 1);
    if(queuedShareIds.length === 0) {
      this.queuedShareIdsBySession.delete(sessionId);
      let schedulingIndex = this.schedulingSessions.indexOf(sessionId);
      if(schedulingIndex !== -1)
        this.schedulingSessions.splice(schedulingIndex, 1);
    }
  }

  private getValidationRequest(shareId: string): IPoWValidatorValidateRequest {
    let validation = this.pending.get(shareId);
    if(!validation)
      throw new Error("PoW validation request is no longer pending");
    return validation.request;
  }

  private getActiveGeneration(): IWorkerGeneration | null {
    switch(this.state.kind) {
      case "starting":
      case "ready":
      case "restarting":
        return this.state.generation;
      default:
        return null;
    }
  }

  private getOwnedGeneration(): IWorkerGeneration | null {
    if(this.state.kind === "failed")
      return this.state.generation ?? null;
    return this.getActiveGeneration();
  }

  private isCurrentGeneration(generation: IWorkerGeneration): boolean {
    return this.getActiveGeneration() === generation;
  }

  private clearInitTimeout(): void {
    if(this.state.kind === "starting")
      clearTimeout(this.state.timeout);
  }

  private isValidRequest(
    sessionId: string,
    request: IPoWValidatorValidateRequest,
    limits: IPoWValidatorLimits,
  ): boolean {
    return (
      typeof sessionId === "string" && sessionId.length > 0 &&
      typeof request?.shareId === "string" && request.shareId.length > 0 &&
      Number.isSafeInteger(request.nonce) && request.nonce >= 0 &&
      Number.isSafeInteger(request.difficulty) && request.difficulty >= 0 &&
      Number.isSafeInteger(limits.maxGlobalPending) && limits.maxGlobalPending > 0 &&
      Number.isSafeInteger(limits.maxSessionPending) && limits.maxSessionPending > 0 &&
      limits.maxSessionPending < limits.maxGlobalPending &&
      Number.isSafeInteger(limits.maxSessionDutyCyclePercent) &&
      limits.maxSessionDutyCyclePercent > 0 && limits.maxSessionDutyCyclePercent <= 50 &&
      Number.isFinite(limits.timeoutMs) && limits.timeoutMs > 0
    );
  }

  private isValidationResult(value: unknown): value is {shareId: string; isValid: boolean} {
    return (
      typeof value === "object" &&
      value !== null &&
      typeof (value as {shareId?: unknown}).shareId === "string" &&
      typeof (value as {isValid?: unknown}).isValid === "boolean"
    );
  }

  private hasShareId(value: unknown): value is {shareId: string} {
    return typeof value === "object" && value !== null && typeof (value as {shareId?: unknown}).shareId === "string";
  }

  private toError(error: unknown, fallback: string): Error {
    return error instanceof Error ? error : new Error(fallback);
  }
}
