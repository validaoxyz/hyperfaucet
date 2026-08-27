import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'node:crypto';
import { FetchUtil } from '../../utils/FetchUtil.js';
import { resolveRelativePath } from '../../config/FaucetConfig.js';
import { FaucetProcess, FaucetLogLevel } from "../../common/FaucetProcess.js";
import { ServiceManager } from '../../common/ServiceManager.js';
import {
  MAX_PASSPORT_PROVIDER_LENGTH,
  parsePassportScoreUnits,
  passportScoreUnitsToNumber,
  type IPassportConfig,
  type PassportScoreUnits,
} from './PassportConfig.js';
import { PassportModule } from './PassportModule.js';
import type { PassportCacheEntry } from './PassportDB.js';
import {
  PassportDIDKitVerifier,
  PassportVerificationUnavailableError,
} from './PassportDIDKitVerifier.js';

type JsonObject = {[key: string]: unknown};

interface IPassportProof extends JsonObject {
  proofPurpose: string;
  verificationMethod: string;
}

const MAX_DID_LENGTH = 512;
const MAX_DATE_LENGTH = 64;
const MAX_TYPE_COUNT = 16;
const MAX_TYPE_LENGTH = 128;
const MAX_NULLIFIER_COUNT = 16;
const MAX_STAMP_HASH_LENGTH = 250;
const MAX_CREDENTIAL_BYTES = 32 * 1024;
const PASSPORT_REQUEST_TIMEOUT_MS = 20_000;
const TRANSIENT_ERROR_RECORD_SECONDS = 30;
const PASSPORT_TRUST_GENERATION_VERSION = 2;

export interface IPassport {
  issuanceDate: string | null;
  expiryDate: string | null;
  stamps: {
    provider: string;
    credential: IPassportCredential;
  }[];
}

export interface IPassportCredential {
  [key: string]: unknown;
  type: string[];
  proof: IPassportProof;
  issuer: string;
  issuanceDate: string;
  expirationDate: string;
  credentialSubject: {
    id: string;
    hash?: string;
    nullifiers?: string[];
    provider: string;
  };
}

export interface IPassportInfo {
  found: boolean;
  parsed: number;
  newest: number;
  stamps?: IPassportStampInfo[];
}

export interface IPassportStampInfo {
  provider: string;
  expiration: number;
  duplicate?: string;
}

export interface IPassportScore {
  score: number;
  factor: number;
}

export interface IPassportScoreCalculation {
  scoreUnits: PassportScoreUnits;
  score: IPassportScore;
}

export interface IPassportVerification {
  valid: boolean;
  errors: string[];
  code?: "PASSPORT_VALIDATION" | "PASSPORT_BUSY";
  newest?: number;
  passport?: IPassport;
}

export interface IPassportVerificationResult extends IPassportVerification {
  passportInfo?: IPassportInfo;
}

interface ILookupContext {
  generation: number;
  signal: AbortSignal;
  config: IPassportConfig;
  cacheGeneration: string;
  trustGeneration: string;
}

type PassportRefreshResult =
  | {kind: "success", passport: IPassport}
  | {kind: "empty"}
  | {kind: "error"};

export class PassportLookupCapacityError extends Error {
  public constructor() {
    super("Passport lookup capacity reached");
    this.name = "PassportLookupCapacityError";
  }
}

export class PassportLookupInvalidatedError extends Error {
  public constructor() {
    super("Passport lookup was invalidated");
    this.name = "PassportLookupInvalidatedError";
  }
}

export class PassportResolver {
  private module: PassportModule;
  private didkitVerifier: PassportDIDKitVerifier;
  private passportCache = new Map<string, Promise<IPassportInfo>>();
  private activeCacheLookups = 0;
  private activeAutomaticLookups = 0;
  private activeManualVerifications = 0;
  private generation = 1;
  private generationController = new AbortController();
  private cacheGeneration: string = randomUUID();
  private trustGeneration = "";
  private acceptingLookups = false;
  private ownedWork = new Set<Promise<unknown>>();
  private rotationTail: Promise<void> = Promise.resolve();

  public constructor(module: PassportModule) {
    this.module = module;
    this.didkitVerifier = this.createDIDKitVerifier(module.getModuleConfig());
  }

  public async start(): Promise<void> {
    let config = this.copyConfig(this.module.getModuleConfig());
    this.trustGeneration = this.getTrustGeneration(config);
    this.cacheGeneration = await this.module.getPassportDb().activateCacheGeneration(
      this.cacheGeneration,
      this.trustGeneration,
      false,
    );
    this.acceptingLookups = true;
  }

  private getVerifyTime(): number {
    return Math.floor((new Date()).getTime() / 1000);
  }

  private getStampHash(credentialSubject: IPassportCredential["credentialSubject"]): string {
    if(typeof credentialSubject.hash === "string" && credentialSubject.hash.length <= MAX_STAMP_HASH_LENGTH)
      return credentialSubject.hash;
    if(Array.isArray(credentialSubject.nullifiers)) {
      let nullifier = credentialSubject.nullifiers.find((value) => typeof value === "string" && value.length > 0 && value.length <= MAX_STAMP_HASH_LENGTH);
      if(nullifier)
        return nullifier;
    }
    return "";
  }

  private normalizeAddress(addr: string): string {
    if(typeof addr !== "string" || !addr.match(/^0x[0-9a-fA-F]{40}$/) || addr.match(/^0x0{40}$/i))
      throw new Error("invalid passport wallet address");
    return addr.toLowerCase();
  }

  private isJsonObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
    return typeof value === "string" && value.length <= maxLength && (allowEmpty || value.length > 0);
  }

  private isValidDate(value: unknown): value is string {
    return this.isBoundedString(value, MAX_DATE_LENGTH) && Number.isFinite(Date.parse(value));
  }

  private parseCredentialSubject(value: unknown): IPassportCredential["credentialSubject"] | null {
    if(!this.isJsonObject(value))
      return null;

    let id = value.id;
    let provider = value.provider;
    if(!this.isBoundedString(id, MAX_DID_LENGTH) || !this.isBoundedString(provider, MAX_PASSPORT_PROVIDER_LENGTH))
      return null;

    let hash: string | undefined;
    if(value.hash !== undefined) {
      if(!this.isBoundedString(value.hash, MAX_STAMP_HASH_LENGTH))
        return null;
      hash = value.hash;
    }

    let nullifiers: string[] | undefined;
    if(value.nullifiers !== undefined) {
      if(!Array.isArray(value.nullifiers) || value.nullifiers.length > MAX_NULLIFIER_COUNT)
        return null;
      nullifiers = [];
      for(let nullifier of value.nullifiers) {
        if(!this.isBoundedString(nullifier, MAX_STAMP_HASH_LENGTH))
          return null;
        nullifiers.push(nullifier);
      }
    }

    return {
      ...value,
      id: id,
      provider: provider,
      hash: hash,
      nullifiers: nullifiers,
    };
  }

  private parseCredential(value: unknown): IPassportCredential | null {
    if(!this.isJsonObject(value) || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_CREDENTIAL_BYTES)
      return null;

    if(!Array.isArray(value.type) || value.type.length === 0 || value.type.length > MAX_TYPE_COUNT)
      return null;
    let credentialTypes: string[] = [];
    for(let credentialType of value.type) {
      if(!this.isBoundedString(credentialType, MAX_TYPE_LENGTH))
        return null;
      credentialTypes.push(credentialType);
    }

    if(!this.isJsonObject(value.proof))
      return null;
    let proofPurpose = value.proof.proofPurpose;
    let verificationMethod = value.proof.verificationMethod;
    if(!this.isBoundedString(proofPurpose, MAX_TYPE_LENGTH) || !this.isBoundedString(verificationMethod, MAX_DID_LENGTH))
      return null;

    let issuer = value.issuer;
    let issuanceDate = value.issuanceDate;
    let expirationDate = value.expirationDate;
    if(!this.isBoundedString(issuer, MAX_DID_LENGTH) || !this.isValidDate(issuanceDate) || !this.isValidDate(expirationDate))
      return null;

    let credentialSubject = this.parseCredentialSubject(value.credentialSubject);
    if(!credentialSubject)
      return null;

    return {
      ...value,
      type: credentialTypes,
      proof: {
        ...value.proof,
        proofPurpose: proofPurpose,
        verificationMethod: verificationMethod,
      },
      issuer: issuer,
      issuanceDate: issuanceDate,
      expirationDate: expirationDate,
      credentialSubject: credentialSubject,
    };
  }

  private parsePassportStamp(value: unknown): IPassport["stamps"][number] | null {
    if(!this.isJsonObject(value) || !this.isBoundedString(value.provider, MAX_PASSPORT_PROVIDER_LENGTH))
      return null;
    let credential = this.parseCredential(value.credential);
    if(!credential)
      return null;
    return {
      provider: value.provider,
      credential: credential,
    };
  }

  private parsePassportJson(passportJson: string, config: IPassportConfig): IPassport | null {
    if(typeof passportJson !== "string" || Buffer.byteLength(passportJson, "utf8") > config.maxPassportBytes)
      return null;

    let value: unknown;
    try {
      value = JSON.parse(passportJson);
    } catch(ex) {
      return null;
    }
    if(!this.isJsonObject(value) || !Array.isArray(value.stamps))
      return null;
    if(value.stamps.length > config.maxPassportStamps)
      return null;
    if(value.issuanceDate !== null && value.issuanceDate !== undefined && !this.isBoundedString(value.issuanceDate, MAX_DATE_LENGTH))
      return null;
    if(value.expiryDate !== null && value.expiryDate !== undefined && !this.isBoundedString(value.expiryDate, MAX_DATE_LENGTH))
      return null;

    let stamps: IPassport["stamps"] = [];
    for(let stampValue of value.stamps) {
      let stamp = this.parsePassportStamp(stampValue);
      if(!stamp)
        return null;
      stamps.push(stamp);
    }

    return {
      issuanceDate: typeof value.issuanceDate === "string" ? value.issuanceDate : null,
      expiryDate: typeof value.expiryDate === "string" ? value.expiryDate : null,
      stamps: stamps,
    };
  }

  private isCredentialBoundToAddress(credential: IPassportCredential, addr: string, config: IPassportConfig): boolean {
    let expectedSubject = "did:pkh:eip155:1:" + addr;
    let verificationMethod = credential.proof.verificationMethod;
    return credential.credentialSubject.id.toLowerCase() === expectedSubject.toLowerCase()
      && config.trustedIssuers.includes(credential.issuer)
      && credential.proof.proofPurpose === "assertionMethod"
      && (verificationMethod === credential.issuer || verificationMethod.startsWith(credential.issuer + "#"));
  }

  private parseScorerPassport(response: unknown, addr: string, config: IPassportConfig): IPassport | null {
    if(!this.isJsonObject(response) || !Array.isArray(response.items))
      throw new Error("invalid passport scorer response");
    if(response.items.length > config.maxPassportStamps)
      throw new Error("passport response exceeds the configured stamp limit");
    if(response.items.length === 0)
      return null;

    let providers = new Set<string>();
    let stamps: IPassport["stamps"] = [];
    for(let item of response.items) {
      if(!this.isJsonObject(item))
        throw new Error("invalid passport scorer item");
      let credential = this.parseCredential(item.credential);
      if(!credential || !this.isCredentialBoundToAddress(credential, addr, config) || !this.getStampHash(credential.credentialSubject))
        throw new Error("passport scorer credential is not bound to the requested wallet");

      let provider = credential.credentialSubject.provider;
      if(item.provider !== undefined && item.provider !== provider)
        throw new Error("passport scorer provider does not match the credential");
      let normalizedProvider = provider.toLowerCase();
      if(providers.has(normalizedProvider))
        throw new Error("passport scorer response contains a duplicate provider");
      providers.add(normalizedProvider);
      stamps.push({provider, credential});
    }

    return {
      issuanceDate: null,
      expiryDate: null,
      stamps,
    };
  }

  private isPassportBoundToAddress(passport: IPassport, addr: string, config: IPassportConfig): boolean {
    let providers = new Set<string>();
    for(let stamp of passport.stamps) {
      let normalizedProvider = stamp.provider.toLowerCase();
      if(
        stamp.provider !== stamp.credential.credentialSubject.provider ||
        providers.has(normalizedProvider) ||
        !this.getStampHash(stamp.credential.credentialSubject) ||
        !this.isCredentialBoundToAddress(stamp.credential, addr, config)
      )
        return false;
      providers.add(normalizedProvider);
    }
    return true;
  }

  public getCachedPassport(addr: string): Promise<IPassportInfo> {
    let normalizedAddress = this.normalizeAddress(addr);
    let context = this.createLookupContext();
    let cacheLookup = this.startCacheLookup(normalizedAddress, context);
    if(!cacheLookup)
      return Promise.reject(new PassportLookupCapacityError());
    let work = cacheLookup.then((cacheEntry) => {
      this.assertCurrent(context);
      return cacheEntry && cacheEntry.kind !== "error" ? cacheEntry.info : null;
    });
    this.trackWork(work);
    return work;
  }

  public getPassport(addr: string, refresh?: boolean, admitScorerLookup?: () => boolean): Promise<IPassportInfo> {
    let normalizedAddress = this.normalizeAddress(addr);
    let pending = this.passportCache.get(normalizedAddress);
    if(pending)
      return pending;
    let context = this.createLookupContext();
    let cacheLookup = this.startCacheLookup(normalizedAddress, context);
    if(!cacheLookup)
      return Promise.reject(new PassportLookupCapacityError());

    let passportInfoPromise: Promise<IPassportInfo>;
    passportInfoPromise = this.resolvePassport(
      normalizedAddress,
      !!refresh,
      context,
      cacheLookup,
      admitScorerLookup,
    ).finally(() => {
      if(this.passportCache.get(normalizedAddress) === passportInfoPromise)
        this.passportCache.delete(normalizedAddress);
    });
    this.passportCache.set(normalizedAddress, passportInfoPromise);
    this.trackWork(passportInfoPromise);

    return passportInfoPromise;
  }

  private async resolvePassport(
    addr: string,
    refresh: boolean,
    context: ILookupContext,
    cacheLookup: Promise<PassportCacheEntry | null>,
    admitScorerLookup?: () => boolean,
  ): Promise<IPassportInfo> {
    let cacheEntry = await cacheLookup;
    this.assertCurrent(context);
    let now = Math.floor(Date.now() / 1000);
    if(cacheEntry && cacheEntry.kind !== "error" && !refresh && cacheEntry.info.parsed > now - context.config.cacheTime)
      return cacheEntry.info;

    if(this.activeAutomaticLookups >= context.config.automaticLookupConcurrency)
      throw new PassportLookupCapacityError();
    if(admitScorerLookup && !admitScorerLookup())
      throw new PassportLookupCapacityError();

    this.activeAutomaticLookups++;
    try {
      let refreshResult = await this.refreshPassport(addr, undefined, context);
      this.assertCurrent(context);
      return await this.buildPassportInfo(addr, refreshResult, context);
    } finally {
      this.activeAutomaticLookups--;
    }
  }

  public verifyUserPassport(addr: string, passportJson: string): Promise<IPassportVerificationResult> {
    let normalizedAddress = this.normalizeAddress(addr);
    let context = this.createLookupContext();
    let work = this.verifyUserPassportForContext(normalizedAddress, passportJson, context);
    this.trackWork(work);
    return work;
  }

  private async verifyUserPassportForContext(addr: string, passportJson: string, context: ILookupContext): Promise<IPassportVerificationResult> {
    if(context.config.trustedIssuers.length === 0)
      return {valid: false, errors: ["Manual passport verification disabled"]};

    let maxConcurrency = context.config.manualVerificationConcurrency;
    if(this.activeManualVerifications >= maxConcurrency)
      return {valid: false, code: "PASSPORT_BUSY", errors: ["Passport verification is busy. Please try again shortly."]};

    this.activeManualVerifications++;
    try {
      let passport = this.parsePassportJson(passportJson, context.config);
      if(!passport)
        return {valid: false, errors: ["Invalid Passport JSON! Please copy your passport JSON from https://passport.gitcoin.co"]};
      if(passport.stamps.length === 0)
        return {valid: false, errors: ["Passport must contain at least one stamp"]};

      let verifyResult = await this.verifyPassportIntegrity(addr, passport, context);
      this.assertCurrent(context);
      if(!verifyResult.valid || !verifyResult.passport)
        return verifyResult;

      let refreshResult = await this.refreshPassport(addr, verifyResult.passport, context);
      this.assertCurrent(context);
      if(refreshResult.kind !== "success" || refreshResult.passport !== verifyResult.passport)
        return {valid: false, errors: ["Cannot update to an older passport"]};

      return {
        ...verifyResult,
        passportInfo: await this.buildPassportInfo(addr, refreshResult, context)
      };
    } finally {
      this.activeManualVerifications--;
    }
  }

  private getNewestPassportStampTime(passport: IPassport): number {
    let newest = 0;
    if(passport.stamps) {
      for(let i = 0; i < passport.stamps.length; i++) {
        let issuanceTime = Math.floor((new Date(passport.stamps[i].credential.issuanceDate)).getTime() / 1000);
        if(issuanceTime > newest) {
          newest = issuanceTime;
        }
      }
    }
    return newest;
  }

  private async refreshPassport(addr: string, passport: IPassport | undefined, context: ILookupContext): Promise<PassportRefreshResult> {
    let cacheFile = this.getPassportCacheFile(addr, context.config.cachePath);
    let cachedPassport: IPassport = null;
    if(cacheFile && fs.existsSync(cacheFile)) {
      try {
        let parsedCache = this.parsePassportJson(fs.readFileSync(cacheFile, "utf8"), context.config);
        if(parsedCache && this.isPassportBoundToAddress(parsedCache, addr, context.config))
          cachedPassport = parsedCache;
      } catch(ex) {
        ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.WARNING, "Ignoring invalid passport cache for " + addr);
      }
    }
    try {
      if(!passport) {
        let rsp = await FetchUtil.fetchWithTimeout("https://api.scorer.gitcoin.co/registry/stamps/" + addr, {
          method: 'GET',
          headers: context.config.scorerApiKey ? {'X-API-KEY': context.config.scorerApiKey} : {},
          redirect: "error",
          signal: context.signal,
          size: context.config.maxPassportBytes,
        }, PASSPORT_REQUEST_TIMEOUT_MS);
        if(typeof rsp.status === "number" && rsp.status !== 200)
          throw new Error("passport scorer returned HTTP " + rsp.status);
        let responseJson: unknown = await rsp.json();
        this.assertCurrent(context);
        passport = this.parseScorerPassport(responseJson, addr, context.config);
        ServiceManager.GetService(FaucetProcess).emitLog(
          FaucetLogLevel.INFO,
          "Requested Gitcoin Passport for " + addr + ": " + (passport ? "got " + passport.stamps.length + " stamps" : "no passport"),
        );
      }
      if(passport) {
        if(!this.isPassportBoundToAddress(passport, addr, context.config))
          throw new Error("passport is not bound to the requested wallet");
        if(cachedPassport && this.getNewestPassportStampTime(cachedPassport) > this.getNewestPassportStampTime(passport)) {
          // passport from cache is newer.. so use the cached one
          return {kind: "success", passport: cachedPassport};
        }
        if(cacheFile) {
          // save to cache
          this.assertCurrent(context);
          this.savePassportToCache(passport, cacheFile);
        }
      }
      if(passport)
        return {kind: "success", passport};
      if(cachedPassport)
        return {kind: "success", passport: cachedPassport};
      return {kind: "empty"};
    } catch(ex) {
      this.assertCurrent(context);
      let detail = ex instanceof Error ? ex.message : String(ex);
      detail = detail.replace(/[\r\n\t]+/g, " ").slice(0, 256);
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.WARNING, "Exception while fetching passport: " + detail);
      return cachedPassport ? {kind: "success", passport: cachedPassport} : {kind: "error"};
    }
  }

  private async verifyPassportIntegrity(addr: string, passport: IPassport, context: ILookupContext): Promise<IPassportVerification> {
    this.assertCurrent(context);

    let verifyResult: IPassportVerification = {
      valid: null,
      errors: [],
      newest: 0,
    }
    let providers = new Set<string>();

    for(let stamp of passport.stamps) {
      this.assertCurrent(context);
      let issuanceTime = Math.floor((new Date(stamp.credential.issuanceDate)).getTime() / 1000);
      if(issuanceTime > verifyResult.newest) {
        verifyResult.newest = issuanceTime;
      }

      // verify stamp provider
      if(stamp.provider !== stamp.credential.credentialSubject.provider) {
        verifyResult.errors.push("Stamp '" + stamp.provider + "' invalid: stamp provider doesn't match credentialSubject.provider (don't play around with the JSON!!!)");
        continue;
      }

      // verify provider uniqueness
      let normalizedProvider = stamp.provider.toLowerCase();
      if(providers.has(normalizedProvider)) {
        verifyResult.errors.push("Stamp '" + stamp.provider + "' invalid: duplicate provider (don't play around with the JSON!!!)");
        continue;
      }
      providers.add(normalizedProvider);

      // verify the stamp subject address
      let subjectPrefix = "did:pkh:eip155:1:";
      let subjectId = stamp.credential.credentialSubject.id;
      let stampAddress = subjectId.startsWith(subjectPrefix) ? subjectId.substring(subjectPrefix.length).toLowerCase() : "";
      if(stampAddress !== addr.toLowerCase()) {
        verifyResult.errors.push("Stamp '" + stamp.provider + "' invalid: not signed for expected wallet (signed for " + stampAddress + ")");
        continue;
      }

      // verify stamp issuer
      if(context.config.trustedIssuers.indexOf(stamp.credential.issuer) === -1) {
        verifyResult.errors.push("Stamp '" + stamp.provider + "' invalid: issuer not trusted");
        continue;
      }

      if(
        stamp.credential.proof.verificationMethod !== stamp.credential.issuer &&
        !stamp.credential.proof.verificationMethod.startsWith(stamp.credential.issuer + "#")
      ) {
        verifyResult.errors.push("Stamp '" + stamp.provider + "' invalid: invalid proof verificationMethod");
        continue;
      }
      if(stamp.credential.proof.proofPurpose !== "assertionMethod") {
        verifyResult.errors.push("Stamp '" + stamp.provider + "' invalid: invalid proof purpose");
        continue;
      }
      if(!this.getStampHash(stamp.credential.credentialSubject)) {
        verifyResult.errors.push("Stamp '" + stamp.provider + "' invalid: missing stamp hash");
        continue;
      }

      // verify expiration date
      let expirationTime = Math.floor((new Date(stamp.credential.expirationDate)).getTime() / 1000);
      if(expirationTime <= this.getVerifyTime()) {
        verifyResult.errors.push("Stamp '" + stamp.provider + "' invalid: stamp expired")
        continue;
      }

      try {
        let verifyResJson = await this.didkitVerifier.verifyCredential(JSON.stringify(stamp.credential), JSON.stringify({
          proofPurpose: stamp.credential.proof.proofPurpose
        }));
        this.assertCurrent(context);
        let verifyRes: unknown = JSON.parse(verifyResJson);
        if(!this.isJsonObject(verifyRes) || !Array.isArray(verifyRes.checks) || !verifyRes.checks.includes("proof")) {
          verifyResult.errors.push("Stamp '" + stamp.provider + "' invalid: proof check failed");
          continue;
        }
        if(Array.isArray(verifyRes.errors) && verifyRes.errors.length > 0) {
          verifyResult.errors.push("Stamp '" + stamp.provider + "' invalid: integrity check failed");
        }
      } catch(ex) {
        if(ex instanceof PassportVerificationUnavailableError)
          throw ex;
        verifyResult.errors.push("Stamp '" + stamp.provider + "' invalid: proof verification failed");
      }
    }

    verifyResult.valid = (verifyResult.errors.length === 0);
    verifyResult.passport = passport;
    //console.log("[PassportVerifier] verify info ", verifyResult.info);
    
    return verifyResult;
  }

  private getPassportCacheFile(addr: string, cachePath: string): string {
    if(!cachePath)
      return null;
    return path.join(resolveRelativePath(cachePath), "passport-" + addr.replace(/[^a-f0-9x]+/gi, "").toLowerCase() + ".json");
  }

  private savePassportToCache(passport: IPassport, cacheFile: string) {
    let trimmedPassport: IPassport = {
      issuanceDate: passport.issuanceDate,
      expiryDate: passport.expiryDate,
      stamps: passport.stamps.map((stamp) => {
        return {
          provider: stamp.provider,
          credential: stamp.credential
        }
      })
    };
    fs.writeFileSync(cacheFile, JSON.stringify(trimmedPassport));
  }

  private async buildPassportInfo(addr: string, refreshResult: PassportRefreshResult, context: ILookupContext): Promise<IPassportInfo> {
    let passportInfo: IPassportInfo;
    let now = Math.floor((new Date()).getTime() / 1000);
    let normalizedAddress = this.normalizeAddress(addr);
    let ownershipExpiry: number | null = null;

    if(refreshResult.kind === "success") {
      let passport = refreshResult.passport;
      let passportStamps = passport.stamps.slice(0, context.config.maxPassportStamps);
      let stampHashes = Array.from(new Set(passportStamps
        .map((stamp) => this.getStampHash(stamp.credential.credentialSubject))
        .filter((stampHash) => stampHash.length > 0)));
      let stampAssignments = await this.module.getPassportDb().claimPassportStampsWithExpiry(
        stampHashes,
        normalizedAddress,
        context.config.stampDeduplicationTime,
      );
      this.assertCurrent(context);
      
      let newestStamp = 0;
      let stamps: IPassportStampInfo[] = [];
      for(let stamp of passportStamps) {
        let stampHash = this.getStampHash(stamp.credential.credentialSubject);
        let assignment = stampAssignments[stampHash];
        if(!assignment?.address || assignment.expiresAt === null)
          throw new Error("passport stamp ownership could not be established");
        ownershipExpiry = ownershipExpiry === null
          ? assignment.expiresAt
          : Math.min(ownershipExpiry, assignment.expiresAt);

        let issuanceTime = Math.floor((new Date(stamp.credential.issuanceDate)).getTime() / 1000);
        if(issuanceTime > newestStamp)
          newestStamp = issuanceTime;
        
        let expirationTime = Math.floor((new Date(stamp.credential.expirationDate)).getTime() / 1000);
        let stampInfo: IPassportStampInfo = {
          provider: stamp.provider,
          expiration: expirationTime,
        };

        // check duplicate use
        let assignedAddr = assignment.address;
        if(assignedAddr && assignedAddr !== normalizedAddress)
          stampInfo.duplicate = assignedAddr;

        stamps.push(stampInfo);
      }

      passportInfo = {
        found: true,
        parsed: now,
        newest: newestStamp,
        stamps: stamps,
      };
    }
    else {
      passportInfo = {
        found: false,
        parsed: now,
        newest: 0,
      };
    }

    this.assertCurrent(context);
    let cacheStored = await this.module.getPassportDb().setPassportInfo({
      address: normalizedAddress,
      outcome: refreshResult.kind,
      info: passportInfo,
      duration: refreshResult.kind === "error"
        ? Math.min(context.config.cacheTime, TRANSIENT_ERROR_RECORD_SECONDS)
        : context.config.cacheTime,
      cacheGeneration: context.cacheGeneration,
      trustGeneration: context.trustGeneration,
      ownershipExpiry,
    });
    this.assertCurrent(context);
    if(!cacheStored)
      throw new Error("passport cache write was rejected");

    return passportInfo;
  }

  private createLookupContext(): ILookupContext {
    if(!this.acceptingLookups || this.generationController.signal.aborted)
      throw new PassportLookupInvalidatedError();
    let moduleConfig = this.module.getModuleConfig();
    return {
      generation: this.generation,
      signal: this.generationController.signal,
      config: this.copyConfig(moduleConfig),
      cacheGeneration: this.cacheGeneration,
      trustGeneration: this.trustGeneration,
    };
  }

  private assertCurrent(context: ILookupContext): void {
    if(
      !this.acceptingLookups ||
      context.generation !== this.generation ||
      context.signal.aborted
    )
      throw new PassportLookupInvalidatedError();
  }

  private startCacheLookup(addr: string, context: ILookupContext): Promise<PassportCacheEntry | null> | null {
    if(this.activeCacheLookups >= context.config.cacheLookupConcurrency)
      return null;
    this.activeCacheLookups++;

    let lookup: Promise<PassportCacheEntry | null>;
    try {
      lookup = this.module.getPassportDb().getPassportInfo(
        addr,
        context.cacheGeneration,
        context.trustGeneration,
      );
    } catch(error) {
      this.activeCacheLookups--;
      throw error;
    }
    let physicalWork = lookup.finally(() => {
      this.activeCacheLookups--;
    });
    this.trackWork(physicalWork);
    return physicalWork;
  }

  private trackWork<T>(promise: Promise<T>): void {
    this.ownedWork.add(promise);
    promise.then(
      () => this.ownedWork.delete(promise),
      () => this.ownedWork.delete(promise),
    );
  }

  private rotateGeneration(acceptingLookups: boolean): Promise<void> {
    let rotation = this.rotationTail.then(() => this.performGenerationRotation(acceptingLookups));
    this.rotationTail = rotation.catch(() => undefined);
    return rotation;
  }

  private async performGenerationRotation(acceptingLookups: boolean): Promise<void> {
    let oldController = this.generationController;
    let oldVerifier = this.didkitVerifier;
    let nextConfig = this.copyConfig(this.module.getModuleConfig());
    let nextCacheGeneration = randomUUID();
    let nextTrustGeneration = this.getTrustGeneration(nextConfig);

    this.acceptingLookups = false;
    this.passportCache.clear();
    oldController.abort();

    let workToDrain = [...this.ownedWork];
    let drainResults = await Promise.allSettled([
      oldVerifier.stop(),
      ...workToDrain,
    ]);
    for(let work of workToDrain)
      this.ownedWork.delete(work);
    let verifierDrain = drainResults[0];
    if(verifierDrain.status === "rejected")
      throw verifierDrain.reason;

    let publishedCacheGeneration = await this.module.getPassportDb().activateCacheGeneration(
      nextCacheGeneration,
      nextTrustGeneration,
      acceptingLookups,
    );
    this.generation++;
    this.cacheGeneration = publishedCacheGeneration;
    this.trustGeneration = nextTrustGeneration;
    this.generationController = new AbortController();
    if(acceptingLookups)
      this.didkitVerifier = this.createDIDKitVerifier(nextConfig);
    this.acceptingLookups = acceptingLookups;
  }

  public async reload(): Promise<void> {
    await this.rotateGeneration(true);
  }

  public async stop(): Promise<void> {
    await this.rotateGeneration(false);
  }

  private createDIDKitVerifier(config: IPassportConfig): PassportDIDKitVerifier {
    return new PassportDIDKitVerifier({
      verifyTimeoutMs: config.manualVerificationTimeout * 1000,
      maxPendingVerifications: config.manualVerificationConcurrency,
    });
  }

  private copyConfig(config: IPassportConfig): IPassportConfig {
    return {
      ...config,
      trustedIssuers: [...config.trustedIssuers],
      stampScoring: {...config.stampScoring},
      boostFactor: {...config.boostFactor},
    };
  }

  private getTrustGeneration(config: IPassportConfig): string {
    return createHash("sha256").update(JSON.stringify({
      version: PASSPORT_TRUST_GENERATION_VERSION,
      trustedIssuers: [...config.trustedIssuers].sort(),
      maxPassportBytes: config.maxPassportBytes,
      maxPassportStamps: config.maxPassportStamps,
      stampDeduplicationTime: config.stampDeduplicationTime,
    })).digest("hex");
  }


  public getPassportScoreCalculation(passportInfo: IPassportInfo): IPassportScoreCalculation {
    if(!passportInfo)
      return null;
    let passportConfig = this.module.getModuleConfig();

    let now = this.getVerifyTime();
    let totalScoreUnits = 0;
    if(passportInfo.found && passportInfo.stamps) {
      passportInfo.stamps.slice(0, passportConfig.maxPassportStamps).forEach((stamp) => {
        if(stamp.expiration <= now)
          return;
        if(stamp.duplicate)
          return;

        let stampScore = passportConfig.stampScoring[stamp.provider];
        if(typeof stampScore === "number") {
          let stampScoreUnits = parsePassportScoreUnits(stampScore);
          if(stampScoreUnits === null)
            throw new Error("passport.stampScoring contains an invalid score");
          totalScoreUnits += stampScoreUnits;
          if(!Number.isSafeInteger(totalScoreUnits))
            throw new Error("passport score exceeds the safe fixed-point range");
        }
      });
    }

    let boostFactor = 1;
    Object.entries(passportConfig.boostFactor).forEach(([minScore, factor]) => {
      let minScoreUnits = parsePassportScoreUnits(minScore);
      if(minScoreUnits === null)
        throw new Error("passport.boostFactor contains an invalid score tier");
      if(totalScoreUnits >= minScoreUnits) {
        if(factor > boostFactor) {
          boostFactor = factor;
        }
      }
    });

    let scoreUnits = totalScoreUnits as PassportScoreUnits;
    return {
      scoreUnits,
      score: {
        score: passportScoreUnitsToNumber(scoreUnits),
        factor: boostFactor,
      },
    };
  }

  public getPassportScore(passportInfo: IPassportInfo): IPassportScore {
    return this.getPassportScoreCalculation(passportInfo)?.score ?? null;
  }
}
