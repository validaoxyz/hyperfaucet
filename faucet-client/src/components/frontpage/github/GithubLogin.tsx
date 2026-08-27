import React from 'react';
import type { IFaucetConfig, IGithubModuleConfig } from '../../../common/FaucetConfig';

import './GithubLogin.css';
import type { IFaucetContext } from '../../../common/FaucetContext';
import { addAuthCallbackParams, BrowserAuthFlow, postBrowserAuthRequest } from '../BrowserAuthFlow';
import type { AuthResult } from '../BrowserAuthFlow';

export interface IGithubLoginProps {
  faucetContext: IFaucetContext;
  faucetConfig: IFaucetConfig
}

export interface IGithubLoginState {
  popupOpen: boolean;
  authInfo: IGithubAuthInfo | null;
}

export interface IGithubAuthInfo {
  time: number;
  uid: number;
  user: string;
  url: string;
  avatar: string;
  token: string;
}

interface IGithubAuthStateCapability {
  state: string;
  expiresAt: number;
}

const GITHUB_AUTH_STATE_PATTERN = /^[0-9a-f]{64}$/;
const GITHUB_AUTH_RESULT_POLL_INTERVAL_MS = 1000;

function isGithubAuthStateCapability(value: unknown): value is IGithubAuthStateCapability {
  if(typeof value !== "object" || value === null || Array.isArray(value))
    return false;

  const capability = value as Record<string, unknown>;
  return Object.keys(capability).length === 2
    && GITHUB_AUTH_STATE_PATTERN.test(typeof capability.state === "string" ? capability.state : "")
    && typeof capability.expiresAt === "number"
    && Number.isSafeInteger(capability.expiresAt)
    && capability.expiresAt > 0;
}

function getSafeGithubProfileUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if(url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com")
      return null;
    if(url.username || url.password || url.port)
      return null;
    return url.toString();
  } catch(error) {
    return null;
  }
}

function isGithubAuthInfo(value: unknown): value is IGithubAuthInfo {
  if(typeof value !== "object" || value === null || Array.isArray(value))
    return false;

  const authInfo = value as Record<string, unknown>;
  const expectedKeys = ["time", "uid", "user", "url", "avatar", "token"];
  return Object.keys(authInfo).length === expectedKeys.length
    && expectedKeys.every((key) => key in authInfo)
    && typeof authInfo.time === "number"
    && Number.isSafeInteger(authInfo.time)
    && authInfo.time >= 0
    && typeof authInfo.uid === "number"
    && Number.isSafeInteger(authInfo.uid)
    && authInfo.uid > 0
    && typeof authInfo.user === "string"
    && typeof authInfo.url === "string"
    && typeof authInfo.avatar === "string"
    && typeof authInfo.token === "string"
    && authInfo.token.length > 0;
}

export class GithubLogin extends React.PureComponent<IGithubLoginProps, IGithubLoginState> {
  private readonly authFlow: BrowserAuthFlow<IGithubAuthInfo>;
  private authResultPollState: string | null = null;
  private authResultPollTimer: number | null = null;

  constructor(props: IGithubLoginProps) {
    super(props);

    this.authFlow = new BrowserAuthFlow(
      "github",
      isGithubAuthInfo,
      (authResult) => this.processLoginResult(authResult),
      (popupOpen) => this.setState({ popupOpen }),
    );

    this.state = {
      popupOpen: false,
      authInfo: null,
		};
  }

  public componentDidMount() {
    const restoredResult = this.authFlow.attach();
    const callbackUrl = this.getCallbackUrl();
    if(!restoredResult && callbackUrl && this.isSplitOrigin(callbackUrl)) {
      const pendingState = this.authFlow.getPendingState();
      if(pendingState)
        this.startAuthResultRecovery(pendingState);
    }
    if(!restoredResult && localStorage['github.AuthInfo']) {
      try {
        const authInfo: unknown = JSON.parse(localStorage['github.AuthInfo']);
        if(!this.loadAuthInfo(authInfo))
          localStorage.removeItem("github.AuthInfo");
      } catch(ex) {
        localStorage.removeItem("github.AuthInfo");
        console.error("Could not parse stored GitHub authentication information.", ex);
      }
    }
  }

  public componentWillUnmount() {
    this.stopAuthResultRecovery();
    this.authFlow.detach();
  }

	public render(): React.ReactElement {

    return (
      <div className='faucet-auth faucet-auth-github'>
        <div className='auth-icon'>
          <div className='logo logo-github'></div>
        </div>
        {this.state.authInfo ?
          this.renderLoginState() :
          this.renderLoginButton()
        }
      </div>
    );
	}

  private renderLoginButton(): React.ReactElement {
    return (
      <div className='auth-field auth-noauth' onClick={(evt) => this.onLoginClick()}>
        <div>Not logged in to a Github account.</div>
        <div>
          <a href="#" onClick={(evt) => evt.preventDefault()}>
            {this.state.popupOpen ?
              <span className='inline-spinner'>
                <img src={(this.props.faucetContext.faucetUrls.imagesUrl || "/images") + "/spinner.gif"} className="spinner" />
              </span>
            : null}
            Login with Github
          </a>
        </div>
      </div>
    );
  }

  private renderLoginState(): React.ReactElement | null {
    const authInfo = this.state.authInfo;
    if(!authInfo)
      return null;

    const profileUrl = getSafeGithubProfileUrl(authInfo.url);
    return (
      <div className='auth-field auth-profile'>
        <div className='auth-info'>
          Authenticated with github profile {profileUrl ?
            <a href={profileUrl} target="_blank" rel='noopener noreferrer'>{authInfo.user}</a> :
            <span>{authInfo.user}</span>
          }
        </div>
        <div>
          <a href="#" onClick={(evt) => {evt.preventDefault(); this.onLogoutClick()}}>
            Logout
          </a>
        </div>
      </div>
    );
  }

  public getToken(): string | undefined {
    return this.state.authInfo?.token;
  }
  
  private onLoginClick() {
    const moduleConfig = this.getModuleConfig();
    if(!moduleConfig)
      return;

    const callbackUrl = this.getCallbackUrl();
    if(!callbackUrl)
      return;
    this.authFlow.startWithIssuedState(
      () => this.issueAuthState(),
      (authState) => {
        const redirectUrl = addAuthCallbackParams(callbackUrl, {
          clientOrigin: window.location.origin,
        });
        const authUrl = new URL("https://github.com/login/oauth/authorize");
        authUrl.searchParams.set("client_id", moduleConfig.clientId);
        authUrl.searchParams.set("redirect_uri", redirectUrl);
        authUrl.searchParams.set("state", authState);
        return authUrl.toString();
      },
      callbackUrl,
      "height=800,width=600",
      (authState) => {
        if(this.isSplitOrigin(callbackUrl))
          this.startAuthResultRecovery(authState);
      },
    );
  }

  private async issueAuthState(): Promise<string> {
    const stateUrl = new URL(
      this.props.faucetContext.faucetApi.getApiUrl("/githubAuthState", true),
      window.location.href,
    );
    stateUrl.searchParams.set("clientOrigin", window.location.origin);
    const response = await postBrowserAuthRequest(stateUrl.toString());
    if(!response.ok)
      throw new Error(`GitHub authentication state request failed with status ${response.status}.`);

    const capability: unknown = await response.json();
    if(!isGithubAuthStateCapability(capability))
      throw new Error("GitHub authentication state response is invalid.");
    if(capability.expiresAt <= this.props.faucetContext.faucetApi.getFaucetTime().getSyncedTime())
      throw new Error("GitHub authentication state expired before use.");
    return capability.state;
  }
  
  private onLogoutClick() {
    this.stopAuthResultRecovery();
    localStorage.removeItem("github.AuthInfo");
    this.setState({
      authInfo: null,
    });
  }

  private processLoginResult(authResult: AuthResult<IGithubAuthInfo>) {
    const recoveryState = this.authResultPollState;
    this.stopAuthResultRecovery();
    if(recoveryState)
      void this.consumeCompletedAuthResult(recoveryState);

    if("data" in authResult && this.loadAuthInfo(authResult.data)) {
      localStorage['github.AuthInfo'] = JSON.stringify(authResult.data);
    }
  }

  private getCallbackUrl(): string | null {
    const moduleConfig = this.getModuleConfig();
    if(!moduleConfig)
      return null;
    return moduleConfig.redirectUrl
      || this.props.faucetContext.faucetApi.getApiUrl("/githubCallback", true);
  }

  private isSplitOrigin(callbackUrl: string): boolean {
    try {
      return new URL(callbackUrl, window.location.href).origin !== window.location.origin;
    } catch {
      return false;
    }
  }

  private startAuthResultRecovery(state: string): void {
    this.stopAuthResultRecovery();
    this.authResultPollState = state;
    void this.pollAuthResult(state);
  }

  private stopAuthResultRecovery(): void {
    this.authResultPollState = null;
    if(this.authResultPollTimer === null)
      return;
    window.clearTimeout(this.authResultPollTimer);
    this.authResultPollTimer = null;
  }

  private scheduleAuthResultPoll(state: string): void {
    if(this.authResultPollState !== state || this.authFlow.getPendingState() !== state) {
      this.stopAuthResultRecovery();
      return;
    }
    this.authResultPollTimer = window.setTimeout(() => {
      this.authResultPollTimer = null;
      void this.pollAuthResult(state);
    }, GITHUB_AUTH_RESULT_POLL_INTERVAL_MS);
  }

  private async pollAuthResult(state: string): Promise<void> {
    if(this.authResultPollState !== state || this.authFlow.getPendingState() !== state) {
      this.stopAuthResultRecovery();
      return;
    }

    let response: Response;
    try {
      response = await postBrowserAuthRequest(this.buildAuthResultUrl(state));
    } catch {
      this.scheduleAuthResultPoll(state);
      return;
    }

    if(this.authResultPollState !== state || this.authFlow.getPendingState() !== state)
      return;
    if(response.status === 202) {
      this.scheduleAuthResultPoll(state);
      return;
    }
    if(response.status !== 200) {
      this.stopAuthResultRecovery();
      return;
    }

    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch(error) {
      this.stopAuthResultRecovery();
      console.error("Could not parse the recovered GitHub authentication result.", error);
      return;
    }
    if(this.authResultPollState !== state || this.authFlow.getPendingState() !== state)
      return;

    this.stopAuthResultRecovery();
    if(!this.authFlow.acceptRecoveredEnvelope(envelope))
      console.error("The recovered GitHub authentication result was invalid.");
  }

  private async consumeCompletedAuthResult(state: string): Promise<void> {
    try {
      await postBrowserAuthRequest(this.buildAuthResultUrl(state));
    } catch {}
  }

  private buildAuthResultUrl(state: string): string {
    const resultUrl = new URL(
      this.props.faucetContext.faucetApi.getApiUrl("/githubAuthResult", true),
      window.location.href,
    );
    resultUrl.searchParams.set("state", state);
    resultUrl.searchParams.set("clientOrigin", window.location.origin);
    return resultUrl.toString();
  }

  private loadAuthInfo(value: unknown): boolean {
    if(!isGithubAuthInfo(value))
      return false;

    let authTimeout = this.getModuleConfig()?.authTimeout;
    let age = this.props.faucetContext.faucetApi.getFaucetTime().getSyncedTime() - value.time;
    if(typeof authTimeout !== "number" || !Number.isFinite(authTimeout) || authTimeout <= 0 || age < -60 || age > Math.max(0, authTimeout - 60))
      return false;

    this.setState({
      authInfo: {
        ...value,
        url: getSafeGithubProfileUrl(value.url) || "",
      },
    });
    return true;
  }

  private getModuleConfig(): IGithubModuleConfig | null {
    return this.props.faucetConfig.modules.github || null;
  }

}
