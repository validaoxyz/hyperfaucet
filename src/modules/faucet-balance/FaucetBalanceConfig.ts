import { IBaseModuleConfig } from "../BaseModule.js";

export interface IFaucetBalanceConfig extends IBaseModuleConfig {
  fixedRestriction?: Record<string, number> | null; // key: min balance in base units, value: percent of normal reward (eg. 50 = half rewards)
  dynamicRestriction?: {
    targetBalance: number | string;
  } | null;
}

export const defaultConfig: IFaucetBalanceConfig = {
  enabled: false,
  fixedRestriction: null,
  dynamicRestriction: null,
}
