import { clearInterval } from "timers";
import { ServiceManager } from "../../common/ServiceManager.js";
import { FaucetLogLevel, FaucetProcess } from "../../common/FaucetProcess.js";
import { faucetConfig } from "../../config/FaucetConfig.js";
import {
  FaucetDatabase,
  type SessionCleanupCandidate,
} from "../../db/FaucetDatabase.js";
import { registerDefaultSessionCleanupGuard } from "../../db/SessionCleanupGuards.js";
import { ClaimTxStatus, EthClaimInfo, isClaimData } from "../../eth/EthClaim.js";
import { EthWalletManager, FaucetCoinType } from "../../eth/EthWalletManager.js";
import { FaucetSession, FaucetSessionStatus, FaucetSessionStoreData } from "../../session/FaucetSession.js";
import { ISessionRewardFactor } from "../../session/SessionRewardFactor.js";
import { BaseModule } from "../BaseModule.js";
import { ModuleHookAction } from "../ModuleManager.js";
import { defaultConfig, IFaucetOutflowConfig } from "./FaucetOutflowConfig.js";

const OUTFLOW_STATE_KEY = "PoWOutflowLimiter.state";
const CLAIM_FEE_CLEANUP_GUARD_OWNER = "faucet-outflow.claim-fees";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getClaimFeeMarkerLimit(): number {
  if(!Number.isSafeInteger(faucetConfig.ethMaxPending) || faucetConfig.ethMaxPending < 0)
    throw new Error("ethMaxPending must be a non-negative safe integer");
  let limit = Math.max(1, faucetConfig.ethMaxPending) * 2;
  if(!Number.isSafeInteger(limit))
    throw new Error("ethMaxPending is too large for bounded claim-fee accounting");
  return limit;
}

function parseClaimFeeMarkers(value: unknown): Record<string, string> {
  if(!isRecord(value))
    throw new Error("Invalid persisted faucet outflow state");

  let markers: Record<string, string> = {};
  let entries = Object.entries(value);
  if(entries.length > getClaimFeeMarkerLimit())
    throw new Error("Persisted faucet outflow claim-fee marker bound exceeded");
  for(let [txHash, sessionId] of entries) {
    if(!/^0x[0-9a-f]{64}$/i.test(txHash) || typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 128)
      throw new Error("Invalid persisted faucet outflow claim-fee marker");
    let normalizedHash = txHash.toLowerCase();
    if(markers[normalizedHash] !== undefined && markers[normalizedHash] !== sessionId)
      throw new Error("Conflicting persisted faucet outflow claim-fee markers");
    markers[normalizedHash] = sessionId;
  }
  return markers;
}

function parsePersistedClaimFeeMarkers(stateJson: string): Record<string, string> {
  let state: unknown;
  try {
    state = JSON.parse(stateJson);
  } catch {
    throw new Error("Invalid persisted faucet outflow state");
  }
  if(!isRecord(state))
    throw new Error("Invalid persisted faucet outflow state");
  if(state.version === 3)
    return parseClaimFeeMarkers(state.accountedClaimFees);
  if(state.version === undefined || state.version === 2)
    return {};
  throw new Error("Unsupported persisted faucet outflow state version");
}

async function canCleanupPersistedClaimFee(
  database: FaucetDatabase,
  session: SessionCleanupCandidate,
): Promise<boolean> {
  if(
    session.status !== FaucetSessionStatus.FINISHED
    || !isClaimData(session.claim)
    || session.claim.claimStatus !== ClaimTxStatus.CONFIRMED
  ) {
    return true;
  }

  let stateJson = await database.getKeyValueEntry(OUTFLOW_STATE_KEY);
  if(stateJson === null || stateJson === undefined)
    return true;
  let markers = parsePersistedClaimFeeMarkers(stateJson);
  let txHash = session.claim.txHash.toLowerCase();
  let markerOwner = markers[txHash];
  if(markerOwner !== undefined && markerOwner !== session.sessionId)
    throw new Error("Finalized claim fee marker is owned by another session");
  for(let [markedHash, markedSession] of Object.entries(markers)) {
    if(markedSession === session.sessionId && markedHash !== txHash)
      throw new Error("Finalized session owns a conflicting claim fee marker");
  }
  return markerOwner === undefined;
}

registerDefaultSessionCleanupGuard(CLAIM_FEE_CLEANUP_GUARD_OWNER, canCleanupPersistedClaimFee);

interface OutflowPolicy {
  amount: bigint;
  duration: number;
  lowerLimit: bigint;
  upperLimit: bigint;
}

interface OutflowState {
  version: 3;
  balanceNumerator: bigint;
  balanceDenominator: bigint;
  updateTime: number;
  rateAmount: bigint;
  rateDuration: number;
  accountedClaimFees: Record<string, string>;
}

interface FaucetOutflowRuntimeState {
  outflowState: OutflowState;
  policy: OutflowPolicy;
}

type FaucetOutflowWriteOwnership =
  | {kind: "certain", durableJson: string | null}
  | {
      kind: "uncertain";
      previousJson: string | null;
      nextJson: string;
      previousRuntime: FaucetOutflowRuntimeState;
      nextRuntime: FaucetOutflowRuntimeState;
      writeError: unknown;
    };

export interface FaucetOutflowDebugState {
  now: number;
  updateTime: number;
  balance: string;
  balanceNumerator: string;
  balanceDenominator: string;
  restriction: number;
  amount: string;
  duration: number;
  lowerLimit: string;
  upperLimit: string;
}

export class FaucetOutflowModule extends BaseModule<IFaucetOutflowConfig> {
  protected readonly moduleDefaultConfig = defaultConfig;
  private outflowState: OutflowState;
  private policy: OutflowPolicy;
  private saveTimer: NodeJS.Timeout;
  private stateOperationPromise: Promise<void> = Promise.resolve();
  private uncertainClaimFee: {txHash: string; session: string} | null = null;
  private writeOwnership: FaucetOutflowWriteOwnership = {kind: "certain", durableJson: null};
  private disposeCleanupGuard: (() => void) | null = null;

  protected override async startModule(): Promise<void> {
    this.disposeCleanupGuard = ServiceManager.GetService(FaucetDatabase).registerSessionCleanupGuard(
      CLAIM_FEE_CLEANUP_GUARD_OWNER,
      (candidate) => this.canCleanupSession(candidate),
    );
    this.policy = this.parsePolicy(this.moduleConfig);
    await this.runStateOperation(async () => {
      await this.loadOutflowStateInternal();
      let previousRuntime = this.getRuntimeSnapshot();
      this.installPolicy(this.policy);
      this.enforceBalanceBoundaries();
      await this.pruneFinalizedClaimFees(this.outflowState);
      await this.persistOutflowState(previousRuntime);
    });

    this.saveTimer = setInterval(() => {
      this.saveOutflowState().catch((ex) => {
        ServiceManager.GetService(FaucetProcess).emitLog(
          FaucetLogLevel.ERROR,
          "Could not save faucet outflow state: " + String(ex),
        );
      });
    }, 60 * 1000);
    this.moduleManager.addActionHook(
      this,
      ModuleHookAction.SessionRewardFactor,
      5,
      "faucet outflow",
      (session: FaucetSession, rewardFactors: ISessionRewardFactor[]) => this.processSessionRewardFactor(session, rewardFactors),
    );
    this.moduleManager.addActionHook(
      this,
      ModuleHookAction.SessionRewarded,
      5,
      "faucet outflow",
      (session: FaucetSession, amount: bigint) => this.updateState(session, amount),
    );
    this.moduleManager.addActionHook(
      this,
      ModuleHookAction.SessionClaimed,
      5,
      "faucet outflow native claim fee",
      (claimInfo: EthClaimInfo) => this.processSessionClaimed(claimInfo),
    );
  }

  protected override async stopModule(): Promise<void> {
    if(this.saveTimer)
      clearInterval(this.saveTimer);
    this.saveTimer = null;
    try {
      if(this.outflowState)
        await this.saveOutflowState();
    } finally {
      this.disposeCleanupGuard?.();
      this.disposeCleanupGuard = null;
    }
  }

  protected override async onConfigReload(): Promise<void> {
    let nextPolicy = this.parsePolicy(this.moduleConfig);
    await this.runStateOperation(async () => {
      let previousRuntime = this.getRuntimeSnapshot();
      try {
        this.installPolicy(nextPolicy);
        this.policy = nextPolicy;
        this.enforceBalanceBoundaries();
        await this.persistOutflowState(previousRuntime);
      } catch(ex) {
        if(this.writeOwnership.kind === "certain")
          this.setRuntimeSnapshot(previousRuntime);
        throw ex;
      }
    });
  }

  private async processSessionRewardFactor(
    session: FaucetSession,
    rewardFactors: ISessionRewardFactor[],
  ): Promise<void> {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    let outflowRestriction = this.getOutflowRestriction();
    if(outflowRestriction < 100) {
      rewardFactors.push({
        factor: outflowRestriction / 100,
        module: this.moduleName,
      });
    }
  }

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }

  public loadOutflowState(): Promise<void> {
    return this.runStateOperation(() => this.loadOutflowStateInternal());
  }

  private async loadOutflowStateInternal(): Promise<void> {
    let stateJson = this.normalizeStoredJson(
      await ServiceManager.GetService(FaucetDatabase).getKeyValueEntry(OUTFLOW_STATE_KEY),
    );
    this.writeOwnership = {kind: "certain", durableJson: stateJson};
    if(!stateJson) {
      if(this.uncertainClaimFee)
        throw new Error("Faucet outflow state disappeared during uncertain claim-fee accounting");
      this.outflowState = this.createEmptyState();
      return;
    }
    this.outflowState = this.parsePersistedState(stateJson);
    this.resolveUncertainClaimFee(this.outflowState);
  }

  public saveOutflowState(): Promise<void> {
    return this.runStateOperation(async () => {
      if(!this.outflowState)
        return;
      let previousRuntime = this.getRuntimeSnapshot();
      try {
        await this.pruneFinalizedClaimFees(this.outflowState);
        await this.persistOutflowState(previousRuntime);
      } catch(ex) {
        if(this.writeOwnership.kind === "certain")
          this.setRuntimeSnapshot(previousRuntime);
        throw ex;
      }
    });
  }

  private async persistOutflowState(previousRuntime = this.getRuntimeSnapshot()): Promise<void> {
    if(!this.outflowState)
      return;
    await this.reconcileWriteOwnership();
    if(this.writeOwnership.kind !== "certain")
      throw new Error("Faucet outflow state write ownership is uncertain");
    if(this.uncertainClaimFee)
      throw new Error("Faucet outflow persistence is blocked by uncertain claim-fee accounting");

    const previousJson = this.writeOwnership.durableJson;
    const nextRuntime = this.getRuntimeSnapshot();
    const nextJson = this.serializeState(nextRuntime.outflowState);
    const database = ServiceManager.GetService(FaucetDatabase);
    try {
      await database.setKeyValueEntry(OUTFLOW_STATE_KEY, nextJson);
      this.writeOwnership = {kind: "certain", durableJson: nextJson};
    } catch(writeError) {
      const uncertain: FaucetOutflowWriteOwnership = {
        kind: "uncertain",
        previousJson,
        nextJson,
        previousRuntime,
        nextRuntime,
        writeError,
      };
      this.writeOwnership = uncertain;
      let observedJson: string | null;
      try {
        observedJson = this.normalizeStoredJson(await database.getKeyValueEntry(OUTFLOW_STATE_KEY));
      } catch(readError) {
        throw new AggregateError(
          [writeError, readError],
          "Faucet outflow state write is uncertain: " + String(writeError) + "; reconciliation failed: " + String(readError),
        );
      }
      if(observedJson === nextJson) {
        this.setRuntimeSnapshot(nextRuntime);
        this.writeOwnership = {kind: "certain", durableJson: nextJson};
        return;
      }
      if(observedJson === previousJson) {
        this.setRuntimeSnapshot(previousRuntime);
        this.writeOwnership = {kind: "certain", durableJson: previousJson};
        throw writeError;
      }
      throw new Error("Faucet outflow state write ownership is uncertain because durable state diverged");
    }
  }

  public async updateState(session: FaucetSession, minedAmount: bigint): Promise<void> {
    if(session && session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    if(typeof minedAmount !== "bigint" || minedAmount < 0n)
      return;

    await this.runStateOperation(async () => {
      let previousRuntime = this.getRuntimeSnapshot();
      try {
        this.settleBalance();
        this.clampUpperLimit();
        this.outflowState.balanceNumerator -= minedAmount * this.outflowState.balanceDenominator;
        this.normalizeBalance();
        await this.persistOutflowState(previousRuntime);
      } catch(ex) {
        if(this.writeOwnership.kind === "certain")
          this.setRuntimeSnapshot(previousRuntime);
        throw ex;
      }
    });
  }

  private async processSessionClaimed(claimInfo: EthClaimInfo): Promise<void> {
    if(!claimInfo || !isClaimData(claimInfo.claim) || claimInfo.claim.claimStatus !== ClaimTxStatus.CONFIRMED)
      throw new Error("Faucet outflow received an invalid confirmed claim");
    if(ServiceManager.GetService(EthWalletManager).getClaimCoinType(claimInfo.claim) !== FaucetCoinType.NATIVE)
      return;

    await this.runStateOperation(() => this.accountConfirmedNativeClaimFee(claimInfo));
  }

  private async accountConfirmedNativeClaimFee(claimInfo: EthClaimInfo): Promise<void> {
    let claim = claimInfo.claim;
    if(claim.claimStatus !== ClaimTxStatus.CONFIRMED)
      throw new Error("Cannot account a non-confirmed claim fee");

    let database = ServiceManager.GetService(FaucetDatabase);
    let txHash = claim.txHash.toLowerCase();
    let txFee = BigInt(claim.txFee);
    while(true) {
      let persistedJson = await database.getKeyValueEntry(OUTFLOW_STATE_KEY);
      if(persistedJson === null || persistedJson === undefined)
        throw new Error("Faucet outflow state disappeared while accounting a claim fee");
      let persistedState = this.parsePersistedState(persistedJson);
      this.resolveUncertainClaimFee(persistedState);
      this.writeOwnership = {kind: "certain", durableJson: persistedJson};
      let existingSession = persistedState.accountedClaimFees[txHash];
      if(existingSession !== undefined) {
        if(existingSession !== claimInfo.session)
          throw new Error("Claim transaction hash is already owned by another session");
        this.outflowState = persistedState;
        return;
      }

      let storedSession = await database.getSession(claimInfo.session);
      if(this.isDurablyFinalizedClaim(storedSession, txHash)) {
        // A late duplicate hook can arrive after a finalized marker was already
        // pruned. FINISHED is the durable proof that the fee was owned earlier.
        this.outflowState = persistedState;
        return;
      }
      if(
        !storedSession
        || storedSession.status !== FaucetSessionStatus.CLAIMING
        || !isClaimData(storedSession.claim)
        || storedSession.claim.claimStatus !== ClaimTxStatus.CONFIRMED
        || storedSession.claim.txHash.toLowerCase() !== txHash
        || JSON.stringify(storedSession.claim) !== JSON.stringify(claim)
      ) {
        throw new Error("Confirmed claim fee accounting lost durable session ownership");
      }

      await this.pruneFinalizedClaimFees(persistedState);
      if(Object.keys(persistedState.accountedClaimFees).length >= getClaimFeeMarkerLimit())
        throw new Error("Faucet outflow claim-fee marker bound reached");

      let previousState = this.cloneState(this.outflowState);
      this.outflowState = persistedState;
      this.settleBalance();
      this.clampUpperLimit();
      this.outflowState.balanceNumerator -= txFee * this.outflowState.balanceDenominator;
      this.outflowState.accountedClaimFees[txHash] = claimInfo.session;
      this.normalizeBalance();
      let nextJson = this.serializeState(this.outflowState);

      try {
        if(await database.compareAndSetKeyValueEntry(OUTFLOW_STATE_KEY, persistedJson, nextJson)) {
          this.writeOwnership = {kind: "certain", durableJson: nextJson};
          return;
        }
      } catch(ex) {
        this.outflowState = previousState;
        this.uncertainClaimFee = {txHash, session: claimInfo.session};
        let observedJson: string;
        try {
          observedJson = await database.getKeyValueEntry(OUTFLOW_STATE_KEY);
        } catch {
          throw ex;
        }
        if(observedJson !== null && observedJson !== undefined) {
          let observedState = this.parsePersistedState(observedJson);
          this.resolveUncertainClaimFee(observedState);
          this.outflowState = observedState;
          this.writeOwnership = {kind: "certain", durableJson: observedJson};
          let observedSession = observedState.accountedClaimFees[txHash];
          if(observedSession === claimInfo.session)
            return;
          if(observedSession !== undefined)
            throw new Error("Claim transaction hash is already owned by another session");
        }
        throw ex;
      }

      this.outflowState = previousState;
    }
  }

  private async pruneFinalizedClaimFees(state: OutflowState): Promise<void> {
    let database = ServiceManager.GetService(FaucetDatabase);
    for(let [txHash, sessionId] of Object.entries(state.accountedClaimFees)) {
      let storedSession = await database.getSession(sessionId);
      if(this.isDurablyFinalizedClaim(storedSession, txHash))
        delete state.accountedClaimFees[txHash];
    }
  }

  private canCleanupSession(session: SessionCleanupCandidate): Promise<boolean> {
    if(
      session.status !== FaucetSessionStatus.FINISHED
      || !isClaimData(session.claim)
      || session.claim.claimStatus !== ClaimTxStatus.CONFIRMED
    ) {
      return Promise.resolve(true);
    }

    return this.runStateOperation(async () => {
      return canCleanupPersistedClaimFee(
        ServiceManager.GetService(FaucetDatabase),
        session,
      );
    });
  }

  private isDurablyFinalizedClaim(
    session: FaucetSessionStoreData | null,
    txHash: string,
  ): boolean {
    return session?.status === FaucetSessionStatus.FINISHED
      && isClaimData(session.claim)
      && session.claim.claimStatus === ClaimTxStatus.CONFIRMED
      && session.claim.txHash.toLowerCase() === txHash;
  }

  private parsePersistedState(stateJson: string): OutflowState {
    let stateObj: unknown;
    try {
      stateObj = JSON.parse(stateJson);
    } catch {
      throw new Error("Invalid persisted faucet outflow state");
    }
    if(!isRecord(stateObj))
      throw new Error("Invalid persisted faucet outflow state");
    if(stateObj.version === 3)
      return this.parseVersionThreeState(stateObj);
    if(stateObj.version === 2)
      return this.migrateVersionTwoState(stateObj);
    if(stateObj.version !== undefined)
      throw new Error("Unsupported persisted faucet outflow state version");
    return this.migrateLegacyState(stateObj);
  }

  private serializeState(state: OutflowState): string {
    let accountedClaimFees: Record<string, string> = {};
    for(let txHash of Object.keys(state.accountedClaimFees).sort())
      accountedClaimFees[txHash] = state.accountedClaimFees[txHash];
    return JSON.stringify({
      version: 3,
      balanceNumerator: state.balanceNumerator.toString(),
      balanceDenominator: state.balanceDenominator.toString(),
      updateTime: state.updateTime,
      rateAmount: state.rateAmount.toString(),
      rateDuration: state.rateDuration,
      accountedClaimFees,
    });
  }

  private resolveUncertainClaimFee(state: OutflowState): void {
    if(!this.uncertainClaimFee)
      return;
    let observedSession = state.accountedClaimFees[this.uncertainClaimFee.txHash];
    if(observedSession !== undefined && observedSession !== this.uncertainClaimFee.session)
      throw new Error("Uncertain claim transaction hash is owned by another session");
    this.uncertainClaimFee = null;
  }

  private createEmptyState(): OutflowState {
    return {
      version: 3,
      balanceNumerator: 0n,
      balanceDenominator: 1n,
      updateTime: this.now(),
      rateAmount: this.policy.amount,
      rateDuration: this.policy.duration,
      accountedClaimFees: {},
    };
  }

  private parseVersionThreeState(state: Record<string, unknown>): OutflowState {
    let result = this.parseVersionTwoStateFields(state);
    result.accountedClaimFees = parseClaimFeeMarkers(state.accountedClaimFees);
    return result;
  }

  private migrateVersionTwoState(state: Record<string, unknown>): OutflowState {
    return this.parseVersionTwoStateFields(state);
  }

  private parseVersionTwoStateFields(state: Record<string, unknown>): OutflowState {
    if(
      !this.isSignedDecimal(state.balanceNumerator)
      || !this.isUnsignedDecimal(state.balanceDenominator)
      || BigInt(state.balanceDenominator as string) === 0n
      || !Number.isSafeInteger(state.updateTime)
      || Number(state.updateTime) < 0
      || !this.isUnsignedDecimal(state.rateAmount)
      || !Number.isSafeInteger(state.rateDuration)
      || Number(state.rateDuration) <= 0
    ) {
      throw new Error("Invalid persisted faucet outflow state");
    }

    let stateResult: OutflowState = {
      version: 3,
      balanceNumerator: BigInt(state.balanceNumerator as string),
      balanceDenominator: BigInt(state.balanceDenominator as string),
      updateTime: Number(state.updateTime),
      rateAmount: BigInt(state.rateAmount as string),
      rateDuration: Number(state.rateDuration),
      accountedClaimFees: {},
    };
    this.normalizeBalance(stateResult);
    return stateResult;
  }

  private migrateLegacyState(state: Record<string, unknown>): OutflowState {
    if(
      !Number.isSafeInteger(state.trackTime)
      || (state.dustAmount !== undefined && !this.isUnsignedDecimal(state.dustAmount))
    ) {
      throw new Error("Invalid persisted faucet outflow state");
    }

    let now = this.now();
    let elapsed = BigInt(now - Number(state.trackTime));
    let balance = elapsed * this.policy.amount / BigInt(this.policy.duration);
    if(state.dustAmount !== undefined)
      balance += BigInt(state.dustAmount as string);
    return {
      version: 3,
      balanceNumerator: balance,
      balanceDenominator: 1n,
      updateTime: now,
      rateAmount: this.policy.amount,
      rateDuration: this.policy.duration,
      accountedClaimFees: {},
    };
  }

  private installPolicy(policy: OutflowPolicy): void {
    this.settleBalance();
    this.outflowState.rateAmount = policy.amount;
    this.outflowState.rateDuration = policy.duration;
  }

  private settleBalance(): void {
    if(this.writeOwnership.kind === "uncertain")
      return;
    let now = this.now();
    let elapsed = now - this.outflowState.updateTime;
    if(elapsed <= 0)
      return;

    let rateDuration = BigInt(this.outflowState.rateDuration);
    this.outflowState.balanceNumerator =
      this.outflowState.balanceNumerator * rateDuration
      + BigInt(elapsed) * this.outflowState.rateAmount * this.outflowState.balanceDenominator;
    this.outflowState.balanceDenominator *= rateDuration;
    this.outflowState.updateTime = now;
    this.normalizeBalance();
  }

  private enforceBalanceBoundaries(): void {
    this.settleBalance();
    this.clampUpperLimit();
    if(this.compareBalance(this.policy.lowerLimit) < 0)
      this.setBalance(this.policy.lowerLimit);
  }

  private clampUpperLimit(): void {
    if(this.compareBalance(this.policy.upperLimit) > 0)
      this.setBalance(this.policy.upperLimit);
  }

  private getOutflowBalance(): bigint {
    if(this.writeOwnership.kind === "uncertain")
      return this.outflowState.balanceNumerator / this.outflowState.balanceDenominator;
    this.settleBalance();
    this.clampUpperLimit();
    return this.outflowState.balanceNumerator / this.outflowState.balanceDenominator;
  }

  private getOutflowRestriction(): number {
    if(this.writeOwnership.kind === "uncertain" || this.uncertainClaimFee)
      return 0;
    this.settleBalance();
    this.clampUpperLimit();
    if(this.compareBalance(0n) >= 0)
      return 100;
    if(this.policy.lowerLimit === 0n || this.compareBalance(this.policy.lowerLimit) <= 0)
      return 0;

    let distanceFromLower =
      this.outflowState.balanceNumerator
      - this.policy.lowerLimit * this.outflowState.balanceDenominator;
    let fullRange = -this.policy.lowerLimit * this.outflowState.balanceDenominator;
    let basisPoints = 10000n * distanceFromLower / fullRange;
    return Number(basisPoints) / 100;
  }

  public getOutflowDebugState(): FaucetOutflowDebugState {
    let balance = this.getOutflowBalance();
    return {
      now: this.now(),
      updateTime: this.outflowState.updateTime,
      balance: balance.toString(),
      balanceNumerator: this.outflowState.balanceNumerator.toString(),
      balanceDenominator: this.outflowState.balanceDenominator.toString(),
      restriction: this.getOutflowRestriction(),
      amount: this.policy.amount.toString(),
      duration: this.policy.duration,
      lowerLimit: this.policy.lowerLimit.toString(),
      upperLimit: this.policy.upperLimit.toString(),
    };
  }

  private parsePolicy(config: IFaucetOutflowConfig): OutflowPolicy {
    let policy: OutflowPolicy = {
      amount: this.parseConfigAmount("amount", config.amount),
      duration: config.duration,
      lowerLimit: this.parseConfigAmount("lowerLimit", config.lowerLimit, true),
      upperLimit: this.parseConfigAmount("upperLimit", config.upperLimit),
    };
    if(policy.amount <= 0n)
      throw new Error("faucet-outflow amount must be greater than zero");
    if(!Number.isSafeInteger(policy.duration) || policy.duration <= 0)
      throw new Error("faucet-outflow duration must be a positive safe integer");
    if(policy.lowerLimit > 0n)
      throw new Error("faucet-outflow lowerLimit must be zero or negative");
    if(policy.upperLimit < 0n)
      throw new Error("faucet-outflow upperLimit must be zero or positive");
    return policy;
  }

  private parseConfigAmount(name: string, value: number | string, signed = false): bigint {
    if(typeof value === "number") {
      if(!Number.isSafeInteger(value))
        throw new Error("faucet-outflow " + name + " must be a safe integer or decimal string");
      return BigInt(value);
    }
    let pattern = signed ? /^-?\d+$/ : /^\d+$/;
    if(typeof value !== "string" || !pattern.test(value))
      throw new Error("faucet-outflow " + name + " must be an integer decimal string");
    return BigInt(value);
  }

  private compareBalance(value: bigint): number {
    let difference = this.outflowState.balanceNumerator - value * this.outflowState.balanceDenominator;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }

  private setBalance(value: bigint): void {
    this.outflowState.balanceNumerator = value;
    this.outflowState.balanceDenominator = 1n;
  }

  private normalizeBalance(state = this.outflowState): void {
    if(state.balanceNumerator === 0n) {
      state.balanceDenominator = 1n;
      return;
    }
    let divisor = this.greatestCommonDivisor(
      state.balanceNumerator < 0n ? -state.balanceNumerator : state.balanceNumerator,
      state.balanceDenominator,
    );
    state.balanceNumerator /= divisor;
    state.balanceDenominator /= divisor;
  }

  private greatestCommonDivisor(left: bigint, right: bigint): bigint {
    while(right !== 0n) {
      let remainder = left % right;
      left = right;
      right = remainder;
    }
    return left;
  }

  private cloneState(state: OutflowState): OutflowState {
    return {
      ...state,
      accountedClaimFees: {...state.accountedClaimFees},
    };
  }

  private runStateOperation<T>(operation: () => Promise<T>): Promise<T> {
    let result = this.stateOperationPromise.catch(() => undefined).then(async () => {
      await this.reconcileWriteOwnership();
      return operation();
    });
    this.stateOperationPromise = result.then(() => undefined, () => undefined);
    return result;
  }

  private async reconcileWriteOwnership(): Promise<void> {
    if(this.writeOwnership.kind === "certain")
      return;
    const uncertain = this.writeOwnership;
    let observedJson: string | null;
    try {
      observedJson = this.normalizeStoredJson(
        await ServiceManager.GetService(FaucetDatabase).getKeyValueEntry(OUTFLOW_STATE_KEY),
      );
    } catch(readError) {
      throw new AggregateError(
        [uncertain.writeError, readError],
        "Faucet outflow state write ownership remains uncertain: " + String(readError),
      );
    }
    if(observedJson === uncertain.nextJson) {
      this.setRuntimeSnapshot(uncertain.nextRuntime);
      this.writeOwnership = {kind: "certain", durableJson: uncertain.nextJson};
      return;
    }
    if(observedJson === uncertain.previousJson) {
      this.setRuntimeSnapshot(uncertain.previousRuntime);
      this.writeOwnership = {kind: "certain", durableJson: uncertain.previousJson};
      return;
    }
    throw new Error("Faucet outflow state write ownership remains uncertain because durable state diverged");
  }

  private normalizeStoredJson(stateJson: string | null | undefined): string | null {
    return stateJson === null || stateJson === undefined ? null : stateJson;
  }

  private getRuntimeSnapshot(): FaucetOutflowRuntimeState {
    return {
      outflowState: this.cloneState(this.outflowState),
      policy: {...this.policy},
    };
  }

  private setRuntimeSnapshot(runtime: FaucetOutflowRuntimeState): void {
    this.outflowState = this.cloneState(runtime.outflowState);
    this.policy = {...runtime.policy};
  }

  private isUnsignedDecimal(value: unknown): value is string {
    return typeof value === "string" && /^\d+$/.test(value);
  }

  private isSignedDecimal(value: unknown): value is string {
    return typeof value === "string" && /^-?\d+$/.test(value);
  }
}
