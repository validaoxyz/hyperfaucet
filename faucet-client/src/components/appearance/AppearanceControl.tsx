import React from 'react';
import { IFaucetContext } from '../../common/FaucetContext';
import { setAppearance } from './appearance';

export function AppearanceControl({ pageContext }: { pageContext: IFaucetContext }): React.ReactElement {
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label="Switch dark/light theme"
      onClick={() => {
        const current = document.documentElement.getAttribute("data-theme");
        setAppearance({ theme: current === "porcelain-cobalt" ? "cobalt-mass" : "porcelain-cobalt" });
      }}
    >
      <svg className="icon-moon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20.3 14.6A8.5 8.5 0 0 1 9.4 3.7a8.5 8.5 0 1 0 10.9 10.9Z" />
      </svg>
      <svg className="icon-sun" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4.5" />
        <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19" />
      </svg>
    </button>
  );
}
