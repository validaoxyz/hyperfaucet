import { randomBytes } from "node:crypto";

import type { AuthCallbackContext } from "../../webserv/AuthCallbackPage.js";
import { sha256 } from "../../utils/CryptoUtils.js";
import { normalizeIpAddress } from "../../utils/IPAddress.js";
import type { IZupassConfig } from "./ZupassConfig.js";
import { BABY_JUB_NEGATIVE_ONE, generateSnarkMessageHash, uuidToBigInt } from "./ZupassUtils.js";

const CHALLENGE_ID_PATTERN = /^[0-9a-f]{64}$/;
const POLICY_ID_PATTERN = /^[0-9a-f]{64}$/;
const SIGNER_COORDINATE_PATTERN = /^(?:0x)?[0-9a-fA-F]{1,128}$/;
const MAX_SECURITY_LABEL_LENGTH = 1024;
const MAX_TOKEN_FIELD_LENGTH = 512;
const MAX_CHALLENGE_LIFETIME_SECONDS = 15 * 60;
const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
const DEFAULT_MAX_PENDING_CHALLENGES = 4096;
const DEFAULT_MAX_PENDING_CHALLENGES_PER_OWNER = 8;
const DEFAULT_MAX_CHALLENGE_ISSUES_PER_OWNER = 16;
const DEFAULT_MAX_CHALLENGE_CALLBACKS_PER_OWNER = 16;
const DEFAULT_MAX_CHALLENGE_RATE_OWNERS = 4096;
const DEFAULT_CHALLENGE_RATE_WINDOW_SECONDS = 5 * 60;
const MAX_CHALLENGE_RATE_WINDOW_SECONDS = 60 * 60;

export interface ZupassTicketIdentity {
  ticketId: string;
  productId: string;
  eventId: string;
  attendeeId: string;
}

interface ZupassVerifierPolicyDescriptor {
  kind: "zupass-verifier-policy";
  version: 1;
  watermarkDomain: string;
  externalNullifier: string;
  signer: readonly string[] | null;
  productIds: readonly string[];
  eventIds: readonly string[];
  challengeLifetimeSeconds: number;
  authTokenLifetimeSeconds: number;
}

export interface ZupassVerifierPolicy extends ZupassVerifierPolicyDescriptor {
  id: string;
}

export interface ZupassFaucetTokenPayload extends ZupassTicketIdentity {
  kind: "zupass";
  version: 1;
  policyId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface ZupassChallenge {
  id: string;
  watermark: string;
  issuedAt: number;
  expiresAt: number;
}

interface StoredZupassChallenge extends ZupassChallenge {
  policyId: string;
  context: ZupassChallengeContext;
  ownerIp: string;
}

type ZupassChallengeContext = Pick<
  AuthCallbackContext,
  "authState" | "callbackOrigin" | "clientOrigin"
>;

export type ZupassChallengeConsumption =
  | { kind: "accepted"; challenge: ZupassChallenge }
  | { kind: "rejected"; reason: "invalid" | "unknown" | "expired" | "context" | "policy" | "rate" };

interface ZupassChallengeStoreOptions {
  maxPending?: number;
  maxPendingPerOwner?: number;
  maxIssuesPerOwner?: number;
  maxCallbacksPerOwner?: number;
  maxRateOwners?: number;
  rateWindowSeconds?: number;
  now?: () => number;
  randomId?: () => string;
}

interface ZupassOwnerRateBudget {
  issueExpiries: number[];
  callbackExpiries: number[];
}

const TOKEN_PAYLOAD_KEYS = [
  "kind",
  "version",
  "ticketId",
  "productId",
  "eventId",
  "attendeeId",
  "policyId",
  "issuedAt",
  "expiresAt",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_FIELD_LENGTH;
}

function isUuid(value: unknown): value is string {
  if(!isBoundedString(value))
    return false;

  try {
    uuidToBigInt(value);
    return true;
  } catch {
    return false;
  }
}

function isSemaphoreId(value: unknown): value is string {
  if(!isBoundedString(value) || !/^(0|[1-9][0-9]*)$/.test(value))
    return false;

  return BigInt(value) <= BABY_JUB_NEGATIVE_ONE;
}

function requireLifetime(value: number, name: string, maximum: number): number {
  if(!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  return value;
}

function requireSecurityLabel(value: unknown, name: string): string {
  if(typeof value !== "string" || value.length === 0 || value.length > MAX_SECURITY_LABEL_LENGTH)
    throw new Error(`${name} must be a non-empty string of at most ${MAX_SECURITY_LABEL_LENGTH} characters.`);
  return value;
}

function normalizeUuidList(value: unknown, name: string): readonly string[] {
  if(!Array.isArray(value))
    throw new Error(`${name} must be an array.`);

  const normalized = value.map((entry) => {
    if(!isUuid(entry))
      throw new Error(`${name} contains an invalid UUID.`);
    return entry.toLowerCase();
  });
  return Object.freeze(Array.from(new Set(normalized)).sort());
}

export function normalizeZupassSigner(value: unknown): readonly string[] | null {
  if(value === undefined || value === null)
    return null;
  if(!Array.isArray(value) || value.length !== 2 || value.some((entry) => typeof entry !== "string" || !SIGNER_COORDINATE_PATTERN.test(entry)))
    throw new Error("Zupass verifier signer must contain two hexadecimal coordinates.");

  return Object.freeze(value.map((coordinate) => coordinate.replace(/^0x/i, "").toLowerCase()));
}

export function buildZupassVerifierPolicy(config: IZupassConfig): ZupassVerifierPolicy {
  if(!config.event)
    throw new Error("Zupass event configuration is required.");

  const signer = normalizeZupassSigner(config.verify?.signer);
  if(!signer)
    throw new Error("Zupass verifier signer is required.");

  const descriptor: ZupassVerifierPolicyDescriptor = Object.freeze({
    kind: "zupass-verifier-policy",
    version: 1,
    watermarkDomain: requireSecurityLabel(config.zupassWatermark, "Zupass watermark"),
    externalNullifier: generateSnarkMessageHash(
      requireSecurityLabel(config.zupassExternalNullifier, "Zupass external nullifier"),
    ).toString(),
    signer,
    productIds: normalizeUuidList(
      config.verify?.productId !== undefined ? config.verify.productId : config.event.productIds,
      "Zupass product IDs",
    ),
    eventIds: normalizeUuidList(
      config.verify?.eventId !== undefined ? config.verify.eventId : config.event.eventIds,
      "Zupass event IDs",
    ),
    challengeLifetimeSeconds: requireLifetime(
      config.challengeLifetime,
      "Zupass challenge lifetime",
      MAX_CHALLENGE_LIFETIME_SECONDS,
    ),
    authTokenLifetimeSeconds: requireLifetime(
      config.authTokenLifetime,
      "Zupass authentication token lifetime",
      MAX_TOKEN_LIFETIME_SECONDS,
    ),
  });
  if(descriptor.eventIds.length > 20)
    throw new Error("Zupass supports at most 20 verifier event IDs.");

  return Object.freeze({
    ...descriptor,
    id: sha256(JSON.stringify(descriptor)),
  });
}

export function buildZupassChallengeWatermark(policy: ZupassVerifierPolicy, challengeId: string): string {
  if(!CHALLENGE_ID_PATTERN.test(challengeId))
    throw new Error("Invalid Zupass challenge ID.");
  return generateSnarkMessageHash(`${policy.watermarkDomain}\n${challengeId}`).toString();
}

export function buildZupassProofRequestUrl(
  config: IZupassConfig,
  policy: ZupassVerifierPolicy,
  challenge: ZupassChallenge,
  returnUrl: string,
): string {
  if(typeof config.zupassUrl !== "string")
    throw new Error("Zupass URL is required.");

  const zupassUrl = new URL(config.zupassUrl);
  if((zupassUrl.protocol !== "http:" && zupassUrl.protocol !== "https:")
    || zupassUrl.username !== ""
    || zupassUrl.password !== ""
  ) {
    throw new Error("Zupass URL must be an HTTP URL without credentials.");
  }

  const request = {
    type: "Get",
    returnUrl,
    pcdType: "zk-eddsa-event-ticket-pcd",
    args: {
      ticket: {
        argumentType: "PCD",
        pcdType: "eddsa-ticket-pcd",
        userProvided: true,
        validatorParams: {
          eventIds: policy.eventIds,
          productIds: policy.productIds,
          notFoundMessage: "No eligible PCDs found",
        },
      },
      identity: {
        argumentType: "PCD",
        pcdType: "semaphore-identity-pcd",
        userProvided: true,
      },
      validEventIds: {
        argumentType: "StringArray",
        value: policy.eventIds.length > 0 ? policy.eventIds : undefined,
        userProvided: false,
      },
      fieldsToReveal: {
        argumentType: "ToggleList",
        value: {
          revealTicketId: true,
          revealEventId: true,
          revealAttendeeSemaphoreId: true,
          revealProductId: true,
          revealIsConsumed: true,
          revealIsRevoked: true,
        },
        userProvided: false,
      },
      externalNullifier: {
        argumentType: "BigInt",
        value: policy.externalNullifier,
        userProvided: false,
      },
      watermark: {
        argumentType: "BigInt",
        value: challenge.watermark,
        userProvided: false,
      },
    },
    options: {
      genericProveScreen: true,
      title: "ZKEdDSA Proof",
      description: "zkeddsa ticket pcd request",
    },
  };
  zupassUrl.hash = `/prove?request=${encodeURIComponent(JSON.stringify(request))}`;
  return zupassUrl.toString();
}

export function createZupassTokenPayload(
  identity: ZupassTicketIdentity,
  policy: ZupassVerifierPolicy,
  now: number,
): ZupassFaucetTokenPayload {
  const issuedAt = Math.floor(now);
  const payload: ZupassFaucetTokenPayload = {
    kind: "zupass",
    version: 1,
    ...identity,
    policyId: policy.id,
    issuedAt,
    expiresAt: issuedAt + policy.authTokenLifetimeSeconds,
  };
  if(!parseZupassTokenPayload(payload, policy, issuedAt))
    throw new Error("Invalid Zupass token claims.");
  return payload;
}

export function parseZupassTokenPayload(
  value: unknown,
  policy: ZupassVerifierPolicy,
  now: number,
): ZupassFaucetTokenPayload | null {
  if(!isRecord(value)
    || Object.keys(value).length !== TOKEN_PAYLOAD_KEYS.length
    || !TOKEN_PAYLOAD_KEYS.every((key) => key in value)
    || value.kind !== "zupass"
    || value.version !== 1
    || !isUuid(value.ticketId)
    || !isUuid(value.productId)
    || !isUuid(value.eventId)
    || !isSemaphoreId(value.attendeeId)
    || typeof value.policyId !== "string"
    || !POLICY_ID_PATTERN.test(value.policyId)
    || value.policyId !== policy.id
    || !isSafeTimestamp(value.issuedAt)
    || !isSafeTimestamp(value.expiresAt)
    || value.expiresAt - value.issuedAt !== policy.authTokenLifetimeSeconds
    || !Number.isSafeInteger(now)
    || value.issuedAt > now
    || value.expiresAt <= now
  ) {
    return null;
  }

  return value as unknown as ZupassFaucetTokenPayload;
}

function sameChallengeContext(left: ZupassChallengeContext, right: ZupassChallengeContext): boolean {
  return left.authState === right.authState
    && left.callbackOrigin === right.callbackOrigin
    && left.clientOrigin === right.clientOrigin;
}

function challengeContextKey(context: ZupassChallengeContext): string {
  return JSON.stringify([context.authState, context.callbackOrigin, context.clientOrigin]);
}

/**
 * Challenges live in one server process. A restart invalidates pending logins, and deployments
 * with several instances must route the login and callback to the same instance or replace this
 * store with a shared atomic implementation.
 */
export class ZupassChallengeStore {
  private readonly challenges = new Map<string, StoredZupassChallenge>();
  private readonly challengeByContext = new Map<string, string>();
  private readonly challengeCountByOwner = new Map<string, number>();
  private readonly challengeIdsByOwner = new Map<string, Set<string>>();
  private readonly rateBudgetByOwner = new Map<string, ZupassOwnerRateBudget>();
  private readonly maxPending: number;
  private readonly maxPendingPerOwner: number;
  private readonly maxIssuesPerOwner: number;
  private readonly maxCallbacksPerOwner: number;
  private readonly maxRateOwners: number;
  private readonly rateWindowSeconds: number;
  private readonly now: () => number;
  private readonly randomId: () => string;

  public constructor(options: ZupassChallengeStoreOptions = {}) {
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING_CHALLENGES;
    if(!Number.isSafeInteger(this.maxPending) || this.maxPending < 1)
      throw new Error("Zupass challenge capacity must be a positive integer.");
    this.maxPendingPerOwner = options.maxPendingPerOwner ?? DEFAULT_MAX_PENDING_CHALLENGES_PER_OWNER;
    if(!Number.isSafeInteger(this.maxPendingPerOwner) || this.maxPendingPerOwner < 1)
      throw new Error("Zupass per-owner challenge capacity must be a positive integer.");
    this.maxIssuesPerOwner = options.maxIssuesPerOwner ?? DEFAULT_MAX_CHALLENGE_ISSUES_PER_OWNER;
    if(!Number.isSafeInteger(this.maxIssuesPerOwner) || this.maxIssuesPerOwner < 1)
      throw new Error("Zupass challenge issue rate limit must be a positive integer.");
    this.maxCallbacksPerOwner = options.maxCallbacksPerOwner ?? DEFAULT_MAX_CHALLENGE_CALLBACKS_PER_OWNER;
    if(!Number.isSafeInteger(this.maxCallbacksPerOwner) || this.maxCallbacksPerOwner < 1)
      throw new Error("Zupass challenge callback rate limit must be a positive integer.");
    this.maxRateOwners = options.maxRateOwners ?? DEFAULT_MAX_CHALLENGE_RATE_OWNERS;
    if(!Number.isSafeInteger(this.maxRateOwners) || this.maxRateOwners < 1)
      throw new Error("Zupass challenge rate owner capacity must be a positive integer.");
    this.rateWindowSeconds = options.rateWindowSeconds ?? DEFAULT_CHALLENGE_RATE_WINDOW_SECONDS;
    if(!Number.isSafeInteger(this.rateWindowSeconds)
      || this.rateWindowSeconds < 1
      || this.rateWindowSeconds > MAX_CHALLENGE_RATE_WINDOW_SECONDS
    ) {
      throw new Error(`Zupass challenge rate window must be an integer between 1 and ${MAX_CHALLENGE_RATE_WINDOW_SECONDS}.`);
    }
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.randomId = options.randomId ?? (() => randomBytes(32).toString("hex"));
  }

  public issue(
    context: AuthCallbackContext,
    policy: ZupassVerifierPolicy,
    ownerIp: string,
  ): ZupassChallenge {
    if(normalizeIpAddress(ownerIp) !== ownerIp)
      throw new Error("Zupass challenge owner must be a canonical IP address.");

    const now = this.currentTime();
    this.pruneOwnerChallenges(ownerIp, now);
    if(!this.consumeRateBudget(ownerIp, "issue", now))
      throw new Error("Zupass challenge issue rate limit reached.");

    const contextKey = challengeContextKey(context);
    const priorChallengeId = this.challengeByContext.get(contextKey);
    if(priorChallengeId)
      this.delete(priorChallengeId);
    if(this.challenges.size >= this.maxPending)
      this.pruneAllExpiredChallenges(now);
    if(this.challenges.size >= this.maxPending)
      throw new Error("Zupass challenge capacity reached.");
    const ownerChallengeCount = this.challengeCountByOwner.get(ownerIp) || 0;
    if(ownerChallengeCount >= this.maxPendingPerOwner)
      throw new Error("Zupass challenge owner capacity reached.");

    let id = "";
    for(let attempt = 0; attempt < 3; attempt++) {
      id = this.randomId();
      if(CHALLENGE_ID_PATTERN.test(id) && !this.challenges.has(id))
        break;
      id = "";
    }
    if(!id)
      throw new Error("Could not allocate a unique Zupass challenge.");

    const challenge: StoredZupassChallenge = Object.freeze({
      id,
      watermark: buildZupassChallengeWatermark(policy, id),
      issuedAt: now,
      expiresAt: now + policy.challengeLifetimeSeconds,
      policyId: policy.id,
      ownerIp,
      context: Object.freeze({
        authState: context.authState,
        callbackOrigin: context.callbackOrigin,
        clientOrigin: context.clientOrigin,
      }),
    });
    this.challenges.set(id, challenge);
    this.challengeByContext.set(contextKey, id);
    this.challengeCountByOwner.set(ownerIp, ownerChallengeCount + 1);
    let ownerChallengeIds = this.challengeIdsByOwner.get(ownerIp);
    if(!ownerChallengeIds) {
      ownerChallengeIds = new Set<string>();
      this.challengeIdsByOwner.set(ownerIp, ownerChallengeIds);
    }
    ownerChallengeIds.add(id);
    return challenge;
  }

  public consume(
    challengeId: unknown,
    context: AuthCallbackContext,
    policy: ZupassVerifierPolicy,
    ownerIp: string,
  ): ZupassChallengeConsumption {
    if(normalizeIpAddress(ownerIp) !== ownerIp)
      return { kind: "rejected", reason: "invalid" };

    const now = this.currentTime();
    if(!this.consumeRateBudget(ownerIp, "callback", now))
      return { kind: "rejected", reason: "rate" };
    if(typeof challengeId !== "string" || !CHALLENGE_ID_PATTERN.test(challengeId))
      return { kind: "rejected", reason: "invalid" };

    const challenge = this.challenges.get(challengeId);
    if(!challenge)
      return { kind: "rejected", reason: "unknown" };
    if(now >= challenge.expiresAt) {
      this.delete(challengeId);
      return { kind: "rejected", reason: "expired" };
    }
    if(challenge.policyId !== policy.id) {
      this.delete(challengeId);
      return { kind: "rejected", reason: "policy" };
    }
    if(!sameChallengeContext(challenge.context, context))
      return { kind: "rejected", reason: "context" };

    this.delete(challengeId);
    return {
      kind: "accepted",
      challenge: {
        id: challenge.id,
        watermark: challenge.watermark,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
      },
    };
  }

  public discard(challengeId: string): void {
    this.delete(challengeId);
  }

  public clear(): void {
    this.challenges.clear();
    this.challengeByContext.clear();
    this.challengeCountByOwner.clear();
    this.challengeIdsByOwner.clear();
    this.rateBudgetByOwner.clear();
  }

  public get size(): number {
    return this.challenges.size;
  }

  private currentTime(): number {
    const now = this.now();
    if(!Number.isSafeInteger(now) || now < 0)
      throw new Error("Zupass challenge clock returned an invalid timestamp.");
    return now;
  }

  private pruneAllExpiredChallenges(now: number): void {
    for(const [challengeId, challenge] of this.challenges) {
      if(now >= challenge.expiresAt)
        this.delete(challengeId);
    }
  }

  private pruneOwnerChallenges(ownerIp: string, now: number): void {
    const challengeIds = this.challengeIdsByOwner.get(ownerIp);
    if(!challengeIds)
      return;
    for(const challengeId of challengeIds) {
      const challenge = this.challenges.get(challengeId);
      if(!challenge) {
        challengeIds.delete(challengeId);
        continue;
      }
      if(now >= challenge.expiresAt)
        this.delete(challengeId);
    }
    if(challengeIds.size === 0)
      this.challengeIdsByOwner.delete(ownerIp);
  }

  private pruneExpiredRateOwners(now: number): void {
    for(const [ownerIp, budget] of this.rateBudgetByOwner) {
      this.pruneRateBudget(ownerIp, budget, now);
    }
  }

  private pruneRateBudget(ownerIp: string, budget: ZupassOwnerRateBudget, now: number): void {
    budget.issueExpiries = budget.issueExpiries.filter((expiresAt) => expiresAt > now);
    budget.callbackExpiries = budget.callbackExpiries.filter((expiresAt) => expiresAt > now);
    if(budget.issueExpiries.length === 0 && budget.callbackExpiries.length === 0)
      this.rateBudgetByOwner.delete(ownerIp);
  }

  private consumeRateBudget(
    ownerIp: string,
    kind: "issue" | "callback",
    now: number,
  ): boolean {
    let budget = this.rateBudgetByOwner.get(ownerIp);
    if(budget) {
      this.pruneRateBudget(ownerIp, budget, now);
      budget = this.rateBudgetByOwner.get(ownerIp);
    }
    if(!budget) {
      if(this.rateBudgetByOwner.size >= this.maxRateOwners) {
        this.pruneExpiredRateOwners(now);
        if(this.rateBudgetByOwner.size >= this.maxRateOwners)
          return false;
      }
      budget = {issueExpiries: [], callbackExpiries: []};
      this.rateBudgetByOwner.set(ownerIp, budget);
    }

    const expiries = kind === "issue" ? budget.issueExpiries : budget.callbackExpiries;
    const limit = kind === "issue" ? this.maxIssuesPerOwner : this.maxCallbacksPerOwner;
    if(expiries.length >= limit)
      return false;
    expiries.push(now + this.rateWindowSeconds);
    return true;
  }

  private delete(challengeId: string): void {
    const challenge = this.challenges.get(challengeId);
    if(!challenge)
      return;
    this.challenges.delete(challengeId);
    const contextKey = challengeContextKey(challenge.context);
    if(this.challengeByContext.get(contextKey) === challengeId)
      this.challengeByContext.delete(contextKey);
    const ownerChallengeCount = this.challengeCountByOwner.get(challenge.ownerIp) || 0;
    if(ownerChallengeCount <= 1) {
      this.challengeCountByOwner.delete(challenge.ownerIp);
      this.challengeIdsByOwner.delete(challenge.ownerIp);
    } else {
      this.challengeCountByOwner.set(challenge.ownerIp, ownerChallengeCount - 1);
      this.challengeIdsByOwner.get(challenge.ownerIp)?.delete(challengeId);
    }
  }
}
