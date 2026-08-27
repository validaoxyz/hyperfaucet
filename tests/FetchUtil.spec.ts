import "mocha";
import { expect } from "chai";
import { createServer, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import sinon from "sinon";
import { FetchUtil } from "../src/utils/FetchUtil.js";

const RESPONSE_LIMIT = 64;
const REQUEST_TIMEOUT = 500;

interface FetchFailure {
  message?: string;
  type?: string;
}

function jsonBodyOfSize(size: number): string {
  return JSON.stringify("x".repeat(size - 2));
}

function sendDeclaredJson(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json",
  });
  response.end(body);
}

function sendChunkedJson(response: ServerResponse, body: string): void {
  const midpoint = Math.floor(body.length / 2);
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Transfer-Encoding": "chunked",
  });
  response.write(body.slice(0, midpoint));
  response.end(body.slice(midpoint));
}

function sendSlowJson(response: ServerResponse): void {
  response.writeHead(200, {
    "Content-Type": "application/json",
    "Transfer-Encoding": "chunked",
  });
  response.write('{"ok":');

  const finishTimer = setTimeout(() => response.end("true}"), 250);
  response.once("close", () => clearTimeout(finishTimer));
}

async function captureRejection(request: Promise<unknown>): Promise<FetchFailure> {
  try {
    await request;
  } catch(error) {
    return error as FetchFailure;
  }

  throw new Error("Expected request to reject");
}

describe("FetchUtil response boundaries", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    const exactBody = jsonBodyOfSize(RESPONSE_LIMIT);
    const oversizedBody = jsonBodyOfSize(RESPONSE_LIMIT + 1);

    server = createServer((request, response) => {
      switch(request.url) {
        case "/declared/exact":
          sendDeclaredJson(response, exactBody);
          return;
        case "/declared/oversized":
          sendDeclaredJson(response, oversizedBody);
          return;
        case "/chunked/exact":
          sendChunkedJson(response, exactBody);
          return;
        case "/chunked/oversized":
          sendChunkedJson(response, oversizedBody);
          return;
        case "/slow":
          sendSlowJson(response);
          return;
        case "/healthy":
          sendDeclaredJson(response, JSON.stringify({ok: true}));
          return;
        default:
          response.writeHead(404);
          response.end();
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(() => sinon.restore());

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  });

  async function expectHealthyRequest(): Promise<void> {
    const result = await FetchUtil.fetchBoundedJson(`${baseUrl}/healthy`, {
      maxResponseBytes: RESPONSE_LIMIT,
      timeoutMs: REQUEST_TIMEOUT,
    });
    expect(result).to.deep.equal({ok: true});
  }

  it("enforces the node-fetch limit when callers consume a declared-length response", async () => {
    const exactResponse = await FetchUtil.fetchWithTimeout(`${baseUrl}/declared/exact`, {
      size: RESPONSE_LIMIT,
    }, REQUEST_TIMEOUT);
    expect(exactResponse.headers.get("content-length")).to.equal(String(RESPONSE_LIMIT));
    expect(await exactResponse.json()).to.equal("x".repeat(RESPONSE_LIMIT - 2));

    const oversizedResponse = await FetchUtil.fetchWithTimeout(`${baseUrl}/declared/oversized`, {
      size: RESPONSE_LIMIT,
    }, REQUEST_TIMEOUT);
    const overflowError = await captureRejection(oversizedResponse.json());

    expect(overflowError.type).to.equal("max-size");
    await expectHealthyRequest();
  });

  it("enforces the bounded JSON limit on chunked responses without Content-Length", async () => {
    const exactResult = await FetchUtil.fetchBoundedJson(`${baseUrl}/chunked/exact`, {
      maxResponseBytes: RESPONSE_LIMIT,
      timeoutMs: REQUEST_TIMEOUT,
    });
    expect(exactResult).to.equal("x".repeat(RESPONSE_LIMIT - 2));

    const overflowError = await captureRejection(
      FetchUtil.fetchBoundedJson(`${baseUrl}/chunked/oversized`, {
        maxResponseBytes: RESPONSE_LIMIT,
        timeoutMs: REQUEST_TIMEOUT,
      }),
    );

    expect(overflowError.type).to.equal("max-size");
    await expectHealthyRequest();
  });

  it("keeps fetchWithTimeout active while json consumes the response body", async () => {
    const controller = new AbortController();
    const removeListener = sinon.spy(controller.signal, "removeEventListener");
    const timeoutError = await captureRejection(
      FetchUtil.fetchWithTimeout(`${baseUrl}/slow`, {
        signal: controller.signal,
      }, 40).then((response) => response.json()),
    );

    expect(timeoutError.type).to.equal("aborted");
    expect(removeListener.calledOnceWith("abort")).to.equal(true);
    await expectHealthyRequest();
  });

  it("reports bounded JSON body timeouts and removes the caller abort listener", async () => {
    const controller = new AbortController();
    const removeListener = sinon.spy(controller.signal, "removeEventListener");
    const timeoutError = await captureRejection(
      FetchUtil.fetchBoundedJson(`${baseUrl}/slow`, {
        init: {signal: controller.signal},
        maxResponseBytes: RESPONSE_LIMIT,
        timeoutMs: 40,
      }),
    );

    expect(timeoutError.message).to.equal("Request timed out");
    expect(removeListener.calledOnceWith("abort")).to.equal(true);
    await expectHealthyRequest();
  });

  it("propagates caller aborts and leaves later requests usable", async () => {
    const controller = new AbortController();
    const removeListener = sinon.spy(controller.signal, "removeEventListener");
    const request = FetchUtil.fetchBoundedJson(`${baseUrl}/slow`, {
      init: {signal: controller.signal},
      maxResponseBytes: RESPONSE_LIMIT,
      timeoutMs: REQUEST_TIMEOUT,
    });
    setTimeout(() => controller.abort(), 25);
    const abortError = await captureRejection(request);

    expect(abortError.type).to.equal("aborted");
    expect(removeListener.calledOnceWith("abort")).to.equal(true);
    await expectHealthyRequest();
  });

  it("cleans up timeout and caller-abort state after a complete response", async () => {
    const controller = new AbortController();
    const removeListener = sinon.spy(controller.signal, "removeEventListener");
    const response = await FetchUtil.fetchWithTimeout(`${baseUrl}/healthy`, {
      signal: controller.signal,
    }, 60_000);

    expect(await response.json()).to.deep.equal({ok: true});
    expect(removeListener.calledOnceWith("abort")).to.equal(true);
  });
});
