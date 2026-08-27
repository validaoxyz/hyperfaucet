import React, { ReactElement } from 'react';
import { Button, Modal } from 'react-bootstrap';

export interface IFaucetDialogProps {
  title: string;
  body: ReactElement;
  size?: string;
  closeButton?: {
    caption: string;
  },
  applyButton?: {
    caption: string;
    variant?: string;
    applyFn: () => void,
  },
  className?: string; // extra class on the modal, e.g. a bespoke entrance
  closeFn?: () => void,
}

export interface IFaucetDialogFullProps extends IFaucetDialogProps {
  container: HTMLElement;
  dialogId?: number;
  closing?: boolean; // host is playing the exit transition before unmount
}

export interface IFaucetDialogState {
}

export class FaucetDialog extends React.PureComponent<IFaucetDialogFullProps, IFaucetDialogState> {

  constructor(props: IFaucetDialogFullProps) {
    super(props);

    this.state = {};
  }

	public render(): React.ReactElement<IFaucetDialogFullProps> {
    let titleId = "faucet-dialog-title-" + (this.props.dialogId ?? "x");
    return (
      <Modal container={this.props.container} show={!this.props.closing} centered className={"faucet-dialog" + (this.props.className ? " " + this.props.className : "")} size={(this.props.size || undefined) as any} aria-labelledby={titleId} onHide={() => {
        if(this.props.closeFn)
          this.props.closeFn();
      }}>
        <Modal.Header closeButton>
          <Modal.Title id={titleId}>
            {this.props.title}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {this.props.body}
        </Modal.Body>
        <Modal.Footer>
          {this.props.applyButton ?
            <Button variant={this.props.applyButton.variant || "primary"} onClick={async () => {
              try {
                await this.props.applyButton.applyFn();
                if(this.props.closeFn)
                  this.props.closeFn();
              } catch(ex) {}
            }}>{this.props.applyButton.caption}</Button>
          : null}
          {this.props.closeButton ? 
            <Button onClick={() => {
              if(this.props.closeFn)
                this.props.closeFn();
            }}>{this.props.closeButton.caption}</Button>
          : null}
        </Modal.Footer>
      </Modal>
    );
	}

}
