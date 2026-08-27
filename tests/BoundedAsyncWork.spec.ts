import "mocha";
import sinon from "sinon";
import { expect } from "chai";
import {
  BoundedAsyncWork,
  BoundedAsyncWorkCapacityError,
  BoundedAsyncWorkContext,
  BoundedAsyncWorkInvalidatedError,
  BoundedAsyncWorkReentrancyError,
  BoundedAsyncWorkTimeoutError,
} from "../src/utils/BoundedAsyncWork.js";
import { PromiseDfd } from "../src/utils/PromiseDfd.js";

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch(ex) {
    return ex;
  }
  throw new Error("expected promise to reject");
}

async function settleWithin<TResult>(promise: Promise<TResult>, timeoutMs = 500): Promise<TResult> {
  let timeout: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`promise did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout!);
  }
}

describe("BoundedAsyncWork", () => {
  it("rejects non-finite and out-of-range limits", () => {
    const invalidLimits = [
      {maxInflight: 0, timeoutMs: 1},
      {maxInflight: 65, timeoutMs: 1},
      {maxInflight: Number.POSITIVE_INFINITY, timeoutMs: 1},
      {maxInflight: 1, timeoutMs: 0},
      {maxInflight: 1, timeoutMs: 120_001},
      {maxInflight: 1, timeoutMs: Number.NaN},
    ];
    let factoryCalls = 0;
    for(const limits of invalidLimits) {
      const owner = new BoundedAsyncWork<string>();
      expect(() => owner.start(() => {
        factoryCalls++;
        return "provider";
      }, limits)).to.throw();
    }
    expect(factoryCalls).to.equal(0, "invalid limits constructed a runtime");
  });

  it("holds capacity after a caller timeout until the physical task settles", async () => {
    const clock = sinon.useFakeTimers();
    const owner = new BoundedAsyncWork<string>();
    try {
      owner.start(() => "provider", {maxInflight: 1, timeoutMs: 5});
      const physical = new PromiseDfd<string>();
      let context: BoundedAsyncWorkContext;
      const startedAt = Date.now();

      const timedOut = owner.run((_runtime, workContext) => {
        context = workContext;
        return physical.promise;
      });
      expect(context.expiresAt).to.be.greaterThan(startedAt);
      await clock.tickAsync(5);
      expect(await rejectionOf(timedOut)).to.be.instanceOf(BoundedAsyncWorkTimeoutError);
      expect(context.signal.aborted).to.equal(true);
      expect(context.signal.reason).to.be.instanceOf(BoundedAsyncWorkTimeoutError);
      expect(owner.getInflightCount()).to.equal(1, "caller timeout released physical capacity");
      expect(await rejectionOf(owner.run(() => Promise.resolve("overflow"))))
        .to.be.instanceOf(BoundedAsyncWorkCapacityError);

      physical.resolve("late result");
      await Promise.resolve();
      await Promise.resolve();
      expect(owner.getInflightCount()).to.equal(0, "settled physical task kept its capacity");
      expect(await owner.run(() => Promise.resolve("recovered"))).to.equal("recovered");
    } finally {
      clock.restore();
    }
  });

  it("stops timed-out sequential work after the pending step settles", async () => {
    const owner = new BoundedAsyncWork<string>();
    owner.start(() => "provider", {maxInflight: 1, timeoutMs: 5});
    const physical = new PromiseDfd<void>();
    let followupCalls = 0;

    const timedOut = owner.run(async (_runtime, context) => {
      await physical.promise;
      context.assertActive();
      followupCalls++;
    });
    expect(await rejectionOf(timedOut)).to.be.instanceOf(BoundedAsyncWorkTimeoutError);

    physical.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(followupCalls).to.equal(0, "timed-out work issued a follow-up operation");
    expect(owner.getInflightCount()).to.equal(0, "timed-out work retained capacity after physical drain");
  });

  it("reserves capacity before invoking operation code", async () => {
    const owner = new BoundedAsyncWork<string>();
    owner.start(() => "provider", {maxInflight: 1, timeoutMs: 1_000});
    const physical = new PromiseDfd<void>();
    let nested: Promise<unknown>;

    const outer = owner.run(() => {
      nested = owner.run(() => Promise.resolve());
      return physical.promise;
    });
    expect(await rejectionOf(nested)).to.be.instanceOf(BoundedAsyncWorkCapacityError);
    expect(owner.getInflightCount()).to.equal(1);

    physical.resolve();
    await outer;
  });

  it("validates the generation on the terminal promise delivered to the caller", async () => {
    const owner = new BoundedAsyncWork<string>();
    owner.start(() => "old", {maxInflight: 1, timeoutMs: 1_000});
    const physical = new PromiseDfd<string>();
    let replacement!: Promise<void>;

    const oldResult = owner.run(() => physical.promise);
    physical.promise.then(() => {
      queueMicrotask(() => {
        replacement = owner.replace(
          () => "new",
          {maxInflight: 1, timeoutMs: 1_000},
        );
      });
    });

    physical.resolve("old result");
    expect(await settleWithin(rejectionOf(oldResult)))
      .to.be.instanceOf(BoundedAsyncWorkInvalidatedError);
    await settleWithin(replacement);
    expect(await owner.run((runtime) => Promise.resolve(runtime))).to.equal("new");
  });

  it("rejects start from a tracked operation without leaking its slot", async () => {
    const owner = new BoundedAsyncWork<string>();
    owner.start(() => "old", {maxInflight: 1, timeoutMs: 1_000});
    let nestedFactoryCalls = 0;

    const error = await settleWithin(rejectionOf(owner.run(() => {
      owner.start(
        () => {
          nestedFactoryCalls++;
          return "nested";
        },
        {maxInflight: 1, timeoutMs: 1_000},
      );
      return Promise.resolve();
    })));

    expect(error).to.be.instanceOf(BoundedAsyncWorkReentrancyError);
    expect(nestedFactoryCalls).to.equal(0);
    expect(owner.getInflightCount()).to.equal(0);
    expect(await owner.run((runtime) => Promise.resolve(runtime))).to.equal("old");
  });

  it("rejects stop returned by a tracked operation", async () => {
    const owner = new BoundedAsyncWork<string>();
    owner.start(() => "provider", {maxInflight: 1, timeoutMs: 1_000});
    const error = await settleWithin(rejectionOf(owner.run(() => owner.stop())));

    expect(error).to.be.instanceOf(BoundedAsyncWorkReentrancyError);
    expect(owner.getInflightCount()).to.equal(0, "rejected stop leaked its tracked slot");
    expect(await owner.run((runtime) => Promise.resolve(runtime))).to.equal("provider");
  });

  it("rejects replace returned by a tracked operation", async () => {
    const owner = new BoundedAsyncWork<string>();
    owner.start(() => "old", {maxInflight: 1, timeoutMs: 1_000});
    let replacementFactoryCalls = 0;
    const error = await settleWithin(rejectionOf(owner.run(() => owner.replace(
      () => {
        replacementFactoryCalls++;
        return "new";
      },
      {maxInflight: 1, timeoutMs: 1_000},
    ))));

    expect(error).to.be.instanceOf(BoundedAsyncWorkReentrancyError);
    expect(replacementFactoryCalls).to.equal(0, "rejected replacement staged a runtime");
    expect(owner.getInflightCount()).to.equal(0, "rejected replacement leaked its tracked slot");
    expect(await owner.run((runtime) => Promise.resolve(runtime))).to.equal("old");
  });

  for(const lifecycle of ["start", "stop", "replace"] as const) {
    it(`rejects ${lifecycle} returned after an awaited operation continuation`, async () => {
      const owner = new BoundedAsyncWork<string>();
      owner.start(() => "old", {maxInflight: 1, timeoutMs: 1_000});
      const continueOperation = new PromiseDfd<void>();
      let replacementFactoryCalls = 0;

      const operation = rejectionOf(owner.run(async () => {
        await continueOperation.promise;
        if(lifecycle === "start") {
          owner.start(
            () => {
              replacementFactoryCalls++;
              return "new";
            },
            {maxInflight: 1, timeoutMs: 1_000},
          );
          return;
        }
        if(lifecycle === "stop")
          return owner.stop();
        return owner.replace(
          () => {
            replacementFactoryCalls++;
            return "new";
          },
          {maxInflight: 1, timeoutMs: 1_000},
        );
      }));

      expect(owner.getInflightCount()).to.equal(1);
      continueOperation.resolve();
      const error = await settleWithin(operation);

      expect(error).to.be.instanceOf(BoundedAsyncWorkReentrancyError);
      expect(replacementFactoryCalls).to.equal(0, "rejected replacement staged a runtime");
      expect(owner.getInflightCount()).to.equal(0, "rejected lifecycle call leaked its tracked slot");
      expect(await owner.run((runtime) => Promise.resolve(runtime))).to.equal("old");
    });
  }

  for(const lifecycle of ["start", "stop", "replace"] as const) {
    it(`rejects ${lifecycle} from a detached operation continuation`, async () => {
      const owner = new BoundedAsyncWork<string>();
      owner.start(() => "old", {maxInflight: 1, timeoutMs: 1_000});
      const continueOperation = new PromiseDfd<void>();
      const scheduledResult = new PromiseDfd<unknown>();
      let replacementFactoryCalls = 0;

      await owner.run(() => {
        void (async () => {
          await continueOperation.promise;
          try {
            let lifecycleResult: Promise<void>;
            if(lifecycle === "start") {
              owner.start(
                () => {
                  replacementFactoryCalls++;
                  return "new";
                },
                {maxInflight: 1, timeoutMs: 1_000},
              );
              lifecycleResult = Promise.resolve();
            } else if(lifecycle === "stop") {
              lifecycleResult = owner.stop();
            } else {
              lifecycleResult = owner.replace(
                () => {
                  replacementFactoryCalls++;
                  return "new";
                },
                {maxInflight: 1, timeoutMs: 1_000},
              );
            }
            lifecycleResult.then(
              () => scheduledResult.resolve(new Error("lifecycle call unexpectedly succeeded")),
              scheduledResult.resolve,
            );
          } catch(ex) {
            scheduledResult.resolve(ex);
          }
        })();
        return Promise.resolve();
      });

      continueOperation.resolve();
      const error = await settleWithin(scheduledResult.promise);
      expect(error).to.be.instanceOf(BoundedAsyncWorkReentrancyError);
      expect(replacementFactoryCalls).to.equal(0, "rejected replacement staged a runtime");
      expect(owner.getInflightCount()).to.equal(0, "detached continuation leaked a tracked slot");
      expect(await owner.run((runtime) => Promise.resolve(runtime))).to.equal("old");
    });
  }

  for(const timing of ["before-await", "after-await"] as const) {
    for(const lifecycle of ["start", "stop", "replace"] as const) {
      it(`rejects ${lifecycle} ${timing} in an async disposer without deadlocking`, async () => {
        const owner = new BoundedAsyncWork<string>();
        const continueDisposal = new PromiseDfd<void>();
        let reenter = true;
        let disposeCalls = 0;
        let nestedFactoryCalls = 0;
        owner.start(() => "old", {maxInflight: 1, timeoutMs: 1_000}, async () => {
          disposeCalls++;
          if(timing === "after-await")
            await continueDisposal.promise;
          if(!reenter)
            return;
          if(lifecycle === "start") {
            owner.start(
              () => {
                nestedFactoryCalls++;
                return "nested";
              },
              {maxInflight: 1, timeoutMs: 1_000},
            );
            return;
          }
          if(lifecycle === "stop")
            return owner.stop();
          return owner.replace(
            () => {
              nestedFactoryCalls++;
              return "nested";
            },
            {maxInflight: 1, timeoutMs: 1_000},
          );
        });

        const stopping = rejectionOf(owner.stop());
        expect(disposeCalls).to.equal(1);
        continueDisposal.resolve();
        const error = await settleWithin(stopping);
        expect(error).to.be.instanceOf(BoundedAsyncWorkReentrancyError);
        expect(nestedFactoryCalls).to.equal(0, "rejected disposer replacement staged a runtime");
        expect(owner.getInflightCount()).to.equal(0, "failed disposal left an inflight slot");
        expect(await rejectionOf(owner.run(() => Promise.resolve())))
          .to.be.instanceOf(BoundedAsyncWorkInvalidatedError);

        reenter = false;
        if(lifecycle === "stop") {
          await settleWithin(owner.stop());
          owner.start(() => "recovered", {maxInflight: 1, timeoutMs: 1_000});
        } else {
          await settleWithin(owner.replace(
            () => "recovered",
            {maxInflight: 1, timeoutMs: 1_000},
          ));
        }
        expect(disposeCalls).to.equal(2, "recovery did not retry disposal");
        expect(await owner.run((runtime) => Promise.resolve(runtime))).to.equal("recovered");
      });
    }
  }

  it("disposes a staged replacement when the previous disposer rejects reentry", async () => {
    const owner = new BoundedAsyncWork<string>();
    let allowDisposal = false;
    let oldDisposeCalls = 0;
    const stagedDisposals: string[] = [];
    owner.start(() => "old", {maxInflight: 1, timeoutMs: 1_000}, async () => {
      oldDisposeCalls++;
      await Promise.resolve();
      if(!allowDisposal)
        return owner.stop();
    });

    const error = await settleWithin(rejectionOf(owner.replace(
      () => "staged",
      {maxInflight: 1, timeoutMs: 1_000},
      (runtime) => {
        stagedDisposals.push(runtime);
      },
    )));
    expect(error).to.be.instanceOf(BoundedAsyncWorkReentrancyError);
    expect(oldDisposeCalls).to.equal(1);
    expect(stagedDisposals).to.deep.equal(["staged"]);
    expect(await rejectionOf(owner.run(() => Promise.resolve())))
      .to.be.instanceOf(BoundedAsyncWorkInvalidatedError);

    allowDisposal = true;
    await settleWithin(owner.replace(
      () => "recovered",
      {maxInflight: 1, timeoutMs: 1_000},
    ));
    expect(oldDisposeCalls).to.equal(2);
    expect(stagedDisposals).to.deep.equal(["staged"], "staged runtime was disposed more than once");
    expect(await owner.run((runtime) => Promise.resolve(runtime))).to.equal("recovered");
  });

  for(const cleanupFailure of [
    {
      name: "synchronous throw undefined",
      dispose: () => {
        throw undefined;
      },
    },
    {
      name: "asynchronous rejection without a reason",
      dispose: () => Promise.reject(),
    },
  ]) {
    it(`retains lifecycle ownership after ${cleanupFailure.name}`, async () => {
      const owner = new BoundedAsyncWork<string>();
      let oldDisposeCalls = 0;
      let stagedDisposeCalls = 0;
      owner.start(() => "old", {maxInflight: 1, timeoutMs: 1_000}, () => {
        oldDisposeCalls++;
        if(oldDisposeCalls === 1)
          return cleanupFailure.dispose();
      });

      const [replacement] = await Promise.allSettled([owner.replace(
        () => "staged",
        {maxInflight: 1, timeoutMs: 1_000},
        () => {
          stagedDisposeCalls++;
        },
      )]);
      expect(replacement.status).to.equal("rejected");
      if(replacement.status === "rejected")
        expect(replacement.reason).to.equal(undefined);
      const [admission] = await Promise.allSettled([
        owner.run((runtime) => Promise.resolve(runtime)),
      ]);
      expect(admission.status).to.equal("rejected", "failed cleanup published the replacement");
      if(admission.status === "rejected")
        expect(admission.reason).to.be.instanceOf(BoundedAsyncWorkInvalidatedError);
      expect(stagedDisposeCalls).to.equal(1, "failed drain did not dispose its staged replacement");

      await settleWithin(owner.stop());
      expect(oldDisposeCalls).to.equal(2, "later lifecycle did not retry the failed cleanup owner");
      expect(stagedDisposeCalls).to.equal(1, "cleanup retry targeted the discarded replacement");
      owner.start(() => "recovered", {maxInflight: 1, timeoutMs: 1_000});
      expect(await owner.run((runtime) => Promise.resolve(runtime))).to.equal("recovered");
    });
  }

  for(const nextLifecycle of ["stop", "replace"] as const) {
    it(`retries failed staged cleanup before a later ${nextLifecycle}`, async () => {
      const oldRuntime = {name: "old"};
      const stagedRuntime = {name: "staged"};
      const recoveredRuntime = {name: "recovered"};
      const owner = new BoundedAsyncWork<{name: string}>();
      const oldDrainError = new Error("old drain failed");
      const stagedCleanupErrors = [
        new Error("staged cleanup failed first"),
        new Error("staged cleanup failed again"),
      ];
      const stagedDisposals: Array<{name: string}> = [];
      let allowOldDisposal = false;
      let allowStagedDisposal = false;
      let oldDisposeCalls = 0;
      let nextFactoryCalls = 0;

      owner.start(() => oldRuntime, {maxInflight: 1, timeoutMs: 1_000}, () => {
        oldDisposeCalls++;
        if(!allowOldDisposal)
          throw oldDrainError;
      });

      const initialError = await settleWithin(rejectionOf(owner.replace(
        () => stagedRuntime,
        {maxInflight: 1, timeoutMs: 1_000},
        (runtime) => {
          stagedDisposals.push(runtime);
          if(!allowStagedDisposal)
            throw stagedCleanupErrors[stagedDisposals.length - 1];
        },
      )));
      if(!(initialError instanceof AggregateError))
        throw new Error("initial replacement did not aggregate both cleanup failures");
      expect(initialError.errors).to.deep.equal([oldDrainError, stagedCleanupErrors[0]]);

      const blockedLifecycle = nextLifecycle === "stop"
        ? owner.stop()
        : owner.replace(
          () => {
            nextFactoryCalls++;
            return {name: "must-not-stage"};
          },
          {maxInflight: 1, timeoutMs: 1_000},
        );
      const retryError = await settleWithin(rejectionOf(blockedLifecycle));
      if(!(retryError instanceof AggregateError))
        throw new Error("cleanup retry did not preserve the aggregate error");
      expect(retryError.errors).to.deep.equal([oldDrainError, stagedCleanupErrors[1]]);
      expect(stagedDisposals).to.have.length(2);
      expect(stagedDisposals.every((runtime) => runtime === stagedRuntime)).to.equal(true);
      expect(oldDisposeCalls).to.equal(1, "later lifecycle retried the old runtime before staged cleanup");
      expect(nextFactoryCalls).to.equal(0, "later replacement staged another runtime before cleanup");
      expect(await rejectionOf(owner.run(() => Promise.resolve())))
        .to.be.instanceOf(BoundedAsyncWorkInvalidatedError);

      allowStagedDisposal = true;
      allowOldDisposal = true;
      if(nextLifecycle === "stop") {
        await settleWithin(owner.stop());
        owner.start(() => recoveredRuntime, {maxInflight: 1, timeoutMs: 1_000});
      } else {
        await settleWithin(owner.replace(
          () => {
            nextFactoryCalls++;
            return recoveredRuntime;
          },
          {maxInflight: 1, timeoutMs: 1_000},
        ));
      }

      expect(stagedDisposals).to.have.length(3);
      expect(stagedDisposals.every((runtime) => runtime === stagedRuntime)).to.equal(true);
      expect(oldDisposeCalls).to.equal(2);
      expect(nextFactoryCalls).to.equal(nextLifecycle === "replace" ? 1 : 0);
      expect(owner.getInflightCount()).to.equal(0);
      expect(await owner.run((runtime) => Promise.resolve(runtime))).to.equal(recoveredRuntime);
    });
  }

  for(const lifecycle of ["start", "stop", "replace"] as const) {
    it(`rejects ${lifecycle} initiated by a start runtime factory`, async () => {
      const owner = new BoundedAsyncWork<string>();
      let nestedFactoryCalls = 0;

      expect(() => owner.start(() => {
        if(lifecycle === "start")
          owner.start(
            () => {
              nestedFactoryCalls++;
              return "nested";
            },
            {maxInflight: 1, timeoutMs: 1_000},
          );
        else if(lifecycle === "stop")
          void owner.stop();
        else
          void owner.replace(
            () => {
              nestedFactoryCalls++;
              return "nested";
            },
            {maxInflight: 1, timeoutMs: 1_000},
          );
        return "outer";
      }, {maxInflight: 1, timeoutMs: 1_000}))
        .to.throw(BoundedAsyncWorkReentrancyError);

      expect(nestedFactoryCalls).to.equal(0, "rejected replacement factory was invoked");
      expect(owner.getInflightCount()).to.equal(0);
      expect(await rejectionOf(owner.run(() => Promise.resolve())))
        .to.be.instanceOf(BoundedAsyncWorkInvalidatedError);
      owner.start(() => "recovered", {maxInflight: 1, timeoutMs: 1_000});
      expect(await owner.run((runtime) => Promise.resolve(runtime))).to.equal("recovered");
    });
  }

  for(const lifecycle of ["start", "stop", "replace"] as const) {
    it(`rejects ${lifecycle} after await in a start runtime factory continuation`, async () => {
      const owner = new BoundedAsyncWork<string>();
      const continueFactory = new PromiseDfd<void>();
      const nestedResult = new PromiseDfd<unknown>();
      let nestedFactoryCalls = 0;

      owner.start(() => {
        void (async () => {
          await continueFactory.promise;
          try {
            let lifecycleResult: Promise<void>;
            if(lifecycle === "start") {
              owner.start(
                () => {
                  nestedFactoryCalls++;
                  return "nested";
                },
                {maxInflight: 1, timeoutMs: 1_000},
              );
              lifecycleResult = Promise.resolve();
            } else if(lifecycle === "stop") {
              lifecycleResult = owner.stop();
            } else {
              lifecycleResult = owner.replace(
                () => {
                  nestedFactoryCalls++;
                  return "nested";
                },
                {maxInflight: 1, timeoutMs: 1_000},
              );
            }
            lifecycleResult.then(
              () => nestedResult.resolve(new Error("lifecycle call unexpectedly succeeded")),
              nestedResult.resolve,
            );
          } catch(ex) {
            nestedResult.resolve(ex);
          }
        })();
        return "outer";
      }, {maxInflight: 1, timeoutMs: 1_000});

      continueFactory.resolve();
      const error = await settleWithin(nestedResult.promise);
      expect(error).to.be.instanceOf(BoundedAsyncWorkReentrancyError);
      expect(nestedFactoryCalls).to.equal(0, "rejected replacement staged a runtime");
      expect(owner.getInflightCount()).to.equal(0);
      expect(await owner.run((runtime) => Promise.resolve(runtime))).to.equal("outer");

      await settleWithin(owner.replace(
        () => "recovered",
        {maxInflight: 1, timeoutMs: 1_000},
      ));
      expect(await owner.run((runtime) => Promise.resolve(runtime))).to.equal("recovered");
    });
  }

  for(const lifecycle of ["start", "stop", "replace"] as const) {
    it(`rejects ${lifecycle} initiated by a replace runtime factory`, async () => {
      const owner = new BoundedAsyncWork<string>();
      owner.start(() => "old", {maxInflight: 1, timeoutMs: 1_000});
      let nestedFactoryCalls = 0;

      const error = await settleWithin(rejectionOf(owner.replace(
        () => {
          if(lifecycle === "start")
            owner.start(
              () => {
                nestedFactoryCalls++;
                return "nested";
              },
              {maxInflight: 1, timeoutMs: 1_000},
            );
          else if(lifecycle === "stop")
            void owner.stop();
          else
            void owner.replace(
              () => {
                nestedFactoryCalls++;
                return "nested";
              },
              {maxInflight: 1, timeoutMs: 1_000},
            );
          return "staged";
        },
        {maxInflight: 1, timeoutMs: 1_000},
      )));

      expect(error).to.be.instanceOf(BoundedAsyncWorkReentrancyError);
      expect(nestedFactoryCalls).to.equal(0, "rejected replacement staged a runtime");
      expect(owner.getInflightCount()).to.equal(0);
      expect(await owner.run((runtime) => Promise.resolve(runtime))).to.equal("old");

      await settleWithin(owner.replace(
        () => "recovered",
        {maxInflight: 1, timeoutMs: 1_000},
      ));
      expect(await owner.run((runtime) => Promise.resolve(runtime))).to.equal("recovered");
    });
  }

  for(const lifecycle of ["start", "stop", "replace"] as const) {
    it(`rejects ${lifecycle} after await in a replace runtime factory continuation`, async () => {
      const owner = new BoundedAsyncWork<string>();
      owner.start(() => "old", {maxInflight: 1, timeoutMs: 1_000});
      const continueFactory = new PromiseDfd<void>();
      const nestedResult = new PromiseDfd<unknown>();
      let nestedFactoryCalls = 0;
      let stagedDisposeCalls = 0;

      await settleWithin(owner.replace(
        () => {
          void (async () => {
            await continueFactory.promise;
            try {
              let lifecycleResult: Promise<void>;
              if(lifecycle === "start") {
                owner.start(
                  () => {
                    nestedFactoryCalls++;
                    return "nested";
                  },
                  {maxInflight: 1, timeoutMs: 1_000},
                );
                lifecycleResult = Promise.resolve();
              } else if(lifecycle === "stop") {
                lifecycleResult = owner.stop();
              } else {
                lifecycleResult = owner.replace(
                  () => {
                    nestedFactoryCalls++;
                    return "nested";
                  },
                  {maxInflight: 1, timeoutMs: 1_000},
                );
              }
              lifecycleResult.then(
                () => nestedResult.resolve(new Error("lifecycle call unexpectedly succeeded")),
                nestedResult.resolve,
              );
            } catch(ex) {
              nestedResult.resolve(ex);
            }
          })();
          return "staged";
        },
        {maxInflight: 1, timeoutMs: 1_000},
        () => {
          stagedDisposeCalls++;
        },
      ));

      continueFactory.resolve();
      const error = await settleWithin(nestedResult.promise);
      expect(error).to.be.instanceOf(BoundedAsyncWorkReentrancyError);
      expect(nestedFactoryCalls).to.equal(0, "rejected replacement staged a runtime");
      expect(stagedDisposeCalls).to.equal(0, "rejected lifecycle call disposed the current runtime");
      expect(owner.getInflightCount()).to.equal(0);
      expect(await owner.run((runtime) => Promise.resolve(runtime))).to.equal("staged");

      await settleWithin(owner.replace(
        () => "recovered",
        {maxInflight: 1, timeoutMs: 1_000},
      ));
      expect(stagedDisposeCalls).to.equal(1, "external replacement did not dispose the staged runtime");
      expect(await owner.run((runtime) => Promise.resolve(runtime))).to.equal("recovered");
    });
  }

  it("allows nested lifecycle calls on a different owner", async () => {
    const first = new BoundedAsyncWork<string>();
    const second = new BoundedAsyncWork<string>();
    first.start(() => "first", {maxInflight: 1, timeoutMs: 1_000});
    second.start(() => "second-old", {maxInflight: 1, timeoutMs: 1_000});

    const result = await settleWithin(first.run(async () => {
      await second.replace(
        () => "new",
        {maxInflight: 1, timeoutMs: 1_000},
      );
      await second.stop();
      second.start(() => "second-new", {maxInflight: 1, timeoutMs: 1_000});
      return second.run((runtime) => Promise.resolve(runtime));
    }));

    expect(result).to.equal("second-new");
    expect(await first.run((runtime) => Promise.resolve(runtime))).to.equal("first");
  });

  it("allows another owner's lifecycle from factory and disposer contexts", async () => {
    const owner = new BoundedAsyncWork<string>();
    const other = new BoundedAsyncWork<string>();
    const continueDisposal = new PromiseDfd<void>();
    let factoryStop!: Promise<void>;
    let disposerCalls = 0;
    other.start(() => "other-old", {maxInflight: 1, timeoutMs: 1_000});

    owner.start(() => {
      factoryStop = other.stop();
      return "owner";
    }, {maxInflight: 1, timeoutMs: 1_000}, async () => {
      disposerCalls++;
      await continueDisposal.promise;
      await other.replace(
        () => "other-replaced",
        {maxInflight: 1, timeoutMs: 1_000},
      );
    });

    await settleWithin(factoryStop);
    other.start(() => "other-restarted", {maxInflight: 1, timeoutMs: 1_000});
    const stopping = owner.stop();
    expect(disposerCalls).to.equal(1);
    continueDisposal.resolve();
    await settleWithin(stopping);

    expect(await other.run((runtime) => Promise.resolve(runtime))).to.equal("other-replaced");
    expect(owner.getInflightCount()).to.equal(0);
  });

  it("stages the next generation first and publishes it only after drain", async () => {
    const owner = new BoundedAsyncWork<string>();
    const lifecycle: string[] = [];
    owner.start(() => "old", {maxInflight: 1, timeoutMs: 1_000}, () => {
      disposeCalls++;
      lifecycle.push("disposed old");
    });
    const physical = new PromiseDfd<string>();
    let disposeCalls = 0;
    let factoryCalls = 0;
    let replacementSettled = false;

    const oldWork = owner.run((runtime) => {
      expect(runtime).to.equal("old");
      return physical.promise;
    });
    const replacement = owner.replace(
      () => {
        factoryCalls++;
        lifecycle.push("staged new");
        return "new";
      },
      {maxInflight: 1, timeoutMs: 1_000},
    ).then(() => {
      replacementSettled = true;
    });

    await Promise.resolve();
    expect(disposeCalls).to.equal(1, "old runtime was not asked to stop");
    expect(factoryCalls).to.equal(1, "next runtime was not staged before old admission closed");
    expect(lifecycle).to.deep.equal(["staged new", "disposed old"]);
    expect(replacementSettled).to.equal(false, "replacement completed before physical drain");
    expect(await rejectionOf(owner.run(() => Promise.resolve("late admission"))))
      .to.be.instanceOf(BoundedAsyncWorkInvalidatedError);

    physical.resolve("old result");
    expect(await rejectionOf(oldWork)).to.be.instanceOf(BoundedAsyncWorkInvalidatedError);
    await replacement;
    expect(factoryCalls).to.equal(1);
    expect(await owner.run((runtime) => Promise.resolve(runtime))).to.equal("new");
  });

  it("leaves the current generation untouched when staging fails", async () => {
    const owner = new BoundedAsyncWork<string>();
    let disposeCalls = 0;
    owner.start(() => "old", {maxInflight: 1, timeoutMs: 1_000}, () => {
      disposeCalls++;
    });

    const error = await rejectionOf(owner.replace(
      () => {
        throw new Error("staging failed");
      },
      {maxInflight: 1, timeoutMs: 1_000},
    ));
    expect(String(error)).to.include("staging failed");
    expect(disposeCalls).to.equal(0, "staging failure disposed the last-good runtime");
    expect(await owner.run((runtime) => Promise.resolve(runtime))).to.equal("old");
  });

  it("keeps stop fail closed until the owned task drains", async () => {
    const owner = new BoundedAsyncWork<string>();
    owner.start(() => "provider", {maxInflight: 1, timeoutMs: 1_000});
    const physical = new PromiseDfd<void>();
    const oldWork = owner.run(() => physical.promise);
    let stopped = false;

    const stop = owner.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).to.equal(false, "stop completed with physical work still pending");
    expect(await rejectionOf(owner.run(() => Promise.resolve())))
      .to.be.instanceOf(BoundedAsyncWorkInvalidatedError);

    physical.resolve();
    expect(await rejectionOf(oldWork)).to.be.instanceOf(BoundedAsyncWorkInvalidatedError);
    await stop;
    expect(stopped).to.equal(true);
  });
});
