import { WebSocketServer, WebSocket } from 'ws';
import { Socket } from "node:net";
import http from "node:http";
import stream from "node:stream";
import { PoWSession } from "./PoWSession.js";
import { IPoWConfig, PoWHashAlgo } from "./PoWConfig.js";
import { PoWValidator } from "./validator/PoWValidator.js";
import { PoWClient } from "./PoWClient.js";
import { ProcessLoadTracker } from "../../utils/ProcessLoadTracker.js";
import { createFaucetWebSocketServer } from "../../webserv/FaucetWebSocket.js";
import { PoWShareVerification } from "./PoWShareVerification.js";

export type PoWClientParams =
  | {a: PoWHashAlgo.SCRYPT; n: number; r: number; p: number; l: number}
  | {a: PoWHashAlgo.CRYPTONIGHT; c: number; v: number; h: number}
  | {a: PoWHashAlgo.ARGON2; t: number; v: number; i: number; m: number; p: number; l: number}
  | {a: PoWHashAlgo.NICKMINER; i: string; r: string; v: number; c: number; s: string; p: string};

interface IPoWConnectRequest {
  action: "pow-connect";
  sessionId: string;
  url: string;
  method: string;
  headers: {[key: string]: string};
  head: string;
}

export class PoWServerWorker {
  private serverSymbol = Symbol("pow-server-worker");
  private port: MessagePort;
  private server: http.Server;
  private wss: WebSocketServer;
  private moduleConfig: IPoWConfig;
  private validator: PoWValidator;
  private sessions: {[sessionId: string]: PoWSession} = {};
  private loadTracker: ProcessLoadTracker;
  private shutdownPromise: Promise<void>;

  public constructor(port: MessagePort) {
    if(port) {
      this.port = port;
      this.port.onmessage = (evt) => this.onMessage(evt.data, (evt as any).objs);
    } else if(process.send) {
      process.on("message", this.onMessage.bind(this));
    }

    this.server = http.createServer();
    this.server.on("upgrade", this.onPoWUpgrade.bind(this));

    this.wss = createFaucetWebSocketServer();
    this.wss.on("connection", this.onPoWConnection.bind(this));

    // start validator
    this.validator = new PoWValidator();

    // Initialize load tracking
    this.loadTracker = new ProcessLoadTracker((stats) => {
      setTimeout(() => {
        this.sendMessage({
          action: "pow-sysload",
          ...stats,
          activeSessions: this.getActiveClients().map(client => client.getPoWSession().getSessionId()),
        });
      }, 50);
    });

    this.sendMessage({ action: "init" });
  }

  public getModuleConfig(): IPoWConfig {
    return this.moduleConfig;
  }

  public getValidator(): PoWValidator {
    return this.validator;
  }

  private sendMessage(message: any, handle?: any) {
    //console.log("send", message);
    if(this.port) {
      this.port.postMessage(message);
    } else if(process.send) {
      process.send(message, handle);
    }
  }

  public sendSessionAbort(sessionId: string, type: string, reason: string, dirtyProps: {[key: string]: any}) {
    this.sendMessage({
      action: "pow-session-abort",
      sessionId: sessionId,
      type: type,
      reason: reason,
      dirtyProps: dirtyProps,
    });
  }

  public sendSessionReward(sessionId: string, reqId: number, amount: bigint, type: string, dirtyProps: {[key: string]: any}) {
    this.sendMessage({
      action: "pow-session-reward",
      sessionId: sessionId,
      reqId: reqId,
      amount: amount.toString(),
      type: type,
      dirtyProps: dirtyProps,
    });
  }

  public sendSessionFlush(sessionId: string, dirtyProps: {[key: string]: any}) {
    this.sendMessage({
      action: "pow-session-flush",
      sessionId: sessionId,
      dirtyProps: dirtyProps,
    });
  }

  private onMessage(message: any, handle?: any) {
    //console.log("recv", message);

    switch(message.action) {
      case "pow-shutdown":
        this.onPoWShutdown();
        break;
      case "pow-update-config":
        this.moduleConfig = message.config;
        break;
      case "pow-register-session":
        this.onPoWRegisterSession(message.sessionId, message.data);
        break;
      case "pow-destroy-session":
        this.onPoWDestroySession(message.sessionId, message.failed);
        break;
      case "pow-connect":
        this.onPoWConnect(message, handle);
        break;
      case "pow-session-close":
        void this.onPoWSessionClose(message.sessionId, message.info, message.closeId).catch((error) => {
          console.error("Could not acknowledge closed PoW session:", error);
        });
        break;
      case "pow-session-reward":
        try {
          if(!this.isIpcBigInt(message.amount) || !this.isIpcBigInt(message.balance))
            throw new Error("Invalid PoW reward acknowledgement");
          this.onPoWSessionReward(message.sessionId, message.reqId, BigInt(message.amount), BigInt(message.balance));
        }
        catch(error) {
          this.onPoWSessionRewardError(
            message.sessionId,
            message.reqId,
            error instanceof Error ? error.message : "Invalid PoW reward acknowledgement",
          );
        }
        break;
      case "pow-session-reward-error":
        this.onPoWSessionRewardError(message.sessionId, message.reqId, message.message);
        break;
    }
  }

  private onPoWRegisterSession(sessionId: string, data: any) {
    let session = new PoWSession(sessionId, this);
    data["pow.idleTime"] = Math.floor(new Date().getTime() / 1000);
    session.loadSessionData(data);
    this.sessions[sessionId] = session;
    this.resetSessionIdleTimer(session);
  }

  private onPoWDestroySession(sessionId: string, failed: boolean) {
    let session = this.sessions[sessionId];
    if(session) {
      let reason = failed ? "PoW session failed" : "PoW session closed";
      session.dispose(reason);
      this.validator.cancelSession(sessionId, reason);
      PoWShareVerification.cancelSession(this, sessionId, reason);
      if(session.activeClient) {
        session.activeClient.killClient(failed ? "session failed" : "session closed");
        session.activeClient = null;
      }
      this.clearSessionIdleTimer(session);
      delete this.sessions[sessionId];
    }
  }

  private async onPoWConnect(request: IPoWConnectRequest, socket: Socket) {
    const headBuffer = Buffer.from(request.head, 'base64');
    if(!socket) {
      console.error("PoWServerWorker: socket is null");
      return;
    }

    const fakeReq = new http.IncomingMessage(socket);
    fakeReq.headers = request.headers;
    fakeReq.url = request.url;
    fakeReq.method = request.method;
    fakeReq[this.serverSymbol] = request.sessionId;

    if((socket as any)._testWs) {
      // hack for unit tests
      let testWs = (socket as any)._testWs;
      this.wss.emit('connection', testWs, fakeReq);
      return;
    }
    
    socket.resume();
    this.server.emit('upgrade', fakeReq, socket, headBuffer);
  }

  private onPoWUpgrade(req: http.IncomingMessage, socket: stream.Duplex, head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }

  private onPoWConnection(ws: WebSocket, req: http.IncomingMessage) {
    let sessionId = req[this.serverSymbol];
    if(!sessionId) {
      ws.close();
      return;
    }

    let session = this.sessions[sessionId];
    if(!session) {
      ws.close();
      return;
    }
    
    if(session.activeClient) {
      session.activeClient.killClient("reconnected from another client");
      session.activeClient = null;
    }

    session.activeClient = new PoWClient(this, session, ws);
    this.resetSessionIdleTimer(session);
  }

  private async onPoWSessionClose(sessionId: string, info: any, closeId: unknown): Promise<void> {
    if(!Number.isSafeInteger(closeId))
      return;
    let session = this.sessions[sessionId];
    if(session)
      session.processSessionClose(info);
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.sendMessage({
      action: "pow-session-close-ack",
      sessionId,
      closeId,
    });
  }

  private onPoWSessionReward(sessionId: string, reqId: number, amount: bigint, balance: bigint) {
    let session = this.sessions[sessionId];
    if(session)
      session.processReward(reqId, amount, balance);
  }

  private onPoWSessionRewardError(sessionId: string, reqId: number, message: string): void {
    this.sessions[sessionId]?.processRewardError(reqId, message);
  }

  private isIpcBigInt(value: unknown): value is string {
    return typeof value === "string" && value.length <= 128 && /^-?\d+$/.test(value);
  }

  private onPoWShutdown(): Promise<void> {
    if(!this.shutdownPromise)
      this.shutdownPromise = this.shutdown();
    return this.shutdownPromise;
  }

  private async shutdown(): Promise<void> {
    let reason = "PoW server shutdown";
    let validatorTeardown = this.validator.dispose(reason);

    // flush all sessions
    for(let sessionId in this.sessions) {
      let session = this.sessions[sessionId];
      if(session.activeClient) {
        session.activeClient.killClient("server shutdown");
        session.activeClient = null;
      }
      this.clearSessionIdleTimer(session);

      let dirtyProps = session.getDirtyProps(true);
      if(Object.keys(dirtyProps).length > 0)
        this.sendSessionFlush(sessionId, dirtyProps);
      session.dispose(reason);
    }
    this.sessions = {};
    PoWShareVerification.cancelAll(this, reason);

    if (this.loadTracker) {
      this.loadTracker.stop();
    }

    this.wss.close();
    this.server.close();

    try {
      await validatorTeardown;
    }
    catch(error) {
      console.error("PoW validator teardown failed:", error);
    }

    if(this.port) {
      this.port.close();
    }
    else {
      setTimeout(() => {
        process.exit(0);
      }, 100);
    }
  }

  public getClientPoWParams(config: IPoWConfig = this.moduleConfig): PoWClientParams {
    switch(config.powHashAlgo) {
      case PoWHashAlgo.SCRYPT:
        return {
          a: PoWHashAlgo.SCRYPT,
          n: config.powScryptParams.cpuAndMemory,
          r: config.powScryptParams.blockSize,
          p: config.powScryptParams.parallelization,
          l: config.powScryptParams.keyLength,
        };
      case PoWHashAlgo.CRYPTONIGHT:
        return {
          a: PoWHashAlgo.CRYPTONIGHT,
          c: config.powCryptoNightParams.algo,
          v: config.powCryptoNightParams.variant,
          h: config.powCryptoNightParams.height,
        };
      case PoWHashAlgo.ARGON2:
        return {
          a: PoWHashAlgo.ARGON2,
          t: config.powArgon2Params.type,
          v: config.powArgon2Params.version,
          i: config.powArgon2Params.timeCost,
          m: config.powArgon2Params.memoryCost,
          p: config.powArgon2Params.parallelization,
          l: config.powArgon2Params.keyLength,
        };
      case PoWHashAlgo.NICKMINER:
        return {
          a: PoWHashAlgo.NICKMINER,
          i: config.powNickMinerParams.hash,
          r: config.powNickMinerParams.sigR,
          v: config.powNickMinerParams.sigV,
          c: config.powNickMinerParams.count,
          s: config.powNickMinerParams.suffix,
          p: config.powNickMinerParams.prefix,
        };
    }
  }

  public getPoWParamsStr(config: IPoWConfig = this.moduleConfig): string {
    let params = this.getClientPoWParams(config);
    switch(params.a) {
      case PoWHashAlgo.SCRYPT:
        return params.a + "|" + params.n + "|" + params.r + "|" + params.p + "|" + params.l + "|" + config.powDifficulty;
      case PoWHashAlgo.CRYPTONIGHT:
        return params.a + "|" + params.c + "|" + params.v + "|" + params.h + "|" + config.powDifficulty;
      case PoWHashAlgo.ARGON2:
        return params.a + "|" + params.t + "|" + params.v + "|" + params.i + "|" + params.m + "|" + params.p + "|" + params.l + "|" + config.powDifficulty;
      case PoWHashAlgo.NICKMINER:
        return params.a + "|" + params.i + "|" + params.r + "|" + params.v + "|" + params.c + "|" + params.s + "|" + params.p + "|" + config.powDifficulty;
    }
  }

  public getActiveClients(): PoWClient[] {
    let clients: PoWClient[] = [];
    for(let sessionId in this.sessions) {
      let session = this.sessions[sessionId];
      if(session.activeClient)
        clients.push(session.activeClient);
    }

    return clients;
  }

  public getPoWSession(sessionId: string): PoWSession {
    return this.sessions[sessionId];
  }

  public onClientDisconnected(session: PoWSession, client: PoWClient): void {
    if(this.sessions[session.getSessionId()] !== session || session.activeClient !== client)
      return;
    session.activeClient = null;
    this.resetSessionIdleTimer(session);
  }

  private resetSessionIdleTimer(session: PoWSession) {
    let hasActiveClient = !!session.activeClient;
    let idleTimer = session.idleTimer;

    if(hasActiveClient && idleTimer) {
      clearTimeout(idleTimer);
      session.idleTimer = null;
    }
    else if(!hasActiveClient && !idleTimer && session.idleTime && this.moduleConfig.powIdleTimeout) {
      let now = Math.floor(new Date().getTime() / 1000);
      let timeout = session.idleTime + this.moduleConfig.powIdleTimeout - now;
      if(timeout < 0)
        timeout = 0;
      session.idleTimer = setTimeout(() => {
        session.idleTimer = null;
        void session.closeSession("timeout").catch((error) => {
          console.error("Could not close idle PoW session:", error);
        });
      }, timeout * 1000);
    }
  }

  private clearSessionIdleTimer(session: PoWSession): void {
    if(!session.idleTimer)
      return;
    clearTimeout(session.idleTimer);
    session.idleTimer = null;
  }
}
