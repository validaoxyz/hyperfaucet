import React from 'react';

export interface IFaucetNotificationProps {
  type: string;
  message: string;
  time: number;
  leaving?: boolean;
  hideFn?: () => void,
}

export interface IFaucetNotificationState {
}

export class FaucetNotification extends React.PureComponent<IFaucetNotificationProps, IFaucetNotificationState> {

  constructor(props: IFaucetNotificationProps) {
    super(props);

    this.state = {};
  }

	public render(): React.ReactElement<IFaucetNotificationProps> {
    let alertClass: string[] = [ "alert" ];
    switch(this.props.type) {
      case "success":
        alertClass.push("alert-success");
        break;
      case "error":
        alertClass.push("alert-danger");
        break;
      case "warning":
        alertClass.push("alert-warning");
        break;
      case "info":
        alertClass.push("alert-info");
        break;
    }

    return (
      <div className={"faucet-notification" + (this.props.leaving ? " leaving" : "")} onClick={() => this.props.hideFn ? this.props.hideFn() : null}>
        <div className={alertClass.join(" ")} role={this.props.type === "error" ? "alert" : "status"}>
          <span className="notification-message">{this.props.message}</span>
          {this.props.hideFn ?
            <button type="button" className="notification-dismiss" aria-label="Dismiss" onClick={(evt) => {
              evt.stopPropagation();
              this.props.hideFn();
            }} />
          : null}
        </div>
      </div>
    );
	}

}
