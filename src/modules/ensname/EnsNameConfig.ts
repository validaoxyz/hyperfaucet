import { IBaseModuleConfig } from "../BaseModule.js";

export interface IEnsNameConfig extends IBaseModuleConfig {
  rpcHost: string | object | null; // ETH execution layer RPC host for ENS resolver
  ensAddr: string | null; // ENS Resolver contract address or null for default resolver
  required: boolean;
  requestTimeout: number; // caller timeout in milliseconds; timed-out RPC work keeps its capacity until it settles
  maxConcurrentLookups: number; // maximum physical ENS lookups owned by this module
}

export const defaultConfig: IEnsNameConfig = {
  enabled: false,
  rpcHost: null,
  ensAddr: null,
  required: false,
  requestTimeout: 10000,
  maxConcurrentLookups: 8,
}
