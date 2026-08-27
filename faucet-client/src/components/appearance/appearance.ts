export interface IAppearance {
  theme: string;
  mascot: string;
}

type AppearanceWindow = Window & {
  __setFaucetAppearance?: (patch: Partial<IAppearance>) => IAppearance;
  __getFaucetAppearance?: () => IAppearance;
};

export function getAppearance(): IAppearance {
  const getAppearanceFn = (window as AppearanceWindow).__getFaucetAppearance;
  if (typeof getAppearanceFn === "function")
    return getAppearanceFn();
  return { theme: "cobalt-mass", mascot: "miner" };
}

export function setAppearance(patch: Partial<IAppearance>): IAppearance {
  const setAppearanceFn = (window as AppearanceWindow).__setFaucetAppearance;
  if (typeof setAppearanceFn === "function")
    return setAppearanceFn(patch);
  return getAppearance();
}
