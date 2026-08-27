import { IBaseModuleConfig } from "../BaseModule.js";

export interface IMainnetWalletConfig extends IBaseModuleConfig {
  rpcHost: string | object | null;
  requestTimeout: number; // caller timeout in milliseconds; timed-out RPC work keeps its capacity until it settles
  maxConcurrentLookups: number; // maximum physical wallet policy checks owned by this module
  minTxCount: number;
  minBalance: number;
  minErc20Balances: {
    name: string;
    address: string;
    decimals?: number;
    minBalance: number;
  }[]
}

export const defaultConfig: IMainnetWalletConfig = {
  enabled: false,
  rpcHost: null,
  requestTimeout: 10000,
  maxConcurrentLookups: 8,
  minTxCount: 0,
  minBalance: 0,
  minErc20Balances: [],
}
