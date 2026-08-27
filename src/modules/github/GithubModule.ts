import { ServiceManager } from "../../common/ServiceManager.js";
import { EthWalletManager } from "../../eth/EthWalletManager.js";
import { FaucetSession, FaucetSessionStoreData } from "../../session/FaucetSession.js";
import { BaseModule } from "../BaseModule.js";
import { ModuleHookAction } from "../ModuleManager.js";
import { defaultConfig, IGithubRestrictionConfig, IGithubConfig } from './GithubConfig.js';
import { FaucetError, PublicFaucetError } from '../../common/FaucetError.js';
import { FaucetDatabase } from "../../db/FaucetDatabase.js";
import { renderTimespan } from "../../utils/DateUtils.js";
import { FaucetWebApi, IFaucetApiUrl } from "../../webserv/FaucetWebApi.js";
import { IncomingMessage } from "http";
import type { OutgoingHttpHeaders } from "http";
import { randomBytes } from "node:crypto";
import { faucetConfig } from "../../config/FaucetConfig.js";
import { FaucetHttpResponse } from "../../webserv/FaucetHttpServer.js";
import { GithubResolver, IGithubAuthInfo, IGithubInfo, IGithubInfoOpts } from './GithubResolver.js';
import { GithubDB } from './GithubDB.js';
import { FaucetLogLevel, FaucetProcess } from "../../common/FaucetProcess.js";
import { ISessionRewardFactor } from "../../session/SessionRewardFactor.js";
import { AdmissionUsage, admissionSubject, excludeCommittedUsage } from "../../session/AdmissionLedger.js";
import { SessionManager } from "../../session/SessionManager.js";
import {
  AUTH_CALLBACK_RESPONSE_HEADERS,
  AuthCallbackResult,
  buildAuthCallbackPage,
  normalizeHttpOrigin,
  resolveAuthCallbackContext,
  resolveAuthCallbackOrigins,
} from "../../webserv/AuthCallbackPage.js";
import {
  GITHUB_AUTH_BROWSER_BINDING_PATTERN,
  GITHUB_AUTH_STATE_LIFETIME_SECONDS,
  GithubAuthStateStore,
} from "./GithubAuthState.js";

interface GithubRestrictionCheck {
  restriction: IGithubRestrictionConfig;
  finishedSessions: Promise<FaucetSessionStoreData[]>;
  priorUsage: AdmissionUsage;
}

type GithubAuthBindingCookie =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; value: string };

const GITHUB_AUTH_BINDING_COOKIE_PREFIX = "__Host-hyperfaucet-github-auth-";

function readGithubAuthBindingCookie(req: IncomingMessage, state: string): GithubAuthBindingCookie {
  const cookieHeader = req.headers.cookie;
  if(cookieHeader === undefined)
    return { kind: "missing" };
  if(typeof cookieHeader !== "string")
    return { kind: "invalid" };

  const expectedCookieName = GITHUB_AUTH_BINDING_COOKIE_PREFIX + state;
  let binding: string | null = null;
  for(const rawCookie of cookieHeader.split(";")) {
    const separatorIndex = rawCookie.indexOf("=");
    const cookieName = (separatorIndex < 0 ? rawCookie : rawCookie.slice(0, separatorIndex)).trim();
    if(cookieName !== expectedCookieName)
      continue;
    if(separatorIndex < 0 || binding !== null)
      return { kind: "invalid" };

    const cookieValue = rawCookie.slice(separatorIndex + 1).trim();
    if(!GITHUB_AUTH_BROWSER_BINDING_PATTERN.test(cookieValue))
      return { kind: "invalid" };
    binding = cookieValue;
  }

  return binding === null
    ? { kind: "missing" }
    : { kind: "valid", value: binding };
}

function serializeGithubAuthBindingCookie(state: string, binding: string): string {
  return [
    `${GITHUB_AUTH_BINDING_COOKIE_PREFIX}${state}=${binding}`,
    "Path=/",
    `Max-Age=${GITHUB_AUTH_STATE_LIFETIME_SECONDS}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export class GithubModule extends BaseModule<IGithubConfig> {
  protected readonly moduleDefaultConfig = defaultConfig;
  private readonly githubAuthStates = new GithubAuthStateStore();
  private githubDb: GithubDB;
  private githubResolver: GithubResolver;

  protected override async startModule(): Promise<void> {
    this.githubDb = await ServiceManager.GetService(FaucetDatabase).createModuleDb(GithubDB, this);
    this.githubResolver = new GithubResolver(this);
    this.moduleManager.addActionHook(
      this, ModuleHookAction.ClientConfig, 1, "github login config", 
      async (clientConfig: any) => {
        clientConfig[this.moduleName] = {
          clientId: this.moduleConfig.appClientId,
          authTimeout: this.moduleConfig.authTimeout,
          redirectUrl: this.moduleConfig.redirectUrl,
        };
      }
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionStart, 6, "Github login check", 
      (session: FaucetSession, userInput: any) => this.processSessionStart(session, userInput)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionRestore, 6, "Restore Github admission reservation",
      (session: FaucetSession) => this.restoreSessionReservation(session)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionComplete, 5, "Github save session", 
      (session: FaucetSession) => this.processSessionComplete(session)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionRewardFactor, 5, "Github reward factor", 
      (session: FaucetSession, rewardFactors: ISessionRewardFactor[]) => this.processSessionRewardFactor(session, rewardFactors)
    );
    ServiceManager.GetService(FaucetWebApi).registerApiEndpoint(
      "githubAuthState",
      (req: IncomingMessage, url: IFaucetApiUrl) => this.processGithubAuthState(req, url)
    );
    ServiceManager.GetService(FaucetWebApi).registerApiEndpoint(
      "githubAuthResult",
      (req: IncomingMessage, url: IFaucetApiUrl) => this.processGithubAuthResult(req, url)
    );
    ServiceManager.GetService(FaucetWebApi).registerApiEndpoint(
      "githubCallback", 
      (req: IncomingMessage, url: IFaucetApiUrl, body: Buffer) => this.processGithubAuthCallback(req, url, body)
    );
    return Promise.resolve();
  }

  protected override async stopModule(): Promise<void> {
    ServiceManager.GetService(FaucetWebApi).removeApiEndpoint("githubAuthState");
    ServiceManager.GetService(FaucetWebApi).removeApiEndpoint("githubAuthResult");
    ServiceManager.GetService(FaucetWebApi).removeApiEndpoint("githubCallback");
    this.githubAuthStates.clear();
    this.githubDb?.dispose();
    this.githubResolver = null;
  }

  public getGithubDb(): GithubDB {
    return this.githubDb;
  }

  private async processSessionStart(session: FaucetSession, userInput: any): Promise<void> {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    let infoOpts: IGithubInfoOpts = {
      loadOwnRepo: false,
    };
    this.moduleConfig.checks.forEach((check) => {
      if(check.minOwnRepoCount || check.minOwnRepoStars)
        infoOpts.loadOwnRepo = true;
    });

    let githubInfo: IGithubInfo;
    try{
      githubInfo = await this.githubResolver.getGithubInfo(userInput.githubToken, infoOpts);
    } catch(ex) {
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.WARNING, "Error while fetching github info: " + ex.toString());
    }

    let now = Math.floor((new Date()).getTime() / 1000);
    let rewardFactor: number = null;
    for(let i = 0; i < this.moduleConfig.checks.length; i++) {
      let check = this.moduleConfig.checks[i];
      let passed = !!githubInfo;
      let errmsg: string = githubInfo ? null : "missing or invalid github token";

      if(passed && check.minAccountAge) {
        if(!(passed = (now - githubInfo.info.createTime > check.minAccountAge)))
          errmsg = "account age check failed";
      }
      if(passed && check.minRepoCount) {
        if(!(passed = (githubInfo.info.repoCount >= check.minRepoCount)))
          errmsg = "repository count check failed";
      }
      if(passed && check.minFollowers) {
        if(!(passed = (githubInfo.info.followers >= check.minFollowers)))
          errmsg = "follower count check failed";
      }
      if(passed && check.minOwnRepoCount) {
        if(!(passed = (githubInfo.info.ownRepoCount >= check.minOwnRepoCount)))
          errmsg = "own repository count check failed";
      }
      if(passed && check.minOwnRepoStars) {
        if(!(passed = (githubInfo.info.ownRepoStars >= check.minOwnRepoStars)))
          errmsg = "own repository star count check failed";
      }

      if(check.required && passed === false) {
        let errMsg: string;
        if(check.message)
          errMsg = check.message.replace("{0}", errmsg);
        else
          errMsg = "Your github account does not meet the minimum requirements: " + errmsg;
        throw new PublicFaucetError({
          code: "GITHUB_CHECK",
          message: errMsg,
        });
      }
      if(passed && typeof check.rewardFactor === "number" && (rewardFactor === null || check.rewardFactor > rewardFactor)) {
        rewardFactor = check.rewardFactor;
      }
    }

    session.setSessionData("github.uid", githubInfo?.uid);
    session.setSessionData("github.user", githubInfo?.user);
    if(rewardFactor !== null)
      session.setSessionData("github.factor", rewardFactor);

    if(githubInfo) {
      let subject = admissionSubject.principal("github", githubInfo.uid.toString());
      let sessionManager = ServiceManager.GetService(SessionManager);
      sessionManager.bindAdmissionSubjects(session, [subject]);
      let now = Math.floor((new Date()).getTime() / 1000);
      let checks: GithubRestrictionCheck[] = this.moduleConfig.restrictions.map((restriction) => ({
        restriction,
        priorUsage: sessionManager.getPriorAdmissionUsage(session, [subject], {
          minStartTime: now - restriction.duration,
        }),
        finishedSessions: this.githubDb.getGithubSessions(githubInfo.uid, restriction.duration, true),
      }));
      let finishedSessions = await Promise.all(checks.map((check) => check.finishedSessions));
      for(let i = 0; i < checks.length; i++)
        this.checkRestriction(checks[i].restriction, finishedSessions[i], checks[i].priorUsage);
    }
  }

  private restoreSessionReservation(session: FaucetSession): void {
    let githubUserId = session.getSessionData<number>("github.uid");
    if(!githubUserId)
      return;
    ServiceManager.GetService(SessionManager).bindAdmissionSubjects(session, [
      admissionSubject.principal("github", githubUserId.toString()),
    ]);
  }

  private async processSessionComplete(session: FaucetSession): Promise<void> {
    let githubUserId = session.getSessionData("github.uid");
    if(!githubUserId)
      return;

    await this.githubDb.setGithubSession(session.getSessionId(), githubUserId);
  }

  private async processSessionRewardFactor(session: FaucetSession, rewardFactors: ISessionRewardFactor[]): Promise<void> {
    let githubFactor = session.getSessionData("github.factor");
    if(typeof githubFactor !== "number")
      return;
    rewardFactors.push({
      factor: githubFactor,
      module: this.moduleName,
    });
  }

  private async processGithubAuthState(req: IncomingMessage, url: IFaucetApiUrl): Promise<FaucetHttpResponse> {
    if(req.method !== "POST") {
      return new FaucetHttpResponse(405, "Method Not Allowed", null, {
        "Allow": "POST",
        "Cache-Control": "no-store",
      });
    }

    const callbackOrigins = resolveAuthCallbackOrigins({
      request: req,
      query: url.query,
      redirectUrl: this.moduleConfig.redirectUrl,
      corsAllowOrigins: faucetConfig.corsAllowOrigin || [],
      trustedProxyCount: faucetConfig.httpProxyCount,
    });
    if(!callbackOrigins)
      return this.invalidAuthCallbackResponse();
    if(!this.hasBoundClientOrigin(req, callbackOrigins))
      return this.invalidAuthCallbackResponse();
    const originHeaders = this.getBoundOriginResponseHeaders(callbackOrigins);
    if(!callbackOrigins.sameOrigin && !callbackOrigins.callbackOrigin.startsWith("https://"))
      return this.invalidAuthCallbackResponse(originHeaders);
    if(!this.hasSameSiteBrowserRequest(req, callbackOrigins))
      return this.invalidAuthCallbackResponse(originHeaders);

    try {
      const browserBinding = callbackOrigins.sameOrigin
        ? null
        : randomBytes(32).toString("hex");
      const ownerIp = ServiceManager.GetService(FaucetWebApi).getRemoteAddr(req);
      const capability = this.githubAuthStates.issue(callbackOrigins, ownerIp, browserBinding);
      const bindingCookie = browserBinding
        ? serializeGithubAuthBindingCookie(capability.state, browserBinding)
        : null;
      return new FaucetHttpResponse(200, "OK", JSON.stringify(capability), {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        ...(bindingCookie ? { "Set-Cookie": bindingCookie } : {}),
        "X-Content-Type-Options": "nosniff",
        ...originHeaders,
      });
    } catch(ex) {
      const errorMessage = ex instanceof Error ? ex.message : String(ex);
      ServiceManager.GetService(FaucetProcess).emitLog(
        FaucetLogLevel.WARNING,
        "GitHub authentication state issuance failed: " + errorMessage,
      );
      return new FaucetHttpResponse(503, "Service Unavailable", "GitHub authentication is unavailable.", {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        ...originHeaders,
      });
    }
  }

  private async processGithubAuthResult(req: IncomingMessage, url: IFaucetApiUrl): Promise<FaucetHttpResponse> {
    if(req.method !== "POST") {
      return new FaucetHttpResponse(405, "Method Not Allowed", null, {
        "Allow": "POST",
        "Cache-Control": "no-store",
      });
    }

    const callbackContext = resolveAuthCallbackContext({
      request: req,
      query: url.query,
      redirectUrl: this.moduleConfig.redirectUrl,
      corsAllowOrigins: faucetConfig.corsAllowOrigin || [],
      trustedProxyCount: faucetConfig.httpProxyCount,
    });
    if(!callbackContext)
      return this.invalidAuthCallbackResponse();
    if(!this.hasBoundClientOrigin(req, callbackContext))
      return this.invalidAuthCallbackResponse();

    const originHeaders = this.getBoundOriginResponseHeaders(callbackContext);
    if(!this.hasSameSiteBrowserRequest(req, callbackContext))
      return this.invalidAuthCallbackResponse(originHeaders);
    const browserBinding = this.getRequiredBrowserBinding(req, callbackContext);
    if(!callbackContext.sameOrigin && !browserBinding)
      return this.invalidAuthCallbackResponse(originHeaders);

    const resultConsumption = this.githubAuthStates.consumeResult(callbackContext, browserBinding);
    if(resultConsumption.kind === "rejected")
      return this.invalidAuthCallbackResponse(originHeaders);

    const responseHeaders = {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...originHeaders,
    };
    if(resultConsumption.kind === "pending") {
      return new FaucetHttpResponse(202, "Accepted", JSON.stringify({ status: "pending" }), responseHeaders);
    }

    return new FaucetHttpResponse(200, "OK", JSON.stringify({
      authModule: "github",
      authState: callbackContext.authState,
      authResult: resultConsumption.authResult,
    }), responseHeaders);
  }

  private async processGithubAuthCallback(req: IncomingMessage, url: IFaucetApiUrl, body: Buffer): Promise<any> {
    if(req.method !== "GET") {
      return new FaucetHttpResponse(405, "Method Not Allowed", null, {
        ...AUTH_CALLBACK_RESPONSE_HEADERS,
        "Allow": "GET",
      });
    }

    const callbackContext = resolveAuthCallbackContext({
      request: req,
      query: url.query,
      redirectUrl: this.moduleConfig.redirectUrl,
      corsAllowOrigins: faucetConfig.corsAllowOrigin || [],
      trustedProxyCount: faucetConfig.httpProxyCount,
    });
    if(!callbackContext)
      return this.invalidAuthCallbackResponse();

    const browserBinding = this.getRequiredBrowserBinding(req, callbackContext);
    if(!callbackContext.sameOrigin && !browserBinding)
      return this.invalidAuthCallbackResponse();

    const stateConsumption = this.githubAuthStates.consume(callbackContext, browserBinding);
    if(stateConsumption.kind !== "accepted")
      return this.invalidAuthCallbackResponse();

    let authResult: AuthCallbackResult<IGithubAuthInfo>;
    if(url.query.error !== undefined) {
      authResult = {
        errorCode: "AUTH_DENIED",
        errorMessage: "GitHub authentication was not completed.",
      };
    } else if(typeof url.query.code === "string" && url.query.code.length > 0 && url.query.code.length <= 1024) {
      try {
        authResult = {
          data: await this.githubResolver.createAuthInfo(url.query.code, stateConsumption.ownerIp),
        };
      } catch(ex) {
        const errorMessage = ex instanceof Error ? ex.message : String(ex);
        ServiceManager.GetService(FaucetProcess).emitLog(
          FaucetLogLevel.WARNING,
          "GitHub authentication callback failed: " + errorMessage,
        );
        authResult = {
          errorCode: "AUTH_ERROR",
          errorMessage: "Could not complete GitHub authentication.",
        };
      }
    } else {
      authResult = {
        errorCode: "AUTH_ERROR",
        errorMessage: "Could not complete GitHub authentication.",
      };
    }

    if(!this.githubAuthStates.complete(callbackContext.authState, authResult)) {
      ServiceManager.GetService(FaucetProcess).emitLog(
        FaucetLogLevel.WARNING,
        "GitHub authentication callback result could not be retained.",
      );
    }

    const pageHtml = buildAuthCallbackPage({
      authModule: "github",
      context: callbackContext,
      authResult,
    });
    return new FaucetHttpResponse(200, "OK", pageHtml, {
      ...AUTH_CALLBACK_RESPONSE_HEADERS,
      ...(browserBinding ? {
        "Set-Cookie": serializeGithubAuthBindingCookie(callbackContext.authState, browserBinding),
      } : {}),
    });
  }

  private invalidAuthCallbackResponse(headers: OutgoingHttpHeaders = {}): FaucetHttpResponse {
    return new FaucetHttpResponse(400, "Bad Request", "Invalid authentication callback request.", {
      ...AUTH_CALLBACK_RESPONSE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      ...headers,
    });
  }

  private getBoundOriginResponseHeaders(origins: {clientOrigin: string; sameOrigin: boolean}): OutgoingHttpHeaders {
    if(origins.sameOrigin)
      return {};
    return {
      "Access-Control-Allow-Origin": origins.clientOrigin,
      "Access-Control-Allow-Credentials": "true",
      "Vary": "Origin",
    };
  }

  private getRequiredBrowserBinding(
    req: IncomingMessage,
    context: {authState: string; sameOrigin: boolean},
  ): string | null {
    if(context.sameOrigin)
      return null;
    const cookie = readGithubAuthBindingCookie(req, context.authState);
    return cookie.kind === "valid" ? cookie.value : null;
  }

  private hasSameSiteBrowserRequest(
    req: IncomingMessage,
    context: {sameOrigin: boolean},
  ): boolean {
    return context.sameOrigin || req.headers["sec-fetch-site"] === "same-site";
  }

  private hasBoundClientOrigin(req: IncomingMessage, origins: {clientOrigin: string}): boolean {
    const requestOrigin = req.headers.origin;
    return typeof requestOrigin === "string"
      && normalizeHttpOrigin(requestOrigin) === origins.clientOrigin;
  }

  private checkRestriction(
    restriction: IGithubRestrictionConfig,
    finishedSessions: FaucetSessionStoreData[],
    priorUsage: AdmissionUsage,
  ): void {
    let activeUsage = excludeCommittedUsage(priorUsage, finishedSessions.map((finishedSession) => finishedSession.sessionId));
    let usedCount = finishedSessions.length + activeUsage.count;

    if(restriction.limitCount > 0 && usedCount >= restriction.limitCount) {
      let errMsg = restriction.message || [
        "You have already created ",
        usedCount,
        (usedCount > 1 ? " sessions" : " session"),
        " in the last ",
        renderTimespan(restriction.duration)
      ].join("");
      throw new PublicFaucetError({
        code: "GITHUB_LIMIT",
        message: errMsg,
      });
    }

    if(restriction.limitAmount > 0) {
      let totalAmount = activeUsage.amount;
      finishedSessions.forEach((session) => totalAmount += BigInt(session.dropAmount));
      if(activeUsage.hasProvisionalAmount || totalAmount >= BigInt(restriction.limitAmount)) {
        let errMsg = restriction.message || (activeUsage.hasProvisionalAmount
          ? "Another request for this Github account is still being processed. Please try again."
          : [
            "You have already requested ",
            ServiceManager.GetService(EthWalletManager).readableAmount(totalAmount),
            " in the last ",
            renderTimespan(restriction.duration)
          ].join(""));
        throw new PublicFaucetError({
          code: "GITHUB_LIMIT",
          message: errMsg,
        });
      }
    }
  }

}
