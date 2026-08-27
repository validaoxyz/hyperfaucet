import { IBaseModuleConfig } from "../BaseModule.js";

export interface IConcurrencyLimitConfig extends IBaseModuleConfig {
  concurrencyLimit: number;
  byAddrOnly: boolean;
  byIPOnly: boolean;
  messageByAddr: string | null;
  messageByIP: string | null;
}

export const defaultConfig: IConcurrencyLimitConfig = {
  enabled: false,
  concurrencyLimit: 0,
  byAddrOnly: false,
  byIPOnly: false,
  messageByAddr: null,
  messageByIP: null,
}
