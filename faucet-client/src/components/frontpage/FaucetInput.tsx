import React from 'react';
import { IFaucetConfig, IFaucetStatus } from '../../common/FaucetConfig';
import { IFaucetContext } from '../../common/FaucetContext';
import { FaucetCaptcha } from '../shared/FaucetCaptcha';
import { AuthenticatoorLogin } from './authenticatoor/AuthenticatoorLogin';
import { GithubLogin } from './github/GithubLogin';
import { ZupassLogin } from './zupass/ZupassLogin';
import VoucherInput, { IVoucherInputRef } from './voucher/VoucherInput';

export interface IFaucetInputProps {
  faucetContext: IFaucetContext;
  faucetConfig: IFaucetConfig;
  startBlocker?: IFaucetStatus;
  defaultAddr?: string;
  submitInputs(inputs: any): Promise<FaucetInputSubmissionResult>;
  preflightFn?: () => Promise<void>; // runs before the captcha, e.g. releasing a previous session's per-IP slot
}

export interface IFaucetInputState {
  submitting: boolean;
  revealedStartBlocker?: {
    status: IFaucetStatus;
    configRevision: number;
  };
  targetAddr: string;
  addrError: string;
}

export type FaucetInputSubmissionResult =
  | {kind: "submitted"}
  | {kind: "blocked"; blocker: IFaucetStatus};

export class FaucetInput extends React.PureComponent<IFaucetInputProps, IFaucetInputState> {
  private authenticatoorLogin = React.createRef<AuthenticatoorLogin>();
  private githubLogin = React.createRef<GithubLogin>();
  private zupassLogin = React.createRef<ZupassLogin>();
  private voucherInput = React.createRef<IVoucherInputRef>();
  private addrInput = React.createRef<HTMLInputElement>();

  constructor(props: IFaucetInputProps) {
    super(props);

    this.state = {
      submitting: false,
      revealedStartBlocker: undefined,
      targetAddr: this.props.defaultAddr || "",
      addrError: null,
		};
  }

  public componentDidUpdate(): void {
    if(
      this.state.revealedStartBlocker &&
      !this.props.startBlocker &&
      this.state.revealedStartBlocker.configRevision !== this.props.faucetContext.configRevision
    ) {
      this.setState({ revealedStartBlocker: undefined });
    }
  }

	public render(): React.ReactElement<IFaucetInputProps> {
    const startBlocker = this.props.startBlocker || this.state.revealedStartBlocker?.status;
    const startBlocked = !!this.state.revealedStartBlocker && !!startBlocker;
    let needAuthenticatoor = !!this.props.faucetConfig.modules.authenticatoor;
    let needGithubAuth = !!this.props.faucetConfig.modules.github;
    let needZupassAuth = !!this.props.faucetConfig.modules.zupass;
    let needVoucher = !!this.props.faucetConfig.modules.voucher;
    let inputTypes: string[] = [];
    if(this.props.faucetConfig.modules.ensname?.required) {
      inputTypes.push("ENS name");
    }
    else {
      inputTypes.push("0x address");
      if(this.props.faucetConfig.modules.ensname)
        inputTypes.push("ENS name");
    }

    let submitBtnCaption: string;
    if(this.props.faucetConfig.modules.pow) {
      submitBtnCaption = "Start Mining";
    }
    else {
      submitBtnCaption = "Request funds";
    }

    return (
      <div className="faucet-inputs">
        <div className="faucet-field">
          <label className="visually-hidden" htmlFor="faucet-target-addr">Wallet address to mine to</label>
          <input
            id="faucet-target-addr"
            ref={this.addrInput}
            className="form-control"
            value={this.state.targetAddr}
            placeholder={"Your " + (inputTypes.join(" or "))}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={this.state.addrError ? true : undefined}
            aria-describedby={this.state.addrError ? "faucet-target-addr-error" : undefined}
            onChange={(evt) => this.setState({ targetAddr: evt.target.value, addrError: null })}
          />
          {this.state.addrError ?
            /* no visible text by design: the ring and shake carry the signal;
               screen readers still get the reason */
            <div className="visually-hidden" id="faucet-target-addr-error" aria-live="polite">{this.state.addrError}</div>
          : null}
        </div>
        {needAuthenticatoor ?
          <AuthenticatoorLogin
            faucetConfig={this.props.faucetConfig}
            faucetContext={this.props.faucetContext}
            ref={this.authenticatoorLogin}
          />
        : null}
        {needGithubAuth ?
          <GithubLogin
            faucetConfig={this.props.faucetConfig}
            faucetContext={this.props.faucetContext}
            ref={this.githubLogin}
          />
        : null}
        {needZupassAuth ? 
          <React.Suspense fallback={<div>loading...</div>}>
            <ZupassLogin 
              faucetConfig={this.props.faucetConfig} 
              faucetContext={this.props.faucetContext} 
              ref={this.zupassLogin}
            />
          </React.Suspense>
        : null}
        {needVoucher ?
          <VoucherInput
            faucetConfig={this.props.faucetConfig}
            faucetContext={this.props.faucetContext}
            ref={this.voucherInput}
          />
        : null}
        {startBlocked ?
          <div id="faucet-start-blocker" className="alert alert-danger" role="alert">
            {startBlocker.text}
          </div>
        : null}
        <div className="faucet-actions center">
          <button
            className="btn btn-success start-action"
            onClick={() => this.onSubmitBtnClick()}
            disabled={this.state.submitting || startBlocked}
            aria-describedby={startBlocked ? "faucet-start-blocker" : undefined}>
              {this.state.submitting ?
              <span className='inline-spinner'>
                <img src={(this.props.faucetContext.faucetUrls.imagesUrl || "/images") + "/spinner.gif"} className="spinner" alt="" />
              </span>
              : null}
              {submitBtnCaption}
          </button>
        </div>
      </div>
    );
	}

  private async onSubmitBtnClick() {
    // when ENS names aren't accepted, an empty or malformed address is caught
    // here instead of round-tripping to the server's error dialog; the button
    // stays alive so the block can answer with the ring + shake
    if(!this.props.faucetConfig.modules.ensname && !/^0x[0-9a-fA-F]{40}$/.test(this.state.targetAddr)) {
      this.setState({
        addrError: this.state.targetAddr.trim() ? "Enter a full 0x address (42 characters)" : "Enter your 0x address",
      });
      let input = this.addrInput.current;
      if(input) {
        input.focus();
        // reduced motion skips the shake; the red ring carries the signal
        if(!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          input.animate([
            { transform: "translateX(0)" },
            { transform: "translateX(-0.3125rem)" },
            { transform: "translateX(0.25rem)" },
            { transform: "translateX(-0.1875rem)" },
            { transform: "translateX(0.125rem)" },
            { transform: "translateX(0)" },
          ], { duration: 300, easing: "ease-out" });
        }
      }
      return;
    }

    if(this.props.startBlocker) {
      this.setState({
        revealedStartBlocker: {
          status: this.props.startBlocker,
          configRevision: this.props.faucetContext.configRevision,
        },
      });
      return;
    }

    this.setState({
      submitting: true
    });

    try {
      let currentConfig: IFaucetConfig;
      try {
        currentConfig = await this.props.faucetContext.refreshConfig(true);
      }
      catch {
        this.props.faucetContext.showDialog({
          title: "Could not start session",
          body: (<div className="alert alert-danger">Could not check the faucet status. Try again.</div>),
          closeButton: { caption: "Close" },
        });
        return;
      }

      const freshStartBlocker = currentConfig.faucetStatus.find((status) => status.blocksSessionStart);
      if(freshStartBlocker) {
        this.setState({
          revealedStartBlocker: {
            status: freshStartBlocker,
            configRevision: this.props.faucetContext.configRevision,
          },
        });
        return;
      }

      const configRevision = this.props.faucetContext.configRevision;
      let inputData: any = {};

      inputData.addr = this.state.targetAddr;
      if(this.props.preflightFn)
        await this.props.preflightFn();
      if(this.props.faucetConfig.modules.captcha?.requiredForStart) {
        let captchaToken = await this.requestCaptchaToken();
        if(!captchaToken)
          return; // dialog dismissed without solving: abort silently
        inputData.captchaToken = captchaToken;
      }
      if(this.props.faucetConfig.modules.authenticatoor) {
        inputData.authToken = this.authenticatoorLogin.current?.getToken() || undefined;
      }
      if(this.props.faucetConfig.modules.github) {
        inputData.githubToken = await this.githubLogin.current?.getToken();
      }
      if(this.props.faucetConfig.modules.zupass) {
        inputData.zupassToken = await this.zupassLogin.current?.getToken();
      }
      if (this.props.faucetConfig.modules.voucher) {
        inputData.voucherCode = this.voucherInput.current?.getCode();
      }

      const result = await this.props.submitInputs(inputData);
      if(result.kind === "blocked") {
        this.setState({
          revealedStartBlocker: {
            status: result.blocker,
            configRevision,
          },
        });
      }
    } finally {
      this.setState({
        submitting: false
      });
    }
  }

  // opens the captcha in a dialog; resolves with the token once solved, or
  // null if the dialog is dismissed first. hideDialog always invokes closeFn,
  // so settle() must run before the programmatic close to keep them distinct.
  private requestCaptchaToken(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      let dialogId: number;
      let settled = false;
      let settle = (token: string | null) => {
        if(settled)
          return;
        settled = true;
        resolve(token);
      };
      dialogId = this.props.faucetContext.showDialog({
        title: "Quick check",
        body: (
          <div
            className='faucet-captcha'
            tabIndex={-1}
            ref={(div) => {
              if(div)
                requestAnimationFrame(() => div.focus());
            }}
          >
            <FaucetCaptcha
              faucetConfig={this.props.faucetConfig}
              variant='session'
              onChange={(token) => {
                if(!token)
                  return;
                settle(token);
                this.props.faucetContext.hideDialog(dialogId);
              }}
            />
          </div>
        ),
        closeButton: { caption: "Cancel" },
        closeFn: () => settle(null),
      });
    });
  }

}
