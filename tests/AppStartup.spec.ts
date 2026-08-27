import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ServiceManager } from '../src/common/ServiceManager.js';
import { FaucetWorkers } from '../src/common/FaucetWorker.js';
import { FaucetLogLevel, FaucetProcess } from '../src/common/FaucetProcess.js';
import { FaucetDatabase } from '../src/db/FaucetDatabase.js';
import { EthClaimManager } from '../src/eth/EthClaimManager.js';
import { EthWalletManager } from '../src/eth/EthWalletManager.js';
import { ModuleManager } from '../src/modules/ModuleManager.js';
import { FaucetStatsLog } from '../src/services/FaucetStatsLog.js';
import { FaucetStatus } from '../src/services/FaucetStatus.js';
import { SessionManager } from '../src/session/SessionManager.js';
import { FaucetHttpServer } from '../src/webserv/FaucetHttpServer.js';
import { cliArgs, setAppBasePath } from '../src/config/FaucetConfig.js';

class StartupOwnedWork {
  public active = false;
  public disposeCount = 0;

  public start(): void {
    this.active = true;
  }

  public dispose(): void {
    this.disposeCount++;
    this.active = false;
  }
}

describe("App startup", () => {
  it("shuts down partial initialization when startup error reporting fails", async () => {
    const originalArgv = process.argv.slice();
    const originalCliArgs = { ...cliArgs };
    const originalEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.startsWith("FAUCET_")),
    );
    const versionDescriptor = Object.getOwnPropertyDescriptor(globalThis, "POWFAUCET_VERSION");
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "powfaucet-startup-"));
    const events: string[] = [];
    let resolveExit: (code: number) => void;
    const exitCode = new Promise<number>((resolve) => resolveExit = resolve);

    try {
      await ServiceManager.DisposeAllServices();
      Object.keys(process.env)
        .filter((name) => name.startsWith("FAUCET_"))
        .forEach((name) => delete process.env[name]);

      fs.writeFileSync(path.join(configDir, "startup.yaml"), [
        "version: 2",
        `faucetSecret: ${"f".repeat(64)}`,
        `pseudonymKey: ${"p".repeat(64)}`,
        "modules: {}",
      ].join("\n"));
      cliArgs["datadir"] = configDir;
      cliArgs["config"] = "startup.yaml";

      const processExit = sinon.stub(process, "exit").callsFake((code?: number) => {
        events.push("exit:" + code);
        resolveExit(code ?? 0);
        return undefined as never;
      });
      sinon.stub(FaucetWorkers.prototype, "initialize");
      const emitLog = sinon.stub(FaucetProcess.prototype, "emitLog").callsFake((level, message) => {
        if(level === FaucetLogLevel.ERROR && message.startsWith("Faucet initialization failed:")) {
          events.push("failure-log");
          throw new Error("startup log sink failed");
        }
      });
      const shutdown = sinon.spy(FaucetProcess.prototype, "shutdown");
      const disposeAll = sinon.spy(ServiceManager, "DisposeAllServices");
      sinon.stub(FaucetStatus.prototype, "initialize");
      sinon.stub(FaucetStatsLog.prototype, "initialize");
      sinon.stub(FaucetDatabase.prototype, "initialize").resolves();
      sinon.stub(FaucetDatabase.prototype, "closeDatabase").callsFake(async () => {
        events.push("database-close");
      });
      sinon.stub(EthWalletManager.prototype, "initialize").resolves();
      sinon.stub(ModuleManager.prototype, "initialize").resolves();
      const moduleDispose = sinon.stub(ModuleManager.prototype, "dispose").resolves();
      sinon.stub(SessionManager.prototype, "initialize").resolves();
      sinon.stub(SessionManager.prototype, "stopRewardOperations");
      sinon.stub(SessionManager.prototype, "drainRewardOperations").resolves();
      sinon.stub(SessionManager.prototype, "saveAllSessions").resolves();
      sinon.stub(EthClaimManager.prototype, "initialize").resolves();
      const claimDispose = sinon.stub(EthClaimManager.prototype, "dispose").resolves();
      const httpInitialize = sinon.stub(FaucetHttpServer.prototype, "initialize");
      const hostileStartupError = Object.defineProperties({}, {
        toString: {
          value: () => { throw new Error("startup error toString failed"); },
        },
        stack: {
          get: () => { throw new Error("startup error stack access failed"); },
        },
      });
      let ownedWork: StartupOwnedWork;
      sinon.stub(ModuleManager.prototype, "activateModulesAfterStateRestore").callsFake(async () => {
        ownedWork = ServiceManager.GetService(StartupOwnedWork);
        ownedWork.start();
        throw hostileStartupError;
      });
      sinon.stub(StartupOwnedWork.prototype, "dispose").callsFake(function(this: StartupOwnedWork) {
        events.push("owned-work-dispose");
        this.disposeCount++;
        this.active = false;
      });

      Object.defineProperty(globalThis, "POWFAUCET_VERSION", {
        configurable: true,
        value: "test",
      });
      process.argv.splice(2);
      await import('../src/app.js');
      expect(await exitCode).to.equal(1, "startup failure did not exit nonzero");

      expect(emitLog.calledWithExactly(
        FaucetLogLevel.ERROR,
        "Faucet initialization failed: [unprintable startup error]",
      )).to.equal(true, "startup failure was not logged");
      expect(shutdown.calledOnceWithExactly(1)).to.equal(true, "startup failure did not request one error shutdown");
      expect(disposeAll.callCount).to.equal(1, "startup failure ran more than one service cleanup pass");
      expect(claimDispose.callCount).to.equal(1, "claim manager was not disposed exactly once");
      expect(moduleDispose.callCount).to.equal(1, "module manager was not disposed exactly once");
      expect(ownedWork.disposeCount).to.equal(1, "startup-owned work was not disposed exactly once");
      expect(ownedWork.active).to.equal(false, "startup-owned work survived cleanup");
      expect(httpInitialize.callCount).to.equal(0, "HTTP admission started after activation failed");
      expect(processExit.calledOnceWithExactly(1)).to.equal(true, "startup failure did not exit nonzero");
      expect(events).to.deep.equal([
        "failure-log",
        "owned-work-dispose",
        "database-close",
        "exit:1",
      ], "startup failure cleanup order changed");
      expect(ServiceManager.GetService(StartupOwnedWork)).not.to.equal(ownedWork, "registered startup work survived cleanup");
    } finally {
      await ServiceManager.DisposeAllServices();
      sinon.restore();
      process.argv.splice(0, process.argv.length, ...originalArgv);
      Object.keys(cliArgs).forEach((name) => delete cliArgs[name]);
      Object.assign(cliArgs, originalCliArgs);
      setAppBasePath(".");
      if(versionDescriptor)
        Object.defineProperty(globalThis, "POWFAUCET_VERSION", versionDescriptor);
      else
        Reflect.deleteProperty(globalThis, "POWFAUCET_VERSION");
      Object.keys(process.env)
        .filter((name) => name.startsWith("FAUCET_"))
        .forEach((name) => delete process.env[name]);
      Object.assign(process.env, originalEnvironment);
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});
