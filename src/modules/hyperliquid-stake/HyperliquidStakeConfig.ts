import { IBaseModuleConfig } from "../BaseModule.js";

export interface IHyperliquidStakeConfig extends IBaseModuleConfig {
  infoApiUrl: string; // hyperliquid info endpoint used for stake lookups (mainnet: https://api.hyperliquid.xyz/info)
  boostFactor: {
    [minStakedUsd: number]: number; // reward factor when staked value (USD) >= key; highest matching tier applies
  };
  validatorFilter: string[]; // only count stake delegated to these validator addresses (empty = count all delegations)
  fixedTokenPrice: number; // fixed HYPE/USD price (0 = fetch live price from the info API)
  priceCacheTime: number; // seconds to cache the live HYPE price
  stakeCacheTime: number; // seconds to cache a wallet's stake lookup
  refreshCooldown: number; // min seconds between manual stake refreshes per session
  requiredStakeUsd: number; // deny session start below this staked value in USD (0 = no requirement); the gate fails closed on API errors regardless of failOnApiError
  failOnApiError: boolean; // false: continue without boost when the info API is unreachable (boost only; a requiredStakeUsd gate always fails closed)
  requestTimeout: number; // info API request timeout in ms
  guestLookupRateLimit: number; // max live guest and session-start stake lookups per IP per minute (0 = unlimited)
  maxConcurrentLookups: number; // max distinct wallet stake lookups in flight across guest and session-start requests
}

export const defaultConfig: IHyperliquidStakeConfig = {
  enabled: false,
  infoApiUrl: "https://api.hyperliquid.xyz/info",
  boostFactor: {
    10000: 2,
    50000: 3,
  },
  validatorFilter: [],
  fixedTokenPrice: 0,
  priceCacheTime: 300,
  stakeCacheTime: 600,
  refreshCooldown: 300,
  requiredStakeUsd: 0,
  failOnApiError: false,
  requestTimeout: 10000,
  guestLookupRateLimit: 6,
  maxConcurrentLookups: 8,
}
