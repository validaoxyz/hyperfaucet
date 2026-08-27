import * as fs from 'fs';
import * as path from 'path';
import * as stream from 'node:stream';
import { createServer, IncomingMessage, Server as HttpServer, ServerResponse } from 'http';
import { Server as StaticServer } from '@brettz9/node-static';
import { WebSocket, WebSocketServer } from 'ws';
import { faucetConfig } from '../config/FaucetConfig.js';
import { encode } from 'html-entities';
import { OutgoingHttpHeaders } from 'http2';
import { FaucetWebApi } from './FaucetWebApi.js';
import { ServiceManager } from '../common/ServiceManager.js';
import { FaucetProcess, FaucetLogLevel } from '../common/FaucetProcess.js';
import { Socket } from 'node:net';
import { logUnexpectedWebError, PUBLIC_INTERNAL_ERROR_MESSAGE } from './PublicErrors.js';
import { createFaucetWebSocketServer, FAUCET_WEBSOCKET_MAX_PAYLOAD } from './FaucetWebSocket.js';

export { createFaucetWebSocketServer, FAUCET_WEBSOCKET_MAX_PAYLOAD };

export class FaucetHttpResponse {
  public readonly code: number;
  public readonly reason: string;
  public readonly body: string;
  public readonly headers: OutgoingHttpHeaders;

  public constructor(code: number, reason: string, body?: string, headers?: OutgoingHttpHeaders) {
    this.code = code;
    this.reason = reason;
    this.body = body;
    this.headers = headers || {};
  }
}

export interface FaucetWssEndpoint {
  pattern: RegExp;
  wssHandler?: (req: IncomingMessage, ws: WebSocket, remoteIp: string) => void;
  rawHandler?: (req: IncomingMessage, socket: stream.Duplex, head: Buffer, remoteIp: string) => void;
}

const MAX_BODY_SIZE = 1024 * 1024 * 10; // 10MB

type HttpRequestState = "receiving" | "routed" | "rejected" | "aborted" | "failed";

const ALLOWED_HTTP_METHODS = "GET, HEAD, POST, OPTIONS";
const STATUS_API_PATTERN = /^\/api\/(?:getSessionStatus|getQueueStatus|getFaucetStatus)(?:\?[^#]*)?$/i;
const BASE_RESPONSE_HEADERS: Readonly<OutgoingHttpHeaders> = Object.freeze({
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

export class FaucetHttpServer {
  private initialized: boolean;
  private httpServer: HttpServer;
  private wssServer: WebSocketServer;
  private wssEndpoints: {[key: string]: FaucetWssEndpoint} = {};
  private staticServer: StaticServer;
  private cachedSeoIndex: string;
  private readonly reloadHandler = () => this.buildSeoIndex();

  public initialize() {
    if(this.initialized)
      return;
    this.initialized = true;

    this.httpServer = createServer();
    this.httpServer.on("request", (req, rsp) => this.onHttpRequest(req, rsp));
    this.httpServer.on("upgrade", (req, sock, head) => this.onHttpUpgrade(req, sock as Socket, head));
    this.httpServer.listen(faucetConfig.serverPort);

    this.wssServer = createFaucetWebSocketServer();

    this.staticServer = new StaticServer(faucetConfig.staticPath, {
      serverInfo: Buffer.from("pow-faucet/" + faucetConfig.faucetVersion)
    });

    if(faucetConfig.buildSeoIndex) {
      this.buildSeoIndex();
      ServiceManager.GetService(FaucetProcess).addListener("reload", this.reloadHandler);
    }
  }

  public getListenPort(): number {
    let addr = this.httpServer.address();
    if(typeof addr === "object")
      return addr.port;
    else
      return faucetConfig.serverPort;
  }

  public async dispose(): Promise<void> {
    if(!this.initialized)
      return;
    this.initialized = false;

    ServiceManager.GetService(FaucetProcess).removeListener("reload", this.reloadHandler);
    let closeHttpServer = !this.httpServer?.listening
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          this.httpServer.close((error) => error ? reject(error) : resolve());
        });
    for(let client of this.wssServer.clients)
      client.terminate();
    let closeWebSocketServer = new Promise<void>((resolve, reject) => {
      this.wssServer.close((error) => error ? reject(error) : resolve());
    });
    await Promise.all([closeHttpServer, closeWebSocketServer]);
  }

  public addWssEndpoint(key: string, pattern: RegExp, wssHandler: (req: IncomingMessage, ws: WebSocket, remoteIp: string) => void) {
    this.wssEndpoints[key] = {
      pattern: pattern,
      wssHandler: wssHandler,
    };
  }

  public addRawEndpoint(key: string, pattern: RegExp, rawHandler: (req: IncomingMessage, socket: Socket, head: Buffer, remoteIp: string) => void) {
    this.wssEndpoints[key] = {
      pattern: pattern,
      rawHandler: rawHandler
    };
  }

  public removeWssEndpoint(key: string) {
    delete this.wssEndpoints[key];
  }

  private onHttpRequest(req: IncomingMessage, rsp: ServerResponse) {
    const bodyParts: Buffer[] = [];
    let bodySize = 0;
    let requestState: HttpRequestState = "receiving";
    const finishRequest = (nextState: Exclude<HttpRequestState, "receiving">, action?: () => void): boolean => {
      if(requestState !== "receiving")
        return false;
      requestState = nextState;
      bodyParts.length = 0;
      bodySize = 0;
      action?.();
      return true;
    };
    const onTransportError = (context: string, error: unknown) => {
      const expectedPeerReset = this.isExpectedPeerReset(error);
      finishRequest(expectedPeerReset ? "aborted" : "failed");
      if(!expectedPeerReset)
        logUnexpectedWebError(context, error);
    };
    const rejectRequest = (code: number, reason: string, headers: OutgoingHttpHeaders = {}) => {
      finishRequest("rejected", () => this.sendResponse(req, rsp, code, reason, headers, null));
    };
    req.on("aborted", () => finishRequest("aborted"));
    req.on("error", (error) => onTransportError("while receiving an HTTP request", error));
    rsp.on("error", (error) => onTransportError("while writing an HTTP response", error));

    if(!this.isAllowedHttpMethod(req.method)) {
      rejectRequest(405, "Method Not Allowed", { "Allow": ALLOWED_HTTP_METHODS });
      req.resume();
      return;
    }

    if(req.method === "POST" && !this.isApiRequest(req.url)) {
      rejectRequest(405, "Method Not Allowed", { "Allow": "GET, HEAD, OPTIONS" });
      req.resume();
      return;
    }

    if(req.method !== "POST") {
      req.resume();
      finishRequest("routed", () => this.routeHttpRequest(req, rsp, null));
      return;
    }

    const endpointLimit = ServiceManager.GetService(FaucetWebApi).getApiRequestBodyLimit(req.url);
    const maxBodySize = endpointLimit || MAX_BODY_SIZE;
    const contentLength = this.getContentLength(req);
    if(contentLength !== null && contentLength > maxBodySize) {
      rejectRequest(413, "Payload Too Large");
      req.resume();
      return;
    }

    req.on("data", (chunk: Buffer) => {
      if(requestState !== "receiving")
        return;
      bodySize += chunk.length;
      if(bodySize > maxBodySize) {
        rejectRequest(413, "Payload Too Large");
        return;
      }
      bodyParts.push(chunk);
    });
    req.on("end", () => {
      if(requestState !== "receiving")
        return;
      const body = Buffer.concat(bodyParts, bodySize);
      finishRequest("routed", () => this.routeHttpRequest(req, rsp, body));
    });
    req.resume();
  }

  private isExpectedPeerReset(error: unknown): boolean {
    if(!error || typeof error !== "object")
      return false;
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ECONNRESET" || code === "EPIPE";
  }

  private getContentLength(req: IncomingMessage): number | null {
    let value = req.headers["content-length"];
    if(typeof value !== "string" || !/^\d+$/.test(value))
      return null;
    let length = Number(value);
    return Number.isSafeInteger(length) ? length : null;
  }

  private isAllowedHttpMethod(method: string): boolean {
    return method === "GET" || method === "HEAD" || method === "POST" || method === "OPTIONS";
  }

  private isApiRequest(url: string): boolean {
    return /^\/api\//i.test(url || "");
  }

  private routeHttpRequest(req: IncomingMessage, rsp: ServerResponse, body: Buffer): void {
    if(this.isApiRequest(req.url)) {
      if(req.method === "OPTIONS") {
        this.sendResponse(req, rsp, 200, "OK", {}, null);
        return;
      }

      ServiceManager.GetService(FaucetWebApi).onApiRequest(req, body).then((res: object) => {
        if(res && typeof res === "object" && res instanceof FaucetHttpResponse)
          this.sendResponse(req, rsp, res.code, res.reason, res.headers, res.body);
        else
          this.sendResponse(req, rsp, 200, "OK", {'Content-Type': 'application/json'}, JSON.stringify(res));
      }).catch((error) => {
        if(error && typeof error === "object" && error instanceof FaucetHttpResponse) {
          this.sendResponse(req, rsp, error.code, error.reason, error.headers, error.body);
          return;
        }
        logUnexpectedWebError("while handling an HTTP API request", error);
        this.sendResponse(req, rsp, 500, "Internal Server Error", {}, PUBLIC_INTERNAL_ERROR_MESSAGE);
      });
      return;
    }

    if(req.method === "OPTIONS") {
      this.sendResponse(req, rsp, 200, "OK", {}, null);
      return;
    }
    const staticResponse = this.createStaticResponse(req, rsp);
    switch(req.url) {
      case "/":
      case "/index.html":
        if(faucetConfig.buildSeoIndex && this.cachedSeoIndex)
          this.sendResponse(req, rsp, 200, "OK", {'Content-Type': 'text/html'}, this.cachedSeoIndex);
        else
          this.staticServer.serveFile("/index.html", 200, this.getResponseHeaders(req), req, staticResponse);
        break;
      default:
        let pathname: string;
        try {
          pathname = decodeURI(new URL(req.url, 'http://localhost').pathname);
        } catch {
          this.sendResponse(req, rsp, 400, "Bad Request", {}, "");
          return;
        }
        this.staticServer.servePath(pathname, 200, this.getResponseHeaders(req), req, staticResponse, (status, headers) => {
          if(!this.isResponseClosed(req, rsp) && !rsp.headersSent) {
            rsp.writeHead(status, this.getResponseHeaders(req, headers));
            rsp.end();
          }
        });
        break;
    }
  }

  private createStaticResponse(req: IncomingMessage, rsp: ServerResponse): ServerResponse {
    return new Proxy(rsp, {
      get: (target, property) => {
        if(property === "writeHead") {
          return (...args: unknown[]) => this.isResponseClosed(req, target)
            ? target
            : Reflect.apply(target.writeHead, target, args);
        }
        if(property === "write") {
          return (...args: unknown[]) => this.isResponseClosed(req, target)
            ? true
            : Reflect.apply(target.write, target, args);
        }
        if(property === "end") {
          return (...args: unknown[]) => this.isResponseClosed(req, target)
            ? target
            : Reflect.apply(target.end, target, args);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  private isResponseClosed(req: IncomingMessage, rsp: ServerResponse): boolean {
    return req.aborted
      || rsp.closed
      || rsp.destroyed
      || rsp.writableEnded
      || rsp.socket?.destroyed === true;
  }

  private sendResponse(req: IncomingMessage, rsp: ServerResponse, code: number, reason: string, headers: OutgoingHttpHeaders, body: string) {
    if(this.isResponseClosed(req, rsp))
      return;
    rsp.writeHead(code, reason, this.getResponseHeaders(req, headers));
    rsp.end(req.method === "HEAD" ? null : body);
  }

  private getResponseHeaders(req: IncomingMessage, headers: OutgoingHttpHeaders = {}): OutgoingHttpHeaders {
    const privacyHeaders = STATUS_API_PATTERN.test(req.url || "")
      ? { "Cache-Control": "no-store" }
      : {};
    return Object.assign({}, BASE_RESPONSE_HEADERS, headers, privacyHeaders, this.getCorsHeaders(req));
  }

  private getCorsHeaders(req: IncomingMessage): OutgoingHttpHeaders {
    let headers: OutgoingHttpHeaders = {};
    let corsAllowOrigin = faucetConfig.corsAllowOrigin || [];
    if(corsAllowOrigin.length > 0) {
      let rspAllowOrigin: string;
      for(let i = 0; i < corsAllowOrigin.length; i++) {
        let allowOrigin = corsAllowOrigin[i];
        if(allowOrigin == "*" || allowOrigin == req.headers.origin) {
          rspAllowOrigin = allowOrigin;
          break;
        }
      }

      if(rspAllowOrigin) {
        headers["Access-Control-Allow-Origin"] = rspAllowOrigin;
        headers["Access-Control-Allow-Methods"] = "GET, HEAD, POST";
        headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
      }
    }

    return headers;
  }

  private onHttpUpgrade(req: IncomingMessage, socket: Socket, head: Buffer) {
    let wssEndpoint: FaucetWssEndpoint;
    let allEndpoints = Object.values(this.wssEndpoints);
    for(let i = 0; i < allEndpoints.length; i++) {
      if(allEndpoints[i].pattern.test(req.url)) {
        wssEndpoint = allEndpoints[i];
        break;
      }
    }
    if(!wssEndpoint) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    let remoteAddr: string;
    try {
      remoteAddr = ServiceManager.GetService(FaucetWebApi).getRemoteAddr(req);
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    if(wssEndpoint.wssHandler) {
      this.wssServer.handleUpgrade(req, socket, head, (ws) => {
        ws.on("error", () => {});
        wssEndpoint.wssHandler(req, ws, remoteAddr);
      });
    } else if(wssEndpoint.rawHandler) {
      wssEndpoint.rawHandler(req, socket, head, remoteAddr);
    } else {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
    }
  }

  private buildSeoIndex() {
    let indexFile = path.join(faucetConfig.staticPath, "index.html");
    if(!fs.existsSync(indexFile))
      return;
    
    let clientVersion: {version: string, build: number};
    try {
      let clientFile = path.join(faucetConfig.staticPath, "js", "powfaucet.js");
      let clientSrc = fs.readFileSync(clientFile, "utf8");
      let match = /@pow-faucet-client: ({[^}]+})/.exec(clientSrc);
      if(match)
        clientVersion = JSON.parse(match[1]);
    } catch(ex) {}

    let indexHtml = fs.readFileSync(indexFile, "utf8");
    let seoMeta = "";
    if(faucetConfig.buildSeoMeta) {
      seoMeta = Object.keys(faucetConfig.buildSeoMeta).filter((metaName) => faucetConfig.buildSeoMeta.hasOwnProperty(metaName)).map((metaName) => {
        return '<meta name="' + metaName + '" content="' + faucetConfig.buildSeoMeta[metaName] + '">';
      }).join("");
    }

    indexHtml = indexHtml.replace(/<title>.*?<\/title>/, '<title>' + encode(faucetConfig.faucetTitle) + '</title>');
    indexHtml = indexHtml.replace(/<!-- pow-faucet-header -->/, seoMeta);
    
    if(clientVersion) {
      indexHtml = indexHtml.replace(/"\/js\/powfaucet\.js"/, '"/js/powfaucet.js?' + clientVersion.build + '"');
      indexHtml = indexHtml.replace(/"\/css\/powfaucet\.css"/, '"/css/powfaucet.css?' + clientVersion.build + '"');
    }

    this.cachedSeoIndex = indexHtml;
    try {
      let seoFile = path.join(faucetConfig.staticPath, "index.seo.html");
      fs.writeFileSync(seoFile, indexHtml);
    } catch(ex) {
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.WARNING, "Could not write seo index to disk, because static folder is not writable. Serving seo index from memory.");
    }
  }
}
