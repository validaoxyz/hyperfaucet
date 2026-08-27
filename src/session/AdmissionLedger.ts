export type AdmissionPhase = "starting" | "running" | "committing";

export type AdmissionSubject =
  | {kind: "ip"; value: string}
  | {kind: "address"; value: string}
  | {kind: "principal"; namespace: string; value: string}
  | {kind: "scope"; namespace: string; value: string};

export interface AdmissionUsage {
  count: number;
  amount: bigint;
  sessionIds: Set<string>;
  amountsBySessionId: Map<string, bigint>;
  provisionalAmountSessionIds: Set<string>;
}

export interface AdmissionUsageOptions {
  minStartTime?: number;
  excludeSessionIds?: ReadonlySet<string>;
}

export interface AdmissionTotals {
  count: number;
  amount: bigint;
  hasProvisionalAmount: boolean;
}

export interface AdmissionSubjectMove {
  sessionId: string;
  oldSubject: AdmissionSubject;
  newSubject: AdmissionSubject;
  newSubjectWasBound: boolean;
}

interface AdmissionBinding {
  subject: AdmissionSubject;
  order: number;
}

interface AdmissionReservation {
  sessionId: string;
  startTime: number;
  phase: AdmissionPhase;
  claimCeiling: {
    state: "provisional" | "settled";
    amount: bigint;
  };
  bindings: Map<string, AdmissionBinding>;
}

export const admissionSubject = {
  ip: (value: string): AdmissionSubject => ({kind: "ip", value}),
  address: (value: string): AdmissionSubject => ({kind: "address", value}),
  principal: (namespace: string, value: string): AdmissionSubject => ({kind: "principal", namespace, value}),
  scope: (namespace: string, value: string): AdmissionSubject => ({kind: "scope", namespace, value}),
};

export function excludeCommittedUsage(
  usage: AdmissionUsage,
  committedSessionIds: Iterable<string>,
): AdmissionTotals {
  let committed = new Set(committedSessionIds);
  let count = 0;
  let amount = 0n;
  let hasProvisionalAmount = false;
  for(let [sessionId, claimCeiling] of usage.amountsBySessionId) {
    if(committed.has(sessionId))
      continue;
    count++;
    amount += claimCeiling;
    if(usage.provisionalAmountSessionIds.has(sessionId))
      hasProvisionalAmount = true;
  }
  return {count, amount, hasProvisionalAmount};
}

/**
 * Owns all in-process admission reservations. Methods are synchronous so a
 * reserve/check sequence cannot interleave with another JavaScript turn.
 */
export class AdmissionLedger {
  private readonly reservations = new Map<string, AdmissionReservation>();
  private readonly subjectIndex = new Map<string, Map<string, number>>();
  private nextBindingOrder = 0;

  public begin(
    sessionId: string,
    startTime: number,
    claimCeiling: bigint,
    subjects: AdmissionSubject[],
    claimCeilingSettled = false,
  ): void {
    if(this.reservations.has(sessionId))
      throw new Error("admission reservation already exists for session " + sessionId);

    this.reservations.set(sessionId, {
      sessionId,
      startTime,
      phase: "starting",
      claimCeiling: {
        state: claimCeilingSettled ? "settled" : "provisional",
        amount: this.normalizeAmount(claimCeiling),
      },
      bindings: new Map(),
    });
    this.bind(sessionId, subjects);
  }

  public bind(sessionId: string, subjects: AdmissionSubject[]): void {
    let reservation = this.requireReservation(sessionId);
    for(let subject of subjects) {
      let key = this.getSubjectKey(subject);
      if(reservation.bindings.has(key))
        continue;

      let order = ++this.nextBindingOrder;
      reservation.bindings.set(key, {subject, order});

      let indexedSessions = this.subjectIndex.get(key);
      if(!indexedSessions) {
        indexedSessions = new Map();
        this.subjectIndex.set(key, indexedSessions);
      }
      indexedSessions.set(sessionId, order);
    }
  }

  public getPriorUsage(
    sessionId: string,
    subjects: AdmissionSubject[],
    options: AdmissionUsageOptions = {},
  ): AdmissionUsage {
    let reservation = this.requireReservation(sessionId);
    let matchedSessionIds = new Set<string>();

    for(let subject of subjects) {
      let key = this.getSubjectKey(subject);
      let ownBinding = reservation.bindings.get(key);
      if(!ownBinding)
        throw new Error("admission subject must be bound before it is checked");

      let indexedSessions = this.subjectIndex.get(key);
      if(!indexedSessions)
        continue;

      for(let [otherSessionId, otherBindingOrder] of indexedSessions) {
        if(otherSessionId === sessionId || matchedSessionIds.has(otherSessionId))
          continue;
        if(options.excludeSessionIds?.has(otherSessionId))
          continue;

        let otherReservation = this.reservations.get(otherSessionId);
        if(!otherReservation)
          continue;
        if(options.minStartTime !== undefined && otherReservation.startTime < options.minStartTime)
          continue;
        if(otherReservation.phase === "starting" && otherBindingOrder >= ownBinding.order)
          continue;

        matchedSessionIds.add(otherSessionId);
      }
    }

    let amount = 0n;
    let amountsBySessionId = new Map<string, bigint>();
    let provisionalAmountSessionIds = new Set<string>();
    for(let matchedSessionId of matchedSessionIds) {
      let claimCeiling = this.reservations.get(matchedSessionId).claimCeiling;
      amount += claimCeiling.amount;
      amountsBySessionId.set(matchedSessionId, claimCeiling.amount);
      if(claimCeiling.state === "provisional")
        provisionalAmountSessionIds.add(matchedSessionId);
    }

    return {
      count: matchedSessionIds.size,
      amount,
      sessionIds: matchedSessionIds,
      amountsBySessionId,
      provisionalAmountSessionIds,
    };
  }

  public markRunning(sessionId: string): void {
    let reservation = this.requireReservation(sessionId);
    if(reservation.claimCeiling.state !== "settled")
      throw new Error("cannot run session with a provisional admission amount");
    reservation.phase = "running";
  }

  public markCommitting(sessionId: string): void {
    this.requireReservation(sessionId).phase = "committing";
  }

  public setClaimCeiling(sessionId: string, amount: bigint): void {
    this.requireReservation(sessionId).claimCeiling = {
      state: "settled",
      amount: this.normalizeAmount(amount),
    };
  }

  public reserveClaimCeiling(sessionId: string, amount: bigint): void {
    let reservation = this.requireReservation(sessionId);
    amount = this.normalizeAmount(amount);
    if(amount > reservation.claimCeiling.amount)
      reservation.claimCeiling.amount = amount;
  }

  public prepareMove(sessionId: string, oldSubject: AdmissionSubject, newSubject: AdmissionSubject): AdmissionSubjectMove {
    let reservation = this.requireReservation(sessionId);
    let newKey = this.getSubjectKey(newSubject);
    let newSubjectWasBound = reservation.bindings.has(newKey);
    this.bind(sessionId, [newSubject]);
    return {sessionId, oldSubject, newSubject, newSubjectWasBound};
  }

  public commitMove(move: AdmissionSubjectMove): void {
    if(this.getSubjectKey(move.oldSubject) !== this.getSubjectKey(move.newSubject))
      this.removeBinding(move.sessionId, move.oldSubject);
  }

  public abortMove(move: AdmissionSubjectMove): void {
    if(!move.newSubjectWasBound)
      this.removeBinding(move.sessionId, move.newSubject);
  }

  public release(sessionId: string): void {
    let reservation = this.reservations.get(sessionId);
    if(!reservation)
      return;
    for(let binding of reservation.bindings.values())
      this.removeIndexedSession(this.getSubjectKey(binding.subject), sessionId);
    this.reservations.delete(sessionId);
  }

  private removeBinding(sessionId: string, subject: AdmissionSubject): void {
    let reservation = this.reservations.get(sessionId);
    if(!reservation)
      return;
    let key = this.getSubjectKey(subject);
    if(!reservation.bindings.delete(key))
      return;
    this.removeIndexedSession(key, sessionId);
  }

  private removeIndexedSession(key: string, sessionId: string): void {
    let indexedSessions = this.subjectIndex.get(key);
    if(!indexedSessions)
      return;
    indexedSessions.delete(sessionId);
    if(indexedSessions.size === 0)
      this.subjectIndex.delete(key);
  }

  private requireReservation(sessionId: string): AdmissionReservation {
    let reservation = this.reservations.get(sessionId);
    if(!reservation)
      throw new Error("missing admission reservation for session " + sessionId);
    return reservation;
  }

  private normalizeAmount(amount: bigint): bigint {
    return amount < 0n ? 0n : amount;
  }

  private getSubjectKey(subject: AdmissionSubject): string {
    if(subject.kind === "ip" || subject.kind === "address")
      return JSON.stringify([subject.kind, subject.value]);
    return JSON.stringify([subject.kind, subject.namespace, subject.value]);
  }
}
