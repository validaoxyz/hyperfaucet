import React from 'react';
import { OverlayTrigger, Tooltip } from 'react-bootstrap';
import type { IFaucetConfig, IZupassModuleConfig } from '../../../common/FaucetConfig';
import type { IFaucetContext } from '../../../common/FaucetContext';

import './ZupassLogin.css';
import type { OverlayChildren } from 'react-bootstrap/esm/Overlay';
import { addAuthCallbackParams, BrowserAuthFlow } from '../BrowserAuthFlow';
import type { AuthResult } from '../BrowserAuthFlow';

export interface IZupassLoginProps {
  faucetContext: IFaucetContext;
  faucetConfig: IFaucetConfig;
}

export interface IZupassLoginState {
  popupOpen: boolean;
  authInfo: IZupassAuthInfo | null;
}

export interface IZupassAuthInfo {
  ticketId: string;
  productId: string;
  eventId: string;
  attendeeId: string;
  token: string;
}

function isZupassAuthInfo(value: unknown): value is IZupassAuthInfo {
  if(typeof value !== "object" || value === null || Array.isArray(value))
    return false;

  const authInfo = value as Record<string, unknown>;
  const expectedKeys = ["ticketId", "productId", "eventId", "attendeeId", "token"];
  return Object.keys(authInfo).length === expectedKeys.length
    && expectedKeys.every((key) => typeof authInfo[key] === "string")
    && typeof authInfo.token === "string"
    && authInfo.token.length > 0;
}

export class ZupassLogin extends React.PureComponent<IZupassLoginProps, IZupassLoginState> {
  private readonly authFlow: BrowserAuthFlow<IZupassAuthInfo>;

  constructor(props: IZupassLoginProps) {
    super(props);

    this.authFlow = new BrowserAuthFlow(
      "zupass",
      isZupassAuthInfo,
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
    if(!restoredResult && localStorage['zupass.AuthInfo']) {
      try {
        const authInfo: unknown = JSON.parse(localStorage['zupass.AuthInfo']);
        if(!this.loadAuthInfo(authInfo))
          localStorage.removeItem("zupass.AuthInfo");
      } catch(ex) {
        localStorage.removeItem("zupass.AuthInfo");
        console.error("Could not parse stored Zupass authentication information.", ex);
      }
    }
  }

  public componentWillUnmount() {
    this.authFlow.detach();
  }

	public render(): React.ReactElement | null {
    const moduleConfig = this.getModuleConfig();
    if(!moduleConfig)
      return null;

    return (
      <div className='faucet-zupass-auth'>
        <div className='auth-icon'>
          <div className='logo logo-zupass' style={{backgroundImage: "url('"+ (moduleConfig.loginLogo || "/images/zupass_logo.jpg") + "')"}}></div>
        </div>
        {this.state.authInfo ?
          this.renderLoginState() :
          this.renderLoginButton()
        }
      </div>
    );
	}

  private renderLoginButton(): React.ReactElement | null {
    const moduleConfig = this.getModuleConfig();
    if(!moduleConfig)
      return null;

    return (
      <div className='auth-field auth-noauth' onClick={(evt) => this.onLoginClick()}>
        <div>
          {moduleConfig.loginLabel || "Event attendee? Login with your Ticket."}
          {moduleConfig.infoHtml ?
            <OverlayTrigger
              placement="bottom"
              container={this.props.faucetContext.getContainer()}
              overlay={this.renderInfoHtml() as OverlayChildren}
            >
              <span className="zupass-info-icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" className="bi bi-info-circle" viewBox="0 0 16 16">
                  <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
                  <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
                </svg>
              </span>
            </OverlayTrigger>
          : null}
        </div>
        <div>
          <a href="#" onClick={(evt) => evt.preventDefault()}>
            {this.state.popupOpen ?
              <span className='inline-spinner'>
                <img src="/images/spinner.gif" className="spinner" />
              </span>
            : null}
            Login with Zupass
          </a>
        </div>
      </div>
    );
  }

  private renderLoginState(): React.ReactElement | null {
    const moduleConfig = this.getModuleConfig();
    const authInfo = this.state.authInfo;
    if(!moduleConfig || !authInfo)
      return null;

    return (
      <div className='auth-field auth-profile'>
        <div className='auth-info'>
          {moduleConfig.userLabel || "Authenticated with Zupass Ticket."}
          {moduleConfig.infoHtml ?
            <OverlayTrigger
              placement="bottom"
              container={this.props.faucetContext.getContainer()}
              overlay={this.renderInfoHtml() as OverlayChildren}
            >
              <span className="zupass-info-icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" className="bi bi-info-circle" viewBox="0 0 16 16">
                  <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
                  <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
                </svg>
              </span>
            </OverlayTrigger>
          : null}
        </div>
        <div className="auth-logout">
          <a href="#" onClick={(evt) => {evt.preventDefault(); this.onLogoutClick()}}>
            Logout
          </a>
        </div>
        <div className='auth-info'>
          Attendee ID: 
          <OverlayTrigger
            placement="bottom"
            delay={{ show: 250, hide: 400 }}
            container={this.props.faucetContext.getContainer()}
            overlay={(props) => this.renderZupassTicketInfo(authInfo, props)}
          >
            <span className="auth-ident-truncated">{authInfo.attendeeId}</span>
          </OverlayTrigger>
        </div>
      </div>
    );
  }

  private renderZupassTicketInfo(ticketInfo: IZupassAuthInfo, props: any): React.ReactElement {
    return (
      <Tooltip id="zupass-tooltip" {...props}>
        <div className='zupass-info'>
          <table>
            <tbody>
              <tr>
                <td className='zupass-title'>TicketId:</td>
                <td className='zupass-value'>{ticketInfo.ticketId}</td>
              </tr>
              <tr>
                <td className='zupass-title'>EventId:</td>
                <td className='zupass-value'>{ticketInfo.eventId}</td>
              </tr>
              <tr>
                <td className='zupass-title'>ProductId:</td>
                <td className='zupass-value'>{ticketInfo.productId}</td>
              </tr>
              <tr>
                <td className='zupass-title'>Attendee:</td>
                <td className='zupass-value'>{ticketInfo.attendeeId}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Tooltip>
    );
  }

  private renderInfoHtml(): React.ReactElement | null {
    const moduleConfig = this.getModuleConfig();
    if(!moduleConfig?.infoHtml)
      return null;

    return (
      <Tooltip id="zupass-tooltip">
        <div className='zupass-info' dangerouslySetInnerHTML={{__html: moduleConfig.infoHtml}}></div>
      </Tooltip>
    );
  }

  public getToken(): string | undefined {
    return this.state.authInfo?.token;
  }

  private onLoginClick() {
    const moduleConfig = this.getModuleConfig();
    if(!moduleConfig)
      return;
    const callbackUrl = moduleConfig.redirectUrl
      || this.props.faucetContext.faucetApi.getApiUrl("/zupassCallback", true);
    const loginUrl = this.props.faucetContext.faucetApi.getApiUrl("/zupassLogin", true);
    this.authFlow.startWithPost(
      (authState) => addAuthCallbackParams(loginUrl, {
        clientOrigin: window.location.origin,
        state: authState,
      }),
      callbackUrl,
      "width=450,height=600,top=100,popup",
    );
  }

  private onLogoutClick() {
    localStorage.removeItem("zupass.AuthInfo");
    this.setState({
      authInfo: null,
    });
  }

  private processLoginResult(authResult: AuthResult<IZupassAuthInfo>) {
    if("data" in authResult && this.loadAuthInfo(authResult.data)) {
      localStorage['zupass.AuthInfo'] = JSON.stringify(authResult.data);
    }
    else if("errorCode" in authResult) {
      this.props.faucetContext.showDialog({
        title: "Could not authenticate with zupass",
        body: (<div className='alert alert-danger'>[{authResult.errorCode}] {authResult.errorMessage}</div>),
        closeButton: { caption: "Close" },
      });
    }
  }

  private loadAuthInfo(value: unknown): boolean {
    if(!isZupassAuthInfo(value))
      return false;

    this.setState({
      authInfo: value,
    });
    return true;
  }

  private getModuleConfig(): IZupassModuleConfig | null {
    return this.props.faucetConfig.modules.zupass || null;
  }

}
