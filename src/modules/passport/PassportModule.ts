
import { ServiceManager } from '../../common/ServiceManager.js';
import { BaseModule } from '../BaseModule.js';
import {
  defaultConfig,
  IPassportConfig,
  MAX_PASSPORT_PROVIDER_LENGTH,
  parsePassportScoreUnits,
  type PassportScoreUnits,
} from './PassportConfig.js';
import { ModuleHookAction } from '../ModuleManager.js';
import { FaucetSession, FaucetSessionStatus } from '../../session/FaucetSession.js';
import { ISessionRewardFactor } from '../../session/SessionRewardFactor.js';
import { FaucetWebApi, IFaucetApiUrl } from '../../webserv/FaucetWebApi.js';
import {
  IPassportInfo,
  PassportLookupCapacityError,
  PassportLookupInvalidatedError,
  PassportResolver,
} from './PassportResolver.js';
import { IncomingMessage } from 'http';
import { SessionManager } from '../../session/SessionManager.js';
import { PassportDB } from './PassportDB.js';
import { FaucetDatabase } from '../../db/FaucetDatabase.js';
import { FaucetError, PublicFaucetError } from '../../common/FaucetError.js';
import { PassportVerificationUnavailableError } from './PassportDIDKitVerifier.js';

type ManualPassportPayload =
  | {kind: "valid", passportJson: string}
  | {kind: "invalid", error: string};

const MAX_MANUAL_ATTEMPT_ENTRIES = 10000;
const LOOKUP_WINDOW_SECONDS = 60;
const MAX_LOOKUP_COUNTERS = 10000;
const REWARD_FACTOR_SCALE = 100000;
const MAX_SAFE_ACCUMULATED_PASSPORT_SCORE = Number.MAX_SAFE_INTEGER;
const MAX_PASSPORT_CONFIG_STRING_LENGTH = 4096;

interface ILookupCounter {
  windowStart: number;
  count: number;
}

export class PassportModule extends BaseModule<IPassportConfig> {
  protected readonly moduleDefaultConfig = defaultConfig;
  
  private passportDb?: PassportDB;
  private passportResolver?: PassportResolver;
  private manualVerificationAttempts = new Map<string, number>();
  private manualVerificationsInFlight = new Set<string>();
  private lookupCounters = new Map<string, ILookupCounter>();

  protected override async startModule(): Promise<void> {
    this.validateConfig();
    this.passportDb = await ServiceManager.GetService(FaucetDatabase).createModuleDb(PassportDB, this);
    this.passportResolver = new PassportResolver(this);
    await this.passportResolver.start();
    this.moduleManager.addActionHook(
      this, ModuleHookAction.ClientConfig, 1, "passport config", 
      async (clientConfig: any) => {
        clientConfig[this.moduleName] = {
          refreshTimeout: this.moduleConfig.refreshCooldown,
          manualVerification: (this.moduleConfig.trustedIssuers && this.moduleConfig.trustedIssuers.length > 0),
          stampScoring: this.moduleConfig.stampScoring,
          boostFactor: this.moduleConfig.boostFactor,
          overrideScores: [ this.moduleConfig.skipHostingCheckScore, this.moduleConfig.skipProxyCheckScore, this.moduleConfig.requireMinScore ],
          guestRefresh: this.moduleConfig.allowGuestRefresh ? (this.moduleConfig.guestRefreshCooldown > 0 ? this.moduleConfig.guestRefreshCooldown : this.moduleConfig.refreshCooldown) : false,
        };
      }
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionStart, 6, "passport",
      (session: FaucetSession) => this.processSessionStart(session)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionInfo, 1, "passport state", 
      async (session: FaucetSession, moduleState: any) => this.processSessionInfo(session, moduleState)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionRewardFactor, 5, "passport boost",
      (session: FaucetSession, rewardFactors: ISessionRewardFactor[]) => this.processSessionRewardFactor(session, rewardFactors)
    );
    ServiceManager.GetService(FaucetWebApi).registerApiEndpoint(
      "refreshPassport", 
      (req: IncomingMessage, url: IFaucetApiUrl, body: Buffer) => this.processPassportRefresh(req, url, body),
      {maxBodySize: () => this.moduleConfig.maxPassportBytes},
    );
    ServiceManager.GetService(FaucetWebApi).registerApiEndpoint(
      "getPassportInfo", 
      (req: IncomingMessage, url: IFaucetApiUrl, body: Buffer) => this.processGetPassportInfo(req, url, body)
    );
  }

  protected override async stopModule(): Promise<void> {
    ServiceManager.GetService(FaucetWebApi).removeApiEndpoint("refreshPassport");
    ServiceManager.GetService(FaucetWebApi).removeApiEndpoint("getPassportInfo");
    await this.passportResolver?.stop();
    this.manualVerificationAttempts.clear();
    this.manualVerificationsInFlight.clear();
    this.lookupCounters.clear();
    this.passportResolver = undefined;
    this.passportDb?.dispose();
    this.passportDb = undefined;
  }

  public getPassportDb(): PassportDB {
    if(!this.passportDb)
      throw new Error("passport database is not running");
    return this.passportDb;
  }

  public getPassportResolver(): PassportResolver {
    if(!this.passportResolver)
      throw new Error("passport resolver is not running");
    return this.passportResolver;
  }

  protected override async onConfigReload(): Promise<void> {
    this.validateConfig();
    this.lookupCounters.clear();
    await this.passportResolver?.reload();
    this.manualVerificationAttempts.clear();
    this.manualVerificationsInFlight.clear();
  }

  private validateConfig(): void {
    let integerRanges: {[key: string]: {value: number, min: number, max: number}} = {
      cacheTime: {value: this.moduleConfig.cacheTime, min: 1, max: 365 * 86400},
      refreshCooldown: {value: this.moduleConfig.refreshCooldown, min: 0, max: 30 * 86400},
      guestRefreshCooldown: {value: this.moduleConfig.guestRefreshCooldown, min: 0, max: 30 * 86400},
      stampDeduplicationTime: {value: this.moduleConfig.stampDeduplicationTime, min: 1, max: 365 * 86400},
      guestLookupRateLimit: {value: this.moduleConfig.guestLookupRateLimit, min: 1, max: 1000},
      cacheLookupConcurrency: {value: this.moduleConfig.cacheLookupConcurrency, min: 1, max: 64},
      automaticLookupConcurrency: {value: this.moduleConfig.automaticLookupConcurrency, min: 1, max: 64},
      maxPassportBytes: {value: this.moduleConfig.maxPassportBytes, min: 1024, max: 1024 * 1024},
      maxPassportStamps: {value: this.moduleConfig.maxPassportStamps, min: 1, max: 256},
      manualVerificationConcurrency: {value: this.moduleConfig.manualVerificationConcurrency, min: 1, max: 8},
      manualVerificationTimeout: {value: this.moduleConfig.manualVerificationTimeout, min: 1, max: 300},
    };
    for(let [key, range] of Object.entries(integerRanges)) {
      if(!Number.isSafeInteger(range.value) || range.value < range.min || range.value > range.max)
        throw new Error("passport." + key + " must be an integer between " + range.min + " and " + range.max);
    }
    if(typeof this.moduleConfig.allowGuestRefresh !== "boolean")
      throw new Error("passport.allowGuestRefresh must be a boolean");
    let optionalStrings: Record<string, unknown> = {
      scorerApiKey: this.moduleConfig.scorerApiKey,
      cachePath: this.moduleConfig.cachePath,
    };
    for(let [key, value] of Object.entries(optionalStrings)) {
      if(value !== null && (
        typeof value !== "string" || value.length === 0 ||
        value.length > MAX_PASSPORT_CONFIG_STRING_LENGTH || value.includes("\0")
      ))
        throw new Error("passport." + key + " must be null or a bounded non-empty string");
    }
    let nonNegativeValues: Record<string, unknown> = {
      requireMinScore: this.moduleConfig.requireMinScore,
      skipProxyCheckScore: this.moduleConfig.skipProxyCheckScore,
      skipHostingCheckScore: this.moduleConfig.skipHostingCheckScore,
    };
    for(let [key, value] of Object.entries(nonNegativeValues)) {
      if(typeof value !== "number" || parsePassportScoreUnits(value) === null)
        throw new Error("passport." + key + " must be a canonical non-negative score with at most six decimal places");
    }
    if(!Array.isArray(this.moduleConfig.trustedIssuers) || this.moduleConfig.trustedIssuers.length > 32)
      throw new Error("passport.trustedIssuers must contain at most 32 issuers");
    let trustedIssuers = new Set<string>();
    for(let issuer of this.moduleConfig.trustedIssuers) {
      if(typeof issuer !== "string" || issuer.length === 0 || issuer.length > 512 || trustedIssuers.has(issuer))
        throw new Error("passport.trustedIssuers contains an invalid or duplicate issuer");
      trustedIssuers.add(issuer);
    }
    if(!this.isConfigMap(this.moduleConfig.stampScoring))
      throw new Error("passport.stampScoring must be an object");
    let maxStampScoreUnits = Math.floor(MAX_SAFE_ACCUMULATED_PASSPORT_SCORE / this.moduleConfig.maxPassportStamps);
    for(let [provider, score] of Object.entries(this.moduleConfig.stampScoring)) {
      let scoreUnits = parsePassportScoreUnits(score);
      if(
        provider.length === 0 || provider.length > MAX_PASSPORT_PROVIDER_LENGTH ||
        typeof score !== "number" || scoreUnits === null || scoreUnits > maxStampScoreUnits
      )
        throw new Error("passport.stampScoring contains an invalid provider or score");
    }
    if(!this.isConfigMap(this.moduleConfig.boostFactor))
      throw new Error("passport.boostFactor must be an object");
    for(let [thresholdValue, factor] of Object.entries(this.moduleConfig.boostFactor)) {
      let thresholdUnits = parsePassportScoreUnits(thresholdValue);
      let scaledFactor = typeof factor === "number" ? Math.floor(factor * REWARD_FACTOR_SCALE) : Number.NaN;
      if(
        thresholdUnits === null ||
        typeof factor !== "number" || !Number.isFinite(factor) || factor < 1 ||
        !Number.isSafeInteger(scaledFactor) || scaledFactor < 0
      )
        throw new Error("passport.boostFactor contains an invalid score tier");
    }
  }

  private isConfigMap(value: unknown): value is Record<string, unknown> {
    if(typeof value !== "object" || value === null || Array.isArray(value))
      return false;
    let prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  private getConfiguredScoreUnits(key: string, value: number): PassportScoreUnits {
    let units = parsePassportScoreUnits(value);
    if(units === null)
      throw new Error("passport." + key + " contains an invalid score");
    return units;
  }

  private parseManualPassportPayload(body: Buffer): ManualPassportPayload {
    if(!Buffer.isBuffer(body) || body.length === 0)
      return {kind: "invalid", error: "Missing passport JSON"};
    if(body.length > this.moduleConfig.maxPassportBytes)
      return {kind: "invalid", error: "Passport JSON exceeds the configured size limit"};

    let value: unknown;
    try {
      value = JSON.parse(body.toString("utf8"));
    } catch(ex) {
      return {kind: "invalid", error: "Invalid passport request"};
    }
    if(typeof value !== "string" || Buffer.byteLength(value, "utf8") > this.moduleConfig.maxPassportBytes)
      return {kind: "invalid", error: "Invalid passport request"};
    return {kind: "valid", passportJson: value};
  }

  private getManualVerificationCooldown(address: string, session: FaucetSession, cooldown: number, now: number): number {
    let normalizedAddress = address.toLowerCase();
    let addressAttempt = this.manualVerificationAttempts.get(normalizedAddress) || 0;
    let sessionAttempt = session ? session.getSessionData<number>("passport.manualRefresh", 0) : 0;
    let remaining = Math.max(addressAttempt, sessionAttempt) + cooldown - now;
    return this.manualVerificationsInFlight.has(normalizedAddress) ? Math.max(1, remaining) : remaining;
  }

  private recordManualVerificationAttempt(address: string, session: FaucetSession, now: number): void {
    let normalizedAddress = address.toLowerCase();
    this.manualVerificationAttempts.delete(normalizedAddress);
    while(this.manualVerificationAttempts.size >= MAX_MANUAL_ATTEMPT_ENTRIES) {
      let oldestAddress = this.manualVerificationAttempts.keys().next().value;
      if(!oldestAddress)
        break;
      this.manualVerificationAttempts.delete(oldestAddress);
    }
    this.manualVerificationAttempts.set(normalizedAddress, now);
    if(session)
      session.setSessionData("passport.manualRefresh", now);
  }

  private beginManualVerificationAttempt(address: string, session: FaucetSession, now: number): void {
    this.manualVerificationsInFlight.add(address.toLowerCase());
    this.recordManualVerificationAttempt(address, session, now);
  }

  private completeManualVerificationAttempt(address: string, session: FaucetSession, now: number): void {
    this.manualVerificationsInFlight.delete(address.toLowerCase());
    this.recordManualVerificationAttempt(address, session, now);
  }

  private async processSessionStart(session: FaucetSession): Promise<void> {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    let targetAddr = session.getTargetAddr();
    let passportInfo: IPassportInfo;
    try {
      passportInfo = await this.getPassportResolver().getPassport(
        targetAddr,
        false,
        () => this.consumeLookupBudget(session.getRemoteIP()),
      );
    } catch(ex) {
      if(ex instanceof PassportLookupCapacityError) {
        passportInfo = {found: false, parsed: Math.floor(Date.now() / 1000), newest: 0};
      } else {
        throw new FaucetError("PASSPORT_CHECK_FAILED", "Could not verify Gitcoin Passport. Please try again shortly.");
      }
    }
    session.setSessionData("passport.refresh", Math.floor(new Date().getTime() / 1000));
    session.setSessionData("passport.data", passportInfo);
    let scoreCalculation = this.getPassportResolver().getPassportScoreCalculation(passportInfo);
    let score = scoreCalculation.score;
    session.setSessionData("passport.score", score);

    let skipHostingCheckScore = this.getConfiguredScoreUnits(
      "skipHostingCheckScore",
      this.moduleConfig.skipHostingCheckScore,
    );
    let skipProxyCheckScore = this.getConfiguredScoreUnits(
      "skipProxyCheckScore",
      this.moduleConfig.skipProxyCheckScore,
    );
    let requireMinScore = this.getConfiguredScoreUnits("requireMinScore", this.moduleConfig.requireMinScore);
    if(skipHostingCheckScore > 0 && scoreCalculation.scoreUnits >= skipHostingCheckScore) {
      session.setSessionData("ipinfo.override_hosting", false);
    }
    if(skipProxyCheckScore > 0 && scoreCalculation.scoreUnits >= skipProxyCheckScore) {
      session.setSessionData("ipinfo.override_proxy", false);
    }
    if(requireMinScore > 0 && scoreCalculation.scoreUnits < requireMinScore) {
      throw new PublicFaucetError({
        code: "PASSPORT_SCORE",
        message: "You need a passport score of at least " + this.moduleConfig.requireMinScore + " to use this faucet.",
        data: {address: session.getTargetAddr()},
      });
    }
  }

  private async processSessionInfo(session: FaucetSession, moduleState: any): Promise<void> {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    if(session.getSessionStatus() !== FaucetSessionStatus.RUNNING)
      return;
    let passportInfo: IPassportInfo = session.getSessionData("passport.data");
    let passportBoost = passportInfo ? this.getPassportResolver().getPassportScore(passportInfo) : null;
    moduleState[this.moduleName] = passportBoost;
  }

  private processSessionRewardFactor(session: FaucetSession, rewardFactors: ISessionRewardFactor[]): void {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    let passportInfo: IPassportInfo = session.getSessionData("passport.data");
    if(!passportInfo)
      return;
    let passportBoost = this.getPassportResolver().getPassportScore(passportInfo);
    session.setSessionData("passport.score", passportBoost);
    if(passportBoost.factor !== 1) {
      rewardFactors.push({
        factor: passportBoost.factor,
        module: this.moduleName,
      });
    }
  }

  private async processPassportRefresh(req: IncomingMessage, url: IFaucetApiUrl, body: Buffer): Promise<any> {
    let sessionId = url.query['session'] as string;
    let session: FaucetSession;
    let address: string;
    let refreshCooldown: number;
    
    if(sessionId) {
      if(!(session = ServiceManager.GetService(SessionManager).getSession(sessionId, [FaucetSessionStatus.RUNNING]))) {
        return {
          code: "INVALID_SESSION",
          error: "Session not found"
        };
      }

      address = session.getTargetAddr();
      refreshCooldown = this.moduleConfig.refreshCooldown;
    } else {
      if (!this.moduleConfig.allowGuestRefresh) {
        return {
          code: "NOT_ALLOWED",
          error: "Passport refresh not allowed without active session"
        };
      }

      address = url.query['address'] as string;
      if (!address || !address.match(/^0x[0-9a-fA-F]{40}$/) || address.match(/^0x0{40}$/i)) {
        return {
          code: "INVALID_ADDRESS",
          error: "Invalid address"
        };
      }

      refreshCooldown = this.moduleConfig.guestRefreshCooldown > 0 ? this.moduleConfig.guestRefreshCooldown : this.moduleConfig.refreshCooldown;
    }

    let now = Math.floor(new Date().getTime() / 1000);
    let passportInfo: IPassportInfo;
    let manualCompletedAt: number | null = null;
    if(req.method === "POST") {
      let cooldown = this.getManualVerificationCooldown(address, session, refreshCooldown, now);
      if(cooldown > 0) {
        return {
          code: "REFRESH_COOLDOWN",
          error: "Passport verification is rate limited. Please wait " + cooldown + " sec",
          cooldown: now + cooldown,
        };
      }
      if(!session && !this.consumeLookupBudget(this.getRequestIp(req)))
        return this.guestLookupRateLimitResponse();
      this.beginManualVerificationAttempt(address, session, now);
      let manualFailure: Record<string, unknown> | null = null;
      try {
        let payload = this.parseManualPassportPayload(body);
        if(payload.kind === "invalid") {
          manualFailure = {
            code: "PASSPORT_VALIDATION",
            error: payload.error,
          };
        } else {
          try {
            let verifyResult = await this.getPassportResolver().verifyUserPassport(address, payload.passportJson);
            if(!verifyResult.valid) {
              manualFailure = {
                code: verifyResult.code || "PASSPORT_VALIDATION",
                error: "Passport verification failed",
                errors: verifyResult.errors,
              };
            } else {
              passportInfo = verifyResult.passportInfo;
            }
          } catch(ex) {
            if(ex instanceof PassportLookupInvalidatedError || ex instanceof PassportVerificationUnavailableError) {
              manualFailure = {
                code: "PASSPORT_UNAVAILABLE",
                error: "Passport verification was interrupted. Please try again.",
              };
            } else {
              throw ex;
            }
          }
        }
      } finally {
        manualCompletedAt = Math.floor(new Date().getTime() / 1000);
        this.completeManualVerificationAttempt(address, session, manualCompletedAt);
      }

      if(manualFailure) {
        return {
          ...manualFailure,
          cooldown: manualCompletedAt + refreshCooldown,
        };
      }
    }
    else {
      // auto refresh
      let lastRefresh: number;
      if(session) {
        lastRefresh = session.getSessionData("passport.refresh") || 0;
      } else {
        try {
          let cachedPassport = await this.getPassportResolver().getCachedPassport(address);
          lastRefresh = cachedPassport ? cachedPassport.parsed : 0;
        } catch(ex) {
          if(ex instanceof PassportLookupCapacityError)
            return {code: "PASSPORT_BUSY", error: "Passport lookup is busy. Please try again shortly."};
          if(ex instanceof PassportLookupInvalidatedError)
            return {code: "PASSPORT_UNAVAILABLE", error: "Passport lookup was interrupted. Please try again."};
          throw ex;
        }
      }

      if(now - lastRefresh < refreshCooldown) {
        return {
          code: "REFRESH_COOLDOWN",
          error: "Passport has been refreshed recently. Please wait " + (lastRefresh + refreshCooldown - now) + " sec",
          cooldown: lastRefresh + refreshCooldown,
        };
      }

      if(!session && !this.consumeLookupBudget(this.getRequestIp(req)))
        return this.guestLookupRateLimitResponse();
      try {
        passportInfo = await this.getPassportResolver().getPassport(address, true);
      } catch(ex) {
        if(ex instanceof PassportLookupCapacityError)
          return {code: "PASSPORT_BUSY", error: "Passport lookup is busy. Please try again shortly."};
        if(ex instanceof PassportLookupInvalidatedError)
          return {code: "PASSPORT_UNAVAILABLE", error: "Passport lookup was interrupted. Please try again."};
        throw ex;
      }
    }

    let refreshedAt = manualCompletedAt ?? Math.floor(new Date().getTime() / 1000);
    let passportScore = this.getPassportResolver().getPassportScore(passportInfo);
    if(session) {
      session.setSessionData("passport.refresh", refreshedAt);
      session.setSessionData("passport.data", passportInfo);
      session.setSessionData("passport.score", passportScore);
    }

    return {
      passport: passportInfo,
      score: passportScore,
      cooldown: refreshedAt + refreshCooldown,
    };
  }

  private async processGetPassportInfo(req: IncomingMessage, url: IFaucetApiUrl, body: Buffer): Promise<any> {
    let sessionId = url.query['session'] as string;
    let passportInfo: IPassportInfo

    if(sessionId) {
      let session: FaucetSession;
      if(!(session = ServiceManager.GetService(SessionManager).getSession(sessionId, [FaucetSessionStatus.RUNNING]))) {
        return {
          code: "INVALID_SESSION",
          error: "Session not found"
        };
      }

      passportInfo = session.getSessionData("passport.data");
      if(!passportInfo) {
        return {
          code: "INVALID_PASSPORT",
          error: "Passport not found"
        };
      }
    }
    else if(!sessionId) {
      if (!this.moduleConfig.allowGuestRefresh) {
        return {
          code: "NOT_ALLOWED",
          error: "Passport info not allowed without active session"
        };
      }

      let address = url.query['address'] as string;
      if (!address || !address.match(/^0x[0-9a-fA-F]{40}$/) || address.match(/^0x0{40}$/i)) {
        return {
          code: "INVALID_ADDRESS",
          error: "Invalid address"
        };
      }

      try {
        passportInfo = await this.getPassportResolver().getCachedPassport(address);
      } catch(ex) {
        if(ex instanceof PassportLookupCapacityError)
          return {code: "PASSPORT_BUSY", error: "Passport lookup is busy. Please try again shortly."};
        if(ex instanceof PassportLookupInvalidatedError)
          return {code: "PASSPORT_UNAVAILABLE", error: "Passport lookup was interrupted. Please try again."};
        throw ex;
      }
    }
    
    return {
      passport: passportInfo,
      score: this.getPassportResolver().getPassportScore(passportInfo),
    }
  }

  private getRequestIp(req: IncomingMessage): string {
    try {
      return ServiceManager.GetService(FaucetWebApi).getRemoteAddr(req) || "unknown";
    } catch(ex) {
      return "unknown";
    }
  }

  private consumeLookupBudget(remoteIp: string): boolean {
    let now = Math.floor(Date.now() / 1000);
    let counter = this.lookupCounters.get(remoteIp);
    if(!counter || now - counter.windowStart >= LOOKUP_WINDOW_SECONDS) {
      this.lookupCounters.delete(remoteIp);
      while(this.lookupCounters.size >= MAX_LOOKUP_COUNTERS) {
        let oldestIp = this.lookupCounters.keys().next().value;
        if(!oldestIp)
          break;
        this.lookupCounters.delete(oldestIp);
      }
      counter = {windowStart: now, count: 0};
      this.lookupCounters.set(remoteIp, counter);
    }
    if(counter.count >= this.moduleConfig.guestLookupRateLimit)
      return false;
    counter.count++;
    return true;
  }

  private guestLookupRateLimitResponse(): {code: string, error: string} {
    return {
      code: "PASSPORT_RATE_LIMITED",
      error: "Passport lookup is rate limited. Please try again later.",
    };
  }

}
