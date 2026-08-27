export interface IStakeData {
  address: string;
  delegated: number;
  totalDelegated: number;
  stakedUsd: number;
  tokenPrice: number;
  time: number;
  error?: string;
}

export interface IStakeBoost {
  factor: number;
  stakedUsd: number;
  nextTierUsd: number | null;
  nextTierFactor: number | null;
}

export interface IStakeInfoResponse {
  address?: string;
  stakeInfo?: IStakeData | null;
  boost?: IStakeBoost | null;
  verified?: boolean;
  cooldown?: number;
  code?: string;
  error?: string;
}

export interface IStakeChallengeResponse extends IStakeInfoResponse {
  challengeId?: string;
  message?: string;
  expiresAt?: number;
}
