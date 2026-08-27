import { PoWHashAlgo } from "../types/PoWMinerSrc";

export interface IFaucetConfig {
  faucetTitle: string;
  faucetStatus: IFaucetStatus[];
  faucetStatusHash: string;
  faucetHtml: string;
  faucetWallet: string;
  faucetDonation: string | null;
  faucetCoinSymbol: string;
  faucetCoinType: string;
  faucetCoinContract: string;
  faucetCoinDecimals: number;
  minClaim: number;
  maxClaim: number;
  sessionTimeout: number;
  ethTxExplorerLink: string;
  time: number;
  modules: {
    authenticatoor?: IAuthenticatoorModuleConfig;
    captcha?: ICaptchaModuleConfig;
    ensname?: IEnsNameModuleConfig;
    github?: IGithubModuleConfig;
    pow?: IPoWModuleConfig;
    passport?: IPassportModuleConfig;
    voucher?: IVoucherModuleConfig;
    zupass?: IZupassModuleConfig;
    "hyperliquid-stake"?: IHyperliquidStakeModuleConfig;
  };
}

export interface IHyperliquidStakeModuleConfig {
  boostFactor: {[minStakedUsd: number]: number};
  refreshTimeout: number;
  requiredStakeUsd: number;
  restrictedToValidators: boolean;
}

export interface IAuthenticatoorModuleConfig {
  authUrl: string;
  requireLogin: boolean;
  loginLabel: string | null;
  userLabel: string | null;
  infoHtml: string | null;
  loginLogo: string | null;
}

export interface ICaptchaModuleConfig {
  provider: string;
  siteKey: string;
  requiredForStart: boolean;
  requiredForClaim: boolean;
}

export interface IEnsNameModuleConfig {
  required: boolean;
}

export interface IGithubModuleConfig {
  clientId: string;
  authTimeout: number;
  redirectUrl: string;
}

export interface IZupassModuleConfig {
  redirectUrl: string | null;
  loginLogo: string | null;
  loginLabel: string | null;
  userLabel: string | null;
  infoHtml: string | null;
}

export interface IPoWModuleConfig {
  powWsUrl: string;
  powTimeout: number;
  powIdleTimeout: number;
  powParams: PoWParams;
  powDifficulty: number;
  powHashrateLimit: number;
}

export type PoWParams = {
  a: PoWHashAlgo.SCRYPT,
  n: number; // cpu and memory cost
  r: number; // block size
  p: number; // parallelization
  l: number; // key length
} | {
  a: PoWHashAlgo.CRYPTONIGHT,
  c: number; // cn-algo
  v: number; // variant
  h: number; // height
} | {
  a: PoWHashAlgo.ARGON2;
  t: number; // type
  v: number; // version
  i: number; // timeCost
  m: number; // memoryCost
  p: number; // parallelization,
  l: number; // keyLength
} | {
  a: PoWHashAlgo.NICKMINER;
  i: string; // input hash
  r: string; // sigR
  v: number; // sigV
  c: number; // count
  s: string; // suffix
  p: string; // prefix
}

export interface IPassportModuleConfig {
  refreshTimeout: number;
  manualVerification: boolean;
  stampScoring: {[stamp: string]: number};
  boostFactor: {[score: number]: number};
  overrideScores: [number, number, number];
  guestRefresh: number | boolean;
}

export interface IVoucherModuleConfig {
  voucherLabel: string;
  infoHtml: string;
}

export interface IFaucetStatus {
  text: string;
  level: string;
  prio: number;
  ishtml: boolean;
  blocksSessionStart?: boolean;
}
