import { IncomingMessage } from "http";
import { createHash, timingSafeEqual } from "node:crypto";
import { faucetConfig } from "../config/FaucetConfig.js";
import { ServiceManager } from "../common/ServiceManager.js";
import { EthWalletManager } from "../eth/EthWalletManager.js";
import { FaucetStatus, IFaucetStatus } from "../services/FaucetStatus.js";
import { FaucetHttpResponse } from "./FaucetHttpServer.js";
import { SessionManager } from "../session/SessionManager.js";
import { FaucetSession, FaucetSessionStatus, FaucetSessionStoreData, FaucetSessionTask, IClientSessionInfo } from "../session/FaucetSession.js";
import { ModuleHookAction, ModuleManager } from "../modules/ModuleManager.js";
import { EthClaimManager } from "../eth/EthClaimManager.js";
import { buildFaucetStatus, buildQueueStatus, buildSessionStatus } from "./api/faucetStatus.js";
import { ISessionRewardFactor } from "../session/SessionRewardFactor.js";
import { getPublicClaimError, toClientFailure, toStoredClientFailure } from "./PublicErrors.js";
import { getTrustedClientIp } from "../utils/IPAddress.js";
import { FaucetError, PublicFaucetError } from "../common/FaucetError.js";

export interface IFaucetApiUrl {
  path: string[];
  query: {[key: string]: string|boolean};
}

export interface FaucetApiEndpointOptions {
  maxBodySize?: number | (() => number);
}

interface FaucetApiEndpoint {
  handler: (req: IncomingMessage, url: IFaucetApiUrl, body: Buffer) => Promise<any>;
  options: FaucetApiEndpointOptions;
}

export interface IClientFaucetConfig {
  faucetTitle: string;
  faucetStatus: IFaucetStatus[];
  faucetStatusHash: string;
  faucetHtml: string;
  faucetWallet: string;
  faucetDonation: string;
  faucetCoinSymbol: string;
  faucetCoinType: string;
  faucetCoinContract: string;
  faucetCoinDecimals: number;
  minClaim: number;
  maxClaim: number;
  sessionTimeout: number;
  ethTxExplorerLink: string;
  time: number;
  modules: {
    [module: string]: any;
  },
}

export interface IClientSessionStatus {
  session: string;
  status: string;
  start: number;
  tasks: FaucetSessionTask[];
  balance: string;
  target: string;
  claimIdx?: number;
  claimStatus?: string;
  claimBlock?: number;
  claimHash?: string;
  claimMessage?: string;
  failedCode?: string;
  failedReason?: string;
  details?: IClientSessionDetails;
}

export interface IClientSessionDetails {
  clientVersion?: string;
  closeTime?: number;
  proofOfWork?: {
    lastNonce?: number;
    hashrate?: number;
    idleTime?: number;
  };
  rewardFactors?: ISessionRewardFactor[];
  passportScore?: number;
  claim?: {
    index: number;
    status: string;
    time: number;
    hash?: string;
    nonce?: number;
    block?: number;
    fee?: string;
    error?: string;
  };
}

type StatusAccess =
  | { kind: "public" }
  | { kind: "admin" }
  | { kind: "denied" };


export const FAUCETSTATUS_CACHE_TIME = 10;
export const SESSION_API_BODY_LIMIT = 64 * 1024;

const BUILT_IN_BODY_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  startsession: SESSION_API_BODY_LIMIT,
  claimreward: SESSION_API_BODY_LIMIT,
});

export class FaucetWebApi {
  private apiEndpoints: {[endpoint: string]: FaucetApiEndpoint} = {};
  private cachedStatusData: {[key: string]: {
    time: number;
    data: any;
  }} = {};

  public async onApiRequest(req: IncomingMessage, body?: Buffer): Promise<any> {
    let apiUrl = this.parseApiUrl(req.url);
    if (!apiUrl || apiUrl.path.length !== 1)
      return new FaucetHttpResponse(404, "Not Found");
    switch (apiUrl.path[0].toLowerCase()) {
      case "getVersion".toLowerCase():
        return this.onGetVersion();
      case "getMaxReward".toLowerCase():
        return this.onGetMaxReward();
      case "getFaucetConfig".toLowerCase():
        return this.onGetFaucetConfig(apiUrl.query['cliver'] as string, apiUrl.query['session'] as string);
      case "startSession".toLowerCase():
        return this.onStartSession(req, body, apiUrl.query['cliver'] as string);
      case "getSession".toLowerCase():
        return this.onGetSession(apiUrl.query['session'] as string);
      case "claimReward".toLowerCase():
        return this.onClaimReward(req, body);
      case "getSessionStatus".toLowerCase():
        return this.onGetSessionStatus(apiUrl.query['session'] as string, apiUrl.query['details'] === "true");
      case "getQueueStatus".toLowerCase():
        return this.onGetQueueStatus();
      case "getFaucetStatus".toLowerCase():
        return this.onGetFaucetStatus(req);
      default:
        let endpoint = this.apiEndpoints[apiUrl.path[0].toLowerCase()];
        if(endpoint)
          return endpoint.handler(req, apiUrl, body);
    }
    return new FaucetHttpResponse(404, "Not Found");
  }

  public registerApiEndpoint(
    endpoint: string,
    handler: (req: IncomingMessage, url: IFaucetApiUrl, body: Buffer) => Promise<any>,
    options: FaucetApiEndpointOptions = {},
  ) {
    this.apiEndpoints[endpoint.toLowerCase()] = {handler, options};
  }

  public removeApiEndpoint(endpoint: string) {
    delete this.apiEndpoints[endpoint.toLowerCase()];
  }

  public getApiRequestBodyLimit(url: string): number | null {
    let apiUrl = this.parseApiUrl(url);
    let endpointName = apiUrl?.path[0]?.toLowerCase();
    if(!endpointName)
      return null;
    let endpoint = this.apiEndpoints[endpointName];
    let configuredLimit = endpoint?.options.maxBodySize;
    if(typeof configuredLimit === "function")
      configuredLimit = configuredLimit();
    if(typeof configuredLimit === "number" && Number.isSafeInteger(configuredLimit) && configuredLimit > 0)
      return configuredLimit;
    return BUILT_IN_BODY_LIMITS[endpointName] || null;
  }

  private parseApiUrl(url: string): IFaucetApiUrl {
    let urlMatch = /^\/api\/([^/?]+)(?:\?([^#]*))?$/.exec(url);
    if(!urlMatch)
      return null;
    let urlRes: IFaucetApiUrl = {
      path: urlMatch[1] && urlMatch[1].length > 0 ? urlMatch[1].split("/") : [],
      query: {}
    };
    if(urlMatch[2] && urlMatch[2].length > 0) {
      urlMatch[2].split("&").forEach((query) => {
        let parts = query.split("=", 2);
        urlRes.query[parts[0]] = (parts.length == 1) ? true : parts[1];
      });
    }
    return urlRes;
  }

  public getRemoteAddr(req: IncomingMessage): string {
    let remoteAddr = getTrustedClientIp(
      req.socket.remoteAddress,
      req.headers?.["x-forwarded-for"],
      faucetConfig.httpProxyCount,
    );
    if(!remoteAddr)
      throw new FaucetError("INVALID_REMOTE_IP", "Unable to determine a valid client IP address.");
    return remoteAddr;
  }

  private onGetVersion(): string {
    return faucetConfig.faucetVersion;
  }

  private onGetMaxReward(): number {
    return faucetConfig.maxDropAmount;
  }

  public getFaucetHomeHtml(): string {
    let ethWalletManager = ServiceManager.GetService(EthWalletManager);
    let faucetHtml = faucetConfig.faucetHomeHtml || "";
    faucetHtml = faucetHtml.replace(/{faucetWallet}/, () => {
      return ethWalletManager.getFaucetAddress();
    });
    return faucetHtml;
  }

  public async onGetFaucetConfig(clientVersion?: string, sessionId?: string): Promise<IClientFaucetConfig> {
    let faucetSession = sessionId ? ServiceManager.GetService(SessionManager).getSession(sessionId, [FaucetSessionStatus.RUNNING, FaucetSessionStatus.CLAIMABLE]) : null;
    let faucetStatus = ServiceManager.GetService(FaucetStatus).getFaucetStatus(clientVersion, faucetSession);
    let ethWalletManager = ServiceManager.GetService(EthWalletManager);
    
    let moduleConfig = {};
    await ServiceManager.GetService(ModuleManager).processActionHooks([], ModuleHookAction.ClientConfig, [moduleConfig, sessionId]);

    return {
      faucetTitle: faucetConfig.faucetTitle,
      faucetStatus: faucetStatus.status,
      faucetStatusHash: faucetStatus.hash,
      faucetHtml: this.getFaucetHomeHtml(),
      faucetWallet: ethWalletManager.getFaucetAddress(),
      faucetDonation: faucetConfig.faucetDonationAddress || null,
      faucetCoinSymbol: faucetConfig.faucetCoinSymbol,
      faucetCoinType: faucetConfig.faucetCoinType,
      faucetCoinContract: faucetConfig.faucetCoinContract,
      faucetCoinDecimals: ethWalletManager.getFaucetDecimals(),
      minClaim: faucetConfig.minDropAmount,
      maxClaim: faucetConfig.maxDropAmount,
      sessionTimeout: faucetConfig.sessionTimeout,
      ethTxExplorerLink: faucetConfig.ethTxExplorerLink,
      time: Math.floor((new Date()).getTime() / 1000),
      modules: moduleConfig,
    };
  }

  public async onStartSession(req: IncomingMessage, body: Buffer, clientVersion: string): Promise<any> {
    if(req.method !== "POST")
      return new FaucetHttpResponse(405, "Method Not Allowed", null, { "Allow": "POST" });
    
    let userInput = JSON.parse(body.toString("utf8"));
    let sessionInfo: IClientSessionInfo;
    let session: FaucetSession;
    try {
      const startBlocker = ServiceManager.GetService(FaucetStatus)
        .getFaucetStatus(clientVersion)
        .status.find((status) => status.blocksSessionStart);
      if(startBlocker) {
        throw new PublicFaucetError({
          code: "FAUCET_EMPTY",
          message: startBlocker.text,
        });
      }
      session = await ServiceManager.GetService(SessionManager).createSession(this.getRemoteAddr(req), userInput);
      if(session.getSessionStatus() === FaucetSessionStatus.FAILED) {
        const failure = toStoredClientFailure(session.getSessionData("failed.code"));
        return {
          status: FaucetSessionStatus.FAILED,
          ...failure,
          balance: session.getDropAmount().toString(),
          target: session.getTargetAddr(),
        }
      }

      if(clientVersion)
        session.setSessionData("cliver", clientVersion);

      sessionInfo = await session.getSessionInfo();
    } catch(ex) {
      return {
        status: FaucetSessionStatus.FAILED,
        ...toClientFailure(ex, "while starting a faucet session", true),
      };
    }
    
    return sessionInfo;
  }

  public async onGetSession(sessionId: string): Promise<any> {
    let session: FaucetSession;
    if(!sessionId || !(session = ServiceManager.GetService(SessionManager).getSession(sessionId, [FaucetSessionStatus.RUNNING]))) {
      return {
        status: "unknown",
        error: "Session not found"
      };
    }

    let sessionInfo: IClientSessionInfo;
    try {
      sessionInfo = await session.getSessionInfo();
    } catch(ex) {
      return {
        status: FaucetSessionStatus.FAILED,
        ...toClientFailure(ex, "while loading a faucet session"),
      };
    }

    return sessionInfo;
  }

  public async onClaimReward(req: IncomingMessage, body: Buffer): Promise<any> {
    if(req.method !== "POST")
      return new FaucetHttpResponse(405, "Method Not Allowed", null, { "Allow": "POST" });
    
    let userInput = JSON.parse(body.toString("utf8"));
    let sessionData: FaucetSessionStoreData;
    if(!userInput || !userInput.session || !(sessionData = await ServiceManager.GetService(SessionManager).getSessionData(userInput.session))) {
      return {
        status: FaucetSessionStatus.FAILED,
        failedCode: "INVALID_SESSION",
        failedReason: "Session not found.",
      }
    }
    
    try {
      await ServiceManager.GetService(EthClaimManager).createSessionClaim(sessionData, userInput);
    } catch(ex) {
      return {
        status: FaucetSessionStatus.FAILED,
        ...toClientFailure(ex, "while creating a faucet claim"),
      }
    }

    return this.getSessionStatus(sessionData, false);
  }

  private getSessionStatus(sessionData: FaucetSessionStoreData, details: boolean): IClientSessionStatus {
    let sessionStatus: IClientSessionStatus = {
      session: sessionData.sessionId,
      status: sessionData.status,
      start: sessionData.startTime,
      tasks: sessionData.tasks,
      balance: sessionData.dropAmount,
      target: sessionData.targetAddr,
    };
    if(sessionData.status === FaucetSessionStatus.FAILED && sessionData.data) {
      const failure = toStoredClientFailure(sessionData.data['failed.code']);
      sessionStatus.failedCode = failure.failedCode;
      sessionStatus.failedReason = failure.failedReason;
    }
    if(sessionData.claim) {
      sessionStatus.claimIdx = sessionData.claim.claimIdx;
      sessionStatus.claimStatus = sessionData.claim.claimStatus;
      sessionStatus.claimBlock = sessionData.claim.txBlock;
      sessionStatus.claimHash = sessionData.claim.txHash;
      sessionStatus.claimMessage = getPublicClaimError(sessionData.claim.claimStatus);
    }
    if(details) {
      sessionStatus.details = this.buildPublicSessionDetails(sessionData);
    }

    return sessionStatus;
  }

  private buildPublicSessionDetails(sessionData: FaucetSessionStoreData): IClientSessionDetails {
    const data = sessionData.data || {};
    const proofOfWork = {
      lastNonce: this.getFiniteNumber(data["pow.lastNonce"]),
      hashrate: this.getFiniteNumber(data["pow.hashrate"]),
      idleTime: this.getFiniteNumber(data["pow.idleTime"]),
    };
    const rewardFactors = Array.isArray(data["reward.factors"])
      ? data["reward.factors"].filter((factor: unknown): factor is ISessionRewardFactor => {
          if(!factor || typeof factor !== "object")
            return false;
          const candidate = factor as Partial<ISessionRewardFactor>;
          return typeof candidate.factor === "number" && Number.isFinite(candidate.factor) &&
            typeof candidate.module === "string" &&
            (candidate.name === undefined || typeof candidate.name === "string");
        }).map((factor: ISessionRewardFactor) => ({
          factor: factor.factor,
          module: factor.module,
          ...(factor.name === undefined ? {} : { name: factor.name }),
        }))
      : undefined;
    const claim = sessionData.claim ? {
      index: sessionData.claim.claimIdx,
      status: sessionData.claim.claimStatus,
      time: sessionData.claim.claimTime,
      hash: this.getString(sessionData.claim.txHash),
      nonce: this.getFiniteNumber(sessionData.claim.txNonce),
      block: this.getFiniteNumber(sessionData.claim.txBlock),
      fee: this.getString(sessionData.claim.txFee),
      error: getPublicClaimError(sessionData.claim.claimStatus),
    } : undefined;

    return {
      clientVersion: this.getString(data["cliver"]),
      closeTime: this.getFiniteNumber(data["close.time"]),
      proofOfWork: Object.values(proofOfWork).some((value) => value !== undefined) ? proofOfWork : undefined,
      rewardFactors,
      passportScore: this.getPassportScore(data["passport.score"]),
      claim,
    };
  }

  private getPassportScore(value: unknown): number | undefined {
    const legacyScore = this.getFiniteNumber(value);
    if(legacyScore !== undefined)
      return legacyScore;
    if(value === null || typeof value !== "object" || !("score" in value))
      return undefined;
    return this.getFiniteNumber(value.score);
  }

  private getFiniteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  private getString(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
  }

  public async onGetSessionStatus(sessionId: string, details: boolean): Promise<any> {
    let sessionData: FaucetSessionStoreData;
    if(!sessionId || !(sessionData = await ServiceManager.GetService(SessionManager).getSessionData(sessionId)))
      return new FaucetHttpResponse(404, "Session not found");
    
    return this.getSessionStatus(sessionData, details);
  }

  public async onGetQueueStatus(): Promise<any> {
    let now = Math.floor(new Date().getTime() / 1000);
    let cachedRsp, cacheKey = "queue";
    if(!(cachedRsp = this.cachedStatusData[cacheKey]) || cachedRsp.time < now - FAUCETSTATUS_CACHE_TIME) {
      cachedRsp = this.cachedStatusData[cacheKey] = {
        time: now,
        data: buildQueueStatus(),
      };
    }
    return cachedRsp.data;
  }

  public async onGetFaucetStatus(req: IncomingMessage): Promise<FaucetHttpResponse> {
    const access = this.getStatusAccess(req);
    if(access.kind === "denied")
      return new FaucetHttpResponse(403, "Access denied", null, { "Cache-Control": "no-store" });

    let data: object;
    if(access.kind === "admin") {
      data = Object.assign(
        await buildFaucetStatus(),
        buildQueueStatus(true),
        await buildSessionStatus(true)
      );
    } else {
      let now = Math.floor(new Date().getTime() / 1000);
      let cachedRsp, cacheKey = "faucet";
      if(!(cachedRsp = this.cachedStatusData[cacheKey]) || cachedRsp.time < now - FAUCETSTATUS_CACHE_TIME) {
        cachedRsp = this.cachedStatusData[cacheKey] = {
          time: now,
          data: Object.assign(
            await buildFaucetStatus(),
            buildQueueStatus(),
            await buildSessionStatus()
          ),
        };
      }
      data = cachedRsp.data;
    }

    return new FaucetHttpResponse(200, "OK", JSON.stringify(data), {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    });
  }

  private getStatusAccess(req: IncomingMessage): StatusAccess {
    const authorization = req.headers.authorization;
    if(authorization === undefined)
      return { kind: "public" };
    if(typeof authorization !== "string" || !faucetConfig.statusAdminToken)
      return { kind: "denied" };

    const bearerMatch = /^Bearer ([^\s]+)$/i.exec(authorization);
    if(!bearerMatch || !this.constantTimeEqual(bearerMatch[1], faucetConfig.statusAdminToken))
      return { kind: "denied" };
    return { kind: "admin" };
  }

  private constantTimeEqual(value: string, expected: string): boolean {
    const valueDigest = createHash("sha256").update(value).digest();
    const expectedDigest = createHash("sha256").update(expected).digest();
    return timingSafeEqual(valueDigest, expectedDigest);
  }



}
