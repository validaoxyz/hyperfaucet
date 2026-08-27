export enum ClaimTxStatus {
  QUEUE = "queue",
  PREPARED = "prepared",
  PENDING = "pending",
  CONFIRMED = "confirmed",
  REVERTED = "reverted",
  FAILED = "failed",
}

export interface SignedClaimTransaction {
  readonly txHash: string;
  readonly txHex: string;
  readonly txNonce: number;
}

interface ClaimDataBase {
  claimFormat: 2;
  claimIdx: number;
  claimTime: number;
}

export interface QueuedClaimData extends ClaimDataBase {
  claimStatus: ClaimTxStatus.QUEUE;
  txHash?: never;
  txHex?: never;
  txNonce?: never;
  txBlock?: never;
  txFee?: never;
  txError?: never;
}

export interface PreparedClaimData extends ClaimDataBase, SignedClaimTransaction {
  claimStatus: ClaimTxStatus.PREPARED;
  txBlock?: never;
  txFee?: never;
  txError?: never;
}

export interface PendingClaimData extends ClaimDataBase, SignedClaimTransaction {
  claimStatus: ClaimTxStatus.PENDING;
  txBlock?: never;
  txFee?: never;
  txError?: never;
}

export interface ConfirmedClaimData extends ClaimDataBase, SignedClaimTransaction {
  claimStatus: ClaimTxStatus.CONFIRMED;
  txBlock: number;
  txFee: string;
  txError?: never;
}

export interface RevertedClaimData extends ClaimDataBase, SignedClaimTransaction {
  claimStatus: ClaimTxStatus.REVERTED;
  txBlock: number;
  txFee: string;
  txError: string;
}

export interface FailedClaimData extends ClaimDataBase {
  claimStatus: ClaimTxStatus.FAILED;
  txError: string;
  txHash?: never;
  txHex?: never;
  txNonce?: never;
  txBlock?: never;
  txFee?: never;
}

export type ActiveSignedClaimData = PreparedClaimData | PendingClaimData;

export type EthClaimData =
  | QueuedClaimData
  | PreparedClaimData
  | PendingClaimData
  | ConfirmedClaimData
  | RevertedClaimData
  | FailedClaimData;

export interface EthClaimInfo {
  session: string;
  target: string;
  amount: string;
  claim: EthClaimData;
}

export function isActiveSignedClaimData(claim: EthClaimData): claim is ActiveSignedClaimData {
  return claim.claimStatus === ClaimTxStatus.PREPARED || claim.claimStatus === ClaimTxStatus.PENDING;
}

export function isClaimData(value: unknown): value is EthClaimData {
  if(!value || typeof value !== "object")
    return false;

  let claim = value as Record<string, unknown>;
  if(claim.claimFormat !== 2 || !isNonNegativeSafeInteger(claim.claimTime) || !isPositiveSafeInteger(claim.claimIdx))
    return false;

  switch(claim.claimStatus) {
    case ClaimTxStatus.QUEUE:
      return lacksFields(claim, "txHash", "txHex", "txNonce", "txBlock", "txFee", "txError");
    case ClaimTxStatus.PREPARED:
    case ClaimTxStatus.PENDING:
      return hasSignedTransaction(claim) && lacksFields(claim, "txBlock", "txFee", "txError");
    case ClaimTxStatus.CONFIRMED:
      return hasSignedTransaction(claim) && isNonNegativeSafeInteger(claim.txBlock) && isUnsignedDecimal(claim.txFee) && claim.txError === undefined;
    case ClaimTxStatus.REVERTED:
      return hasSignedTransaction(claim) && isNonNegativeSafeInteger(claim.txBlock) && isUnsignedDecimal(claim.txFee) && isNonEmptyString(claim.txError);
    case ClaimTxStatus.FAILED:
      return isNonEmptyString(claim.txError) && lacksFields(claim, "txHash", "txHex", "txNonce", "txBlock", "txFee");
    default:
      return false;
  }
}

function hasSignedTransaction(claim: Record<string, unknown>): boolean {
  return typeof claim.txHash === "string" && /^0x[0-9a-f]{64}$/i.test(claim.txHash) &&
    typeof claim.txHex === "string" && /^0x(?:[0-9a-f]{2})+$/i.test(claim.txHex) &&
    isNonNegativeSafeInteger(claim.txNonce);
}

function lacksFields(claim: Record<string, unknown>, ...fields: string[]): boolean {
  return fields.every((field) => claim[field] === undefined);
}

function isNonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isUnsignedDecimal(value: unknown): boolean {
  return typeof value === "string" && /^\d+$/.test(value);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}
