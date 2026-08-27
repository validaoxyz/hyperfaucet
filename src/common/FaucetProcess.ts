import * as fs from 'fs';
import { TypedEmitter } from 'tiny-typed-emitter';
import { FaucetDatabase } from '../db/FaucetDatabase.js';
import { renderDate } from '../utils/DateUtils.js';
import { strPadRight } from '../utils/StringUtils.js';
import { faucetConfig, loadFaucetConfig, resolveRelativePath } from '../config/FaucetConfig.js';
import { ServiceManager } from './ServiceManager.js';
import { SessionManager } from '../session/SessionManager.js';
import { FaucetHttpServer } from '../webserv/FaucetHttpServer.js';
import { EthClaimManager } from '../eth/EthClaimManager.js';
import { ModuleManager } from '../modules/ModuleManager.js';


interface FaucetProcessEvents {
  'event': () => void;
  'reload': () => void;
}

const MAX_LOG_MESSAGE_LENGTH = 4096;
const LOG_TRUNCATION_MARKER = " [truncated]";

function sanitizeLogMessage(message: string): string {
  let raw = String(message ?? "");
  let sanitized = raw.slice(0, MAX_LOG_MESSAGE_LENGTH)
    .replace(/\r\n|\r|\n|\u2028|\u2029/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");

  if(raw.length <= MAX_LOG_MESSAGE_LENGTH && sanitized.length <= MAX_LOG_MESSAGE_LENGTH)
    return sanitized;
  return sanitized.slice(0, MAX_LOG_MESSAGE_LENGTH - LOG_TRUNCATION_MARKER.length) + LOG_TRUNCATION_MARKER;
}

function describeError(error: unknown): string {
  try {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } catch {
    return "unprintable error";
  }
}

function writeStderrFallback(message: string): void {
  try {
    console.error(sanitizeLogMessage(message));
  } catch {
    // Logging must never change application or shutdown state.
  }
}

export enum FaucetLogLevel {
  ERROR   = "ERROR",
  WARNING = "WARNING",
  INFO    = "INFO",
  HIDDEN  = "HIDDEN",
}

export class FaucetProcess extends TypedEmitter<FaucetProcessEvents> {
  private initialized: boolean;
  private shutdownPromise: Promise<void> | null = null;
  public hideLogOutput: boolean;

  private eventHandlers = {
    "uncaughtException": (err, origin) => {
      this.emitLog(FaucetLogLevel.ERROR, `### Caught unhandled exception: ${err}\r\n` + `  Exception origin: ${origin}\r\n` + `  Stack Trace: ${err.stack}\r\n`);
      this.shutdown(1);
    },
    "unhandledRejection": (reason: any, promise) => {
      let stack;
      try {
        throw new Error();
      } catch(ex) {
        stack = ex.stack;
      }
      this.emitLog(FaucetLogLevel.ERROR, `### Caught unhandled rejection: ${reason}\r\n` + `  Stack Trace: ${reason && reason.stack ? reason.stack : stack}\r\n`);
    },
    "SIGUSR1": () => {
      this.emitLog(FaucetLogLevel.INFO, `# Received SIGURS1 signal - reloading faucet config`);
      loadFaucetConfig();
      this.emit("reload");
    },
    "SIGINT": () => {
      // CTRL+C
      this.emitLog(FaucetLogLevel.INFO, `# Received SIGINT signal - shutdown faucet`);
      this.shutdown(0);
    },
    "SIGQUIT": () => {
      // Keyboard quit
      this.emitLog(FaucetLogLevel.INFO, `# Received SIGQUIT signal - shutdown faucet`);
      this.shutdown(0);
    },
    "SIGTERM": () => {
      // `kill` command
      this.emitLog(FaucetLogLevel.INFO, `# Received SIGTERM signal - shutdown faucet`);
      this.shutdown(0);
    },
  }

  public initialize() {
    if(this.initialized)
      return;
    this.initialized = true;

    if(faucetConfig.faucetPidFile) {
      fs.writeFileSync(faucetConfig.faucetPidFile, process.pid.toString());
    }
    Object.keys(this.eventHandlers).forEach((evtName) => {
      process.on(evtName, this.eventHandlers[evtName]);
    });
  }

  public dispose() {
    if(!this.initialized)
      return;
    this.initialized = false;
    Object.keys(this.eventHandlers).forEach((evtName) => {
      process.off(evtName, this.eventHandlers[evtName]);
    });
  }

  public shutdown(code: number): Promise<void> {
    if(!this.shutdownPromise)
      this.shutdownPromise = this.performShutdown(code);
    return this.shutdownPromise;
  }

  private async performShutdown(code: number): Promise<void> {
    let errors: unknown[] = [];
    let dbService = ServiceManager.GetService(FaucetDatabase);
    let sessionManager = ServiceManager.GetService(SessionManager);
    let moduleManager = ServiceManager.GetService(ModuleManager);
    let steps: Array<[string, () => Promise<unknown> | unknown]> = [
      ["stop HTTP admission", () => ServiceManager.DisposeService(FaucetHttpServer)],
      ["stop new reward operations", () => sessionManager.stopRewardOperations()],
      ["drain claim processing", () => ServiceManager.DisposeService(EthClaimManager)],
      ["quiesce module reward producers", () => moduleManager.quiesceRewardProducers()],
      ["drain session terminal producers", () => sessionManager.drainRewardProducers()],
      ["close and drain reward accounting", () => sessionManager.drainRewardOperations()],
      ["flush and stop modules", () => ServiceManager.DisposeService(ModuleManager)],
      ["save active sessions", () => sessionManager.saveAllSessions()],
      ["dispose services", () => ServiceManager.DisposeAllServices()],
      ["close the database", () => dbService.closeDatabase()],
    ];

    for(let [name, step] of steps) {
      try {
        await step();
      } catch(ex) {
        errors.push(ex);
        this.emitLog(FaucetLogLevel.ERROR, "Shutdown could not " + name + ": " + describeError(ex));
      }
    }

    process.exit(errors.length > 0 ? 1 : code);
  }

  public emitLog(level: FaucetLogLevel, message: string, data?: any) {
    if(level === FaucetLogLevel.HIDDEN)
      return;
    
    let logLine = renderDate(new Date(), true, true) + "  " + strPadRight(level, 7, " ") + "  " + sanitizeLogMessage(message);

    if(faucetConfig?.faucetLogFile) {
      try {
        let logFile = resolveRelativePath(faucetConfig.faucetLogFile);
        fs.appendFileSync(logFile, logLine + "\r\n");
      } catch(ex) {
        writeStderrFallback("Log file write failed; stderr fallback only: " + logLine + "; cause: " + describeError(ex));
      }
    }

    if(!this.hideLogOutput) {
      try {
        console.log(logLine);
      } catch(ex) {
        writeStderrFallback("Console log write failed: " + describeError(ex));
      }
    }
  }

}
