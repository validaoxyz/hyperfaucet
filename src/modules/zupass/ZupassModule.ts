import { ServiceManager } from "../../common/ServiceManager.js";
import { EthWalletManager } from "../../eth/EthWalletManager.js";
import { FaucetSession, FaucetSessionStoreData } from "../../session/FaucetSession.js";
import { BaseModule } from "../BaseModule.js";
import { ModuleHookAction } from "../ModuleManager.js";
import { defaultConfig, IZupassConfig, IZupassGrantConfig } from './ZupassConfig.js';
import { FaucetError, PublicFaucetError } from '../../common/FaucetError.js';
import { FaucetDatabase } from "../../db/FaucetDatabase.js";
import { renderTimespan } from "../../utils/DateUtils.js";
import { FaucetWebApi, IFaucetApiUrl } from "../../webserv/FaucetWebApi.js";
import { IncomingMessage } from "http";
import { faucetConfig } from "../../config/FaucetConfig.js";
import { FaucetHttpResponse } from "../../webserv/FaucetHttpServer.js";
import { IZupassPDCData, ZKEdDSAEventTicketPCD, ZupassPCD } from './ZupassPCD.js';
import { ZupassDB } from './ZupassDB.js';
import { FaucetLogLevel, FaucetProcess } from "../../common/FaucetProcess.js";
import { ISessionRewardFactor } from "../../session/SessionRewardFactor.js";
import { SessionManager } from "../../session/SessionManager.js";
import { AdmissionUsage, admissionSubject, excludeCommittedUsage } from "../../session/AdmissionLedger.js";
import {
  AUTH_CALLBACK_RESPONSE_HEADERS,
  AuthCallbackContext,
  AuthCallbackResult,
  buildAuthCallbackPage,
  normalizeHttpOrigin,
  resolveAuthCallbackContext,
} from "../../webserv/AuthCallbackPage.js";
import {
  buildZupassProofRequestUrl,
  buildZupassVerifierPolicy,
  normalizeZupassSigner,
  ZupassChallengeStore,
  ZupassVerifierPolicy,
} from "./ZupassAuth.js";
import { assertBoundedJsonDocument } from "./ZupassJsonBounds.js";
import type { BoundedJsonDocumentOptions } from "./ZupassJsonBounds.js";

export interface ZupassGrantPerks {
  factor?: number;
  skipModules?: string[];
  overrideMaxDrop?: number;
}

interface ZupassGrantCheck {
  grant: IZupassGrantConfig;
  finishedSessions: Promise<FaucetSessionStoreData[]>;
  priorUsage: AdmissionUsage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MAX_ENCODED_ZUPASS_PROOF_CHARS = 96 * 1024;
const MAX_ZUPASS_PROOF_ENVELOPE_BYTES = 48 * 1024;
const MAX_ZUPASS_PROOF_ENVELOPE_DEPTH = 4;
const ZUPASS_PROOF_ENVELOPE_BOUNDS: BoundedJsonDocumentOptions = {
  maxBytes: MAX_ZUPASS_PROOF_ENVELOPE_BYTES,
  maxDepth: MAX_ZUPASS_PROOF_ENVELOPE_DEPTH,
  errorMessages: {
    size: "proof payload exceeds the decoded size limit",
    nesting: "proof payload exceeds the nesting limit",
  },
};

interface ZupassProofEnvelope {
  type: "zk-eddsa-event-ticket-pcd";
  pcd: string;
}

function parseProofEnvelope(encodedProof: string): ZupassProofEnvelope {
  let decodedProof: string;
  try {
    decodedProof = decodeURIComponent(encodedProof);
  } catch {
    throw new Error("proof payload encoding is invalid");
  }
  assertBoundedJsonDocument(decodedProof, ZUPASS_PROOF_ENVELOPE_BOUNDS);

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodedProof) as unknown;
  } catch {
    throw new Error("proof payload is not valid JSON");
  }
  if(!isRecord(parsed)
    || parsed.type !== "zk-eddsa-event-ticket-pcd"
    || typeof parsed.pcd !== "string"
  ) {
    throw new Error("proof payload has an invalid type");
  }
  return {
    type: parsed.type,
    pcd: parsed.pcd,
  };
}

export class ZupassModule extends BaseModule<IZupassConfig> {
  protected readonly moduleDefaultConfig = defaultConfig;
  private zupassDb: ZupassDB;
  private zupassPCD: ZupassPCD;
  private readonly challengeStore = new ZupassChallengeStore();
  private verifierPolicy: ZupassVerifierPolicy | null = null;

  protected override async startModule(): Promise<void> {
    this.applyVerifierPolicy();
    this.zupassDb = await ServiceManager.GetService(FaucetDatabase).createModuleDb(ZupassDB, this);
    this.zupassPCD = new ZupassPCD(this);

    this.moduleManager.addActionHook(
      this, ModuleHookAction.ClientConfig, 1, "Zupass login config", 
      async (clientConfig: any) => {
        clientConfig[this.moduleName] = {
          redirectUrl: this.moduleConfig.redirectUrl,
          loginLogo: this.moduleConfig.loginLogo,
          loginLabel: this.moduleConfig.loginLabel,
          userLabel: this.moduleConfig.userLabel,
          infoHtml: this.moduleConfig.infoHtml,
        };
      }
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionStart, 2, "Zupass login check", 
      (session: FaucetSession, userInput: any) => this.processSessionStart(session, userInput)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionRestore, 2, "Restore Zupass admission reservation",
      (session: FaucetSession) => this.restoreSessionReservation(session)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionComplete, 5, "Zupass save session", 
      (session: FaucetSession) => this.processSessionComplete(session)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionRewardFactor, 5, "Zupass reward factor", 
      (session: FaucetSession, rewardFactors: ISessionRewardFactor[]) => this.processSessionRewardFactor(session, rewardFactors)
    );
    ServiceManager.GetService(FaucetWebApi).registerApiEndpoint(
      "zupassLogin",
      (req: IncomingMessage, url: IFaucetApiUrl) => this.processZupassLogin(req, url),
    );
    ServiceManager.GetService(FaucetWebApi).registerApiEndpoint(
      "zupassCallback", 
      (req: IncomingMessage, url: IFaucetApiUrl) => this.processZupassAuthCallback(req, url),
    );
    return Promise.resolve();
  }

  protected override async stopModule(): Promise<void> {
    ServiceManager.GetService(FaucetWebApi).removeApiEndpoint("zupassLogin");
    ServiceManager.GetService(FaucetWebApi).removeApiEndpoint("zupassCallback");
    this.challengeStore.clear();
    this.verifierPolicy = null;
    await this.zupassPCD?.dispose();
    this.zupassDb?.dispose();
    this.zupassPCD = null;
  }

  protected override async onConfigReload(): Promise<void> {
    await this.zupassPCD?.reload();
    this.applyVerifierPolicy();
  }

  public getVerifierPolicy(): ZupassVerifierPolicy {
    if(!this.verifierPolicy)
      throw new Error("Zupass verifier policy is unavailable.");
    return this.verifierPolicy;
  }

  private applyVerifierPolicy(): void {
    this.challengeStore.clear();
    this.verifierPolicy = null;
    this.verifierPolicy = buildZupassVerifierPolicy(this.moduleConfig);
  }

  private async processSessionStart(session: FaucetSession, userInput: any): Promise<void> {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    
    let zupassInfo: IZupassPDCData | null = null;
    if(userInput.zupassToken) {
      try{
        zupassInfo = await this.zupassPCD.parseFaucetToken(userInput.zupassToken);
        if(!zupassInfo)
          throw new Error("invalid token payload");
      } catch(ex) {
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.WARNING, "Error while parsing zupass login token: " + ex.toString());
        throw new FaucetError(
          "ZUPASS_TOKEN", 
          "Invalid zupass login token",
        );
      }
    }
    
    if(this.moduleConfig.requireLogin && !zupassInfo) {
      throw new FaucetError(
        "ZUPASS_REQUIRED", 
        "You need to authenticate with your zupass account to use this faucet.",
      );
    }

    if(zupassInfo) {
      for(let grant of this.moduleConfig.grants) {
        if(typeof grant.overrideMaxDrop !== "undefined")
          session.reserveAdmissionClaimCeiling(BigInt(grant.overrideMaxDrop));
      }

      let subject = admissionSubject.principal("zupass", zupassInfo.attendeeId);
      let sessionManager = ServiceManager.GetService(SessionManager);
      sessionManager.bindAdmissionSubjects(session, [subject]);
      this.checkLimit(sessionManager.getPriorAdmissionUsage(session, [subject]));

      let now = Math.floor((new Date()).getTime() / 1000);
      let checks: ZupassGrantCheck[] = this.moduleConfig.grants.map((grant) => ({
        grant,
        priorUsage: sessionManager.getPriorAdmissionUsage(session, [subject], {
          minStartTime: now - grant.duration,
        }),
        finishedSessions: this.zupassDb.getZupassSessions(zupassInfo.attendeeId, grant.duration, true),
      }));
      let finishedSessions = await Promise.all(checks.map((check) => check.finishedSessions));

      let perks: ZupassGrantPerks = {};
      for(let i = 0; i < checks.length; i++)
        this.checkGrant(checks[i].grant, perks, finishedSessions[i], checks[i].priorUsage);
      
      session.setSessionData("zupass.data", zupassInfo);
      if(typeof perks.factor === "number")
        session.setSessionData("zupass.factor", perks.factor);
      if(typeof perks.overrideMaxDrop === "number")
        session.setMaxDropAmountOverride(BigInt(perks.overrideMaxDrop));
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
    let zupassInfo = session.getSessionData<IZupassPDCData>("zupass.data");
    if(!zupassInfo)
      return;
    ServiceManager.GetService(SessionManager).bindAdmissionSubjects(session, [
      admissionSubject.principal("zupass", zupassInfo.attendeeId),
    ]);
  }

  private async processSessionComplete(session: FaucetSession): Promise<void> {
    let zupassInfo = session.getSessionData<IZupassPDCData>("zupass.data");
    if(!zupassInfo)
      return;

    await this.zupassDb.setZupassSession(session.getSessionId(), zupassInfo.attendeeId, zupassInfo.ticketId, zupassInfo.eventId, zupassInfo.productId);
  }

  private async processSessionRewardFactor(session: FaucetSession, rewardFactors: ISessionRewardFactor[]): Promise<void> {
    let zupassFactor = session.getSessionData("zupass.factor");
    if(typeof zupassFactor !== "number")
      return;
    rewardFactors.push({
      factor: zupassFactor,
      module: this.moduleName,
    });
  }

  private async processZupassLogin(req: IncomingMessage, url: IFaucetApiUrl): Promise<FaucetHttpResponse> {
    if(req.method !== "POST") {
      return new FaucetHttpResponse(405, "Method Not Allowed", null, {
        "Allow": "POST",
        "Cache-Control": "no-store",
      });
    }

    const callbackContext = this.resolveCallbackContext(req, url);
    if(!callbackContext)
      return this.invalidCallbackResponse();
    const requestOrigin = req.headers.origin;
    if(typeof requestOrigin !== "string"
      || normalizeHttpOrigin(requestOrigin) !== callbackContext.clientOrigin
    ) {
      return this.invalidCallbackResponse();
    }

    let challengeId: string | null = null;
    try {
      const policy = this.getVerifierPolicy();
      const ownerIp = ServiceManager.GetService(FaucetWebApi).getRemoteAddr(req);
      const challenge = this.challengeStore.issue(callbackContext, policy, ownerIp);
      challengeId = challenge.id;
      const returnUrl = this.buildCallbackUrl(callbackContext, challenge.id);
      const proofRequestUrl = buildZupassProofRequestUrl(
        this.moduleConfig,
        policy,
        challenge,
        returnUrl,
      );
      return new FaucetHttpResponse(302, "Found", null, {
        "Cache-Control": "no-store",
        "Location": proofRequestUrl,
        "Referrer-Policy": "no-referrer",
      });
    } catch(ex) {
      if(challengeId)
        this.challengeStore.discard(challengeId);
      this.logAuthFailure("login initialization", ex);
      return new FaucetHttpResponse(503, "Service Unavailable", "Zupass authentication is unavailable. Try again.", {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      });
    }
  }

  private async processZupassAuthCallback(req: IncomingMessage, url: IFaucetApiUrl): Promise<FaucetHttpResponse> {
    if(req.method !== "GET")
      return new FaucetHttpResponse(405, "Method Not Allowed", null, { "Allow": "GET" });

    const callbackContext = this.resolveCallbackContext(req, url);
    if(!callbackContext)
      return this.invalidCallbackResponse();

    let authResult: AuthCallbackResult<IZupassPDCData>;
    try {
      const ownerIp = ServiceManager.GetService(FaucetWebApi).getRemoteAddr(req);
      authResult = { data: await this.validateZupassProof(url, callbackContext, ownerIp) };
    } catch(ex) {
      this.logAuthFailure("callback", ex);
      authResult = {
        errorCode: "ZUPASS_RESTART_REQUIRED",
        errorMessage: "Authentication failed. Start again.",
      };
    }

    const pageHtml = buildAuthCallbackPage({
      authModule: "zupass",
      context: callbackContext,
      authResult,
    });
    return new FaucetHttpResponse(200, "OK", pageHtml, AUTH_CALLBACK_RESPONSE_HEADERS);
  }

  private resolveCallbackContext(req: IncomingMessage, url: IFaucetApiUrl): AuthCallbackContext | null {
    const callbackContext = resolveAuthCallbackContext({
      request: req,
      query: url.query,
      redirectUrl: this.moduleConfig.redirectUrl,
      corsAllowOrigins: faucetConfig.corsAllowOrigin || [],
      trustedProxyCount: faucetConfig.httpProxyCount,
    });
    return callbackContext;
  }

  private invalidCallbackResponse(): FaucetHttpResponse {
    return new FaucetHttpResponse(400, "Bad Request", "Invalid authentication callback request.", {
      ...AUTH_CALLBACK_RESPONSE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
    });
  }

  private buildCallbackUrl(context: AuthCallbackContext, challengeId: string): string {
    const callbackUrl = new URL(
      this.moduleConfig.redirectUrl || "/api/zupassCallback",
      `${context.callbackOrigin}/`,
    );
    callbackUrl.searchParams.set("state", context.authState);
    callbackUrl.searchParams.set("clientOrigin", context.clientOrigin);
    callbackUrl.searchParams.set("challenge", challengeId);
    return callbackUrl.toString();
  }

  private async validateZupassProof(
    url: IFaucetApiUrl,
    callbackContext: AuthCallbackContext,
    ownerIp: string,
  ): Promise<IZupassPDCData> {
    const policy = this.getVerifierPolicy();
    const challengeResult = this.challengeStore.consume(url.query.challenge, callbackContext, policy, ownerIp);
    if(challengeResult.kind === "rejected")
      throw new Error(`challenge rejected: ${challengeResult.reason}`);

    const proof = url.query.proof;
    if(typeof proof !== "string" || proof.length === 0 || proof.length > MAX_ENCODED_ZUPASS_PROOF_CHARS)
      throw new Error("proof is missing");

    const admission = this.zupassPCD.reserveVerification();
    try {
      const parsedPCD = parseProofEnvelope(proof);
      let ticket: ZKEdDSAEventTicketPCD;
      try {
        ticket = this.zupassPCD.parseTicket(parsedPCD.pcd);
      } catch {
        throw new Error("ticket payload is invalid");
      }
      if(ticket.claim.watermark !== challengeResult.challenge.watermark)
        throw new Error("ticket watermark does not match the challenge");
      if(ticket.claim.externalNullifier !== policy.externalNullifier)
        throw new Error("ticket external nullifier does not match policy");

      const fields = [
        "productId",
        "eventId",
        "attendeeSemaphoreId",
        "ticketId",
        "isConsumed",
        "isRevoked",
      ] as const;
      for(const field of fields) {
        if(!(field in ticket.claim.partialTicket))
          throw new Error(`ticket is missing ${field}`);
      }
      if(ticket.claim.partialTicket.isConsumed || ticket.claim.partialTicket.isRevoked)
        throw new Error("ticket is no longer valid");

      let ticketSigner: readonly string[] | null;
      try {
        ticketSigner = normalizeZupassSigner(ticket.claim.signer);
      } catch {
        throw new Error("ticket signer is invalid");
      }
      if(policy.signer && (!ticketSigner || ticketSigner.some((coordinate, index) => coordinate !== policy.signer[index])))
        throw new Error("ticket signer does not match policy");

      const productId = ticket.claim.partialTicket.productId?.toLowerCase();
      if(policy.productIds.length > 0 && (!productId || !policy.productIds.includes(productId)))
        throw new Error("ticket product does not match policy");

      const eventId = ticket.claim.partialTicket.eventId?.toLowerCase();
      if(policy.eventIds.length > 0 && (!eventId || !policy.eventIds.includes(eventId)))
        throw new Error("ticket event does not match policy");

      const isValid = await this.zupassPCD.verifyTicket(ticket, admission);
      if(!isValid)
        throw new Error("ticket proof verification failed");

      return this.zupassPCD.getTicketData(ticket, policy);
    } finally {
      this.zupassPCD.releaseVerification(admission);
    }
  }

  private logAuthFailure(stage: string, error: unknown): void {
    ServiceManager.GetService(FaucetProcess).emitLog(
      FaucetLogLevel.WARNING,
      `Zupass ${stage} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  private checkGrant(
    grant: IZupassGrantConfig,
    perks: ZupassGrantPerks,
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
        renderTimespan(grant.duration)
      ].join("");
      throw new PublicFaucetError({
        code: "ZUPASS_LIMIT",
        message: errMsg,
      });
    }

    if(grant.limitAmount > 0) {
      let totalAmount = activeUsage.amount;
      finishedSessions.forEach((session) => totalAmount += BigInt(session.dropAmount));
      if(activeUsage.hasProvisionalAmount || totalAmount >= BigInt(grant.limitAmount)) {
        if(!grant.required)
          return;
        let errMsg = grant.message || (activeUsage.hasProvisionalAmount
          ? "Another request for this ticket holder is still being processed. Please try again."
          : [
            "You have already requested ",
            ServiceManager.GetService(EthWalletManager).readableAmount(totalAmount),
            " in the last ",
            renderTimespan(grant.duration)
          ].join(""));
        throw new PublicFaucetError({
          code: "ZUPASS_LIMIT",
          message: errMsg,
        });
      }
    }

    // apply perks
    if(grant.skipModules) {
      perks.skipModules = grant.skipModules
    }
    if(typeof grant.rewardFactor === "number") {
      perks.factor = grant.rewardFactor;
    }
    if(typeof grant.overrideMaxDrop !== "undefined") {
      perks.overrideMaxDrop = grant.overrideMaxDrop;
    }
  }

  private checkLimit(priorUsage: AdmissionUsage): void {
    if(this.moduleConfig.concurrencyLimit === 0)
      return;

    if(priorUsage.count >= this.moduleConfig.concurrencyLimit) {
      throw new PublicFaucetError({
        code: "ZUPASS_CONCURRENCY_LIMIT",
        message: "Only " + this.moduleConfig.concurrencyLimit + " concurrent sessions allowed per ticket holder",
      });
    }
  }

}
