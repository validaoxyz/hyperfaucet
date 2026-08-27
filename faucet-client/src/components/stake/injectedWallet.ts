export type WalletOwnershipErrorCode =
  | "ACCOUNT_MISMATCH"
  | "INVALID_PROVIDER_RESPONSE"
  | "NO_PROVIDER"
  | "USER_REJECTED";

export class WalletOwnershipError extends Error {
  public readonly code: WalletOwnershipErrorCode;

  public constructor(code: WalletOwnershipErrorCode, message: string) {
    super(message);
    this.name = "WalletOwnershipError";
    this.code = code;
  }
}

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;
const SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/i;

export function getInjectedWallet(): Eip1193Provider {
  if(typeof window === "undefined" || !window.ethereum || typeof window.ethereum.request !== "function")
    throw new WalletOwnershipError("NO_PROVIDER", "No browser wallet detected.");
  return window.ethereum;
}

export async function requestTargetAccount(provider: Eip1193Provider, targetAddress: string): Promise<string> {
  let response: unknown;
  try {
    response = await provider.request({method: "eth_requestAccounts"});
  } catch(ex) {
    if(isUserRejectedRequest(ex))
      throw new WalletOwnershipError("USER_REJECTED", "Wallet connection canceled.");
    throw ex;
  }

  if(!Array.isArray(response))
    throw new WalletOwnershipError("INVALID_PROVIDER_RESPONSE", "The wallet returned an invalid account list.");

  const normalizedTarget = targetAddress.toLowerCase();
  const targetAccount = response.find((account) => (
    typeof account === "string" && ADDRESS_PATTERN.test(account) && account.toLowerCase() === normalizedTarget
  ));
  if(typeof targetAccount !== "string")
    throw new WalletOwnershipError("ACCOUNT_MISMATCH", "Connected wallet does not match this mining address.");
  return targetAccount.toLowerCase();
}

export async function signOwnershipMessage(
  provider: Eip1193Provider,
  address: string,
  message: string,
): Promise<string> {
  let response: unknown;
  try {
    response = await provider.request({
      method: "personal_sign",
      params: [utf8ToHex(message), address],
    });
  } catch(ex) {
    if(isUserRejectedRequest(ex))
      throw new WalletOwnershipError("USER_REJECTED", "Signature canceled.");
    throw ex;
  }

  if(typeof response !== "string" || !SIGNATURE_PATTERN.test(response))
    throw new WalletOwnershipError("INVALID_PROVIDER_RESPONSE", "The wallet returned an invalid signature.");
  return response;
}

export function isUserRejectedRequest(error: unknown): boolean {
  if(!error || typeof error !== "object")
    return false;
  const code = Reflect.get(error, "code");
  return code === 4001 || code === "4001";
}

export function utf8ToHex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let encoded = "0x";
  for(const byte of bytes)
    encoded += byte.toString(16).padStart(2, "0");
  return encoded;
}
