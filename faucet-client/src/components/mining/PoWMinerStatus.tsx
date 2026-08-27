import { IPoWMinerStats, PoWMiner } from '../../pow/PoWMiner';
import { PoWSession } from '../../pow/PoWSession';
import React from 'react';
import { toReadableAmount } from '../../utils/ConvertHelpers';
import { IFaucetConfig } from '../../common/FaucetConfig';
import { renderTimespan } from '../../utils/DateUtils';
import { FaucetTime } from '../../common/FaucetTime';
import { PoWClient } from '../../pow/PoWClient';
import { IPassportScoreInfo } from '../../types/PassportInfo';
import { OverlayTrigger, Tooltip } from 'react-bootstrap';
import { IFaucetContext } from '../../common/FaucetContext';
import { MascotView } from '../mascot/MascotView';
import { getAppearance } from '../appearance/appearance';
import { AddressChip } from '../shared/AddressChip';

export interface IPoWMinerStatusProps {
  pageContext: IFaucetContext;
  powClient: PoWClient;
  powMiner: PoWMiner;
  powSession: PoWSession;
  time: FaucetTime;
  faucetConfig: IFaucetConfig;
  passportScoreInfo: IPassportScoreInfo;
  openPassportInfo: () => void;
  stakeBoostInfo?: {stakeInfo: any, boost: {factor: number, stakedUsd: number}};
  openStakeInfo?: () => void;
}

export interface IPoWMinerStatusState {
  workerCountInput: number;
  refreshIndex: number;
  workerCount: number;
  hashRate: number;
  totalShares: number;
  balance: bigint;
  startTime: number;
  lastShareTime: number;
  showBoostInfoDialog: boolean;
  disableProgressGif: boolean;
}

export class PoWMinerStatus extends React.PureComponent<IPoWMinerStatusProps, IPoWMinerStatusState> {
  private powMinerStatsListener: ((stats: IPoWMinerStats) => void);
  private powSessionUpdateListener: (() => void);
  // re-render on mascot/theme switches so the mining mascot follows the picker
  private appearanceListener = () => {
    this.setState({ refreshIndex: this.state.refreshIndex + 1 });
  };
  private updateTimer: NodeJS.Timer;
  private stoppedMiner: boolean = false;
  // (time, balance) samples for the recent-rate display; a whole-session average
  // would keep showing the initial burst long after the outflow governor throttles
  private rateSamples: {time: number, balance: bigint}[] = [];

  constructor(props: IPoWMinerStatusProps) {
    super(props);

    this.state = {
      workerCountInput: this.props.powMiner.getTargetWorkerCount(),
      refreshIndex: 0,
      workerCount: 0,
      hashRate: 0,
      totalShares: this.props.powSession.getShareCount(),
      balance: this.props.powSession.getBalance(),
      startTime: this.props.powSession.getStartTime(),
      lastShareTime: 0,
      showBoostInfoDialog: false,
      disableProgressGif: false,
		};
  }

  public componentDidMount() {
    if(!this.powMinerStatsListener) {
      this.powMinerStatsListener = (stats: IPoWMinerStats) => {
        let stateChange: any = {
          hashRate: stats.hashRate,
          totalShares: this.props.powSession.getShareCount(),
          lastShareTime: stats.lastShareTime ? Math.floor(stats.lastShareTime.getTime() / 1000) : 0
        };
        if(this.state.workerCountInput === 0)
          stateChange.workerCountInput = stats.workerCount;
        if(this.state.workerCount !== stats.workerCount)
          stateChange.workerCount = stats.workerCount;
        
        this.setState(stateChange);
      };
      this.props.powMiner.on("stats", this.powMinerStatsListener);
    }
    if(!this.powSessionUpdateListener) {
      this.powSessionUpdateListener = () => {
        this.setState({
          balance: this.props.powSession.getBalance(),
        });
      };
      this.props.powSession.on("balanceUpdate", this.powSessionUpdateListener);
    }

    window.addEventListener("faucet-appearance-change", this.appearanceListener);

    if(!this.updateTimer) {
      this.setUpdateTimer();
    }
    this.props.powSession.once("resume", () => {
      this.setState({
        balance: this.props.powSession.getBalance(),
      });
    });

    let gifPref = localStorage.getItem("powMinerDisableGif");
    if(gifPref === "true") {
      this.setState({
        disableProgressGif: true,
      });
    }
    else if(gifPref === null && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // the mascot is a GIF, so reduced motion has to pause it here, not in CSS
      this.setState({
        disableProgressGif: true,
      });
    }
  }

  public componentWillUnmount() {
    window.removeEventListener("faucet-appearance-change", this.appearanceListener);
    if(this.powMinerStatsListener) {
      this.props.powMiner.off("stats", this.powMinerStatsListener);
      this.powMinerStatsListener = null;
    }
    if(this.powSessionUpdateListener) {
      this.props.powSession.off("balanceUpdate", this.powSessionUpdateListener);
      this.powSessionUpdateListener = null;
    }
    if(this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
  }

  private setUpdateTimer() {
    let now = (new Date()).getTime();
    let timeLeft = (1000 - (now % 1000)) + 2;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      let sampleTime = this.props.time.getSyncedTime();
      this.rateSamples.push({time: sampleTime, balance: this.state.balance});
      while(this.rateSamples.length > 1 && this.rateSamples[0].time < sampleTime - 120)
        this.rateSamples.shift();
      this.setState({
        refreshIndex: this.state.refreshIndex + 1,
      });
      this.setUpdateTimer();
    }, timeLeft);
  }

  // reward rate over the sampled window (up to 2 min); falls back to the session
  // average until enough samples exist
  private getRecentRate(miningTime: number): bigint {
    let samples = this.rateSamples;
    let span = samples.length > 1 ? samples[samples.length - 1].time - samples[0].time : 0;
    if(span >= 30)
      return (samples[samples.length - 1].balance - samples[0].balance) * 3600n / BigInt(span);
    return BigInt(this.state.balance || 0) * 3600n / BigInt(miningTime || 1);
  }

	public render(): React.ReactElement<IPoWMinerStatusProps> {
    let now = this.props.time.getSyncedTime();
    let sessionLifetime = 0;
    if(this.state.startTime) {
      let sessionTimeout = this.props.faucetConfig.modules.pow.powTimeout;
      sessionLifetime = (this.state.startTime + sessionTimeout) - now;
      if(sessionLifetime < 5 && !this.stoppedMiner) {
        this.stoppedMiner = true;
        this.props.powSession.closeSession();
      }
    }

    if(this.state.balance >= this.props.faucetConfig.maxClaim && !this.stoppedMiner) {
      this.stoppedMiner = true;
      setTimeout(() => {
        this.stoppedMiner = true;
        this.props.powSession.closeSession();
      }, 100);
    }

    let lastShareTime = this.state.lastShareTime || now;
    let miningTime = lastShareTime - this.state.startTime;

    return (
      <div className='grid pow-status'>
        <div className='row'>
          <div className='col pow-status-image'>
            <div className='pow-progress-actions'>
              <OverlayTrigger
                placement="bottom"
                container={this.props.pageContext.getContainer()}
                overlay={
                  <Tooltip>
                    {this.state.disableProgressGif ? "*whip*" : "Give Hypurr a break"}
                  </Tooltip>
                }
              >
                <button
                  type="button"
                  aria-label={this.state.disableProgressGif ? "Play the animation" : "Pause the animation"}
                  onClick={() => this.onProgressGifToggle()}
                >
                {this.state.disableProgressGif ?
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" className="bi bi-play-fill" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="m11.596 8.697-6.363 3.692c-.54.313-1.233-.066-1.233-.697V4.308c0-.63.692-1.01 1.233-.696l6.363 3.692a.802.802 0 0 1 0 1.393"/>
                  </svg> :
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" className="bi bi-pause-fill" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M5.5 3.5A1.5 1.5 0 0 1 7 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5m5 0A1.5 1.5 0 0 1 12 5v6a1.5 1.5 0 0 1-3 0V5a1.5 1.5 0 0 1 1.5-1.5"/>
                  </svg>
                }
                </button>
              </OverlayTrigger>
            </div>

            <MascotView
              mascotId={getAppearance().mascot}
              animate={!this.state.disableProgressGif}
              imagesUrl={this.props.pageContext.faucetUrls.imagesUrl || "/images"}
            />
          </div>
        </div>

        <div className='row pow-status-addr'>
          <span className='status-title'>Mining to</span>
          <AddressChip address={this.props.powSession.getTargetAddr()} />
        </div>
        <div className='row pow-status-top'>
          <div className='col-6'>
            <div className='status-title'>Mined</div>
            <div className='status-value'>{toReadableAmount(this.state.balance, this.props.faucetConfig.faucetCoinDecimals, null)} <span className='unit'>{this.props.faucetConfig.faucetCoinSymbol}</span></div>
            {this.state.balance < this.props.faucetConfig.minClaim ?
              <div className='below-min-hint'>{toReadableAmount(BigInt(this.props.faucetConfig.minClaim) - this.state.balance, this.props.faucetConfig.faucetCoinDecimals, this.props.faucetConfig.faucetCoinSymbol)} to the minimum</div>
            : null}
          </div>
          <div className='col-6'>
            <div className='status-title'>Hashrate</div>
            <div className='status-value'>{this.state.hashRate >= 100 ? Math.round(this.state.hashRate) : Math.round(this.state.hashRate * 10) / 10} <span className='unit'>H/s</span></div>
          </div>
        </div>
        <div className='row pow-status-spacer'></div>
        
        <div className='row pow-status-other'>
          <div className='col-6'>
            <div className='status-title'>Workers</div>
          </div>
          <div className='col-3'>
            <div className='status-value'>{this.state.workerCount} / {this.state.workerCountInput}</div>
          </div>
          <div className='col-3 pow-worker-controls'>
            <button type="button" className="btn btn-primary btn-sm" aria-label="Add a worker" disabled={this.state.workerCountInput >= 32} onClick={() => this.onChangeWorkerCountButtonClick(1)}>+</button>
            <button type="button" className="btn btn-primary btn-sm" aria-label="Remove a worker" disabled={this.state.workerCountInput <= 1} onClick={() => this.onChangeWorkerCountButtonClick(-1)}>−</button>
          </div>
        </div>
        <div className='row pow-status-other'>
          <div className='col-6'>
            <div className='status-title'>Session time left</div>
          </div>
          <div className='col-6'>
            <div className='status-value'>{renderTimespan(sessionLifetime)}</div>
          </div>
        </div>
        <div className='row pow-status-other'>
          <div className='col-6'>
            <div className='status-title'>Shares found</div>
          </div>
          <div className='col-6'>
            <div className='status-value'>{this.state.totalShares}</div>
          </div>
        </div>
        <div className='row pow-status-other'>
          <div className='col-6'>
            <div className='status-title'>Rate per hour</div>
          </div>
          <div className='col-6'>
            <div className='status-value'>{toReadableAmount(this.getRecentRate(miningTime), this.props.faucetConfig.faucetCoinDecimals, this.props.faucetConfig.faucetCoinSymbol)}/h</div>
          </div>
        </div>
        <div className='row pow-status-other'>
          <div className='col-6'>
            <div className='status-title'>Claim range</div>
          </div>
          <div className='col-6'>
            <div className='status-value'>{toReadableAmount(this.props.faucetConfig.minClaim, this.props.faucetConfig.faucetCoinDecimals, null)} – {toReadableAmount(this.props.faucetConfig.maxClaim, this.props.faucetConfig.faucetCoinDecimals, this.props.faucetConfig.faucetCoinSymbol)}</div>
          </div>
        </div>
        {this.props.faucetConfig.modules["hyperliquid-stake"] ?
          <div className='row pow-status-other'>
            <div className='col-6'>
              <div className='status-title'>Stake boost</div>
            </div>
            <div className='col-3'>
              <div className='status-value'>
                {this.props.stakeBoostInfo?.boost && this.props.stakeBoostInfo.boost.factor > 1 ?
                  <span className='boost-value'>{this.props.stakeBoostInfo.boost.factor}x</span>
                : <span className='boost-none'>1x</span>}
              </div>
            </div>
            <div className='col-3 pow-passport-controls'>
              <button type="button" className="btn btn-primary btn-sm" aria-label="Stake boost details" onClick={() => this.props.openStakeInfo && this.props.openStakeInfo()}>Boost</button>
            </div>
          </div>
        : null}
        {this.props.faucetConfig.modules.passport ?
          <div className='row pow-status-other'>
            <div className='col-6'>
              <div className='status-title'>Reward boost</div>
            </div>
            <div className='col-3'>
              <div className='status-value'>
                {this.props.passportScoreInfo ?
                  <span className='boost-value'>+ {Math.round((this.props.passportScoreInfo.factor - 1) * 100)}%</span>
                : <span className='boost-none'>+ 0%</span>}
              </div>
            </div>
            <div className='col-3 pow-passport-controls'>
              <button type="button" className="btn btn-primary btn-sm" aria-label="Passport boost details" onClick={() => this.props.openPassportInfo()}>Boost</button>
            </div>
          </div>
        : null}
      </div>
    );
	}

  private onChangeWorkerCountButtonClick(change: number) {
    let value = this.state.workerCountInput + change;
    this.setState({
      workerCountInput: value,
    });
    this.props.powMiner.setWorkerCount(value);
  }

  private onProgressGifToggle() {
    if(this.state.disableProgressGif) {
      localStorage.setItem("powMinerDisableGif", "false")
      this.setState({
        disableProgressGif: false,
      });
    } else {
      localStorage.setItem("powMinerDisableGif", "true")
      this.setState({
        disableProgressGif: true,
      });
    }
  }

}
