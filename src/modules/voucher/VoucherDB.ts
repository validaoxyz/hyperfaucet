import {
  FaucetDatabase,
  FaucetDbDriver,
  SessionCleanupCandidate,
} from '../../db/FaucetDatabase.js';
import { FaucetModuleDB } from '../../db/FaucetModuleDB.js';
import { SQL } from '../../db/SQL.js';
import { BaseDriver } from '../../db/driver/BaseDriver.js';
import { FaucetSessionStatus } from '../../session/FaucetSession.js';
import { ClaimTxStatus, isClaimData, type EthClaimData } from '../../eth/EthClaim.js';
import { createHash } from 'node:crypto';
import { faucetConfig } from '../../config/FaucetConfig.js';

const CLEANUP_CLAIM_DATA_HASH_DOMAIN = "hyperfaucet:voucher-cleanup:claim-data:v1\0";
const VOUCHER_SESSION_INDEX = "VouchersSessionIdIdx";

interface VoucherColumnSpec {
  readonly name: string;
  readonly sqliteDefinition: string;
  readonly sqliteType: "TEXT" | "INTEGER";
  readonly sqliteNotNull: 0 | 1;
  readonly primaryKey: boolean;
  readonly mysqlDefinition: string;
  readonly mysqlType: "varchar" | "char" | "int";
  readonly mysqlMaxLength: number | null;
  readonly mysqlNullable: "YES" | "NO";
}

const VOUCHER_BASE_COLUMNS = [
  {
    name: "Code",
    sqliteDefinition: "TEXT NOT NULL",
    sqliteType: "TEXT",
    sqliteNotNull: 1,
    primaryKey: true,
    mysqlDefinition: "VARCHAR(50) NOT NULL",
    mysqlType: "varchar",
    mysqlMaxLength: 50,
    mysqlNullable: "NO",
  },
  {
    name: "DropAmount",
    sqliteDefinition: "TEXT NOT NULL",
    sqliteType: "TEXT",
    sqliteNotNull: 1,
    primaryKey: false,
    mysqlDefinition: "VARCHAR(50) NOT NULL",
    mysqlType: "varchar",
    mysqlMaxLength: 50,
    mysqlNullable: "NO",
  },
  {
    name: "SessionId",
    sqliteDefinition: "TEXT NULL",
    sqliteType: "TEXT",
    sqliteNotNull: 0,
    primaryKey: false,
    mysqlDefinition: "CHAR(36) NULL",
    mysqlType: "char",
    mysqlMaxLength: 36,
    mysqlNullable: "YES",
  },
  {
    name: "TargetAddr",
    sqliteDefinition: "TEXT NULL",
    sqliteType: "TEXT",
    sqliteNotNull: 0,
    primaryKey: false,
    mysqlDefinition: "CHAR(42) NULL",
    mysqlType: "char",
    mysqlMaxLength: 42,
    mysqlNullable: "YES",
  },
  {
    name: "StartTime",
    sqliteDefinition: "INTEGER NULL",
    sqliteType: "INTEGER",
    sqliteNotNull: 0,
    primaryKey: false,
    mysqlDefinition: "INT(11) NULL",
    mysqlType: "int",
    mysqlMaxLength: null,
    mysqlNullable: "YES",
  },
] as const satisfies readonly VoucherColumnSpec[];

const VOUCHER_V3_COLUMNS = [
  {
    name: "CleanupVoucherCode",
    sqliteDefinition: "TEXT NULL",
    sqliteType: "TEXT",
    sqliteNotNull: 0,
    primaryKey: false,
    mysqlDefinition: "VARCHAR(50) NULL",
    mysqlType: "varchar",
    mysqlMaxLength: 50,
    mysqlNullable: "YES",
  },
  {
    name: "CleanupSessionId",
    sqliteDefinition: "TEXT NULL",
    sqliteType: "TEXT",
    sqliteNotNull: 0,
    primaryKey: false,
    mysqlDefinition: "CHAR(36) NULL",
    mysqlType: "char",
    mysqlMaxLength: 36,
    mysqlNullable: "YES",
  },
  {
    name: "CleanupStartTime",
    sqliteDefinition: "INTEGER NULL",
    sqliteType: "INTEGER",
    sqliteNotNull: 0,
    primaryKey: false,
    mysqlDefinition: "INT(11) NULL",
    mysqlType: "int",
    mysqlMaxLength: null,
    mysqlNullable: "YES",
  },
  {
    name: "CleanupTargetAddr",
    sqliteDefinition: "TEXT NULL",
    sqliteType: "TEXT",
    sqliteNotNull: 0,
    primaryKey: false,
    mysqlDefinition: "CHAR(42) NULL",
    mysqlType: "char",
    mysqlMaxLength: 42,
    mysqlNullable: "YES",
  },
  {
    name: "CleanupStatus",
    sqliteDefinition: "TEXT NULL",
    sqliteType: "TEXT",
    sqliteNotNull: 0,
    primaryKey: false,
    mysqlDefinition: "VARCHAR(10) NULL",
    mysqlType: "varchar",
    mysqlMaxLength: 10,
    mysqlNullable: "YES",
  },
  {
    name: "CleanupExpectedState",
    sqliteDefinition: "TEXT NULL",
    sqliteType: "TEXT",
    sqliteNotNull: 0,
    primaryKey: false,
    mysqlDefinition: "VARCHAR(10) NULL",
    mysqlType: "varchar",
    mysqlMaxLength: 10,
    mysqlNullable: "YES",
  },
  {
    name: "CleanupDataHash",
    sqliteDefinition: "TEXT NULL",
    sqliteType: "TEXT",
    sqliteNotNull: 0,
    primaryKey: false,
    mysqlDefinition: "CHAR(64) NULL",
    mysqlType: "char",
    mysqlMaxLength: 64,
    mysqlNullable: "YES",
  },
  {
    name: "CleanupClaimDataHash",
    sqliteDefinition: "TEXT NULL",
    sqliteType: "TEXT",
    sqliteNotNull: 0,
    primaryKey: false,
    mysqlDefinition: "CHAR(64) NULL",
    mysqlType: "char",
    mysqlMaxLength: 64,
    mysqlNullable: "YES",
  },
] as const satisfies readonly VoucherColumnSpec[];

export class VoucherCodeCollisionError extends Error {
  public constructor(cause?: unknown) {
    super("Voucher code already exists.", {cause});
    this.name = "VoucherCodeCollisionError";
  }
}

export enum VoucherState {
  AVAILABLE = "available",
  LEASED = "leased",
  CONSUMED = "consumed",
}

interface VoucherBase {
  code: string;
  dropAmount: string;
}

export type IVoucher =
  | VoucherBase & {
      state: VoucherState.AVAILABLE;
      sessionId: null;
      targetAddr: null;
      startTime: null;
    }
  | VoucherBase & {
      state: VoucherState.LEASED;
      sessionId: string;
      targetAddr: null;
      startTime: number;
    }
  | VoucherBase & {
      state: VoucherState.CONSUMED;
      sessionId: string;
      targetAddr: string;
      startTime: number;
    };

type ReservedVoucher = Exclude<IVoucher, {state: VoucherState.AVAILABLE}>;

type PersistedVoucherBinding =
  | {
      kind: "none";
      targetAddr: string;
      dataJson: string;
      dataHash: string;
    }
  | {
      kind: "voucher";
      voucherCode: string;
      targetAddr: string;
      dataJson: string;
      dataHash: string;
    };

type VoucherCleanupReceipt =
  | {kind: "none"}
  | {
      kind: "receipt";
      voucherCode: string;
      sessionId: string;
      startTime: number;
      targetAddr: string;
      status: FaucetSessionStatus.FAILED | FaucetSessionStatus.FINISHED;
      expectedState: VoucherState.LEASED | VoucherState.CONSUMED;
      dataHash: string;
      claimDataHash: string;
    };

type CleanupClaimDataSnapshot =
  | {
      kind: "none";
      claimDataJson: null;
      claimDataHash: string;
      claim: null;
    }
  | {
      kind: "claim";
      claimDataJson: string;
      claimDataHash: string;
      claim: EthClaimData;
    };

interface FailedSessionReservationSnapshot {
  readonly binding: PersistedVoucherBinding;
  readonly claimData: CleanupClaimDataSnapshot;
  readonly candidate: SessionCleanupCandidate;
}

type VoucherReservationSnapshot =
  | {kind: "missing"}
  | {kind: "invalid"}
  | {
      kind: "valid";
      voucher: IVoucher;
      receipt: VoucherCleanupReceipt;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  if(value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  return true;
}

function getRecordField(value: unknown, field: string): unknown {
  if(!isRecord(value))
    return undefined;
  return value[field];
}

function isValidOwner(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isValidTargetAddr(value: unknown): value is string {
  return typeof value === "string"
    && /^0x[0-9a-fA-F]{40}$/.test(value)
    && !/^0x0{40}$/i.test(value);
}

function hashCleanupClaimData(claimDataJson: string | null): string {
  const hash = createHash("sha256").update(CLEANUP_CLAIM_DATA_HASH_DOMAIN);
  if(claimDataJson === null)
    return hash.update("null").digest("hex");
  return hash.update("value\0").update(claimDataJson).digest("hex");
}

function decodeCleanupClaimData(
  status: FaucetSessionStatus,
  claimDataJson: unknown,
): CleanupClaimDataSnapshot | null {
  if(status !== FaucetSessionStatus.FAILED && status !== FaucetSessionStatus.FINISHED)
    return null;
  if(claimDataJson === null) {
    return {
      kind: "none",
      claimDataJson: null,
      claimDataHash: hashCleanupClaimData(null),
      claim: null,
    };
  }
  if(typeof claimDataJson !== "string")
    return null;

  let claim: unknown;
  try {
    claim = JSON.parse(claimDataJson);
  } catch {
    return null;
  }
  if(!isClaimData(claim))
    return null;

  const eligible = status === FaucetSessionStatus.FAILED
    ? claim.claimStatus === ClaimTxStatus.FAILED || claim.claimStatus === ClaimTxStatus.REVERTED
    : status === FaucetSessionStatus.FINISHED && claim.claimStatus === ClaimTxStatus.CONFIRMED;
  if(!eligible)
    return null;
  return {
    kind: "claim",
    claimDataJson,
    claimDataHash: hashCleanupClaimData(claimDataJson),
    claim,
  };
}

function decodePersistedVoucherBinding(value: unknown): PersistedVoucherBinding | null {
  const dataJson = getRecordField(value, "Data");
  const targetAddr = getRecordField(value, "TargetAddr");
  if(typeof dataJson !== "string")
    return null;
  if(!isValidTargetAddr(targetAddr))
    return null;

  let data: unknown;
  try {
    data = JSON.parse(dataJson);
  } catch {
    return null;
  }
  if(!isRecord(data))
    return null;
  const dataHash = createHash("sha256").update(dataJson).digest("hex");
  if(!Object.prototype.hasOwnProperty.call(data, "voucherCode")) {
    return {
      kind: "none",
      targetAddr,
      dataJson,
      dataHash,
    };
  }

  const voucherCode = data.voucherCode;
  if(typeof voucherCode !== "string" || voucherCode.length === 0)
    return null;
  return {
    kind: "voucher",
    voucherCode,
    targetAddr,
    dataJson,
    dataHash,
  };
}

function decodeCleanupReceipt(value: unknown): VoucherCleanupReceipt | null {
  const voucherCode = getRecordField(value, "CleanupVoucherCode");
  const sessionId = getRecordField(value, "CleanupSessionId");
  const startTime = getRecordField(value, "CleanupStartTime");
  const targetAddr = getRecordField(value, "CleanupTargetAddr");
  const status = getRecordField(value, "CleanupStatus");
  const expectedState = getRecordField(value, "CleanupExpectedState");
  const dataHash = getRecordField(value, "CleanupDataHash");
  const claimDataHash = getRecordField(value, "CleanupClaimDataHash");
  const rowCode = getRecordField(value, "Code");
  const fields = [
    voucherCode,
    sessionId,
    startTime,
    targetAddr,
    status,
    expectedState,
    dataHash,
    claimDataHash,
  ];
  if(fields.every((field) => field === null))
    return {kind: "none"};
  if(
    typeof voucherCode !== "string"
    || voucherCode.length === 0
    || voucherCode !== rowCode
    || !isValidOwner(sessionId)
    || !isValidTimestamp(startTime)
    || !isValidTargetAddr(targetAddr)
    || (status !== FaucetSessionStatus.FAILED && status !== FaucetSessionStatus.FINISHED)
    || (expectedState !== VoucherState.LEASED && expectedState !== VoucherState.CONSUMED)
    || typeof dataHash !== "string"
    || !/^[0-9a-f]{64}$/.test(dataHash)
    || typeof claimDataHash !== "string"
    || !/^[0-9a-f]{64}$/.test(claimDataHash)
  ) {
    return null;
  }
  return {
    kind: "receipt",
    voucherCode,
    sessionId,
    startTime,
    targetAddr,
    status,
    expectedState,
    dataHash,
    claimDataHash,
  };
}

export class VoucherDB extends FaucetModuleDB {
  protected override latestSchemaVersion = 3;

  private static voucherFromRow(value: unknown): IVoucher {
    const code = getRecordField(value, "Code");
    const dropAmount = getRecordField(value, "DropAmount");
    const sessionId = getRecordField(value, "SessionId");
    const targetAddr = getRecordField(value, "TargetAddr");
    const startTime = getRecordField(value, "StartTime");
    if(typeof code !== "string" || code.length === 0 || typeof dropAmount !== "string")
      throw new Error("Voucher row has invalid persisted data.");

    const common = {code, dropAmount};
    if(sessionId === null) {
      if(targetAddr !== null || startTime !== null)
        throw new Error("Voucher row has contradictory available-state data.");
      return {
        ...common,
        state: VoucherState.AVAILABLE,
        sessionId: null,
        targetAddr: null,
        startTime: null,
      };
    }
    if(!isValidOwner(sessionId) || !isValidTimestamp(startTime))
      throw new Error("Voucher row has invalid reservation ownership data.");
    if(targetAddr === null) {
      return {
        ...common,
        state: VoucherState.LEASED,
        sessionId,
        targetAddr: null,
        startTime,
      };
    }
    if(!isValidTargetAddr(targetAddr))
      throw new Error("Voucher row has an invalid consumed target.");
    return {
      ...common,
      state: VoucherState.CONSUMED,
      sessionId,
      targetAddr,
      startTime,
    };
  }

  private static async getVoucherFromDriver(db: BaseDriver, code: string): Promise<IVoucher | null> {
    const row = await db.get(SQL.driverSql({
      [FaucetDbDriver.SQLITE]: [
        "SELECT Code, DropAmount, SessionId, TargetAddr, StartTime",
        "FROM Vouchers WHERE Code = ?",
      ].join(" "),
      [FaucetDbDriver.MYSQL]: [
        "SELECT Code, DropAmount, SessionId, TargetAddr, StartTime",
        "FROM Vouchers WHERE Code = ? AND BINARY Code = BINARY ?",
      ].join(" "),
    }), faucetConfig.database.driver === FaucetDbDriver.MYSQL ? [code, code] : [code]);
    return row ? VoucherDB.voucherFromRow(row) : null;
  }

  private static async getReservationSnapshotFromDriver(
    db: BaseDriver,
    code: string,
  ): Promise<VoucherReservationSnapshot> {
    const row = await db.get(SQL.driverSql({
      [FaucetDbDriver.SQLITE]: [
        "SELECT Code, DropAmount, SessionId, TargetAddr, StartTime,",
        "CleanupVoucherCode, CleanupSessionId, CleanupStartTime, CleanupTargetAddr,",
        "CleanupStatus, CleanupExpectedState, CleanupDataHash, CleanupClaimDataHash",
        "FROM Vouchers WHERE Code = ?",
      ].join(" "),
      [FaucetDbDriver.MYSQL]: [
        "SELECT Code, DropAmount, SessionId, TargetAddr, StartTime,",
        "CleanupVoucherCode, CleanupSessionId, CleanupStartTime, CleanupTargetAddr,",
        "CleanupStatus, CleanupExpectedState, CleanupDataHash, CleanupClaimDataHash",
        "FROM Vouchers WHERE Code = ? AND BINARY Code = BINARY ?",
      ].join(" "),
    }), faucetConfig.database.driver === FaucetDbDriver.MYSQL ? [code, code] : [code]);
    if(!row)
      return {kind: "missing"};

    const receipt = decodeCleanupReceipt(row);
    if(!receipt)
      return {kind: "invalid"};
    const voucher = VoucherDB.voucherFromRow(row);
    if(!VoucherDB.isValidReceiptVoucherPair(voucher, receipt))
      return {kind: "invalid"};
    return {
      kind: "valid",
      voucher,
      receipt,
    };
  }

  private static isValidReceiptVoucherPair(
    voucher: IVoucher,
    receipt: VoucherCleanupReceipt,
  ): boolean {
    if(receipt.kind === "none")
      return true;
    if(receipt.status === FaucetSessionStatus.FAILED)
      return voucher.state === VoucherState.AVAILABLE;
    return voucher.state === VoucherState.CONSUMED
      && voucher.sessionId === receipt.sessionId
      && voucher.startTime === receipt.startTime
      && voucher.targetAddr === receipt.targetAddr;
  }

  private static isExactLeaseReservation(
    snapshot: VoucherReservationSnapshot,
    code: string,
    sessionId: string,
    startTime: number,
  ): boolean {
    return snapshot.kind === "valid"
      && snapshot.receipt.kind === "none"
      && snapshot.voucher.state === VoucherState.LEASED
      && snapshot.voucher.code === code
      && snapshot.voucher.sessionId === sessionId
      && snapshot.voucher.startTime === startTime;
  }

  private static async runReservationCas(
    db: BaseDriver,
    code: string,
    sessionId: string,
    startTime: number,
    update: () => Promise<{changes: number}>,
  ): Promise<boolean> {
    for(let attempt = 0; attempt < 2; attempt++) {
      let updateFailure: {error: unknown} | null = null;
      let updateChanges: number | null = null;
      try {
        const result = await update();
        updateChanges = result.changes;
      } catch(error) {
        updateFailure = {error};
      }
      if(updateChanges !== null) {
        if(updateChanges > 1)
          throw new Error("Voucher reservation changed more than one row.");
        if(updateChanges === 1)
          return true;
      }

      try {
        const snapshot = await VoucherDB.getReservationSnapshotFromDriver(db, code);
        if(VoucherDB.isExactLeaseReservation(snapshot, code, sessionId, startTime))
          return true;
      } catch(reconciliationError) {
        if(updateFailure) {
          throw new AggregateError(
            [updateFailure.error, reconciliationError],
            "Voucher reservation failed and persisted state could not be reconciled.",
          );
        }
        throw reconciliationError;
      }

      if(!updateFailure)
        return false;
      if(attempt === 0 && VoucherDB.isReservationDeadlock(updateFailure.error))
        continue;
      throw updateFailure.error;
    }
    return false;
  }

  private static isReservationDeadlock(error: unknown): boolean {
    if(
      faucetConfig.database.driver !== FaucetDbDriver.MYSQL
      || typeof error !== "object"
      || error === null
    ) {
      return false;
    }
    const record = error as Record<string, unknown>;
    return record.code === "ER_LOCK_DEADLOCK" || record.errno === 1213;
  }

  private static async runStateTransition(
    update: () => Promise<{changes: number}>,
    hasExactPostState: () => Promise<boolean>,
  ): Promise<boolean> {
    let updateFailure: {error: unknown} | null = null;
    let updateChanges: number | null = null;
    try {
      const result = await update();
      updateChanges = result.changes;
    } catch(error) {
      updateFailure = {error};
    }
    if(updateChanges !== null) {
      if(updateChanges > 1)
        throw new Error("Voucher state transition changed more than one row.");
      if(updateChanges === 1)
        return true;
    }

    try {
      if(await hasExactPostState())
        return true;
    } catch(reconciliationError) {
      if(updateFailure) {
        throw new AggregateError(
          [updateFailure.error, reconciliationError],
          "Voucher state transition failed and persisted state could not be reconciled.",
        );
      }
      throw reconciliationError;
    }

    if(updateFailure)
      throw updateFailure.error;
    return false;
  }

  private static matchesCleanupReceipt(
    receipt: VoucherCleanupReceipt,
    voucherCode: string,
    candidate: SessionCleanupCandidate,
    binding: Extract<PersistedVoucherBinding, {kind: "voucher"}>,
    claimData: CleanupClaimDataSnapshot,
    expectedState: VoucherState.LEASED | VoucherState.CONSUMED,
  ): receipt is Extract<VoucherCleanupReceipt, {kind: "receipt"}> {
    return receipt.kind === "receipt"
      && receipt.voucherCode === voucherCode
      && receipt.sessionId === candidate.sessionId
      && receipt.startTime === candidate.startTime
      && receipt.targetAddr === binding.targetAddr
      && receipt.status === candidate.status
      && receipt.expectedState === expectedState
      && receipt.dataHash === binding.dataHash
      && receipt.claimDataHash === claimData.claimDataHash;
  }

  private static async getVoucherCodesForSession(db: BaseDriver, sessionId: string): Promise<string[] | null> {
    const rows = await db.all(SQL.driverSql({
      [FaucetDbDriver.SQLITE]: [
        "SELECT Code FROM Vouchers WHERE SessionId = ? AND SessionId = ? LIMIT 2",
      ].join(" "),
      [FaucetDbDriver.MYSQL]: [
        "SELECT Code FROM Vouchers WHERE SessionId = ?",
        "AND BINARY SessionId = BINARY ? LIMIT 2",
      ].join(" "),
    }), [sessionId, sessionId]);
    const codes = rows.map((row) => getRecordField(row, "Code"));
    return codes.every((code): code is string => typeof code === "string" && code.length > 0)
      ? codes
      : null;
  }

  private static async hasPersistedSession(db: BaseDriver, sessionId: string): Promise<boolean> {
    const row = await db.get(SQL.driverSql({
      [FaucetDbDriver.SQLITE]: "SELECT SessionId FROM Sessions WHERE SessionId = ? AND SessionId = ?",
      [FaucetDbDriver.MYSQL]: [
        "SELECT SessionId FROM Sessions WHERE SessionId = ?",
        "AND BINARY SessionId = BINARY ?",
      ].join(" "),
    }), [sessionId, sessionId]);
    return row !== undefined && row !== null;
  }

  private static async isValidCleanupReceiptReplay(
    db: BaseDriver,
    voucher: IVoucher,
    receipt: VoucherCleanupReceipt,
    candidate: SessionCleanupCandidate,
    binding: Extract<PersistedVoucherBinding, {kind: "voucher"}>,
    claimData: CleanupClaimDataSnapshot,
    expectedState: VoucherState.LEASED | VoucherState.CONSUMED,
  ): Promise<boolean> {
    if(
      receipt.kind !== "receipt"
      || !VoucherDB.isValidReceiptVoucherPair(voucher, receipt)
      || !VoucherDB.matchesCleanupReceipt(
        receipt,
        binding.voucherCode,
        candidate,
        binding,
        claimData,
        expectedState,
      )
    ) {
      return false;
    }

    const ownedCodes = await VoucherDB.getVoucherCodesForSession(db, candidate.sessionId);
    if(!ownedCodes)
      return false;
    if(candidate.status === FaucetSessionStatus.FAILED)
      return voucher.state === VoucherState.AVAILABLE && ownedCodes.length === 0;
    return voucher.state === VoucherState.CONSUMED
      && voucher.sessionId === candidate.sessionId
      && voucher.startTime === candidate.startTime
      && voucher.targetAddr === binding.targetAddr
      && ownedCodes.length === 1
      && ownedCodes[0] === binding.voucherCode;
  }

  private static async releaseLease(db: BaseDriver, code: string, sessionId: string): Promise<boolean> {
    const snapshot = await VoucherDB.getReservationSnapshotFromDriver(db, code);
    if(
      snapshot.kind !== "valid"
      || snapshot.receipt.kind !== "none"
      || snapshot.voucher.state !== VoucherState.LEASED
      || snapshot.voucher.sessionId !== sessionId
    ) {
      return false;
    }
    const voucher = snapshot.voucher;
    return VoucherDB.runStateTransition(
      () => db.run(SQL.driverSql({
        [FaucetDbDriver.SQLITE]: [
          "UPDATE Vouchers SET SessionId = NULL, TargetAddr = NULL, StartTime = NULL",
          "WHERE Code = ? AND SessionId = ? AND TargetAddr IS NULL AND StartTime = ?",
          "AND CleanupVoucherCode IS NULL AND CleanupSessionId IS NULL AND CleanupStartTime IS NULL",
          "AND CleanupTargetAddr IS NULL AND CleanupStatus IS NULL AND CleanupExpectedState IS NULL",
          "AND CleanupDataHash IS NULL AND CleanupClaimDataHash IS NULL",
        ].join(" "),
        [FaucetDbDriver.MYSQL]: [
          "UPDATE Vouchers SET SessionId = NULL, TargetAddr = NULL, StartTime = NULL",
          "WHERE Code = ? AND BINARY Code = BINARY ?",
          "AND SessionId = ? AND BINARY SessionId = BINARY ?",
          "AND TargetAddr IS NULL AND StartTime = ?",
          "AND CleanupVoucherCode IS NULL AND CleanupSessionId IS NULL AND CleanupStartTime IS NULL",
          "AND CleanupTargetAddr IS NULL AND CleanupStatus IS NULL AND CleanupExpectedState IS NULL",
          "AND CleanupDataHash IS NULL AND CleanupClaimDataHash IS NULL",
        ].join(" "),
      }), faucetConfig.database.driver === FaucetDbDriver.MYSQL
        ? [code, code, sessionId, sessionId, voucher.startTime]
        : [code, sessionId, voucher.startTime]),
      async () => {
        const current = await VoucherDB.getReservationSnapshotFromDriver(db, code);
        return current.kind === "valid"
          && current.receipt.kind === "none"
          && current.voucher.state === VoucherState.AVAILABLE
          && current.voucher.code === voucher.code
          && current.voucher.dropAmount === voucher.dropAmount;
      },
    );
  }

  private static async consumeLease(
    db: BaseDriver,
    code: string,
    sessionId: string,
    targetAddr: string,
  ): Promise<boolean> {
    if(!isValidTargetAddr(targetAddr))
      return false;
    const snapshot = await VoucherDB.getReservationSnapshotFromDriver(db, code);
    if(snapshot.kind !== "valid" || snapshot.receipt.kind !== "none")
      return false;
    const voucher = snapshot.voucher;
    if(voucher.state === VoucherState.CONSUMED) {
      return voucher.sessionId === sessionId && voucher.targetAddr === targetAddr;
    }
    if(voucher.state !== VoucherState.LEASED || voucher.sessionId !== sessionId)
      return false;

    return VoucherDB.runStateTransition(
      () => db.run(SQL.driverSql({
        [FaucetDbDriver.SQLITE]: [
          "UPDATE Vouchers SET TargetAddr = ?",
          "WHERE Code = ? AND SessionId = ? AND TargetAddr IS NULL AND StartTime = ?",
          "AND CleanupVoucherCode IS NULL AND CleanupSessionId IS NULL AND CleanupStartTime IS NULL",
          "AND CleanupTargetAddr IS NULL AND CleanupStatus IS NULL AND CleanupExpectedState IS NULL",
          "AND CleanupDataHash IS NULL AND CleanupClaimDataHash IS NULL",
        ].join(" "),
        [FaucetDbDriver.MYSQL]: [
          "UPDATE Vouchers SET TargetAddr = ?",
          "WHERE Code = ? AND BINARY Code = BINARY ?",
          "AND SessionId = ? AND BINARY SessionId = BINARY ?",
          "AND TargetAddr IS NULL AND StartTime = ?",
          "AND CleanupVoucherCode IS NULL AND CleanupSessionId IS NULL AND CleanupStartTime IS NULL",
          "AND CleanupTargetAddr IS NULL AND CleanupStatus IS NULL AND CleanupExpectedState IS NULL",
          "AND CleanupDataHash IS NULL AND CleanupClaimDataHash IS NULL",
        ].join(" "),
      }), faucetConfig.database.driver === FaucetDbDriver.MYSQL
        ? [targetAddr, code, code, sessionId, sessionId, voucher.startTime]
        : [targetAddr, code, sessionId, voucher.startTime]),
      async () => {
        const current = await VoucherDB.getReservationSnapshotFromDriver(db, code);
        return current.kind === "valid"
          && current.receipt.kind === "none"
          && current.voucher.state === VoucherState.CONSUMED
          && current.voucher.code === voucher.code
          && current.voucher.dropAmount === voucher.dropAmount
          && current.voucher.sessionId === sessionId
          && current.voucher.startTime === voucher.startTime
          && current.voucher.targetAddr === targetAddr;
      },
    );
  }

  private static async getFailedSessionReservationSnapshot(
    db: BaseDriver,
    sessionId: string,
    startTime: number,
  ): Promise<FailedSessionReservationSnapshot | null> {
    const row = await db.get(SQL.driverSql({
      [FaucetDbDriver.SQLITE]: [
        "SELECT Status, TargetAddr, Data, ClaimData FROM Sessions",
        "WHERE SessionId = ? AND Status = 'failed' AND StartTime = ?",
      ].join(" "),
      [FaucetDbDriver.MYSQL]: [
        "SELECT Status, TargetAddr, Data, ClaimData FROM Sessions",
        "WHERE SessionId = ? AND BINARY SessionId = BINARY ?",
        "AND Status = 'failed' AND BINARY Status = BINARY 'failed' AND StartTime = ?",
      ].join(" "),
    }), faucetConfig.database.driver === FaucetDbDriver.MYSQL
      ? [sessionId, sessionId, startTime]
      : [sessionId, startTime]);
    if(!row || getRecordField(row, "Status") !== FaucetSessionStatus.FAILED)
      return null;
    const claimData = decodeCleanupClaimData(
      FaucetSessionStatus.FAILED,
      getRecordField(row, "ClaimData"),
    );
    const binding = decodePersistedVoucherBinding(row);
    if(!claimData || !binding)
      return null;
    return {
      binding,
      claimData,
      candidate: {
        sessionId,
        status: FaucetSessionStatus.FAILED,
        startTime,
        targetAddr: binding.targetAddr,
        dataJson: binding.dataJson,
        claimDataJson: claimData.claimDataJson,
        claim: claimData.claim,
      },
    };
  }

  private static async releaseFailedReservation(
    db: BaseDriver,
    voucher: ReservedVoucher,
    candidate: SessionCleanupCandidate,
    binding: Extract<PersistedVoucherBinding, {kind: "voucher"}>,
    claimData: CleanupClaimDataSnapshot,
  ): Promise<boolean> {
    const sqliteTargetPredicate = voucher.state === VoucherState.LEASED
      ? "TargetAddr IS NULL"
      : "TargetAddr = ?";
    const mysqlTargetPredicate = voucher.state === VoucherState.LEASED
      ? "TargetAddr IS NULL"
      : "BINARY TargetAddr = BINARY ?";
    const targetArgs = voucher.state === VoucherState.LEASED ? [] : [voucher.targetAddr];
    const sqliteClaimPredicate = claimData.kind === "none" ? "ClaimData IS NULL" : "ClaimData = ?";
    const mysqlClaimPredicate = claimData.kind === "none"
      ? "ClaimData IS NULL"
      : "BINARY ClaimData = BINARY ?";
    const claimArgs = claimData.kind === "none" ? [] : [claimData.claimDataJson];
    const transitionArgs = faucetConfig.database.driver === FaucetDbDriver.MYSQL
      ? [
          voucher.code,
          candidate.sessionId,
          candidate.startTime,
          binding.targetAddr,
          candidate.status,
          voucher.state,
          binding.dataHash,
          claimData.claimDataHash,
          voucher.code,
          voucher.code,
          voucher.sessionId,
          voucher.sessionId,
          ...targetArgs,
          voucher.startTime,
          candidate.sessionId,
          candidate.sessionId,
          candidate.status,
          candidate.status,
          candidate.startTime,
          binding.targetAddr,
          binding.targetAddr,
          binding.dataJson,
          ...claimArgs,
        ]
      : [
          voucher.code,
          candidate.sessionId,
          candidate.startTime,
          binding.targetAddr,
          candidate.status,
          voucher.state,
          binding.dataHash,
          claimData.claimDataHash,
          voucher.code,
          voucher.sessionId,
          ...targetArgs,
          voucher.startTime,
          candidate.sessionId,
          candidate.status,
          candidate.startTime,
          binding.targetAddr,
          binding.dataJson,
          ...claimArgs,
        ];
    await db.run(SQL.driverSql({
      [FaucetDbDriver.SQLITE]: [
        "UPDATE Vouchers SET SessionId = NULL, TargetAddr = NULL, StartTime = NULL,",
        "CleanupVoucherCode = ?, CleanupSessionId = ?, CleanupStartTime = ?,",
        "CleanupTargetAddr = ?, CleanupStatus = ?, CleanupExpectedState = ?, CleanupDataHash = ?,",
        "CleanupClaimDataHash = ?",
        `WHERE Code = ? AND SessionId = ? AND ${sqliteTargetPredicate} AND StartTime = ?`,
        "AND EXISTS (SELECT 1 FROM Sessions",
        "WHERE SessionId = ? AND Status = ? AND StartTime = ? AND TargetAddr = ? AND Data = ?",
        `AND ${sqliteClaimPredicate})`,
      ].join(" "),
      [FaucetDbDriver.MYSQL]: [
        "UPDATE Vouchers SET SessionId = NULL, TargetAddr = NULL, StartTime = NULL,",
        "CleanupVoucherCode = ?, CleanupSessionId = ?, CleanupStartTime = ?,",
        "CleanupTargetAddr = ?, CleanupStatus = ?, CleanupExpectedState = ?, CleanupDataHash = ?,",
        "CleanupClaimDataHash = ?",
        `WHERE Code = ? AND BINARY Code = BINARY ? AND SessionId = ? AND BINARY SessionId = BINARY ? AND ${mysqlTargetPredicate} AND StartTime = ?`,
        "AND EXISTS (SELECT 1 FROM Sessions",
        "WHERE SessionId = ? AND BINARY SessionId = BINARY ?",
        "AND Status = ? AND BINARY Status = BINARY ? AND StartTime = ?",
        "AND TargetAddr = ? AND BINARY TargetAddr = BINARY ? AND BINARY Data = BINARY ?",
        `AND ${mysqlClaimPredicate})`,
      ].join(" "),
    }), transitionArgs);
    const snapshot = await VoucherDB.getReservationSnapshotFromDriver(db, voucher.code);
    return snapshot.kind === "valid"
      && VoucherDB.isValidCleanupReceiptReplay(
        db,
        snapshot.voucher,
        snapshot.receipt,
        candidate,
        binding,
        claimData,
        voucher.state,
      );
  }

  private static async confirmFinishedReservation(
    db: BaseDriver,
    voucher: ReservedVoucher,
    candidate: SessionCleanupCandidate,
    binding: Extract<PersistedVoucherBinding, {kind: "voucher"}>,
    claimData: CleanupClaimDataSnapshot,
  ): Promise<boolean> {
    if(voucher.state !== VoucherState.CONSUMED || voucher.targetAddr !== binding.targetAddr)
      return false;
    const sqliteClaimPredicate = claimData.kind === "none" ? "ClaimData IS NULL" : "ClaimData = ?";
    const mysqlClaimPredicate = claimData.kind === "none"
      ? "ClaimData IS NULL"
      : "BINARY ClaimData = BINARY ?";
    const claimArgs = claimData.kind === "none" ? [] : [claimData.claimDataJson];
    const transitionArgs = faucetConfig.database.driver === FaucetDbDriver.MYSQL
      ? [
          voucher.code,
          candidate.sessionId,
          candidate.startTime,
          binding.targetAddr,
          candidate.status,
          voucher.state,
          binding.dataHash,
          claimData.claimDataHash,
          voucher.code,
          voucher.code,
          voucher.sessionId,
          voucher.sessionId,
          voucher.targetAddr,
          voucher.startTime,
          candidate.sessionId,
          candidate.sessionId,
          candidate.status,
          candidate.status,
          candidate.startTime,
          binding.targetAddr,
          binding.targetAddr,
          binding.dataJson,
          ...claimArgs,
        ]
      : [
          voucher.code,
          candidate.sessionId,
          candidate.startTime,
          binding.targetAddr,
          candidate.status,
          voucher.state,
          binding.dataHash,
          claimData.claimDataHash,
          voucher.code,
          voucher.sessionId,
          voucher.targetAddr,
          voucher.startTime,
          candidate.sessionId,
          candidate.status,
          candidate.startTime,
          binding.targetAddr,
          binding.dataJson,
          ...claimArgs,
        ];
    await db.run(SQL.driverSql({
      [FaucetDbDriver.SQLITE]: [
        "UPDATE Vouchers SET CleanupVoucherCode = ?, CleanupSessionId = ?, CleanupStartTime = ?,",
        "CleanupTargetAddr = ?, CleanupStatus = ?, CleanupExpectedState = ?, CleanupDataHash = ?,",
        "CleanupClaimDataHash = ?",
        "WHERE Code = ? AND SessionId = ? AND TargetAddr = ? AND StartTime = ?",
        "AND EXISTS (SELECT 1 FROM Sessions",
        "WHERE SessionId = ? AND Status = ? AND StartTime = ? AND TargetAddr = ? AND Data = ?",
        `AND ${sqliteClaimPredicate})`,
      ].join(" "),
      [FaucetDbDriver.MYSQL]: [
        "UPDATE Vouchers SET CleanupVoucherCode = ?, CleanupSessionId = ?, CleanupStartTime = ?,",
        "CleanupTargetAddr = ?, CleanupStatus = ?, CleanupExpectedState = ?, CleanupDataHash = ?,",
        "CleanupClaimDataHash = ?",
        "WHERE Code = ? AND BINARY Code = BINARY ?",
        "AND SessionId = ? AND BINARY SessionId = BINARY ?",
        "AND BINARY TargetAddr = BINARY ? AND StartTime = ?",
        "AND EXISTS (SELECT 1 FROM Sessions",
        "WHERE SessionId = ? AND BINARY SessionId = BINARY ?",
        "AND Status = ? AND BINARY Status = BINARY ? AND StartTime = ?",
        "AND TargetAddr = ? AND BINARY TargetAddr = BINARY ? AND BINARY Data = BINARY ?",
        `AND ${mysqlClaimPredicate})`,
      ].join(" "),
    }), transitionArgs);
    const snapshot = await VoucherDB.getReservationSnapshotFromDriver(db, voucher.code);
    return snapshot.kind === "valid"
      && VoucherDB.isValidCleanupReceiptReplay(
        db,
        snapshot.voucher,
        snapshot.receipt,
        candidate,
        binding,
        claimData,
        voucher.state,
      );
  }

  private static async consumeFinishedReservation(
    db: BaseDriver,
    voucher: ReservedVoucher,
    candidate: SessionCleanupCandidate,
    binding: Extract<PersistedVoucherBinding, {kind: "voucher"}>,
    claimData: CleanupClaimDataSnapshot,
  ): Promise<boolean> {
    if(voucher.state === VoucherState.CONSUMED)
      return VoucherDB.confirmFinishedReservation(db, voucher, candidate, binding, claimData);

    const sqliteClaimPredicate = claimData.kind === "none" ? "ClaimData IS NULL" : "ClaimData = ?";
    const mysqlClaimPredicate = claimData.kind === "none"
      ? "ClaimData IS NULL"
      : "BINARY ClaimData = BINARY ?";
    const claimArgs = claimData.kind === "none" ? [] : [claimData.claimDataJson];
    const transitionArgs = faucetConfig.database.driver === FaucetDbDriver.MYSQL
      ? [
          binding.targetAddr,
          voucher.code,
          candidate.sessionId,
          candidate.startTime,
          binding.targetAddr,
          candidate.status,
          voucher.state,
          binding.dataHash,
          claimData.claimDataHash,
          voucher.code,
          voucher.code,
          voucher.sessionId,
          voucher.sessionId,
          voucher.startTime,
          candidate.sessionId,
          candidate.sessionId,
          candidate.status,
          candidate.status,
          candidate.startTime,
          binding.targetAddr,
          binding.targetAddr,
          binding.dataJson,
          ...claimArgs,
        ]
      : [
          binding.targetAddr,
          voucher.code,
          candidate.sessionId,
          candidate.startTime,
          binding.targetAddr,
          candidate.status,
          voucher.state,
          binding.dataHash,
          claimData.claimDataHash,
          voucher.code,
          voucher.sessionId,
          voucher.startTime,
          candidate.sessionId,
          candidate.status,
          candidate.startTime,
          binding.targetAddr,
          binding.dataJson,
          ...claimArgs,
        ];
    await db.run(SQL.driverSql({
      [FaucetDbDriver.SQLITE]: [
        "UPDATE Vouchers SET TargetAddr = ?, CleanupVoucherCode = ?, CleanupSessionId = ?,",
        "CleanupStartTime = ?, CleanupTargetAddr = ?, CleanupStatus = ?, CleanupExpectedState = ?,",
        "CleanupDataHash = ?, CleanupClaimDataHash = ?",
        "WHERE Code = ? AND SessionId = ? AND TargetAddr IS NULL AND StartTime = ?",
        "AND EXISTS (SELECT 1 FROM Sessions",
        "WHERE SessionId = ? AND Status = ? AND StartTime = ? AND TargetAddr = ? AND Data = ?",
        `AND ${sqliteClaimPredicate})`,
      ].join(" "),
      [FaucetDbDriver.MYSQL]: [
        "UPDATE Vouchers SET TargetAddr = ?, CleanupVoucherCode = ?, CleanupSessionId = ?,",
        "CleanupStartTime = ?, CleanupTargetAddr = ?, CleanupStatus = ?, CleanupExpectedState = ?,",
        "CleanupDataHash = ?, CleanupClaimDataHash = ?",
        "WHERE Code = ? AND BINARY Code = BINARY ?",
        "AND SessionId = ? AND BINARY SessionId = BINARY ?",
        "AND TargetAddr IS NULL AND StartTime = ?",
        "AND EXISTS (SELECT 1 FROM Sessions",
        "WHERE SessionId = ? AND BINARY SessionId = BINARY ?",
        "AND Status = ? AND BINARY Status = BINARY ? AND StartTime = ?",
        "AND TargetAddr = ? AND BINARY TargetAddr = BINARY ? AND BINARY Data = BINARY ?",
        `AND ${mysqlClaimPredicate})`,
      ].join(" "),
    }), transitionArgs);

    const snapshot = await VoucherDB.getReservationSnapshotFromDriver(db, voucher.code);
    return snapshot.kind === "valid"
      && VoucherDB.isValidCleanupReceiptReplay(
        db,
        snapshot.voucher,
        snapshot.receipt,
        candidate,
        binding,
        claimData,
        voucher.state,
      );
  }

  public static async insertVoucher(db: BaseDriver, code: string, dropAmount: string): Promise<void> {
    try {
      await db.run(
        "INSERT INTO Vouchers (Code, DropAmount, SessionId, TargetAddr, StartTime) VALUES (?, ?, NULL, NULL, NULL)",
        [code, dropAmount],
      );
    } catch(insertError) {
      let existingVoucher;
      try {
        existingVoucher = await db.get(
          "SELECT Code FROM Vouchers WHERE Code = ?",
          [code],
        );
      } catch(lookupError) {
        throw new AggregateError(
          [insertError, lookupError],
          "Voucher insert failed and collision status could not be checked.",
        );
      }

      if(existingVoucher?.Code === code)
        throw new VoucherCodeCollisionError(insertError);
      throw insertError;
    }
  }

  private async readVoucherColumns(): Promise<Map<string, unknown>> {
    const rows = await this.db.all(faucetConfig.database.driver === FaucetDbDriver.SQLITE
      ? "PRAGMA table_info(Vouchers)"
      : [
          "SELECT COLUMN_NAME AS Name, DATA_TYPE AS DataType, IS_NULLABLE AS Nullable,",
          "CHARACTER_MAXIMUM_LENGTH AS MaxLength, COLUMN_DEFAULT AS DefaultValue,",
          "COLUMN_KEY AS ColumnKey",
          "FROM information_schema.columns",
          "WHERE table_schema = DATABASE() AND table_name = 'Vouchers'",
        ].join(" "));
    const columns = new Map<string, unknown>();
    for(const row of rows) {
      const name = faucetConfig.database.driver === FaucetDbDriver.SQLITE
        ? getRecordField(row, "name")
        : getRecordField(row, "Name");
      if(typeof name !== "string" || name.length === 0 || columns.has(name))
        throw new Error("Voucher schema contains an invalid column definition.");
      columns.set(name, row);
    }
    return columns;
  }

  private static assertCompatibleVoucherColumn(spec: VoucherColumnSpec, row: unknown): void {
    if(faucetConfig.database.driver === FaucetDbDriver.SQLITE) {
      const dataType = getRecordField(row, "type");
      const notNull = getRecordField(row, "notnull");
      const defaultValue = getRecordField(row, "dflt_value");
      const primaryKey = getRecordField(row, "pk");
      if(
        typeof dataType !== "string"
        || dataType.toUpperCase() !== spec.sqliteType
        || notNull !== spec.sqliteNotNull
        || defaultValue !== null
        || (primaryKey !== 0) !== spec.primaryKey
      ) {
        throw new Error(`Voucher schema column ${spec.name} has an incompatible definition.`);
      }
      return;
    }

    const dataType = getRecordField(row, "DataType");
    const nullable = getRecordField(row, "Nullable");
    const maxLength = getRecordField(row, "MaxLength");
    const defaultValue = getRecordField(row, "DefaultValue");
    const columnKey = getRecordField(row, "ColumnKey");
    if(
      dataType !== spec.mysqlType
      || nullable !== spec.mysqlNullable
      || (maxLength === null ? null : Number(maxLength)) !== spec.mysqlMaxLength
      || defaultValue !== null
      || (spec.primaryKey && columnKey !== "PRI")
    ) {
      throw new Error(`Voucher schema column ${spec.name} has an incompatible definition.`);
    }
  }

  private async ensureVoucherV3Columns(): Promise<void> {
    const columns = await this.readVoucherColumns();
    for(const spec of VOUCHER_BASE_COLUMNS) {
      const existing = columns.get(spec.name);
      if(!existing)
        throw new Error(`Voucher schema is missing required column ${spec.name}.`);
      VoucherDB.assertCompatibleVoucherColumn(spec, existing);
    }
    for(const spec of VOUCHER_V3_COLUMNS) {
      const existing = columns.get(spec.name);
      if(existing) {
        VoucherDB.assertCompatibleVoucherColumn(spec, existing);
        continue;
      }
      await this.db.exec(faucetConfig.database.driver === FaucetDbDriver.SQLITE
        ? `ALTER TABLE Vouchers ADD COLUMN ${spec.name} ${spec.sqliteDefinition}`
        : `ALTER TABLE Vouchers ADD COLUMN ${spec.name} ${spec.mysqlDefinition}`);
    }

    const convergedColumns = await this.readVoucherColumns();
    for(const spec of VOUCHER_V3_COLUMNS) {
      const converged = convergedColumns.get(spec.name);
      if(!converged)
        throw new Error(`Voucher schema migration did not create column ${spec.name}.`);
      VoucherDB.assertCompatibleVoucherColumn(spec, converged);
    }
  }

  private async ensureVoucherSessionIndex(): Promise<void> {
    if(faucetConfig.database.driver === FaucetDbDriver.SQLITE) {
      const indexes = await this.db.all("PRAGMA index_list(Vouchers)");
      const existing = indexes.find((row) => getRecordField(row, "name") === VOUCHER_SESSION_INDEX);
      if(existing) {
        if(getRecordField(existing, "unique") !== 0)
          throw new Error(`Voucher schema index ${VOUCHER_SESSION_INDEX} has an incompatible definition.`);
        const columns = await this.db.all(`PRAGMA index_info(${VOUCHER_SESSION_INDEX})`);
        if(columns.length !== 1 || getRecordField(columns[0], "name") !== "SessionId")
          throw new Error(`Voucher schema index ${VOUCHER_SESSION_INDEX} has an incompatible definition.`);
        return;
      }
      await this.db.exec(`CREATE INDEX ${VOUCHER_SESSION_INDEX} ON Vouchers (SessionId)`);
      return this.ensureVoucherSessionIndex();
    }

    const indexes = await this.db.all([
      "SELECT NON_UNIQUE AS NonUnique, SEQ_IN_INDEX AS SequenceIndex, COLUMN_NAME AS ColumnName",
      "FROM information_schema.statistics",
      "WHERE table_schema = DATABASE() AND table_name = 'Vouchers' AND index_name = ?",
      "ORDER BY SEQ_IN_INDEX",
    ].join(" "), [VOUCHER_SESSION_INDEX]);
    if(indexes.length > 0) {
      if(
        indexes.length !== 1
        || Number(getRecordField(indexes[0], "NonUnique")) !== 1
        || Number(getRecordField(indexes[0], "SequenceIndex")) !== 1
        || getRecordField(indexes[0], "ColumnName") !== "SessionId"
      ) {
        throw new Error(`Voucher schema index ${VOUCHER_SESSION_INDEX} has an incompatible definition.`);
      }
      return;
    }
    await this.db.exec(`ALTER TABLE Vouchers ADD INDEX ${VOUCHER_SESSION_INDEX} (SessionId)`);
    return this.ensureVoucherSessionIndex();
  }

  protected override async upgradeSchema(version: number): Promise<number> {
    if(version < 0 || version > 2)
      return version;
    if(version === 0) {
      await this.db.exec(SQL.driverSql({
        [FaucetDbDriver.SQLITE]: `
          CREATE TABLE IF NOT EXISTS "Vouchers" (
            "Code" TEXT NOT NULL UNIQUE,
            "DropAmount" TEXT NOT NULL,
            "SessionId" TEXT NULL,
            "TargetAddr" TEXT NULL,
            "StartTime" INTEGER NULL,
            "CleanupVoucherCode" TEXT NULL,
            "CleanupSessionId" TEXT NULL,
            "CleanupStartTime" INTEGER NULL,
            "CleanupTargetAddr" TEXT NULL,
            "CleanupStatus" TEXT NULL,
            "CleanupExpectedState" TEXT NULL,
            "CleanupDataHash" TEXT NULL,
            "CleanupClaimDataHash" TEXT NULL,
            PRIMARY KEY("Code")
          )`,
        [FaucetDbDriver.MYSQL]: `
          CREATE TABLE IF NOT EXISTS Vouchers (
            Code VARCHAR(50) NOT NULL,
            DropAmount VARCHAR(50) NOT NULL,
            SessionId CHAR(36) NULL,
            TargetAddr CHAR(42) NULL,
            StartTime INT(11) NULL,
            CleanupVoucherCode VARCHAR(50) NULL,
            CleanupSessionId CHAR(36) NULL,
            CleanupStartTime INT(11) NULL,
            CleanupTargetAddr CHAR(42) NULL,
            CleanupStatus VARCHAR(10) NULL,
            CleanupExpectedState VARCHAR(10) NULL,
            CleanupDataHash CHAR(64) NULL,
            CleanupClaimDataHash CHAR(64) NULL,
            PRIMARY KEY(Code)
          )`,
      }));
    }
    await this.ensureVoucherV3Columns();
    await this.ensureVoucherSessionIndex();
    return 3;
  }

  public async getVoucher(code: string): Promise<IVoucher | null> {
    return VoucherDB.getVoucherFromDriver(this.db, code);
  }

  private async finishFailedReceiptCleanup(
    voucher: Extract<IVoucher, {state: VoucherState.AVAILABLE}>,
    receipt: Extract<VoucherCleanupReceipt, {kind: "receipt"}>,
  ): Promise<boolean> {
    if(receipt.status !== FaucetSessionStatus.FAILED)
      return false;
    const failedSession = await VoucherDB.getFailedSessionReservationSnapshot(
      this.db,
      receipt.sessionId,
      receipt.startTime,
    );
    if(!failedSession)
      return !await VoucherDB.hasPersistedSession(this.db, receipt.sessionId);
    if(
      failedSession.binding.kind !== "voucher"
      || failedSession.binding.voucherCode !== voucher.code
      || !await VoucherDB.isValidCleanupReceiptReplay(
        this.db,
        voucher,
        receipt,
        failedSession.candidate,
        failedSession.binding,
        failedSession.claimData,
        receipt.expectedState,
      )
    ) {
      return false;
    }
    return this.faucetStore.cleanupSessionCandidate(failedSession.candidate);
  }

  public async reserveVoucher(code: string, sessionId: string, startTime: number): Promise<boolean> {
    if(!isValidOwner(sessionId) || !isValidTimestamp(startTime))
      return false;
    const snapshot = await VoucherDB.getReservationSnapshotFromDriver(this.db, code);
    if(snapshot.kind !== "valid")
      return false;
    if(VoucherDB.isExactLeaseReservation(snapshot, code, sessionId, startTime))
      return true;

    const {voucher, receipt} = snapshot;
    if(voucher.code !== code)
      return false;

    const requestedOwnerCodes = await VoucherDB.getVoucherCodesForSession(this.db, sessionId);
    if(
      !requestedOwnerCodes
      || requestedOwnerCodes.length !== 0
      || await VoucherDB.hasPersistedSession(this.db, sessionId)
    ) {
      return false;
    }

    if(voucher.state === VoucherState.AVAILABLE) {
      if(receipt.kind === "receipt") {
        const cleanupOwnerCodes = await VoucherDB.getVoucherCodesForSession(
          this.db,
          receipt.sessionId,
        );
        if(
          receipt.status !== FaucetSessionStatus.FAILED
          || !cleanupOwnerCodes
          || cleanupOwnerCodes.length !== 0
          || !await this.finishFailedReceiptCleanup(voucher, receipt)
        ) {
          return false;
        }
      }
      const sqliteReceiptPredicate = receipt.kind === "none"
        ? [
            "CleanupVoucherCode IS NULL AND CleanupSessionId IS NULL AND CleanupStartTime IS NULL",
            "AND CleanupTargetAddr IS NULL AND CleanupStatus IS NULL AND CleanupExpectedState IS NULL",
            "AND CleanupDataHash IS NULL AND CleanupClaimDataHash IS NULL",
          ].join(" ")
        : [
            "CleanupVoucherCode = ? AND CleanupSessionId = ? AND CleanupStartTime = ?",
            "AND CleanupTargetAddr = ? AND CleanupStatus = ? AND CleanupExpectedState = ?",
            "AND CleanupDataHash = ? AND CleanupClaimDataHash = ?",
            "AND NOT EXISTS (SELECT 1 FROM Sessions WHERE Sessions.SessionId = Vouchers.CleanupSessionId)",
            "AND NOT EXISTS (SELECT 1 FROM Vouchers AS CleanupOwners",
            "WHERE CleanupOwners.SessionId = ? AND CleanupOwners.SessionId = ?)",
          ].join(" ");
      const mysqlReceiptPredicate = receipt.kind === "none"
        ? [
            "CleanupVoucherCode IS NULL AND CleanupSessionId IS NULL AND CleanupStartTime IS NULL",
            "AND CleanupTargetAddr IS NULL AND CleanupStatus IS NULL AND CleanupExpectedState IS NULL",
            "AND CleanupDataHash IS NULL AND CleanupClaimDataHash IS NULL",
          ].join(" ")
        : [
            "CleanupVoucherCode = ? AND BINARY CleanupVoucherCode = BINARY ?",
            "AND CleanupSessionId = ? AND BINARY CleanupSessionId = BINARY ?",
            "AND CleanupStartTime = ? AND BINARY CleanupTargetAddr = BINARY ?",
            "AND BINARY CleanupStatus = BINARY ? AND BINARY CleanupExpectedState = BINARY ?",
            "AND BINARY CleanupDataHash = BINARY ? AND BINARY CleanupClaimDataHash = BINARY ?",
            "AND NOT EXISTS (SELECT 1 FROM Sessions",
            "WHERE Sessions.SessionId = Vouchers.CleanupSessionId",
            "AND BINARY Sessions.SessionId = BINARY Vouchers.CleanupSessionId)",
            "AND NOT EXISTS (SELECT 1 FROM (SELECT Code FROM Vouchers",
            "WHERE SessionId = ? AND BINARY SessionId = BINARY ? LIMIT 1) AS CleanupOwners)",
          ].join(" ");
      const receiptArgs = receipt.kind === "none"
        ? []
        : faucetConfig.database.driver === FaucetDbDriver.MYSQL
          ? [
              receipt.voucherCode,
              receipt.voucherCode,
              receipt.sessionId,
              receipt.sessionId,
              receipt.startTime,
              receipt.targetAddr,
              receipt.status,
              receipt.expectedState,
              receipt.dataHash,
              receipt.claimDataHash,
              receipt.sessionId,
              receipt.sessionId,
            ]
          : [
              receipt.voucherCode,
              receipt.sessionId,
              receipt.startTime,
              receipt.targetAddr,
              receipt.status,
              receipt.expectedState,
              receipt.dataHash,
              receipt.claimDataHash,
              receipt.sessionId,
              receipt.sessionId,
            ];
      const reservationArgs = faucetConfig.database.driver === FaucetDbDriver.MYSQL
        ? [
            sessionId,
            startTime,
            voucher.code,
            voucher.code,
            ...receiptArgs,
            sessionId,
            sessionId,
            sessionId,
            sessionId,
          ]
        : [
            sessionId,
            startTime,
            voucher.code,
            ...receiptArgs,
            sessionId,
            sessionId,
            sessionId,
            sessionId,
          ];
      return VoucherDB.runReservationCas(
        this.db,
        voucher.code,
        sessionId,
        startTime,
        () => this.db.run(SQL.driverSql({
          [FaucetDbDriver.SQLITE]: [
            "UPDATE Vouchers SET SessionId = ?, TargetAddr = NULL, StartTime = ?,",
            "CleanupVoucherCode = NULL, CleanupSessionId = NULL, CleanupStartTime = NULL,",
            "CleanupTargetAddr = NULL, CleanupStatus = NULL, CleanupExpectedState = NULL,",
            "CleanupDataHash = NULL, CleanupClaimDataHash = NULL",
            "WHERE Code = ? AND SessionId IS NULL AND TargetAddr IS NULL AND StartTime IS NULL",
            `AND ${sqliteReceiptPredicate}`,
            "AND NOT EXISTS (SELECT 1 FROM Vouchers AS RequestedOwners",
            "WHERE RequestedOwners.SessionId = ? AND RequestedOwners.SessionId = ?)",
            "AND NOT EXISTS (SELECT 1 FROM Sessions AS RequestedSessions",
            "WHERE RequestedSessions.SessionId = ? AND RequestedSessions.SessionId = ?)",
          ].join(" "),
          [FaucetDbDriver.MYSQL]: [
            "UPDATE Vouchers SET SessionId = ?, TargetAddr = NULL, StartTime = ?,",
            "CleanupVoucherCode = NULL, CleanupSessionId = NULL, CleanupStartTime = NULL,",
            "CleanupTargetAddr = NULL, CleanupStatus = NULL, CleanupExpectedState = NULL,",
            "CleanupDataHash = NULL, CleanupClaimDataHash = NULL",
            "WHERE Code = ? AND BINARY Code = BINARY ?",
            "AND SessionId IS NULL AND TargetAddr IS NULL AND StartTime IS NULL",
            `AND ${mysqlReceiptPredicate}`,
            "AND NOT EXISTS (SELECT 1 FROM (SELECT Code FROM Vouchers",
            "WHERE SessionId = ? AND BINARY SessionId = BINARY ? LIMIT 1) AS RequestedOwners)",
            "AND NOT EXISTS (SELECT 1 FROM Sessions AS RequestedSessions",
            "WHERE RequestedSessions.SessionId = ?",
            "AND BINARY RequestedSessions.SessionId = BINARY ?)",
          ].join(" "),
        }), reservationArgs),
      );
    }
    if(receipt.kind !== "none")
      return false;

    const failedSession = await VoucherDB.getFailedSessionReservationSnapshot(
      this.db,
      voucher.sessionId,
      voucher.startTime,
    );
    if(
      !failedSession
      || failedSession.binding.kind !== "voucher"
      || failedSession.binding.voucherCode !== voucher.code
      || (
        voucher.state === VoucherState.CONSUMED
        && voucher.targetAddr !== failedSession.binding.targetAddr
      )
    ) {
      return false;
    }
    const {binding, claimData} = failedSession;
    const currentOwnerCodes = await VoucherDB.getVoucherCodesForSession(this.db, voucher.sessionId);
    if(
      !currentOwnerCodes
      || currentOwnerCodes.length !== 1
      || currentOwnerCodes[0] !== voucher.code
    ) {
      return false;
    }
    if(!await VoucherDB.releaseFailedReservation(
      this.db,
      voucher,
      failedSession.candidate,
      binding,
      claimData,
    )) {
      return false;
    }
    if(!await this.faucetStore.cleanupSessionCandidate(failedSession.candidate))
      return false;
    return this.reserveVoucher(code, sessionId, startTime);
  }

  public async releaseVoucher(code: string, sessionId: string): Promise<boolean> {
    return VoucherDB.releaseLease(this.db, code, sessionId);
  }

  public async consumeVoucher(code: string, sessionId: string, targetAddr: string): Promise<boolean> {
    return VoucherDB.consumeLease(this.db, code, sessionId, targetAddr);
  }

  public async reconcileOrphanedLeases(): Promise<number> {
    const result = await this.db.run(SQL.driverSql({
      [FaucetDbDriver.SQLITE]: [
        "UPDATE Vouchers SET SessionId = NULL, TargetAddr = NULL, StartTime = NULL",
        "WHERE SessionId IS NOT NULL AND typeof(SessionId) = 'text' AND length(SessionId) > 0",
        "AND TargetAddr IS NULL AND StartTime IS NOT NULL AND typeof(StartTime) = 'integer'",
        "AND StartTime BETWEEN -9007199254740991 AND 9007199254740991",
        "AND CleanupVoucherCode IS NULL AND CleanupSessionId IS NULL AND CleanupStartTime IS NULL",
        "AND CleanupTargetAddr IS NULL AND CleanupStatus IS NULL AND CleanupExpectedState IS NULL",
        "AND CleanupDataHash IS NULL AND CleanupClaimDataHash IS NULL",
        "AND NOT EXISTS (SELECT 1 FROM Sessions WHERE Sessions.SessionId = Vouchers.SessionId)",
      ].join(" "),
      [FaucetDbDriver.MYSQL]: [
        "UPDATE Vouchers SET SessionId = NULL, TargetAddr = NULL, StartTime = NULL",
        "WHERE SessionId IS NOT NULL AND CHAR_LENGTH(SessionId) > 0",
        "AND TargetAddr IS NULL AND StartTime IS NOT NULL",
        "AND CleanupVoucherCode IS NULL AND CleanupSessionId IS NULL AND CleanupStartTime IS NULL",
        "AND CleanupTargetAddr IS NULL AND CleanupStatus IS NULL AND CleanupExpectedState IS NULL",
        "AND CleanupDataHash IS NULL AND CleanupClaimDataHash IS NULL",
        "AND NOT EXISTS (SELECT 1 FROM Sessions",
        "WHERE Sessions.SessionId = Vouchers.SessionId",
        "AND BINARY Sessions.SessionId = BINARY Vouchers.SessionId)",
      ].join(" "),
    }));
    return result.changes;
  }

  public static async prepareSessionCleanup(
    database: FaucetDatabase,
    candidate: SessionCleanupCandidate,
  ): Promise<boolean> {
    if(candidate.status !== FaucetSessionStatus.FAILED && candidate.status !== FaucetSessionStatus.FINISHED)
      return true;

    const db = database.getDatabase();
    const binding = decodePersistedVoucherBinding({
      TargetAddr: candidate.targetAddr,
      Data: candidate.dataJson,
    });
    const claimData = decodeCleanupClaimData(candidate.status, candidate.claimDataJson);

    const schema = await db.get(
      "SELECT Version FROM SchemaVersion WHERE Module = ?",
      ["voucher"],
    );
    if(!schema)
      return true;
    const schemaVersion = getRecordField(schema, "Version");
    if(!isValidTimestamp(schemaVersion) || schemaVersion < 1 || !binding || !claimData)
      return false;

    if(schemaVersion === 1) {
      if(binding.kind !== "none")
        return false;
      const ownedCodes = await VoucherDB.getVoucherCodesForSession(db, candidate.sessionId);
      return ownedCodes !== null && ownedCodes.length === 0;
    }
    if(schemaVersion < 3)
      return false;

    if(binding.kind === "none") {
      const ownedCodes = await VoucherDB.getVoucherCodesForSession(db, candidate.sessionId);
      return ownedCodes !== null && ownedCodes.length === 0;
    }

    const snapshot = await VoucherDB.getReservationSnapshotFromDriver(db, binding.voucherCode);
    if(snapshot.kind !== "valid")
      return false;
    const {voucher, receipt} = snapshot;
    if(receipt.kind === "receipt") {
      return VoucherDB.isValidCleanupReceiptReplay(
        db,
        voucher,
        receipt,
        candidate,
        binding,
        claimData,
        receipt.expectedState,
      );
    }

    const ownedCodes = await VoucherDB.getVoucherCodesForSession(db, candidate.sessionId);
    if(
      !ownedCodes
      || ownedCodes.length !== 1
      || ownedCodes[0] !== binding.voucherCode
      || voucher.state === VoucherState.AVAILABLE
      || voucher.sessionId !== candidate.sessionId
      || voucher.startTime !== candidate.startTime
      || (voucher.state === VoucherState.CONSUMED && voucher.targetAddr !== binding.targetAddr)
    ) {
      return false;
    }

    if(candidate.status === FaucetSessionStatus.FAILED)
      return VoucherDB.releaseFailedReservation(db, voucher, candidate, binding, claimData);
    return VoucherDB.consumeFinishedReservation(db, voucher, candidate, binding, claimData);
  }
}
