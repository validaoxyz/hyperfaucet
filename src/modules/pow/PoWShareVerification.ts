import fs from "fs";

import { ServiceManager } from "../../common/ServiceManager.js";
import { FaucetLogLevel, FaucetProcess } from "../../common/FaucetProcess.js";
import { resolveRelativePath } from "../../config/FaucetConfig.js";
import { getNewGuid } from "../../utils/GuidUtils.js";
import { PromiseDfd } from "../../utils/PromiseDfd.js";
import type { PoWClient } from "./PoWClient.js";
import { applyPoWPercentage, IPoWConfig, PoWCryptoParams, PoWHashAlgo } from "./PoWConfig.js";
import type { PoWClientParams, PoWServerWorker } from "./PoWServerWorker.js";
import { PoWSession } from "./PoWSession.js";
import { IPoWValidatorValidateRequest } from "./validator/IPoWValidator.js";

export interface IPoWShareVerificationResult {
  isValid: boolean;
  reward: bigint;
}

export interface IPoWPeerVerificationPolicy {
  id: string;
  params: PoWClientParams;
  difficulty: number;
}

export interface IPoWPeerVerificationResult {
  shareId: string;
  verifierId: string;
  policyId: string;
  isValid: boolean;
}

type SettlementState = "pending" | "settling" | "settled" | "cancelled";
type PeerTelemetryState = "idle" | "open" | "closed";
type PeerTelemetryCloseReason = "complete" | "timeout" | "validation-failed";

export class PoWShareVerification {
  private static verifyingShares = new Map<string, PoWShareVerification>();

  public static processVerificationResult(result: IPoWPeerVerificationResult): Promise<bigint> {
    let share = this.verifyingShares.get(result.shareId);
    return share ? share.processVerificationResult(result) : Promise.resolve(0n);
  }

  public static cancelSession(server: PoWServerWorker, sessionId: string, reason: string): void {
    for(let share of [...this.verifyingShares.values()]) {
      if(share.server === server && share.session.getSessionId() === sessionId)
        share.cancel(reason);
      else if(share.server === server)
        share.cancelVerifier(sessionId);
    }
  }

  public static cancelAll(server: PoWServerWorker, reason: string): void {
    for(let share of [...this.verifyingShares.values()]) {
      if(share.server === server)
        share.cancel(reason);
    }
  }

  private shareId: string;
  private server: PoWServerWorker;
  private session: PoWSession;
  private nonce: number;
  private data: string;
  private policy: IPoWConfig;
  private peerPolicy: IPoWPeerVerificationPolicy;
  private verifyMinerCount = 0;
  private pendingVerifierIds = new Set<string>();
  private respondedVerifierIds = new Set<string>();
  private verifierCloseGuards = new Map<string, () => void>();
  private verifyMinerTimer: NodeJS.Timeout;
  private peerTelemetryState: PeerTelemetryState = "idle";
  private settlementState: SettlementState = "pending";
  private localResultDfd = new PromiseDfd<boolean | null>();
  private resultDfd: PromiseDfd<IPoWShareVerificationResult>;
  private releaseSubmitterCloseGuard: () => void;

  public constructor(server: PoWServerWorker, session: PoWSession, nonce: number, data: string) {
    this.shareId = getNewGuid();
    this.server = server;
    this.session = session;
    this.nonce = nonce;
    this.data = data;
    this.policy = this.snapshotPolicy(server.getModuleConfig());
    this.peerPolicy = {
      id: getNewGuid(),
      params: server.getClientPoWParams(this.policy),
      difficulty: this.policy.powDifficulty,
    };
    PoWShareVerification.verifyingShares.set(this.shareId, this);
  }

  public getMinerVerifyCount(): number {
    return this.verifyMinerCount;
  }

  public getMinerVerifyMisses(): number {
    return this.verifyMinerCount - this.respondedVerifierIds.size;
  }

  public startVerification(): Promise<IPoWShareVerificationResult> {
    if(this.resultDfd)
      return this.resultDfd.promise;

    this.resultDfd = new PromiseDfd<IPoWShareVerificationResult>();
    this.releaseSubmitterCloseGuard = this.session.holdBenignCloseForSecurityDecision?.() ?? (() => undefined);
    let localValidation = this.server.getValidator().tryValidateShare(
      this.session.getSessionId(),
      this.getValidationRequest(),
      {
        maxGlobalPending: this.policy.verifyLocalMaxQueue,
        maxSessionPending: this.policy.verifyLocalMaxPendingPerSession,
        maxSessionDutyCyclePercent: this.policy.verifyLocalMaxSessionDutyCyclePercent,
        timeoutMs: this.policy.verifyLocalTimeout * 1000,
      },
    );

    if(localValidation.kind === "rejected") {
      PoWShareVerification.verifyingShares.delete(this.shareId);
      this.settlementState = "settled";
      this.localResultDfd.resolve(null);
      this.resultDfd.reject(new Error("PoW validation unavailable: " + localValidation.reason));
      this.releaseSubmitterGuard();
      return this.resultDfd.promise;
    }

    localValidation.promise.then(
      (isValid) => this.settleShare(isValid),
      (error) => this.failVerification(error)
    );
    try {
      this.startPeerTelemetry();
    }
    catch(error) {
      this.server.getValidator().cancelValidation(this.shareId, "PoW peer verification setup failed");
      this.failVerification(error);
    }

    return this.resultDfd.promise;
  }

  private startPeerTelemetry(): void {
    let validatorSessions = this.getVerifierSessions();
    let shouldVerify = (
      this.policy.verifyMinerPercent > 0 &&
      validatorSessions.length >= this.policy.verifyMinerPeerCount &&
      Math.random() * 100 < this.policy.verifyMinerPercent
    );
    let verifierCount = Math.min(
      Math.max(0, Math.floor(this.policy.verifyMinerIndividuals)),
      validatorSessions.length
    );

    if(!shouldVerify || verifierCount === 0) {
      this.peerTelemetryState = "closed";
      return;
    }

    this.peerTelemetryState = "open";
    this.verifyMinerCount = verifierCount;
    for(let i = 0; i < verifierCount; i++) {
      let sessionIndex = Math.floor(Math.random() * validatorSessions.length);
      let validatorSession = validatorSessions.splice(sessionIndex, 1)[0];
      let verifierId = validatorSession.getSessionId();
      let releaseCloseGuard = validatorSession.holdBenignCloseForSecurityDecision?.();
      if(releaseCloseGuard)
        this.verifierCloseGuards.set(verifierId, releaseCloseGuard);
      this.pendingVerifierIds.add(verifierId);
      validatorSession.pendingVerifications++;
      validatorSession.activeClient.sendMessage("verify", {
        shareId: this.shareId,
        preimage: this.session.preImage,
        nonce: this.nonce,
        data: this.data,
        policy: this.peerPolicy,
      });
    }

    this.verifyMinerTimer = setTimeout(
      () => this.closePeerTelemetry("timeout"),
      Math.max(0, this.policy.verifyMinerTimeout) * 1000
    );
  }

  private getVerifierSessions(): PoWSession[] {
    let minBalance = applyPoWPercentage(BigInt(this.policy.powShareReward), this.policy.verifyMinerMissPenaltyPerc);
    return this.server.getActiveClients().map((client) => client.getPoWSession()).filter((session) => {
      if(!session.activeClient) {
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.ERROR, "PoWModule.getActiveClients returned an inactive client: " + session.getSessionId());
        return false;
      }
      return (
        session !== this.session &&
        session.getDropAmount() >= minBalance &&
        session.missedVerifications < this.policy.verifyMinerMaxMissed &&
        session.pendingVerifications < this.policy.verifyMinerMaxPending
      );
    });
  }

  public async processVerificationResult(result: IPoWPeerVerificationResult): Promise<bigint> {
    if(
      this.peerTelemetryState !== "open" ||
      result.policyId !== this.peerPolicy.id ||
      !this.pendingVerifierIds.delete(result.verifierId)
    )
      return 0n;

    this.respondedVerifierIds.add(result.verifierId);
    let releaseVerifierCloseGuard = this.takeVerifierCloseGuard(result.verifierId);
    try {
      let verifierSession = this.server.getPoWSession(result.verifierId);
      if(verifierSession)
        verifierSession.pendingVerifications--;

      if(this.pendingVerifierIds.size === 0)
        this.closePeerTelemetry("complete");

      let localResult = await this.localResultDfd.promise;
      if(localResult === null)
        return 0n;

      let resultMatches = result.isValid === localResult;
      if(!resultMatches)
        await verifierSession?.slashSession("invalid PoW verification result");
      if(!localResult || !resultMatches)
        return 0n;

      let reward = applyPoWPercentage(BigInt(this.policy.powShareReward), this.policy.verifyMinerRewardPerc);
      if(!verifierSession || reward === 0n)
        return 0n;
      return await verifierSession.addReward(reward, "verify");
    }
    finally {
      releaseVerifierCloseGuard?.();
    }
  }

  private closePeerTelemetry(reason: PeerTelemetryCloseReason): void {
    if(this.peerTelemetryState !== "open")
      return;

    this.peerTelemetryState = "closed";
    if(this.verifyMinerTimer) {
      clearTimeout(this.verifyMinerTimer);
      this.verifyMinerTimer = null;
    }

    try {
      for(let verifierId of this.pendingVerifierIds) {
        let verifierSession = this.server.getPoWSession(verifierId);
        if(!verifierSession)
          continue;

        verifierSession.pendingVerifications--;
        if(reason !== "timeout")
          continue;

        verifierSession.missedVerifications++;
        let missPenalty = applyPoWPercentage(BigInt(this.policy.powShareReward), this.policy.verifyMinerMissPenaltyPerc);
        let releaseVerifierCloseGuard = this.takeVerifierCloseGuard(verifierId);
        this.settleVerifierMissPenalty(verifierSession, missPenalty, releaseVerifierCloseGuard);
      }
    }
    finally {
      this.pendingVerifierIds.clear();
      this.releaseAllVerifierCloseGuards();
      this.tryRelease();
    }
  }

  private async settleShare(isValid: boolean): Promise<void> {
    if(this.settlementState !== "pending")
      return;

    this.settlementState = "settling";
    this.localResultDfd.resolve(isValid);

    try {
      let reward = 0n;
      if(isValid) {
        reward = await this.session.addReward(BigInt(this.policy.powShareReward), "share");
        this.storeRelevantResult();
        this.session.activeClient?.sendMessage("updateBalance", {
          balance: this.session.getDropAmount().toString(),
          reason: "valid share (reward: " + reward.toString() + ")"
        });
      }
      else {
        await this.session.slashSession("invalid PoW result hash");
      }

      this.resultDfd.resolve({
        isValid,
        reward
      });
    }
    catch(error) {
      this.resultDfd.reject(error);
    }
    finally {
      this.finishSettlement();
      this.tryRelease();
      this.releaseSubmitterGuard();
    }
  }

  private finishSettlement(): void {
    if(this.settlementState !== "cancelled")
      this.settlementState = "settled";
  }

  private failVerification(error: unknown): void {
    if(this.settlementState !== "pending")
      return;

    this.settlementState = "settled";
    this.localResultDfd.resolve(null);
    this.closePeerTelemetry("validation-failed");
    this.resultDfd.reject(error);
    this.tryRelease();
    this.releaseSubmitterGuard();
  }

  private cancel(reason: string): void {
    if(this.settlementState === "settled" || this.settlementState === "cancelled")
      return;

    this.settlementState = "cancelled";
    this.localResultDfd.resolve(null);
    this.closePeerTelemetry("validation-failed");
    this.resultDfd?.reject(new Error(reason));
    this.tryRelease();
    this.releaseSubmitterGuard();
  }

  private cancelVerifier(sessionId: string): void {
    if(this.peerTelemetryState !== "open" || !this.pendingVerifierIds.delete(sessionId))
      return;

    let releaseVerifierCloseGuard = this.takeVerifierCloseGuard(sessionId);
    try {
      this.verifyMinerCount--;
      let verifierSession = this.server.getPoWSession(sessionId);
      if(verifierSession)
        verifierSession.pendingVerifications = Math.max(0, verifierSession.pendingVerifications - 1);
      if(this.pendingVerifierIds.size === 0)
        this.closePeerTelemetry("complete");
    }
    finally {
      releaseVerifierCloseGuard?.();
    }
  }

  private storeRelevantResult(): void {
    if(this.policy.powHashAlgo !== PoWHashAlgo.NICKMINER || !this.policy.powNickMinerParams.relevantFile)
      return;

    let difficulty = parseInt(this.data.substring(2, 4), 16);
    if(difficulty < this.policy.powNickMinerParams.relevantDifficulty)
      return;

    let line = "0x" + this.data.substring(4, 44) + "  (d: " + difficulty + "): hash: 0x" + this.policy.powNickMinerParams.hash + ", sigR: 0x" + this.policy.powNickMinerParams.sigR + ", sigS: 0x" + this.data.substring(44);
    fs.appendFileSync(resolveRelativePath(this.policy.powNickMinerParams.relevantFile), line + "\n");
  }

  private getValidationRequest(): IPoWValidatorValidateRequest {
    return {
      shareId: this.shareId,
      nonce: this.nonce,
      data: this.data,
      preimage: this.session.preImage,
      algo: this.policy.powHashAlgo,
      params: this.getValidationParams(),
      difficulty: this.policy.powDifficulty,
    };
  }

  private getValidationParams(): PoWCryptoParams {
    switch(this.policy.powHashAlgo) {
      case PoWHashAlgo.SCRYPT:
        return {...this.policy.powScryptParams};
      case PoWHashAlgo.CRYPTONIGHT:
        return {...this.policy.powCryptoNightParams};
      case PoWHashAlgo.ARGON2:
        return {...this.policy.powArgon2Params};
      case PoWHashAlgo.NICKMINER:
        return {...this.policy.powNickMinerParams};
    }
  }

  private snapshotPolicy(policy: IPoWConfig): IPoWConfig {
    return {
      ...policy,
      powScryptParams: {...policy.powScryptParams},
      powCryptoNightParams: {...policy.powCryptoNightParams},
      powArgon2Params: {...policy.powArgon2Params},
      powNickMinerParams: {...policy.powNickMinerParams},
    };
  }

  private tryRelease(): void {
    if(
      (this.settlementState === "settled" || this.settlementState === "cancelled") &&
      this.peerTelemetryState !== "open"
    )
      PoWShareVerification.verifyingShares.delete(this.shareId);
  }

  private releaseSubmitterGuard(): void {
    let release = this.releaseSubmitterCloseGuard;
    this.releaseSubmitterCloseGuard = null;
    release?.();
  }

  private takeVerifierCloseGuard(verifierId: string): (() => void) | undefined {
    let release = this.verifierCloseGuards.get(verifierId);
    this.verifierCloseGuards.delete(verifierId);
    return release;
  }

  private releaseAllVerifierCloseGuards(): void {
    for(let verifierId of [...this.verifierCloseGuards.keys()])
      this.takeVerifierCloseGuard(verifierId)?.();
  }

  private settleVerifierMissPenalty(
    verifierSession: PoWSession,
    missPenalty: bigint,
    releaseVerifierCloseGuard?: () => void,
  ): void {
    void Promise.resolve().then(() => verifierSession.subPenalty(missPenalty, "verify")).then((penalty) => {
      if(penalty === 0n)
        return;
      let client: PoWClient = verifierSession.activeClient;
      client?.sendMessage("updateBalance", {
        balance: verifierSession.getDropAmount().toString(),
        reason: "verify miss (penalty: " + missPenalty.toString() + ")"
      });
    }).catch((error) => {
      ServiceManager.GetService(FaucetProcess).emitLog(
        FaucetLogLevel.WARNING,
        "Could not apply PoW verification miss penalty: " + (error instanceof Error ? error.message : String(error)),
      );
    }).finally(() => {
      releaseVerifierCloseGuard?.();
    });
  }
}
