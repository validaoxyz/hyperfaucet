import React, { useContext } from 'react';
import { Link } from "react-router";
import { FaucetConfigContext } from '../FaucetPage';
import { AddressChip } from '../shared/AddressChip';

const DefaultInfoSections = (): React.ReactElement => (
  <div className="pow-home-container">
    <div className="pow-info">
      <h5>About</h5>
      <p>A proof-of-work faucet for HyperEVM testnet. Mining in your browser rate-limits requests, so there is testnet HYPE left for everyone.</p>
    </div>
    <div className="pow-info">
      <h5>How it works</h5>
      <p>Enter your address and start mining. Stop whenever you want and claim what you mined. Wallets staking HYPE with any validator earn a hash rate boost: 2x from 100 HYPE staked, 3x from 500 HYPE.</p>
    </div>
  </div>
);

export const InfoContent = (): React.ReactElement => {
  const faucetConfig = useContext(FaucetConfigContext);

  return (
    <div className='page-info-card'>
      {faucetConfig.faucetHtml ?
        <div className="pow-home-container" dangerouslySetInnerHTML={{__html: faucetConfig.faucetHtml}} />
      : <DefaultInfoSections />}
      {faucetConfig.faucetDonation || faucetConfig.faucetWallet ?
        <div className='pow-info'>
          <h5>Support</h5>
          <p>If you have any spare testnet HYPE, feel free to donate here to keep the faucet running:</p>
          <AddressChip address={faucetConfig.faucetDonation || faucetConfig.faucetWallet} />
        </div>
      : null}
    </div>
  );
};

const InfoPage = (): React.ReactElement => (
  <div className='page-info'>
    <div className='page-info-header'>
      <Link to='/' className='page-info-back' aria-label='Back to the faucet'>
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M19 12H5" />
          <path d="m12 19-7-7 7-7" />
        </svg>
      </Link>
      <h1>Information</h1>
    </div>
    <InfoContent />
  </div>
);

export default InfoPage;
