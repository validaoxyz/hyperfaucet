import { AsyncLocalStorage } from 'node:async_hooks';
import { PromiseDfd } from './PromiseDfd.js';

export interface BoundedAsyncWorkLimits {
  maxInflight: number;
  timeoutMs: number;
}

export interface BoundedAsyncWorkContext {
  readonly signal: AbortSignal;
  readonly expiresAt: number;
  assertActive(): void;
}

const MAX_INFLIGHT_WORK = 64;
const MAX_CALLER_TIMEOUT_MS = 120_000;

type RuntimeDisposer<TRuntime> = (runtime: TRuntime) => void | Promise<void>;

interface WorkGeneration<TRuntime> {
  runtime: TRuntime;
  limits: BoundedAsyncWorkLimits;
  accepting: boolean;
  active: Set<Promise<unknown>>;
  invalidationController: AbortController;
  disposer?: RuntimeDisposer<TRuntime>;
  drain?: Promise<void>;
}

interface FailedStagedCleanup<TRuntime> {
  readonly generation: WorkGeneration<TRuntime>;
  readonly drainError: unknown;
}

export class BoundedAsyncWorkCapacityError extends Error {
  public constructor() {
    super("asynchronous work capacity reached");
    this.name = "BoundedAsyncWorkCapacityError";
  }
}

export class BoundedAsyncWorkInvalidatedError extends Error {
  public constructor() {
    super("asynchronous work generation was invalidated");
    this.name = "BoundedAsyncWorkInvalidatedError";
  }
}

export class BoundedAsyncWorkTimeoutError extends Error {
  public constructor() {
    super("asynchronous work timed out");
    this.name = "BoundedAsyncWorkTimeoutError";
  }
}

export class BoundedAsyncWorkReentrancyError extends Error {
  public constructor() {
    super("cannot start, stop, or replace asynchronous work from an owned callback");
    this.name = "BoundedAsyncWorkReentrancyError";
  }
}

export class BoundedAsyncWork<TRuntime> {
  private readonly callbackContext = new AsyncLocalStorage<true>();
  private current: WorkGeneration<TRuntime> | null = null;
  private lifecycle: Promise<void> | null = null;
  private failedStagedCleanup: FailedStagedCleanup<TRuntime> | null = null;

  public start(
    runtimeFactory: () => TRuntime,
    limits: BoundedAsyncWorkLimits,
    disposer?: RuntimeDisposer<TRuntime>,
  ): void {
    this.assertLifecycleCallAllowed();
    if(this.current || this.lifecycle || this.failedStagedCleanup)
      throw new Error("cannot start asynchronous work while another generation is present");

    const generation = this.stage(runtimeFactory, limits, disposer);
    generation.accepting = true;
    this.current = generation;
  }

  public run<TResult>(
    operation: (runtime: TRuntime, context: BoundedAsyncWorkContext) => Promise<TResult>,
  ): Promise<TResult> {
    const generation = this.current;
    if(!generation?.accepting)
      return Promise.reject(new BoundedAsyncWorkInvalidatedError());
    if(generation.active.size >= generation.limits.maxInflight)
      return Promise.reject(new BoundedAsyncWorkCapacityError());

    const workController = new AbortController();
    const expiresAt = Date.now() + generation.limits.timeoutMs;
    const cancelled = new PromiseDfd<never>();
    const cancel = (error: Error) => {
      if(workController.signal.aborted)
        return;
      workController.abort(error);
      cancelled.reject(error);
    };
    const context: BoundedAsyncWorkContext = {
      signal: workController.signal,
      expiresAt,
      assertActive: () => {
        if(!workController.signal.aborted && Date.now() >= expiresAt)
          cancel(new BoundedAsyncWorkTimeoutError());
        if(workController.signal.aborted)
          throw workController.signal.reason;
        this.assertGenerationCurrent(generation);
      },
    };
    const onInvalidated = () => cancel(new BoundedAsyncWorkInvalidatedError());
    generation.invalidationController.signal.addEventListener("abort", onInvalidated, {once: true});
    if(generation.invalidationController.signal.aborted)
      onInvalidated();
    const timeout = setTimeout(
      () => cancel(new BoundedAsyncWorkTimeoutError()),
      generation.limits.timeoutMs,
    );

    const tracked = new PromiseDfd<TResult>();
    generation.active.add(tracked.promise);
    tracked.promise.then(
      () => generation.active.delete(tracked.promise),
      () => generation.active.delete(tracked.promise),
    );

    let operationResult: Promise<TResult>;
    try {
      operationResult = Promise.resolve(this.runCallback(
        () => operation(generation.runtime, context),
      ));
    } catch(ex) {
      operationResult = Promise.reject(ex);
    }
    operationResult.then(tracked.resolve, tracked.reject);

    const settled = Promise.race([tracked.promise, cancelled.promise]).finally(() => {
      clearTimeout(timeout);
      generation.invalidationController.signal.removeEventListener("abort", onInvalidated);
    });

    return settled.then(
      (result) => {
        context.assertActive();
        return result;
      },
      (error) => {
        context.assertActive();
        throw error;
      },
    );
  }

  public replace(
    runtimeFactory: () => TRuntime,
    limits: BoundedAsyncWorkLimits,
    disposer?: RuntimeDisposer<TRuntime>,
  ): Promise<void> {
    this.assertLifecycleCallAllowed();
    return this.runLifecycle(() => this.runAfterFailedStagedCleanup(
      () => this.replaceGeneration(runtimeFactory, limits, disposer),
    ));
  }

  public stop(): Promise<void> {
    this.assertLifecycleCallAllowed();
    return this.runLifecycle(() => this.runAfterFailedStagedCleanup(
      () => this.stopCurrent(),
    ));
  }

  public getInflightCount(): number {
    return this.current?.active.size ?? 0;
  }

  public currentMatches(predicate: (runtime: TRuntime) => boolean): boolean {
    return !!this.current?.accepting && predicate(this.current.runtime);
  }

  private runLifecycle(operation: () => Promise<void>): Promise<void> {
    if(this.lifecycle) {
      const previous = this.lifecycle;
      return previous.catch(() => undefined).then(() => this.runLifecycle(operation));
    }

    const lifecycleDfd = new PromiseDfd<void>();
    const lifecycle = lifecycleDfd.promise;
    this.lifecycle = lifecycle;

    let result: Promise<void>;
    try {
      result = Promise.resolve(operation());
    } catch(ex) {
      result = Promise.reject(ex);
    }
    result.then(
      () => {
        if(this.lifecycle === lifecycle)
          this.lifecycle = null;
        lifecycleDfd.resolve();
      },
      (error) => {
        if(this.lifecycle === lifecycle)
          this.lifecycle = null;
        lifecycleDfd.reject(error);
      },
    );
    return lifecycle;
  }

  private async replaceGeneration(
    runtimeFactory: () => TRuntime,
    limits: BoundedAsyncWorkLimits,
    disposer?: RuntimeDisposer<TRuntime>,
  ): Promise<void> {
    const staged = this.stage(runtimeFactory, limits, disposer);
    const previous = this.current;
    if(!previous) {
      staged.accepting = true;
      this.current = staged;
      return;
    }

    try {
      await this.drain(previous);
    } catch(drainError) {
      try {
        await this.dispose(staged);
      } catch(stagedDisposeError) {
        this.failedStagedCleanup = {generation: staged, drainError};
        throw this.createStagedCleanupError(drainError, stagedDisposeError);
      }
      throw drainError;
    }

    if(this.current !== previous) {
      await this.dispose(staged);
      throw new Error("asynchronous work generation changed during replacement");
    }
    staged.accepting = true;
    this.current = staged;
  }

  private async stopCurrent(): Promise<void> {
    const generation = this.current;
    if(!generation)
      return;
    await this.drain(generation);
    if(this.current === generation)
      this.current = null;
  }

  private stage(
    runtimeFactory: () => TRuntime,
    limits: BoundedAsyncWorkLimits,
    disposer?: RuntimeDisposer<TRuntime>,
  ): WorkGeneration<TRuntime> {
    const stagedLimits = {
      maxInflight: limits.maxInflight,
      timeoutMs: limits.timeoutMs,
    };
    this.validateLimits(stagedLimits);
    const active = new Set<Promise<unknown>>();
    const invalidationController = new AbortController();
    const runtime = this.runCallback(runtimeFactory);
    return {
      runtime,
      limits: stagedLimits,
      accepting: false,
      active,
      invalidationController,
      disposer,
    };
  }

  private async drain(generation: WorkGeneration<TRuntime>): Promise<void> {
    if(generation.drain)
      return generation.drain;

    generation.accepting = false;
    generation.invalidationController.abort();
    generation.drain = this.disposeAndDrain(generation);
    try {
      await generation.drain;
    } catch(ex) {
      generation.drain = undefined;
      throw ex;
    }
  }

  private async disposeAndDrain(generation: WorkGeneration<TRuntime>): Promise<void> {
    let disposeFailed = false;
    let disposeError: unknown;
    try {
      await this.dispose(generation);
    } catch(ex) {
      disposeFailed = true;
      disposeError = ex;
    }
    await Promise.allSettled([...generation.active]);
    if(disposeFailed)
      throw disposeError;
  }

  private async dispose(generation: WorkGeneration<TRuntime>): Promise<void> {
    if(generation.disposer)
      await this.runCallback(() => generation.disposer!(generation.runtime));
  }

  private async retryFailedStagedCleanup(): Promise<void> {
    const failedCleanup = this.failedStagedCleanup;
    if(!failedCleanup)
      return;
    try {
      await this.dispose(failedCleanup.generation);
    } catch(stagedDisposeError) {
      throw this.createStagedCleanupError(failedCleanup.drainError, stagedDisposeError);
    }
    if(this.failedStagedCleanup === failedCleanup)
      this.failedStagedCleanup = null;
  }

  private runAfterFailedStagedCleanup(operation: () => Promise<void>): Promise<void> {
    if(!this.failedStagedCleanup)
      return operation();
    return this.retryFailedStagedCleanup().then(operation);
  }

  private createStagedCleanupError(drainError: unknown, stagedDisposeError: unknown): AggregateError {
    return new AggregateError(
      [drainError, stagedDisposeError],
      "failed to drain the previous runtime and dispose its staged replacement",
    );
  }

  private runCallback<TResult>(callback: () => TResult): TResult {
    return this.callbackContext.run(true, callback);
  }

  private assertLifecycleCallAllowed(): void {
    if(this.callbackContext.getStore())
      throw new BoundedAsyncWorkReentrancyError();
  }

  private assertGenerationCurrent(generation: WorkGeneration<TRuntime>): void {
    if(this.current !== generation || !generation.accepting)
      throw new BoundedAsyncWorkInvalidatedError();
  }

  private validateLimits(limits: BoundedAsyncWorkLimits): void {
    if(!Number.isSafeInteger(limits.maxInflight) || limits.maxInflight < 1 || limits.maxInflight > MAX_INFLIGHT_WORK)
      throw new Error("asynchronous work maxInflight must be an integer between 1 and 64");
    if(!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1 || limits.timeoutMs > MAX_CALLER_TIMEOUT_MS)
      throw new Error("asynchronous work timeoutMs must be an integer between 1 and 120000");
  }
}
