import { FetchUtil } from '../../utils/FetchUtil.js';
import { normalizeIpAddress } from '../../utils/IPAddress.js';
import { IPInfoDB } from './IPInfoDB.js';

const IP_INFO_REQUEST_TIMEOUT_MS = 20_000;
const IP_INFO_RESPONSE_LIMIT = 64 * 1024;
const MAX_CONCURRENT_IP_INFO_LOOKUPS = 64;
const DEFAULT_MAX_PROVIDER_REQUESTS = 120;
const DEFAULT_PROVIDER_WINDOW_MS = 60_000;
const DEFAULT_PROVIDER_FAILURE_THRESHOLD = 2;
const DEFAULT_INITIAL_PROVIDER_BACKOFF_MS = 1_000;
const DEFAULT_MAX_PROVIDER_BACKOFF_MS = 60_000;
const MAX_INVALIDATED_CACHE_KEYS = 10_000;

export interface IIPInfo {
  status: string;
  ip?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  regionCode?: string;
  city?: string;
  cityCode?: string;
  locLat?: number;
  locLon?: number;
  zone?: string;
  isp?: string;
  org?: string;
  as?: string;
  proxy?: boolean;
  hosting?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  return typeof source[key] === "string" ? source[key] as string : undefined;
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  return typeof source[key] === "number" && Number.isFinite(source[key]) ? source[key] as number : undefined;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
  return typeof source[key] === "boolean" ? source[key] as boolean : undefined;
}

function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> {
  return isRecord(source[key]) ? source[key] : {};
}

function requireResponseSubject(response: Record<string, unknown>, expectedIp: string): string {
  let responseIp = normalizeIpAddress(readString(response, "ip") ?? readString(response, "query"));
  if(!responseIp || responseIp !== expectedIp)
    throw new Error("IP info response does not match the requested IP");
  return responseIp;
}

function parseLegacyIpApiResponse(response: Record<string, unknown>, expectedIp: string): IIPInfo {
  let status = readString(response, "status");
  if(!status)
    throw new Error("invalid IP info response");
  if(status !== "success")
    return { status };

  let proxy = readBoolean(response, "proxy");
  let hosting = readBoolean(response, "hosting");
  if(proxy === undefined || hosting === undefined)
    throw new Error("IP info response is missing classification flags");

  return {
    status,
    ip: requireResponseSubject(response, expectedIp),
    country: readString(response, "country"),
    countryCode: readString(response, "countryCode"),
    region: readString(response, "regionName"),
    regionCode: readString(response, "region"),
    city: readString(response, "city"),
    cityCode: readString(response, "zip"),
    locLat: readNumber(response, "lat"),
    locLon: readNumber(response, "lon"),
    zone: readString(response, "timezone"),
    isp: readString(response, "isp"),
    org: readString(response, "org"),
    as: readString(response, "as"),
    proxy,
    hosting,
  };
}

function parseIpApiIsResponse(response: Record<string, unknown>, expectedIp: string): IIPInfo {
  let error = readString(response, "error");
  if(error)
    return { status: "error: " + error.slice(0, 200) };

  let proxyFlags = ["is_proxy", "is_vpn", "is_tor"].map((key) => readBoolean(response, key));
  let hosting = readBoolean(response, "is_datacenter");
  if(proxyFlags.some((flag) => flag === undefined) || hosting === undefined)
    throw new Error("IP info response is missing classification flags");

  let location = readRecord(response, "location");
  let company = readRecord(response, "company");
  let asn = readRecord(response, "asn");
  let asnNumber = readNumber(asn, "asn") ?? readNumber(response, "asn_num");
  let asnOrg = readString(asn, "org") ?? readString(response, "asn_org");
  let companyName = readString(company, "name") ?? readString(response, "company_name");
  let asInfo = asnNumber ? `AS${asnNumber}${asnOrg ? " " + asnOrg : ""}` : asnOrg;

  return {
    status: "success",
    ip: requireResponseSubject(response, expectedIp),
    country: readString(location, "country"),
    countryCode: readString(location, "country_code") ?? readString(response, "cc"),
    region: readString(location, "state"),
    city: readString(location, "city"),
    cityCode: readString(location, "zip"),
    locLat: readNumber(location, "latitude") ?? readNumber(response, "lat"),
    locLon: readNumber(location, "longitude") ?? readNumber(response, "lon"),
    zone: readString(location, "timezone"),
    isp: companyName ?? asnOrg,
    org: companyName ?? asnOrg,
    as: asInfo,
    proxy: proxyFlags.some((flag) => flag === true),
    hosting,
  };
}

function parseIPInfoResponse(response: unknown, expectedIp: string): IIPInfo {
  if(!isRecord(response))
    throw new Error("invalid IP info response");
  if(typeof response.status === "string")
    return parseLegacyIpApiResponse(response, expectedIp);
  return parseIpApiIsResponse(response, expectedIp);
}

interface ILookupContext {
  generation: number;
  api: string;
  cacheTime: number;
  signal: AbortSignal;
}

export interface IPInfoResolverOptions {
  maxProviderRequests?: number;
  providerWindowMs?: number;
  providerFailureThreshold?: number;
  initialProviderBackoffMs?: number;
  maxProviderBackoffMs?: number;
  now?: () => number;
}

export class IPInfoLookupInvalidatedError extends Error {
  public constructor() {
    super("IP info lookup was invalidated");
    this.name = "IPInfoLookupInvalidatedError";
  }
}

export class IPInfoResolver {
  private ipInfoDb: IPInfoDB;
  private ipInfoApi: string;
  private cacheTime: number;
  private ipInfoPromises = new Map<string, Promise<IIPInfo>>();
  private generation = 1;
  private generationController = new AbortController();
  private acceptingLookups = true;
  private ownedWork = new Set<Promise<unknown>>();
  private invalidatedCacheKeys = new Set<string>();
  private bypassAllCachedResults = false;
  private readonly maxProviderRequests: number;
  private readonly providerWindowMs: number;
  private readonly providerFailureThreshold: number;
  private readonly initialProviderBackoffMs: number;
  private readonly maxProviderBackoffMs: number;
  private readonly now: () => number;
  private providerRequestTimes: number[] = [];
  private providerFailureCount = 0;
  private providerBackoffUntil = 0;

  public constructor(ipInfoDb: IPInfoDB, api: string, cacheTime: number, options: IPInfoResolverOptions = {}) {
    this.ipInfoDb = ipInfoDb;
    this.ipInfoApi = api;
    this.cacheTime = cacheTime;
    this.maxProviderRequests = this.requirePositiveInteger(
      options.maxProviderRequests ?? DEFAULT_MAX_PROVIDER_REQUESTS,
      "IP info provider request limit",
    );
    this.providerWindowMs = this.requirePositiveInteger(
      options.providerWindowMs ?? DEFAULT_PROVIDER_WINDOW_MS,
      "IP info provider request window",
    );
    this.providerFailureThreshold = this.requirePositiveInteger(
      options.providerFailureThreshold ?? DEFAULT_PROVIDER_FAILURE_THRESHOLD,
      "IP info provider failure threshold",
    );
    this.initialProviderBackoffMs = this.requirePositiveInteger(
      options.initialProviderBackoffMs ?? DEFAULT_INITIAL_PROVIDER_BACKOFF_MS,
      "IP info initial provider backoff",
    );
    this.maxProviderBackoffMs = this.requirePositiveInteger(
      options.maxProviderBackoffMs ?? DEFAULT_MAX_PROVIDER_BACKOFF_MS,
      "IP info maximum provider backoff",
    );
    if(this.maxProviderBackoffMs < this.initialProviderBackoffMs)
      throw new Error("IP info maximum provider backoff must not be shorter than the initial backoff");
    this.now = options.now ?? (() => Date.now());
  }

  public getInflightCount(): number {
    return this.ipInfoPromises.size;
  }

  public getIpInfo(ipAddr: string): Promise<IIPInfo> {
    let normalizedIp = normalizeIpAddress(ipAddr);
    if(!normalizedIp)
      return Promise.resolve({status: "error: invalid IP address"});

    let pending = this.ipInfoPromises.get(normalizedIp);
    if(pending)
      return pending;
    if(this.ipInfoPromises.size >= MAX_CONCURRENT_IP_INFO_LOOKUPS)
      return Promise.resolve({status: "error: IP info lookup capacity reached"});

    let context = this.createLookupContext();
    let promise: Promise<IIPInfo>;
    promise = this.resolveIpInfo(normalizedIp, context).finally(() => {
      if(this.ipInfoPromises.get(normalizedIp) === promise)
        this.ipInfoPromises.delete(normalizedIp);
    });
    this.ipInfoPromises.set(normalizedIp, promise);
    this.trackWork(promise);
    return promise;
  }

  private async resolveIpInfo(ipAddr: string, context: ILookupContext): Promise<IIPInfo> {
    if(!this.bypassAllCachedResults && !this.invalidatedCacheKeys.has(ipAddr)) {
      let cachedIpInfo = await this.ipInfoDb.getIPInfo(ipAddr);
      this.assertCurrent(context);
      if(cachedIpInfo)
        return cachedIpInfo;
    }

    let ipApiUrl = context.api.replace(/{ip}/, encodeURIComponent(ipAddr));
    let providerRequestStarted = false;
    try {
      this.admitProviderRequest();
      providerRequestStarted = true;
      let rsp = await FetchUtil.fetchWithTimeout(ipApiUrl, {
        redirect: "error",
        signal: context.signal,
        size: IP_INFO_RESPONSE_LIMIT,
      }, IP_INFO_REQUEST_TIMEOUT_MS);
      if(typeof rsp.status === "number" && rsp.status !== 200)
        throw new Error("IP info provider returned HTTP " + rsp.status);
      let responseJson: unknown = await rsp.json();
      this.assertCurrent(context);
      let ipInfo = parseIPInfoResponse(responseJson, ipAddr);
      if(ipInfo.status === "success") {
        this.recordProviderSuccess();
        providerRequestStarted = false;
        await this.ipInfoDb.setIPInfo(ipAddr, ipInfo, context.cacheTime);
      } else {
        this.recordProviderFailure();
        providerRequestStarted = false;
      }
      this.assertCurrent(context);
      if(ipInfo.status === "success")
        this.invalidatedCacheKeys.delete(ipAddr);
      return ipInfo;
    } catch(err) {
      this.assertCurrent(context);
      if(providerRequestStarted)
        this.recordProviderFailure();
      return {
        status: "error" + (err ? ": " + err.toString() : ""),
      };
    }
  }

  private createLookupContext(): ILookupContext {
    if(!this.acceptingLookups || this.generationController.signal.aborted)
      throw new IPInfoLookupInvalidatedError();
    return {
      generation: this.generation,
      api: this.ipInfoApi,
      cacheTime: this.cacheTime,
      signal: this.generationController.signal,
    };
  }

  private assertCurrent(context: ILookupContext): void {
    if(
      !this.acceptingLookups ||
      context.generation !== this.generation ||
      context.signal.aborted
    )
      throw new IPInfoLookupInvalidatedError();
  }

  private trackWork<T>(promise: Promise<T>): void {
    this.ownedWork.add(promise);
    promise.then(
      () => this.ownedWork.delete(promise),
      () => this.ownedWork.delete(promise),
    );
  }

  private requirePositiveInteger(value: number, name: string): number {
    if(!Number.isSafeInteger(value) || value < 1)
      throw new Error(name + " must be a positive integer");
    return value;
  }

  private currentTimeMs(): number {
    let now = this.now();
    if(!Number.isSafeInteger(now) || now < 0)
      throw new Error("IP info provider clock returned an invalid timestamp");
    return now;
  }

  private admitProviderRequest(): void {
    let now = this.currentTimeMs();
    if(now < this.providerBackoffUntil)
      throw new Error("IP info provider backoff active");

    let cutoff = now - this.providerWindowMs;
    this.providerRequestTimes = this.providerRequestTimes.filter((requestTime) => requestTime > cutoff);
    if(this.providerRequestTimes.length >= this.maxProviderRequests)
      throw new Error("IP info provider request budget reached");
    this.providerRequestTimes.push(now);
  }

  private recordProviderFailure(): void {
    let now = this.currentTimeMs();
    this.providerFailureCount++;
    if(this.providerFailureCount < this.providerFailureThreshold)
      return;
    let exponent = Math.min(this.providerFailureCount - this.providerFailureThreshold, 30);
    let delay = Math.min(
      this.initialProviderBackoffMs * (2 ** exponent),
      this.maxProviderBackoffMs,
    );
    this.providerBackoffUntil = Math.max(this.providerBackoffUntil, now + delay);
  }

  private recordProviderSuccess(): void {
    this.providerFailureCount = 0;
    this.providerBackoffUntil = 0;
  }

  private resetProviderProtection(): void {
    this.providerRequestTimes = [];
    this.providerFailureCount = 0;
    this.providerBackoffUntil = 0;
  }

  private rememberInvalidatedCacheKey(ipAddr: string): void {
    if(this.bypassAllCachedResults)
      return;
    if(this.invalidatedCacheKeys.size >= MAX_INVALIDATED_CACHE_KEYS) {
      this.invalidatedCacheKeys.clear();
      this.bypassAllCachedResults = true;
      return;
    }
    this.invalidatedCacheKeys.add(ipAddr);
  }

  private async rotateGeneration(api: string, cacheTime: number, acceptingLookups: boolean): Promise<void> {
    let oldController = this.generationController;
    let workToDrain = [...this.ownedWork];
    for(let ipAddr of this.ipInfoPromises.keys())
      this.rememberInvalidatedCacheKey(ipAddr);

    this.generation++;
    this.acceptingLookups = false;
    this.ipInfoPromises.clear();
    oldController.abort();

    await Promise.allSettled(workToDrain);
    this.ipInfoApi = api;
    this.cacheTime = cacheTime;
    this.resetProviderProtection();
    this.generationController = new AbortController();
    this.acceptingLookups = acceptingLookups;
  }

  public async reload(api: string, cacheTime: number): Promise<void> {
    await this.rotateGeneration(api, cacheTime, true);
  }

  public async stop(): Promise<void> {
    await this.rotateGeneration(this.ipInfoApi, this.cacheTime, false);
  }
}
