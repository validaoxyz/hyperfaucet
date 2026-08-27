import { randomBytes } from "node:crypto";
import { eth } from "web3";

export interface IStakeOwnershipChallenge {
  challengeId: string;
  sessionId: string;
  address: string;
  message: string;
  expiresAt: number;
}

export interface IStakeOwnershipMarker {
  state: "pending" | "active";
  challengeId: string;
  address: string;
  verifiedAt: number;
}

export type StakeOwnershipClaim =
  | {kind: "claimed", challenge: IStakeOwnershipChallenge}
  | {kind: "expired"}
  | {kind: "missing"};

const MAX_PENDING_CHALLENGES = 10000;
const SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/i;

export class StakeOwnershipChallengeStore {
  private readonly challenges = new Map<string, IStakeOwnershipChallenge>();

  public issue(sessionId: string, address: string, expiresAt: number): IStakeOwnershipChallenge {
    const challengeId = randomBytes(32).toString("hex");
    const challenge: IStakeOwnershipChallenge = {
      challengeId,
      sessionId,
      address: address.toLowerCase(),
      expiresAt,
      message: buildStakeOwnershipMessage(sessionId, address, challengeId, expiresAt),
    };

    this.challenges.delete(sessionId);
    while(this.challenges.size >= MAX_PENDING_CHALLENGES) {
      const oldestSession = this.challenges.keys().next().value;
      if(typeof oldestSession !== "string")
        break;
      this.challenges.delete(oldestSession);
    }
    this.challenges.set(sessionId, challenge);
    return challenge;
  }

  public claim(sessionId: string, challengeId: string, now: number): StakeOwnershipClaim {
    const challenge = this.challenges.get(sessionId);
    if(!challenge || challenge.challengeId !== challengeId)
      return {kind: "missing"};

    this.challenges.delete(sessionId);
    if(now >= challenge.expiresAt)
      return {kind: "expired"};
    return {kind: "claimed", challenge};
  }

  public clear(): void {
    this.challenges.clear();
  }

  public get size(): number {
    return this.challenges.size;
  }
}

export function buildStakeOwnershipMessage(
  sessionId: string,
  address: string,
  challengeId: string,
  expiresAt: number,
): string {
  return [
    "HyperFaucet wallet verification",
    "",
    "Address: " + address.toLowerCase(),
    "Session: " + sessionId,
    "Challenge: " + challengeId,
    "Expires: " + new Date(expiresAt * 1000).toISOString(),
    "",
    "Signing proves you own this mining wallet. It does not authorize a transaction.",
  ].join("\n");
}

export function recoverStakeOwnershipSigner(message: string, signature: unknown): string | null {
  if(typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature))
    return null;

  const recoveryByte = signature.slice(-2).toLowerCase();
  let normalizedSignature = signature;
  if(recoveryByte === "00" || recoveryByte === "01") {
    const normalizedRecoveryByte = recoveryByte === "00" ? "1b" : "1c";
    normalizedSignature = signature.slice(0, -2) + normalizedRecoveryByte;
  }
  else if(recoveryByte !== "1b" && recoveryByte !== "1c") {
    return null;
  }

  try {
    return eth.accounts.recover(message, normalizedSignature).toLowerCase();
  } catch(ex) {
    return null;
  }
}
