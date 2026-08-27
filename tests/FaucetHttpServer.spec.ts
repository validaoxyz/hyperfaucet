import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocket } from 'ws';
import { bindTestStubs, loadDefaultTestConfig, returnDelayedPromise, unbindTestStubs } from './common.js';
import { ServiceManager } from '../src/common/ServiceManager.js';
import { FaucetWebApi, SESSION_API_BODY_LIMIT } from '../src/webserv/FaucetWebApi.js';
import { IncomingHttpHeaders, IncomingMessage, request as httpRequest, ServerResponse } from 'http';
import { errorMonitor, once } from 'node:events';
import { connect as connectSocket } from 'node:net';
import { MessageChannel } from 'node:worker_threads';
import { PromiseDfd } from '../src/utils/PromiseDfd.js';
import { FaucetDatabase } from '../src/db/FaucetDatabase.js';
import { ModuleManager } from '../src/modules/ModuleManager.js';
import { faucetConfig, resolveRelativePath } from '../src/config/FaucetConfig.js';
import { FAUCET_WEBSOCKET_MAX_PAYLOAD, FaucetHttpResponse, FaucetHttpServer } from '../src/webserv/FaucetHttpServer.js';
import { EthClaimManager } from '../src/eth/EthClaimManager.js';
import { sha256 } from '../src/utils/CryptoUtils.js';
import { FaucetProcess } from '../src/common/FaucetProcess.js';
import { FetchUtil } from '../src/utils/FetchUtil.js';
import { PUBLIC_INTERNAL_ERROR_MESSAGE } from '../src/webserv/PublicErrors.js';
import { PoWServerWorker } from '../src/modules/pow/PoWServerWorker.js';

interface ResetRequestResult {
  request: IncomingMessage;
  error: NodeJS.ErrnoException | null;
  responseStatus: number;
}

function withTimeout<T>(promise: Promise<T>, errorMessage: string): Promise<T> {
  let timer!: NodeJS.Timeout;
  let timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(errorMessage)), 1000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function resetIncompleteRequest(
  webServer: FaucetHttpServer,
  rawRequest: string,
  observeResetError = true,
): Promise<ResetRequestResult> {
  let request!: IncomingMessage;
  let serverResponse!: ServerResponse;
  let bodyStarted = new PromiseDfd<void>();
  let requestAborted = new PromiseDfd<void>();
  let requestError = new PromiseDfd<NodeJS.ErrnoException>();
  (webServer as any).httpServer.once("request", (incomingRequest: IncomingMessage, response: ServerResponse) => {
    request = incomingRequest;
    serverResponse = response;
    request.once("data", () => bodyStarted.resolve());
    request.once("aborted", () => requestAborted.resolve());
    request.once(errorMonitor, (error: NodeJS.ErrnoException) => requestError.resolve(error));
  });

  let socket = connectSocket({
    host: "127.0.0.1",
    port: webServer.getListenPort(),
  });
  await once(socket, "connect");
  socket.resume();
  socket.write(rawRequest);
  await withTimeout(bodyStarted.promise, "request body was not received");
  let responseStatus = serverResponse.statusCode;

  if(socket.destroyed)
    throw new Error("client socket closed before reset");
  let socketClosed = once(socket, "close");
  socket.resetAndDestroy();
  try {
    await socketClosed;
  } catch(error) {
    if((error as NodeJS.ErrnoException).code !== "ECONNRESET")
      throw error;
  }

  let error: NodeJS.ErrnoException | null = null;
  if(observeResetError) {
    error = await withTimeout(
      Promise.all([requestAborted.promise, requestError.promise]).then(([, observedError]) => observedError),
      "request reset was not observed for " + rawRequest.split("\r\n", 1)[0],
    );
  }
  return {request, error, responseStatus};
}

describe("Faucet Web Server", () => {
  let globalStubs;

  beforeEach(async () => {
    globalStubs = bindTestStubs({});
    loadDefaultTestConfig();
    await ServiceManager.GetService(FaucetDatabase).initialize();
    await ServiceManager.GetService(ModuleManager).initialize();
  });
  afterEach(async () => {
    let dbService = ServiceManager.GetService(FaucetDatabase);
    await ServiceManager.DisposeAllServices();
    await dbService.closeDatabase();
    await unbindTestStubs(globalStubs);
  });

  it("generate SEO index.html", async () => {
    faucetConfig.faucetTitle = "test_title_" + Math.floor(Math.random() * 99999999).toString();
    faucetConfig.faucetHomeHtml = '<section data-pre-mount-content>Rendered before React</section>';
    faucetConfig.buildSeoIndex = true;
    faucetConfig.serverPort = 0;

    let clientFile = path.join(faucetConfig.staticPath, "js", "powfaucet.js");
    let oldClientFile;
    if(!fs.existsSync(path.join(faucetConfig.staticPath, "js")))
      fs.mkdirSync(path.join(faucetConfig.staticPath, "js"));
    if(fs.existsSync(clientFile)) {
      oldClientFile = fs.readFileSync(clientFile, "utf8");
    }
    fs.writeFileSync(clientFile, '/* @pow-faucet-client: {"version":"0.0.0","build":1337} */');

    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    webServer.initialize();
    let seoFile = path.join(faucetConfig.staticPath, "index.seo.html");
    expect(fs.existsSync(seoFile), "seo file not found");
    let seoContent = fs.readFileSync(seoFile, "utf8");
    expect(seoContent).contains(faucetConfig.faucetTitle, "uncustomized seo index");
    expect(seoContent).not.contains("class=\"faucet-wordmark\"", "seo shell should not render the app masthead before React mounts");
    expect(seoContent).not.contains("data-pre-mount-content", "seo shell should not render app content before React mounts");

    // drop & check re-generation after config refresh
    fs.unlinkSync(seoFile);
    ServiceManager.GetService(FaucetProcess).emit("reload");
    expect(fs.existsSync(seoFile), "seo file not found after refresh");

    if(oldClientFile) {
      fs.writeFileSync(clientFile, oldClientFile);
    }
  });

  it("check basic http call", async () => {
    faucetConfig.faucetTitle = "test_title_" + Math.floor(Math.random() * 99999999).toString();
    faucetConfig.buildSeoMeta = {
      "test1": "1234567890"
    };
    faucetConfig.buildSeoIndex = true;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    let listenPort = webServer.getListenPort();
    let indexData = await FetchUtil.fetch("http://localhost:" + listenPort, {method: "GET"}).then((rsp) => rsp.text());
    expect(indexData).contains(faucetConfig.faucetTitle, "not index contents");
  });

  it("sets baseline security headers on static and API responses", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    let listenPort = webServer.getListenPort();

    for(const requestPath of ["/", "/api/getVersion"]) {
      const response = await FetchUtil.fetch("http://localhost:" + listenPort + requestPath, { method: "GET" });
      expect(response.headers.get("content-security-policy")).equals("frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
      expect(response.headers.get("permissions-policy")).equals("camera=(), microphone=(), geolocation=(), payment=(), usb=()");
      expect(response.headers.get("referrer-policy")).equals("no-referrer");
      expect(response.headers.get("x-content-type-options")).equals("nosniff");
      expect(response.headers.get("x-frame-options")).equals("DENY");
    }
  });

  it("check basic http call (without SEO index)", async () => {
    faucetConfig.faucetTitle = "test_title_" + Math.floor(Math.random() * 99999999).toString();
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let seoFile = path.join(faucetConfig.staticPath, "index.seo.html");
    if(fs.existsSync(seoFile))
      fs.unlinkSync(seoFile);
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    let listenPort = webServer.getListenPort();
    let indexData = await FetchUtil.fetch("http://localhost:" + listenPort, {method: "GET"}).then((rsp) => rsp.text());
    expect(indexData).contains("<!-- pow-faucet-header -->", "not index contents");
  });

  it("rejects invalid static request urls without crashing", async () => {
    faucetConfig.faucetTitle = "test_title_" + Math.floor(Math.random() * 99999999).toString();
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    await returnDelayedPromise(true, null);
    let listenPort = webServer.getListenPort();
    let response = await FetchUtil.fetch("http://localhost:" + listenPort + "//", {method: "GET"});
    expect(response.status).equals(400, "unexpected response status");
    expect(response.statusText).equals("Bad Request", "unexpected response status text");
  });

  it("check api call (GET)", async () => {
    faucetConfig.faucetTitle = "test_title_" + Math.floor(Math.random() * 99999999).toString();
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    let listenPort = webServer.getListenPort();
    let configData = await FetchUtil.fetch("http://localhost:" + listenPort + "/api/getFaucetConfig", {method: "GET"}).then((rsp) => rsp.json());
    expect(!!configData).equals(true, "no api response");
    expect((configData as any).faucetTitle).equals(faucetConfig.faucetTitle, "api response mismatch");
  });

  it("check api call (POST)", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    let reqMsg: IncomingMessage = {} as any;
    ServiceManager.GetService(FaucetWebApi).registerApiEndpoint("testEndpoint", async (req, url, body) => {
      reqMsg = req;
      return sha256(body.toString());
    });
    let listenPort = webServer.getListenPort();
    let responseData = await FetchUtil.fetch("http://localhost:" + listenPort + "/api/testEndpoint", {
      method: 'POST',
      body: JSON.stringify({test: 1}),
      headers: {'Content-Type': 'application/json'}
    }).then((rsp) => rsp.text());

    expect(responseData).equals('"1da06016289bd76a5ada4f52fc805ae0c394612f17ec6d0f0c29b636473c8a9d"', "unexpected api response");
    expect(reqMsg.method).equals("POST", "unexpected method");
  });

  it("does not expose malformed JSON parser errors", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    let listenPort = webServer.getListenPort();

    const response = await FetchUtil.fetch("http://localhost:" + listenPort + "/api/startSession", {
      method: "POST",
      body: "{invalid",
      headers: { "Content-Type": "application/json" },
    });
    const responseBody = await response.text();
    expect(response.status).to.equal(500, "unexpected response code");
    expect(responseBody).to.equal(PUBLIC_INTERNAL_ERROR_MESSAGE, "unexpected public error message");
    expect(responseBody).not.to.contain("SyntaxError", "parser error leaked to client");
  });

  it("enforces an endpoint body-size limit before dispatch", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    let handlerCalled = false;
    ServiceManager.GetService(FaucetWebApi).registerApiEndpoint("testEndpoint", async (req, url, body) => {
      handlerCalled = true;
      return "test";
    }, {maxBodySize: 64});
    let listenPort = webServer.getListenPort();
    let response = await FetchUtil.fetch("http://localhost:" + listenPort + "/api/testEndpoint", {
      method: "POST",
      body: "x".repeat(65),
      headers: {"Content-Type": "application/json"},
    });

    expect(response.status).to.equal(413, "oversized body was accepted");
    expect(handlerCalled).to.equal(false, "oversized body reached the endpoint handler");
  });

  it("bounds built-in session requests and chunked bodies", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    let listenPort = webServer.getListenPort();
    expect(ServiceManager.GetService(FaucetWebApi).getApiRequestBodyLimit("/api/startSession"))
      .to.equal(SESSION_API_BODY_LIMIT);

    let response = await new Promise<{status: number; body: string}>((resolve, reject) => {
      let request = httpRequest({
        host: "127.0.0.1",
        port: listenPort,
        path: "/api/startSession",
        method: "POST",
        headers: {"Transfer-Encoding": "chunked"},
      }, (result) => {
        let chunks: Buffer[] = [];
        result.on("data", (chunk: Buffer) => chunks.push(chunk));
        result.on("end", () => resolve({
          status: result.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      request.on("error", reject);
      request.write("x".repeat(SESSION_API_BODY_LIMIT));
      request.end("x");
    });

    expect(response.status).to.equal(413);
    expect(response.body).to.equal("");
  });

  it("survives incomplete request resets without process shutdown", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();

    let endpointCalls = {incomplete: false, slow: false, oversized: false};
    let webApi = ServiceManager.GetService(FaucetWebApi);
    webApi.registerApiEndpoint("incompleteEndpoint", async () => {
      endpointCalls.incomplete = true;
      return "test";
    });
    webApi.registerApiEndpoint("slowEndpoint", async () => {
      endpointCalls.slow = true;
      return returnDelayedPromise(true, "test", 100);
    });
    webApi.registerApiEndpoint("oversizedEndpoint", async () => {
      endpointCalls.oversized = true;
      return "test";
    }, {maxBodySize: 8});

    let faucetProcess = ServiceManager.GetService(FaucetProcess);
    let shutdownStub = sinon.stub(faucetProcess, "shutdown").resolves();
    let emitLogStub = sinon.stub(faucetProcess, "emitLog");
    faucetProcess.initialize();

    let postReset = await resetIncompleteRequest(webServer, [
      "POST /api/incompleteEndpoint HTTP/1.1",
      "Host: 127.0.0.1",
      "Content-Type: application/json",
      "Content-Length: 1024",
      "Connection: close",
      "",
      "{\"partial\":"
    ].join("\r\n"));
    let getReset = await resetIncompleteRequest(webServer, [
      "GET /api/slowEndpoint HTTP/1.1",
      "Host: 127.0.0.1",
      "Content-Length: 1024",
      "Connection: keep-alive",
      "",
      "x",
    ].join("\r\n"));
    let oversizedReset = await resetIncompleteRequest(webServer, [
      "POST /api/oversizedEndpoint HTTP/1.1",
      "Host: 127.0.0.1",
      "Transfer-Encoding: chunked",
      "Connection: keep-alive",
      "",
      "9",
      "123456789",
      "",
    ].join("\r\n"), false);
    await returnDelayedPromise(true, null, 150);
    oversizedReset.request.emit("error", Object.assign(new Error("aborted"), {code: "ECONNRESET"}));

    let response = await FetchUtil.fetch(
      "http://localhost:" + webServer.getListenPort() + "/api/getVersion",
      {method: "GET"}
    );
    expect(postReset.error?.code).to.equal("ECONNRESET", "POST reset was not handled");
    expect(getReset.error?.code).to.equal("ECONNRESET", "GET reset was not handled");
    expect(oversizedReset.responseStatus).to.equal(413, "oversized body was not rejected before reset");
    expect(response.status).to.equal(200, "server stopped accepting requests after client resets");
    expect(endpointCalls).to.deep.equal({incomplete: false, slow: true, oversized: false});
    expect(emitLogStub.notCalled).to.equal(true, "expected peer reset was logged as a server error");
    expect(shutdownStub.notCalled).to.equal(true, "peer reset triggered process shutdown");

    postReset.request.emit("error", Object.assign(new Error("test transport failure"), {code: "EIO"}));
    expect(emitLogStub.calledOnce).to.equal(true, "unexpected transport error was hidden");
    expect(emitLogStub.firstCall.args[1]).to.contain("test transport failure");
    expect(shutdownStub.notCalled).to.equal(true, "handled transport error triggered process shutdown");
  });

  it("serves pipelined responses queued behind a delayed handler", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();

    let slowResponse = new PromiseDfd<string>();
    let fastHandlerCalled = new PromiseDfd<void>();
    let webApi = ServiceManager.GetService(FaucetWebApi);
    webApi.registerApiEndpoint("slowPipelineEndpoint", async () => slowResponse.promise);
    webApi.registerApiEndpoint("fastPipelineEndpoint", async () => {
      fastHandlerCalled.resolve();
      return "second";
    });

    let socket = connectSocket({host: "127.0.0.1", port: webServer.getListenPort()});
    let responseReceived = new PromiseDfd<string>();
    let rawResponse = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      rawResponse += chunk;
      if(rawResponse.includes('"first"') && rawResponse.includes('"second"'))
        responseReceived.resolve(rawResponse);
    });

    try {
      await once(socket, "connect");
      socket.write([
        "GET /api/slowPipelineEndpoint HTTP/1.1",
        "Host: 127.0.0.1",
        "Connection: keep-alive",
        "",
        "GET /api/fastPipelineEndpoint HTTP/1.1",
        "Host: 127.0.0.1",
        "Connection: close",
        "",
        "",
      ].join("\r\n"));
      await withTimeout(fastHandlerCalled.promise, "pipelined request was not dispatched");
      slowResponse.resolve("first");
      let response = await withTimeout(responseReceived.promise, "pipelined response did not finish");

      expect(response.match(/HTTP\/1\.1 200 OK/g)).to.have.length(2);
      expect(response.indexOf('"first"')).to.be.lessThan(response.indexOf('"second"'));
    } finally {
      socket.destroy();
    }
  });

  it("logs unexpected response errors without process shutdown", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();

    let handlerResult = new PromiseDfd<string>();
    ServiceManager.GetService(FaucetWebApi).registerApiEndpoint(
      "responseErrorEndpoint",
      async () => handlerResult.promise,
    );
    let responseObserved = new PromiseDfd<ServerResponse>();
    (webServer as any).httpServer.once("request", (_request: IncomingMessage, response: ServerResponse) => {
      responseObserved.resolve(response);
    });

    let faucetProcess = ServiceManager.GetService(FaucetProcess);
    let shutdownStub = sinon.stub(faucetProcess, "shutdown").resolves();
    let emitLogStub = sinon.stub(faucetProcess, "emitLog");
    faucetProcess.initialize();

    let request = FetchUtil.fetch(
      "http://localhost:" + webServer.getListenPort() + "/api/responseErrorEndpoint",
      {method: "GET"},
    );
    let response = await withTimeout(responseObserved.promise, "server response was not observed");
    response.emit("error", Object.assign(new Error("test response failure"), {code: "EIO"}));
    expect(emitLogStub.calledOnce).to.equal(true, "unexpected response error was hidden");
    expect(emitLogStub.firstCall.args[1]).to.contain("test response failure");
    expect(shutdownStub.notCalled).to.equal(true, "handled response error triggered process shutdown");

    handlerResult.resolve("ok");
    expect((await request).status).to.equal(200);
  });

  it("does not write a delayed API response after its client disconnects", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();

    let handlerCalled = new PromiseDfd<void>();
    let handlerResult = new PromiseDfd<string>();
    ServiceManager.GetService(FaucetWebApi).registerApiEndpoint("delayedAbortEndpoint", async () => {
      handlerCalled.resolve();
      return handlerResult.promise;
    });
    let responseObserved = new PromiseDfd<ServerResponse>();
    (webServer as any).httpServer.once("request", (_request: IncomingMessage, response: ServerResponse) => {
      responseObserved.resolve(response);
    });

    let socket = connectSocket({host: "127.0.0.1", port: webServer.getListenPort()});
    await once(socket, "connect");
    socket.write([
      "GET /api/delayedAbortEndpoint HTTP/1.1",
      "Host: 127.0.0.1",
      "Connection: close",
      "",
      "",
    ].join("\r\n"));
    await withTimeout(handlerCalled.promise, "delayed handler was not called");
    let response = await withTimeout(responseObserved.promise, "server response was not observed");
    let writeHead = sinon.spy(response, "writeHead");
    let responseClosed = once(response, "close");
    let socketClosed = once(socket, "close");
    socket.resetAndDestroy();
    await Promise.all([socketClosed, responseClosed]);

    handlerResult.resolve("late");
    await returnDelayedPromise(true, null, 20);
    expect(writeHead.notCalled).to.equal(true, "delayed handler wrote after client disconnect");
  });

  it("does not write a static response after its client disconnects", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();

    let pendingStaticResponse = new PromiseDfd<{
      response: ServerResponse;
      callback: (status: number, headers: IncomingHttpHeaders) => void;
    }>();
    sinon.stub((webServer as any).staticServer, "servePath").callsFake(((...args: unknown[]) => {
      pendingStaticResponse.resolve({
        response: args[4] as ServerResponse,
        callback: args[5] as (status: number, headers: IncomingHttpHeaders) => void,
      });
    }) as any);

    let responseObserved = new PromiseDfd<ServerResponse>();
    (webServer as any).httpServer.once("request", (_request: IncomingMessage, response: ServerResponse) => {
      responseObserved.resolve(response);
    });
    let socket = connectSocket({host: "127.0.0.1", port: webServer.getListenPort()});
    await once(socket, "connect");
    socket.write([
      "GET /js/powfaucet.js HTTP/1.1",
      "Host: 127.0.0.1",
      "Connection: close",
      "",
      "",
    ].join("\r\n"));
    let response = await withTimeout(responseObserved.promise, "static response was not observed");
    let pending = await withTimeout(pendingStaticResponse.promise, "static response was not intercepted");
    let responseClosed = once(response, "close");
    let socketClosed = once(socket, "close");
    socket.resetAndDestroy();
    await Promise.all([socketClosed, responseClosed]);

    let writeHead = sinon.spy(response, "writeHead");
    let write = sinon.spy(response, "write");
    let end = sinon.spy(response, "end");
    pending.response.writeHead(200, {"Content-Type": "text/plain"});
    pending.response.write("late");
    pending.response.end();
    pending.callback(404, {});
    expect(writeHead.notCalled).to.equal(true, "static server wrote after client disconnect");
    expect(write.notCalled).to.equal(true, "static server streamed after client disconnect");
    expect(end.notCalled).to.equal(true, "static server ended after client disconnect");
  });

  it("check api call (custom response)", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    ServiceManager.GetService(FaucetWebApi).registerApiEndpoint("testEndpoint", async (req, url, body) => {
      return new FaucetHttpResponse(500, "Test Error 4135");
    });
    let listenPort = webServer.getListenPort();
    let testRsp = await FetchUtil.fetch("http://localhost:" + listenPort + "/api/testEndpoint", {method: "GET"});
    expect(testRsp.status).to.equal(500, "unexpected http response code");
    expect(testRsp.statusText).to.matches(/Test Error 4135/, "unexpected http response code");
  });

  it("logs unexpected API errors without exposing them", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    ServiceManager.GetService(FaucetWebApi).registerApiEndpoint("testEndpoint", (req, url, body) => {
      return Promise.reject("Test Error 3672");
    });
    const logSpy = sinon.spy(ServiceManager.GetService(FaucetProcess), "emitLog");
    let listenPort = webServer.getListenPort();
    let testRsp = await FetchUtil.fetch("http://localhost:" + listenPort + "/api/testEndpoint", {method: "GET"});
    let testRspText = await testRsp.text();
    expect(testRsp.status).to.equal(500, "unexpected http response code");
    expect(testRspText).to.equal(PUBLIC_INTERNAL_ERROR_MESSAGE, "unexpected public error message");
    expect(testRspText).not.to.contain("Test Error 3672", "private error leaked to client");
    expect(logSpy.calledOnce).to.equal(true, "unexpected error was not logged");
    expect(logSpy.firstCall.args[1]).to.contain("Test Error 3672", "logged error lacks diagnostic detail");
    logSpy.restore();
  });

  it("check api call (rejection with custom response)", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    ServiceManager.GetService(FaucetWebApi).registerApiEndpoint("testEndpoint", async (req, url, body) => {
      throw new FaucetHttpResponse(500, "Test Error 4267");
    });
    let listenPort = webServer.getListenPort();
    let testRsp = await FetchUtil.fetch("http://localhost:" + listenPort + "/api/testEndpoint", {method: "GET"});
    expect(testRsp.status).to.equal(500, "unexpected http response code");
    expect(testRsp.statusText).to.matches(/Test Error 4267/, "unexpected http response code");
  });

  it("check api call (unexpected error)", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    ServiceManager.GetService(FaucetWebApi).registerApiEndpoint("testEndpoint", async (req, url, body) => {
      throw "unexpected error";
    });
    let listenPort = webServer.getListenPort();
    let testRsp = await FetchUtil.fetch("http://localhost:" + listenPort + "/api/testEndpoint", {method: "GET"});
    let responseBody = await testRsp.text();
    expect(testRsp.status).to.equal(500, "unexpected http response code");
    expect(testRsp.statusText).to.matches(/Internal Server Error/, "unexpected http response code");
    expect(responseBody).to.equal(PUBLIC_INTERNAL_ERROR_MESSAGE, "unexpected public error message");
  });

  it("returns 405 with Allow for unsupported methods", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    let listenPort = webServer.getListenPort();

    for(const method of ["PUT", "PATCH", "DELETE", "TRACE"]) {
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = httpRequest({
          host: "127.0.0.1",
          port: listenPort,
          path: "/api/getVersion",
          method,
        }, resolve);
        request.on("error", reject);
        request.end();
      });
      const responseEnded = once(response, "end");
      response.resume();
      await responseEnded;

      expect(response.statusCode).to.equal(405, `${method} returned an unexpected response code`);
      expect(response.headers.allow).to.equal("GET, HEAD, POST, OPTIONS", `${method} returned an unexpected Allow header`);
    }
  });

  it("rejects POST on static routes before dispatch", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    let listenPort = webServer.getListenPort();

    const response = await FetchUtil.fetch("http://localhost:" + listenPort + "/", {
      method: "POST",
      body: "not a static request",
    });
    expect(response.status).to.equal(405, "unexpected response code");
    expect(response.headers.get("allow")).to.equal("GET, HEAD, OPTIONS", "unexpected Allow header");
  });

  it("handles HEAD as GET without a response body", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    let listenPort = webServer.getListenPort();

    const response = await FetchUtil.fetch("http://localhost:" + listenPort + "/api/getVersion", { method: "HEAD" });
    expect(response.status).to.equal(200, "unexpected response code");
    expect(response.headers.get("content-type")).to.equal("application/json", "missing GET-equivalent headers");
    expect(await response.text()).to.equal("", "HEAD response included a body");
  });

  it("prevents status responses from being cached", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    let listenPort = webServer.getListenPort();

    for(const requestPath of [
      "/api/getSessionStatus?session=missing",
      "/api/GETSESSIONSTATUS?session=missing",
      "/api/getQueueStatus",
    ]) {
      const response = await FetchUtil.fetch("http://localhost:" + listenPort + requestPath, { method: "GET" });
      expect(response.headers.get("cache-control")).to.equal("no-store", `${requestPath} may be cached`);
    }
  });

  it("rejects API routes with trailing path segments", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    let listenPort = webServer.getListenPort();

    for(const requestPath of [
      "/api/getSessionStatus/",
      "/api/getSessionStatus/extra",
      "/api/getQueueStatus/extra",
    ]) {
      const response = await FetchUtil.fetch("http://localhost:" + listenPort + requestPath, { method: "GET" });
      expect(response.status).to.equal(404, `${requestPath} was accepted`);
    }
  });

  it("check ws call", async () => {
    faucetConfig.faucetTitle = "test_title_" + Math.floor(Math.random() * 99999999).toString();
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    await ServiceManager.GetService(EthClaimManager).initialize();
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    let listenPort = webServer.getListenPort();
    let webSocket = new WebSocket("ws://127.0.0.1:" + listenPort + "/ws/claim");
    let errorDfd = new PromiseDfd<any>();
    webSocket.onmessage = (evt) => {
      let data = JSON.parse(evt.data.toString());
      if(data && data.action === "error")
        errorDfd.resolve(data);
    };
    await new Promise<void>((resolve) => {
      webSocket.onopen = (evt) => {
        resolve();
      };
    });
    let errorResponse = await errorDfd.promise;
    expect(!!errorResponse).equals(true, "no websocket response");
    expect(errorResponse.data.reason).to.matches(/session not found/, "api response mismatch");
    webSocket.close();
  });

  it("check ws call (invalid endpoint)", async () => {
    faucetConfig.faucetTitle = "test_title_" + Math.floor(Math.random() * 99999999).toString();
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    await ServiceManager.GetService(EthClaimManager).initialize();
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    let listenPort = webServer.getListenPort();
    let webSocket = new WebSocket("ws://127.0.0.1:" + listenPort + "/api/test");
    let errorResponse = await new Promise<any>((resolve) => {
      webSocket.onerror = (evt) => {
        resolve(evt);
      };
    });
    expect(!!errorResponse).equals(true, "no websocket error");
  });

  it("limits WebSocket messages to 64 KiB", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.addWssEndpoint("payload-limit-test", /^\/ws\/payload-limit-test$/, (_req, ws) => {
      ws.on("message", (message) => ws.send(message));
    });
    webServer.initialize();
    let listenPort = webServer.getListenPort();
    expect((webServer as any).wssServer.options.maxPayload).to.equal(FAUCET_WEBSOCKET_MAX_PAYLOAD);
    let webSocket = new WebSocket("ws://127.0.0.1:" + listenPort + "/ws/payload-limit-test");
    webSocket.on("error", () => {});
    await new Promise<void>((resolve) => webSocket.on("open", () => resolve()));

    for(const messageSize of [FAUCET_WEBSOCKET_MAX_PAYLOAD - 1, FAUCET_WEBSOCKET_MAX_PAYLOAD]) {
      const echoedMessage = new Promise<Buffer>((resolve) => {
        webSocket.once("message", (message) => resolve(Buffer.from(message as any)));
      });
      webSocket.send(Buffer.alloc(messageSize));
      expect((await withTimeout(echoedMessage, `message of ${messageSize} bytes was not echoed`)).length)
        .to.equal(messageSize, `message of ${messageSize} bytes was rejected`);
    }

    const closeCode = new Promise<number>((resolve) => {
      webSocket.once("close", (code) => resolve(code));
    });
    webSocket.send(Buffer.alloc(FAUCET_WEBSOCKET_MAX_PAYLOAD + 1));
    expect(await withTimeout(closeCode, "oversized message did not close the WebSocket"))
      .to.equal(1009, "oversized message did not close with message-too-big");
  });

  it("configures PoW workers with the shared WebSocket payload limit", async () => {
    const validatorWorker = {
      on: sinon.stub(),
      off: sinon.stub(),
      terminate: sinon.stub().resolves(0),
    };
    globalStubs["FaucetWorkers.createWorker"].returns(validatorWorker);
    const channel = new MessageChannel();
    const powWorker = new PoWServerWorker(channel.port1 as any);

    try {
      expect((powWorker as any).wss.options.maxPayload).to.equal(FAUCET_WEBSOCKET_MAX_PAYLOAD);
    } finally {
      await (powWorker as any).onPoWShutdown();
      channel.port2.close();
    }
  });

  it("check cors api call", async () => {
    faucetConfig.faucetTitle = "test_title_" + Math.floor(Math.random() * 99999999).toString();
    faucetConfig.buildSeoIndex = true;
    faucetConfig.serverPort = 0;
    faucetConfig.corsAllowOrigin = ["https://example.com", "https://example2.com"];
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    let listenPort = webServer.getListenPort();
    let configOptionsRsp = await FetchUtil.fetch(
      "http://localhost:" + listenPort + "/api/getFaucetConfig", 
      {
        method: "OPTIONS",
        headers: {
          "Origin": "https://example.com"
        }
      }
    )
    expect(configOptionsRsp.headers.get("access-control-allow-origin")).equals("https://example.com", "access-control-allow-origin mismatch");
    expect(configOptionsRsp.headers.get("access-control-allow-methods")).equals("GET, HEAD, POST", "access-control-allow-methods mismatch");
    expect(configOptionsRsp.headers.get("access-control-allow-headers")).equals("Authorization, Content-Type", "access-control-allow-headers mismatch");

    let configRsp = await FetchUtil.fetch(
      "http://localhost:" + listenPort + "/api/getFaucetConfig", 
      {
        method: "GET",
        headers: {
          "Origin": "https://example2.com"
        }
      }
    )
    expect(configRsp.headers.get("access-control-allow-origin")).equals("https://example2.com", "access-control-allow-origin mismatch 2");
    expect(configRsp.headers.get("access-control-allow-methods")).equals("GET, HEAD, POST", "access-control-allow-methods mismatch 2");
    let configData = await configRsp.json();
    expect(!!configData).equals(true, "no api response");
    expect((configData as any).faucetTitle).equals(faucetConfig.faucetTitle, "api response mismatch");
  });

  it("check cors api call (invalid origin)", async () => {
    faucetConfig.faucetTitle = "test_title_" + Math.floor(Math.random() * 99999999).toString();
    faucetConfig.buildSeoIndex = true;
    faucetConfig.serverPort = 0;
    faucetConfig.corsAllowOrigin = ["https://example.com"];
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    let listenPort = webServer.getListenPort();
    let configOptionsRsp = await FetchUtil.fetch(
      "http://localhost:" + listenPort + "/api/getFaucetConfig", 
      {
        method: "OPTIONS",
        headers: {
          "Origin": "https://example2.com"
        }
      }
    )
    expect(configOptionsRsp.headers.get("access-control-allow-origin")).equals(null, "access-control-allow-origin mismatch");
    expect(configOptionsRsp.headers.get("access-control-allow-methods")).equals(null, "access-control-allow-methods mismatch");
  });

  it("check cors resource calls", async function() {
    faucetConfig.faucetTitle = "test_title_" + Math.floor(Math.random() * 99999999).toString();
    faucetConfig.buildSeoIndex = true;
    faucetConfig.serverPort = 0;
    faucetConfig.corsAllowOrigin = ["https://example.com", "https://example2.com"];
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    let listenPort = webServer.getListenPort();

    let staticPath = resolveRelativePath(faucetConfig.staticPath, process.cwd());
    let checkResources = [
      "/js/powfaucet.js",
      "/css/powfaucet.css",
    ];

    // create dirs (might be missing if client hasn't been compiled)
    [ "js", "css" ].forEach((dir) => {
      let dirPath = path.join(staticPath, dir);
      if(!fs.existsSync(dirPath))
        fs.mkdirSync(dirPath);
    })

    for(let i = 0; i < checkResources.length; i++) {
      let resource = checkResources[i];

      let resourcePath = path.join(staticPath, resource);
      if(!fs.existsSync(resourcePath))
        fs.writeFileSync(resourcePath, "test");

      let optionsRsp = await FetchUtil.fetch(
        "http://localhost:" + listenPort + resource, 
        {
          method: "OPTIONS",
          headers: {
            "Origin": "https://example.com"
          }
        }
      )
      expect(optionsRsp.headers.get("access-control-allow-origin")).equals("https://example.com", "access-control-allow-origin mismatch");
      expect(optionsRsp.headers.get("access-control-allow-methods")).equals("GET, HEAD, POST", "access-control-allow-methods mismatch");

      let dataRsp = await FetchUtil.fetch(
        "http://localhost:" + listenPort + resource, 
        {
          method: "GET",
          headers: {
            "Origin": "https://example2.com"
          }
        }
      )
      expect(dataRsp.headers.get("access-control-allow-origin")).equals("https://example2.com", "access-control-allow-origin mismatch 2");
      expect(dataRsp.headers.get("access-control-allow-methods")).equals("GET, HEAD, POST", "access-control-allow-methods mismatch 2");
    }
  });

  it("returns 304 for conditional static resource requests", async function() {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    faucetConfig.corsAllowOrigin = ["https://example.com"];
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    let listenPort = webServer.getListenPort();

    let staticPath = resolveRelativePath(faucetConfig.staticPath, process.cwd());
    let jsPath = path.join(staticPath, "js");
    if(!fs.existsSync(jsPath))
      fs.mkdirSync(jsPath);

    let resourcePath = path.join(jsPath, "powfaucet.js");
    if(!fs.existsSync(resourcePath))
      fs.writeFileSync(resourcePath, "test");

    let initialRsp = await FetchUtil.fetch(
      "http://localhost:" + listenPort + "/js/powfaucet.js",
      {
        method: "GET",
        headers: {
          "Origin": "https://example.com"
        }
      }
    );

    let etag = initialRsp.headers.get("etag");
    expect(etag).to.not.equal(null, "etag missing");

    let cachedRsp = await FetchUtil.fetchWithTimeout(
      "http://localhost:" + listenPort + "/js/powfaucet.js",
      {
        method: "GET",
        headers: {
          "Origin": "https://example.com",
          "If-None-Match": etag
        }
      },
      1000
    );

    expect(cachedRsp.status).equals(304, "unexpected status");
    expect(cachedRsp.headers.get("access-control-allow-origin")).equals("https://example.com", "access-control-allow-origin mismatch");
    expect(cachedRsp.headers.get("content-security-policy")).equals("frame-ancestors 'none'; base-uri 'self'; object-src 'none'", "security policy missing on 304 response");
    expect(cachedRsp.headers.get("content-length")).equals(null, "content-length should be omitted on 304");
  });

  it("FetchUtil: request", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    ServiceManager.GetService(FaucetWebApi).registerApiEndpoint("testEndpoint", async (req, url, body) => {
      return "test";
    });
    let listenPort = webServer.getListenPort();
    let res = await FetchUtil.fetchWithTimeout("http://localhost:" + listenPort + "/api/testEndpoint", {method: "GET"}, 100).then((rsp) => rsp.json());
    expect(res).to.equals("test", "unexpected response");
  });

  it("FetchUtil: timeout", async () => {
    faucetConfig.buildSeoIndex = false;
    faucetConfig.serverPort = 0;
    let webServer = ServiceManager.GetService(FaucetHttpServer);
    webServer.initialize();
    ServiceManager.GetService(FaucetWebApi).registerApiEndpoint("testEndpoint", async (req, url, body) => {
      return returnDelayedPromise(true, "test", 200);
    });
    let listenPort = webServer.getListenPort();
    let err;
    try {
      await FetchUtil.fetchWithTimeout("http://localhost:" + listenPort + "/api/testEndpoint", {method: "GET"}, 100);
    } catch(ex) {
      err = ex;
    }
    expect(!!err).to.equals(true, "no error thrown");
    expect(err.toString()).to.matches(/Request timed out/, "unexpected error message");
  });

  it("FetchUtil: http error", async () => {
    let err;
    try {
      await FetchUtil.fetchWithTimeout("http://127.0.0.1:62353/api/testEndpoint", {method: "GET", }, 5000);
    } catch(ex) {
      err = ex;
    }
    expect(!!err).to.equals(true, "no error thrown");
    expect(err.toString()).to.matches(/failed/, "unexpected error message");
  });

});
