import path, { dirname, basename } from "path";
import { fileURLToPath } from "url";
import { isMainThread, workerData } from "node:worker_threads";
import { faucetConfig, loadFaucetConfig, setAppBasePath } from "./config/FaucetConfig.js";
import { FaucetWorkers } from "./common/FaucetWorker.js";
import { EthWalletManager } from "./eth/EthWalletManager.js";
import { FaucetHttpServer } from "./webserv/FaucetHttpServer.js";
import { FaucetDatabase } from "./db/FaucetDatabase.js";
import { ServiceManager } from "./common/ServiceManager.js";
import { FaucetStatsLog } from "./services/FaucetStatsLog.js";
import { FaucetLogLevel, FaucetProcess } from "./common/FaucetProcess.js";
import { EthClaimManager } from "./eth/EthClaimManager.js";
import { ModuleManager } from "./modules/ModuleManager.js";
import { SessionManager } from "./session/SessionManager.js";
import { FaucetStatus } from "./services/FaucetStatus.js";
import { createVoucher } from "./tools/createVoucher.js";

const UNPRINTABLE_STARTUP_ERROR = "[unprintable startup error]";

function formatStartupError(error: unknown): string {
  let description: string;
  try {
    description = String(error);
  } catch {
    description = UNPRINTABLE_STARTUP_ERROR;
  }

  if(error === null || (typeof error !== "object" && typeof error !== "function"))
    return description;

  let stack: unknown;
  try {
    stack = Reflect.get(error, "stack");
  } catch {
    return description;
  }
  return typeof stack === "string" && stack.length > 0
    ? description + " " + stack
    : description;
}

(async () => {
  let srcfile: string;
  if(typeof require !== "undefined") {
    srcfile = require.main.filename;
  } else {
    srcfile = fileURLToPath(import.meta.url);
  }
  let basepath = path.join(dirname(srcfile), "..");

  setAppBasePath(basepath);
  ServiceManager.GetService(FaucetWorkers).initialize(srcfile);

  if(!isMainThread) {
    FaucetWorkers.loadWorkerClass();
    return;
  }
  
  if(process.argv.length >= 3) {
    switch(process.argv[2]) {
      case "worker":
        FaucetWorkers.loadWorkerClass(process.argv[3]);
        return;
      case "create-voucher":
        createVoucher();
        return;
    }
  }
  
  try {
    loadFaucetConfig();
    ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Initializing PoWFaucet v" + faucetConfig.faucetVersion + " (AppBasePath: " + faucetConfig.appBasePath + ", InternalBasePath: " + basepath + ")");
    ServiceManager.GetService(FaucetProcess).initialize();
    ServiceManager.GetService(FaucetStatus).initialize();
    ServiceManager.GetService(FaucetStatsLog).initialize();
    await ServiceManager.GetService(FaucetDatabase).initialize();
    await ServiceManager.GetService(EthWalletManager).initialize();
    await ServiceManager.GetService(ModuleManager).initialize();
    await ServiceManager.GetService(SessionManager).initialize();
    await ServiceManager.GetService(EthClaimManager).initialize();
    await ServiceManager.GetService(ModuleManager).activateModulesAfterStateRestore();
    ServiceManager.GetService(FaucetHttpServer).initialize();

    ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Faucet initialization complete.");
  } catch(ex) {
    const faucetProcess = ServiceManager.GetService(FaucetProcess);
    const errorDetails = formatStartupError(ex);
    try {
      faucetProcess.emitLog(FaucetLogLevel.ERROR, "Faucet initialization failed: " + errorDetails);
    } catch {
      // Shutdown must proceed even when the configured log sink is unavailable.
    }
    await faucetProcess.shutdown(1);
  }
})();
