import React from 'react';
import { IFaucetConfig } from '../../common/FaucetConfig';
import { IFaucetContext } from '../../common/FaucetContext';
import { IStakeBoost, IStakeData, IStakeInfoResponse } from '../../types/StakeInfo';
import {
  WalletOwnershipError,
  getInjectedWallet,
  requestTargetAccount,
  signOwnershipMessage,
} from './injectedWallet';

export interface IStakeInfoProps {
  pageContext: IFaucetContext;
  faucetConfig: IFaucetConfig;
  sessionId?: string;
  sessionStartTime?: number; // seed the initial refresh cooldown without a failed round-trip
  targetAddr: string;
  refreshFn?: (boost: IStakeBoost) => void;
  children?: React.ReactElement | React.ReactElement[];
}

type OwnershipStatus = "connecting" | "error" | "idle" | "preparing" | "signing" | "verified" | "verifying";

interface IOwnershipState {
  status: OwnershipStatus;
  message: string;
}

export interface IStakeInfoState {
  loading: boolean;
  refreshing: boolean;
  stakeInfo: IStakeData | null;
  boost: IStakeBoost | null;
  refreshCooldown: number;
  refreshError: string;
  refreshIdx: number;
  ownership: IOwnershipState;
}

export class StakeInfo extends React.PureComponent<IStakeInfoProps, IStakeInfoState> {
  private cooldownTimer: NodeJS.Timeout;
  private mounted = false;

  constructor(props: IStakeInfoProps) {
    super(props);

    this.state = {
      loading: true,
      refreshing: false,
      stakeInfo: null,
      boost: null,
      refreshCooldown: 0,
      refreshError: null,
      refreshIdx: 0,
      ownership: {
        status: "idle",
        message: "Connect this mining wallet to apply its stake boost.",
      },
    };
  }

  public componentDidMount() {
    this.mounted = true;
    // the server stamps the session refresh cooldown at session start, so the
    // Refresh control starts disabled with a countdown instead of inviting a
    // request that is known to fail
    let config = this.props.faucetConfig.modules["hyperliquid-stake"];
    if(this.props.sessionId && this.props.sessionStartTime && config?.refreshTimeout) {
      this.setState({ refreshCooldown: this.props.sessionStartTime + config.refreshTimeout });
    }
    this.loadStakeInfo();
    this.cooldownTimer = setInterval(() => {
      if(this.state.refreshCooldown > 0) {
        this.setState({ refreshIdx: this.state.refreshIdx + 1 });
      }
    }, 1000);
  }

  public componentWillUnmount() {
    this.mounted = false;
    if(this.cooldownTimer) {
      clearInterval(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  private async loadStakeInfo() {
    try {
      let rsp = await this.props.pageContext.faucetApi.getStakeInfo(this.props.sessionId, this.props.targetAddr);
      if(!this.mounted)
        return;
      if(rsp?.verified === true) {
        this.applyVerifiedResponse(rsp);
        return;
      }
      this.setState({
        loading: false,
        stakeInfo: rsp?.stakeInfo || null,
        boost: rsp?.boost || null,
        refreshCooldown: !this.props.sessionId && rsp?.cooldown
          ? rsp.cooldown
          : this.state.refreshCooldown,
      });
    } catch(ex) {
      if(!this.mounted)
        return;
      this.setState({
        loading: false,
        refreshError: "Could not load stake info",
      });
    }
  }

  private async onRefreshClick() {
    if(this.state.refreshing)
      return;
    this.setState({ refreshing: true, refreshError: null });
    try {
      // Guest checks never force-refresh shared address state. The server uses a
      // live lookup only after the cached value expires and enforces its own budget.
      let rsp = this.props.sessionId
        ? await this.props.pageContext.faucetApi.refreshStakeInfo(this.props.sessionId)
        : await this.props.pageContext.faucetApi.getStakeInfo(null, this.props.targetAddr, true);
      if(!this.mounted)
        return;
      if(rsp?.code === "REFRESH_COOLDOWN") {
        this.setState({
          refreshing: false,
          refreshCooldown: rsp.cooldown,
        });
        return;
      }
      if(rsp?.code) {
        this.setState({
          refreshing: false,
          refreshError: rsp.error || rsp.code,
        });
        return;
      }
      if(rsp?.verified === true) {
        this.applyVerifiedResponse(rsp);
        return;
      }
      this.setState({
        refreshing: false,
        stakeInfo: rsp?.stakeInfo || null,
        boost: rsp?.boost || null,
        refreshCooldown: rsp?.cooldown || 0,
      });
      if(this.props.refreshFn && rsp?.boost)
        this.props.refreshFn(rsp.boost);
    } catch(ex) {
      if(!this.mounted)
        return;
      this.setState({
        refreshing: false,
        refreshError: "Could not refresh stake info",
      });
    }
  }

  private async onVerifyWalletClick(): Promise<void> {
    if(!this.props.sessionId || this.isOwnershipBusy() || this.state.ownership.status === "verified")
      return;

    this.setOwnership("connecting", "Choose this mining wallet.");
    try {
      const provider = getInjectedWallet();
      const address = await requestTargetAccount(provider, this.props.targetAddr);
      if(!this.mounted)
        return;

      this.setOwnership("preparing", "Preparing wallet verification…");
      const challenge = await this.props.pageContext.faucetApi.getStakeChallenge(this.props.sessionId);
      if(!this.mounted)
        return;
      if(challenge.verified === true) {
        this.applyVerifiedResponse(challenge);
        return;
      }
      if(challenge.code) {
        this.setOwnership("error", this.getServerErrorMessage(challenge.code));
        return;
      }
      if(
        challenge.address?.toLowerCase() !== address ||
        !challenge.challengeId?.match(/^[0-9a-f]{64}$/i) ||
        typeof challenge.message !== "string" || challenge.message.length === 0 ||
        !Number.isSafeInteger(challenge.expiresAt)
      ) {
        this.setOwnership("error", "Could not verify the wallet. Try again.");
        return;
      }

      this.setOwnership("signing", "Sign the ownership message in your wallet.");
      const signature = await signOwnershipMessage(provider, address, challenge.message);
      if(!this.mounted)
        return;

      this.setOwnership("verifying", "Verifying wallet…");
      const response = await this.props.pageContext.faucetApi.verifyStakeOwnership(
        this.props.sessionId,
        challenge.challengeId,
        signature,
      );
      if(!this.mounted)
        return;
      if(response.verified === true) {
        this.applyVerifiedResponse(response);
        return;
      }
      this.setOwnership("error", this.getServerErrorMessage(response.code));
    } catch(ex) {
      if(!this.mounted)
        return;
      this.setOwnership("error", this.getWalletErrorMessage(ex));
    }
  }

  private applyVerifiedResponse(response: IStakeInfoResponse): void {
    if(
      response.address?.toLowerCase() !== this.props.targetAddr.toLowerCase() ||
      !this.isStakeBoost(response.boost)
    ) {
      this.setState({
        loading: false,
        refreshing: false,
        ownership: {status: "error", message: "Could not verify the wallet. Try again."},
      });
      return;
    }

    this.setState({
      loading: false,
      refreshing: false,
      refreshError: null,
      stakeInfo: response.stakeInfo || null,
      boost: response.boost,
      refreshCooldown: response.cooldown || 0,
      ownership: {status: "verified", message: this.getVerifiedMessage(response)},
    }, () => {
      if(this.props.refreshFn)
        this.props.refreshFn(response.boost);
    });
  }

  private setOwnership(status: OwnershipStatus, message: string): void {
    if(this.mounted)
      this.setState({ownership: {status, message}});
  }

  private isOwnershipBusy(): boolean {
    return ["connecting", "preparing", "signing", "verifying"].indexOf(this.state.ownership.status) !== -1;
  }

  private isStakeBoost(boost: IStakeBoost | null | undefined): boost is IStakeBoost {
    return !!boost && Number.isFinite(boost.factor) && boost.factor >= 1 && Number.isFinite(boost.stakedUsd);
  }

  private getVerifiedMessage(response: IStakeInfoResponse): string {
    if(response.code === "STAKE_CHECK_FAILED" || response.code === "STAKE_CHECK_RATE_LIMITED")
      return "Wallet verified. Stake lookup is unavailable. Use Refresh to try again.";
    if(response.boost && response.boost.factor > 1)
      return "Wallet verified. " + response.boost.factor + "x applies to new shares.";
    return "Wallet verified. Mining stays at 1x.";
  }

  private getWalletErrorMessage(error: unknown): string {
    if(error instanceof WalletOwnershipError) {
      switch(error.code) {
        case "NO_PROVIDER":
          return "No browser wallet detected.";
        case "ACCOUNT_MISMATCH":
          return "Switch to this mining wallet, then try again.";
        case "USER_REJECTED":
          return "Wallet verification canceled.";
        default:
          return "The wallet returned an invalid response. Try again.";
      }
    }
    return "Could not connect to the wallet. Try again.";
  }

  private getServerErrorMessage(code?: string): string {
    switch(code) {
      case "CHALLENGE_EXPIRED":
      case "CHALLENGE_NOT_FOUND":
        return "Verification expired. Try again.";
      case "INVALID_SESSION":
        return "This mining session is no longer active.";
      case "SIGNER_MISMATCH":
        return "The signature came from a different wallet.";
      case "OWNERSHIP_SAVE_FAILED":
        return "Could not save wallet verification. Try again.";
      default:
        return "Could not verify the wallet. Try again.";
    }
  }

  private getOwnershipButtonLabel(): string {
    switch(this.state.ownership.status) {
      case "connecting":
        return "Connecting…";
      case "preparing":
        return "Preparing…";
      case "signing":
        return "Waiting for signature…";
      case "verifying":
        return "Verifying…";
      case "verified":
        return "Verified";
      default:
        return "Connect wallet";
    }
  }

  private formatStake(value: number): string {
    return Math.floor(value).toLocaleString("en-US") + " HYPE";
  }

  // the "stake X more" hint rounds UP so a fractional remainder never renders
  // as "stake 0 more" right at a tier boundary
  private formatStakeCeil(value: number): string {
    return Math.ceil(value).toLocaleString("en-US") + " HYPE";
  }

  public render(): React.ReactElement<IStakeInfoProps> {
    let config = this.props.faucetConfig.modules["hyperliquid-stake"];
    if(!config)
      return null;

    if(this.state.loading) {
      return (
        <div className="stake-dialog">
          <div className="stake-summary">
            <span className="stake-amount">…</span>
          </div>
        </div>
      );
    }

    let stakeInfo = this.state.stakeInfo;
    let boost = this.state.boost;
    let tiers = Object.keys(config.boostFactor || {}).map((tier) => parseFloat(tier)).sort((a, b) => a - b);
    let activeTier = 0;
    tiers.forEach((tier) => {
      if(boost && boost.stakedUsd >= tier)
        activeTier = tier;
    });

    let now = Math.floor(new Date().getTime() / 1000);
    let cooldownLeft = this.state.refreshCooldown > now ? this.state.refreshCooldown - now : 0;
    let ownershipBusy = this.isOwnershipBusy();
    let ownershipVerified = this.state.ownership.status === "verified";
    let ownershipError = this.state.ownership.status === "error";

    return (
      <div className="stake-dialog">
        {this.props.children}
        <div className="stake-summary">
          <div>
            <div className="stake-amount">
              {stakeInfo && !stakeInfo.error ? this.formatStake(stakeInfo.stakedUsd) : "—"}
            </div>
            <div className="boost-descr" style={{marginTop: 0}}>
              {stakeInfo && !stakeInfo.error ? "staked" : "no stake data"}
            </div>
          </div>
          <div className="stake-factor">
            {boost && boost.factor > 1 ? boost.factor + "x rewards" : "1x rewards"}
          </div>
        </div>

        {stakeInfo?.error ?
          <div className="alert alert-warning">
            Stake lookup is temporarily unavailable. Mining continues at 1x.
          </div>
        : null}

        <div className="stake-tiers">
          <div className={"stake-tier-row" + (activeTier === 0 ? " active" : "")}>
            <span>under {this.formatStake(tiers[0] || 0)} staked</span>
            <span className="tier-factor">1x</span>
          </div>
          {tiers.map((tier) => (
            <div key={tier} className={"stake-tier-row" + (activeTier === tier ? " active" : "")}>
              <span>from {this.formatStake(tier)} staked</span>
              <span className="tier-factor">{config.boostFactor[tier]}x</span>
            </div>
          ))}
        </div>

        <div className="boost-descr">
          {config.restrictedToValidators ?
            "Boosts apply only to HYPE staked with this faucet's eligible validators on Hyperliquid mainnet." :
            "Boosts apply to HYPE staked with any Hyperliquid mainnet validator."}
          {config.requiredStakeUsd > 0 ?
            <> Mining requires at least {this.formatStake(config.requiredStakeUsd)} staked.</>
          : null}
          {boost && boost.nextTierUsd ?
            <> Stake {this.formatStakeCeil(boost.nextTierUsd - boost.stakedUsd)} more to reach {boost.nextTierFactor}x.</>
          : null}
        </div>

        {this.props.sessionId ?
          <div className={"stake-verify" + (ownershipError ? " error" : ownershipVerified ? " verified" : "")}>
            <span
              id="stake-verify-status"
              role="status"
              aria-live="polite"
            >
              {this.state.ownership.message}
            </span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              aria-busy={ownershipBusy}
              aria-describedby="stake-verify-status"
              aria-disabled={ownershipBusy || ownershipVerified}
              onClick={() => this.onVerifyWalletClick()}
            >
              {this.getOwnershipButtonLabel()}
            </button>
          </div>
        : null}

        {!this.props.sessionId || ownershipVerified ?
          <div className="stake-refresh">
            <span>
              {this.state.refreshError ? this.state.refreshError :
               cooldownLeft > 0 ? "Refresh available in " + cooldownLeft + "s" :
               this.props.sessionId ? "Refresh your stake." :
               "Refresh to re-check your stake."}
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={this.state.refreshing || cooldownLeft > 0}
              onClick={() => this.onRefreshClick()}
            >
              {this.state.refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        : null}
      </div>
    );
  }
}
