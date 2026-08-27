import { IBaseModuleConfig } from "../BaseModule.js";

export const MAX_REPORTED_HASHRATE = 1_000_000_000;

export function isValidReportedHashrate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_REPORTED_HASHRATE;
}

const PERCENTAGE_BASIS_POINT_SCALE = 10_000n;

export function percentageToBasisPoints(value: unknown, fieldName = "percentage"): bigint {
  if(typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)
    throw new Error(`${fieldName} must be a finite percentage between 0 and 100`);

  let [mantissa, rawExponent = "0"] = value.toString().toLowerCase().split("e");
  let exponent = Number(rawExponent);
  let [whole, fraction = ""] = mantissa.split(".");
  let digits = (whole + fraction).replace(/^0+/, "") || "0";
  let decimalPlaces = fraction.length - exponent;

  if(decimalPlaces < 0) {
    digits += "0".repeat(-decimalPlaces);
    decimalPlaces = 0;
  }
  if(decimalPlaces > 2) {
    let excessPlaces = decimalPlaces - 2;
    if(!digits.endsWith("0".repeat(excessPlaces)))
      throw new Error(`${fieldName} must use at most two decimal places`);
    digits = digits.slice(0, -excessPlaces) || "0";
    decimalPlaces = 2;
  }
  if(decimalPlaces < 2)
    digits += "0".repeat(2 - decimalPlaces);

  let basisPoints = BigInt(digits);
  if(basisPoints > PERCENTAGE_BASIS_POINT_SCALE)
    throw new Error(`${fieldName} must be no greater than 100`);
  return basisPoints;
}

export function applyPoWPercentage(amount: bigint, percentage: number): bigint {
  return amount * percentageToBasisPoints(percentage) / PERCENTAGE_BASIS_POINT_SCALE;
}

function requireFiniteNumber(fieldName: string, value: unknown, minimum: number, allowMinimum: boolean): void {
  if(
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (allowMinimum ? value < minimum : value <= minimum)
  ) {
    let comparison = allowMinimum ? "at least" : "greater than";
    throw new Error(`${fieldName} must be a finite number ${comparison} ${minimum}`);
  }
}

function requireSafeInteger(fieldName: string, value: unknown, minimum: number): void {
  if(!Number.isSafeInteger(value) || (value as number) < minimum)
    throw new Error(`${fieldName} must be a safe integer of at least ${minimum}`);
}

function requireSafeIntegerRange(fieldName: string, value: unknown, minimum: number, maximum: number): void {
  requireSafeInteger(fieldName, value, minimum);
  if((value as number) > maximum)
    throw new Error(`${fieldName} must be no greater than ${maximum}`);
}

export function validatePoWConfig(config: IPoWConfig): void {
  if(!Number.isSafeInteger(config.powShareReward) || config.powShareReward < 0)
    throw new Error("powShareReward must be a non-negative safe integer");

  requireFiniteNumber("powSessionTimeout", config.powSessionTimeout, 0, false);
  requireFiniteNumber("powIdleTimeout", config.powIdleTimeout, 0, true);
  requireFiniteNumber("powPingInterval", config.powPingInterval, 0, false);
  requireFiniteNumber("powPingTimeout", config.powPingTimeout, 0, false);
  requireFiniteNumber("verifyLocalTimeout", config.verifyLocalTimeout, 0, false);
  requireFiniteNumber("verifyMinerTimeout", config.verifyMinerTimeout, 0, false);
  requireFiniteNumber("powHashrateSoftLimit", config.powHashrateSoftLimit, 0, true);
  requireFiniteNumber("powHashrateHardLimit", config.powHashrateHardLimit, 0, true);

  requireSafeInteger("powScryptParams.cpuAndMemory", config.powScryptParams?.cpuAndMemory, 2);
  if(!Number.isInteger(Math.log2(config.powScryptParams.cpuAndMemory)))
    throw new Error("powScryptParams.cpuAndMemory must be a power of two");
  requireSafeInteger("powScryptParams.blockSize", config.powScryptParams?.blockSize, 1);
  requireSafeInteger("powScryptParams.parallelization", config.powScryptParams?.parallelization, 1);
  requireSafeIntegerRange(
    "powScryptParams.keyLength",
    config.powScryptParams?.keyLength,
    1,
    Math.floor(Number.MAX_SAFE_INTEGER / 8),
  );

  requireSafeInteger("powCryptoNightParams.algo", config.powCryptoNightParams?.algo, 0);
  requireSafeInteger("powCryptoNightParams.variant", config.powCryptoNightParams?.variant, 0);
  requireSafeInteger("powCryptoNightParams.height", config.powCryptoNightParams?.height, 0);

  requireSafeIntegerRange("powArgon2Params.type", config.powArgon2Params?.type, 0, 2);
  requireSafeInteger("powArgon2Params.version", config.powArgon2Params?.version, 1);
  requireSafeInteger("powArgon2Params.timeCost", config.powArgon2Params?.timeCost, 1);
  requireSafeInteger("powArgon2Params.memoryCost", config.powArgon2Params?.memoryCost, 1);
  requireSafeInteger("powArgon2Params.parallelization", config.powArgon2Params?.parallelization, 1);
  requireSafeIntegerRange(
    "powArgon2Params.keyLength",
    config.powArgon2Params?.keyLength,
    1,
    Math.floor(Number.MAX_SAFE_INTEGER / 8),
  );

  requireSafeInteger("powNickMinerParams.sigV", config.powNickMinerParams?.sigV, 0);
  requireSafeInteger("powNickMinerParams.count", config.powNickMinerParams?.count, 1);
  requireSafeIntegerRange("powNickMinerParams.relevantDifficulty", config.powNickMinerParams?.relevantDifficulty, 0, 255);

  let maximumDifficulty: number;
  switch(config.powHashAlgo) {
    case PoWHashAlgo.SCRYPT:
      maximumDifficulty = config.powScryptParams.keyLength * 8;
      break;
    case PoWHashAlgo.CRYPTONIGHT:
      maximumDifficulty = 256;
      break;
    case PoWHashAlgo.ARGON2:
      maximumDifficulty = config.powArgon2Params.keyLength * 8;
      break;
    case PoWHashAlgo.NICKMINER:
      maximumDifficulty = 255;
      break;
    default:
      throw new Error("powHashAlgo is not supported");
  }
  requireSafeIntegerRange("powDifficulty", config.powDifficulty, 0, maximumDifficulty);
  requireSafeInteger("powSessionsPerServer", config.powSessionsPerServer, 0);
  requireSafeInteger("verifyLocalMaxQueue", config.verifyLocalMaxQueue, 1);
  requireSafeInteger("verifyLocalMaxPendingPerSession", config.verifyLocalMaxPendingPerSession, 1);
  requireSafeIntegerRange("verifyLocalMaxSessionDutyCyclePercent", config.verifyLocalMaxSessionDutyCyclePercent, 1, 50);
  requireSafeInteger("verifyMinerPeerCount", config.verifyMinerPeerCount, 0);
  requireSafeInteger("verifyMinerIndividuals", config.verifyMinerIndividuals, 0);
  requireSafeInteger("verifyMinerMaxPending", config.verifyMinerMaxPending, 0);
  requireSafeInteger("verifyMinerMaxMissed", config.verifyMinerMaxMissed, 0);

  if(config.verifyLocalMaxPendingPerSession >= config.verifyLocalMaxQueue) {
    throw new Error(
      "verifyLocalMaxPendingPerSession must be less than verifyLocalMaxQueue so one session cannot consume all local validation capacity",
    );
  }

  let percentages: Array<[string, unknown]> = [
    ["verifyLocalPercent", config.verifyLocalPercent],
    ["verifyLocalLowPeerPercent", config.verifyLocalLowPeerPercent],
    ["verifyMinerPercent", config.verifyMinerPercent],
    ["verifyMinerRewardPerc", config.verifyMinerRewardPerc],
    ["verifyMinerMissPenaltyPerc", config.verifyMinerMissPenaltyPerc],
  ];
  for(let [fieldName, value] of percentages)
    percentageToBasisPoints(value, fieldName);
}

export interface IPoWConfig extends IBaseModuleConfig {
  /* PoW parameters */
  powShareReward: number; // reward amount per share (in wei)
  powSessionTimeout: number; // maximum mining session time in seconds
  powIdleTimeout: number; // maximum number of seconds a session can idle until it gets closed
  powPingInterval: number; // websocket ping interval
  powPingTimeout: number; // kill websocket if no ping/pong for that number of seconds
  powHashAlgo: PoWHashAlgo; // hash algorithm to use ("sc" = SCrypt, "cn" = CryptoNight), defaults to SCrypt
  powScryptParams: IPoWSCryptParams; // scrypt parameters
  powCryptoNightParams: IPoWCryptoNightParams; // cryptonight parameters
  powArgon2Params: IPoWArgon2Params; // argon2 parameters
  powNickMinerParams: IPoWNickMinerParams; // nickminer parameters
  powDifficulty: number; // number of 0-bits the scrypt hash needs to start with to be egliable for a reward
  powHashrateSoftLimit: number; // maximum allowed mining hashrate (will be throttled to this rate when faster); 0 disables client throttling
  powHashrateHardLimit: number; // nonce progression limit; 0 disables this check but not the local validator CPU budget

  powSessionsPerServer: number; // maximum number of sessions per server sub-process (0 = unlimited)

  /* PoW-share verification
  Every rewarded share is validated locally. Peer verification is advisory telemetry used to reward
  accurate verifiers and penalize incorrect or missing responses. Bad shares terminate the mining
  session and forfeit its collected balance.
  */
  verifyLocalPercent: number; // retained for configuration compatibility; all rewarded shares are validated locally
  verifyLocalMaxQueue: number; // hard cap across queued and in-flight local validations; full capacity rejects new shares
  verifyLocalMaxPendingPerSession: number; // per-session backlog cap; admitted sessions are dispatched round-robin
  verifyLocalMaxSessionDutyCyclePercent: number; // maximum validator duty cycle for one session; measured work earns dispatch cooldown, range 1 through 50
  verifyLocalTimeout: number; // admission-to-result deadline covering both queue time and hashing
  verifyMinerPeerCount: number; // minimum number of eligible peers before sampling peer telemetry
  verifyLocalLowPeerPercent: number; // retained for configuration compatibility; all rewarded shares are validated locally
  verifyMinerPercent: number; // percentage of shares sampled for peer telemetry (0 - 100)
  verifyMinerIndividuals: number; // number of other mining sessions to redistribute a share to for verification
  verifyMinerMaxPending: number; // max number of pending verifications per miner before not sending any more verification requests
  verifyMinerMaxMissed: number; // max number of missed verifications before not sending any more verification requests
  verifyMinerTimeout: number; // timeout for verification requests (client gets penalized if not responding within this timespan)
  verifyMinerRewardPerc: number; // percent of powShareReward as reward for responding to a verification request in time
  verifyMinerMissPenaltyPerc: number; // percent of powShareReward as penalty for not responding to a verification request (shouldn't be too high as this can happen regularly in case of connection loss or so)
}

export enum PoWHashAlgo {
  SCRYPT      = "scrypt",
  CRYPTONIGHT = "cryptonight",
  ARGON2      = "argon2",
  NICKMINER   = "nickminer",
}

export interface IPoWSCryptParams {
  cpuAndMemory: number; // N - iterations count (affects memory and CPU usage, must be a power of 2)
  blockSize: number; // r - block size (affects memory and CPU usage)
  parallelization: number; // p - parallelism factor (threads to run in parallel, affects the memory, CPU usage), should be 1 as webworker is single threaded
  keyLength: number; // klen - how many bytes to generate as output, e.g. 16 bytes (128 bits)
}

export interface IPoWCryptoNightParams {
  algo: number;
  variant: number;
  height: number;
}

export interface IPoWArgon2Params {
  type: number;
  version: number;
  timeCost: number; // time cost (iterations), default: 1
  memoryCost: number; // memory size
  parallelization: number; // parallelism factor (threads to run in parallel, affects the memory, CPU usage), should be 1 as webworker is single threaded
  keyLength: number; // how many bytes to generate as output, e.g. 16 bytes (128 bits)
}

export interface IPoWNickMinerParams {
  hash: string; // input hash
  sigR: string; // sigR
  sigV: number; // sigV
  count: number; // number of hashed per hash call
  suffix: string; // suffix to check for in the hash (client side)
  prefix: string; // additional prefix to check for on server side for interesting nonces

  relevantDifficulty: number; // min difficulty to thread a hash as relevant
  relevantFile: string; // filename to store relevant data
}

export type PoWCryptoParams = IPoWSCryptParams | IPoWCryptoNightParams | IPoWArgon2Params | IPoWNickMinerParams;

export const defaultConfig: IPoWConfig = {
  enabled: false,
  powShareReward: 0,
  powSessionTimeout: 7200,
  powIdleTimeout: 1800,
  powPingInterval: 60,
  powPingTimeout: 120,
  powHashAlgo: PoWHashAlgo.ARGON2,
  powScryptParams: {
    cpuAndMemory: 4096,
    blockSize: 8,
    parallelization: 1,
    keyLength: 16,
  },
  powCryptoNightParams: {
    algo: 0,
    variant: 0,
    height: 0,
  },
  powArgon2Params: {
    type: 0,
    version: 13,
    timeCost: 4,
    memoryCost: 4096,
    parallelization: 1,
    keyLength: 16,
  },
  powNickMinerParams: {
    hash: "1234567890123456",
    sigR: "0539",
    sigV: 27,
    count: 60,
    suffix: "beac02",
    prefix: "0000",
    relevantDifficulty: 0,
    relevantFile: null,
  },
  powDifficulty: 11,
  powHashrateSoftLimit: 0,
  powHashrateHardLimit: 0,
  powSessionsPerServer: 0,
  verifyLocalPercent: 10,
  verifyLocalMaxQueue: 100,
  verifyLocalMaxPendingPerSession: 4,
  verifyLocalMaxSessionDutyCyclePercent: 25,
  verifyLocalTimeout: 30,
  verifyMinerPeerCount: 4,
  verifyLocalLowPeerPercent: 80,
  verifyMinerPercent: 75,
  verifyMinerIndividuals: 2,
  verifyMinerMaxPending: 5,
  verifyMinerMaxMissed: 10,
  verifyMinerTimeout: 30,
  verifyMinerRewardPerc: 15,
  verifyMinerMissPenaltyPerc: 10,
}
