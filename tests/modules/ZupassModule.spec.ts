import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { bindTestStubs, unbindTestStubs, loadDefaultTestConfig } from '../common.js';
import { ServiceManager } from '../../src/common/ServiceManager.js';
import { FaucetDatabase } from '../../src/db/FaucetDatabase.js';
import { ModuleHookAction, ModuleManager } from '../../src/modules/ModuleManager.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { faucetConfig } from '../../src/config/FaucetConfig.js';
import { FaucetError } from '../../src/common/FaucetError.js';
import { FaucetWebApi } from '../../src/webserv/FaucetWebApi.js';
import { FaucetSession, FaucetSessionStatus } from '../../src/session/FaucetSession.js';
import { FaucetHttpResponse } from '../../src/webserv/FaucetHttpServer.js';
import { IZupassConfig } from '../../src/modules/zupass/ZupassConfig.js';
import { ZupassPCD } from '../../src/modules/zupass/ZupassPCD.js';
import { sleepPromise } from '../../src/utils/PromiseUtils.js';
import { ZupassDB } from '../../src/modules/zupass/ZupassDB.js';
import { encryptTokenPayload } from '../../src/utils/CryptoUtils.js';
import { EventEmitter } from 'node:events';
import { ZupassChallengeStore } from '../../src/modules/zupass/ZupassAuth.js';

const AUTH_STATE = "b".repeat(64);
const CALLBACK_ORIGIN = "https://faucets.pk910.de";

function withCallbackContext(url: string, clientOrigin = CALLBACK_ORIGIN, state = AUTH_STATE): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}state=${state}&clientOrigin=${encodeURIComponent(clientOrigin)}`;
}


describe("Faucet module: zupass", () => {
  let globalStubs;

  beforeEach(async () => {
    globalStubs = bindTestStubs({});
    loadDefaultTestConfig();
    await ServiceManager.GetService(FaucetDatabase).initialize();
    faucetConfig.modules["zupass"] = {
      enabled: true,
      zupassUrl: "https://zupass.org/",
      zupassApiUrl: "https://api.zupass.org/",
      redirectUrl: "https://faucets.pk910.de/api/zupassCallback",
      zupassWatermark: "powfaucet challenge",
      zupassExternalNullifier: "powfaucet",
      event: {
        name: "Devconnect 2023",
        eventIds: ["a1c822c4-60bd-11ee-8732-763dbf30819c", "140b208c-6d1d-11ee-8320-126a2f5f3c5e"],
        productIds: [],
      },
      verify: {
        signer: ["05e0c4e8517758da3a26c80310ff2fe65b9f85d89dfc9c80e6d0b6477f88173e", "29ae64b615383a0ebb1bc37b3a642d82d37545f0f5b1444330300e4c4eedba3f"],
      },
      requireLogin: true,
      concurrencyLimit: 1,
      grants: [],
      loginLogo: null,
      loginLabel: "zupass login",
      userLabel: null,
      infoHtml: "zupass info"
    } as IZupassConfig;
  });
  afterEach(async () => {
    let dbService = ServiceManager.GetService(FaucetDatabase);
    await ServiceManager.DisposeAllServices();
    await dbService.closeDatabase();
    await unbindTestStubs(globalStubs);
  });

  function getValidPcd() {
    // this is a valid PCD generated for my devconnect ticket :)
    return {
      "id": "08f3ab85-2849-4b9b-a87c-970d14b342cd",
      "claim": {
        "partialTicket": {
          "ticketId": "102c8990-9efc-11ee-85f8-de4e23c7523a",
          "eventId": "a1c822c4-60bd-11ee-8732-763dbf30819c",
          "productId": "6768a2e0-986f-11ee-abf3-126a2f5f3c5c",
          "attendeeSemaphoreId": "13741484094604222573966014497321470030869540832333932860622584807523008667804",
          "isConsumed": false,
          "isRevoked": false
        },
        "watermark": "337635737515449575428187860496846766607298173824839204522817527605290000567",
        "signer":[
          "05e0c4e8517758da3a26c80310ff2fe65b9f85d89dfc9c80e6d0b6477f88173e",
          "29ae64b615383a0ebb1bc37b3a642d82d37545f0f5b1444330300e4c4eedba3f"
        ],
        "validEventIds":[
          "785e8a0e-6734-11ee-b810-a2b83754f6bc",
          "0996f5fa-6736-11ee-a3bd-a2b83754f6bc",
          "f626d630-2f8a-11ee-be83-b2dd9fd377ba",
          "a1c822c4-60bd-11ee-8732-763dbf30819c",
          "3049870c-6cc8-11ee-98f3-7ebd6aca95cd",
          "aebcb892-69e5-11ee-b65e-a2b83754f6bc",
          "7b57a8fc-6bae-11ee-bf2a-9e102a509962",
          "e1423686-6cc7-11ee-98f3-7ebd6aca95cd",
          "140b208c-6d1d-11ee-8320-126a2f5f3c5e"
        ],
        "nullifierHash": "1453430002874639591624883772901011511827714415737702185124492361874364231852",
        "externalNullifier": "436406636072292623482634608279337780777116908402682507662237447074993329383"
      },
      "proof":{
        "pi_a": [
          "9817201909012884395430827012567150362379238508671638764505850984305625038164",
          "2596154944618744496977159836942145170826608436016936844463358172433387533362",
          "1"
        ],
        "pi_b": [
          ["17656789093164305733037037056526659674044557325195302604168642797409784582264","13814016577669853857274722145873501584187668397304277737180681466182407349975"],
          ["12328779357527727520379416500297377534855162802589644097578481298022784697840","5660729295765724845796798134929980134921676688459035771015916110375289415270"],
          ["1","0"]
        ],
        "pi_c": [
          "7195542179845510084575676470153719167790899838447209482141904711493707705763",
          "3982741706039324597928768955071283925868252297390994760620627935244606981245",
          "1"
        ],
        "protocol":"groth16",
        "curve":"bn128"
      },
      "type": "zk-eddsa-event-ticket-pcd"
    };
  }

  function generateTestToken(ticketId: string, productId: string, eventId: string, attendeeId: string): string {
    let pcd: ZupassPCD = ServiceManager.GetService(ModuleManager).getModule<any>("zupass").zupassPCD;
    return pcd.generateFaucetToken({
      ticketId: ticketId,
      productId: productId,
      eventId: eventId,
      attendeeId: attendeeId,
      token: "",
    });
  }

  async function issueChallenge(
    state = AUTH_STATE,
    remoteAddress = "127.0.0.1",
    clientOrigin = CALLBACK_ORIGIN,
  ): Promise<{
    callbackUrl: URL;
    watermark: string;
    externalNullifier: string;
  }> {
    const loginResponse = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "POST",
      url: withCallbackContext("/api/zupassLogin", clientOrigin, state),
      headers: { origin: clientOrigin },
      socket: { remoteAddress },
    } as any);
    expect(loginResponse.code).to.equal(302);

    const proofRequestUrl = new URL(String(loginResponse.headers.Location));
    const requestQuery = proofRequestUrl.hash.split("?", 2)[1];
    const encodedRequest = new URLSearchParams(requestQuery).get("request");
    expect(encodedRequest).to.be.a("string");
    const proofRequest = JSON.parse(decodeURIComponent(encodedRequest!));
    return {
      callbackUrl: new URL(proofRequest.returnUrl),
      watermark: proofRequest.args.watermark.value,
      externalNullifier: proofRequest.args.externalNullifier.value,
    };
  }

  function callbackPath(callbackUrl: URL, proof?: unknown): string {
    const url = new URL(callbackUrl);
    if(proof !== undefined)
      url.searchParams.set("proof", JSON.stringify(proof));
    return url.pathname + url.search;
  }

  function bindProofToChallenge(
    pcd: ReturnType<typeof getValidPcd>,
    challenge: {watermark: string; externalNullifier: string},
  ): void {
    pcd.claim.watermark = challenge.watermark;
    pcd.claim.externalNullifier = challenge.externalNullifier;
  }

  function expectRestartRequired(response: FaucetHttpResponse): void {
    expect(response.code).to.equal(200);
    expect(response.body).to.include("ZUPASS_RESTART_REQUIRED");
    expect(response.body).to.not.include("ticket watermark");
    expect(response.body).to.not.include("ticket signer");
  }

  it("Check client config exports", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    let clientConfig = await ServiceManager.GetService(FaucetWebApi).onGetFaucetConfig();
    expect(!!clientConfig.modules['zupass']).to.equal(true, "no zupass config exported");
    expect(clientConfig.modules['zupass'].redirectUrl).to.equal("https://faucets.pk910.de/api/zupassCallback", "client config mismatch: redirectUrl");
    expect(clientConfig.modules['zupass'].infoHtml).to.matches(/zupass info/, "client config mismatch: infoHtml");
    expect(Object.keys(clientConfig.modules['zupass']).sort()).to.deep.equal([
      "infoHtml",
      "loginLabel",
      "loginLogo",
      "redirectUrl",
      "userLabel",
    ]);
  });

  it("requires a trusted ticket signer", async () => {
    (faucetConfig.modules["zupass"] as IZupassConfig).verify = {};
    let error: Error | null = null;
    try {
      await ServiceManager.GetService(ModuleManager).initialize();
    } catch(ex) {
      error = ex;
    }
    expect(error?.message).to.include("Zupass verifier signer is required");
  });

  it("Check database cleanup", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();

    let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      zupassToken: generateTestToken("102c8990-9efc-11ee-85f8-de4e23c7523a", "6768a2e0-986f-11ee-abf3-126a2f5f3c5c", "a1c822c4-60bd-11ee-8732-763dbf30819c", "1"),
    });
    
    let now = Math.floor((new Date()).getTime() / 1000);
    await ServiceManager.GetService(FaucetDatabase).updateSession({
      sessionId: testSession.getSessionId(),
      status: FaucetSessionStatus.FINISHED,
      startTime: now - faucetConfig.sessionCleanup - 10,
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1337",
      remoteIP: "8.8.8.8",
      tasks: [],
      data: {},
      claim: null,
    });

    ServiceManager.GetService(FaucetDatabase).cleanStore();
    await sleepPromise(50);

    let zupassDb: ZupassDB = ServiceManager.GetService(ModuleManager).getModule<any>("zupass").zupassDb;
    await zupassDb.cleanStore();
  });

  it("Start session with zupass token", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      zupassToken: generateTestToken("102c8990-9efc-11ee-85f8-de4e23c7523a", "6768a2e0-986f-11ee-abf3-126a2f5f3c5c", "a1c822c4-60bd-11ee-8732-763dbf30819c", "1"),
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");

    let zupassData = testSession.getSessionData("zupass.data");
    expect(!!zupassData).to.equal(true, "unexpected zupass data in session data: undefined");
    expect(zupassData.ticketId).to.equal("102c8990-9efc-11ee-85f8-de4e23c7523a", "unexpected zupass data in session data: ticketId");
    expect(zupassData.productId).to.equal("6768a2e0-986f-11ee-abf3-126a2f5f3c5c", "unexpected zupass data in session data: productId");
    expect(zupassData.eventId).to.equal("a1c822c4-60bd-11ee-8732-763dbf30819c", "unexpected zupass data in session data: eventId");
    expect(zupassData.attendeeId).to.equal("1", "unexpected zupass data in session data: attendeeId");
  });

  it("Check zupass requirements: missing authentication", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("ZUPASS_REQUIRED", "unexpected error code");
    expect(error?.message).to.matches(/need to authenticate with your zupass account/, "unexpected error message");
  });

  it("Check zupass requirements: invalid token", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        zupassToken: generateTestToken("102c8990-9efc-11ee-85f8-de4e23c7523a", "6768a2e0-986f-11ee-abf3-126a2f5f3c5c", "a1c822c4-60bd-11ee-8732-763dbf30819c", "1") + "invalid",
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("ZUPASS_TOKEN", "unexpected error code");
    expect(error?.message).to.matches(/Invalid zupass login token/, "unexpected error message");
  });

  it("Rejects authenticated zupass tokens with invalid payloads", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const pcd: any = ServiceManager.GetService(ModuleManager).getModule<any>("zupass").zupassPCD;
    const validPayload = {
      kind: "zupass",
      ticketId: "102c8990-9efc-11ee-85f8-de4e23c7523a",
      productId: "6768a2e0-986f-11ee-abf3-126a2f5f3c5c",
      eventId: "a1c822c4-60bd-11ee-8732-763dbf30819c",
      attendeeId: "1",
    };
    const invalidPayloads = [
      { ...validPayload, attendeeId: 1 },
      { ...validPayload, extra: "unexpected" },
      { ...validPayload, kind: "github" },
      { ...validPayload, ticketId: "" },
      { ...validPayload, eventId: "not-a-uuid" },
      { ...validPayload, attendeeId: "01" },
      { ...validPayload, attendeeId: "not-a-number" },
    ];

    for(const payload of invalidPayloads) {
      const token = encryptTokenPayload(payload, pcd.getTokenPassphrase());
      expect(pcd.parseFaucetToken(token)).to.equal(null);
    }
  });

  it("expires authentication tokens and invalidates them on policy reload", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const module = ServiceManager.GetService(ModuleManager).getModule<any>("zupass");
    const pcd: ZupassPCD = module.zupassPCD;
    const identity = {
      ticketId: "102c8990-9efc-11ee-85f8-de4e23c7523a",
      productId: "6768a2e0-986f-11ee-abf3-126a2f5f3c5c",
      eventId: "a1c822c4-60bd-11ee-8732-763dbf30819c",
      attendeeId: "1",
      token: "",
    };
    const issuedAt = 1_000_000;
    const token = pcd.generateFaucetToken(identity, issuedAt);
    expect(pcd.parseFaucetToken(token, issuedAt + 3599)).to.not.equal(null);
    expect(pcd.parseFaucetToken(token, issuedAt + 3600)).to.equal(null);

    await module.setModuleConfig({
      ...module.getModuleConfig(),
      zupassWatermark: "replacement policy",
    });
    expect(pcd.parseFaucetToken(token, issuedAt + 1)).to.equal(null);
  });

  it("replaces a timed-out verifier generation and ignores stale events", async () => {
    const firstWorker = new EventEmitter() as any;
    firstWorker.postMessage = sinon.spy();
    firstWorker.terminate = sinon.stub().resolves(0);
    const replacementWorker = new EventEmitter() as any;
    replacementWorker.postMessage = sinon.spy();
    replacementWorker.terminate = sinon.stub().resolves(0);
    let resolveReplacementStarted!: () => void;
    const replacementStarted = new Promise<void>((resolve) => {
      resolveReplacementStarted = resolve;
    });
    const workerFactory = sinon.stub().callsFake(() => {
      resolveReplacementStarted();
      return replacementWorker;
    });
    const verifier = new ZupassPCD({} as any, firstWorker, {
      initTimeoutMs: 100,
      verifyTimeoutMs: 10,
      maxPendingVerifications: 2,
      restartBackoffMs: 1,
      maxRestartBackoffMs: 1,
      workerFactory,
    });
    const staleMessageListener = firstWorker.listeners("message")[0] as (message: unknown) => void;
    firstWorker.emit("message", {action: "init"});
    const ticket = verifier.parseTicket(JSON.stringify(getValidPcd()));

    const firstResult = verifier.verifyTicket(ticket).then(
      () => null,
      (error) => error,
    );
    const queuedResult = verifier.verifyTicket(ticket).then(
      () => null,
      (error) => error,
    );
    expect(await firstResult).to.be.instanceOf(Error);
    expect(await queuedResult).to.be.instanceOf(Error);
    await replacementStarted;
    expect(firstWorker.postMessage.calledOnce).to.equal(true);
    expect(firstWorker.terminate.calledOnce).to.equal(true);
    expect(workerFactory.calledOnce).to.equal(true);

    replacementWorker.emit("message", {action: "init"});
    const replacementResult = verifier.verifyTicket(ticket);
    const replacementRequest = replacementWorker.postMessage.firstCall.args[0].data;
    let replacementSettled = false;
    replacementResult.finally(() => replacementSettled = true);
    staleMessageListener({
      action: "verified",
      data: {reqId: replacementRequest.reqId, isValid: false},
    });
    await Promise.resolve();
    expect(replacementSettled).to.equal(false);

    replacementWorker.emit("message", {
      action: "verified",
      data: {reqId: replacementRequest.reqId, isValid: true},
    });
    expect(await replacementResult).to.equal(true);
    await verifier.dispose();
  });

  it("gives each serialized verification a full compute timeout after dispatch", async () => {
    const verifyTimeoutMs = 50;
    const computeDurationMs = 30;
    expect(computeDurationMs).to.be.lessThan(verifyTimeoutMs);
    expect(computeDurationMs * 2).to.be.greaterThan(verifyTimeoutMs);
    const clock = sinon.useFakeTimers();
    const worker = new EventEmitter() as any;
    worker.postMessage = sinon.spy();
    worker.terminate = sinon.stub().resolves(0);
    const workerFactory = sinon.stub();
    const verifier = new ZupassPCD({} as any, worker, {
      initTimeoutMs: 100,
      verifyTimeoutMs,
      maxPendingVerifications: 2,
      workerFactory,
    });

    try {
      worker.emit("message", {action: "init"});
      const ticket = verifier.parseTicket(JSON.stringify(getValidPcd()));
      const firstResult = verifier.verifyTicket(ticket);
      const secondResult = verifier.verifyTicket(ticket);
      expect(worker.postMessage.calledOnce).to.equal(true);
      const firstRequest = worker.postMessage.firstCall.args[0].data;

      await clock.tickAsync(computeDurationMs);
      worker.emit("message", {
        action: "verified",
        data: {reqId: firstRequest.reqId, isValid: true},
      });
      expect(await firstResult).to.equal(true);
      expect(worker.postMessage.callCount).to.equal(2);
      const secondRequest = worker.postMessage.secondCall.args[0].data;

      await clock.tickAsync(computeDurationMs);
      worker.emit("message", {
        action: "verified",
        data: {reqId: secondRequest.reqId, isValid: false},
      });
      expect(await secondResult).to.equal(false);
      expect(worker.terminate.called).to.equal(false);
      expect(workerFactory.called).to.equal(false);
    }
    finally {
      await verifier.dispose();
      clock.restore();
    }
  });

  it("does not spend the compute timeout while a verification waits for initialization", async () => {
    const verifyTimeoutMs = 20;
    const initializationDwellMs = 30;
    const computeDurationMs = 10;
    expect(initializationDwellMs).to.be.greaterThan(verifyTimeoutMs);
    expect(computeDurationMs).to.be.lessThan(verifyTimeoutMs);
    const clock = sinon.useFakeTimers();
    const worker = new EventEmitter() as any;
    worker.postMessage = sinon.spy();
    worker.terminate = sinon.stub().resolves(0);
    const workerFactory = sinon.stub();
    const verifier = new ZupassPCD({} as any, worker, {
      initTimeoutMs: 100,
      verifyTimeoutMs,
      workerFactory,
    });

    try {
      const ticket = verifier.parseTicket(JSON.stringify(getValidPcd()));
      const result = verifier.verifyTicket(ticket);
      let settled = false;
      void result.then(
        () => settled = true,
        () => settled = true,
      );

      await clock.tickAsync(initializationDwellMs);
      expect(settled).to.equal(false);
      expect(worker.postMessage.called).to.equal(false);
      expect(worker.terminate.called).to.equal(false);

      worker.emit("message", {action: "init"});
      const request = worker.postMessage.firstCall.args[0].data;
      await clock.tickAsync(computeDurationMs);
      worker.emit("message", {
        action: "verified",
        data: {reqId: request.reqId, isValid: true},
      });

      expect(await result).to.equal(true);
      expect(worker.terminate.called).to.equal(false);
      expect(workerFactory.called).to.equal(false);
    }
    finally {
      await verifier.dispose();
      clock.restore();
    }
  });

  it("recovers from verifier worker errors and exits", async () => {
    const firstWorker = new EventEmitter() as any;
    firstWorker.postMessage = sinon.spy();
    firstWorker.terminate = sinon.stub().resolves(0);
    const secondWorker = new EventEmitter() as any;
    secondWorker.postMessage = sinon.spy();
    secondWorker.terminate = sinon.stub().resolves(0);
    const thirdWorker = new EventEmitter() as any;
    thirdWorker.postMessage = sinon.spy();
    thirdWorker.terminate = sinon.stub().resolves(0);
    const workerFactory = sinon.stub();
    workerFactory.onFirstCall().returns(secondWorker);
    workerFactory.onSecondCall().returns(thirdWorker);
    const verifier = new ZupassPCD({} as any, firstWorker, {
      initTimeoutMs: 100,
      verifyTimeoutMs: 100,
      restartBackoffMs: 1,
      maxRestartBackoffMs: 1,
      workerFactory,
    });
    const ticket = verifier.parseTicket(JSON.stringify(getValidPcd()));

    firstWorker.emit("message", {action: "init"});
    const errorResult = verifier.verifyTicket(ticket).catch((error) => error);
    firstWorker.emit("error", new Error("worker failed"));
    expect(await errorResult).to.be.instanceOf(Error);
    await sleepPromise(5);
    expect(firstWorker.terminate.calledOnce).to.equal(true);
    expect(workerFactory.calledOnce).to.equal(true);

    secondWorker.emit("message", {action: "init"});
    const exitResult = verifier.verifyTicket(ticket).catch((error) => error);
    secondWorker.emit("exit", 1);
    expect(await exitResult).to.be.instanceOf(Error);
    await sleepPromise(5);
    expect(secondWorker.terminate.calledOnce).to.equal(true);
    expect(workerFactory.callCount).to.equal(2);

    thirdWorker.emit("message", {action: "init"});
    const recoveredResult = verifier.verifyTicket(ticket);
    const recoveredRequest = thirdWorker.postMessage.firstCall.args[0].data;
    thirdWorker.emit("message", {
      action: "verified",
      data: {reqId: recoveredRequest.reqId, isValid: true},
    });
    expect(await recoveredResult).to.equal(true);
    await verifier.dispose();
  });

  it("stays fail closed after termination rejection until reload drains the old generation", async () => {
    const firstWorker = new EventEmitter() as any;
    firstWorker.postMessage = sinon.spy();
    firstWorker.terminate = sinon.stub();
    firstWorker.terminate.onFirstCall().rejects(new Error("termination rejected"));
    firstWorker.terminate.onSecondCall().resolves(0);
    const replacementWorker = new EventEmitter() as any;
    replacementWorker.postMessage = sinon.spy();
    replacementWorker.terminate = sinon.stub().resolves(0);
    const workerFactory = sinon.stub().returns(replacementWorker);
    const verifier = new ZupassPCD({} as any, firstWorker, {
      initTimeoutMs: 100,
      verifyTimeoutMs: 100,
      restartBackoffMs: 1,
      maxRestartBackoffMs: 1,
      workerFactory,
    });
    const ticket = verifier.parseTicket(JSON.stringify(getValidPcd()));

    firstWorker.emit("message", {action: "init"});
    const failedVerification = verifier.verifyTicket(ticket).catch((error) => error);
    firstWorker.emit("error", new Error("worker failed"));
    expect(await failedVerification).to.be.instanceOf(Error);
    await sleepPromise(5);

    expect(() => verifier.reserveVerification()).to.throw("unavailable");
    expect(workerFactory.called).to.equal(false, "replacement worker started before old termination was proven");

    await verifier.reload();
    expect(firstWorker.terminate.callCount).to.equal(2, "reload did not retry the rejected termination");
    expect(workerFactory.calledOnce).to.equal(true);

    replacementWorker.emit("message", {action: "init"});
    const recoveredResult = verifier.verifyTicket(ticket);
    const recoveredRequest = replacementWorker.postMessage.firstCall.args[0].data;
    replacementWorker.emit("message", {
      action: "verified",
      data: {reqId: recoveredRequest.reqId, isValid: true},
    });
    expect(await recoveredResult).to.equal(true);
    await verifier.dispose();
  });

  it("keeps disposal retryable when worker termination rejects", async () => {
    const worker = new EventEmitter() as any;
    worker.postMessage = sinon.spy();
    worker.terminate = sinon.stub();
    worker.terminate.onFirstCall().rejects(new Error("termination rejected"));
    worker.terminate.onSecondCall().resolves(0);
    const workerFactory = sinon.stub();
    const verifier = new ZupassPCD({} as any, worker, {workerFactory});

    const firstDispose = verifier.dispose();
    expect(await firstDispose.catch((error) => error)).to.have.property("message", "termination rejected");
    expect(worker.terminate.calledOnce).to.equal(true);

    const secondDispose = verifier.dispose();
    expect(secondDispose).to.not.equal(firstDispose, "failed disposal returned a permanently rejected drain promise");
    await secondDispose;
    expect(worker.terminate.callCount).to.equal(2, "disposal did not retry the rejected termination");
    expect(verifier.dispose()).to.equal(secondDispose, "successful disposal did not keep its drain promise");
    expect(workerFactory.called).to.equal(false);
  });

  it("does not restart the verifier after disposal", async () => {
    const worker = new EventEmitter() as any;
    worker.postMessage = sinon.spy();
    worker.terminate = sinon.stub().resolves(0);
    const workerFactory = sinon.stub();
    const verifier = new ZupassPCD({} as any, worker, {
      initTimeoutMs: 5,
      verifyTimeoutMs: 100,
      restartBackoffMs: 20,
      maxRestartBackoffMs: 20,
      workerFactory,
    });
    const result = verifier.verifyTicket(
      verifier.parseTicket(JSON.stringify(getValidPcd())),
    ).then(
      () => null,
      (error) => error,
    );
    expect(await result).to.be.instanceOf(Error);
    expect(worker.postMessage.called).to.equal(false);
    expect(worker.terminate.calledOnce).to.equal(true);
    await verifier.dispose();
    await sleepPromise(25);
    expect(workerFactory.called).to.equal(false);
  });

  it("Check zupass grants: limiting grant", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    (faucetConfig.modules["zupass"] as IZupassConfig).grants.push({
      duration: 3600,
      limitAmount: 0,
      limitCount: 1,
      rewardFactor: 2,
      overrideMaxDrop: 2000000000000000000,
      skipModules: ["ipinfo", "ipinfo"]
    }, {
      duration: 3600,
      limitAmount: 0,
      limitCount: 2,
      required: true,
      message: "test_message_4572"
    });
    
    let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      zupassToken: generateTestToken("102c8990-9efc-11ee-85f8-de4e23c7523a", "6768a2e0-986f-11ee-abf3-126a2f5f3c5c", "a1c822c4-60bd-11ee-8732-763dbf30819c", "1"),
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status (1st run)");
    expect(testSession.getDropAmount()).to.equal(2000000000000000000n, "unexpected drop amount (1st run)");
    expect(testSession.getSessionData("skip.modules", []).length).to.equal(1, "unexpected skip.modules count (1st run)");

    
    testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      zupassToken: generateTestToken("102c8990-9efc-11ee-85f8-de4e23c7523a", "6768a2e0-986f-11ee-abf3-126a2f5f3c5c", "a1c822c4-60bd-11ee-8732-763dbf30819c", "1"),
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status (2nd run)");
    expect(testSession.getDropAmount()).to.equal(1000000000000000000n, "unexpected drop amount (2nd run)");
    expect(testSession.getSessionData("skip.modules", []).length).to.equal(0, "unexpected skip.modules count (2nd run)");

    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        zupassToken: generateTestToken("102c8990-9efc-11ee-85f8-de4e23c7523a", "6768a2e0-986f-11ee-abf3-126a2f5f3c5c", "a1c822c4-60bd-11ee-8732-763dbf30819c", "1"),
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("ZUPASS_LIMIT", "unexpected error code");
    expect(error?.message).to.matches(/test_message_4572/, "unexpected error message");
  });

  it("Check zupass grants: count limit", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    (faucetConfig.modules["zupass"] as IZupassConfig).grants.push({
      duration: 3600,
      limitAmount: 0,
      limitCount: 1,
      required: true,
    });

    let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      zupassToken: generateTestToken("102c8990-9efc-11ee-85f8-de4e23c7523a", "6768a2e0-986f-11ee-abf3-126a2f5f3c5c", "a1c822c4-60bd-11ee-8732-763dbf30819c", "1"),
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status (1st run)");
    expect(testSession.getDropAmount()).to.equal(1000000000000000000n, "unexpected drop amount (1st run)");
    expect(testSession.getSessionData("skip.modules", []).length).to.equal(0, "unexpected skip.modules count (1st run)");

    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        zupassToken: generateTestToken("102c8990-9efc-11ee-85f8-de4e23c7523a", "6768a2e0-986f-11ee-abf3-126a2f5f3c5c", "a1c822c4-60bd-11ee-8732-763dbf30819c", "1"),
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("ZUPASS_LIMIT", "unexpected error code");
    expect(error?.message).to.matches(/You have already created/, "unexpected error message");
  });

  it("Check zupass grants: amount limit", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    (faucetConfig.modules["zupass"] as IZupassConfig).grants.push({
      duration: 3600,
      limitAmount: 1000000000000000000,
      limitCount: 0,
      required: true,
    });

    let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      zupassToken: generateTestToken("102c8990-9efc-11ee-85f8-de4e23c7523a", "6768a2e0-986f-11ee-abf3-126a2f5f3c5c", "a1c822c4-60bd-11ee-8732-763dbf30819c", "1"),
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status (1st run)");
    expect(testSession.getDropAmount()).to.equal(1000000000000000000n, "unexpected drop amount (1st run)");
    expect(testSession.getSessionData("skip.modules", []).length).to.equal(0, "unexpected skip.modules count (1st run)");

    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        zupassToken: generateTestToken("102c8990-9efc-11ee-85f8-de4e23c7523a", "6768a2e0-986f-11ee-abf3-126a2f5f3c5c", "a1c822c4-60bd-11ee-8732-763dbf30819c", "1"),
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("ZUPASS_LIMIT", "unexpected error code");
    expect(error?.message).to.matches(/You have already requested/, "unexpected error message");
  });

  it("Check zupass grants: amount limit, custom error", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    (faucetConfig.modules["zupass"] as IZupassConfig).grants.push({
      duration: 3600,
      limitAmount: 1000000000000000000,
      limitCount: 0,
      required: true,
      message: "test_message_4574"
    });

    let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      zupassToken: generateTestToken("102c8990-9efc-11ee-85f8-de4e23c7523a", "6768a2e0-986f-11ee-abf3-126a2f5f3c5c", "a1c822c4-60bd-11ee-8732-763dbf30819c", "1"),
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status (1st run)");
    expect(testSession.getDropAmount()).to.equal(1000000000000000000n, "unexpected drop amount (1st run)");
    expect(testSession.getSessionData("skip.modules", []).length).to.equal(0, "unexpected skip.modules count (1st run)");

    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        zupassToken: generateTestToken("102c8990-9efc-11ee-85f8-de4e23c7523a", "6768a2e0-986f-11ee-abf3-126a2f5f3c5c", "a1c822c4-60bd-11ee-8732-763dbf30819c", "1"),
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("ZUPASS_LIMIT", "unexpected error code");
    expect(error?.message).to.matches(/test_message_4574/, "unexpected error message");
  });

  it("Check zupass concurrency limit", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test", 1);
    });

    let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      zupassToken: generateTestToken("102c8990-9efc-11ee-85f8-de4e23c7523a", "6768a2e0-986f-11ee-abf3-126a2f5f3c5c", "a1c822c4-60bd-11ee-8732-763dbf30819c", "1"),
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status (1st run)");

    await sleepPromise(50);

    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        zupassToken: generateTestToken("102c8990-9efc-11ee-85f8-de4e23c7523a", "6768a2e0-986f-11ee-abf3-126a2f5f3c5c", "a1c822c4-60bd-11ee-8732-763dbf30819c", "1"),
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("ZUPASS_CONCURRENCY_LIMIT", "unexpected error code");
    expect(error?.message).to.matches(/concurrent sessions/, "unexpected error message");
  });

  it("admits only the first concurrent start for one ticket holder", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "blocker", (session: FaucetSession) => {
      session.addBlockingTask("test", "test", 10);
    });
    let token = generateTestToken(
      "102c8990-9efc-11ee-85f8-de4e23c7523a",
      "6768a2e0-986f-11ee-abf3-126a2f5f3c5c",
      "a1c822c4-60bd-11ee-8732-763dbf30819c",
      "1",
    );
    let sessionManager = ServiceManager.GetService(SessionManager);
    let results = await Promise.allSettled([
      sessionManager.createSession("8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        zupassToken: token,
      }),
      sessionManager.createSession("8.8.4.4", {
        addr: "0x0000000000000000000000000000000000001338",
        zupassToken: token,
      }),
    ]);
    let fulfilled = results.filter((result) => result.status === "fulfilled") as PromiseFulfilledResult<FaucetSession>[];
    let rejected = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];

    expect(fulfilled.length).to.equal(1);
    expect(fulfilled[0].value.getSessionStatus()).to.equal(FaucetSessionStatus.RUNNING);
    expect(rejected.length).to.equal(1);
    expect(rejected[0].reason).to.be.instanceOf(FaucetError);
    expect(rejected[0].reason.getCode()).to.equal("ZUPASS_CONCURRENCY_LIMIT");
  });

  it("restores ticket-holder reservations before admitting new traffic", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    let now = Math.floor(Date.now() / 1000);
    await ServiceManager.GetService(FaucetDatabase).updateSession({
      sessionId: "4e63566e-e482-46f3-bb91-da11f511c003",
      status: FaucetSessionStatus.RUNNING,
      startTime: now,
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1000000000000000000",
      remoteIP: "8.8.8.8",
      tasks: [{module: "test", name: "test", timeout: 0}],
      data: {
        "zupass.data": {
          ticketId: "102c8990-9efc-11ee-85f8-de4e23c7523a",
          productId: "6768a2e0-986f-11ee-abf3-126a2f5f3c5c",
          eventId: "a1c822c4-60bd-11ee-8732-763dbf30819c",
          attendeeId: "1",
          token: "",
        },
      },
      claim: null,
    });

    let sessionManager = ServiceManager.GetService(SessionManager);
    await sessionManager.initialize();
    let error: FaucetError | null = null;
    try {
      await sessionManager.createSession("8.8.4.4", {
        addr: "0x0000000000000000000000000000000000001338",
        zupassToken: generateTestToken(
          "102c8990-9efc-11ee-85f8-de4e23c7523a",
          "6768a2e0-986f-11ee-abf3-126a2f5f3c5c",
          "a1c822c4-60bd-11ee-8732-763dbf30819c",
          "1",
        ),
      });
    } catch(ex) {
      error = ex;
    }
    expect(error?.getCode()).to.equal("ZUPASS_CONCURRENCY_LIMIT");
  });

  it("Rejects invalid callback context before parsing a proof", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const module = ServiceManager.GetService(ModuleManager).getModule<any>("zupass");
    const parseTicket = sinon.spy(module.zupassPCD, "parseTicket");
    const proof = encodeURIComponent(JSON.stringify({
      type: "zk-eddsa-event-ticket-pcd",
      pcd: JSON.stringify(getValidPcd()),
    }));

    try {
      for(const url of [
        `/api/zupassCallback?proof=${proof}`,
        withCallbackContext(`/api/zupassCallback?proof=${proof}`, CALLBACK_ORIGIN, "A".repeat(64)),
        withCallbackContext(`/api/zupassCallback?proof=${proof}`, "https://attacker.example"),
      ]) {
        const callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({ method: "GET", url } as any);
        expect(callbackRsp.code).to.equal(400);
        expect(callbackRsp.headers["Cache-Control"]).to.equal("no-store");
        expect(callbackRsp.body).to.equal("Invalid authentication callback request.");
      }
      expect(parseTicket.callCount).to.equal(0);
    } finally {
      parseTicket.restore();
    }
  });

  it("requires an origin-bound POST before allocating a challenge", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const loginUrl = withCallbackContext("/api/zupassLogin");

    const getResponse = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: loginUrl,
      headers: { origin: CALLBACK_ORIGIN },
      socket: { remoteAddress: "8.8.8.8" },
    } as any);
    expect(getResponse.code).to.equal(405);
    expect(getResponse.headers.Allow).to.equal("POST");

    for(const requestOrigin of [undefined, "not an origin", "https://attacker.example"]) {
      const headers: Record<string, string> = {};
      if(requestOrigin !== undefined)
        headers.origin = requestOrigin;
      const rejectedResponse = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
        method: "POST",
        url: loginUrl,
        headers,
        socket: { remoteAddress: "8.8.8.8" },
      } as any);
      expect(rejectedResponse.code).to.equal(400);
      expect(rejectedResponse.body).to.equal("Invalid authentication callback request.");
    }

    for(let index = 0; index < 8; index++)
      await issueChallenge(index.toString(16).padStart(64, "0"), "8.8.8.8");

    const capacityResponse = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "POST",
      url: withCallbackContext("/api/zupassLogin", CALLBACK_ORIGIN, "a".repeat(64)),
      headers: { origin: CALLBACK_ORIGIN },
      socket: { remoteAddress: "8.8.8.8" },
    } as any);
    expect(capacityResponse.code).to.equal(503);
  });

  it("allows a configured split-origin client to issue a challenge", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const clientOrigin = "https://client.example";
    faucetConfig.corsAllowOrigin = [clientOrigin];

    const challenge = await issueChallenge(AUTH_STATE, "8.8.8.8", clientOrigin);
    expect(challenge.callbackUrl.searchParams.get("clientOrigin")).to.equal(clientOrigin);
  });

  it("bounds pending challenges per canonical client IP and releases consumed slots", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const challenges: Awaited<ReturnType<typeof issueChallenge>>[] = [];
    for(let index = 0; index < 8; index++) {
      const state = index.toString(16).padStart(64, "0");
      const remoteAddress = index % 2 === 0 ? "8.8.8.8" : "::ffff:8.8.8.8";
      challenges.push(await issueChallenge(state, remoteAddress));
    }

    const capacityResponse = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "POST",
      url: withCallbackContext("/api/zupassLogin", CALLBACK_ORIGIN, "a".repeat(64)),
      headers: { origin: CALLBACK_ORIGIN },
      socket: { remoteAddress: "8.8.8.8" },
    } as any);
    expect(capacityResponse.code).to.equal(503);

    const otherOwnerChallenge = await issueChallenge("b".repeat(64), "8.8.4.4");
    expect(otherOwnerChallenge.callbackUrl.searchParams.get("challenge")).to.match(/^[0-9a-f]{64}$/);

    const consumeResponse = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: callbackPath(challenges[0].callbackUrl),
      socket: {remoteAddress: "127.0.0.1"},
    } as any);
    expectRestartRequired(consumeResponse);

    const replacementChallenge = await issueChallenge("c".repeat(64), "8.8.8.8");
    expect(replacementChallenge.callbackUrl.searchParams.get("challenge")).to.match(/^[0-9a-f]{64}$/);

    const module = ServiceManager.GetService(ModuleManager).getModule<any>("zupass");
    let now = 1_000;
    const expiringStore = new ZupassChallengeStore({
      maxPendingPerOwner: 1,
      now: () => now,
    });
    const challengeContext = {
      authState: "d".repeat(64),
      callbackOrigin: CALLBACK_ORIGIN,
      clientOrigin: CALLBACK_ORIGIN,
      sameOrigin: true,
    };
    expiringStore.issue(challengeContext, module.getVerifierPolicy(), "8.8.8.8");
    expect(() => expiringStore.issue(
      {...challengeContext, authState: "e".repeat(64)},
      module.getVerifierPolicy(),
      "8.8.8.8",
    )).to.throw("capacity");
    now += module.getVerifierPolicy().challengeLifetimeSeconds;
    expect(() => expiringStore.issue(
      {...challengeContext, authState: "f".repeat(64)},
      module.getVerifierPolicy(),
      "8.8.8.8",
    )).to.not.throw();
  });

  it("rate-limits sequential challenge and callback churn until the challenge window expires", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const module = ServiceManager.GetService(ModuleManager).getModule<any>("zupass");
    const policy = module.getVerifierPolicy();
    let now = 1_000;
    const store = new ZupassChallengeStore({
      maxIssuesPerOwner: 2,
      maxCallbacksPerOwner: 2,
      maxRateOwners: 8,
      rateWindowSeconds: 10,
      now: () => now,
    } as any);
    const context = (state: string) => ({
      authState: state.repeat(64),
      callbackOrigin: CALLBACK_ORIGIN,
      clientOrigin: CALLBACK_ORIGIN,
      sameOrigin: true,
    });

    store.issue(context("1"), policy, "8.8.8.8");
    const replacement = store.issue(context("1"), policy, "8.8.8.8");
    expect(() => store.issue(context("2"), policy, "8.8.8.8")).to.throw("issue rate limit");
    store.discard(replacement.id);

    now += 10;
    const first = store.issue(context("3"), policy, "8.8.8.8");
    const second = store.issue(context("4"), policy, "8.8.8.8");
    expect(store.consume(first.id, context("3"), policy, "8.8.8.8").kind).to.equal("accepted");
    expect(store.consume(second.id, context("4"), policy, "8.8.8.8").kind).to.equal("accepted");

    now += 1;
    const deferred = store.issue(context("5"), policy, "8.8.4.4");
    const limited = store.consume(deferred.id, context("5"), policy, "8.8.8.8");
    expect(limited).to.deep.equal({kind: "rejected", reason: "rate"});
    expect(store.size).to.equal(1, "rate-limited callback consumed its pending challenge");

    now += 9;
    expect(store.consume(deferred.id, context("5"), policy, "8.8.8.8").kind).to.equal("accepted");
  });

  it("rejects oversized and malformed proofs before verifier work", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const module = ServiceManager.GetService(ModuleManager).getModule<any>("zupass");
    const parseTicket = sinon.spy(module.zupassPCD, "parseTicket");
    const verifyTicket = sinon.stub(module.zupassPCD, "verifyTicket").resolves(true);

    try {
      const oversizedChallenge = await issueChallenge("1".repeat(64));
      const oversizedResponse = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
        method: "GET",
        url: callbackPath(oversizedChallenge.callbackUrl, {
          type: "zk-eddsa-event-ticket-pcd",
          pcd: "x".repeat(64 * 1024),
        }),
        socket: {remoteAddress: "127.0.0.1"},
      } as any);
      expectRestartRequired(oversizedResponse);
      expect(parseTicket.callCount).to.equal(0, "oversized envelope reached JSONBig parsing");
      expect(verifyTicket.callCount).to.equal(0);

      const malformedChallenge = await issueChallenge("2".repeat(64));
      const malformedPcd = getValidPcd();
      bindProofToChallenge(malformedPcd, malformedChallenge);
      malformedPcd.claim.validEventIds = new Array(21).fill("a1c822c4-60bd-11ee-8732-763dbf30819c");
      const malformedResponse = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
        method: "GET",
        url: callbackPath(malformedChallenge.callbackUrl, {
          type: "zk-eddsa-event-ticket-pcd",
          pcd: JSON.stringify(malformedPcd),
        }),
        socket: {remoteAddress: "127.0.0.1"},
      } as any);
      expectRestartRequired(malformedResponse);
      expect(parseTicket.callCount).to.equal(1);
      expect(verifyTicket.callCount).to.equal(0, "malformed ticket reached public-signal generation");

      const deeplyNested = "[".repeat(32) + "0" + "]".repeat(32);
      expect(() => module.zupassPCD.parseTicket(deeplyNested)).to.throw("nesting");

      const invalidDimensions = getValidPcd();
      invalidDimensions.proof.pi_a.push("0");
      expect(() => module.zupassPCD.parseTicket(JSON.stringify(invalidDimensions))).to.throw("structure");
      const oversizedCoordinate = getValidPcd();
      oversizedCoordinate.proof.pi_c[0] = "1".repeat(81);
      expect(() => module.zupassPCD.parseTicket(JSON.stringify(oversizedCoordinate))).to.throw("structure");
    } finally {
      parseTicket.restore();
      verifyTicket.restore();
    }
  });

  it("reserves verifier capacity before parsing callback proofs", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const module = ServiceManager.GetService(ModuleManager).getModule<any>("zupass");
    const verifier = module.zupassPCD;
    const admissions: any[] = [];
    for(let index = 0; index < 32; index++) {
      try {
        admissions.push(verifier.reserveVerification());
      } catch {
        break;
      }
    }
    expect(admissions.length).to.equal(16);
    const parseTicket = sinon.spy(verifier, "parseTicket");

    try {
      const challenge = await issueChallenge("3".repeat(64));
      const pcd = getValidPcd();
      bindProofToChallenge(pcd, challenge);
      const response = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
        method: "GET",
        url: callbackPath(challenge.callbackUrl, {
          type: "zk-eddsa-event-ticket-pcd",
          pcd: JSON.stringify(pcd),
        }),
        socket: {remoteAddress: "127.0.0.1"},
      } as any);
      expectRestartRequired(response);
      expect(parseTicket.callCount).to.equal(0, "busy verifier parsed a callback before admission");
    } finally {
      parseTicket.restore();
      admissions.forEach((admission) => verifier.releaseVerification(admission));
    }
  });

  it("rejects a callback with a missing proof and consumes its challenge", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const challenge = await issueChallenge();
    const callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: callbackPath(challenge.callbackUrl),
      socket: {remoteAddress: "127.0.0.1"},
    } as any);
    expectRestartRequired(callbackRsp);

    const replayRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: callbackPath(challenge.callbackUrl),
      socket: {remoteAddress: "127.0.0.1"},
    } as any);
    expectRestartRequired(replayRsp);
  });

  it("rejects an invalid proof type without exposing verifier details", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const challenge = await issueChallenge();
    const callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: callbackPath(challenge.callbackUrl, { type: "invalid-type", pcd: JSON.stringify(getValidPcd()) }),
      socket: {remoteAddress: "127.0.0.1"},
    } as any);
    expectRestartRequired(callbackRsp);
  });

  for(const testCase of [
    {
      name: "watermark",
      mutate: (pcd: ReturnType<typeof getValidPcd>) => { pcd.claim.watermark = "1"; },
    },
    {
      name: "external nullifier",
      mutate: (pcd: ReturnType<typeof getValidPcd>) => { pcd.claim.externalNullifier = "1"; },
    },
    {
      name: "required fields",
      mutate: (pcd: ReturnType<typeof getValidPcd>) => { delete pcd.claim.partialTicket.productId; },
    },
    {
      name: "signer",
      mutate: (pcd: ReturnType<typeof getValidPcd>) => { pcd.claim.signer = ["xxx", "yyy"]; },
    },
    {
      name: "event",
      mutate: (pcd: ReturnType<typeof getValidPcd>) => {
        pcd.claim.partialTicket.eventId = "6768a2e0-986f-11ee-abf3-126a2f5f3c5d";
      },
    },
  ]) {
    it(`rejects a proof with an invalid ${testCase.name}`, async () => {
      await ServiceManager.GetService(ModuleManager).initialize();
      const challenge = await issueChallenge();
      const pcd = getValidPcd();
      bindProofToChallenge(pcd, challenge);
      testCase.mutate(pcd);
      const callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
        method: "GET",
        url: callbackPath(challenge.callbackUrl, {
          type: "zk-eddsa-event-ticket-pcd",
          pcd: JSON.stringify(pcd),
        }),
        socket: {remoteAddress: "127.0.0.1"},
      } as any);
      expectRestartRequired(callbackRsp);
    });
  }

  for(const field of ["isConsumed", "isRevoked"] as const) {
    it(`rejects a ${field} ticket`, async () => {
      await ServiceManager.GetService(ModuleManager).initialize();
      const module = ServiceManager.GetService(ModuleManager).getModule<any>("zupass");
      const verifyTicket = sinon.stub(module.zupassPCD, "verifyTicket").resolves(true);
      const challenge = await issueChallenge();
      const pcd = getValidPcd();
      bindProofToChallenge(pcd, challenge);
      pcd.claim.partialTicket[field] = true;
      const callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
        method: "GET",
        url: callbackPath(challenge.callbackUrl, {
          type: "zk-eddsa-event-ticket-pcd",
          pcd: JSON.stringify(pcd),
        }),
        socket: {remoteAddress: "127.0.0.1"},
      } as any);
      expectRestartRequired(callbackRsp);
      expect(verifyTicket.called).to.equal(false, "invalid ticket reached cryptographic verification");
    });
  }

  it("rejects a product outside the verifier policy", async () => {
    (faucetConfig.modules["zupass"] as IZupassConfig).event.productIds = [
      "6768a2e0-986f-11ee-abf3-126a2f5f3c5d",
    ];
    await ServiceManager.GetService(ModuleManager).initialize();
    const challenge = await issueChallenge();
    const pcd = getValidPcd();
    bindProofToChallenge(pcd, challenge);
    const callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: callbackPath(challenge.callbackUrl, {
        type: "zk-eddsa-event-ticket-pcd",
        pcd: JSON.stringify(pcd),
      }),
      socket: {remoteAddress: "127.0.0.1"},
    } as any);
    expectRestartRequired(callbackRsp);
  });

  it("rejects a proof that fails cryptographic verification", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const module = ServiceManager.GetService(ModuleManager).getModule<any>("zupass");
    const verifyTicket = sinon.stub(module.zupassPCD, "verifyTicket").resolves(false);
    const challenge = await issueChallenge();
    const pcd = getValidPcd();
    bindProofToChallenge(pcd, challenge);
    const callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: callbackPath(challenge.callbackUrl, {
        type: "zk-eddsa-event-ticket-pcd",
        pcd: JSON.stringify(pcd),
      }),
      socket: {remoteAddress: "127.0.0.1"},
    } as any);
    expectRestartRequired(callbackRsp);
    expect(verifyTicket.calledOnce).to.equal(true);
  });

  it("accepts one challenge-bound proof exactly once", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const module = ServiceManager.GetService(ModuleManager).getModule<any>("zupass");
    const verifyTicket = sinon.stub(module.zupassPCD, "verifyTicket").resolves(true);
    const challenge = await issueChallenge();
    const pcd: any = getValidPcd();
    bindProofToChallenge(pcd, challenge);
    delete pcd.type;
    pcd.metadata = {source: "bounded metadata"};
    pcd.claim.metadata = "bounded metadata";
    pcd.claim.partialTicket.attendeeName = "";
    pcd.claim.partialTicket.ticketCategory = 4;
    const callbackUrl = callbackPath(challenge.callbackUrl, {
      type: "zk-eddsa-event-ticket-pcd",
      pcd: JSON.stringify(pcd),
      metadata: "bounded metadata",
    });
    const callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: callbackUrl,
      socket: {remoteAddress: "127.0.0.1"},
    } as any);
    expect(callbackRsp.code).to.equal(200);
    expect(callbackRsp.headers["Cache-Control"]).to.equal("no-store");
    expect(callbackRsp.headers["X-Frame-Options"]).to.equal("DENY");
    expect(callbackRsp.body).to.include('authModule":"zupass"');
    expect(callbackRsp.body).to.include(`authState":"${AUTH_STATE}"`);
    expect(callbackRsp.body).to.include(`targetOrigin = "${CALLBACK_ORIGIN}"`);
    expect(callbackRsp.body).to.include("attendeeId");
    expect(verifyTicket.calledOnce).to.equal(true);

    const replayRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: callbackUrl,
      socket: {remoteAddress: "127.0.0.1"},
    } as any);
    expectRestartRequired(replayRsp);
    expect(verifyTicket.calledOnce).to.equal(true);
  });

});
