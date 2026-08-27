import { PromiseDfd } from "../../utils/PromiseDfd.js";
import { FaucetWorkers } from "../../common/FaucetWorker.js";
import { ServiceManager } from "../../common/ServiceManager.js";
import type { IPassportWorkerVerifyRequest, PassportWorkerRequest } from "./PassportWorker.js";

const DEFAULT_INIT_TIMEOUT_MS = 120_000;
const DEFAULT_RESTART_BACKOFF_MS = 100;
const DEFAULT_MAX_RESTART_BACKOFF_MS = 5_000;

type PassportWorkerPhase = "starting" | "ready" | "stopping";

export interface PassportVerifierWorker {
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  postMessage(message: PassportWorkerRequest): void;
  terminate(): Promise<number>;
  removeAllListeners(): this;
}

interface PassportWorkerGeneration {
  id: number;
  worker: PassportVerifierWorker;
  phase: PassportWorkerPhase;
  initTimeout: NodeJS.Timeout | null;
}

type PassportTerminationState =
  | {kind: "drained"}
  | {kind: "undrained", generation: PassportWorkerGeneration};

interface PendingPassportVerification {
  generationId: number;
  request: IPassportWorkerVerifyRequest;
  result: PromiseDfd<string>;
  timeout: NodeJS.Timeout | null;
  phase: "queued" | "in-flight";
}

export interface PassportDIDKitVerifierOptions {
  verifyTimeoutMs: number;
  maxPendingVerifications: number;
  initTimeoutMs?: number;
  restartBackoffMs?: number;
  maxRestartBackoffMs?: number;
  workerFactory?: () => PassportVerifierWorker;
}

export class PassportVerificationUnavailableError extends Error {
  public constructor(message = "Passport verification is unavailable.") {
    super(message);
    this.name = "PassportVerificationUnavailableError";
  }
}

export class PassportDIDKitVerifier {
  private readonly verifyTimeoutMs: number;
  private readonly maxPendingVerifications: number;
  private readonly initTimeoutMs: number;
  private readonly restartBackoffMs: number;
  private readonly maxRestartBackoffMs: number;
  private readonly workerFactory: () => PassportVerifierWorker;
  private readonly pending = new Map<number, PendingPassportVerification>();
  private generation: PassportWorkerGeneration | null = null;
  private generationIdCounter = 1;
  private requestIdCounter = 1;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private recoveryPromise: Promise<void> | null = null;
  private terminationState: PassportTerminationState = {kind: "drained"};
  private reloadPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private accepting = true;
  private stopped = false;

  public constructor(options: PassportDIDKitVerifierOptions) {
    this.verifyTimeoutMs = options.verifyTimeoutMs;
    this.maxPendingVerifications = options.maxPendingVerifications;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.restartBackoffMs = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
    this.maxRestartBackoffMs = options.maxRestartBackoffMs ?? DEFAULT_MAX_RESTART_BACKOFF_MS;
    this.workerFactory = options.workerFactory
      || (() => ServiceManager.GetService(FaucetWorkers).createWorker("passport-worker"));

    this.assertPositiveInteger(this.verifyTimeoutMs, "Passport verification timeout");
    this.assertPositiveInteger(this.maxPendingVerifications, "Passport verification capacity");
    this.assertPositiveInteger(this.initTimeoutMs, "Passport verifier initialization timeout");
    this.assertPositiveInteger(this.restartBackoffMs, "Passport verifier restart backoff");
    this.assertPositiveInteger(this.maxRestartBackoffMs, "Passport verifier maximum restart backoff");
  }

  public verifyCredential(credentialJson: string, proofOptionsJson: string): Promise<string> {
    if(!this.accepting || this.stopped || this.reloadPromise || this.recoveryPromise || this.restartTimer
      || this.terminationState.kind === "undrained"
    )
      return Promise.reject(new PassportVerificationUnavailableError());
    if(this.pending.size >= this.maxPendingVerifications)
      return Promise.reject(new PassportVerificationUnavailableError("Passport verification is busy."));

    if(!this.generation)
      this.startGeneration();
    let generation = this.generation;
    if(!generation || generation.phase === "stopping")
      return Promise.reject(new PassportVerificationUnavailableError());

    let request: IPassportWorkerVerifyRequest = {
      reqId: this.requestIdCounter++,
      credentialJson,
      proofOptionsJson,
    };
    let result = new PromiseDfd<string>();
    this.pending.set(request.reqId, {
      generationId: generation.id,
      request,
      result,
      timeout: null,
      phase: "queued",
    });
    this.dispatchQueued(generation);
    return result.promise;
  }

  public reload(): Promise<void> {
    if(this.stopped)
      return Promise.reject(new PassportVerificationUnavailableError("Passport verifier is stopped."));
    if(this.reloadPromise)
      return this.reloadPromise;

    this.accepting = false;
    this.clearRestartTimer();
    this.rejectAll(new PassportVerificationUnavailableError("Passport verification was interrupted by reload."));
    let generation = this.generation;
    this.generation = null;
    if(generation)
      generation.phase = "stopping";
    let recovery = this.recoveryPromise || Promise.resolve();

    let drain = (async () => {
      if(generation)
        await this.terminateTrackedGeneration(generation);
      await recovery;
      await this.retryUndrainedGeneration();
    })();
    this.reloadPromise = drain.then(() => {
      this.restartAttempts = 0;
      this.accepting = !this.stopped;
      this.reloadPromise = null;
    }, (error) => {
      this.reloadPromise = null;
      throw error;
    });
    return this.reloadPromise;
  }

  public stop(): Promise<void> {
    if(this.stopPromise)
      return this.stopPromise;
    this.stopped = true;
    this.accepting = false;
    this.clearRestartTimer();
    this.rejectAll(new PassportVerificationUnavailableError("Passport verifier is stopped."));
    let generation = this.generation;
    this.generation = null;
    if(generation)
      generation.phase = "stopping";
    let recovery = this.recoveryPromise || Promise.resolve();
    let reload = this.reloadPromise || Promise.resolve();

    let drain = (async () => {
      if(generation)
        await this.terminateTrackedGeneration(generation);
      await recovery;
      await reload;
      await this.retryUndrainedGeneration();
    })();
    let stopAttempt: Promise<void>;
    stopAttempt = drain.then(
      () => undefined,
      (error) => {
        if(this.stopPromise === stopAttempt)
          this.stopPromise = null;
        throw error;
      },
    );
    this.stopPromise = stopAttempt;
    return this.stopPromise;
  }

  private startGeneration(): void {
    if(!this.accepting || this.stopped || this.generation || this.recoveryPromise
      || this.terminationState.kind === "undrained"
    )
      return;

    let worker: PassportVerifierWorker;
    try {
      worker = this.workerFactory();
    } catch {
      this.scheduleRestart();
      return;
    }

    let generation: PassportWorkerGeneration = {
      id: this.generationIdCounter++,
      worker,
      phase: "starting",
      initTimeout: null,
    };
    this.generation = generation;
    worker.on("message", (message) => this.onWorkerMessage(generation, message));
    worker.on("error", (error) => this.recoverGeneration(generation, error));
    worker.on("exit", (code) => this.recoverGeneration(
      generation,
      new Error("Passport verifier worker exited (" + code + ")."),
    ));
    generation.initTimeout = setTimeout(
      () => this.recoverGeneration(generation, new Error("Passport verifier initialization timed out.")),
      this.initTimeoutMs,
    );
    generation.initTimeout.unref?.();
  }

  private onWorkerMessage(generation: PassportWorkerGeneration, message: unknown): void {
    if(this.generation !== generation || generation.phase === "stopping" || !this.isRecord(message))
      return;

    switch(message.action) {
      case "init":
        if(generation.phase !== "starting") {
          this.recoverGeneration(generation, new Error("Passport verifier sent a duplicate initialization response."));
          return;
        }
        this.clearInitTimeout(generation);
        generation.phase = "ready";
        this.restartAttempts = 0;
        this.dispatchQueued(generation);
        return;
      case "verified":
        this.onVerified(generation, message.data);
        return;
      case "init-error":
        this.recoverGeneration(generation, new Error("Passport verifier initialization failed."));
        return;
      case "verification-error":
        this.recoverGeneration(generation, new Error("Passport proof verification failed unexpectedly."));
        return;
      default:
        this.recoverGeneration(generation, new Error("Passport verifier returned an invalid response."));
    }
  }

  private onVerified(generation: PassportWorkerGeneration, value: unknown): void {
    if(generation.phase !== "ready" || !this.isRecord(value)
      || !Number.isSafeInteger(value.reqId) || typeof value.result !== "string"
    ) {
      this.recoverGeneration(generation, new Error("Passport verifier returned an invalid result."));
      return;
    }

    let pending = this.pending.get(value.reqId as number);
    if(!pending || pending.generationId !== generation.id || pending.phase !== "in-flight") {
      this.recoverGeneration(generation, new Error("Passport verifier returned an unexpected request id."));
      return;
    }
    this.takeVerification(value.reqId as number)?.result.resolve(value.result);
  }

  private dispatchQueued(generation: PassportWorkerGeneration): void {
    if(this.generation !== generation || generation.phase !== "ready")
      return;
    for(let pending of this.pending.values()) {
      if(pending.generationId !== generation.id || pending.phase !== "queued")
        continue;
      pending.phase = "in-flight";
      try {
        generation.worker.postMessage({action: "verify", data: pending.request});
      } catch(error) {
        this.recoverGeneration(generation, error);
        return;
      }
      if(this.pending.get(pending.request.reqId) !== pending)
        continue;
      pending.timeout = setTimeout(
        () => this.timeoutVerification(pending.request.reqId),
        this.verifyTimeoutMs,
      );
      pending.timeout.unref?.();
    }
  }

  private timeoutVerification(requestId: number): void {
    let pending = this.pending.get(requestId);
    if(!pending)
      return;
    let generation = this.generation;
    if(!generation || generation.id !== pending.generationId) {
      this.takeVerification(requestId)?.result.reject(new PassportVerificationUnavailableError());
      return;
    }
    this.recoverGeneration(generation, new Error("Passport proof verification timed out."));
  }

  private recoverGeneration(generation: PassportWorkerGeneration, error: unknown): void {
    if(this.generation !== generation || generation.phase === "stopping")
      return;
    generation.phase = "stopping";
    this.clearInitTimeout(generation);
    this.generation = null;
    let detail = error instanceof Error ? error.message : String(error);
    this.rejectGeneration(
      generation.id,
      new PassportVerificationUnavailableError("Passport verifier failed: " + detail),
    );

    let recovery: Promise<void>;
    recovery = this.terminateTrackedGeneration(generation).then(() => {
      if(this.recoveryPromise === recovery)
        this.recoveryPromise = null;
      this.scheduleRestart();
    }, () => {
      if(this.recoveryPromise === recovery)
        this.recoveryPromise = null;
    });
    this.recoveryPromise = recovery;
  }

  private async terminateTrackedGeneration(generation: PassportWorkerGeneration): Promise<void> {
    try {
      await this.terminateGeneration(generation);
    } catch(error) {
      this.terminationState = {kind: "undrained", generation};
      throw error;
    }
    if(this.terminationState.kind === "undrained" && this.terminationState.generation === generation)
      this.terminationState = {kind: "drained"};
  }

  private retryUndrainedGeneration(): Promise<void> {
    let terminationState = this.terminationState;
    return terminationState.kind === "undrained"
      ? this.terminateTrackedGeneration(terminationState.generation)
      : Promise.resolve();
  }

  private async terminateGeneration(generation: PassportWorkerGeneration): Promise<void> {
    generation.phase = "stopping";
    this.clearInitTimeout(generation);
    generation.worker.removeAllListeners();
    await generation.worker.terminate();
  }

  private scheduleRestart(): void {
    if(!this.accepting || this.stopped || this.generation || this.restartTimer
      || this.terminationState.kind === "undrained"
    )
      return;
    let delay = Math.min(
      this.restartBackoffMs * (2 ** Math.min(this.restartAttempts, 30)),
      this.maxRestartBackoffMs,
    );
    this.restartAttempts++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startGeneration();
    }, delay);
    this.restartTimer.unref?.();
  }

  private clearRestartTimer(): void {
    if(!this.restartTimer)
      return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private clearInitTimeout(generation: PassportWorkerGeneration): void {
    if(generation.initTimeout)
      clearTimeout(generation.initTimeout);
    generation.initTimeout = null;
  }

  private takeVerification(requestId: number): PendingPassportVerification | undefined {
    let pending = this.pending.get(requestId);
    if(!pending)
      return undefined;
    if(pending.timeout)
      clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    return pending;
  }

  private rejectGeneration(generationId: number, error: Error): void {
    for(let [requestId, pending] of [...this.pending]) {
      if(pending.generationId === generationId)
        this.takeVerification(requestId)?.result.reject(error);
    }
  }

  private rejectAll(error: Error): void {
    for(let requestId of [...this.pending.keys()])
      this.takeVerification(requestId)?.result.reject(error);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private assertPositiveInteger(value: number, name: string): void {
    if(!Number.isSafeInteger(value) || value < 1)
      throw new Error(name + " must be a positive integer.");
  }
}
