
declare const FAUCET_CLIENT_VERSION: string;
declare const FAUCET_CLIENT_BUILDTIME: number;

interface Eip1193Request {
  method: string;
  params?: unknown[];
}

interface Eip1193Provider {
  request(request: Eip1193Request): Promise<unknown>;
}

interface Window {
  ethereum?: Eip1193Provider;
}
