import { MessagePort } from "node:worker_threads";

export interface IPassportWorkerVerifyRequest {
  reqId: number;
  credentialJson: string;
  proofOptionsJson: string;
}

export type PassportWorkerRequest = {
  action: "verify";
  data: IPassportWorkerVerifyRequest;
};

export type PassportWorkerResponse =
  | {action: "init"}
  | {action: "init-error"}
  | {action: "verified", data: {reqId: number, result: string}}
  | {action: "verification-error", data: {reqId: number}};

type DIDKitLib = {
  verifyCredential: (vc: string, proofOptions: string) => Promise<string>;
};

export class PassportWorker {
  private readonly port: MessagePort;
  private didkit?: DIDKitLib;

  public constructor(port: MessagePort) {
    this.port = port;
    this.port.on("message", (message: unknown) => this.onMessage(message));
    this.initialize().then(
      () => this.send({action: "init"}),
      () => this.send({action: "init-error"}),
    );
  }

  private async initialize(): Promise<void> {
    let didkit = await import("../../../libs/didkit_wasm.cjs");
    this.didkit = didkit.default || didkit;
  }

  private onMessage(message: unknown): void {
    if(!this.isVerifyRequest(message) || !this.didkit)
      return;

    let request = message.data;
    this.didkit.verifyCredential(request.credentialJson, request.proofOptionsJson).then(
      (result) => this.send({action: "verified", data: {reqId: request.reqId, result}}),
      () => this.send({action: "verification-error", data: {reqId: request.reqId}}),
    );
  }

  private isVerifyRequest(message: unknown): message is PassportWorkerRequest {
    if(typeof message !== "object" || message === null || Array.isArray(message))
      return false;
    let record = message as Record<string, unknown>;
    if(record.action !== "verify" || typeof record.data !== "object" || record.data === null || Array.isArray(record.data))
      return false;
    let data = record.data as Record<string, unknown>;
    return Number.isSafeInteger(data.reqId)
      && typeof data.credentialJson === "string"
      && typeof data.proofOptionsJson === "string";
  }

  private send(message: PassportWorkerResponse): void {
    this.port.postMessage(message);
  }
}
