import React, { ReactElement } from 'react';
import { HashRouter as Router, Routes, Route, Link, useLocation } from "react-router";

import { FaucetApi } from '../common/FaucetApi';
import { IFaucetConfig, IFaucetStatus } from '../common/FaucetConfig';
import { IFaucetContext, IFaucetContextUrls } from '../common/FaucetContext';
import { FaucetNotification } from './shared/FaucetNotification';
import { FaucetDialog, IFaucetDialogProps } from './shared/FaucetDialog';
import { RouteFade } from './shared/RouteFade';
import { MascotView } from './mascot/MascotView';

import FrontPage from './frontpage/FrontPage';
import MiningPage from './mining/MiningPage';
import ClaimPage from './claim/ClaimPage';
import DetailsPage from './details/DetailsPage';
import FaucetStatusPage from './status/FaucetStatusPage';
import QueueStatusPage from './status/QueueStatusPage';
import InfoPage from './info/InfoPage';

import './FaucetPage.scss'
// after FaucetPage.scss: [data-theme] blocks tie the :root scene tokens on
// specificity, so bundle order lets a selected theme win
import './themes.scss'
import { AppearanceControl } from './appearance/AppearanceControl';
import { getAppearance } from './appearance/appearance';
import { PoWMinerWorkerSrc, getPoWMinerDefaultSrc } from '../types/PoWMinerSrc';
import { joinUrl } from '../utils/QueryUtils';
import { revealInitialPaint } from '../initialPaint';

export interface IFaucetPageProps {
  baseUrl?: string; // base url (default: "/")
  apiUrl?: string;  // api url  (default: "{baseUrl}/api")
  wsBaseUrl?: string; // ws url (default: "{baseUrl}/ws")
  imagesUrl?: string; // images (default: "{baseUrl}/images")
  minerSrc?: PoWMinerWorkerSrc;
  children?: ReactElement | ReactElement[];
  ref?: (ref: FaucetPage) => void;
}

export interface IFaucetPageState {
  initializing: boolean;
  initializationError: string | null;
  faucetConfig: IFaucetConfig;
  faucetStatus: IFaucetStatus[];
  statusAlerts: IFaucetStatusAlert[];
  dialogs: IFaucetDialog[];
  notifications: IFaucetNotification[];
}

export interface IFaucetNotification {
  id: number;
  type: string;
  message: string;
  time?: number;
  timeout?: number;
  timerId?: NodeJS.Timeout;
  leaving?: boolean; // exit animation in progress; removed when it finishes
}

export interface IFaucetDialog {
  id: number;
  dialog: IFaucetDialogProps;
  closeFn: () => void;
  closing?: boolean; // exit animation in progress; removed when it finishes
}

export interface IFaucetStatusAlert {
  id: number;
  body: React.ReactElement;
  level: string;
  prio: number;
}

export const FaucetPageContext = React.createContext<IFaucetContext>(null);
export const FaucetConfigContext = React.createContext<IFaucetConfig>(null);

function PersistentHomeMascot({ pageContext }: { pageContext: IFaucetContext }): React.ReactElement {
  const location = useLocation();
  const [, setAppearanceRevision] = React.useState(0);
  const showMascot = location.pathname === "/";

  React.useEffect(() => {
    const onAppearanceChange = () => setAppearanceRevision((revision) => revision + 1);
    window.addEventListener("faucet-appearance-change", onAppearanceChange);
    return () => window.removeEventListener("faucet-appearance-change", onAppearanceChange);
  }, []);

  const appearance = getAppearance();
  return (
    <div className={"faucet-frontimage persistent-faucet-frontimage" + (showMascot ? " is-visible" : "")} aria-hidden={!showMascot}>
      <MascotView
        mascotId={appearance.mascot}
        animate={!window.matchMedia("(prefers-reduced-motion: reduce)").matches}
        imagesUrl={pageContext.faucetUrls.imagesUrl || "/images"}
        className="image"
      />
    </div>
  );
}

export class FaucetPage extends React.PureComponent<IFaucetPageProps, IFaucetPageState> {
  private configRefreshInterval: NodeJS.Timer;
  private configRefreshGeneration = 0;
  private faucetContainerElement: HTMLElement;
  private lastConfigRefresh = 0;
  private lastConfigRefreshStart = 0;
  private statusAlertIdCounter = 0;
  private notificationIdCounter = 0;
  private dialogIdCounter = 0;
  private notifications: IFaucetNotification[] = [];
  private dialogs: IFaucetDialog[] = [];
  private statusAlerts: IFaucetStatusAlert[] = [];
  private pageContext: IFaucetContext;
  private faucetStatucClickCount = 0;
  private initialPaintRevealStarted = false;

  constructor(props: IFaucetPageProps) {
    super(props);

    let baseUrl = props.baseUrl || "/";
    let faucetApi = new FaucetApi(props.apiUrl || joinUrl(baseUrl, "/api"));
    this.pageContext = {
      faucetUrls: {
        baseUrl: baseUrl,
        apiUrl: props.apiUrl || joinUrl(baseUrl, "/api"),
        wsBaseUrl: props.wsBaseUrl || joinUrl(baseUrl.replace(/^http/, "ws"), "/ws"),
        minerSrc: props.minerSrc || getPoWMinerDefaultSrc(baseUrl),
        imagesUrl: props.imagesUrl || joinUrl(baseUrl, "/images"),
      },
      faucetApi: faucetApi,
      configRevision: 0,
      showStatusAlert: (level: string, prio: number, body: React.ReactElement) => this.showStatusAlert(level, prio, body),
      hideStatusAlert: (statusAlertId: number) => this.hideStatusAlert(statusAlertId),
      showNotification: (type: string, message: string, time?: number|boolean, timeout?: number) => this.showNotification(type, message, time, timeout),
      hideNotification: (notificationId: number) => this.hideNotification(notificationId),
      showDialog: (dialogProps: IFaucetDialogProps) => this.showDialog(dialogProps),
      hideDialog: (dialogId: number) => this.hideDialog(dialogId),
      getContainer: () => this.faucetContainerElement,
      refreshConfig: (force?: boolean) => this.loadFaucetConfig(force),
    };

    this.state = {
      initializing: true,
      initializationError: null,
      faucetConfig: null,
      faucetStatus: [],
      statusAlerts: [],
      dialogs: [],
      notifications: [],
		};

    if(props.ref) {
      props.ref(this);
    }
  }

  public componentDidMount() {
    void this.loadFaucetConfig().catch(() => {
      if(!this.state.initializing)
        return;
      this.setState({
        initializing: false,
        initializationError: "Could not load the faucet. Refresh to try again.",
      }, () => this.revealInitialPaint());
    });
    this.startConfigRefreshInterval();  
  }

  public componentWillUnmount() {
    if(this.configRefreshInterval) {
      clearInterval(this.configRefreshInterval);
      this.configRefreshInterval = null;
    }
  }

  private startConfigRefreshInterval() {
    if(this.configRefreshInterval)
      clearInterval(this.configRefreshInterval);
    this.configRefreshInterval = setInterval(() => {
      let now = (new Date()).getTime();
      if(this.lastConfigRefresh < now - (10 * 60 * 1000)) {
        void this.loadFaucetConfig();
      }
    }, 30 * 1000);
  }

  private loadFaucetConfig(force = false): Promise<IFaucetConfig> {
    let now = (new Date()).getTime();
    if(!force && now - this.lastConfigRefreshStart < 10000)
      return Promise.resolve(this.state.faucetConfig);
    this.lastConfigRefreshStart = now;
    const generation = ++this.configRefreshGeneration;

    return this.pageContext.faucetApi.getFaucetConfig().then((faucetConfig) => {
      if(generation !== this.configRefreshGeneration)
        return this.state.faucetConfig || faucetConfig;
      this.lastConfigRefresh = (new Date()).getTime();
      this.pageContext.configRevision += 1;
      const initialLoad = this.state.initializing;
      return new Promise<IFaucetConfig>((resolve) => {
        this.setState({
          initializing: false,
          initializationError: null,
          faucetConfig: faucetConfig,
          faucetStatus: faucetConfig.faucetStatus,
        }, () => {
          if(initialLoad)
            this.revealInitialPaint();
          resolve(faucetConfig);
        });
      });
    });
  }

  private revealInitialPaint(): void {
    if(this.initialPaintRevealStarted)
      return;
    this.initialPaintRevealStarted = true;
    void revealInitialPaint(document);
  }

	public render(): React.ReactElement<IFaucetPageProps> {
    if(this.state.initializing) {
      return (
        <div className="faucet-loading">
          <div className="loading-spinner">
            <img src={(this.pageContext.faucetUrls.imagesUrl || "/images") + "/spinner.gif"} className="spinner" alt="" />
            <span className="spinner-text">Loading...</span>
          </div>
        </div>
      );
    }
    if(this.state.initializationError) {
      return (
        <div className="faucet-loading">
          <div className="faucet-initialization-error alert alert-danger" role="alert">
            <span>{this.state.initializationError}</span>
            <button type="button" className="btn btn-secondary" onClick={() => location.reload()}>Refresh</button>
          </div>
        </div>
      );
    }
    return (
      <div className='faucet-page' ref={(ref) => {
        this.faucetContainerElement = ref;
      }}>
        <FaucetConfigContext.Provider value={this.state.faucetConfig}>
          <FaucetPageContext.Provider value={this.pageContext}>
            <Router>
              <div className="faucet-title">
                <div className="faucet-title-inner">
                  <a className="faucet-wordmark" href="#/" aria-label="hyperfaucet.dev, home">{this.state.faucetConfig.faucetTitle}</a>
                  <div className="faucet-title-controls">
                    <AppearanceControl pageContext={this.pageContext} />
                    <div className="faucet-status-link" onClick={() => this.onFaucetStatusClick()}></div>
                  </div>
                </div>
              </div>
              {this.renderStatusAlerts()}
              <div className="faucet-body">
                {this.props.children && (!Array.isArray(this.props.children) || this.props.children.length > 0) ? this.props.children :
                <div className="faucet-route-stack">
                  <PersistentHomeMascot pageContext={this.pageContext} />
                  <RouteFade>
                    <Routes>
                      <Route
                        path='/'
                        element={(
                          <FrontPage />
                        )}
                      />
                      <Route
                        path='/mine/:session'
                        element={(
                          <MiningPage />
                        )}
                      />
                      <Route
                        path='/claim/:session'
                        element={(
                          <ClaimPage />
                        )}
                      />
                      <Route
                        path='/details/:session'
                        element={(
                          <DetailsPage />
                        )}
                      />
                      <Route
                        path='/status'
                        element={(
                          <FaucetStatusPage />
                        )}
                      />
                      <Route
                        path='/queue'
                        element={(
                          <QueueStatusPage />
                        )}
                      />
                      <Route
                        path='/info'
                        element={(
                          <InfoPage />
                        )}
                      />
                    </Routes>
                  </RouteFade>
                </div>
                }
              </div>
              {this.renderDialogs()}
              {this.renderNotifications()}
              <div className='faucet-footer'>
                <span>by <a href="https://validao.xyz/#tools" target="_blank" rel="noopener">ValiDAO</a></span>
                <Link to="/info">Information</Link>
                <a href="https://github.com/validaoxyz/hyperfaucet" target="_blank" rel="noreferrer">Fork me</a>
                <a href="https://hyperpools.dev" target="_blank" rel="noreferrer">HyperPools</a>
                <a href="https://testnet.hyperevm-explorer.xyz" target="_blank" rel="noreferrer">Explorer</a>
              </div>
            </Router>
          </FaucetPageContext.Provider>
        </FaucetConfigContext.Provider>
      </div>
    );
	}

  private renderStatusAlerts(): React.ReactElement {
    const faucetStatusEntries: Array<IFaucetStatus | IFaucetStatusAlert> = [
      ...this.state.faucetStatus.filter((status) => !status.blocksSessionStart),
      ...this.state.statusAlerts,
    ];
    faucetStatusEntries.sort((a, b) => (a.prio || 10) - (b.prio || 10));

    return (
      <div className="faucet-status-alerts">
        {faucetStatusEntries.map((status, idx) => {
          let faucetStatusClass: string = "";
          switch(status.level) {
            case "info":
              faucetStatusClass = "alert-info";
              break;
            case "warn":
              faucetStatusClass = "alert-warning";
              break;
            case "error":
              faucetStatusClass = "alert-danger";
              break;
            default:
              faucetStatusClass = "alert-light";
              break;
          }
          return (
            <div key={"status" + idx} className={["faucet-status-alert alert", faucetStatusClass].join(" ")} role="alert">
              {"body" in status ? status.body : status.ishtml ?
                <div dangerouslySetInnerHTML={{__html: status.text}} /> :
                <span>{status.text}</span>
              }
            </div>
          );
        })}
      </div>
    );
  }

  private showStatusAlert(level: string, prio: number, body: React.ReactElement): number {
    let statusAlertId = this.statusAlertIdCounter++;
    let statusAlert: IFaucetStatusAlert = {
      id: statusAlertId,
      level: level,
      prio: prio,
      body: body,
    }
    this.statusAlerts.push(statusAlert);
    this.setState({
      statusAlerts: this.statusAlerts.slice()
    })
    return statusAlertId;
  }

  private hideStatusAlert(statusAlertId: number): void {
    let statusAlertIdx = -1;
    let statusAlert: IFaucetStatusAlert;
    for(let idx = 0; idx < this.state.statusAlerts.length; idx++) {
      if(this.statusAlerts[idx].id === statusAlertId) {
        statusAlertIdx = idx;
        statusAlert = this.state.statusAlerts[idx];
        break;
      }
    }
    if(statusAlertIdx !== -1) {
      this.statusAlerts.splice(statusAlertIdx, 1);
      this.setState({
        statusAlerts: this.statusAlerts.slice()
      });
    }
  }

  private renderNotifications(): React.ReactElement {
    return (
      <div className='faucet-notifications'>
        {this.state.notifications.map((notification) => (
          <FaucetNotification
            key={notification.id}
            type={notification.type}
            message={notification.message}
            time={notification.time}
            leaving={notification.leaving}
            hideFn={() => this.hideNotification(notification.id)}
          />
        ))}
      </div>
    );
  }

  private showNotification(type: string, message: string, time?: number|boolean, timeout?: number): number {
    let notificationId = this.notificationIdCounter++;
    let notification: IFaucetNotification = {
      id: notificationId,
      type: type,
      message: message,
      time: typeof time == "number" ? time : time ? (new Date()).getTime() : null,
      timeout: timeout ? (new Date()).getTime() + timeout : 0,
      timerId: timeout ? setTimeout(() => {
        notification.timerId = null;
        this.hideNotification(notification.id);
      }, timeout) : null,
    }
    if(this.notifications.length > 10) {
      this.notifications.splice(0, this.notifications.length - 10).forEach((n) => {
        if(n.timerId) {
          clearTimeout(n.timerId);
          n.timerId = null;
        }
      });
    }
    this.notifications.push(notification);
    this.setState({
      notifications: this.notifications.slice()
    })
    return notificationId;
  }

  private hideNotification(notificationId: number): void {
    let notificationIdx = -1;
    let notification: IFaucetNotification;
    for(let idx = 0; idx < this.state.notifications.length; idx++) {
      if(this.notifications[idx].id === notificationId) {
        notificationIdx = idx;
        notification = this.state.notifications[idx];
        break;
      }
    }
    if(notificationIdx !== -1) {
      if(notification.timerId) {
        clearTimeout(notification.timerId);
        notification.timerId = null;
      }
      if(notification.leaving)
        return;

      // two-phase removal: play the exit animation, then unmount
      notification.leaving = true;
      this.setState({
        notifications: this.notifications.slice()
      });
      setTimeout(() => {
        let idx = this.notifications.indexOf(notification);
        if(idx !== -1) {
          this.notifications.splice(idx, 1);
          this.setState({
            notifications: this.notifications.slice()
          });
        }
      }, 220);
    }
  }

  private renderDialogs(): React.ReactElement[] {
    return this.state.dialogs.map((dialog) => (
      <FaucetDialog
        key={dialog.id}
        {...dialog.dialog}
        dialogId={dialog.id}
        closing={dialog.closing}
        container={this.faucetContainerElement}
      />
    ));
  }

  private showDialog(dialogProps: IFaucetDialogProps): number {
    let dialogId = this.dialogIdCounter++;
    let dialog: IFaucetDialog = {
      id: dialogId,
      dialog: {
        ...dialogProps,
        closeFn: () => this.hideDialog(dialogId),
      },
      closeFn: dialogProps.closeFn,
    }
    this.dialogs.push(dialog);
    this.setState({
      dialogs: this.dialogs.slice()
    })
    return dialogId;
  }

  private hideDialog(dialogId: number): void {
    let dialogIdx = -1;
    let dialog: IFaucetDialog;
    for(let idx = 0; idx < this.dialogs.length; idx++) {
      if(this.dialogs[idx].id === dialogId) {
        dialogIdx = idx;
        dialog = this.dialogs[idx];
        break;
      }
    }
    if(dialog && dialogIdx !== -1) {
      if(dialog.closing)
        return;
      if(dialog.closeFn)
        dialog.closeFn();
      // two-phase removal: play the modal's exit transition, then unmount
      dialog.closing = true;
      this.setState({
        dialogs: this.dialogs.slice()
      });
      setTimeout(() => {
        let idx = this.dialogs.indexOf(dialog);
        if(idx === -1)
          return;
        this.dialogs.splice(idx, 1);
        this.setState({
          dialogs: this.dialogs.slice()
        });
      }, 200);
    }
  }

  private onFaucetStatusClick() {
    this.faucetStatucClickCount++;
    if(this.faucetStatucClickCount >= 10) {
      this.faucetStatucClickCount = 0;
      location.href = "#/status";
    }
  }

}
