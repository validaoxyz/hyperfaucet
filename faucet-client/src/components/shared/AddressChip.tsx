import React from 'react';

export interface IAddressChipProps {
  address: string;
  className?: string;
}

export interface IAddressChipState {
  copied: boolean;
}

/* A hex address as a quiet mono chip that copies itself on click. Full address,
 * no truncation — 42 mono characters fit every surface this app puts them on,
 * and overflow-wrap covers narrow phones. */
export class AddressChip extends React.PureComponent<IAddressChipProps, IAddressChipState> {
  private resetTimer: NodeJS.Timeout;

  constructor(props: IAddressChipProps) {
    super(props);
    this.state = { copied: false };
  }

  public componentWillUnmount() {
    if(this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }

  private async onCopyClick() {
    try {
      await navigator.clipboard.writeText(this.props.address);
    } catch(ex) {
      let input = document.createElement("textarea");
      input.value = this.props.address;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
    }
    this.setState({ copied: true });
    if(this.resetTimer)
      clearTimeout(this.resetTimer);
    this.resetTimer = setTimeout(() => {
      this.resetTimer = null;
      this.setState({ copied: false });
    }, 1500);
  }

  public render(): React.ReactElement<IAddressChipProps> {
    return (
      <button
        type="button"
        className={"address-chip" + (this.state.copied ? " copied" : "") + (this.props.className ? " " + this.props.className : "")}
        title="Copy address"
        aria-label={"Copy address " + this.props.address}
        onClick={() => this.onCopyClick()}
      >
        <span className="chip-addr">{this.props.address}</span>
        {this.state.copied ?
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        :
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a1 1 0 0 1 1-1h10" />
          </svg>
        }
        <span className="visually-hidden" aria-live="polite">{this.state.copied ? "Copied" : ""}</span>
      </button>
    );
  }
}
