import { WebSocket, RawData } from 'ws';
import { PoWSession } from './PoWSession.js';
import { ServiceManager } from '../../common/ServiceManager.js';
import { PoWShareVerification } from './PoWShareVerification.js';
import { FaucetProcess, FaucetLogLevel } from '../../common/FaucetProcess.js';
import { PoWServerWorker } from './PoWServerWorker.js';
import { isValidReportedHashrate } from './PoWConfig.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeNonce(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export class PoWClient {
  private server: PoWServerWorker;
  private socket: WebSocket;
  private session: PoWSession;
  private pingTimer: NodeJS.Timeout = null;
  private lastPingPong: Date;

  public constructor(server: PoWServerWorker, session: PoWSession, socket: WebSocket) {
    this.server = server;
    this.session = session;
    this.socket = socket;
    this.lastPingPong = new Date();

    this.session.activeClient = this;

    this.socket.on("message", (data) => {
      void this.onClientMessage(data).catch((error) => this.onClientMessageError(error));
    });
    this.socket.on("ping", (data) => {
      this.lastPingPong = new Date();
      if(this.socket)
        this.socket.pong(data)
    });
    this.socket.on("pong", () => {
      this.lastPingPong = new Date();
    });
    this.socket.on("error", (err) => {
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.WARNING, "WebSocket error: " + err.toString());
      try {
        if(this.socket)
          this.socket.close();
      } catch(ex) {}
      this.dispose("client error");
    });
    this.socket.on("close", () => {
      this.dispose("client closed");
    });
    this.pingClientLoop();
  }

  public getPoWSession(): PoWSession {
    return this.session;
  }

  private dispose(reason: string) {
    if(!this.socket)
      return;
    this.socket = null;

    if(this.session)
      this.server.onClientDisconnected(this.session, this);

    if(this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  public killClient(reason?: string) {
    if(!this.socket)
      return;
    try {
      this.sendErrorResponse("CLIENT_KILLED", "Client killed: " + (reason || ""), null, FaucetLogLevel.HIDDEN);
      this.socket.close();
    } catch(ex) {}
    this.dispose(reason);
  }

  private pingClientLoop() {
    this.pingTimer = setInterval(() => {
      if(!this.socket)
        return;
      
      let pingpongTime = Math.floor(((new Date()).getTime() - this.lastPingPong.getTime()) / 1000);
      if(pingpongTime > this.server.getModuleConfig().powPingTimeout) {
        this.killClient("ping timeout");
        return;
      }
      
      this.socket.ping();
    }, this.server.getModuleConfig().powPingInterval * 1000);
  }

  public sendMessage(action: string, data?: any, rsp?: any) {
    if(!this.socket)
      return;
    
    let message: any = {
      action: action
    };
    if(data !== undefined)
      message.data = data;
    if(rsp !== undefined)
      message.rsp = rsp;
    
    this.socket.send(JSON.stringify(message));
  }

  private sendErrorResponse(errCode: string, errMessage: string, reqMsg?: any, logLevel?: FaucetLogLevel, data?: any) {
    if(!logLevel)
      logLevel = FaucetLogLevel.WARNING;
    let logReqMsg = reqMsg && logLevel !== FaucetLogLevel.INFO;
    //ServiceManager.GetService(FaucetProcess).emitLog(logLevel, "Returned error to client: [" + errCode + "] " + errMessage + (logReqMsg ? "\n    Message: " + JSON.stringify(reqMsg) : ""));
    
    let resObj: any = {
      code: errCode,
      message: errMessage
    };
    if(data)
      resObj.data = data;
    this.sendMessage("error", resObj, reqMsg ? reqMsg.id : undefined);
  }

  private async onClientMessage(data: RawData): Promise<void> {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch(ex) {
      this.killClient("invalid message: " + ex.toString());
      return;
    }
    if(!message || typeof message !== "object")
      return;

    switch(message.action) {
      case "foundShare":
        await this.onCliFoundShare(message);
        break;
      case "verifyResult":
        await this.onCliVerifyResult(message);
        break;
      case "closeSession":
        await this.onCliCloseSession(message);
        break;
      default:
        this.sendMessage("error", {
          code: "INVALID_ACTION",
          message: "Unknown action"
        }, message.id);
        break;
    }
  }

  private onClientMessageError(error: unknown): void {
    let message = error instanceof Error ? error.message : String(error);
    ServiceManager.GetService(FaucetProcess).emitLog(
      FaucetLogLevel.WARNING,
      "PoW client message handling failed: " + message,
    );
    this.killClient("message processing failed");
  }

  private onCliFoundShare(message: any) {
    let reqId = message.id ?? undefined;

    let rawShareData: unknown = message.data;
    if(!isObject(rawShareData))
      return this.sendErrorResponse("INVALID_SHARE", "Invalid share data", message);

    let moduleConfig = this.server.getModuleConfig();
    let shareData = rawShareData;
    let nonce = shareData.nonce;
    let shareResult = shareData.data;

    if(typeof shareData.params !== "string" || shareData.params !== this.server.getPoWParamsStr())
      return this.sendErrorResponse("INVALID_SHARE", "Invalid share params", message);

    if(!isSafeNonce(nonce))
      return this.sendErrorResponse("INVALID_SHARE", "Invalid nonce", message);
    if(shareResult !== undefined && typeof shareResult !== "string")
      return this.sendErrorResponse("INVALID_SHARE", "Invalid share result", message);

    let lastNonce = this.session.lastNonce;
    if(!isSafeNonce(lastNonce))
      return this.sendErrorResponse("INVALID_SHARE", "Invalid session nonce state", message);
    if(nonce <= lastNonce)
      return this.sendErrorResponse("INVALID_SHARE", "Nonce too low", message);

    if(moduleConfig.powHashrateHardLimit > 0) {
      let sessionAge = Math.max(0, Math.floor((new Date()).getTime() / 1000) - this.session.startTime);
      let nonceLimit = Math.min(Number.MAX_SAFE_INTEGER, Math.floor((sessionAge + 30) * moduleConfig.powHashrateHardLimit));
      if(nonce > nonceLimit)
        return this.sendErrorResponse("HASHRATE_LIMIT", "Nonce too high (did you evade the hashrate limit?) " + sessionAge + "/" + nonceLimit, message);
    }

    this.session.lastNonce = nonce;
    let reportedHashrate = shareData.hashrate;
    if(isValidReportedHashrate(reportedHashrate)) {
      let reportedHashrates = this.session.reportedHashrate;
      reportedHashrates.push(reportedHashrate);
      if(reportedHashrates.length > 5)
        reportedHashrates.shift();
      this.session.reportedHashrate = reportedHashrates;
    }
    this.session.missedVerifications = 0;

    let shareVerification = new PoWShareVerification(this.server, this.session, nonce, typeof shareResult === "string" ? shareResult : "");
    shareVerification.startVerification().then((result) => {
      if(!result.isValid)
        this.sendErrorResponse("WRONG_SHARE", "Share verification failed", message);
      else {
        if(reqId !== undefined)
          this.sendMessage("ok", null, reqId);
        
        this.session.shareCount++;
      }
    }, () => {
      if(this.session) {
        this.sendErrorResponse("VERIFY_FAILED", "Share verification unavailable", message);
      }
    });
  }
  
  private async onCliVerifyResult(message: any) {
    let rawVerifyResult: unknown = message.data;
    if(!isObject(rawVerifyResult))
      return this.sendErrorResponse("INVALID_VERIFYRESULT", "Invalid verification result data", message);

    let verifyRes = rawVerifyResult;

    if(
      typeof verifyRes.shareId !== "string" || !verifyRes.shareId ||
      typeof verifyRes.policyId !== "string" || !verifyRes.policyId ||
      typeof verifyRes.isValid !== "boolean"
    )
      return this.sendErrorResponse("INVALID_VERIFYRESULT", "Invalid verification result data", message);

    try {
      let appliedReward = await PoWShareVerification.processVerificationResult({
        shareId: verifyRes.shareId,
        verifierId: this.session.getSessionId(),
        policyId: verifyRes.policyId,
        isValid: verifyRes.isValid,
      });
      if(appliedReward > 0n) {
        this.sendMessage("updateBalance", {
          balance: this.session.getDropAmount().toString(),
          reason: "valid verification"
        });
      }
      this.sendMessage("ok", null, message.id);
    }
    catch(error) {
      ServiceManager.GetService(FaucetProcess).emitLog(
        FaucetLogLevel.WARNING,
        "PoW verification settlement failed: " + (error instanceof Error ? error.message : String(error)),
      );
      this.sendErrorResponse("VERIFY_FAILED", "Verification result could not be settled", message);
    }
  }

  private async onCliCloseSession(message: any) {
    let reqId = message.id || undefined;
    let sessionInfo = await this.session.closeSession("closed");
    this.sendMessage("ok", sessionInfo, reqId);
  }

}
