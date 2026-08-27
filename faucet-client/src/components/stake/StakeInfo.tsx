import React from 'react';
import { IFaucetConfig } from '../../common/FaucetConfig';
import { IFaucetContext } from '../../common/FaucetContext';

export interface IStakeInfoProps {
  pageContext: IFaucetContext;
  faucetConfig: IFaucetConfig;
  sessionId?: string;
  sessionStartTime?: number; // seed the initial refresh cooldown without a failed round-trip
  targetAddr: string;
  refreshFn?: (boost: IStakeBoost) => void;
  children?: React.ReactElement | React.ReactElement[];
}

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

export interface IStakeInfoState {
  loading: boolean;
  refreshing: boolean;
  stakeInfo: IStakeData | null;
  boost: IStakeBoost | null;
  refreshCooldown: number;
  refreshError: string;
  refreshIdx: number;
}

export class StakeInfo extends React.PureComponent<IStakeInfoProps, IStakeInfoState> {
  private cooldownTimer: NodeJS.Timeout;

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
    };
  }

  public componentDidMount() {
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
    if(this.cooldownTimer) {
      clearInterval(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  private async loadStakeInfo() {
    try {
      let rsp = await this.props.pageContext.faucetApi.getStakeInfo(this.props.sessionId, this.props.targetAddr);
      this.setState({
        loading: false,
        stakeInfo: rsp?.stakeInfo || null,
        boost: rsp?.boost || null,
        refreshCooldown: !this.props.sessionId && rsp?.cooldown
          ? rsp.cooldown
          : this.state.refreshCooldown,
      });
    } catch(ex) {
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
      this.setState({
        refreshing: false,
        stakeInfo: rsp?.stakeInfo || null,
        boost: rsp?.boost || null,
        refreshCooldown: rsp?.cooldown || 0,
      });
      if(this.props.refreshFn && rsp?.boost)
        this.props.refreshFn(rsp.boost);
    } catch(ex) {
      this.setState({
        refreshing: false,
        refreshError: "Could not refresh stake info",
      });
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

        <div className="stake-refresh">
          <span>
            {this.state.refreshError ? this.state.refreshError :
             cooldownLeft > 0 ? "Refresh available in " + cooldownLeft + "s" :
             this.props.sessionId ? "Refresh to apply stake added after starting." :
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
      </div>
    );
  }
}
