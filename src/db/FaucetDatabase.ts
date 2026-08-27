
import { Worker } from "node:worker_threads";
import { faucetConfig, resolveRelativePath } from '../config/FaucetConfig.js';
import { FaucetProcess, FaucetLogLevel } from '../common/FaucetProcess.js';
import { ServiceManager } from '../common/ServiceManager.js';
import { FaucetSessionStatus, FaucetSessionStoreData } from '../session/FaucetSession.js';
import { BaseModule } from '../modules/BaseModule.js';
import { ClaimTxStatus, EthClaimData, isClaimData } from '../eth/EthClaim.js';
import { FaucetModuleDB } from './FaucetModuleDB.js';
import { BaseDriver } from './driver/BaseDriver.js';
import { ISQLiteOptions } from './driver/SQLiteDriver.js';
import { WorkerDriver } from './driver/WorkerDriver.js';
import { FaucetWorkers } from '../common/FaucetWorker.js';
import { IMySQLOptions, MySQLDriver } from "./driver/MySQLDriver.js";
import { getDefaultSessionCleanupGuards } from "./SessionCleanupGuards.js";
import { SQL } from "./SQL.js";

export type FaucetDatabaseOptions = ISQLiteOptions | IMySQLOptions;

export interface SessionCleanupCandidate {
  readonly sessionId: string;
  readonly status: FaucetSessionStatus;
  readonly startTime: number;
  readonly targetAddr: string;
  readonly dataJson: string;
  readonly claimDataJson: string | null;
  readonly claim: EthClaimData | null;
}

export type SessionCleanupGuard = (candidate: SessionCleanupCandidate) => boolean | Promise<boolean>;

export const SESSION_CLEANUP_BATCH_SIZE = 100;
export const SESSION_CLEANUP_RUN_LIMIT = 1000;

interface SessionCleanupCursor {
  readonly startTime: number;
  readonly sessionId: string;
}

interface SessionCleanupRow {
  readonly SessionId: string;
  readonly Status: string;
  readonly StartTime: number;
  readonly TargetAddr: string;
  readonly Data: string;
  readonly ClaimData: string | null;
}

type SessionCleanupIndexState = "missing" | "compatible" | "incompatible";

interface ClaimableDigitSumRow {
  readonly DigitPosition: number;
  readonly DigitSum: string;
  readonly InvalidAmount: number;
  readonly OversizedAmount: number;
}

function isSchemaVersionInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

export enum FaucetDbDriver {
  SQLITE = "sqlite",
  MYSQL = "mysql",
}

export class FaucetDatabase {

  private initialized = false;
  private stopping = false;
  private initializationInFlight: Promise<void> | null = null;
  private closeInFlight: Promise<void> | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private db: BaseDriver;
  private dbWorker: Worker;
  private moduleDBs: {[module: string]: FaucetModuleDB} = {};
  private moduleDBInitializations = new Map<string, Promise<FaucetModuleDB>>();
  private sessionCleanupGuards = new Map<string, SessionCleanupGuard>();
  private sessionCleanupCursor: SessionCleanupCursor | null = null;
  private cleanupInFlight: Promise<void> | null = null;

  public initialize(): Promise<void> {
    if(this.initialized)
      return Promise.resolve();
    if(this.closeInFlight) {
      return Promise.reject(
        new Error("Database cannot initialize while close is in progress or database resources remain."),
      );
    }
    if(this.initializationInFlight)
      return this.initializationInFlight;
    if(this.db || this.dbWorker) {
      return Promise.reject(
        new Error("Database cannot initialize while close is in progress or database resources remain."),
      );
    }

    this.stopping = false;
    let initialization: Promise<void>;
    initialization = this.initializeDatabase().finally(() => {
      if(this.initializationInFlight === initialization)
        this.initializationInFlight = null;
    });
    this.initializationInFlight = initialization;
    return initialization;
  }

  private async initializeDatabase(): Promise<void> {
    try {
      await this.initDatabase();
      if(this.stopping)
        throw new Error("Database initialization completed after shutdown began.");
      this.initialized = true;
      this.cleanupTimer = setInterval(() => {
        this.cleanStore().catch((ex) => {
          ServiceManager.GetService(FaucetProcess).emitLog(
            FaucetLogLevel.ERROR,
            "Could not clean the faucet database: " + String(ex),
          );
        });
      }, (1000 * 60 * 60 * 2));
    } catch(error) {
      this.initialized = false;
      this.stopping = true;
      throw error;
    }
  }

  public async dispose(): Promise<void> {
    this.stopping = true;
    this.initialized = false;
    if(this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    const pending = [
      ...(this.initializationInFlight ? [this.initializationInFlight] : []),
      ...(this.cleanupInFlight ? [this.cleanupInFlight] : []),
      ...this.moduleDBInitializations.values(),
    ];
    const results = await Promise.allSettled(pending);
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if(errors.length > 0)
      throw new AggregateError(errors, "Database work did not drain cleanly");
  }

  private async initDatabase(): Promise<void> {
    switch(faucetConfig.database.driver) {
      case "sqlite":
        this.dbWorker = ServiceManager.GetService(FaucetWorkers).createWorker("database");
        this.db = new WorkerDriver(this.dbWorker);
        await this.db.open(Object.assign({}, faucetConfig.database, {
          file: resolveRelativePath(faucetConfig.database.file),
        }))
        break;
      case "mysql":
        this.db = new MySQLDriver();
        await this.db.open(Object.assign({}, faucetConfig.database));
        break;
      default:
        throw "unknown database driver: " + (faucetConfig.database as any).driver;
    }
    await this.upgradeSchema();
  }

  public closeDatabase(): Promise<void> {
    if(this.closeInFlight)
      return this.closeInFlight;

    let close: Promise<void>;
    close = this.closeDatabaseOwned().finally(() => {
      if(this.closeInFlight === close)
        this.closeInFlight = null;
    });
    this.closeInFlight = close;
    return close;
  }

  private async closeDatabaseOwned(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.dispose();
    } catch(error) {
      errors.push(error);
    }

    if(this.db) {
      try {
        await this.db.close();
        this.db = null;
        this.moduleDBs = {};
        this.sessionCleanupCursor = null;
      } catch(error) {
        errors.push(error);
      }
    }
    if(!this.db && this.dbWorker) {
      const worker = this.dbWorker;
      try {
        await worker.terminate();
        if(this.dbWorker === worker)
          this.dbWorker = null;
      } catch(error) {
        errors.push(error);
      }
    }
    if(errors.length > 0)
      throw new AggregateError(errors, "Database shutdown did not complete cleanly");
  }

  public async createModuleDb<TModDB extends FaucetModuleDB>(dbClass: new(module: BaseModule, faucetStore: FaucetDatabase) => TModDB, module: BaseModule): Promise<TModDB> {
    const modName = module.getModuleName();
    if(!this.initialized || this.stopping)
      throw new Error(
        `Module database ${modName} cannot initialize before database readiness or during shutdown.`,
      );
    const existing = this.moduleDBs[modName];
    if(existing) {
      if(!(existing instanceof dbClass))
        throw new Error(`Module database ${modName} was initialized with a different implementation.`);
      return existing;
    }

    let initialization = this.moduleDBInitializations.get(modName);
    if(!initialization) {
      const candidate = new dbClass(module, this);
      initialization = Promise.resolve()
        .then(() => candidate.initSchema())
        .then(() => {
          if(!this.initialized || this.stopping) {
            throw new Error(
              `Module database ${modName} finished initializing after database shutdown began.`,
            );
          }
          this.moduleDBs[modName] = candidate;
          return candidate;
        });
      this.moduleDBInitializations.set(modName, initialization);
    }

    try {
      const moduleDb = await initialization;
      if(!(moduleDb instanceof dbClass))
        throw new Error(`Module database ${modName} was initialized with a different implementation.`);
      return moduleDb;
    } finally {
      if(this.moduleDBInitializations.get(modName) === initialization)
        this.moduleDBInitializations.delete(modName);
    }
  }

  public disposeModuleDb(moduleDb: FaucetModuleDB) {
    if(this.moduleDBs[moduleDb.getModuleName()] === moduleDb)
      delete this.moduleDBs[moduleDb.getModuleName()];
  }

  public getDatabase(): BaseDriver {
    return this.db;
  }

  public registerSessionCleanupGuard(owner: string, guard: SessionCleanupGuard): () => void {
    if(!owner || typeof guard !== "function")
      throw new Error("A session cleanup guard requires an owner and callback.");
    this.sessionCleanupGuards.set(owner, guard);
    return () => {
      if(this.sessionCleanupGuards.get(owner) === guard)
        this.sessionCleanupGuards.delete(owner);
    };
  }

  private async passesSessionCleanupGuards(candidate: SessionCleanupCandidate): Promise<boolean> {
    let defaultSessionCleanupGuards = getDefaultSessionCleanupGuards();
    for(let [owner, defaultGuard] of defaultSessionCleanupGuards) {
      let runtimeGuard = this.sessionCleanupGuards.get(owner);
      if(!await (runtimeGuard ? runtimeGuard(candidate) : defaultGuard(this, candidate)))
        return false;
    }
    for(let [owner, runtimeGuard] of this.sessionCleanupGuards) {
      if(!defaultSessionCleanupGuards.has(owner) && !await runtimeGuard(candidate))
        return false;
    }
    return true;
  }

  public async upgradeIfNeeded(module: string, latestVersion: number, upgrade: (version: number) => Promise<number>): Promise<void> {
    if(!isSchemaVersionInRange(latestVersion, 0, Number.MAX_SAFE_INTEGER))
      throw new Error(`Module ${module} has an invalid latest schema version.`);

    let schemaVersion = 0;
    const versionRows = await this.db.all(
      "SELECT Version FROM SchemaVersion WHERE Module = ? LIMIT 2",
      [module],
    );
    if(versionRows.length > 1)
      throw new Error(`Module ${module} has duplicate schema version rows.`);
    if(versionRows.length === 1)
      schemaVersion = versionRows[0].Version as number;
    else
      await this.db.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", [module, 0]);
    if(!isSchemaVersionInRange(schemaVersion, 0, latestVersion)) {
      throw new Error(
        `Module ${module} has an unsupported schema version; expected a safe integer from 0 through ${latestVersion}.`,
      );
    }

    let upgradedVersion = schemaVersion;
    if(schemaVersion !== latestVersion) {
      upgradedVersion = await upgrade(schemaVersion);
    }
    if(!isSchemaVersionInRange(upgradedVersion, latestVersion, latestVersion)) {
      throw new Error(
        `Module ${module} schema upgrade returned an invalid version; expected exactly ${latestVersion}.`,
      );
    }
    if(upgradedVersion !== schemaVersion) {
      await this.db.run("UPDATE SchemaVersion SET Version = ? WHERE Module = ?", [upgradedVersion, module]);
    }
  }

  private async upgradeSchema(): Promise<void> {
    const latestSchemaVersion = 2;
    let schemaVersion: number = 0;
    await this.db.run(SQL.driverSql({
      [FaucetDbDriver.SQLITE]: `
        CREATE TABLE IF NOT EXISTS SchemaVersion (
          Module TEXT NULL UNIQUE,
          Version INTEGER NOT NULL,
          PRIMARY KEY(Module)
        )`,
        [FaucetDbDriver.MYSQL]: `
        CREATE TABLE IF NOT EXISTS SchemaVersion (
          Module VARCHAR(50) NULL,
          Version INT(11) NOT NULL
        )`,
    }));
    
    const versionRows = await this.db.all(
      "SELECT Version FROM SchemaVersion WHERE Module IS NULL LIMIT 2",
    );
    if(versionRows.length > 1)
      throw new Error("FaucetStore has duplicate schema version rows.");
    if(versionRows.length === 1)
      schemaVersion = versionRows[0].Version as number;
    else
      await this.db.run("INSERT INTO SchemaVersion (Module, Version) VALUES (NULL, ?)", [0]);
    if(!isSchemaVersionInRange(schemaVersion, 0, latestSchemaVersion)) {
      throw new Error(
        `FaucetStore has an unsupported schema version; expected a safe integer from 0 through ${latestSchemaVersion}.`,
      );
    }
    ServiceManager.GetService(FaucetProcess).emitLog(
      FaucetLogLevel.INFO,
      "Current FaucetStore schema version: " + (versionRows.length === 1 ? schemaVersion : "uninitialized"),
    );
    
    let oldVersion = schemaVersion;
    switch(schemaVersion) {
      case 0: // upgrade to version 1
        schemaVersion = 1;
        await this.db.exec(SQL.driverSql({
          [FaucetDbDriver.SQLITE]: `
            CREATE TABLE KeyValueStore (
              Key	TEXT NOT NULL UNIQUE,
              Value	TEXT NOT NULL,
              PRIMARY KEY(Key)
            );`,
          [FaucetDbDriver.MYSQL]: `
            CREATE TABLE KeyValueStore (
              \`Key\`	VARCHAR(250) NOT NULL,
              Value	TEXT NOT NULL,
              PRIMARY KEY(\`Key\`)
            );`,
          }));
        await this.db.exec(SQL.driverSql({
          [FaucetDbDriver.SQLITE]: `
            CREATE TABLE Sessions (
              SessionId TEXT NOT NULL UNIQUE,
              Status TEXT NOT NULL,
              StartTime INTEGER NOT NULL,
              TargetAddr TEXT NOT NULL,
              DropAmount TEXT NOT NULL,
              RemoteIP TEXT NOT NULL,
              Tasks TEXT NOT NULL,
              Data TEXT NOT NULL,
              ClaimData TEXT NULL,
              PRIMARY KEY(SessionId)
            );`,
          [FaucetDbDriver.MYSQL]: `
            CREATE TABLE Sessions (
              SessionId CHAR(36) NOT NULL,
              Status VARCHAR(30) NOT NULL,
              StartTime INT(11) NOT NULL,
              TargetAddr CHAR(42) NOT NULL,
              DropAmount VARCHAR(50) NOT NULL,
              RemoteIP VARCHAR(40) NOT NULL,
              Tasks TEXT NOT NULL,
              Data TEXT NOT NULL,
              ClaimData TEXT NULL,
              PRIMARY KEY(SessionId)
            );`,
          }));
        await this.db.exec(SQL.driverSql({
          [FaucetDbDriver.SQLITE]: `CREATE INDEX SessionsTimeIdx ON Sessions (StartTime	ASC);`,
          [FaucetDbDriver.MYSQL]: `ALTER TABLE Sessions ADD INDEX SessionsTimeIdx (StartTime);`,
        }));
        await this.db.exec(SQL.driverSql({
          [FaucetDbDriver.SQLITE]: `CREATE INDEX SessionsStatusIdx ON Sessions (Status	ASC);`,
          [FaucetDbDriver.MYSQL]: `ALTER TABLE Sessions ADD INDEX SessionsStatusIdx (Status);`,
        }));
        await this.db.exec(SQL.driverSql({
          [FaucetDbDriver.SQLITE]: `CREATE INDEX SessionsTargetAddrIdx ON Sessions (TargetAddr	ASC, StartTime	ASC);`,
          [FaucetDbDriver.MYSQL]: `ALTER TABLE Sessions ADD INDEX SessionsTargetAddrIdx (TargetAddr, StartTime);`,
        }));
        await this.db.exec(SQL.driverSql({
          [FaucetDbDriver.SQLITE]: `CREATE INDEX SessionsRemoteIPIdx ON Sessions (RemoteIP	ASC, StartTime	ASC);`,
          [FaucetDbDriver.MYSQL]: `ALTER TABLE Sessions ADD INDEX SessionsRemoteIPIdx (RemoteIP, StartTime);`,
          }));
      case 1: // upgrade to version 2
        schemaVersion = 2;
    }
    await this.ensureSessionCleanupIndex();
    if(schemaVersion !== oldVersion) {
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.INFO, "Upgraded FaucetStore schema from version " + oldVersion + " to version " + schemaVersion);
      await this.db.run("UPDATE SchemaVersion SET Version = ? WHERE Module IS NULL", [schemaVersion]);
    }
  }

  private async ensureSessionCleanupIndex(): Promise<void> {
    if(faucetConfig.database.driver === FaucetDbDriver.SQLITE) {
      const state = await this.validateSQLiteSessionCleanupIndex();
      if(state === "compatible")
        return;
      if(state === "incompatible")
        await this.db.exec("DROP INDEX SessionsCleanupIdx");
      await this.db.exec("CREATE INDEX SessionsCleanupIdx ON Sessions (StartTime ASC, SessionId ASC)");
      if(await this.validateSQLiteSessionCleanupIndex() !== "compatible")
        throw new Error("Session cleanup index was not created.");
      return;
    }

    const state = await this.validateMySQLSessionCleanupIndex();
    if(state === "compatible")
      return;
    if(state === "incompatible")
      await this.db.exec("ALTER TABLE Sessions DROP INDEX SessionsCleanupIdx");
    await this.db.exec("ALTER TABLE Sessions ADD INDEX SessionsCleanupIdx (StartTime, SessionId)");
    if(await this.validateMySQLSessionCleanupIndex() !== "compatible")
      throw new Error("Session cleanup index was not created.");
  }

  private async validateSQLiteSessionCleanupIndex(): Promise<SessionCleanupIndexState> {
    const matching = (await this.db.all('PRAGMA index_list("Sessions")'))
      .filter((row) => row["name"] === "SessionsCleanupIdx");
    if(matching.length === 0)
      return "missing";
    if(
      matching.length !== 1
      || matching[0]["unique"] !== 0
      || matching[0]["partial"] !== 0
    )
      return "incompatible";

    const columns = (await this.db.all('PRAGMA index_xinfo("SessionsCleanupIdx")'))
      .filter((row) => row["key"] === 1);
    const expectedColumns = ["StartTime", "SessionId"];
    const compatible = columns.length === expectedColumns.length
      && columns.every((row, index) => (
        row["seqno"] === index
        && row["name"] === expectedColumns[index]
        && row["desc"] === 0
        && row["coll"] === "BINARY"
      ));
    return compatible ? "compatible" : "incompatible";
  }

  private async validateMySQLSessionCleanupIndex(): Promise<SessionCleanupIndexState> {
    const columns = await this.db.all([
      "SELECT NON_UNIQUE AS NonUnique, SEQ_IN_INDEX AS SequenceIndex,",
      "COLUMN_NAME AS ColumnName, COLLATION AS Collation, SUB_PART AS SubPart,",
      "INDEX_TYPE AS IndexType, IS_VISIBLE AS IsVisible FROM information_schema.statistics",
      "WHERE table_schema = DATABASE() AND table_name = 'Sessions'",
      "AND index_name = 'SessionsCleanupIdx' ORDER BY SEQ_IN_INDEX",
    ].join(" "));
    if(columns.length === 0)
      return "missing";

    const expectedColumns = ["StartTime", "SessionId"];
    const compatible = columns.length === expectedColumns.length
      && columns.every((row, index) => (
        Number(row["NonUnique"]) === 1
        && Number(row["SequenceIndex"]) === index + 1
        && row["ColumnName"] === expectedColumns[index]
        && row["Collation"] === "A"
        && row["SubPart"] === null
        && row["IndexType"] === "BTREE"
        && row["IsVisible"] === "YES"
      ));
    return compatible ? "compatible" : "incompatible";
  }


  private now(): number {
    return Math.floor((new Date()).getTime() / 1000);
  }

  public async cleanStore(): Promise<void> {
    if(!this.initialized)
      return;
    if(this.cleanupInFlight)
      return this.cleanupInFlight;

    const cleanup = this.cleanStoreBounded();
    this.cleanupInFlight = cleanup;
    try {
      await cleanup;
    } finally {
      if(this.cleanupInFlight === cleanup)
        this.cleanupInFlight = null;
    }
  }

  private async cleanStoreBounded(): Promise<void> {
    let cutoff = this.now() - faucetConfig.sessionCleanup;
    let processed = 0;
    while(processed < SESSION_CLEANUP_RUN_LIMIT) {
      const batchLimit = Math.min(
        SESSION_CLEANUP_BATCH_SIZE,
        SESSION_CLEANUP_RUN_LIMIT - processed,
      );
      const batchCursor = this.sessionCleanupCursor;
      const candidates = await this.selectSessionCleanupBatch(
        cutoff,
        batchCursor,
        batchLimit,
      );
      if(candidates.length > batchLimit)
        throw new Error("Session cleanup query exceeded its requested batch size.");
      if(candidates.length === 0) {
        this.sessionCleanupCursor = null;
        if(batchCursor && processed === 0)
          continue;
        break;
      }

      for(let candidate of candidates) {
        if(typeof candidate.SessionId !== "string" || !Number.isSafeInteger(candidate.StartTime))
          throw new Error("Session cleanup encountered an invalid keyset key.");
        const cleanupCandidate: SessionCleanupCandidate = {
          sessionId: candidate.SessionId,
          status: candidate.Status as FaucetSessionStatus,
          startTime: candidate.StartTime,
          targetAddr: candidate.TargetAddr,
          dataJson: candidate.Data,
          claimDataJson: candidate.ClaimData,
          claim: null,
        };
        await this.cleanupSessionCandidate(cleanupCandidate);
        this.sessionCleanupCursor = {
          startTime: candidate.StartTime,
          sessionId: candidate.SessionId,
        };
        processed++;
      }

      if(candidates.length < batchLimit) {
        this.sessionCleanupCursor = null;
        break;
      }
    }

    await Promise.all(Object.values(this.moduleDBs).map((modDb) => modDb.cleanStore()));
  }

  private async selectSessionCleanupBatch(
    cutoff: number,
    cursor: SessionCleanupCursor | null,
    limit: number,
  ): Promise<SessionCleanupRow[]> {
    const cursorSql = cursor
      ? "AND (StartTime > ? OR (StartTime = ? AND SessionId > ?))"
      : "";
    const args: (number | string)[] = [cutoff];
    if(cursor)
      args.push(cursor.startTime, cursor.startTime, cursor.sessionId);
    args.push(limit);

    return this.db.all(SQL.driverSql({
      [FaucetDbDriver.SQLITE]: [
        "SELECT SessionId, Status, StartTime, TargetAddr, Data, ClaimData",
        "FROM Sessions INDEXED BY SessionsCleanupIdx",
        "WHERE StartTime < ? AND Status IN ('finished', 'failed')",
        cursorSql,
        "ORDER BY StartTime ASC, SessionId ASC LIMIT ?",
      ].filter(Boolean).join(" "),
      [FaucetDbDriver.MYSQL]: [
        "SELECT SessionId, Status, StartTime, TargetAddr, Data, ClaimData",
        "FROM Sessions FORCE INDEX (SessionsCleanupIdx)",
        "WHERE StartTime < ? AND Status IN ('finished', 'failed')",
        "AND BINARY Status IN (BINARY 'finished', BINARY 'failed')",
        cursorSql,
        "ORDER BY StartTime ASC, SessionId ASC LIMIT ?",
      ].filter(Boolean).join(" "),
    }), args) as unknown as Promise<SessionCleanupRow[]>;
  }

  public async cleanupSessionCandidate(candidate: SessionCleanupCandidate): Promise<boolean> {
    if(
      candidate.status !== FaucetSessionStatus.FINISHED
      && candidate.status !== FaucetSessionStatus.FAILED
    ) {
      return false;
    }
    if(
      typeof candidate.sessionId !== "string"
      || candidate.sessionId.length === 0
      || !Number.isSafeInteger(candidate.startTime)
      || typeof candidate.targetAddr !== "string"
      || typeof candidate.dataJson !== "string"
      || (candidate.claimDataJson !== null && typeof candidate.claimDataJson !== "string")
      || this.hasUnresolvedClaimLiability(candidate.status, candidate.claimDataJson)
    ) {
      return false;
    }

    let claim: EthClaimData | null = null;
    if(candidate.claimDataJson !== null) {
      const parsedClaim: unknown = JSON.parse(candidate.claimDataJson);
      if(!isClaimData(parsedClaim))
        return false;
      claim = parsedClaim;
    }
    const exactCandidate: SessionCleanupCandidate = {
      ...candidate,
      claim,
    };
    if(!await this.passesSessionCleanupGuards(exactCandidate))
      return false;

    let deleteFailure: {error: unknown} | null = null;
    let deleteChanges: number | null = null;
    const deleteArgs = faucetConfig.database.driver === FaucetDbDriver.MYSQL
      ? exactCandidate.claimDataJson === null
        ? [
            exactCandidate.sessionId,
            exactCandidate.sessionId,
            exactCandidate.status,
            exactCandidate.status,
            exactCandidate.startTime,
            exactCandidate.targetAddr,
            exactCandidate.targetAddr,
            exactCandidate.dataJson,
          ]
        : [
            exactCandidate.sessionId,
            exactCandidate.sessionId,
            exactCandidate.status,
            exactCandidate.status,
            exactCandidate.startTime,
            exactCandidate.targetAddr,
            exactCandidate.targetAddr,
            exactCandidate.dataJson,
            exactCandidate.claimDataJson,
          ]
      : exactCandidate.claimDataJson === null
        ? [
            exactCandidate.sessionId,
            exactCandidate.status,
            exactCandidate.startTime,
            exactCandidate.targetAddr,
            exactCandidate.dataJson,
          ]
        : [
            exactCandidate.sessionId,
            exactCandidate.status,
            exactCandidate.startTime,
            exactCandidate.targetAddr,
            exactCandidate.dataJson,
            exactCandidate.claimDataJson,
          ];
    try {
      const result = await this.db.run(SQL.driverSql({
        [FaucetDbDriver.SQLITE]: exactCandidate.claimDataJson === null
          ? [
              "DELETE FROM Sessions WHERE SessionId = ? AND Status = ? AND StartTime = ?",
              "AND TargetAddr = ? AND Data = ? AND ClaimData IS NULL",
            ].join(" ")
          : [
              "DELETE FROM Sessions WHERE SessionId = ? AND Status = ? AND StartTime = ?",
              "AND TargetAddr = ? AND Data = ? AND ClaimData = ?",
            ].join(" "),
        [FaucetDbDriver.MYSQL]: exactCandidate.claimDataJson === null
          ? [
              "DELETE FROM Sessions WHERE SessionId = ? AND BINARY SessionId = BINARY ?",
              "AND Status = ? AND BINARY Status = BINARY ? AND StartTime = ?",
              "AND TargetAddr = ? AND BINARY TargetAddr = BINARY ? AND BINARY Data = BINARY ?",
              "AND ClaimData IS NULL",
            ].join(" ")
          : [
              "DELETE FROM Sessions WHERE SessionId = ? AND BINARY SessionId = BINARY ?",
              "AND Status = ? AND BINARY Status = BINARY ? AND StartTime = ?",
              "AND TargetAddr = ? AND BINARY TargetAddr = BINARY ? AND BINARY Data = BINARY ?",
              "AND BINARY ClaimData = BINARY ?",
            ].join(" "),
      }), deleteArgs);
      deleteChanges = result.changes;
    } catch(error) {
      deleteFailure = {error};
    }
    if(deleteChanges !== null) {
      if(deleteChanges > 1)
        throw new Error("Session cleanup deleted more than one row for " + exactCandidate.sessionId);
      if(deleteChanges === 1)
        return true;
    }

    try {
      const remaining = await this.db.get(SQL.driverSql({
        [FaucetDbDriver.SQLITE]: "SELECT SessionId FROM Sessions WHERE SessionId = ?",
        [FaucetDbDriver.MYSQL]: [
          "SELECT SessionId FROM Sessions WHERE SessionId = ?",
          "AND BINARY SessionId = BINARY ?",
        ].join(" "),
      }), faucetConfig.database.driver === FaucetDbDriver.SQLITE
        ? [exactCandidate.sessionId]
        : [exactCandidate.sessionId, exactCandidate.sessionId]);
      if(!remaining)
        return true;
    } catch(reconciliationError) {
      if(deleteFailure) {
        throw new AggregateError(
          [deleteFailure.error, reconciliationError],
          "Session cleanup failed and persisted state could not be reconciled.",
        );
      }
      throw reconciliationError;
    }

    if(deleteFailure)
      throw deleteFailure.error;
    return false;
  }

  private hasUnresolvedClaimLiability(status: string, claimJson: string | null): boolean {
    if(claimJson === null)
      return false;
    let claim: unknown;
    try {
      claim = JSON.parse(claimJson);
    } catch {
      return true;
    }
    if(!isClaimData(claim))
      return true;
    switch(claim.claimStatus) {
      case ClaimTxStatus.QUEUE:
      case ClaimTxStatus.PREPARED:
      case ClaimTxStatus.PENDING:
        return true;
      case ClaimTxStatus.CONFIRMED:
        return status !== FaucetSessionStatus.FINISHED;
      case ClaimTxStatus.REVERTED:
      case ClaimTxStatus.FAILED:
        return status !== FaucetSessionStatus.FAILED;
    }
  }

  public async dropAllTables() {
    // for tests only! this drops the whole DB.
    let tables = await this.db.all(
      SQL.driverSql({
        [FaucetDbDriver.SQLITE]: "SELECT name FROM sqlite_schema WHERE type ='table' AND name NOT LIKE 'sqlite_%'",
        [FaucetDbDriver.MYSQL]: "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()",
      })
    ) as {
      name: string;
    }[];

    let dropPromises = tables.map((table) => {
      return this.db.run("DROP TABLE " + table.name);
    });

    await Promise.all(dropPromises);
  }

  public async getKeyValueEntry(key: string): Promise<string> {
    let row = await this.db.get("SELECT " + SQL.field("Value") + " FROM KeyValueStore WHERE " + SQL.field("Key") + " = ?", [key]) as {Value: string};
    return row?.Value;
  }

  public async setKeyValueEntry(key: string, value: string): Promise<void> {
    await this.db.run(
      SQL.driverSql({
        [FaucetDbDriver.SQLITE]: "INSERT OR REPLACE INTO KeyValueStore (Key,Value) VALUES (?,?)",
        [FaucetDbDriver.MYSQL]: "REPLACE INTO KeyValueStore (`Key`,Value) VALUES (?,?)",
      }),
      [
        key,
        value,
      ]
    );
  }

  public async compareAndSetKeyValueEntry(key: string, expectedValue: string, value: string): Promise<boolean> {
    let result = await this.db.run(SQL.driverSql({
      [FaucetDbDriver.SQLITE]: "UPDATE KeyValueStore SET Value = ? WHERE Key = ? AND Value = ?",
      [FaucetDbDriver.MYSQL]: "UPDATE KeyValueStore SET Value = ? WHERE `Key` = ? AND BINARY Value = BINARY ?",
    }), [value, key, expectedValue]);
    return result.changes === 1;
  }

  public async deleteKeyValueEntry(key: string): Promise<void> {
    await this.db.run("DELETE FROM KeyValueStore WHERE " + SQL.field("Key") + " = ?", [key]);
  }



  private selectSessions(whereSql: string, whereArgs: any[], skipData?: boolean): Promise<FaucetSessionStoreData[]> {
    let sql = [
      "FROM Sessions WHERE ",
      whereSql
    ].join("");
    return this.selectSessionsSql(sql, whereArgs, skipData);
  }

  public async selectSessionsSql(selectSql: string, args: any[], skipData?: boolean): Promise<FaucetSessionStoreData[]> {
    let fields = ["SessionId","Status","StartTime","TargetAddr","DropAmount","RemoteIP","Tasks"];
    if(!skipData)
      fields.push("Data","ClaimData");

    let sql = [
      "SELECT ",
      fields.map((f) => "Sessions." + f).join(","),
      " ",
      selectSql
    ].join("");
    let rows = await this.db.all(sql, args) as {
      SessionId: string;
      Status: string;
      StartTime: number;
      TargetAddr: string;
      DropAmount: string;
      RemoteIP: string;
      Tasks: string;
      Data: string;
      ClaimData: string;
    }[];

    if(rows.length === 0)
      return [];
    
    return rows.map((row) => {
      return {
        sessionId: row.SessionId,
        status: row.Status as FaucetSessionStatus,
        startTime: row.StartTime,
        targetAddr: row.TargetAddr,
        dropAmount: row.DropAmount,
        remoteIP: row.RemoteIP,
        tasks: JSON.parse(row.Tasks),
        data: skipData ? undefined : JSON.parse(row.Data),
        claim: skipData ? undefined : (row.ClaimData ? JSON.parse(row.ClaimData) : null),
      };
    });
  }

  public getSessions(states: FaucetSessionStatus[]): Promise<FaucetSessionStoreData[]> {
    return this.selectSessions("Status IN (" + states.map(() => "?").join(",") + ")", states);
  }

  public async getAllSessions(timeLimit: number): Promise<FaucetSessionStoreData[]> {
    let now = Math.floor(new Date().getTime() / 1000);
    return this.selectSessions("Status NOT IN ('finished', 'failed') OR StartTime > ?", [now - timeLimit]);
  }

  public async getTimedOutSessions(timeout: number): Promise<FaucetSessionStoreData[]> {
    let now = Math.floor(new Date().getTime() / 1000);
    return this.selectSessions("Status NOT IN ('claiming', 'finished', 'failed') AND StartTime <= ?", [now - timeout]);
  }

  public async tryTimeoutSession(sessionData: FaucetSessionStoreData, timeout: number): Promise<boolean> {
    let failedData = {
      ...(sessionData.data || {}),
      "failed.code": "SESSION_TIMEOUT",
      "failed.reason": "Session timed out",
    };
    let result = await this.db.run(SQL.driverSql({
      [FaucetDbDriver.SQLITE]: "UPDATE Sessions SET Status = 'failed', Data = ? WHERE SessionId = ? AND Status = ? AND StartTime = ? AND StartTime <= ? AND ClaimData IS NULL AND Data = ?",
      [FaucetDbDriver.MYSQL]: "UPDATE Sessions SET Status = 'failed', Data = ? WHERE SessionId = ? AND BINARY Status = BINARY ? AND StartTime = ? AND StartTime <= ? AND ClaimData IS NULL AND BINARY Data = BINARY ?",
    }), [
      JSON.stringify(failedData),
      sessionData.sessionId,
      sessionData.status,
      sessionData.startTime,
      this.now() - timeout,
      JSON.stringify(sessionData.data),
    ]);
    return result.changes === 1;
  }

  public async getFinishedSessions(targetAddr: string, remoteIP: string, timeout: number, skipData?: boolean): Promise<FaucetSessionStoreData[]> {
    let now = Math.floor(new Date().getTime() / 1000);
    let whereSql: string[] = [];
    let whereArgs: any[] = [];
    if(targetAddr) {
      whereSql.push("LOWER(TargetAddr) = LOWER(?)");
      whereArgs.push(targetAddr);
    }
    if(remoteIP) {
      whereSql.push("RemoteIP LIKE ?");
      whereArgs.push(remoteIP);
    }
    if(whereSql.length === 0)
      throw "invalid query";
    
    whereArgs.push(now - timeout);
    return this.selectSessions("(" + whereSql.join(" OR ") + ") AND StartTime > ? AND Status IN ('claimable','claiming','finished')", whereArgs, skipData);
  }

  public async getSession(sessionId: string): Promise<FaucetSessionStoreData> {
    let row = await this.db.get("SELECT SessionId,Status,StartTime,TargetAddr,DropAmount,RemoteIP,Tasks,Data,ClaimData FROM Sessions WHERE SessionId = ?", [sessionId]) as {
      SessionId: string;
      Status: string;
      StartTime: number;
      TargetAddr: string;
      DropAmount: string;
      RemoteIP: string;
      Tasks: string;
      Data: string;
      ClaimData: string;
    };

    if(!row)
      return null;
    
    return {
      sessionId: row.SessionId,
      status: row.Status as FaucetSessionStatus,
      startTime: row.StartTime,
      targetAddr: row.TargetAddr,
      dropAmount: row.DropAmount,
      remoteIP: row.RemoteIP,
      tasks: JSON.parse(row.Tasks),
      data: JSON.parse(row.Data),
      claim: row.ClaimData ? JSON.parse(row.ClaimData) : null,
    };
  }

  public async updateSession(sessionData: FaucetSessionStoreData): Promise<boolean> {
    let claimJson = sessionData.claim ? JSON.stringify(sessionData.claim) : null;
    let updateExisting = async (): Promise<boolean> => {
      let result = await this.db.run(SQL.driverSql({
        [FaucetDbDriver.SQLITE]: claimJson === null
          ? "UPDATE Sessions SET StartTime = ?, TargetAddr = ?, DropAmount = ?, RemoteIP = ?, Tasks = ?, Data = ? WHERE SessionId = ? AND Status = ? AND ClaimData IS NULL"
          : "UPDATE Sessions SET StartTime = ?, TargetAddr = ?, DropAmount = ?, RemoteIP = ?, Tasks = ?, Data = ? WHERE SessionId = ? AND Status = ? AND ClaimData = ?",
        [FaucetDbDriver.MYSQL]: claimJson === null
          ? "UPDATE Sessions SET StartTime = ?, TargetAddr = ?, DropAmount = ?, RemoteIP = ?, Tasks = ?, Data = ? WHERE SessionId = ? AND BINARY Status = BINARY ? AND ClaimData IS NULL"
          : "UPDATE Sessions SET StartTime = ?, TargetAddr = ?, DropAmount = ?, RemoteIP = ?, Tasks = ?, Data = ? WHERE SessionId = ? AND BINARY Status = BINARY ? AND BINARY ClaimData = BINARY ?",
      }), claimJson === null ? [
        sessionData.startTime,
        sessionData.targetAddr,
        sessionData.dropAmount,
        sessionData.remoteIP,
        JSON.stringify(sessionData.tasks),
        JSON.stringify(sessionData.data),
        sessionData.sessionId,
        sessionData.status,
      ] : [
        sessionData.startTime,
        sessionData.targetAddr,
        sessionData.dropAmount,
        sessionData.remoteIP,
        JSON.stringify(sessionData.tasks),
        JSON.stringify(sessionData.data),
        sessionData.sessionId,
        sessionData.status,
        claimJson,
      ]);
      if(result.changes === 1)
        return true;
      let current = await this.db.get(SQL.driverSql({
        [FaucetDbDriver.SQLITE]: claimJson === null
          ? "SELECT SessionId FROM Sessions WHERE SessionId = ? AND Status = ? AND ClaimData IS NULL"
          : "SELECT SessionId FROM Sessions WHERE SessionId = ? AND Status = ? AND ClaimData = ?",
        [FaucetDbDriver.MYSQL]: claimJson === null
          ? "SELECT SessionId FROM Sessions WHERE SessionId = ? AND BINARY Status = BINARY ? AND ClaimData IS NULL"
          : "SELECT SessionId FROM Sessions WHERE SessionId = ? AND BINARY Status = BINARY ? AND BINARY ClaimData = BINARY ?",
      }), claimJson === null
        ? [sessionData.sessionId, sessionData.status]
        : [sessionData.sessionId, sessionData.status, claimJson]);
      return current !== null;
    };

    if(await updateExisting())
      return true;
    if(await this.db.get("SELECT SessionId FROM Sessions WHERE SessionId = ?", [sessionData.sessionId]))
      return false;

    try {
      await this.db.run(
        "INSERT INTO Sessions (SessionId,Status,StartTime,TargetAddr,DropAmount,RemoteIP,Tasks,Data,ClaimData) VALUES (?,?,?,?,?,?,?,?,?)",
        [
          sessionData.sessionId,
          sessionData.status,
          sessionData.startTime,
          sessionData.targetAddr,
          sessionData.dropAmount,
          sessionData.remoteIP,
          JSON.stringify(sessionData.tasks),
          JSON.stringify(sessionData.data),
          claimJson,
        ],
      );
      return true;
    } catch(ex) {
      if(await updateExisting())
        return true;
      if(await this.db.get("SELECT SessionId FROM Sessions WHERE SessionId = ?", [sessionData.sessionId]))
        return false;
      throw ex;
    }
  }

  public async insertRunningSession(sessionData: FaucetSessionStoreData): Promise<void> {
    if(sessionData.status !== FaucetSessionStatus.RUNNING || sessionData.claim !== null)
      throw new Error("Only an unclaimed running session can be inserted.");
    await this.db.run(
      "INSERT INTO Sessions (SessionId,Status,StartTime,TargetAddr,DropAmount,RemoteIP,Tasks,Data,ClaimData) VALUES (?,?,?,?,?,?,?,?,NULL)",
      [
        sessionData.sessionId,
        FaucetSessionStatus.RUNNING,
        sessionData.startTime,
        sessionData.targetAddr,
        sessionData.dropAmount,
        sessionData.remoteIP,
        JSON.stringify(sessionData.tasks),
        JSON.stringify(sessionData.data),
      ],
    );
  }

  public async updateRunningSession(sessionData: FaucetSessionStoreData): Promise<boolean> {
    if(sessionData.status !== FaucetSessionStatus.RUNNING || sessionData.claim !== null)
      throw new Error("Only an unclaimed running session can be updated.");
    let result = await this.db.run(
      "UPDATE Sessions SET DropAmount = ?, RemoteIP = ?, Tasks = ?, Data = ? WHERE SessionId = ? AND Status = 'running' AND ClaimData IS NULL",
      [
        sessionData.dropAmount,
        sessionData.remoteIP,
        JSON.stringify(sessionData.tasks),
        JSON.stringify(sessionData.data),
        sessionData.sessionId,
      ],
    );
    if(result.changes === 1)
      return true;
    let current = await this.db.get(
      "SELECT SessionId FROM Sessions WHERE SessionId = ? AND Status = 'running' AND ClaimData IS NULL",
      [sessionData.sessionId],
    );
    return current !== null;
  }

  public async transitionSession(
    sessionData: FaucetSessionStoreData,
    expectedStatus: FaucetSessionStatus,
  ): Promise<boolean> {
    if(
      (sessionData.status !== FaucetSessionStatus.CLAIMABLE && sessionData.status !== FaucetSessionStatus.FAILED)
      || sessionData.claim !== null
    ) {
      throw new Error("Invalid unclaimed session transition.");
    }
    let result = await this.db.run(SQL.driverSql({
      [FaucetDbDriver.SQLITE]: "UPDATE Sessions SET Status = ?, DropAmount = ?, RemoteIP = ?, Tasks = ?, Data = ? WHERE SessionId = ? AND Status = ? AND ClaimData IS NULL",
      [FaucetDbDriver.MYSQL]: "UPDATE Sessions SET Status = ?, DropAmount = ?, RemoteIP = ?, Tasks = ?, Data = ? WHERE SessionId = ? AND BINARY Status = BINARY ? AND ClaimData IS NULL",
    }), [
      sessionData.status,
      sessionData.dropAmount,
      sessionData.remoteIP,
      JSON.stringify(sessionData.tasks),
      JSON.stringify(sessionData.data),
      sessionData.sessionId,
      expectedStatus,
    ]);
    return result.changes === 1;
  }

  public async tryCreateClaim(sessionId: string, amount: string, claimData: EthClaimData): Promise<boolean> {
    let result = await this.db.run(
      "UPDATE Sessions SET Status = 'claiming', DropAmount = ?, ClaimData = ? WHERE SessionId = ? AND Status = 'claimable' AND ClaimData IS NULL",
      [amount, JSON.stringify(claimData), sessionId]
    );
    return result.changes === 1;
  }

  public async compareAndSetClaim(sessionId: string, expectedClaim: EthClaimData, claimData: EthClaimData): Promise<boolean> {
    let status: FaucetSessionStatus;
    switch(claimData.claimStatus) {
      case ClaimTxStatus.CONFIRMED:
        // Receipt confirmation is durable before required accounting hooks run.
        // The separate finalizeConfirmedClaim CAS publishes FINISHED afterward.
        status = FaucetSessionStatus.CLAIMING;
        break;
      case ClaimTxStatus.REVERTED:
      case ClaimTxStatus.FAILED:
        status = FaucetSessionStatus.FAILED;
        break;
      default:
        status = FaucetSessionStatus.CLAIMING;
        break;
    }
    let result = await this.db.run(SQL.driverSql({
      [FaucetDbDriver.SQLITE]: "UPDATE Sessions SET Status = ?, ClaimData = ? WHERE Status = 'claiming' AND SessionId = ? AND ClaimData = ?",
      [FaucetDbDriver.MYSQL]: "UPDATE Sessions SET Status = ?, ClaimData = ? WHERE Status = 'claiming' AND SessionId = ? AND BINARY ClaimData = BINARY ?",
    }), [
      status,
      JSON.stringify(claimData),
      sessionId,
      JSON.stringify(expectedClaim),
    ]);
    return result.changes === 1;
  }

  public async finalizeConfirmedClaim(sessionId: string, claimData: EthClaimData): Promise<boolean> {
    if(claimData.claimStatus !== ClaimTxStatus.CONFIRMED)
      throw new Error("Only a confirmed claim can be finalized.");
    let result = await this.db.run(SQL.driverSql({
      [FaucetDbDriver.SQLITE]: "UPDATE Sessions SET Status = 'finished' WHERE Status = 'claiming' AND SessionId = ? AND ClaimData = ?",
      [FaucetDbDriver.MYSQL]: "UPDATE Sessions SET Status = 'finished' WHERE BINARY Status = BINARY 'claiming' AND SessionId = ? AND BINARY ClaimData = BINARY ?",
    }), [sessionId, JSON.stringify(claimData)]);
    return result.changes === 1;
  }

  public async getClaimableAmount(): Promise<bigint> {
    // Native SUM coerces SQLite text to floating point and gives MySQL a fixed decimal precision.
    // Sum each decimal position in SQL, then combine the returned strings with BigInt.
    const rows = await this.db.all(SQL.driverSql({
      [FaucetDbDriver.SQLITE]: [
        "WITH RECURSIVE",
        "Validation(InvalidAmount, OversizedAmount) AS (",
        "SELECT CASE WHEN EXISTS (",
        "SELECT 1 FROM Sessions WHERE Status = 'claimable'",
        "AND (DropAmount = '' OR DropAmount GLOB '*[^0-9]*')",
        ") THEN 1 ELSE 0 END,",
        "CASE WHEN EXISTS (",
        "SELECT 1 FROM Sessions WHERE Status = 'claimable'",
        "AND LENGTH(DropAmount) > 50",
        ") THEN 1 ELSE 0 END",
        "),",
        "Bounds(MaxDigits) AS (",
        "SELECT COALESCE(MAX(LENGTH(DropAmount)), 0)",
        "FROM Sessions WHERE Status = 'claimable'",
        "),",
        "Positions(DigitPosition) AS (",
        "SELECT 1 FROM Bounds, Validation",
        "WHERE MaxDigits > 0 AND InvalidAmount = 0 AND OversizedAmount = 0",
        "UNION ALL",
        "SELECT DigitPosition + 1 FROM Positions, Bounds",
        "WHERE DigitPosition < MaxDigits",
        ")",
        "SELECT Positions.DigitPosition AS DigitPosition,",
        "CAST(SUM(CAST(SUBSTR(Sessions.DropAmount, -Positions.DigitPosition, 1) AS INTEGER)) AS TEXT) AS DigitSum,",
        "Validation.InvalidAmount AS InvalidAmount,",
        "Validation.OversizedAmount AS OversizedAmount",
        "FROM Positions CROSS JOIN Validation",
        "JOIN Sessions ON Positions.DigitPosition <= LENGTH(Sessions.DropAmount)",
        "WHERE Sessions.Status = 'claimable'",
        "AND Validation.InvalidAmount = 0 AND Validation.OversizedAmount = 0",
        "GROUP BY Positions.DigitPosition, Validation.InvalidAmount, Validation.OversizedAmount",
        "UNION ALL",
        "SELECT 0 AS DigitPosition, CAST(0 AS TEXT) AS DigitSum,",
        "Validation.InvalidAmount AS InvalidAmount, Validation.OversizedAmount AS OversizedAmount",
        "FROM Validation CROSS JOIN Bounds",
        "WHERE Validation.InvalidAmount = 1 OR Validation.OversizedAmount = 1 OR Bounds.MaxDigits = 0",
        "ORDER BY DigitPosition ASC",
      ].join(" "),
      [FaucetDbDriver.MYSQL]: [
        "WITH RECURSIVE",
        "Validation(InvalidAmount, OversizedAmount) AS (",
        "SELECT CASE WHEN EXISTS (",
        "SELECT 1 FROM Sessions WHERE Status = 'claimable'",
        "AND BINARY Status = BINARY 'claimable'",
        "AND (DropAmount = '' OR DropAmount REGEXP '[^0-9]')",
        ") THEN 1 ELSE 0 END,",
        "CASE WHEN EXISTS (",
        "SELECT 1 FROM Sessions WHERE Status = 'claimable'",
        "AND BINARY Status = BINARY 'claimable'",
        "AND CHAR_LENGTH(DropAmount) > 50",
        ") THEN 1 ELSE 0 END",
        "),",
        "Bounds(MaxDigits) AS (",
        "SELECT COALESCE(MAX(CHAR_LENGTH(DropAmount)), 0)",
        "FROM Sessions WHERE Status = 'claimable'",
        "AND BINARY Status = BINARY 'claimable'",
        "),",
        "Positions(DigitPosition) AS (",
        "SELECT 1 FROM Bounds, Validation",
        "WHERE MaxDigits > 0 AND InvalidAmount = 0 AND OversizedAmount = 0",
        "UNION ALL",
        "SELECT DigitPosition + 1 FROM Positions, Bounds",
        "WHERE DigitPosition < MaxDigits",
        ")",
        "SELECT Positions.DigitPosition AS DigitPosition,",
        "CAST(SUM(CAST(SUBSTRING(Sessions.DropAmount, -Positions.DigitPosition, 1) AS UNSIGNED)) AS CHAR) AS DigitSum,",
        "Validation.InvalidAmount AS InvalidAmount,",
        "Validation.OversizedAmount AS OversizedAmount",
        "FROM Positions CROSS JOIN Validation",
        "JOIN Sessions ON Positions.DigitPosition <= CHAR_LENGTH(Sessions.DropAmount)",
        "WHERE Sessions.Status = 'claimable'",
        "AND BINARY Sessions.Status = BINARY 'claimable'",
        "AND Validation.InvalidAmount = 0 AND Validation.OversizedAmount = 0",
        "GROUP BY Positions.DigitPosition, Validation.InvalidAmount, Validation.OversizedAmount",
        "UNION ALL",
        "SELECT 0 AS DigitPosition, CAST(0 AS CHAR) AS DigitSum,",
        "Validation.InvalidAmount AS InvalidAmount, Validation.OversizedAmount AS OversizedAmount",
        "FROM Validation CROSS JOIN Bounds",
        "WHERE Validation.InvalidAmount = 1 OR Validation.OversizedAmount = 1 OR Bounds.MaxDigits = 0",
        "ORDER BY DigitPosition ASC",
      ].join(" "),
    })) as unknown as ClaimableDigitSumRow[];

    let total = 0n;
    let place = 1n;
    let expectedPosition = 1;
    for(let row of rows) {
      if(row.OversizedAmount === 1)
        throw new Error("Claimable DropAmount exceeds the 50-digit storage limit.");
      if(row.InvalidAmount === 1)
        throw new Error("Claimable DropAmount must be a non-empty decimal string.");
      if(row.DigitPosition === 0)
        continue;
      if(
        row.DigitPosition !== expectedPosition
        || typeof row.DigitSum !== "string"
        || !/^[0-9]+$/.test(row.DigitSum)
      ) {
        throw new Error("Invalid claimable amount aggregate returned by the database.");
      }
      total += BigInt(row.DigitSum) * place;
      place *= 10n;
      expectedPosition++;
    }
    return total;
  }

}
