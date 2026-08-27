import { IBaseModuleConfig } from "../BaseModule.js";

export interface IEthInfoConfig extends IBaseModuleConfig {
  requestTimeout: number; // caller timeout in milliseconds; timed-out RPC work keeps its capacity until it settles
  maxConcurrentLookups: number; // maximum physical wallet policy checks owned by this module
  maxBalance: number;
  denyContract: boolean;
}

export const defaultConfig: IEthInfoConfig = {
  enabled: false,
  requestTimeout: 10000,
  maxConcurrentLookups: 8,
  maxBalance: 0,
  denyContract: false,
}
