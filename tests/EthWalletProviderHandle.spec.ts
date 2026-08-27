import "mocha";
import { expect } from "chai";
import sinon from "sinon";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import IpcProvider from "web3-providers-ipc";
import WebSocketProvider from "web3-providers-ws";
import { EthWalletManager, type Web3ProviderHandle } from "../src/eth/EthWalletManager.js";
import {
  BoundedAsyncWork,
  BoundedAsyncWorkInvalidatedError,
} from "../src/utils/BoundedAsyncWork.js";
import { PromiseDfd } from "../src/utils/PromiseDfd.js";

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch(error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

async function settleWithin<TResult>(promise: Promise<TResult>, timeoutMs = 1_000): Promise<TResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`promise did not settle within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if(timeout !== undefined)
      clearTimeout(timeout);
  }
}

describe("EthWalletManager policy provider handles", () => {
  afterEach(() => {
    sinon.restore();
  });

  it("aborts module-owned HTTPS providers", () => {
    let signal: AbortSignal | undefined;
    const providerFactory = sinon.stub().callsFake((_rpcHost, providerSignal) => {
      signal = providerSignal;
      return {};
    });

    const handle = EthWalletManager.createWeb3ProviderHandle(
      "https://rpc.example.test",
      "test rpcHost",
      providerFactory,
    );
    expect(providerFactory.calledOnce).to.equal(true);
    expect(providerFactory.firstCall.args).to.deep.equal([
      "https://rpc.example.test",
      signal,
      false,
    ]);
    expect(signal?.aborted).to.equal(false);
    handle.dispose();
    expect(signal?.aborted).to.equal(true);
  });

  it("clears pending work before disconnecting module-owned WSS providers", () => {
    const clearQueues = sinon.spy();
    const disconnect = sinon.spy();
    const providerFactory = sinon.stub().returns({clearQueues, disconnect});

    const handle = EthWalletManager.createWeb3ProviderHandle(
      "wss://rpc.example.test",
      "test rpcHost",
      providerFactory,
    );
    expect(providerFactory.calledOnceWithExactly(
      "wss://rpc.example.test",
      undefined,
      false,
    )).to.equal(true);
    handle.dispose();
    expect(clearQueues.calledOnce).to.equal(true);
    expect(clearQueues.firstCall.args[0]).to.be.instanceOf(Error);
    expect(clearQueues.firstCall.args[0].message).to.equal("test rpcHost was stopped");
    expect(clearQueues.calledBefore(disconnect)).to.equal(true);
    expect(disconnect.calledOnce).to.equal(true);
  });

  it("does not reconnect an owned WSS provider after abnormal close and disposal", async () => {
    const providerPrototype = WebSocketProvider.prototype as any;
    let readyState = 0;
    const socketConnection = {
      CONNECTING: 0,
      OPEN: 1,
      get readyState() {
        return readyState;
      },
      close: sinon.stub().callsFake(() => {
        readyState = 3;
      }),
      removeEventListener: sinon.spy(),
    };
    const openSocket = sinon.stub(providerPrototype, "_openSocketConnection").callsFake(function() {
      readyState = socketConnection.CONNECTING;
      Reflect.set(this, "_socketConnection", socketConnection);
    });
    sinon.stub(providerPrototype, "_addSocketListeners");
    const clock = sinon.useFakeTimers();
    const handle = EthWalletManager.createWeb3ProviderHandle(
      "wss://rpc.example.test",
      "test WSS rpcHost",
    );
    const provider = handle.provider;
    const reconnectOptions = Reflect.get(provider, "_reconnectOptions");
    const onClose = Reflect.get(provider, "_onCloseEvent");
    if(typeof reconnectOptions !== "object" || reconnectOptions === null)
      throw new Error("WSS provider reconnect options were unavailable");
    if(typeof onClose !== "function")
      throw new Error("WSS provider close handler was unavailable");

    readyState = 3;
    Reflect.apply(onClose, provider, [{code: 1006, reason: "abnormal", wasClean: false}]);
    const requestError = rejectionOf(provider.request({
      jsonrpc: "2.0",
      id: 5001,
      method: "eth_blockNumber",
      params: [],
    }));
    expect(openSocket.callCount).to.equal(2, "active WSS request did not reconnect on demand");
    handle.dispose();
    await clock.tickAsync(5_001);

    expect(Reflect.get(reconnectOptions, "autoReconnect")).to.equal(false);
    expect(await settleWithin(requestError)).to.be.instanceOf(Error);
    expect(openSocket.callCount).to.equal(2, "disposed WSS provider opened a third connection");
    expect(provider.getPendingRequestQueueSize()).to.equal(0);
    expect(provider.getSentRequestsQueueSize()).to.equal(0);
  });

  it("does not reconnect an owned IPC provider after abnormal close and disposal", async () => {
    const providerPrototype = IpcProvider.prototype as any;
    const socketConnection = {
      end: sinon.stub().callsFake((callback?: () => void) => callback?.()),
      removeAllListeners: sinon.spy(),
    };
    const openSocket = sinon.stub(providerPrototype, "_openSocketConnection").callsFake(function() {
      Reflect.set(this, "_socketConnection", socketConnection);
    });
    sinon.stub(providerPrototype, "_addSocketListeners");
    const clock = sinon.useFakeTimers();
    const handle = EthWalletManager.createWeb3ProviderHandle(
      "/tmp/hyperfaucet-owned-provider-test.ipc",
      "test IPC rpcHost",
    );
    const provider = handle.provider;
    const reconnectOptions = Reflect.get(provider, "_reconnectOptions");
    const onClose = Reflect.get(provider, "_onCloseEvent");
    if(typeof reconnectOptions !== "object" || reconnectOptions === null)
      throw new Error("IPC provider reconnect options were unavailable");
    if(typeof onClose !== "function")
      throw new Error("IPC provider close handler was unavailable");

    Reflect.apply(onClose, provider, [undefined]);
    const requestError = rejectionOf(provider.request({
      jsonrpc: "2.0",
      id: 5002,
      method: "eth_blockNumber",
      params: [],
    }));
    expect(openSocket.callCount).to.equal(2, "active IPC request did not reconnect on demand");
    handle.dispose();
    await clock.tickAsync(5_001);

    expect(Reflect.get(reconnectOptions, "autoReconnect")).to.equal(false);
    expect(await settleWithin(requestError)).to.be.instanceOf(Error);
    expect(openSocket.callCount).to.equal(2, "disposed IPC provider opened a third connection");
    expect(provider.getPendingRequestQueueSize()).to.equal(0);
    expect(provider.getSentRequestsQueueSize()).to.equal(0);
  });

  it("settles a real IPC request before lifecycle drain completes", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "hyperfaucet-provider-ipc-"));
    const socketPath = join(tempDirectory, "provider.ipc");
    const requestReceived = new PromiseDfd<void>();
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let received = "";
      const respondedRequests = new Set<string>();
      socket.on("data", (data) => {
        received += data.toString();
        const initialRequest = /"id":("[^"]+"|\d+),"method":"(eth_chainId|eth_accounts)"/g;
        for(const match of received.matchAll(initialRequest)) {
          const idLiteral = match[1];
          if(respondedRequests.has(idLiteral))
            continue;
          respondedRequests.add(idLiteral);
          const id = idLiteral.startsWith('"')
            ? idLiteral.substring(1, idLiteral.length - 1)
            : Number(idLiteral);
          socket.write(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: match[2] === "eth_chainId" ? "0x1" : [],
          }));
        }
        if(received.includes('"id":424242'))
          requestReceived.resolve();
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });

    let handle: Web3ProviderHandle | undefined;
    try {
      const work = new BoundedAsyncWork<Web3ProviderHandle>();
      work.start(
        () => {
          handle = EthWalletManager.createWeb3ProviderHandle(socketPath, "test IPC rpcHost");
          return handle;
        },
        {maxInflight: 1, timeoutMs: 5_000},
        (runtime) => runtime.dispose(),
      );
      const operationError = rejectionOf(work.run(async (runtime) => {
        await runtime.provider.request({
          jsonrpc: "2.0",
          id: 424242,
          method: "eth_blockNumber",
          params: [],
        });
      }));

      await settleWithin(requestReceived.promise);
      const ownedHandle = handle;
      if(!ownedHandle)
        throw new Error("IPC provider handle was not created");
      await settleWithin((async () => {
        while(ownedHandle.provider.getSentRequestsQueueSize() !== 1)
          await new Promise<void>((resolve) => setImmediate(resolve));
      })());
      await settleWithin(work.stop());
      expect(await settleWithin(operationError)).to.be.instanceOf(BoundedAsyncWorkInvalidatedError);
      expect(work.getInflightCount()).to.equal(0);
    } finally {
      try {
        handle?.dispose();
      } finally {
        for(const socket of sockets)
          socket.destroy();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
        await rm(tempDirectory, {recursive: true, force: true});
      }
    }
  });

  it("does not dispose an injected provider", () => {
    const clearQueues = sinon.spy();
    const disconnect = sinon.spy();
    const provider = {clearQueues, disconnect};
    const providerFactory = sinon.stub();

    const handle = EthWalletManager.createWeb3ProviderHandle(
      provider,
      "test rpcHost",
      providerFactory,
    );
    handle.dispose();
    expect(handle.provider).to.equal(provider);
    expect(providerFactory.called).to.equal(false);
    expect(clearQueues.called).to.equal(false);
    expect(disconnect.called).to.equal(false);
  });
});
