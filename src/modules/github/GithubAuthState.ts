import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  AuthCallbackContext,
  AuthCallbackOrigins,
  AuthCallbackResult,
} from "../../webserv/AuthCallbackPage.js";
import type { IGithubAuthInfo } from "./GithubResolver.js";

export interface GithubAuthStateCapability {
  state: string;
  expiresAt: number;
}

interface GithubAuthStateCommon extends GithubAuthStateCapability {
  context: AuthCallbackOrigins;
  ownerIp: string;
  browserBinding: GithubAuthBrowserBinding;
}

type GithubAuthBrowserBinding =
  | { kind: "same-origin" }
  | { kind: "cookie"; digest: string };

type GithubAuthResult = AuthCallbackResult<IGithubAuthInfo>;

type StoredGithubAuthState =
  | GithubAuthStateCommon & { phase: "issued" }
  | GithubAuthStateCommon & { phase: "processing" }
  | GithubAuthStateCommon & { phase: "complete"; authResult: GithubAuthResult };

export type GithubAuthStateConsumption =
  | { kind: "accepted"; ownerIp: string }
  | { kind: "rejected"; reason: "invalid" | "unknown" | "expired" | "context" | "binding" | "used" };

export type GithubAuthResultConsumption =
  | { kind: "accepted"; authResult: GithubAuthResult }
  | { kind: "pending" }
  | { kind: "rejected"; reason: "invalid" | "unknown" | "expired" | "context" | "binding" };

interface GithubAuthStateStoreOptions {
  maxPending?: number;
  maxPendingPerOwner?: number;
  lifetimeSeconds?: number;
  now?: () => number;
  randomState?: () => string;
}

export const GITHUB_AUTH_STATE_LIFETIME_SECONDS = 5 * 60;

const GITHUB_AUTH_STATE_PATTERN = /^[0-9a-f]{64}$/;
export const GITHUB_AUTH_BROWSER_BINDING_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_MAX_PENDING_STATES = 1024;
const DEFAULT_MAX_PENDING_STATES_PER_OWNER = 8;

function sameContext(left: AuthCallbackOrigins, right: AuthCallbackOrigins): boolean {
  return left.callbackOrigin === right.callbackOrigin
    && left.clientOrigin === right.clientOrigin
    && left.sameOrigin === right.sameOrigin;
}

function digestBrowserBinding(binding: string): string {
  return createHash("sha256").update(binding, "utf8").digest("hex");
}

function matchesBrowserBinding(capability: StoredGithubAuthState, binding: string | null): boolean {
  switch(capability.browserBinding.kind) {
    case "same-origin":
      return true;
    case "cookie": {
      if(typeof binding !== "string" || !GITHUB_AUTH_BROWSER_BINDING_PATTERN.test(binding))
        return false;
      const expectedDigest = Buffer.from(capability.browserBinding.digest, "hex");
      const actualDigest = Buffer.from(digestBrowserBinding(binding), "hex");
      return timingSafeEqual(expectedDigest, actualDigest);
    }
    default: {
      const exhaustive: never = capability.browserBinding;
      return exhaustive;
    }
  }
}

export class GithubAuthStateStore {
  private readonly states = new Map<string, StoredGithubAuthState>();
  private readonly stateCountByOwner = new Map<string, number>();
  private readonly maxPending: number;
  private readonly maxPendingPerOwner: number;
  private readonly lifetimeSeconds: number;
  private readonly now: () => number;
  private readonly randomState: () => string;

  public constructor(options: GithubAuthStateStoreOptions = {}) {
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING_STATES;
    this.maxPendingPerOwner = options.maxPendingPerOwner ?? DEFAULT_MAX_PENDING_STATES_PER_OWNER;
    this.lifetimeSeconds = options.lifetimeSeconds ?? GITHUB_AUTH_STATE_LIFETIME_SECONDS;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.randomState = options.randomState ?? (() => randomBytes(32).toString("hex"));

    if(!Number.isSafeInteger(this.maxPending) || this.maxPending < 1)
      throw new Error("GitHub authentication state capacity must be a positive integer.");
    if(!Number.isSafeInteger(this.maxPendingPerOwner) || this.maxPendingPerOwner < 1)
      throw new Error("GitHub per-client authentication state capacity must be a positive integer.");
    if(!Number.isSafeInteger(this.lifetimeSeconds) || this.lifetimeSeconds < 1)
      throw new Error("GitHub authentication state lifetime must be a positive integer.");
  }

  public issue(
    context: AuthCallbackOrigins,
    ownerIp: string,
    browserBinding: string | null = null,
  ): GithubAuthStateCapability {
    if(typeof ownerIp !== "string" || ownerIp.length === 0)
      throw new Error("GitHub authentication state owner is invalid.");
    let storedBrowserBinding: GithubAuthBrowserBinding;
    if(context.sameOrigin) {
      storedBrowserBinding = Object.freeze({ kind: "same-origin" });
    } else {
      if(typeof browserBinding !== "string" || !GITHUB_AUTH_BROWSER_BINDING_PATTERN.test(browserBinding))
        throw new Error("GitHub authentication browser binding is invalid.");
      storedBrowserBinding = Object.freeze({
        kind: "cookie",
        digest: digestBrowserBinding(browserBinding),
      });
    }

    const now = this.currentTime();
    this.pruneExpired(now);
    if(this.states.size >= this.maxPending)
      throw new Error("GitHub authentication state capacity reached.");

    const ownerStateCount = this.stateCountByOwner.get(ownerIp) || 0;
    if(ownerStateCount >= this.maxPendingPerOwner)
      throw new Error("GitHub authentication state client capacity reached.");

    let state = "";
    for(let attempt = 0; attempt < 3; attempt++) {
      state = this.randomState();
      if(GITHUB_AUTH_STATE_PATTERN.test(state) && !this.states.has(state))
        break;
      state = "";
    }
    if(!state)
      throw new Error("Could not allocate a unique GitHub authentication state.");

    const capability: StoredGithubAuthState = Object.freeze({
      state,
      expiresAt: now + this.lifetimeSeconds,
      ownerIp,
      phase: "issued",
      browserBinding: storedBrowserBinding,
      context: Object.freeze({
        callbackOrigin: context.callbackOrigin,
        clientOrigin: context.clientOrigin,
        sameOrigin: context.sameOrigin,
      }),
    });
    this.states.set(state, capability);
    this.stateCountByOwner.set(ownerIp, ownerStateCount + 1);
    return { state: capability.state, expiresAt: capability.expiresAt };
  }

  public consume(
    context: AuthCallbackContext,
    browserBinding: string | null = null,
  ): GithubAuthStateConsumption {
    if(!GITHUB_AUTH_STATE_PATTERN.test(context.authState))
      return { kind: "rejected", reason: "invalid" };

    const capability = this.states.get(context.authState);
    if(!capability)
      return { kind: "rejected", reason: "unknown" };
    const now = this.currentTime();
    if(now >= capability.expiresAt) {
      this.delete(context.authState);
      return { kind: "rejected", reason: "expired" };
    }
    if(!sameContext(capability.context, context))
      return { kind: "rejected", reason: "context" };
    if(!matchesBrowserBinding(capability, browserBinding))
      return { kind: "rejected", reason: "binding" };
    if(capability.phase !== "issued")
      return { kind: "rejected", reason: "used" };

    this.states.set(context.authState, Object.freeze({
      ...capability,
      expiresAt: now + this.lifetimeSeconds,
      phase: "processing",
    }));
    return { kind: "accepted", ownerIp: capability.ownerIp };
  }

  public complete(state: string, authResult: GithubAuthResult): boolean {
    const capability = this.states.get(state);
    if(!capability || capability.phase !== "processing")
      return false;
    const now = this.currentTime();
    if(now >= capability.expiresAt) {
      this.delete(state);
      return false;
    }
    if(capability.context.sameOrigin) {
      this.delete(state);
      return true;
    }

    this.states.set(state, Object.freeze({
      ...capability,
      expiresAt: now + this.lifetimeSeconds,
      phase: "complete",
      authResult,
    }));
    return true;
  }

  public consumeResult(
    context: AuthCallbackContext,
    browserBinding: string | null = null,
  ): GithubAuthResultConsumption {
    if(!GITHUB_AUTH_STATE_PATTERN.test(context.authState))
      return { kind: "rejected", reason: "invalid" };

    const capability = this.states.get(context.authState);
    if(!capability)
      return { kind: "rejected", reason: "unknown" };
    if(this.currentTime() >= capability.expiresAt) {
      this.delete(context.authState);
      return { kind: "rejected", reason: "expired" };
    }
    if(!sameContext(capability.context, context))
      return { kind: "rejected", reason: "context" };
    if(!matchesBrowserBinding(capability, browserBinding))
      return { kind: "rejected", reason: "binding" };
    if(capability.phase !== "complete")
      return { kind: "pending" };

    this.delete(context.authState);
    return { kind: "accepted", authResult: capability.authResult };
  }

  public clear(): void {
    this.states.clear();
    this.stateCountByOwner.clear();
  }

  private currentTime(): number {
    const now = this.now();
    if(!Number.isSafeInteger(now) || now < 0)
      throw new Error("GitHub authentication state clock returned an invalid timestamp.");
    return now;
  }

  private pruneExpired(now: number): void {
    for(const [state, capability] of this.states) {
      if(now >= capability.expiresAt)
        this.delete(state);
    }
  }

  private delete(state: string): void {
    const capability = this.states.get(state);
    if(!capability)
      return;

    this.states.delete(state);
    const ownerStateCount = this.stateCountByOwner.get(capability.ownerIp) || 0;
    if(ownerStateCount <= 1)
      this.stateCountByOwner.delete(capability.ownerIp);
    else
      this.stateCountByOwner.set(capability.ownerIp, ownerStateCount - 1);
  }
}
