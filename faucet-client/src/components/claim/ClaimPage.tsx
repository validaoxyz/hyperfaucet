import { IFaucetConfig } from '../../common/FaucetConfig';
import { FaucetConfigContext, FaucetPageContext } from '../FaucetPage';
import React, { useContext } from 'react';
import { Link, useParams, useNavigate, NavigateFunction } from "react-router";
import { IFaucetContext } from '../../common/FaucetContext';
import { FaucetSession, IFaucetSessionStatus } from '../../common/FaucetSession';
import { toReadableAmount } from '../../utils/ConvertHelpers';
import { renderDate, renderTimespan } from '../../utils/DateUtils';
import { ClaimInput } from './ClaimInput';
import { Spinner } from 'react-bootstrap';
import { ClaimNotificationClient, IClaimNotificationUpdateData } from './ClaimNotificationClient';

export interface IClaimPageProps {
  pageContext: IFaucetContext;
  faucetConfig: IFaucetConfig;
  navigateFn: NavigateFunction;
  sessionId: string;
}

export interface IClaimPageState {
  sessionStatus: IFaucetSessionStatus;
  loadingStatus: boolean;
  loadingError: string|boolean;
  isTimedOut: boolean;
  claimProcessing: boolean;
  refreshIndex: number;
  claimNotification: IClaimNotificationUpdateData;
  claimNotificationConnected: boolean;
}


export class ClaimPage extends React.PureComponent<IClaimPageProps, IClaimPageState> {
  private updateTimer: NodeJS.Timeout;
  private loadingStatus: boolean;
  private isTimedOut: boolean;
  private notificationClient: ClaimNotificationClient;
  private notificationClientActive: boolean;
  private lastStatusPoll: number;

  constructor(props: IClaimPageProps) {
    super(props);

    let claimWsEndpoint: string;
    if(this.props.pageContext.faucetUrls.wsBaseUrl) 
      claimWsEndpoint = this.props.pageContext.faucetUrls.wsBaseUrl + "/claim";
    else
      claimWsEndpoint = "/ws/claim";
    if(claimWsEndpoint.match(/^\//))
      claimWsEndpoint = location.origin.replace(/^http/, "ws") + claimWsEndpoint;
    this.notificationClient = new ClaimNotificationClient({
      claimWsUrl: claimWsEndpoint,
      sessionId: this.props.sessionId,
    });
    this.notificationClient.on("update", (message) => {
      this.setState({
        claimNotification: message.data,
      });
    });
    this.notificationClient.on("open", () => {
      this.setState({
        claimNotificationConnected: true,
      });
    });
    this.notificationClient.on("close", () => {
      this.setState({
        claimNotificationConnected: false,
      });
    });

    this.state = {
      sessionStatus: null,
      loadingStatus: false,
      loadingError: false,
      isTimedOut: false,
      claimProcessing: false,
      refreshIndex: 0,
      claimNotification: null,
      claimNotificationConnected: false,
		};
  }

  public componentDidMount() {
    this.refreshSessionStatus();
  }

  public componentWillUnmount() {
    if(this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    if(this.notificationClientActive) {
      this.notificationClientActive = false;
      this.notificationClient.stop();
    }
  }

  private async refreshSessionStatus() {
    if(this.loadingStatus)
      return;
    
    this.loadingStatus = true;
    this.setState({
      loadingStatus: true,
    });

    try {
      let sessionStatus = await this.props.pageContext.faucetApi.getSessionStatus(this.props.sessionId);
      this.setState({
        loadingStatus: false,
        sessionStatus: sessionStatus,
      }, () => {
        this.setUpdateTimer();
      });
    }
    catch(err) {
      this.setState({
        loadingStatus: false,
        loadingError: err.error?.toString() || err.toString() || true,
      });
    }
    this.loadingStatus = false;
  }

  private setUpdateTimer() {
    if(this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    let exactNow = (new Date()).getTime();

    let timeLeft = (1000 - (exactNow % 1000)) + 2;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.setState({
        refreshIndex: this.state.refreshIndex + 1,
      });
      this.setUpdateTimer();
    }, timeLeft);
  }

	public render(): React.ReactElement<IClaimPageProps> {
    let exactNow = (new Date()).getTime();
    let now = this.props.pageContext.faucetApi.getFaucetTime().getSyncedTime();

    if(this.state.sessionStatus) {
      let claimTimeout = (this.state.sessionStatus.start + this.props.faucetConfig.sessionTimeout) - now;
      if(claimTimeout < 0 && this.state.sessionStatus.status === "claimable" && !this.isTimedOut) {
        this.isTimedOut = true;
        this.setState({
          isTimedOut: true
        });
        
        this.props.pageContext.showDialog({
          title: "Claim expired",
          body: (
            <div className='alert alert-danger'>
              This claim expired and the rewards returned to the faucet. Start a new session.
            </div>
          ),
          closeButton: {
            caption: "Close"
          },
          closeFn: () => {
            this.refreshSessionStatus();
          }
        });
      }

      if(this.state.sessionStatus.status === "claiming") {
        if(!this.notificationClientActive) {
          this.notificationClientActive = true;
          this.notificationClient.start();
        }

        if(exactNow - this.lastStatusPoll > 30 * 1000 || this.state.sessionStatus.claimIdx <= (this.state.claimNotification?.confirmedIdx || 0)) {
          this.lastStatusPoll = exactNow;
          this.refreshSessionStatus();
        }
      }
      else {
        if(this.notificationClientActive) {
          this.notificationClientActive = false;
          this.notificationClient.stop();
        }
      }
    }

    return (
      <div className='page-claim'>
        <div className='page-info-header'>
          <Link to='/' className='page-info-back' aria-label='Back to the faucet'>
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 12H5" />
              <path d="m12 19-7-7 7-7" />
            </svg>
          </Link>
          <h1>Claim rewards</h1>
        </div>
        <div className='container'>
          {this.renderClaim()}
        </div>
      </div>
    )
	}

  private renderClaim(): React.ReactElement {
    if(this.state.loadingError) {
      return (
        <div className='alert alert-danger'>
          No claimable reward found: {typeof this.state.loadingError == "string" ? this.state.loadingError : ""}
        </div>
      );
    }
    else if(!this.state.sessionStatus) {
      return (
        <div className="faucet-loading">
          <div className="loading-spinner">
            <img src={(this.props.pageContext.faucetUrls.imagesUrl || "/images") + "/spinner.gif"} className="spinner" alt="" />
            <span className="spinner-text">Loading claim...</span>
          </div>
        </div>
      );
    }
    else if(this.state.isTimedOut) {
      return (
        <div className='alert alert-danger'>
          This claim expired and the rewards returned to the faucet. Start a new session.
        </div>
      );
    }
    
    let now = this.props.pageContext.faucetApi.getFaucetTime().getSyncedTime();
    let claimTimeout = (this.state.sessionStatus.start + this.props.faucetConfig.sessionTimeout) - now;

    return (
      <div>
        <div className='row claim-summary-row'>
          <div className='col-3 claim-label'>
            Wallet
          </div>
          <div className='col claim-value txhash'>
            {this.state.sessionStatus.target}
          </div>
        </div>
        <div className='row claim-summary-row'>
          <div className='col-3 claim-label'>
            Amount
          </div>
          <div className='col claim-value claim-amount'>
            {toReadableAmount(BigInt(this.state.sessionStatus.balance), this.props.faucetConfig.faucetCoinDecimals, this.props.faucetConfig.faucetCoinSymbol)}
          </div>
        </div>
        <div className='row claim-summary-row'>
          <div className='col-3 claim-label'>
            Claim by
          </div>
          <div className='col claim-value'>
            {this.state.sessionStatus.status === "claimable" ?
              <span className='claim-timeout'>
                {renderDate(new Date((this.state.sessionStatus.start + this.props.faucetConfig.sessionTimeout) * 1000), true)}  ({renderTimespan(claimTimeout)})
              </span> :
              <span className='claim-timeout'>
                -
              </span>
            }
          </div>
        </div>
        {this.state.sessionStatus.status === "claimable" ? this.renderClaimForm() : null}
        {this.state.sessionStatus.status === "claiming" ? this.renderClaimStatus() : null}
        {this.state.sessionStatus.status === "failed" ? this.renderSessionFailed() : null}
        {this.state.sessionStatus.status === "finished" ? this.renderSessionFinished() : null}
        {this.state.sessionStatus.status !== "claimable" ?
          <div className='faucet-actions'>
            <button
              className="btn btn-secondary action-btn"
              onClick={() => {
                this.props.navigateFn("/");
              }}>
                Return to start page
              </button>
          </div>
        : null}
      </div>
    );
  }

  private renderClaimForm(): React.ReactElement {
    return (
      <ClaimInput 
        faucetConfig={this.props.faucetConfig}
        submitInputs={(claimData) => this.submitClaim(claimData)}
      />
    );
  }

  private renderClaimStatus(): React.ReactElement {
    let sending = !!(this.state.sessionStatus.claimHash || (this.state.sessionStatus.claimIdx || 0) <= (this.state.claimNotification?.processedIdx || 0));
    let ahead = (this.state.sessionStatus.claimIdx || 0) - (this.state.claimNotification?.processedIdx || 0);
    return (
      <div className='claim-status claim-reveal'>
        <div className='claim-reveal-inner'>
          <div className='claim-status-line'>
            <Spinner animation="border" role="status" size="sm">
              <span className="visually-hidden">Processing</span>
            </Spinner>
            <span>Claim queued. Safe to close this page.</span>
          </div>
          <div className='claim-status-meta'>
            {sending ? "Sending" : ahead <= 1 ? "Next in queue" : "#" + ahead + " in queue"}
          </div>
          {this.state.sessionStatus.claimHash ?
            <div className='claim-status-meta'>
              <span className='txhash'>
                {this.props.faucetConfig.ethTxExplorerLink ?
                  <a href={this.props.faucetConfig.ethTxExplorerLink.replace("{txid}", this.state.sessionStatus.claimHash)} target='_blank' rel='noopener noreferrer'>{this.state.sessionStatus.claimHash}</a> :
                  <span>{this.state.sessionStatus.claimHash}</span>}
              </span>
            </div>
          : null}
        </div>
      </div>
    );
  }
  private renderSessionFailed(): React.ReactElement {
    return (
      <div className='claim-status'>
        <div className='alert alert-danger'>
          Claim failed: {this.state.sessionStatus.failedReason || this.state.sessionStatus.claimMessage} {this.state.sessionStatus.failedCode ? " [" + this.state.sessionStatus.failedCode + "]" : ""}
        </div>
      </div>
    )
  }

  private renderSessionFinished(): React.ReactElement {
    return (
      <div className='claim-status'>
        <div className='alert alert-success'>
          Confirmed in block #{this.state.sessionStatus.claimBlock}.<br />
          <span className='txhash'>
            {this.props.faucetConfig.ethTxExplorerLink ?
              <a href={this.props.faucetConfig.ethTxExplorerLink.replace("{txid}", this.state.sessionStatus.claimHash)} target='_blank' rel='noopener noreferrer'>{this.state.sessionStatus.claimHash}</a> :
              <span>{this.state.sessionStatus.claimHash}</span>}
          </span>
        </div>
      </div>
    );
  }

  private async submitClaim(claimData: any): Promise<void> {
    try {
      claimData = Object.assign({
        session: this.props.sessionId
      }, claimData ||{});

      let sessionStatus = await this.props.pageContext.faucetApi.claimReward(claimData);
      if(sessionStatus.status === "failed")
        throw sessionStatus;
      
      this.lastStatusPoll = new Date().getTime();
      this.setState({
        sessionStatus: sessionStatus,
      });
      FaucetSession.persistSessionInfo(null);
    } catch(ex) {
      let errMsg: string;
      if(ex && ex.failedCode)
        errMsg = "[" + ex.failedCode + "] " + ex.failedReason;
      else
        errMsg = ex.toString();
      this.props.pageContext.showDialog({
        title: "Claim failed",
        body: (
          <div className='alert alert-danger'>
            Could not claim rewards: {errMsg}
          </div>
        ),
        closeButton: {
          caption: "Close"
        }
      });
      throw errMsg;
    }
  }

}

export default (props) => {
  let params = useParams();
  return (
    <ClaimPage 
      key={params.session}
      {...props}
      pageContext={useContext(FaucetPageContext)}
      faucetConfig={useContext(FaucetConfigContext)}
      navigateFn={useNavigate()}
      sessionId={params.session}
    />
  );
};
