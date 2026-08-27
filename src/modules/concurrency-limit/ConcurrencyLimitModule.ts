import { ServiceManager } from "../../common/ServiceManager.js";
import { FaucetSession } from "../../session/FaucetSession.js";
import { BaseModule } from "../BaseModule.js";
import { ModuleHookAction } from "../ModuleManager.js";
import { defaultConfig, IConcurrencyLimitConfig } from "./ConcurrencyLimitConfig.js";
import { PublicFaucetError } from "../../common/FaucetError.js";
import { SessionManager } from "../../session/SessionManager.js";
import { admissionSubject } from "../../session/AdmissionLedger.js";
import type { AdmissionSubject } from "../../session/AdmissionLedger.js";

type ConcurrencyLimitScope = "ip" | "address" | "ip-or-address";

interface CompiledConcurrencyLimitConfig {
  readonly concurrencyLimit: number;
  readonly scope: ConcurrencyLimitScope;
  readonly messageByAddr: string | null;
  readonly messageByIP: string | null;
}

function compileConfig(config: IConcurrencyLimitConfig): CompiledConcurrencyLimitConfig {
  if(typeof config.enabled !== "boolean")
    throw new Error("enabled must be a boolean");
  if(!Number.isSafeInteger(config.concurrencyLimit) || config.concurrencyLimit <= 0)
    throw new Error("concurrencyLimit must be a positive safe integer");
  if(typeof config.byAddrOnly !== "boolean")
    throw new Error("byAddrOnly must be a boolean");
  if(typeof config.byIPOnly !== "boolean")
    throw new Error("byIPOnly must be a boolean");
  if(config.byAddrOnly && config.byIPOnly)
    throw new Error("byAddrOnly and byIPOnly cannot both be true");
  if(config.messageByAddr !== null && typeof config.messageByAddr !== "string")
    throw new Error("messageByAddr must be a string or null");
  if(config.messageByIP !== null && typeof config.messageByIP !== "string")
    throw new Error("messageByIP must be a string or null");

  let scope: ConcurrencyLimitScope = "ip-or-address";
  if(config.byAddrOnly)
    scope = "address";
  else if(config.byIPOnly)
    scope = "ip";

  return {
    concurrencyLimit: config.concurrencyLimit,
    scope,
    messageByAddr: config.messageByAddr,
    messageByIP: config.messageByIP,
  };
}

export class ConcurrencyLimitModule extends BaseModule<IConcurrencyLimitConfig> {
  protected readonly moduleDefaultConfig = defaultConfig;
  private compiledConfig: CompiledConcurrencyLimitConfig | null = null;

  protected override startModule(): Promise<void> {
    this.compiledConfig = compileConfig(this.moduleConfig);
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionStart, 7, "Concurrency limit check",
      (session: FaucetSession) => this.processSessionStart(session)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionIpChange, 6, "Concurrency limit check",
      (session: FaucetSession) => this.processSessionStart(session)
    );
    return Promise.resolve();
  }

  protected override stopModule(): Promise<void> {
    this.compiledConfig = null;
    return Promise.resolve();
  }

  protected override onConfigReload(): void {
    this.compiledConfig = compileConfig(this.moduleConfig);
  }

  private processSessionStart(session: FaucetSession): void {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    this.checkLimit(session);
  }

  private checkLimit(session: FaucetSession): void {
    let config = this.compiledConfig;
    if(!config)
      throw new Error("concurrency-limit module is not configured");

    let sessionManager = ServiceManager.GetService(SessionManager);
    let concurrentSessionCount = 0;
    let concurrentLimitMessage: string = null;

    let ipCheck = {
      subject: admissionSubject.ip(session.getRemoteIP()),
      message: config.messageByIP || ("Only " + config.concurrencyLimit + " concurrent sessions allowed per IP"),
    };
    let addressCheck = {
      subject: admissionSubject.address(session.getTargetAddr()),
      message: config.messageByAddr || ("Only " + config.concurrencyLimit + " concurrent sessions allowed per wallet address"),
    };
    let checks: Array<{subject: AdmissionSubject; message: string}>;
    switch(config.scope) {
      case "ip":
        checks = [ipCheck];
        break;
      case "address":
        checks = [addressCheck];
        break;
      case "ip-or-address":
        checks = [ipCheck, addressCheck];
        break;
      default: {
        const exhaustive: never = config.scope;
        throw exhaustive;
      }
    }

    for(let check of checks) {
      let sessCount = sessionManager.getPriorAdmissionUsage(session, [check.subject]).count;
      if(sessCount > concurrentSessionCount) {
        concurrentSessionCount = sessCount;
        concurrentLimitMessage = check.message;
      }
    }

    if(concurrentSessionCount >= config.concurrencyLimit) {
      throw new PublicFaucetError({
        code: "CONCURRENCY_LIMIT",
        message: concurrentLimitMessage,
      });
    }
  }

}
