import { IFaucetConfig } from '../../common/FaucetConfig';
import { FaucetConfigContext, FaucetPageContext } from '../FaucetPage';
import React, { useContext } from 'react';
import { useNavigate, NavigateFunction } from "react-router";
import { FaucetInput, FaucetInputSubmissionResult } from './FaucetInput';
import { IFaucetContext } from '../../common/FaucetContext';
import { FaucetSession } from '../../common/FaucetSession';
import { PoWClient } from '../../pow/PoWClient';
import { RestoreSession } from './RestoreSession';
import { PassportInfo } from '../passport/PassportInfo';
import { StakeInfo } from '../stake/StakeInfo';

export interface IFrontPageProps {
  faucetContext: IFaucetContext;
  faucetConfig: IFaucetConfig;
  navigateFn: NavigateFunction;
  defaultAddr?: string;
}

export interface IFrontPageState {
  appearanceIdx: number;
}

export class FrontPage extends React.PureComponent<IFrontPageProps, IFrontPageState> {
  private faucetInput = React.createRef<FaucetInput>();
  private retriedConcurrency = false;
  // re-render on mascot/theme switches so the hero follows the picker live
  private appearanceListener = () => {
    this.setState({ appearanceIdx: this.state.appearanceIdx + 1 });
  };

  constructor(props: IFrontPageProps) {
    super(props);

    this.state = {
      appearanceIdx: 0,
		};
  }

  public componentWillUnmount() {
    window.removeEventListener("faucet-appearance-change", this.appearanceListener);
  }

  public componentDidMount() {
    window.addEventListener("faucet-appearance-change", this.appearanceListener);
    let sessionJson = FaucetSession.recoverSessionInfo();
    if(sessionJson) {
      this.props.faucetContext.faucetApi.getSessionStatus(sessionJson.id).then((sessionInfo) => {
        if(!sessionInfo)
          return;
        let actionLabel: string = null;
        let actionFn: () => void;
        switch(sessionInfo.status) {
          case "claimable":
            actionLabel = "Claim rewards";
            actionFn = () => this.props.navigateFn("/claim/" + sessionInfo.session);
            break;
          case "running":
            if(sessionInfo.tasks.filter(t => t.module === "pow").length > 0) {
              actionLabel = "Continue mining";
              actionFn = () => this.props.navigateFn("/mine/" + sessionInfo.session);
            }
            else
              return;
            break;
          default:
            return;
        }

        this.props.faucetContext.showDialog({
          title: "Restore session",
          size: "700px",
          body: (
            <RestoreSession
              faucetConfig={this.props.faucetConfig}
              sessionStatus={sessionInfo}
            />
          ),
          applyButton: {
            caption: actionLabel,
            applyFn: actionFn,
          },
          closeButton: {
            caption: "Start new session"
          }
        })
      });
    }
  }

	public render(): React.ReactElement<IFrontPageProps> {
    const startBlocker = this.props.faucetConfig.faucetStatus.find((status) => status.blocksSessionStart);
    return (
      <div className='page-frontpage'>
        <FaucetInput
          ref={this.faucetInput}
          faucetContext={this.props.faucetContext}
          faucetConfig={this.props.faucetConfig}
          startBlocker={startBlocker}
          defaultAddr={this.props.defaultAddr}
          preflightFn={() => this.closeStoredRunningSession()}
          submitInputs={(inputData) => this.onSubmitInputs(inputData)}/>
      </div>
    );
	}

  private async onSubmitInputs(inputData: any): Promise<FaucetInputSubmissionResult> {
    try {
      let sessionInfo = await this.props.faucetContext.faucetApi.startSession(inputData);
      if(sessionInfo.status === "failed") {
        let canStartWithScore = false;
        let requiredScore = 0;
        let ipflags: string[] = [];

        if(sessionInfo.failedCode === "FAUCET_EMPTY") {
          void this.props.faucetContext.refreshConfig(true).catch(() => undefined);
          return {
            kind: "blocked",
            blocker: {
              level: "error",
              prio: 10,
              ishtml: false,
              text: sessionInfo.failedReason || "The faucet is empty. Wait for it to be refilled and try again",
              blocksSessionStart: true,
            },
          };
        }

        if(sessionInfo.failedCode == "IPINFO_RESTRICTION" && this.props.faucetConfig.modules["passport"] && this.props.faucetConfig.modules["passport"].guestRefresh !== false && sessionInfo.failedData && sessionInfo.failedData["ipflags"]) {
          canStartWithScore = true;
          if(sessionInfo.failedData["ipflags"][0] && this.props.faucetConfig.modules["passport"].overrideScores[0] > 0) {
            canStartWithScore = true;
            ipflags.push("hosting");
            if(this.props.faucetConfig.modules["passport"].overrideScores[0] > requiredScore)
              requiredScore = this.props.faucetConfig.modules["passport"].overrideScores[0];
          }
          if(sessionInfo.failedData["ipflags"][1] && this.props.faucetConfig.modules["passport"].overrideScores[1] > 0) {
            canStartWithScore = true;
            ipflags.push("proxy");
            if(this.props.faucetConfig.modules["passport"].overrideScores[1] > requiredScore)
              requiredScore = this.props.faucetConfig.modules["passport"].overrideScores[1];
          }
        }
        else if(sessionInfo.failedCode == "PASSPORT_SCORE" && this.props.faucetConfig.modules["passport"] && this.props.faucetConfig.modules["passport"].guestRefresh !== false) {
          requiredScore = this.props.faucetConfig.modules["passport"].overrideScores[2];
          canStartWithScore = true;
        }

        if(sessionInfo.failedCode == "STAKE_REQUIRED" && this.props.faucetConfig.modules["hyperliquid-stake"] && sessionInfo.failedData?.["address"]) {
          this.props.faucetContext.showDialog({
            title: "Could not start session",
            size: "lg",
            body: (
              <div className='stake-dialog error-dialog'>
                <StakeInfo
                  pageContext={this.props.faucetContext}
                  faucetConfig={this.props.faucetConfig}
                  targetAddr={sessionInfo.failedData["address"]}
                >
                  <div className='alert alert-danger'>{sessionInfo.failedReason}</div>
                </StakeInfo>
              </div>
            ),
            closeButton: { caption: "Close" },
          });
          throw null; // dialog already shown
        }

        if(canStartWithScore) {
          // special case, the session is denied as the users IP is flagged as hosting/proxy range.
          // however, the faucet allows skipping this check for passport trusted wallets
          // show a dialog that shows the score & allows refreshing the passport to meet the requirement

          let errMsg: string;
          if(ipflags.length > 0) {
            errMsg = "The faucet denied starting a session because your IP Address is marked as " + ipflags.join(" and ") + " range.";
          } else {
            errMsg = "The faucet denied starting a session because your wallet does not meet the minimum passport score.";
          }

          this.props.faucetContext.showDialog({
            title: "Could not start session",
            size: "lg",
            body: (
              <div className='passport-dialog error-dialog'>
                <PassportInfo 
                  pageContext={this.props.faucetContext}
                  faucetConfig={this.props.faucetConfig}
                  targetAddr={sessionInfo.failedData["address"]}
                  refreshFn={(passportScore) => {
                    
                  }}
                >
                  <div>
                    <div className='alert alert-danger'>{errMsg}</div>
                    <div className="boost-descr">
                      You can verify your unique identity and increase your score using <a href="https://passport.gitcoin.co/#/dashboard" target="_blank">Gitcoin Passport</a>.
                    </div>
                    <div className="boost-descr2">
                      Ensure your provided address achieves a minimum score of {requiredScore} to initiate a session.
                    </div>
                  </div>
                </PassportInfo>
              </div>
            ),
            closeButton: { caption: "Close" },
          });

          throw null; // throw without dialog
        }

        if(sessionInfo.failedCode == "CONCURRENCY_LIMIT") {
          // starting fresh while this browser's previous session still holds the
          // per-IP slot: the explicit new start is consent to abandon it, so close
          // it over the pow websocket and retry once
          let storedSession = FaucetSession.recoverSessionInfo();
          if(storedSession?.id && !this.retriedConcurrency && await this.closeStoredSession(storedSession.id)) {
            if(!this.props.faucetConfig.modules.captcha?.requiredForStart) {
              this.retriedConcurrency = true;
              try {
                return await this.onSubmitInputs(inputData);
              } catch(ex) {
                throw null; // the retry showed its own failure dialog
              } finally {
                this.retriedConcurrency = false;
              }
            }
            throw "Your previous mining session was closed. Press Start mining again to begin the new session.";
          }
          throw "This faucet allows one mining session per IP address, and a session from your IP is still running. Stop it from its mining tab, or wait a few minutes for it to time out.";
        }

        throw (sessionInfo.failedCode ? "[" + sessionInfo.failedCode + "] " : "") + sessionInfo.failedReason;
      }

      let session = new FaucetSession(this.props.faucetContext, sessionInfo.session, sessionInfo);
      this.props.faucetContext.activeSession = session;

      switch(sessionInfo.status) {
        case "claimable":
          // redirect to claim page
          console.log("redirect to claim page!", session);
          this.props.navigateFn("/claim/" + sessionInfo.session);
          return {kind: "submitted"};
        case "running":
          if(sessionInfo.tasks?.filter((task) => task.module === "pow").length > 0) {
            // redirect to mining page
            console.log("redirect to mining page!", session);
            this.props.navigateFn("/mine/" + sessionInfo.session);
            return {kind: "submitted"};
          }
          else {
            // session is running, but has an unknown or no task...
            throw "unexpected session task";
          }
        default:
          throw "unexpected session state";
      }
    } catch(ex) {
      if(ex) {
        this.props.faucetContext.showDialog({
          title: "Could not start session",
          body: (<div className='alert alert-danger'>{ex.toString()}</div>),
          closeButton: { caption: "Close" },
        });
      }
      throw ex;
    }
  }

  // before a new start (and before the captcha solve): if this browser's stored
  // session still holds the per-IP slot, release it so one click and one solve
  // start the new session
  private async closeStoredRunningSession(): Promise<void> {
    let storedSession = FaucetSession.recoverSessionInfo();
    if(!storedSession?.id)
      return;
    try {
      let sessionInfo = await this.props.faucetContext.faucetApi.getSessionStatus(storedSession.id);
      if(sessionInfo?.status === "running")
        await this.closeStoredSession(storedSession.id);
    } catch(ex) {
      // preflight is best-effort; the CONCURRENCY_LIMIT handler still covers a miss
    }
  }

  // close a session this browser started (id from localStorage) over the pow
  // websocket, freeing the per-IP concurrency slot; balance >= the claim minimum
  // moves to the claim queue server-side
  private async closeStoredSession(sessionId: string): Promise<boolean> {
    let powWsEndpoint: string;
    if(this.props.faucetConfig.modules.pow?.powWsUrl)
      powWsEndpoint = this.props.faucetConfig.modules.pow.powWsUrl;
    else if(this.props.faucetContext.faucetUrls.wsBaseUrl)
      powWsEndpoint = this.props.faucetContext.faucetUrls.wsBaseUrl + "/pow";
    else
      powWsEndpoint = "/ws/pow";
    if(powWsEndpoint.match(/^\//))
      powWsEndpoint = location.origin.replace(/^http/, "ws") + powWsEndpoint;

    let client = new PoWClient({ powApiUrl: powWsEndpoint, sessionId: sessionId });
    try {
      client.start();
      await Promise.race([
        client.getReadyPromise(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout")), 5000)),
      ]);
      let sessionInfo: any = await client.sendRequest("closeSession");
      if(sessionInfo?.status === "claimable") {
        this.props.faucetContext.showNotification("info", "Your previous session was closed. Its rewards are waiting in the claim queue.", true, 10000);
      }
      return true;
    } catch(ex) {
      return false;
    } finally {
      client.stop();
    }
  }

}

export default (props) => {
  const searchParams = new URLSearchParams(window.location.search);
  const addressParam = searchParams.get('address');

  return (
    <FrontPage 
      {...props}
      faucetContext={useContext(FaucetPageContext)}
      faucetConfig={useContext(FaucetConfigContext)}
      navigateFn={useNavigate()}
      defaultAddr={addressParam || undefined}
    />
  );
};
