
export class FaucetError extends Error {
  private code: string;
  public data?: unknown;

  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }

  public toString(): string {
    return "[" + this.code + "] " + super.toString();
  }

  public getCode(): string {
    return this.code;
  }
}

export interface PublicFaucetAddressData {
  address: string;
}

export interface PublicFaucetIpInfoData extends PublicFaucetAddressData {
  ipflags: [boolean, boolean];
}

type PublicFaucetTextErrorCode =
  | "AUTHENTICATOOR_CONCURRENCY_LIMIT"
  | "AUTHENTICATOOR_LIMIT"
  | "BALANCE_LIMIT"
  | "CONCURRENCY_LIMIT"
  | "FAUCET_EMPTY"
  | "FAUCET_DISABLED"
  | "GITHUB_CHECK"
  | "GITHUB_LIMIT"
  | "MAINNET_BALANCE_LIMIT"
  | "MAINNET_TXCOUNT_LIMIT"
  | "RECURRING_LIMIT"
  | "ZUPASS_CONCURRENCY_LIMIT"
  | "ZUPASS_LIMIT";

export type PublicFaucetErrorSpec =
  | {
      code: PublicFaucetTextErrorCode;
      message: string;
    }
  | {
      code: "STAKE_REQUIRED" | "PASSPORT_SCORE";
      message: string;
      data: PublicFaucetAddressData;
    }
  | {
      code: "IPINFO_RESTRICTION";
      message: string;
      data?: PublicFaucetIpInfoData;
    };

export class PublicFaucetError extends FaucetError {
  public readonly publicData: PublicFaucetAddressData | PublicFaucetIpInfoData | undefined;

  public constructor(spec: PublicFaucetErrorSpec) {
    super(spec.code, spec.message);
    this.publicData = "data" in spec ? spec.data : undefined;
  }
}
