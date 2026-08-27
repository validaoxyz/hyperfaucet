import {
  FaucetError,
  PublicFaucetAddressData,
  PublicFaucetError,
  PublicFaucetIpInfoData,
} from "../common/FaucetError.js";
import { FaucetLogLevel, FaucetProcess } from "../common/FaucetProcess.js";
import { ServiceManager } from "../common/ServiceManager.js";

export const PUBLIC_INTERNAL_ERROR_CODE = "INTERNAL_ERROR";
export const PUBLIC_INTERNAL_ERROR_MESSAGE = "An internal error occurred.";
export const PUBLIC_CLAIM_FAILED_MESSAGE = "Claim processing failed.";
export const PUBLIC_CLAIM_REVERTED_MESSAGE = "Transaction reverted.";

export type PublicFailureData = PublicFaucetAddressData | PublicFaucetIpInfoData;

export interface IClientFailure {
  failedCode: string;
  failedReason: string;
  failedData?: PublicFailureData;
}

type DataProjection =
  | { ok: true; data?: PublicFailureData }
  | { ok: false };

interface PublicErrorPolicy {
  fallback: string;
  allowDynamicMessage?: true;
  projectData?: (value: unknown) => DataProjection;
}

const PUBLIC_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS_PATTERN = /^0x0{40}$/i;
const MAX_PUBLIC_ERROR_MESSAGE_LENGTH = 512;
const INVALID_PROJECTION: DataProjection = Object.freeze({ ok: false });
const NO_PUBLIC_DATA: DataProjection = Object.freeze({ ok: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidPublicAddress(value: unknown): value is string {
  return typeof value === "string"
    && PUBLIC_ADDRESS_PATTERN.test(value)
    && !ZERO_ADDRESS_PATTERN.test(value);
}

function projectAddressData(value: unknown): DataProjection {
  if(!isRecord(value) || !isValidPublicAddress(value.address))
    return INVALID_PROJECTION;
  return {
    ok: true,
    data: { address: value.address },
  };
}

function projectIpInfoData(value: unknown): DataProjection {
  if(value === undefined)
    return NO_PUBLIC_DATA;
  if(
    !isRecord(value)
    || !isValidPublicAddress(value.address)
    || !Array.isArray(value.ipflags)
    || value.ipflags.length !== 2
    || typeof value.ipflags[0] !== "boolean"
    || typeof value.ipflags[1] !== "boolean"
  )
    return INVALID_PROJECTION;
  return {
    ok: true,
    data: {
      address: value.address,
      ipflags: [value.ipflags[0], value.ipflags[1]],
    },
  };
}

const PUBLIC_ERROR_POLICIES = Object.freeze({
  AMOUNT_TOO_LOW: { fallback: "drop amount lower than minimum" },
  AUTHENTICATOOR_CONCURRENCY_LIMIT: {
    fallback: "Concurrent session limit reached for this authenticated user.",
    allowDynamicMessage: true,
  },
  AUTHENTICATOOR_LIMIT: {
    fallback: "Authenticated-user faucet limit reached.",
    allowDynamicMessage: true,
  },
  AUTHENTICATOOR_REQUIRED: { fallback: "You need to authenticate to use this faucet." },
  AUTHENTICATOOR_TOKEN: { fallback: "Invalid authenticatoor login token." },
  BALANCE_ERROR: { fallback: "Could not get wallet balance." },
  BALANCE_LIMIT: {
    fallback: "This wallet exceeds the faucet balance limit.",
    allowDynamicMessage: true,
  },
  CONCURRENCY_LIMIT: {
    fallback: "Concurrent session limit reached.",
    allowDynamicMessage: true,
  },
  CONTRACT_ADDR: { fallback: "Cannot start session for a contract address." },
  CONTRACT_LIMIT: { fallback: "Could not check contract status of wallet." },
  FAUCET_EMPTY: {
    fallback: "The faucet is empty. Wait for it to be refilled and try again",
    allowDynamicMessage: true,
  },
  FAUCET_DISABLED: {
    fallback: "The faucet is currently not allowing new sessions.",
    allowDynamicMessage: true,
  },
  FAUCET_UNAVAILABLE: { fallback: "The faucet is temporarily unavailable. Please try again shortly." },
  GITHUB_CHECK: {
    fallback: "Your github account does not meet the minimum requirements.",
    allowDynamicMessage: true,
  },
  GITHUB_LIMIT: {
    fallback: "GitHub account faucet limit reached.",
    allowDynamicMessage: true,
  },
  INVALID_ADDR: { fallback: "Invalid target address." },
  INVALID_CAPTCHA: { fallback: "captcha check failed: invalid token" },
  INVALID_ENSNAME: { fallback: "Could not resolve ENS Name." },
  INVALID_IPINFO: { fallback: "Error while checking your IP." },
  INVALID_REMOTE_IP: { fallback: "Unable to determine a valid client IP address." },
  IPINFO_RESTRICTION: {
    fallback: "IP Blocked.",
    allowDynamicMessage: true,
    projectData: projectIpInfoData,
  },
  MAINNET_BALANCE_CHECK: { fallback: "Could not get balance of mainnet wallet." },
  MAINNET_BALANCE_LIMIT: {
    fallback: "This wallet does not meet the mainnet balance requirement.",
    allowDynamicMessage: true,
  },
  MAINNET_TXCOUNT_CHECK: { fallback: "Could not get tx-count of mainnet wallet." },
  MAINNET_TXCOUNT_LIMIT: {
    fallback: "This wallet does not meet the mainnet transaction-count requirement.",
    allowDynamicMessage: true,
  },
  NOT_CLAIMABLE: { fallback: "cannot claim session: not claimable" },
  PASSPORT_CHECK_FAILED: { fallback: "Could not verify Gitcoin Passport. Please try again shortly." },
  PASSPORT_SCORE: {
    fallback: "Your wallet does not meet the minimum passport score.",
    allowDynamicMessage: true,
    projectData: projectAddressData,
  },
  RACE_CLAIMING: { fallback: "cannot claim session: already claiming" },
  RECURRING_LIMIT: {
    fallback: "Faucet request limit reached.",
    allowDynamicMessage: true,
  },
  REQUIRE_ENSNAME: { fallback: "Only ENS Names allowed." },
  RESTRICTION: { fallback: "IP Blocked." },
  SESSION_TIMEOUT: { fallback: "Session timed out" },
  SHUTTING_DOWN: { fallback: "cannot claim session: faucet is shutting down" },
  SLASHED: { fallback: "invalid PoW verification result" },
  STAKE_CHECK_FAILED: { fallback: "Could not verify staked HYPE. Please try again in a few minutes." },
  STAKE_REQUIRED: {
    fallback: "Your wallet does not meet the minimum staked HYPE requirement.",
    allowDynamicMessage: true,
    projectData: projectAddressData,
  },
  VOUCHER_INVALID: { fallback: "The provided voucher code is not valid." },
  VOUCHER_REQUIRED: { fallback: "A valid voucher code is required." },
  VOUCHER_USED: { fallback: "This voucher code has already been used." },
  ZUPASS_CONCURRENCY_LIMIT: {
    fallback: "Concurrent session limit reached for this ticket holder.",
    allowDynamicMessage: true,
  },
  ZUPASS_LIMIT: {
    fallback: "Ticket-holder faucet limit reached.",
    allowDynamicMessage: true,
  },
  ZUPASS_REQUIRED: { fallback: "You need to authenticate with your zupass account to use this faucet." },
  ZUPASS_TOKEN: { fallback: "Invalid zupass login token" },
} satisfies Record<string, PublicErrorPolicy>);

type PublicErrorCode = keyof typeof PUBLIC_ERROR_POLICIES;

function isPublicErrorCode(code: unknown): code is PublicErrorCode {
  return typeof code === "string" && Object.hasOwn(PUBLIC_ERROR_POLICIES, code);
}

function isValidDynamicMessage(message: unknown): message is string {
  return typeof message === "string"
    && message.length > 0
    && message.length <= MAX_PUBLIC_ERROR_MESSAGE_LENGTH
    && message.trim().length > 0
    && !/[\u0000-\u001f\u007f-\u009f]/.test(message);
}

function internalFailure(): IClientFailure {
  return {
    failedCode: PUBLIC_INTERNAL_ERROR_CODE,
    failedReason: PUBLIC_INTERNAL_ERROR_MESSAGE,
  };
}

export function logUnexpectedWebError(context: string, error: unknown): void {
  const message = error instanceof Error
    ? `${error.message}${error.stack ? `\r\n   Stack Trace: ${error.stack}` : ""}`
    : String(error);
  ServiceManager.GetService(FaucetProcess).emitLog(
    FaucetLogLevel.ERROR,
    `Unexpected error ${context}: ${message}`
  );
}

export function toClientFailure(error: unknown, context: string, allowPublicData = false): IClientFailure {
  if(!(error instanceof FaucetError)) {
    logUnexpectedWebError(context, error);
    return internalFailure();
  }

  const code = error.getCode();
  if(!isPublicErrorCode(code)) {
    logUnexpectedWebError(context, error);
    return internalFailure();
  }
  const policy: PublicErrorPolicy = PUBLIC_ERROR_POLICIES[code];

  if(!(error instanceof PublicFaucetError)) {
    return {
      failedCode: code,
      failedReason: policy.fallback,
    };
  }

  if(!policy.allowDynamicMessage || !isValidDynamicMessage(error.message)) {
    logUnexpectedWebError(context, error);
    return internalFailure();
  }

  let projectedData = NO_PUBLIC_DATA;
  try {
    if(policy.projectData)
      projectedData = policy.projectData(error.publicData);
    else if(error.publicData !== undefined)
      projectedData = INVALID_PROJECTION;
  } catch {
    projectedData = INVALID_PROJECTION;
  }

  if(!projectedData.ok) {
    logUnexpectedWebError(context, error);
    return internalFailure();
  }

  const failure: IClientFailure = {
    failedCode: code,
    failedReason: error.message,
  };
  if(allowPublicData && projectedData.data)
    failure.failedData = projectedData.data;
  return failure;
}

export function toStoredClientFailure(code: unknown): IClientFailure {
  if(!isPublicErrorCode(code))
    return internalFailure();
  return {
    failedCode: code,
    failedReason: PUBLIC_ERROR_POLICIES[code].fallback,
  };
}

export function getPublicClaimError(status: unknown): string | undefined {
  if(status === "failed")
    return PUBLIC_CLAIM_FAILED_MESSAGE;
  if(status === "reverted")
    return PUBLIC_CLAIM_REVERTED_MESSAGE;
  return undefined;
}
