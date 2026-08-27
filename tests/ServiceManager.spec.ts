import "mocha";
import { expect } from "chai";
import { ServiceManager } from "../src/common/ServiceManager.js";

describe("ServiceManager", () => {
  afterEach(async () => {
    await ServiceManager.DisposeAllServices();
  });

  it("keeps every batch dependency registered until every disposer settles", async () => {
    let releaseConsumer: () => void;
    const consumerGate = new Promise<void>((resolve) => {
      releaseConsumer = resolve;
    });
    let consumerStarted: () => void;
    const consumerEntered = new Promise<void>((resolve) => {
      consumerStarted = resolve;
    });

    let dependencyDisposalCount = 0;
    class Dependency {
      public dispose(): void {
        dependencyDisposalCount++;
      }
    }

    let dependencyDuringDisposal: Dependency;
    class Consumer {
      public async dispose(): Promise<void> {
        consumerStarted();
        await consumerGate;
        dependencyDuringDisposal = ServiceManager.GetService(Dependency);
      }
    }

    const dependency = ServiceManager.GetService(Dependency);
    ServiceManager.GetService(Consumer);

    const disposal = ServiceManager.DisposeAllServices();
    const dependencyDisposal = ServiceManager.DisposeService(Dependency);
    await consumerEntered;
    await dependencyDisposal;

    try {
      expect(ServiceManager.GetService(Dependency)).to.equal(dependency);
      expect(dependencyDisposalCount).to.equal(1);
    }
    finally {
      releaseConsumer();
      await disposal;
    }

    expect(dependencyDuringDisposal).to.equal(dependency);
    expect(ServiceManager.GetService(Dependency)).not.to.equal(dependency);
  });

  it("aggregates disposal errors after every service settles", async () => {
    const fastError = new Error("fast disposal failed");
    const slowError = new Error("slow disposal failed");
    let releaseSlowService: () => void;
    const slowServiceGate = new Promise<void>((resolve) => {
      releaseSlowService = resolve;
    });
    let slowServiceStarted: () => void;
    const slowServiceEntered = new Promise<void>((resolve) => {
      slowServiceStarted = resolve;
    });

    class FastFailingService {
      public dispose(): never {
        throw fastError;
      }
    }

    class SlowFailingService {
      public async dispose(): Promise<void> {
        slowServiceStarted();
        await slowServiceGate;
        throw slowError;
      }
    }

    const fastService = ServiceManager.GetService(FastFailingService);
    ServiceManager.GetService(SlowFailingService);
    const disposal = ServiceManager.DisposeAllServices();
    await slowServiceEntered;
    await Promise.resolve();

    try {
      expect(ServiceManager.GetService(FastFailingService)).to.equal(fastService);
    }
    finally {
      releaseSlowService();
    }

    let disposalError: unknown;
    try {
      await disposal;
    } catch(ex) {
      disposalError = ex;
    }

    expect(disposalError).to.be.instanceOf(AggregateError);
    expect((disposalError as AggregateError).errors).to.deep.equal([fastError, slowError]);
  });

  it("coalesces concurrent disposal calls", async () => {
    let finishDisposal: () => void;
    const disposalGate = new Promise<void>((resolve) => {
      finishDisposal = resolve;
    });
    let disposalCount = 0;

    class SlowService {
      public async dispose(): Promise<void> {
        disposalCount++;
        await disposalGate;
      }
    }

    ServiceManager.GetService(SlowService);
    const firstDisposal = ServiceManager.DisposeAllServices();
    const secondDisposal = ServiceManager.DisposeAllServices();

    expect(secondDisposal).to.equal(firstDisposal);
    finishDisposal();
    await firstDisposal;
    expect(disposalCount).to.equal(1);
  });

  it("does not dispose an explicitly stopped service again during catch-all cleanup", async () => {
    let disposalCount = 0;
    class OwnedService {
      public dispose(): void {
        disposalCount++;
      }
    }

    const firstInstance = ServiceManager.GetService(OwnedService);
    await ServiceManager.DisposeService(OwnedService);
    await ServiceManager.DisposeAllServices();

    expect(disposalCount).to.equal(1);
    expect(ServiceManager.GetService(OwnedService)).not.to.equal(firstInstance);
  });
});
