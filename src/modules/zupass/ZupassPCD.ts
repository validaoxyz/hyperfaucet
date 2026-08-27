import { Worker } from "node:worker_threads";
import JSONBig from "json-bigint";

import { faucetConfig } from "../../config/FaucetConfig.js";
import { decryptTokenPayload, encryptTokenPayload } from "../../utils/CryptoUtils.js";
import { ZupassModule } from "./ZupassModule.js";
import { BABY_JUB_NEGATIVE_ONE, booleanToBigInt, generateSnarkMessageHash, hexToBigInt, numberToBigInt, requireDefinedParameter, uuidToBigInt } from './ZupassUtils.js';
import { PromiseDfd } from "../../utils/PromiseDfd.js";
import { ServiceManager } from "../../common/ServiceManager.js";
import { FaucetWorkers } from "../../common/FaucetWorker.js";
import {
  createZupassTokenPayload,
  parseZupassTokenPayload,
  ZupassVerifierPolicy,
} from "./ZupassAuth.js";
import { assertBoundedJsonDocument } from "./ZupassJsonBounds.js";
import type { BoundedJsonDocumentOptions } from "./ZupassJsonBounds.js";


/**
 * Max supported size of validEventIds field in ZKEdDSAEventTicketPCDArgs.
 */
export const VALID_EVENT_IDS_MAX_LEN = 20;

export const STATIC_TICKET_PCD_NULLIFIER = generateSnarkMessageHash(
  "dummy-nullifier-for-eddsa-event-ticket-pcds"
);

export type NumericString = `${number}` | string;
export type SignalValueType = NumericString | number | bigint | SignalValueType[];
export interface CircuitSignals {
    [signal: string]: SignalValueType;
}
export interface Groth16Proof {
    pi_a: NumericString[];
    pi_b: NumericString[][];
    pi_c: NumericString[];
    protocol: string;
    curve: string;
}

/**
 * An EdDSA public key is represented as a point on the elliptic curve, with each point being
 * a pair of coordinates consisting of hexadecimal strings. The public key is maintained in a standard
 * format and is internally converted to and from the Montgomery format as needed.
 */
export type EdDSAPublicKey = [string, string];

export enum TicketCategory {
  ZuConnect = 0,
  Devconnect = 1,
  PcdWorkingGroup = 2,
  Zuzalu = 3,
  Generic = 4,
}

export interface ITicketData {
  // The fields below are not signed and are used for display purposes.
  attendeeName: string;
  attendeeEmail: string;
  eventName: string;
  ticketName: string;
  checkerEmail: string | undefined;
  // The fields below are signed using the passport-server's private EdDSA key
  // and can be used by 3rd parties to represent their own tickets.
  ticketId: string; // The ticket ID is a unique identifier of the ticket.
  eventId: string; // The event ID uniquely identifies an event.
  productId: string; // The product ID uniquely identifies the type of ticket (e.g. General Admission, Volunteer etc.).
  timestampConsumed: number;
  timestampSigned: number;
  attendeeSemaphoreId: string;
  isConsumed: boolean;
  isRevoked: boolean;
  ticketCategory: number;
}

export const ZKEdDSAEventTicketPCDTypeName = "zk-eddsa-event-ticket-pcd";


export interface PCD<C = unknown, P = unknown> {
  /**
   * Uniquely identifies this instance. Zupass cannot have more than one
   * {@link PCD} with the same id. In practice this is often a UUID generated
   * by the {@link PCDPackage#prove} function.
   */
  id: string;

  /**
   * Refers to {@link PCDPackage#name} - each {@link PCD} must come from a
   * particular {@link PCDPackage}. By convention, this is a string like
   * `'semaphore-identity-pcd'`, or `'rsa-ticket-pcd'`. These type names
   * are intended to be globally unique - i.e. no two distinct PCD types
   * should have the same type name.
   */
  type: string;

  /**
   * Information encoded in this PCD that is intended to be consumed by the
   * business logic of some application. For example, a type of PCD that could
   * exist is one that is able to prove that its creator knows the prime factorization
   * of a really big number. In that case, the really big number would be the claim,
   * and a ZK proof of its prime factorization would go in the {@link PCD#proof}.
   *
   */
  claim: C;

  /**
   * A cryptographic or mathematical proof of the {@link PCD#claim}.
   */
  proof: P;
}

/**
 * Claim part of a ZKEdDSAEventTicketPCD contains all public/revealed fields.
 */
export interface ZKEdDSAEventTicketPCDClaim {
  partialTicket: Partial<ITicketData>;
  watermark: string;
  signer: EdDSAPublicKey;

  // only if requested in PCDArgs
  validEventIds?: string[];
  externalNullifier?: string;
  nullifierHash?: string;
}

/**
 * ZKEdDSAEventTicketPCD PCD type representation.
 */
export class ZKEdDSAEventTicketPCD
  implements PCD<ZKEdDSAEventTicketPCDClaim, Groth16Proof>
{
  type = ZKEdDSAEventTicketPCDTypeName;

  public constructor(
    readonly id: string,
    readonly claim: ZKEdDSAEventTicketPCDClaim,
    readonly proof: Groth16Proof
  ) {
    this.id = id;
    this.claim = claim;
    this.proof = proof;
  }
}


export interface IZupassPDCData {
  ticketId: string;
  productId: string;
  eventId: string;
  attendeeId: string;
  token: string;
}

export interface IZupassVerifyRequest {
  reqId: number;
  publicSignals: string[];
  proof: Groth16Proof;
}

const DEFAULT_INIT_TIMEOUT_MS = 10_000;
const DEFAULT_VERIFY_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PENDING_VERIFICATIONS = 16;
const DEFAULT_RESTART_BACKOFF_MS = 100;
const DEFAULT_MAX_RESTART_BACKOFF_MS = 5_000;
const MAX_TICKET_PCD_BYTES = 32 * 1024;
const MAX_TICKET_JSON_DEPTH = 16;
const TICKET_PCD_BOUNDS: BoundedJsonDocumentOptions = {
  maxBytes: MAX_TICKET_PCD_BYTES,
  maxDepth: MAX_TICKET_JSON_DEPTH,
  errorMessages: {
    size: "Zupass ticket payload exceeds the size limit.",
    nesting: "Zupass ticket payload exceeds the nesting limit.",
  },
};
const MAX_PCD_ID_LENGTH = 128;
const MAX_TICKET_TEXT_LENGTH = 1024;
const MAX_FIELD_ELEMENT_DIGITS = 80;
const MAX_PROOF_COORDINATE_DIGITS = 80;
const FIELD_ELEMENT_PATTERN = /^(?:0|[1-9][0-9]{0,79})$/;
const PROOF_COORDINATE_PATTERN = /^(?:0|[1-9][0-9]{0,79})$/;
const SIGNER_COORDINATE_PATTERN = /^(?:0x)?[0-9a-fA-F]{1,128}$/;

type ZupassWorkerPhase = "starting" | "ready" | "stopping";

interface ZupassWorkerGeneration {
  id: number;
  worker: Worker;
  phase: ZupassWorkerPhase;
  initTimeout: NodeJS.Timeout | null;
  activeRequestId: number | null;
}

type ZupassTerminationState =
  | {kind: "drained"}
  | {kind: "undrained", generation: ZupassWorkerGeneration};

interface PendingZupassVerification {
  generationId: number;
  request: IZupassVerifyRequest;
  result: PromiseDfd<boolean>;
  timeout: NodeJS.Timeout | null;
  phase: "queued" | "in-flight";
}

export interface ZupassVerificationAdmission {
  readonly id: number;
  readonly generationId: number;
}

export interface ZupassPCDOptions {
  initTimeoutMs?: number;
  verifyTimeoutMs?: number;
  maxPendingVerifications?: number;
  restartBackoffMs?: number;
  maxRestartBackoffMs?: number;
  workerFactory?: () => Worker;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isUuid(value: unknown): value is string {
  if(!isBoundedString(value, 64))
    return false;
  try {
    uuidToBigInt(value);
    return true;
  } catch {
    return false;
  }
}

function isFieldElement(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_FIELD_ELEMENT_DIGITS
    && FIELD_ELEMENT_PATTERN.test(value);
}

function isSemaphoreId(value: unknown): value is string {
  return isFieldElement(value) && BigInt(value) <= BABY_JUB_NEGATIVE_ONE;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parsePartialTicket(value: unknown): Partial<ITicketData> | null {
  if(!isRecord(value))
    return null;

  const ticket: Partial<ITicketData> = {};
  for(const key of ["ticketId", "eventId", "productId"] as const) {
    const fieldValue = value[key];
    if(fieldValue !== undefined) {
      if(!isUuid(fieldValue))
        return null;
      ticket[key] = fieldValue;
    }
  }
  for(const key of ["attendeeName", "attendeeEmail", "eventName", "ticketName", "checkerEmail"] as const) {
    const fieldValue = value[key];
    if(fieldValue !== undefined) {
      if(!isBoundedText(fieldValue, MAX_TICKET_TEXT_LENGTH))
        return null;
      ticket[key] = fieldValue;
    }
  }
  for(const key of ["timestampConsumed", "timestampSigned"] as const) {
    const fieldValue = value[key];
    if(fieldValue !== undefined) {
      if(!isSafeNonNegativeInteger(fieldValue))
        return null;
      ticket[key] = fieldValue;
    }
  }
  const attendeeSemaphoreId = value.attendeeSemaphoreId;
  if(attendeeSemaphoreId !== undefined) {
    if(!isSemaphoreId(attendeeSemaphoreId))
      return null;
    ticket.attendeeSemaphoreId = attendeeSemaphoreId;
  }
  for(const key of ["isConsumed", "isRevoked"] as const) {
    const fieldValue = value[key];
    if(fieldValue !== undefined) {
      if(typeof fieldValue !== "boolean")
        return null;
      ticket[key] = fieldValue;
    }
  }
  const ticketCategory = value.ticketCategory;
  if(ticketCategory !== undefined) {
    if(typeof ticketCategory !== "number"
      || !Number.isSafeInteger(ticketCategory)
      || ticketCategory < 0
    ) {
      return null;
    }
    ticket.ticketCategory = ticketCategory;
  }
  return ticket;
}

function parseTicketClaim(value: unknown): ZKEdDSAEventTicketPCDClaim | null {
  if(!isRecord(value))
    return null;
  const partialTicket = parsePartialTicket(value.partialTicket);
  if(!partialTicket || !isFieldElement(value.watermark))
    return null;
  if(!Array.isArray(value.signer)
    || value.signer.length !== 2
    || value.signer.some((coordinate) => typeof coordinate !== "string" || !SIGNER_COORDINATE_PATTERN.test(coordinate))
  ) {
    return null;
  }

  let validEventIds: string[] | undefined;
  if(value.validEventIds !== undefined) {
    if(!Array.isArray(value.validEventIds) || value.validEventIds.length > VALID_EVENT_IDS_MAX_LEN)
      return null;
    validEventIds = [];
    for(const eventId of value.validEventIds) {
      if(!isUuid(eventId))
        return null;
      validEventIds.push(eventId);
    }
  }
  let externalNullifier: string | undefined;
  if(value.externalNullifier !== undefined) {
    if(!isFieldElement(value.externalNullifier))
      return null;
    externalNullifier = value.externalNullifier;
  }
  let nullifierHash: string | undefined;
  if(value.nullifierHash !== undefined) {
    if(!isFieldElement(value.nullifierHash))
      return null;
    nullifierHash = value.nullifierHash;
  }

  return {
    partialTicket,
    watermark: value.watermark,
    signer: [value.signer[0], value.signer[1]],
    validEventIds,
    externalNullifier,
    nullifierHash,
  };
}

function parseProofCoordinate(value: unknown): NumericString | null {
  return typeof value === "string"
    && value.length <= MAX_PROOF_COORDINATE_DIGITS
    && PROOF_COORDINATE_PATTERN.test(value)
    ? value
    : null;
}

function parseProofVector(value: unknown, length: number): NumericString[] | null {
  if(!Array.isArray(value) || value.length !== length)
    return null;
  const vector: NumericString[] = [];
  for(const coordinate of value) {
    const parsed = parseProofCoordinate(coordinate);
    if(parsed === null)
      return null;
    vector.push(parsed);
  }
  return vector;
}

function parseGroth16Proof(value: unknown): Groth16Proof | null {
  if(!isRecord(value)
    || value.protocol !== "groth16"
    || value.curve !== "bn128"
  ) {
    return null;
  }
  const piA = parseProofVector(value.pi_a, 3);
  const piC = parseProofVector(value.pi_c, 3);
  if(!piA || !piC || !Array.isArray(value.pi_b) || value.pi_b.length !== 3)
    return null;
  const piB: NumericString[][] = [];
  for(const row of value.pi_b) {
    const parsed = parseProofVector(row, 2);
    if(!parsed)
      return null;
    piB.push(parsed);
  }
  return {
    pi_a: piA,
    pi_b: piB,
    pi_c: piC,
    protocol: value.protocol,
    curve: value.curve,
  };
}

export class ZupassPCD {
  private readonly module: ZupassModule;
  private readonly initTimeoutMs: number;
  private readonly verifyTimeoutMs: number;
  private readonly maxPendingVerifications: number;
  private readonly restartBackoffMs: number;
  private readonly maxRestartBackoffMs: number;
  private readonly workerFactory: () => Worker;
  private readonly verifyQueue = new Map<number, PendingZupassVerification>();
  private generation: ZupassWorkerGeneration | null = null;
  private generationIdCounter = 1;
  private verifyIdCounter = 1;
  private admissionIdCounter = 1;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private recoveryPromise: Promise<void> | null = null;
  private terminationState: ZupassTerminationState = {kind: "drained"};
  private reloadPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;
  private readonly verificationAdmissions = new Set<ZupassVerificationAdmission>();

  public constructor(module: ZupassModule, worker?: Worker, options: ZupassPCDOptions = {}) {
    this.module = module;
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.verifyTimeoutMs = options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
    this.maxPendingVerifications = options.maxPendingVerifications ?? DEFAULT_MAX_PENDING_VERIFICATIONS;
    this.restartBackoffMs = options.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
    this.maxRestartBackoffMs = options.maxRestartBackoffMs ?? DEFAULT_MAX_RESTART_BACKOFF_MS;
    this.workerFactory = options.workerFactory
      || (() => ServiceManager.GetService(FaucetWorkers).createWorker("zupass-worker"));
    if(!Number.isSafeInteger(this.initTimeoutMs) || this.initTimeoutMs < 1)
      throw new Error("Zupass verifier initialization timeout must be a positive integer.");
    if(!Number.isSafeInteger(this.verifyTimeoutMs) || this.verifyTimeoutMs < 1)
      throw new Error("Zupass verification timeout must be a positive integer.");
    if(!Number.isSafeInteger(this.maxPendingVerifications) || this.maxPendingVerifications < 1)
      throw new Error("Zupass verification capacity must be a positive integer.");
    if(!Number.isSafeInteger(this.restartBackoffMs) || this.restartBackoffMs < 1)
      throw new Error("Zupass verifier restart backoff must be a positive integer.");
    if(!Number.isSafeInteger(this.maxRestartBackoffMs) || this.maxRestartBackoffMs < 1)
      throw new Error("Zupass verifier maximum restart backoff must be a positive integer.");

    this.startGeneration(worker);
  }

  public parseTicket(pcdData: string): ZKEdDSAEventTicketPCD {
    if(typeof pcdData !== "string")
      throw new Error("Zupass ticket payload must be a string.");
    assertBoundedJsonDocument(pcdData, TICKET_PCD_BOUNDS);

    let parsed: unknown;
    try {
      parsed = JSONBig({ useNativeBigInt: true }).parse(pcdData) as unknown;
    } catch {
      throw new Error("Zupass ticket payload is not valid JSON.");
    }
    return this.normalizeTicket(parsed);
  }

  /**
   * Convert a list of valid event IDs from input format (variable-length list
   * of UUID strings) to snark signal format (fixed-length list of bigint
   * strings).  The result always has length VALID_EVENT_IDS_MAX_LEN with
   * unused fields are filled in with a value of BABY_JUB_NEGATIVE_ONE.
   */
  private snarkInputForValidEventIds(validEventIds: string[]): string[] {
    const snarkIds = new Array<string>(VALID_EVENT_IDS_MAX_LEN);
    let i = 0;
    for (const validId of validEventIds) {
      snarkIds[i] = uuidToBigInt(validId).toString();
      ++i;
    }
    for (; i < VALID_EVENT_IDS_MAX_LEN; ++i) {
      snarkIds[i] = BABY_JUB_NEGATIVE_ONE.toString();
    }
    return snarkIds;
  }

  private publicSignalsFromClaim(claim: ZKEdDSAEventTicketPCDClaim): string[] {
    const t = claim.partialTicket;
    const ret: string[] = [];
  
    const negOne = BABY_JUB_NEGATIVE_ONE.toString();
  
    // Outputs appear in public signals first
    ret.push(
      t.ticketId === undefined ? negOne : uuidToBigInt(t.ticketId).toString()
    );
    ret.push(
      t.eventId === undefined ? negOne : uuidToBigInt(t.eventId).toString()
    );
    ret.push(
      t.productId === undefined ? negOne : uuidToBigInt(t.productId).toString()
    );
    ret.push(
      t.timestampConsumed === undefined ? negOne : t.timestampConsumed.toString()
    );
    ret.push(
      t.timestampSigned === undefined ? negOne : t.timestampSigned.toString()
    );
    ret.push(t.attendeeSemaphoreId || negOne);
    ret.push(
      t.isConsumed === undefined
        ? negOne
        : booleanToBigInt(t.isConsumed).toString()
    );
    ret.push(
      t.isRevoked === undefined ? negOne : booleanToBigInt(t.isRevoked).toString()
    );
    ret.push(
      t.ticketCategory === undefined
        ? negOne
        : numberToBigInt(t.ticketCategory).toString()
    );
    // Placeholder for reserved fields
    ret.push(negOne, negOne, negOne);
    ret.push(claim.nullifierHash || negOne);
  
    // Public inputs appear in public signals in declaration order
    ret.push(hexToBigInt(claim.signer[0]).toString());
    ret.push(hexToBigInt(claim.signer[1]).toString());
  
    for (const eventId of this.snarkInputForValidEventIds(claim.validEventIds || [])) {
      ret.push(eventId);
    }
    ret.push(claim.validEventIds !== undefined ? "1" : "0"); // checkValidEventIds
  
    ret.push(
      claim.externalNullifier?.toString() ||
        STATIC_TICKET_PCD_NULLIFIER.toString()
    );
  
    ret.push(claim.watermark);
  
    return ret;
  }

  public reserveVerification(): ZupassVerificationAdmission {
    const generation = this.generation;
    if(this.disposed
      || this.reloadPromise
      || this.recoveryPromise
      || this.terminationState.kind === "undrained"
      || !generation
      || generation.phase === "stopping"
    ) {
      throw new Error("Zupass verifier is unavailable.");
    }
    if(this.verifyQueue.size + this.verificationAdmissions.size >= this.maxPendingVerifications)
      throw new Error("Zupass verifier is busy.");

    const admission = Object.freeze({
      id: this.admissionIdCounter++,
      generationId: generation.id,
    });
    this.verificationAdmissions.add(admission);
    return admission;
  }

  public releaseVerification(admission: ZupassVerificationAdmission): void {
    this.verificationAdmissions.delete(admission);
  }

  public async verifyTicket(
    pcd: ZKEdDSAEventTicketPCD,
    admission = this.reserveVerification(),
  ): Promise<boolean> {
    if(!this.verificationAdmissions.has(admission))
      throw new Error("Zupass verifier admission is invalid.");

    const generation = this.generation;
    if(this.disposed
      || !generation
      || generation.phase === "stopping"
      || admission.generationId !== generation.id
    ) {
      this.releaseVerification(admission);
      throw new Error("Zupass verifier is unavailable.");
    }

    let normalizedTicket: ZKEdDSAEventTicketPCD;
    let publicSignals: string[];
    try {
      normalizedTicket = this.normalizeTicket(pcd);
      publicSignals = this.publicSignalsFromClaim(normalizedTicket.claim);
    } catch(error) {
      this.releaseVerification(admission);
      throw error;
    }
    if(this.generation !== generation) {
      this.releaseVerification(admission);
      throw new Error("Zupass verifier is unavailable.");
    }
    this.releaseVerification(admission);

    const resDfd = new PromiseDfd<boolean>();
    const req: IZupassVerifyRequest = {
      reqId: this.verifyIdCounter++,
      publicSignals,
      proof: normalizedTicket.proof,
    };
    const pending: PendingZupassVerification = {
      generationId: generation.id,
      request: req,
      result: resDfd,
      timeout: null,
      phase: "queued",
    };
    this.verifyQueue.set(req.reqId, pending);
    this.dispatchNext();

    return resDfd.promise;
  }

  public reload(): Promise<void> {
    if(this.disposed)
      return Promise.reject(new Error("Zupass verifier is stopped."));
    if(this.reloadPromise)
      return this.reloadPromise;

    this.clearRestartTimer();
    this.verificationAdmissions.clear();
    this.rejectAll(new Error("Zupass verification was interrupted by reload."));
    const generation = this.generation;
    this.generation = null;
    if(generation)
      generation.phase = "stopping";
    const recovery = this.recoveryPromise || Promise.resolve();

    const drain = (async () => {
      if(generation)
        await this.terminateTrackedGeneration(generation);
      await recovery;
      await this.retryUndrainedGeneration();
    })();
    let reloadAttempt: Promise<void>;
    reloadAttempt = drain.then(
      () => {
        if(this.reloadPromise === reloadAttempt)
          this.reloadPromise = null;
        this.restartAttempts = 0;
        this.startGeneration();
      },
      (error) => {
        if(this.reloadPromise === reloadAttempt)
          this.reloadPromise = null;
        throw error;
      },
    );
    this.reloadPromise = reloadAttempt;
    return reloadAttempt;
  }

  public dispose(): Promise<void> {
    if(this.disposePromise)
      return this.disposePromise;
    this.disposed = true;
    this.verificationAdmissions.clear();
    this.clearRestartTimer();
    this.rejectAll(new Error("Zupass verifier is stopped."));
    const generation = this.generation;
    this.generation = null;
    if(generation)
      generation.phase = "stopping";
    const recovery = this.recoveryPromise || Promise.resolve();
    const reload = this.reloadPromise || Promise.resolve();

    const drain = (async () => {
      if(generation)
        await this.terminateTrackedGeneration(generation);
      await recovery;
      await reload;
      await this.retryUndrainedGeneration();
    })();
    let disposeAttempt: Promise<void>;
    disposeAttempt = drain.then(
      () => undefined,
      (error) => {
        if(this.disposePromise === disposeAttempt)
          this.disposePromise = null;
        throw error;
      },
    );
    this.disposePromise = disposeAttempt;
    return disposeAttempt;
  }

  private startGeneration(worker?: Worker): void {
    if(this.disposed
      || this.generation
      || this.reloadPromise
      || this.recoveryPromise
      || this.terminationState.kind === "undrained"
    ) {
      return;
    }

    let nextWorker: Worker;
    try {
      nextWorker = worker || this.workerFactory();
    } catch {
      this.scheduleRestart();
      return;
    }

    const generation: ZupassWorkerGeneration = {
      id: this.generationIdCounter++,
      worker: nextWorker,
      phase: "starting",
      initTimeout: null,
      activeRequestId: null,
    };
    this.generation = generation;
    nextWorker.on("message", (message) => this.onWorkerMessage(generation, message));
    nextWorker.on("error", (error) => this.recoverGeneration(generation, error));
    nextWorker.on("exit", (code) => {
      this.recoverGeneration(generation, new Error(`Zupass verifier worker exited (${code}).`));
    });
    generation.initTimeout = setTimeout(
      () => this.recoverGeneration(generation, new Error("Zupass verifier initialization timed out.")),
      this.initTimeoutMs,
    );
    generation.initTimeout.unref?.();
  }

  private onWorkerMessage(generation: ZupassWorkerGeneration, msg: unknown): void {
    if(this.generation !== generation || generation.phase === "stopping")
      return;
    if(!this.isRecord(msg) || typeof msg.action !== "string")
      return;
    switch(msg.action) {
      case "init":
        if(generation.phase !== "starting")
          return;
        if(generation.initTimeout)
          clearTimeout(generation.initTimeout);
        generation.initTimeout = null;
        generation.phase = "ready";
        this.restartAttempts = 0;
        this.dispatchNext();
        break;
      case "verified":
        this.onWorkerVerified(generation, msg.data);
        break;
      case "error":
        this.recoverGeneration(generation, new Error("Zupass verifier initialization failed."));
        break;
    }
  }

  private onWorkerVerified(generation: ZupassWorkerGeneration, msg: unknown): void {
    if(this.generation !== generation || generation.phase !== "ready")
      return;
    if(!this.isRecord(msg)
      || !Number.isSafeInteger(msg.reqId)
      || typeof msg.isValid !== "boolean"
      || msg.reqId !== generation.activeRequestId
    ) {
      return;
    }

    const pending = this.takeVerification(msg.reqId);
    if(pending)
      pending.result.resolve(msg.isValid);
    this.dispatchNext();
  }

  private dispatchNext(): void {
    const generation = this.generation;
    if(!generation || generation.phase !== "ready" || generation.activeRequestId !== null)
      return;

    const pending = [...this.verifyQueue.values()].find((entry) =>
      entry.generationId === generation.id && entry.phase === "queued"
    );
    if(!pending)
      return;

    pending.phase = "in-flight";
    generation.activeRequestId = pending.request.reqId;
    pending.timeout = setTimeout(
      () => this.timeoutVerification(pending.request.reqId),
      this.verifyTimeoutMs,
    );
    pending.timeout.unref?.();
    try {
      generation.worker.postMessage({
        action: "verify",
        data: pending.request,
      });
    } catch(error) {
      this.recoverGeneration(generation, error);
    }
  }

  private timeoutVerification(reqId: number): void {
    const pending = this.verifyQueue.get(reqId);
    if(!pending)
      return;

    const generation = this.generation;
    if(!generation || generation.id !== pending.generationId) {
      this.takeVerification(reqId);
      pending.result.reject(new Error("Zupass verifier is unavailable."));
      return;
    }
    this.recoverGeneration(generation, new Error("Zupass verification timed out."));
  }

  private takeVerification(reqId: number): PendingZupassVerification | undefined {
    const pending = this.verifyQueue.get(reqId);
    if(!pending)
      return undefined;

    if(pending.timeout)
      clearTimeout(pending.timeout);
    this.verifyQueue.delete(reqId);
    if(this.generation?.id === pending.generationId && this.generation.activeRequestId === reqId)
      this.generation.activeRequestId = null;
    return pending;
  }

  private recoverGeneration(generation: ZupassWorkerGeneration, error: unknown): void {
    if(this.disposed || this.generation !== generation || generation.phase === "stopping")
      return;
    generation.phase = "stopping";
    if(generation.initTimeout)
      clearTimeout(generation.initTimeout);
    generation.initTimeout = null;
    const failure = error instanceof Error
      ? new Error(`Zupass verifier failed: ${error.message}`)
      : new Error("Zupass verifier failed.");
    this.rejectGeneration(generation.id, failure);
    for(const admission of this.verificationAdmissions) {
      if(admission.generationId === generation.id)
        this.verificationAdmissions.delete(admission);
    }
    this.generation = null;

    let recovery: Promise<void>;
    recovery = this.terminateTrackedGeneration(generation).then(() => {
      if(this.recoveryPromise === recovery)
        this.recoveryPromise = null;
      this.scheduleRestart();
    }, () => {
      if(this.recoveryPromise === recovery)
        this.recoveryPromise = null;
    });
    this.recoveryPromise = recovery;
  }

  private async terminateTrackedGeneration(generation: ZupassWorkerGeneration): Promise<void> {
    try {
      await this.terminateGeneration(generation);
    } catch(error) {
      this.terminationState = {kind: "undrained", generation};
      throw error;
    }
    if(this.terminationState.kind === "undrained" && this.terminationState.generation === generation)
      this.terminationState = {kind: "drained"};
  }

  private retryUndrainedGeneration(): Promise<void> {
    const terminationState = this.terminationState;
    return terminationState.kind === "undrained"
      ? this.terminateTrackedGeneration(terminationState.generation)
      : Promise.resolve();
  }

  private async terminateGeneration(generation: ZupassWorkerGeneration): Promise<void> {
    generation.phase = "stopping";
    if(generation.initTimeout)
      clearTimeout(generation.initTimeout);
    generation.initTimeout = null;
    generation.worker.removeAllListeners();
    await generation.worker.terminate();
  }

  private scheduleRestart(): void {
    if(this.disposed
      || this.generation
      || this.reloadPromise
      || this.recoveryPromise
      || this.restartTimer
      || this.terminationState.kind === "undrained"
    ) {
      return;
    }
    const delay = Math.min(
      this.restartBackoffMs * (2 ** Math.min(this.restartAttempts, 30)),
      this.maxRestartBackoffMs,
    );
    this.restartAttempts++;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.startGeneration();
    }, delay);
    this.restartTimer.unref?.();
  }

  private clearRestartTimer(): void {
    if(!this.restartTimer)
      return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private rejectGeneration(generationId: number, error: Error): void {
    for(const [reqId, pending] of [...this.verifyQueue]) {
      if(pending.generationId !== generationId)
        continue;
      this.takeVerification(reqId)?.result.reject(error);
    }
  }

  private rejectAll(error: Error): void {
    for(const reqId of [...this.verifyQueue.keys()]) {
      const pending = this.takeVerification(reqId);
      if(pending)
        pending.result.reject(error);
    }
  }

  private normalizeTicket(value: unknown): ZKEdDSAEventTicketPCD {
    if(!isRecord(value))
      throw new Error("Zupass ticket payload has an invalid structure.");
    const id = value.id;
    const claim = parseTicketClaim(value.claim);
    const proof = parseGroth16Proof(value.proof);
    requireDefinedParameter(id, "id");
    if(!isBoundedString(id, MAX_PCD_ID_LENGTH)
      || (value.type !== undefined && value.type !== ZKEdDSAEventTicketPCDTypeName)
      || !claim
      || !proof
    ) {
      throw new Error("Zupass ticket payload has an invalid structure.");
    }
    return new ZKEdDSAEventTicketPCD(id, claim, proof);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  public getTicketData(
    pcd: ZKEdDSAEventTicketPCD,
    policy = this.module.getVerifierPolicy(),
  ): IZupassPDCData {
    let ticketData: IZupassPDCData = {
      ticketId: pcd.claim.partialTicket.ticketId || "",
      productId: pcd.claim.partialTicket.productId || "",
      eventId: pcd.claim.partialTicket.eventId || "",
      attendeeId: pcd.claim.partialTicket.attendeeSemaphoreId || "",
      token: "",
    };
    ticketData.token = this.generateFaucetToken(ticketData, undefined, policy);
    return ticketData;
  }

  private getTokenPassphrase() {
    return faucetConfig.faucetSecret + "-" + this.module.getModuleName() + "-authtoken";
  }

  public generateFaucetToken(
    pcdData: IZupassPDCData,
    now = Math.floor(Date.now() / 1000),
    policy: ZupassVerifierPolicy = this.module.getVerifierPolicy(),
  ): string {
    const payload = createZupassTokenPayload({
      ticketId: pcdData.ticketId,
      productId: pcdData.productId,
      eventId: pcdData.eventId,
      attendeeId: pcdData.attendeeId,
    }, policy, now);

    return encryptTokenPayload(payload, this.getTokenPassphrase());
  }

  public parseFaucetToken(faucetToken: string, now = Math.floor(Date.now() / 1000)): IZupassPDCData | null {
    const decryptedPayload = decryptTokenPayload(faucetToken, this.getTokenPassphrase());
    const payload = parseZupassTokenPayload(decryptedPayload, this.module.getVerifierPolicy(), now);
    if(!payload)
      return null;

    return {
      ticketId: payload.ticketId,
      productId: payload.productId,
      eventId: payload.eventId,
      attendeeId: payload.attendeeId,
      token: faucetToken,
    };
  }

}
