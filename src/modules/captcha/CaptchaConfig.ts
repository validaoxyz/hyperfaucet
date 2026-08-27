import { IBaseModuleConfig } from "../BaseModule.js";

export const captchaProviders = ["hcaptcha", "recaptcha", "turnstile", "custom"] as const;
export type CaptchaProvider = typeof captchaProviders[number];

export interface ICaptchaConfig extends IBaseModuleConfig {
  provider: CaptchaProvider;
  siteKey: string; // site key
  secret: string; // secret key
  checkSessionStart: boolean; // require captcha to start a new mining session
  checkBalanceClaim: boolean; // require captcha to claim mining rewards
  allowedHostnames: string[]; // optional exact hostname allowlist for Turnstile
}

export const defaultConfig: ICaptchaConfig = {
  enabled: false,
  provider: null,
  siteKey: null,
  secret: null,
  checkSessionStart: false,
  checkBalanceClaim: false,
  allowedHostnames: [],
}
