import { IBaseModuleConfig } from "../BaseModule.js";

export interface IFaucetOutflowConfig extends IBaseModuleConfig {
  amount: number | string;
  duration: number;
  lowerLimit: number | string;
  upperLimit: number | string;
}

export const defaultConfig: IFaucetOutflowConfig = {
  enabled: false,
  amount: 0,
  duration: 86400,
  lowerLimit: 0,
  upperLimit: 0,
}
