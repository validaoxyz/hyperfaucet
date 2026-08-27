import { ServiceManager } from "../../common/ServiceManager.js";
import { EthWalletManager } from "../../eth/EthWalletManager.js";
import { FaucetSession, FaucetSessionStoreData } from "../../session/FaucetSession.js";
import { BaseModule } from "../BaseModule.js";
import { ModuleHookAction } from "../ModuleManager.js";
import { defaultConfig, IAuthenticatoorConfig, IAuthenticatoorGrantConfig } from './AuthenticatoorConfig.js';
import { FaucetError, PublicFaucetError } from '../../common/FaucetError.js';
import { FaucetDatabase } from "../../db/FaucetDatabase.js";
import { renderTimespan } from "../../utils/DateUtils.js";
import { FaucetLogLevel, FaucetProcess } from "../../common/FaucetProcess.js";
import { ISessionRewardFactor } from "../../session/SessionRewardFactor.js";
import { SessionManager } from "../../session/SessionManager.js";
import { AuthenticatoorVerifier, IAuthenticatoorClaims } from './AuthenticatoorVerifier.js';
import { AuthenticatoorDB, IAuthenticatoorPrincipal } from './AuthenticatoorDB.js';
import { AdmissionSubject, AdmissionUsage, admissionSubject, excludeCommittedUsage } from "../../session/AdmissionLedger.js";

export interface IAuthenticatoorAuthInfo {
  subject: string;
  email: string;
  issuer: string;
}

export interface AuthenticatoorGrantPerks {
  factor?: number;
  skipModules?: string[];
  overrideMaxDrop?: number;
}

interface AuthenticatoorGrantCheck {
  grant: IAuthenticatoorGrantConfig;
  finishedSessions: Promise<FaucetSessionStoreData[]>;
  priorUsage: AdmissionUsage;
}

interface AuthenticatoorPolicy {
  verifier: AuthenticatoorVerifier | null;
  requireLogin: boolean;
  concurrencyLimit: number;
  grants: IAuthenticatoorGrantConfig[];
}

interface CanonicalAuthenticatoorIdentity {
  kind: "canonical";
  principal: IAuthenticatoorPrincipal;
  legacyUserId: string;
}

interface LegacyAuthenticatoorIdentity {
  kind: "legacy";
  issuer: string;
  legacyUserId: string;
}

type AuthenticatoorIdentity = CanonicalAuthenticatoorIdentity | LegacyAuthenticatoorIdentity;

export class AuthenticatoorModule extends BaseModule<IAuthenticatoorConfig> {
  protected readonly moduleDefaultConfig = defaultConfig;
  private authDb: AuthenticatoorDB;
  private authPolicy: AuthenticatoorPolicy;

  private get verifier(): AuthenticatoorVerifier | null {
    return this.authPolicy?.verifier || null;
  }

  protected override async startModule(): Promise<void> {
    this.authDb = await ServiceManager.GetService(FaucetDatabase).createModuleDb(AuthenticatoorDB, this);
    this.initVerifier();

    this.moduleManager.addActionHook(
      this, ModuleHookAction.ClientConfig, 1, "authenticatoor login config",
      async (clientConfig: any) => {
        clientConfig[this.moduleName] = {
          authUrl: this.moduleConfig.authUrl,
          requireLogin: this.moduleConfig.requireLogin,
          loginLabel: this.moduleConfig.loginLabel,
          userLabel: this.moduleConfig.userLabel,
          infoHtml: this.moduleConfig.infoHtml,
          loginLogo: this.moduleConfig.loginLogo,
        };
      }
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionStart, 2, "authenticatoor login check",
      (session: FaucetSession, userInput: any) => this.processSessionStart(session, userInput)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionRestore, 2, "Restore authenticatoor admission reservation",
      (session: FaucetSession) => this.restoreSessionReservation(session)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionComplete, 5, "authenticatoor save session",
      (session: FaucetSession) => this.processSessionComplete(session)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionRewardFactor, 5, "authenticatoor reward factor",
      (session: FaucetSession, rewardFactors: ISessionRewardFactor[]) => this.processSessionRewardFactor(session, rewardFactors)
    );
  }

  protected override stopModule(): Promise<void> {
    this.authPolicy = null;
    this.authDb?.dispose();
    return Promise.resolve();
  }

  protected override onConfigReload(): void {
    this.initVerifier();
  }

  private initVerifier(): void {
    let verifier: AuthenticatoorVerifier | null = null;
    if(!this.moduleConfig.authUrl) {
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.WARNING, "authenticatoor module enabled but no authUrl configured; tokens cannot be verified");
    }
    else {
      let audience = this.moduleConfig.expectedAudience;
      if(!audience)
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.WARNING, "authenticatoor module: expectedAudience is not configured; verification will fail until set");
      verifier = new AuthenticatoorVerifier(this.moduleConfig.authUrl, audience || "", this.moduleConfig.expectedHost || "");
    }

    this.authPolicy = {
      verifier,
      requireLogin: this.moduleConfig.requireLogin,
      concurrencyLimit: this.moduleConfig.concurrencyLimit,
      grants: this.moduleConfig.grants.map((grant) => ({
        ...grant,
        skipModules: grant.skipModules?.slice(),
      })),
    };
  }

  private async processSessionStart(session: FaucetSession, userInput: any): Promise<void> {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;

    const policy = this.authPolicy;
    let authInfo: IAuthenticatoorAuthInfo | null = null;
    if(userInput.authToken && policy.verifier) {
      try {
        let claims = await policy.verifier.verify(userInput.authToken);
        authInfo = this.claimsToAuthInfo(claims);
      } catch(ex) {
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.WARNING, "Error verifying authenticatoor token: " + ex.toString());
        throw new FaucetError("AUTHENTICATOOR_TOKEN", "Invalid authenticatoor login token.");
      }
    }

    if(policy.requireLogin && !authInfo) {
      throw new FaucetError("AUTHENTICATOOR_REQUIRED", "You need to authenticate to use this faucet.");
    }

    if(authInfo) {
      for(let grant of policy.grants) {
        if(typeof grant.overrideMaxDrop !== "undefined")
          session.reserveAdmissionClaimCeiling(BigInt(grant.overrideMaxDrop));
      }

      let identity = this.getCanonicalIdentity(authInfo);
      let subjects = this.getAdmissionSubjects(identity);
      let sessionManager = ServiceManager.GetService(SessionManager);
      sessionManager.bindAdmissionSubjects(session, subjects);
      this.checkConcurrencyLimit(sessionManager.getPriorAdmissionUsage(session, subjects), policy.concurrencyLimit);

      let now = Math.floor((new Date()).getTime() / 1000);
      let checks: AuthenticatoorGrantCheck[] = policy.grants.map((grant) => ({
        grant,
        priorUsage: sessionManager.getPriorAdmissionUsage(session, subjects, {
          minStartTime: now - grant.duration,
        }),
        finishedSessions: this.authDb.getPrincipalSessions(
          identity.principal,
          [identity.legacyUserId],
          grant.duration,
          true,
        ),
      }));
      let finishedSessions = await Promise.all(checks.map((check) => check.finishedSessions));

      let perks: AuthenticatoorGrantPerks = {};
      for(let i = 0; i < checks.length; i++)
        this.checkGrant(checks[i].grant, perks, finishedSessions[i], checks[i].priorUsage);

      session.setSessionData("authenticatoor.data", authInfo);
      if(typeof perks.factor === "number")
        session.setSessionData("authenticatoor.factor", perks.factor);
      if(typeof perks.overrideMaxDrop === "number") {
        session.setMaxDropAmountOverride(BigInt(perks.overrideMaxDrop));
        await session.setDropAmount(BigInt(perks.overrideMaxDrop));
      }
      if(perks.skipModules) {
        let skipModules = session.getSessionData<Array<string>>("skip.modules", []);
        perks.skipModules.forEach((mod) => {
          if(!mod)
            return;
          if(skipModules.indexOf(mod) === -1)
            skipModules.push(mod);
        });
        session.setSessionData("skip.modules", skipModules);
      }
    }
  }

  private restoreSessionReservation(session: FaucetSession): void {
    let identity = this.getStoredIdentity(session);
    if(!identity)
      return;
    ServiceManager.GetService(SessionManager).bindAdmissionSubjects(session, this.getAdmissionSubjects(identity));
  }

  private async processSessionComplete(session: FaucetSession): Promise<void> {
    let identity = this.getStoredIdentity(session);
    if(!identity)
      return;
    if(identity.kind === "canonical") {
      await this.authDb.setPrincipalSession(
        session.getSessionId(),
        identity.principal,
        session.getStartTime(),
      );
    }
    else {
      await this.authDb.setLegacySession(
        session.getSessionId(),
        {issuer: identity.issuer, userId: identity.legacyUserId},
        session.getStartTime(),
      );
    }
  }

  private async processSessionRewardFactor(session: FaucetSession, rewardFactors: ISessionRewardFactor[]): Promise<void> {
    let factor = session.getSessionData("authenticatoor.factor");
    if(typeof factor !== "number")
      return;
    rewardFactors.push({
      factor: factor,
      module: this.moduleName,
    });
  }

  private claimsToAuthInfo(claims: IAuthenticatoorClaims): IAuthenticatoorAuthInfo {
    let subject = typeof claims.sub === "string" ? claims.sub : "";
    let issuer = typeof claims.iss === "string" ? claims.iss : "";
    if(!subject || !issuer)
      throw new Error("token has no issuer or subject claim");
    return {
      subject,
      email: typeof claims.email === "string" ? claims.email : "",
      issuer,
    };
  }

  private getCanonicalIdentity(authInfo: IAuthenticatoorAuthInfo): CanonicalAuthenticatoorIdentity {
    return {
      kind: "canonical",
      principal: {issuer: authInfo.issuer, subject: authInfo.subject},
      legacyUserId: authInfo.email || authInfo.subject,
    };
  }

  private getStoredIdentity(session: FaucetSession): AuthenticatoorIdentity | null {
    let authInfo = session.getSessionData<unknown>("authenticatoor.data");
    if(!this.isRecord(authInfo))
      return null;

    let issuer = this.getNonEmptyString(authInfo.issuer);
    if(!issuer)
      return null;

    let subject = this.getNonEmptyString(authInfo.subject);
    if(subject) {
      let email = typeof authInfo.email === "string" ? authInfo.email : "";
      return this.getCanonicalIdentity({issuer, subject, email});
    }

    let userId = this.getNonEmptyString(authInfo.userId);
    if(!userId)
      return null;
    return {kind: "legacy", issuer, legacyUserId: userId};
  }

  private getAdmissionSubjects(identity: AuthenticatoorIdentity): AdmissionSubject[] {
    let issuer = identity.kind === "canonical" ? identity.principal.issuer : identity.issuer;
    let subjects = [this.getLegacyAdmissionSubject(issuer, identity.legacyUserId)];
    if(identity.kind === "canonical")
      subjects.unshift(this.getCanonicalAdmissionSubject(identity.principal));
    return subjects;
  }

  private getCanonicalAdmissionSubject(principal: IAuthenticatoorPrincipal): AdmissionSubject {
    return admissionSubject.principal(
      "authenticatoor",
      JSON.stringify([principal.issuer, principal.subject]),
    );
  }

  private getLegacyAdmissionSubject(issuer: string, userId: string): AdmissionSubject {
    return admissionSubject.principal(
      "authenticatoor-legacy-user",
      JSON.stringify([issuer, userId]),
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private getNonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  private checkConcurrencyLimit(priorUsage: AdmissionUsage, concurrencyLimit: number): void {
    if(concurrencyLimit === 0)
      return;
    if(priorUsage.count >= concurrencyLimit) {
      throw new PublicFaucetError({
        code: "AUTHENTICATOOR_CONCURRENCY_LIMIT",
        message: "Only " + concurrencyLimit + " concurrent sessions allowed per authenticated user.",
      });
    }
  }

  private checkGrant(
    grant: IAuthenticatoorGrantConfig,
    perks: AuthenticatoorGrantPerks,
    finishedSessions: FaucetSessionStoreData[],
    priorUsage: AdmissionUsage,
  ): void {
    let activeUsage = excludeCommittedUsage(priorUsage, finishedSessions.map((finishedSession) => finishedSession.sessionId));
    let usedCount = finishedSessions.length + activeUsage.count;

    if(grant.limitCount > 0 && usedCount >= grant.limitCount) {
      if(!grant.required)
        return;
      let errMsg = grant.message || [
        "You have already created ",
        usedCount,
        (usedCount > 1 ? " sessions" : " session"),
        " in the last ",
        renderTimespan(grant.duration),
      ].join("");
      throw new PublicFaucetError({ code: "AUTHENTICATOOR_LIMIT", message: errMsg });
    }

    if(grant.limitAmount > 0) {
      let totalAmount = activeUsage.amount;
      finishedSessions.forEach((sess) => totalAmount += BigInt(sess.dropAmount));
      if(activeUsage.hasProvisionalAmount || totalAmount >= BigInt(grant.limitAmount)) {
        if(!grant.required)
          return;
        let errMsg = grant.message || (activeUsage.hasProvisionalAmount
          ? "Another request for this authenticated user is still being processed. Please try again."
          : [
            "You have already requested ",
            ServiceManager.GetService(EthWalletManager).readableAmount(totalAmount),
            " in the last ",
            renderTimespan(grant.duration),
          ].join(""));
        throw new PublicFaucetError({ code: "AUTHENTICATOOR_LIMIT", message: errMsg });
      }
    }

    if(grant.skipModules)
      perks.skipModules = grant.skipModules;
    if(typeof grant.rewardFactor === "number")
      perks.factor = grant.rewardFactor;
    if(typeof grant.overrideMaxDrop !== "undefined")
      perks.overrideMaxDrop = grant.overrideMaxDrop;
  }

}
