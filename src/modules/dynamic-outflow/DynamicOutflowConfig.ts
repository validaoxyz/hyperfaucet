import { IBaseModuleConfig } from "../BaseModule.js";

export interface IDynamicOutflowConfig extends IBaseModuleConfig {
  targetDrainTime: number; // target time (seconds) in which sustained mining at the current rate would drain the faucet wallet
  refreshInterval: number; // how often (seconds) the outflow rate is recomputed from the current wallet balance
  burstWindow: number; // seconds worth of unused outflow budget that may accumulate as burst buffer
  cutoffWindow: number; // seconds worth of overdrafted budget at which the reward factor reaches 0
}

const durationFields = ["targetDrainTime", "refreshInterval", "burstWindow", "cutoffWindow"] as const;

export function validateDynamicOutflowConfig(config: IDynamicOutflowConfig): void {
  for(const field of durationFields) {
    const value = config[field];
    if(!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${field} must be a positive safe integer number of seconds`);
  }
}

export const defaultConfig: IDynamicOutflowConfig = {
  enabled: false,
  targetDrainTime: 359100, // 4 days 3 hours 45 minutes; ~1 HYPE per 15 minutes at 400 HYPE with a 1 HYPE reserve
  refreshInterval: 60,
  burstWindow: 900, // 15 minutes
  cutoffWindow: 900, // 15 minutes
}
