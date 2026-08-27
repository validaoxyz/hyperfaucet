import React from 'react';

export interface IMascotMeta {
  id: string;
  label: string;
  kind: "gif" | "ascii";
}

export const MASCOTS: IMascotMeta[] = [
  { id: "miner", label: "Miner", kind: "gif" },
];

export interface IMascotViewProps {
  mascotId: string;
  animate: boolean;
  imagesUrl: string;
  className?: string;
}

export function MascotView(props: IMascotViewProps): React.ReactElement {
  return (
    <img
      className={props.className}
      src={props.imagesUrl + "/mascots/miner/progress" + (props.animate ? ".gif" : ".png")}
      alt=""
    />
  );
}
