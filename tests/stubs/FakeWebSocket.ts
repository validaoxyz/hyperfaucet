import { WebSocket, RawData } from 'ws';
import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { ServiceManager } from '../../src/common/ServiceManager.js';
import { FaucetHttpServer } from '../../src/webserv/FaucetHttpServer.js';
import { sleepPromise } from '../../src/utils/PromiseUtils.js';

export let fakeWebSockets: FakeWebSocket[] = [];

export function disposeFakeWebSockets() {
  fakeWebSockets.forEach((fakeWs) => fakeWs.dispose());
}

export async function injectFakeWebSocket(url: string, ip: string): Promise<FakeWebSocket> {
  let fakeWs = new FakeWebSocket();
  let faucetHttpServer: any = ServiceManager.GetService(FaucetHttpServer);
  let wsHandler: (req: IncomingMessage, ws: WebSocket, remoteIp: string) => Promise<void> = null as any;
  let rawHandler: (req: IncomingMessage, socket: Duplex, head: Buffer, remoteIp: string) => Promise<void> = null as any;
  for(let endpoint in faucetHttpServer.wssEndpoints) {
    if(faucetHttpServer.wssEndpoints[endpoint].pattern.test(url)) {
      wsHandler = faucetHttpServer.wssEndpoints[endpoint].wssHandler;
      rawHandler = faucetHttpServer.wssEndpoints[endpoint].rawHandler;
    }
  }
  if(wsHandler) {
    await wsHandler({
      url: url,
    } as any, fakeWs, ip)
  }
  else if(rawHandler) {
    let fakeSocket = {_testWs: fakeWs} as any;
    fakeSocket.write = (data: string) => {
      data = data.replace(/^.*[\r\n]{2}/gm, "");
      fakeWs.send(data);
    };
    fakeSocket.end = () => { fakeWs.close(); };
    fakeSocket.destroy = () => { };
    fakeSocket.removeAllListeners = () => {};
    fakeSocket.pause = () => {};
    fakeSocket.resume = () => {};
    await rawHandler({
      url: url,
    } as any, fakeSocket, Buffer.from(""), ip)
    await sleepPromise(10);
  }
  else {
    throw "no ws handler for url";
  }

  return fakeWs;
}

export class FakeWebSocket extends WebSocket {
  private sentMessages: any[] = [];
  public isReady = true;

  constructor() {
    super(null as any, undefined, {});
    fakeWebSockets.push(this);
  }

  public dispose() {
    let fakeWsIdx = fakeWebSockets.indexOf(this);
    if(fakeWsIdx !== -1) {
      fakeWebSockets.splice(fakeWsIdx, 1);
    }
  }

  public override send(data: any): void {
    let message = JSON.parse(data);
    this.sentMessages.push(message);
    this.emit("sent-message", message);
  }

  public getSentMessage(action?: string) {
    return this.sentMessages.filter((msg) => !action || msg.action === action);
  }

  public waitForSentMessageCount(action: string, count: number, timeoutMs = 5_000): Promise<void> {
    if(this.getSentMessage(action).length >= count)
      return Promise.resolve();

    return new Promise((resolve, reject) => {
      let cleanup = () => {
        clearTimeout(timeout);
        this.removeListener("sent-message", onMessage);
      };
      let onMessage = () => {
        if(this.getSentMessage(action).length < count)
          return;
        cleanup();
        resolve();
      };
      let timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${count} ${action} WebSocket message(s)`));
      }, timeoutMs);
      this.on("sent-message", onMessage);
    });
  }

  public override ping() {
    setTimeout(() => {
      this.emit("pong");
    }, 50);
  }

  public override close() {
    this.isReady = false;
  }
}
