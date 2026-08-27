import { PoWCryptoParams, PoWHashAlgo } from "../PoWConfig.js";

export interface IPoWValidatorValidateRequest {
  shareId: string;
  nonce: number;
  data: string;
  preimage: string;
  algo: PoWHashAlgo;
  params: PoWCryptoParams;
  difficulty: number;
}

export interface IPoWValidatorLimits {
  maxGlobalPending: number;
  maxSessionPending: number;
  maxSessionDutyCyclePercent: number;
  timeoutMs: number;
}

export type PoWValidationAdmission =
  | { kind: "accepted"; promise: Promise<boolean> }
  | { kind: "rejected"; reason: "global-capacity" | "session-capacity" | "session-rate" | "unavailable" | "invalid-policy" };
