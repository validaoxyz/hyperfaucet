
import { FaucetLogLevel, FaucetProcess } from "../../common/FaucetProcess.js";
import { ServiceManager } from "../../common/ServiceManager.js";
import { FaucetSession, FaucetSessionStoreData } from "../../session/FaucetSession.js";
import { BaseModule } from "../BaseModule.js";
import { ModuleHookAction } from "../ModuleManager.js";
import { captchaProviders, defaultConfig, ICaptchaConfig } from "./CaptchaConfig.js";
import { FaucetError } from '../../common/FaucetError.js';
import { FetchUtil } from '../../utils/FetchUtil.js';
import type { SessionClaimHookArgs } from '../../eth/EthClaimManager.js';

const CAPTCHA_RESPONSE_LIMIT = 64 * 1024;
const CAPTCHA_REQUEST_TIMEOUT = 10000;
const CUSTOM_CAPTCHA_REQUEST_TIMEOUT = 20000;

export interface HCaptchaVerifyOptions {
  endpoint?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class HCaptchaApi {
  public static verify(
    secret: string,
    token: string,
    remoteip?: string,
    sitekey?: string,
    options: HCaptchaVerifyOptions = {},
  ): Promise<unknown> {
    let verifyData = new URLSearchParams();
    verifyData.append("secret", secret);
    verifyData.append("response", token);
    if(remoteip)
      verifyData.append("remoteip", remoteip);
    if(sitekey)
      verifyData.append("sitekey", sitekey);

    return FetchUtil.fetchBoundedJson(
      options.endpoint || "https://api.hcaptcha.com/siteverify",
      {
        init: {
          method: "POST",
          body: verifyData,
          headers: {"Content-Type": "application/x-www-form-urlencoded"},
        },
        timeoutMs: options.timeoutMs ?? CAPTCHA_REQUEST_TIMEOUT,
        maxResponseBytes: options.maxResponseBytes ?? CAPTCHA_RESPONSE_LIMIT,
      },
    );
  }
}

type CaptchaVariant = "session" | "claim";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

function isValidHostname(hostname: string): boolean {
  if(!hostname || hostname.length > 253)
    return false;
  return hostname.split(".").every((label) =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  );
}

export class CaptchaModule extends BaseModule<ICaptchaConfig> {
  protected readonly moduleDefaultConfig = defaultConfig;

  protected override startModule(): Promise<void> {
    this.validateConfig();
    this.moduleManager.addActionHook(
      this, ModuleHookAction.ClientConfig, 1, "captcha config", 
      async (clientConfig: any) => {
        clientConfig[this.moduleName] = {
          provider: this.moduleConfig.provider,
          siteKey: this.moduleConfig.siteKey,
          requiredForStart: this.moduleConfig.checkSessionStart,
          requiredForClaim: this.moduleConfig.checkBalanceClaim,
        };
      }
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionStart, 2, "captcha check",
      async (session: FaucetSession, userInput: any) => this.processSessionStart(session, userInput)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionClaim, 1, "captcha check", 
      async (...[, userInput, sessionData]: SessionClaimHookArgs) => this.processSessionClaim(sessionData, userInput)
    );
    return Promise.resolve();
  }

  protected override onConfigReload(): void {
    this.validateConfig();
  }

  protected override stopModule(): Promise<void> {
    // nothing to do
    return Promise.resolve();
  }
  
  private async processSessionStart(session: FaucetSession, userInput: any): Promise<void> {
    if(!this.moduleConfig.checkSessionStart)
      return;
    if(!userInput.captchaToken)
      throw new FaucetError("INVALID_CAPTCHA", "captcha check failed: captcha token missing");
    
    let result = await this.verifyToken(userInput.captchaToken, session.getRemoteIP(), "session");
    if(typeof result === "string")
      session.setSessionData("captcha.ident", result);
    else if(!result)
      throw new FaucetError("INVALID_CAPTCHA", "captcha check failed: invalid token");
  }

  private async processSessionClaim(sessionData: FaucetSessionStoreData, userInput: any): Promise<void> {
    if(!this.moduleConfig.checkBalanceClaim)
      return;
    if(!userInput.captchaToken)
      throw new FaucetError("INVALID_CAPTCHA", "captcha check failed: captcha token missing");
    
    let result = await this.verifyToken(userInput.captchaToken, sessionData.remoteIP, "claim");
    if(!result)
      throw new FaucetError("INVALID_CAPTCHA", "captcha check failed: invalid token");
  }

  public async verifyToken(token: string, remoteIp: string, variant: CaptchaVariant): Promise<boolean|string> {
    switch(this.moduleConfig.provider) {
      case "hcaptcha":
        return await this.verifyHCaptchaToken(token, remoteIp);
      case "recaptcha":
        return await this.verifyReCaptchaToken(token, remoteIp);
      case "turnstile":
        return await this.verifyTurnstileToken(token, remoteIp, variant);
      case "custom":
        return await this.verifyCustomToken(token, remoteIp, variant);
      default:
        return false;
    }
  }

  private validateConfig(): void {
    if(!captchaProviders.includes(this.moduleConfig.provider))
      throw new Error("captcha provider is missing or unsupported");
    if(typeof this.moduleConfig.siteKey !== "string" || !this.moduleConfig.siteKey.trim())
      throw new Error("captcha siteKey is required");
    if(typeof this.moduleConfig.secret !== "string" || !this.moduleConfig.secret.trim())
      throw new Error("captcha secret is required");
    if(!Array.isArray(this.moduleConfig.allowedHostnames))
      throw new Error("captcha allowedHostnames must be an array");

    this.moduleConfig.allowedHostnames = this.moduleConfig.allowedHostnames.map((hostname) => {
      if(typeof hostname !== "string")
        throw new Error("captcha allowedHostnames entries must be strings");
      let normalized = normalizeHostname(hostname);
      if(!isValidHostname(normalized))
        throw new Error("captcha allowedHostnames contains an invalid hostname");
      return normalized;
    });
  }
  
  private async verifyHCaptchaToken(token: string, remoteIp: string): Promise<boolean> {
    let hcaptchaResponse = await HCaptchaApi.verify(this.moduleConfig.secret, token, remoteIp, this.moduleConfig.siteKey);
    return isRecord(hcaptchaResponse) && hcaptchaResponse.success === true;
  }

  private async verifyReCaptchaToken(token: string, remoteIp: string): Promise<boolean> {
    let verifyData = new URLSearchParams();
    verifyData.append("secret", this.moduleConfig.secret);
    verifyData.append("response", token);
    verifyData.append("remoteip", remoteIp);

    let verifyRsp = await this.fetchVerificationJson(
      "https://www.google.com/recaptcha/api/siteverify",
      verifyData,
      CAPTCHA_REQUEST_TIMEOUT,
    );

    if(!isRecord(verifyRsp) || verifyRsp.success !== true)
      return false;
    return true;
  }

  private async verifyTurnstileToken(token: string, remoteIp: string, expectedAction: CaptchaVariant): Promise<boolean> {
    let verifyData = new URLSearchParams();
    verifyData.append("secret", this.moduleConfig.secret);
    verifyData.append("response", token);
    verifyData.append("remoteip", remoteIp);

    let verifyRsp = await this.fetchVerificationJson(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      verifyData,
      CAPTCHA_REQUEST_TIMEOUT,
    );

    if(!isRecord(verifyRsp) || verifyRsp.success !== true || verifyRsp.action !== expectedAction)
      return false;
    if(this.moduleConfig.allowedHostnames.length > 0) {
      if(typeof verifyRsp.hostname !== "string")
        return false;
      if(!this.moduleConfig.allowedHostnames.includes(normalizeHostname(verifyRsp.hostname)))
        return false;
    }
    return true;
  }

  private async verifyCustomToken(token: string, remoteIp: string, variant: CaptchaVariant): Promise<boolean|string> {
    let verifyData = new URLSearchParams();
    verifyData.append("response", token);
    verifyData.append("remoteip", remoteIp);
    verifyData.append("variant", variant);

    let verifyRsp = await this.fetchVerificationJson(
      this.moduleConfig.secret,
      verifyData,
      CUSTOM_CAPTCHA_REQUEST_TIMEOUT,
    );

    if(!isRecord(verifyRsp) || verifyRsp.success !== true) {
      let info = isRecord(verifyRsp) && typeof verifyRsp.info === "string" ? verifyRsp.info : "";
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Captcha verification failed: " + info);
      return false;
    }
    return typeof verifyRsp.ident === "string" && verifyRsp.ident ? verifyRsp.ident : true;
  }

  private fetchVerificationJson(url: string, body: URLSearchParams, timeoutMs: number): Promise<unknown> {
    return FetchUtil.fetchBoundedJson(url, {
      init: {
        method: "POST",
        body,
        headers: {"Content-Type": "application/x-www-form-urlencoded"},
      },
      timeoutMs,
      maxResponseBytes: CAPTCHA_RESPONSE_LIMIT,
    });
  }

}
