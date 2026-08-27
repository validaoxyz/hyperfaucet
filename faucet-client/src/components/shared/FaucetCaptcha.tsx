import { IFaucetConfig } from '../../common/FaucetConfig';
import React from 'react';
import HCaptcha from '@hcaptcha/react-hcaptcha';
import ReCAPTCHA from "react-google-recaptcha";
import Turnstile from "react-turnstile";

export interface IFaucetCaptchaProps {
  faucetConfig: IFaucetConfig;
  onChange?: (token: string) => void;
  variant: "session" | "claim";
  target?: string;
}

export interface IFaucetCaptchaState {
}

interface IPoWFaucetCustomCaptchaLoader {
  createCaptcha(options?: {
    onChange?: (token: string) => void;
    customData?: any;
    variant?: string;
    target?: string;
  }): IFaucetCustomCaptcha;
}

interface IFaucetCustomCaptcha {
  render(container: Element): void;
  getToken(): string;
  reset(): void;
  unmount(): void;
}

export class FaucetCaptcha extends React.PureComponent<IFaucetCaptchaProps, IFaucetCaptchaState> {
  private lastToken: string;
  private hcapControl: HCaptcha;
  private recapControl: ReCAPTCHA;
  private turnstileWidgetId: string;
  private customControl: IFaucetCustomCaptcha;

  constructor(props: IFaucetCaptchaProps) {
    super(props);

    this.state = {};
  }

  public getToken(): Promise<string> {
    if(this.customControl) {
      return Promise.resolve().then(() => {
        return this.customControl.getToken();
      });
    }
    return Promise.resolve(this.lastToken);
  }

  public resetToken() {
    this.lastToken = null;
    if(this.hcapControl)
      this.hcapControl.resetCaptcha();
    if(this.recapControl)
      this.recapControl.reset();
    if(this.turnstileWidgetId)
      (window as any).turnstile.reset(this.turnstileWidgetId);
    if(this.customControl)
      this.customControl.reset();
  }

  private onTokenChange(token: string) {
    this.lastToken = token;
    if(this.props.onChange)
      this.props.onChange(token);
  }

  public componentWillUnmount() {
    if(this.hcapControl) {
      this.hcapControl.removeCaptcha();
      this.hcapControl = null;
    }
    if(this.turnstileWidgetId) {
      (window as any).turnstile.remove(this.turnstileWidgetId);
      this.turnstileWidgetId = null;
    }
    if(this.customControl) {
      this.customControl.unmount();
      this.customControl = null;
    }
  }

	public render(): React.ReactElement<IFaucetCaptchaProps> {
    if(!this.props.faucetConfig.modules.captcha)
      return null;
    
    let captchaEl: React.ReactElement;
    switch(this.props.faucetConfig.modules.captcha.provider) {
      case "hcaptcha":
        captchaEl = this.renderHCaptcha();
        break;
      case "recaptcha":
        captchaEl = this.renderReCaptcha();
        break;
      case "turnstile":
        captchaEl = this.renderTurnstile();
        break;
      case "custom":
        captchaEl = this.renderCustomCaptcha();
        break;
    }

    return (
      <div className='faucet-captcha'>
        {captchaEl}
      </div>
    );
	}

  private renderHCaptcha(): React.ReactElement {
    return (
      <HCaptcha 
        sitekey={this.props.faucetConfig.modules.captcha.siteKey} 
        onVerify={(token) => this.onTokenChange(token)}
        ref={(cap) => { this.hcapControl = cap; }} 
      />
    );
  }

  private renderReCaptcha(): React.ReactElement {
    return (
      <ReCAPTCHA
        sitekey={this.props.faucetConfig.modules.captcha.siteKey}
        onChange={(token) => this.onTokenChange(token)}
        ref={(cap) => { this.recapControl = cap; }}
      />
    );
  }

  private renderTurnstile(): React.ReactElement {
    // follow the active scene, not the OS ("auto" would ignore the app theme),
    // and stretch to the container instead of the default 300px box
    let scheme: "light" | "dark" = "dark";
    try {
      if(getComputedStyle(document.documentElement).colorScheme === "light")
        scheme = "light";
    } catch(ex) {}
    return (
      <Turnstile
        sitekey={this.props.faucetConfig.modules.captcha.siteKey}
        action={this.props.variant}
        theme={scheme}
        size="flexible"
        onVerify={(token) => this.onTokenChange(token)}
        onLoad={(widgetId) => { this.turnstileWidgetId = widgetId; }}
      />
    );
  }

  private injectCustomCaptchaLoader(): Promise<IPoWFaucetCustomCaptchaLoader> {
    let customScriptEl = document.querySelector('script[ref="custom-captcha"]');
    let customScriptPromise: Promise<IPoWFaucetCustomCaptchaLoader>;
    if(!customScriptEl) {
      customScriptPromise = new Promise((resolve, reject) => {
        let callbackFnName = (() => {
          while(true) {
            let name = "powFaucetCustomCaptcha" + Math.floor(Math.random() * 10000);
            if(window.hasOwnProperty(name))
              continue;
            return name;
          }
        })();
        let customCaptchaLoader: IPoWFaucetCustomCaptchaLoader;
        Object.defineProperty(window, callbackFnName, {
          configurable: false,
          enumerable: false,
          writable: false,
          value: function(loader: IPoWFaucetCustomCaptchaLoader) {
            if(customCaptchaLoader)
              return;
              customCaptchaLoader = loader;
          }
        });
  
        customScriptEl = document.createElement("script");
        customScriptEl.setAttribute("src", this.props.faucetConfig.modules.captcha.siteKey.replace(/{callback}/, callbackFnName));
        customScriptEl.setAttribute("ref", "custom-captcha");
        customScriptEl.addEventListener("load", () => {
          if(customCaptchaLoader)
            resolve(customCaptchaLoader);
          else
            reject("captcha loader callback not called");
        });
        customScriptEl.addEventListener("error", (err) => {
          reject("custom captcha could not be initialized: " + (err ? err.toString() : ""));
        });

        document.head.appendChild(customScriptEl);
      });
      (customScriptEl as any)._FaucetCaptchaPromise = customScriptPromise;

      customScriptPromise.catch(() => {
        if(customScriptEl.parentElement) {
          customScriptEl.parentElement.removeChild(customScriptEl);
        }
      });
    }
    else {
      customScriptPromise = (customScriptEl as any)._FaucetCaptchaPromise;
    }
    return customScriptPromise;
  }

  private renderCustomCaptcha(): React.ReactElement {
    let controlPromise: Promise<IFaucetCustomCaptcha>;
    if(this.customControl) {
      controlPromise = Promise.resolve(this.customControl);
    }
    else {
      let captchaLoader = this.injectCustomCaptchaLoader();
      controlPromise = captchaLoader.then((loader) => {
        return this.customControl = loader.createCaptcha({
          onChange: (token) => this.onTokenChange(token),
          variant: this.props.variant,
          target: this.props.target,
        });
      });
    }

    return (
      <div ref={(div) => {
        if(div) {
          controlPromise.then((control) => {
            control.render(div);
          }, (err) => {
            div.innerHTML = '<div class="alert alert-danger" role="alert">Error: Captcha could not be loaded</div>';
            console.error(err);
          });
        }
      }}>Loading captcha...</div>
    )
  }

}
