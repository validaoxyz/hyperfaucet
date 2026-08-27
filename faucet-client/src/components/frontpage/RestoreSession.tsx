import React from 'react';
import { IFaucetConfig } from '../../common/FaucetConfig';
import { IFaucetSessionStatus } from '../../common/FaucetSession';
import { toReadableAmount } from '../../utils/ConvertHelpers';
import { renderDate } from '../../utils/DateUtils';
import { AddressChip } from '../shared/AddressChip';

export interface IRestoreSessionProps {
  faucetConfig: IFaucetConfig;
  sessionStatus: IFaucetSessionStatus;
}

const STATUS_LABELS: {[status: string]: string} = {
  running: "Running",
  claimable: "Claimable",
  claiming: "Claiming",
  finished: "Finished",
  failed: "Failed",
};

export class RestoreSession extends React.PureComponent<IRestoreSessionProps> {

	public render(): React.ReactElement<IRestoreSessionProps> {
    let status = this.props.sessionStatus.status;
    return (
      <div className='restore-session'>
        <div className='restore-row'>
          <span className='restore-label'>Wallet</span>
          <span className='restore-value'><AddressChip address={this.props.sessionStatus.target} /></span>
        </div>
        <div className='restore-row'>
          <span className='restore-label'>Started</span>
          <span className='restore-value'>{renderDate(new Date(this.props.sessionStatus.start * 1000), true)}</span>
        </div>
        <div className='restore-row'>
          <span className='restore-label'>Balance</span>
          <span className='restore-value'>{toReadableAmount(BigInt(this.props.sessionStatus.balance), this.props.faucetConfig.faucetCoinDecimals, this.props.faucetConfig.faucetCoinSymbol)}</span>
        </div>
        <div className='restore-row'>
          <span className='restore-label'>Status</span>
          <span className='restore-value'>
            <span className={"session-state state-" + status}>{STATUS_LABELS[status] || status}</span>
          </span>
        </div>
      </div>
    );
	}

}
