import React from 'react';
import { IFaucetConfig } from '../../common/FaucetConfig';
import { renderTimespan } from '../../utils/DateUtils';
import { FaucetTime } from '../../common/FaucetTime';

export interface IConnectionAlertProps {
  faucetConfig: IFaucetConfig;
  disconnectTime: number;
  timeoutCb?: () => void;
}

export interface IConnectionAlertState {
  refreshIndex: number;
}

export class ConnectionAlert extends React.PureComponent<IConnectionAlertProps, IConnectionAlertState> {
  private updateTimer: NodeJS.Timer;
  private timeoutCbCalled: boolean;

  constructor(props: IConnectionAlertProps) {
    super(props);

    this.state = {
      refreshIndex: 0,
		};
  }

  public componentDidMount() {
    if(!this.updateTimer) {
      this.setUpdateTimer();
    }
  }

  public componentWillUnmount() {
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
      this.setState({
        refreshIndex: this.state.refreshIndex + 1,
      });
      this.setUpdateTimer();
    }, timeLeft);
  }

	public render(): React.ReactElement<IConnectionAlertProps> {
    let now = Math.floor((new Date()).getTime() / 1000);
    let timeout = this.props.faucetConfig.modules.pow.powIdleTimeout ? this.props.disconnectTime + this.props.faucetConfig.modules.pow.powIdleTimeout - now : 0;
    if(timeout < 0 && !this.timeoutCbCalled) {
      this.timeoutCbCalled = true;
      if(this.props.timeoutCb)
        this.props.timeoutCb();
    }

    return (
      <div className='connection-status'>
        <div className='error-caption'>Connection to faucet server has been lost. Reconnecting...</div>
        {now - this.props.disconnectTime > 10 && timeout > 0 ? (
          <div className='reconnect-info'>
            {/* the countdown ticks every second; hiding it from the a11y tree
                keeps the role=alert container from re-announcing each tick */}
            Please check your internet connection. The session will close if the connection isn't restored in time.
            <span aria-hidden="true"> Time left: {renderTimespan(timeout, 2)}.</span>
          </div>
        ) : null}
        {timeout < 0 ? (
          <div className='reconnect-info'>
            Connection couldn't be restored in time. Session timed out.
          </div>
        ) : null}
      </div>
    );
	}


}
