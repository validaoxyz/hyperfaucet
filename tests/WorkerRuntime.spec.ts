import "mocha";
import { expect } from "chai";
import type { ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import { fileURLToPath } from "node:url";

import { FaucetWorkers } from "../src/common/FaucetWorker.js";
import { defaultConfig as defaultPoWConfig } from "../src/modules/pow/PoWConfig.js";
import { ZupassPCD } from "../src/modules/zupass/ZupassPCD.js";
import { DATA as passportTestData } from "./modules/PassportModule.data.js";

const EVENT_TIMEOUT_MS = 10_000;
const PASSPORT_INIT_TIMEOUT_MS = 120_000;
const POW_INIT_TIMEOUT_MS = 20_000;
const ZUPASS_INIT_TIMEOUT_MS = 30_000;
const ZUPASS_VERIFY_TIMEOUT_MS = 30_000;
const LOOPBACK_TIMEOUT_MS = 10_000;
const WORKER_ENTRY_PATH = fileURLToPath(new URL("../src/app.js", import.meta.url));

interface MessageSource {
  on(event: "message", listener: (message: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "message", listener: (message: unknown) => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
}

function withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = EVENT_TIMEOUT_MS): Promise<T> {
  let timeout: NodeJS.Timeout;
  let timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function waitForMessage<T>(
  source: MessageSource,
  predicate: (message: unknown) => message is T,
  timeoutMessage: string,
  timeoutMs = EVENT_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timeout = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    let cleanup = () => {
      clearTimeout(timeout);
      source.removeListener("message", onMessage);
      source.removeListener("error", onError);
    };
    let onMessage = (message: unknown) => {
      if(!predicate(message))
        return;
      cleanup();
      resolve(message);
    };
    let onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    source.on("message", onMessage);
    source.on("error", onError);
  });
}

function sendChildMessage(
  child: ChildProcess,
  message: {action: string, [key: string]: unknown},
  socket?: Socket,
): Promise<void> {
  let sendPromise = new Promise<void>((resolve, reject) => {
    let callback = (error: Error | null) => error ? reject(error) : resolve();
    if(socket)
      child.send(message, socket, {keepOpen: true}, callback);
    else
      child.send(message, callback);
  });
  return withTimeout(sendPromise, `Timed out sending ${message.action} to the PoW child`);
}

function beginServerClose(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function closeServer(server: Server, closePromise?: Promise<void>): Promise<void> {
  if(!closePromise && !server.listening)
    return Promise.resolve();
  return withTimeout(
    closePromise ?? beginServerClose(server),
    "Loopback server did not close",
    LOOPBACK_TIMEOUT_MS,
  );
}

function closeSocket(socket?: Socket): Promise<void> {
  if(!socket || socket.closed)
    return Promise.resolve();
  let closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.destroy();
  return withTimeout(closed, "Loopback socket did not close", LOOPBACK_TIMEOUT_MS);
}

function collectRejected(results: PromiseSettledResult<unknown>[], errors: unknown[]): void {
  for(let result of results) {
    if(result.status === "rejected")
      errors.push(result.reason);
  }
}

function throwCollected(errors: unknown[], message: string): void {
  if(errors.length === 0)
    return;
  if(errors.length === 1)
    throw errors[0];
  throw new AggregateError(errors, message);
}

async function drainChild(
  child: ChildProcess,
  closePromise: Promise<{code: number | null, signal: NodeJS.Signals | null}>,
): Promise<void> {
  if(child.exitCode !== null || child.signalCode !== null) {
    await withTimeout(closePromise, "Owned PoW child close was not observed", LOOPBACK_TIMEOUT_MS);
    return;
  }

  child.kill("SIGTERM");
  try {
    await withTimeout(closePromise, "Owned PoW child did not exit after SIGTERM", LOOPBACK_TIMEOUT_MS);
  }
  catch(error) {
    if(child.exitCode !== null || child.signalCode !== null)
      throw error;
    child.kill("SIGKILL");
    try {
      await withTimeout(closePromise, "Owned PoW child did not exit after SIGKILL", LOOPBACK_TIMEOUT_MS);
    }
    catch(killError) {
      throw new AggregateError([error, killError], "Could not drain the owned PoW child");
    }
  }
}

function getValidZupassPcd() {
  return {
    "id": "08f3ab85-2849-4b9b-a87c-970d14b342cd",
    "claim": {
      "partialTicket": {
        "ticketId": "102c8990-9efc-11ee-85f8-de4e23c7523a",
        "eventId": "a1c822c4-60bd-11ee-8732-763dbf30819c",
        "productId": "6768a2e0-986f-11ee-abf3-126a2f5f3c5c",
        "attendeeSemaphoreId": "13741484094604222573966014497321470030869540832333932860622584807523008667804"
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

describe("Worker runtime", () => {
  it("runs real Zupass Groth16 verification and terminates the worker", async function() {
    this.timeout(90_000);
    let workers = new FaucetWorkers();
    workers.initialize(WORKER_ENTRY_PATH);
    let worker = workers.createWorker("zupass-worker");
    let initPromise = waitForMessage(
      worker,
      (message): message is {action: "init" | "error"} => (
        typeof message === "object"
        && message !== null
        && ["init", "error"].includes((message as {action?: string}).action)
      ),
      "Zupass worker did not initialize",
      ZUPASS_INIT_TIMEOUT_MS,
    );
    let verifier = new ZupassPCD({} as any, worker, {
      initTimeoutMs: ZUPASS_INIT_TIMEOUT_MS,
      verifyTimeoutMs: ZUPASS_VERIFY_TIMEOUT_MS,
    });
    let errors: unknown[] = [];

    try {
      let init = await initPromise;
      expect(init.action).to.equal("init");

      let validPcd = getValidZupassPcd();
      let validResult = verifier.verifyTicket(verifier.parseTicket(JSON.stringify(validPcd)));
      expect(await withTimeout(
        validResult,
        "Zupass worker did not verify the valid proof",
        ZUPASS_VERIFY_TIMEOUT_MS + EVENT_TIMEOUT_MS,
      )).to.equal(true);

      let tamperedPcd = getValidZupassPcd();
      tamperedPcd.claim.watermark = (BigInt(tamperedPcd.claim.watermark) + 1n).toString();
      let tamperedResult = verifier.verifyTicket(verifier.parseTicket(JSON.stringify(tamperedPcd)));
      expect(await withTimeout(
        tamperedResult,
        "Zupass worker did not reject the claim-mutated proof",
        ZUPASS_VERIFY_TIMEOUT_MS + EVENT_TIMEOUT_MS,
      )).to.equal(false);
    }
    catch(error) {
      errors.push(error);
    }

    let terminationPromise = verifier.dispose();
    let exitPromise = new Promise<number>((resolve) => worker.once("exit", resolve));
    let workerCleanup = await Promise.allSettled([
      withTimeout(
        terminationPromise,
        "Zupass worker termination did not complete",
        LOOPBACK_TIMEOUT_MS,
      ),
      withTimeout(exitPromise, "Zupass worker exit was not observed", LOOPBACK_TIMEOUT_MS),
    ]);
    collectRejected(workerCleanup, errors);
    if(workerCleanup[0].status === "fulfilled" && workerCleanup[1].status === "fulfilled") {
      try {
        expect(workerCleanup[1].value).to.be.a("number");
        expect(worker.threadId).to.equal(-1);
      }
      catch(error) {
        errors.push(error);
      }
    }
    throwCollected(errors, "Zupass worker runtime test failed");
  });

  it("runs Passport verification through the application worker dispatch and terminates it", async function() {
    this.timeout(150_000);
    let workers = new FaucetWorkers();
    workers.initialize(WORKER_ENTRY_PATH);
    let worker = workers.createWorker("passport-worker");
    let exitPromise = new Promise<number>((resolve) => worker.once("exit", resolve));
    let errors: unknown[] = [];

    try {
      let init = await waitForMessage(
        worker,
        (message): message is {action: "init" | "init-error"} => (
          typeof message === "object"
          && message !== null
          && ["init", "init-error"].includes((message as {action?: string}).action)
        ),
        "Passport worker did not initialize",
        PASSPORT_INIT_TIMEOUT_MS,
      );
      expect(init.action).to.equal("init");

      let reqId = 42;
      let credential = (passportTestData as any).testPassport1Json.stamps[0].credential;
      let resultPromise = waitForMessage(
        worker,
        (message): message is {action: "verified" | "verification-error", data: {reqId: number, result?: string}} => {
          if(typeof message !== "object" || message === null)
            return false;
          let response = message as {action?: string, data?: {reqId?: number}};
          return ["verified", "verification-error"].includes(response.action)
            && response.data?.reqId === reqId;
        },
        "Passport worker did not answer a verification request",
      );
      worker.postMessage({
        action: "verify",
        data: {
          reqId,
          credentialJson: JSON.stringify(credential),
          proofOptionsJson: JSON.stringify({proofPurpose: credential.proof.proofPurpose}),
        },
      });

      let result = await resultPromise;
      expect(result.data.reqId).to.equal(reqId);
      expect(result.action).to.equal("verified");
      expect(result.data.result).to.be.a("string");
      let verification = JSON.parse(result.data.result as string);
      expect(verification.checks).to.include("proof");
      expect(verification.errors).to.deep.equal([]);
    }
    catch(error) {
      errors.push(error);
    }

    let workerCleanup = await Promise.allSettled([
      withTimeout(
        Promise.resolve().then(() => worker.terminate()),
        "Passport worker did not terminate",
        LOOPBACK_TIMEOUT_MS,
      ),
      withTimeout(exitPromise, "Passport worker exit was not observed", LOOPBACK_TIMEOUT_MS),
    ]);
    collectRejected(workerCleanup, errors);
    if(workerCleanup[0].status === "fulfilled" && workerCleanup[1].status === "fulfilled") {
      try {
        expect(workerCleanup[1].value).to.equal(workerCleanup[0].value);
        expect(worker.threadId).to.equal(-1);
      }
      catch(error) {
        errors.push(error);
      }
    }
    throwCollected(errors, "Passport worker runtime test failed");
  });

  it("hands a loopback socket to the PoW child and waits for clean shutdown", async function() {
    this.timeout(180_000);
    let workers = new FaucetWorkers();
    workers.initialize(WORKER_ENTRY_PATH);
    let ownedChild = workers.createChildProcess("pow-server");
    let child = ownedChild.childProcess;
    let childErrors: Error[] = [];
    child.on("error", (error) => childErrors.push(error));
    let closePromise = new Promise<{code: number | null, signal: NodeJS.Signals | null}>((resolve) => {
      child.once("close", (code, signal) => resolve({code, signal}));
    });
    let server = createServer({pauseOnConnect: true});
    let acceptedSocket: Socket;
    let clientSocket: Socket;
    let serverClosePromise: Promise<void>;
    let errors: unknown[] = [];

    try {
      let init = await waitForMessage(
        child,
        (message): message is {action: "init"} => (
          typeof message === "object"
          && message !== null
          && (message as {action?: string}).action === "init"
        ),
        "PoW child did not initialize",
        POW_INIT_TIMEOUT_MS,
      );
      expect(init.action).to.equal("init");
      await sendChildMessage(child, {
        action: "pow-update-config",
        config: {...defaultPoWConfig, enabled: true},
      });

      let acceptedPromise = withTimeout(new Promise<Socket>((resolve, reject) => {
        server.once("connection", resolve);
        server.once("error", reject);
      }), "Loopback server did not accept a socket", LOOPBACK_TIMEOUT_MS);
      await withTimeout(new Promise<void>((resolve, reject) => {
        server.listen(0, "127.0.0.1", resolve);
        server.once("error", reject);
      }), "Loopback server did not listen", LOOPBACK_TIMEOUT_MS);

      let address = server.address() as AddressInfo;
      clientSocket = createConnection({host: "127.0.0.1", port: address.port});
      await withTimeout(new Promise<void>((resolve, reject) => {
        clientSocket.once("connect", resolve);
        clientSocket.once("error", reject);
      }), "Loopback client did not connect", LOOPBACK_TIMEOUT_MS);
      acceptedSocket = await acceptedPromise;
      serverClosePromise = beginServerClose(server);

      let response = "";
      let handshakePromise = withTimeout(new Promise<string>((resolve, reject) => {
        let onData = (data: Buffer) => {
          response += data.toString("utf8");
          if(response.includes("101 Switching Protocols")) {
            clientSocket.removeListener("data", onData);
            clientSocket.removeListener("error", onError);
            resolve(response);
          }
        };
        let onError = (error: Error) => {
          clientSocket.removeListener("data", onData);
          reject(error);
        };
        clientSocket.on("data", onData);
        clientSocket.once("error", onError);
      }), "PoW child did not answer the handed-off socket", EVENT_TIMEOUT_MS);

      await sendChildMessage(child, {
        action: "pow-connect",
        sessionId: "missing-session",
        url: "/pow",
        method: "GET",
        headers: {
          connection: "Upgrade",
          host: `127.0.0.1:${address.port}`,
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
          upgrade: "websocket",
        },
        head: "",
      }, acceptedSocket);
      expect(await handshakePromise).to.contain("101 Switching Protocols");

      await sendChildMessage(child, {action: "pow-shutdown"});
      let close = await withTimeout(closePromise, "PoW child did not shut down");
      expect(close).to.deep.equal({code: 0, signal: null});
      expect(childErrors).to.deep.equal([]);
    }
    catch(error) {
      errors.push(error);
    }
    finally {
      let cleanupErrors: unknown[] = [];
      try {
        let socketCleanup = await Promise.allSettled([
          Promise.resolve().then(() => closeSocket(clientSocket)),
          Promise.resolve().then(() => closeSocket(acceptedSocket)),
        ]);
        collectRejected(socketCleanup, cleanupErrors);
      }
      finally {
        try {
          await drainChild(child, closePromise);
        }
        catch(error) {
          cleanupErrors.push(error);
        }
        finally {
          let serverCleanup = await Promise.allSettled([
            Promise.resolve().then(() => closeServer(server, serverClosePromise)),
          ]);
          collectRejected(serverCleanup, cleanupErrors);
        }
      }
      errors.push(...cleanupErrors);
    }
    throwCollected(errors, "PoW child runtime test failed");
  });
});
