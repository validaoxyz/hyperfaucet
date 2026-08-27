import { IBaseModuleConfig } from "../BaseModule.js";

export const MAX_PASSPORT_PROVIDER_LENGTH = 128;
export const PASSPORT_SCORE_DECIMAL_PLACES = 6;
export const PASSPORT_SCORE_SCALE = 10 ** PASSPORT_SCORE_DECIMAL_PLACES;

declare const passportScoreUnitsBrand: unique symbol;
export type PassportScoreUnits = number & {readonly [passportScoreUnitsBrand]: true};

const CANONICAL_PASSPORT_SCORE = /^(0|[1-9][0-9]*)(?:\.([0-9]{0,5}[1-9]))?$/;

// Passport scores use integer micro-score units internally. Config values may have at most six decimal places.
export function parsePassportScoreUnits(value: unknown): PassportScoreUnits | null {
  if(typeof value === "number") {
    if(!Number.isFinite(value) || value < 0 || Object.is(value, -0))
      return null;
    value = value.toString();
  }
  if(typeof value !== "string")
    return null;

  let match = CANONICAL_PASSPORT_SCORE.exec(value);
  if(!match)
    return null;
  let whole = Number(match[1]);
  let fractional = match[2] || "";
  let units = whole * PASSPORT_SCORE_SCALE
    + Number(fractional.padEnd(PASSPORT_SCORE_DECIMAL_PLACES, "0"));
  if(!Number.isSafeInteger(units) || units < 0)
    return null;
  return units as PassportScoreUnits;
}

export function passportScoreUnitsToNumber(units: PassportScoreUnits): number {
  return units / PASSPORT_SCORE_SCALE;
}

export interface IPassportConfig extends IBaseModuleConfig {
  scorerApiKey: string | null;
  cachePath: string | null;
  cacheTime: number;
  trustedIssuers: string[];
  refreshCooldown: number;
  stampDeduplicationTime: number;
  stampScoring: {[stamp: string]: number};
  boostFactor: {[score: string]: number};
  requireMinScore: number;
  skipProxyCheckScore: number;
  skipHostingCheckScore: number;
  allowGuestRefresh: boolean;
  guestRefreshCooldown: number;
  guestLookupRateLimit: number; // max guest submissions/refreshes and uncached session-start scorer lookups per IP per minute
  cacheLookupConcurrency: number;
  automaticLookupConcurrency: number;
  maxPassportBytes: number;
  maxPassportStamps: number;
  manualVerificationConcurrency: number;
  manualVerificationTimeout: number;
}

export const defaultConfig: IPassportConfig = {
  enabled: false,
  scorerApiKey: null,
  cachePath: null,
  cacheTime: 86400,
  trustedIssuers: [ "did:key:z6MkghvGHLobLEdj1bgRLhS4LPGJAvbMA1tn2zcRyqmYU5LC" ],
  refreshCooldown: 300,
  stampDeduplicationTime: 86400 * 3,
  stampScoring: {},
  boostFactor: {},
  requireMinScore: 0,
  skipProxyCheckScore: 0,
  skipHostingCheckScore: 0,
  allowGuestRefresh: false,
  guestRefreshCooldown: 0,
  guestLookupRateLimit: 6,
  cacheLookupConcurrency: 16,
  automaticLookupConcurrency: 8,
  maxPassportBytes: 256 * 1024,
  maxPassportStamps: 64,
  manualVerificationConcurrency: 2,
  manualVerificationTimeout: 20,
}
