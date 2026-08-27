import { FaucetDbDriver } from '../../db/FaucetDatabase.js';
import { FaucetModuleDB } from '../../db/FaucetModuleDB.js';
import { SQL } from '../../db/SQL.js';
import { faucetConfig } from '../../config/FaucetConfig.js';
import type { IPassportInfo, IPassportStampInfo } from './PassportResolver.js';

const MAX_STAMP_CLAIMS_PER_REQUEST = 256;
const MAX_STAMP_HASH_CODE_UNITS = 250;
const MAX_STAMP_HASH_BYTES = 1000;
const MAX_STAMP_CLAIM_ATTEMPTS = 2;
const PASSPORT_CLEANUP_BATCH_SIZE = 1000;
const PASSPORT_CLEANUP_RUN_LIMIT = 10000;

type PassportTable = "PassportCache" | "PassportStamps" | "PassportCacheState";

interface PassportColumnSpec {
  readonly name: string;
  readonly sqliteDefinition: string;
  readonly sqliteType: "TEXT" | "INTEGER";
  readonly sqliteNotNull: 0 | 1;
  readonly sqliteDefault: string | null;
  readonly primaryKey: boolean;
  readonly mysqlDefinition: string;
  readonly mysqlType: "varchar" | "varbinary" | "char" | "text" | "int" | "tinyint";
  readonly mysqlMaxLength: number | null;
  readonly mysqlNullable: "YES" | "NO";
  readonly mysqlDefault: string | null;
  readonly mysqlUnsigned: boolean;
}

type SQLiteColumnType = PassportColumnSpec["sqliteType"];
type MySQLColumnType = PassportColumnSpec["mysqlType"];

interface PassportColumnOptions {
  readonly primaryKey?: boolean;
  readonly mysqlUnsigned?: boolean;
}

function requiredColumn(
  name: string,
  sqliteDefinition: string,
  sqliteType: SQLiteColumnType,
  mysqlDefinition: string,
  mysqlType: MySQLColumnType,
  mysqlMaxLength: number | null,
  options: PassportColumnOptions = {},
): PassportColumnSpec {
  return {
    name,
    sqliteDefinition,
    sqliteType,
    sqliteNotNull: 1,
    sqliteDefault: null,
    primaryKey: options.primaryKey ?? false,
    mysqlDefinition,
    mysqlType,
    mysqlMaxLength,
    mysqlNullable: "NO",
    mysqlDefault: null,
    mysqlUnsigned: options.mysqlUnsigned ?? false,
  };
}

function defaultedColumn(
  name: string,
  sqliteDefinition: string,
  sqliteType: SQLiteColumnType,
  sqliteDefault: string,
  mysqlDefinition: string,
  mysqlType: MySQLColumnType,
  mysqlMaxLength: number | null,
  mysqlDefault: string,
): PassportColumnSpec {
  return {
    ...requiredColumn(
      name,
      sqliteDefinition,
      sqliteType,
      mysqlDefinition,
      mysqlType,
      mysqlMaxLength,
    ),
    sqliteDefault,
    mysqlDefault,
  };
}

function nullableColumn(
  name: string,
  sqliteDefinition: string,
  sqliteType: SQLiteColumnType,
  mysqlDefinition: string,
  mysqlType: MySQLColumnType,
  mysqlMaxLength: number | null,
): PassportColumnSpec {
  return {
    ...requiredColumn(
      name,
      sqliteDefinition,
      sqliteType,
      mysqlDefinition,
      mysqlType,
      mysqlMaxLength,
    ),
    sqliteNotNull: 0,
    mysqlNullable: "YES",
  };
}

const PASSPORT_CACHE_BASE_COLUMNS = [
  requiredColumn("Address", "TEXT NOT NULL", "TEXT", "CHAR(42) NOT NULL", "char", 42, {
    primaryKey: true,
  }),
  requiredColumn("Json", "TEXT NOT NULL", "TEXT", "TEXT NOT NULL", "text", 65535),
  requiredColumn("Timeout", "INTEGER NOT NULL", "INTEGER", "INT(11) NOT NULL", "int", null),
] as const;

const PASSPORT_CACHE_V2_COLUMNS = [
  defaultedColumn(
    "Outcome",
    "TEXT NOT NULL DEFAULT 'error'",
    "TEXT",
    "'error'",
    "VARCHAR(16) NOT NULL DEFAULT 'error'",
    "varchar",
    16,
    "error",
  ),
  defaultedColumn(
    "TrustGeneration",
    "TEXT NOT NULL DEFAULT ''",
    "TEXT",
    "''",
    "CHAR(64) NOT NULL DEFAULT ''",
    "char",
    64,
    "",
  ),
  defaultedColumn(
    "CacheGeneration",
    "TEXT NOT NULL DEFAULT ''",
    "TEXT",
    "''",
    "CHAR(36) NOT NULL DEFAULT ''",
    "char",
    36,
    "",
  ),
  nullableColumn("OwnershipExpiry", "INTEGER NULL", "INTEGER", "INT(11) NULL", "int", null),
] as const;

const PASSPORT_STAMP_COLUMNS = [
  requiredColumn("Address", "TEXT NOT NULL", "TEXT", "CHAR(42) NOT NULL", "char", 42),
  requiredColumn("Timeout", "INTEGER NOT NULL", "INTEGER", "INT(11) NOT NULL", "int", null),
] as const;

const PASSPORT_STAMP_HASH_V3_COLUMN = requiredColumn(
  "StampHash",
  "TEXT NOT NULL",
  "TEXT",
  "VARBINARY(1000) NOT NULL",
  "varbinary",
  1000,
  {primaryKey: true},
);

const PASSPORT_CACHE_STATE_COLUMNS = [
  requiredColumn("Id", "INTEGER NOT NULL", "INTEGER", "TINYINT UNSIGNED NOT NULL", "tinyint", null, {
    primaryKey: true,
    mysqlUnsigned: true,
  }),
  requiredColumn("CacheGeneration", "TEXT NOT NULL", "TEXT", "CHAR(36) NOT NULL", "char", 36),
  requiredColumn("TrustGeneration", "TEXT NOT NULL", "TEXT", "CHAR(64) NOT NULL", "char", 64),
] as const;

const PASSPORT_CACHE_COLUMN_NAMES = [
  ...PASSPORT_CACHE_BASE_COLUMNS,
  ...PASSPORT_CACHE_V2_COLUMNS,
].map((column) => column.name);
const PASSPORT_STAMP_COLUMN_NAMES = [
  PASSPORT_STAMP_HASH_V3_COLUMN.name,
  ...PASSPORT_STAMP_COLUMNS.map((column) => column.name),
];
const PASSPORT_CACHE_STATE_COLUMN_NAMES = PASSPORT_CACHE_STATE_COLUMNS.map((column) => column.name);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRecordField(value: unknown, field: string): unknown {
  return isRecord(value) ? value[field] : undefined;
}

export type PassportCacheOutcome = "success" | "empty" | "error";

export type PassportCacheEntry =
  | {kind: "success", info: IPassportInfo, expiresAt: number, ownershipExpiry: number | null}
  | {kind: "empty", info: IPassportInfo, expiresAt: number}
  | {kind: "error", info: IPassportInfo, expiresAt: number};

export interface PassportCacheWrite {
  address: string;
  outcome: PassportCacheOutcome;
  info: IPassportInfo;
  duration: number;
  cacheGeneration: string;
  trustGeneration: string;
  ownershipExpiry?: number | null;
}

export interface PassportStampClaim {
  address: string | null;
  expiresAt: number | null;
}

interface PassportCacheRow {
  Json: string;
  Timeout: number;
  Outcome: string;
  OwnershipExpiry: number | null;
}

interface PassportCacheStateRow {
  CacheGeneration: string;
  TrustGeneration: string;
}

export class PassportDB extends FaucetModuleDB {
  protected override latestSchemaVersion = 3;

  public override async initSchema(): Promise<void> {
    await super.initSchema();
    await this.validateCurrentSchema();
  }

  protected override async upgradeSchema(version: number): Promise<number> {
    if(!Number.isSafeInteger(version) || version < 0 || version > this.latestSchemaVersion) {
      throw new Error(
        `Unsupported Passport schema version ${version}; this build supports up to ${this.latestSchemaVersion}.`,
      );
    }
    if(version === this.latestSchemaVersion)
      return version;

    await this.validateExistingSchema(version);
    await this.ensurePassportCacheTable();
    await this.ensurePassportStampsTable();
    await this.ensurePassportCacheStateTable();
    await this.ensurePassportCacheV2Columns();
    await this.ensureTimeIndex("PassportCache", "PassportCacheTimeIdx");
    await this.ensureTimeIndex("PassportStamps", "PassportStampsTimeIdx");
    await this.ensurePassportCacheStateRow();

    if(version < 2) {
      // Version 1 rows did not record whether an absence came from a successful
      // lookup or a transient scorer failure, and positive rows had no trust or
      // ownership generation. They cannot be upgraded safely.
      await this.db.run("DELETE FROM PassportCache");
    }

    await this.ensureStampHashV3();
    return 3;
  }

  private async validateCurrentSchema(): Promise<void> {
    const cacheColumns = await this.readTableColumns("PassportCache");
    this.assertPassportCacheColumns(cacheColumns, true);
    if(!await this.assertExistingTimeIndex("PassportCache", "PassportCacheTimeIdx"))
      throw new Error("Passport schema is missing index PassportCacheTimeIdx.");

    const stampColumns = await this.readTableColumns("PassportStamps");
    await this.assertPassportStampColumns(stampColumns);
    this.assertCompatibleColumn(
      "PassportStamps",
      PASSPORT_STAMP_HASH_V3_COLUMN,
      stampColumns.get("StampHash"),
    );
    if(!await this.assertExistingTimeIndex("PassportStamps", "PassportStampsTimeIdx"))
      throw new Error("Passport schema is missing index PassportStampsTimeIdx.");

    const stateColumns = await this.readTableColumns("PassportCacheState");
    this.assertPassportCacheStateColumns(stateColumns);
    const stateRows = await this.readAndValidateCacheStateRows();
    if(stateRows.length !== 1)
      throw new Error("PassportCacheState must contain exactly the Id = 1 state row.");
  }

  private async validateExistingSchema(version: number): Promise<void> {
    const cacheColumns = await this.readTableColumns("PassportCache");
    if(cacheColumns.size === 0) {
      if(version >= 1)
        throw new Error(`Passport schema version ${version} is missing required table PassportCache.`);
    } else {
      this.assertPassportCacheColumns(cacheColumns, version >= 2);
      await this.assertExistingTimeIndex("PassportCache", "PassportCacheTimeIdx");
    }

    const stampColumns = await this.readTableColumns("PassportStamps");
    if(stampColumns.size === 0) {
      if(version >= 1)
        throw new Error(`Passport schema version ${version} is missing required table PassportStamps.`);
    } else {
      await this.assertPassportStampColumns(stampColumns);
      await this.assertExistingTimeIndex("PassportStamps", "PassportStampsTimeIdx");
    }

    const stateColumns = await this.readTableColumns("PassportCacheState");
    if(stateColumns.size === 0) {
      if(version >= 2) {
        throw new Error(
          `Passport schema version ${version} is missing required table PassportCacheState.`,
        );
      }
    } else {
      this.assertPassportCacheStateColumns(stateColumns);
      const stateRows = await this.readAndValidateCacheStateRows();
      if(version >= 2 && stateRows.length !== 1)
        throw new Error("PassportCacheState must contain exactly the Id = 1 state row.");
    }
  }

  private async ensurePassportCacheTable(): Promise<void> {
    if((await this.readTableColumns("PassportCache")).size === 0) {
      await this.db.exec(SQL.driverSql({
        [FaucetDbDriver.SQLITE]: `
          CREATE TABLE "PassportCache" (
            "Address" TEXT NOT NULL UNIQUE,
            "Json" TEXT NOT NULL,
            "Timeout" INTEGER NOT NULL,
            "Outcome" TEXT NOT NULL DEFAULT 'error',
            "TrustGeneration" TEXT NOT NULL DEFAULT '',
            "CacheGeneration" TEXT NOT NULL DEFAULT '',
            "OwnershipExpiry" INTEGER NULL,
            PRIMARY KEY("Address")
          )`,
        [FaucetDbDriver.MYSQL]: `
          CREATE TABLE PassportCache (
            Address CHAR(42) NOT NULL UNIQUE,
            Json TEXT NOT NULL,
            Timeout INT(11) NOT NULL,
            Outcome VARCHAR(16) NOT NULL DEFAULT 'error',
            TrustGeneration CHAR(64) NOT NULL DEFAULT '',
            CacheGeneration CHAR(36) NOT NULL DEFAULT '',
            OwnershipExpiry INT(11) NULL,
            PRIMARY KEY(Address)
          )`,
      }));
    }
    const columns = await this.readTableColumns("PassportCache");
    this.assertPassportCacheColumns(columns, false);
  }

  private async ensurePassportStampsTable(): Promise<void> {
    if((await this.readTableColumns("PassportStamps")).size === 0) {
      await this.db.exec(SQL.driverSql({
        [FaucetDbDriver.SQLITE]: `
          CREATE TABLE "PassportStamps" (
            "StampHash" TEXT NOT NULL UNIQUE,
            "Address" TEXT NOT NULL,
            "Timeout" INTEGER NOT NULL,
            PRIMARY KEY("StampHash")
          )`,
        [FaucetDbDriver.MYSQL]: `
          CREATE TABLE PassportStamps (
            StampHash VARBINARY(1000) NOT NULL UNIQUE,
            Address CHAR(42) NOT NULL,
            Timeout INT(11) NOT NULL,
            PRIMARY KEY(StampHash)
          )`,
      }));
    }
    const columns = await this.readTableColumns("PassportStamps");
    await this.assertPassportStampColumns(columns);
  }

  private async ensurePassportCacheStateTable(): Promise<void> {
    if((await this.readTableColumns("PassportCacheState")).size === 0) {
      await this.db.exec(SQL.driverSql({
        [FaucetDbDriver.SQLITE]: `
          CREATE TABLE "PassportCacheState" (
            "Id" INTEGER NOT NULL,
            "CacheGeneration" TEXT NOT NULL,
            "TrustGeneration" TEXT NOT NULL,
            PRIMARY KEY("Id")
          )`,
        [FaucetDbDriver.MYSQL]: `
          CREATE TABLE PassportCacheState (
            Id TINYINT UNSIGNED NOT NULL,
            CacheGeneration CHAR(36) NOT NULL,
            TrustGeneration CHAR(64) NOT NULL,
            PRIMARY KEY(Id)
          )`,
      }));
    }
    this.assertPassportCacheStateColumns(await this.readTableColumns("PassportCacheState"));
  }

  private async ensurePassportCacheV2Columns(): Promise<void> {
    let columns = await this.readTableColumns("PassportCache");
    this.assertPassportCacheColumns(columns, false);
    for(const spec of PASSPORT_CACHE_V2_COLUMNS) {
      if(columns.has(spec.name))
        continue;
      await this.db.exec(faucetConfig.database.driver === FaucetDbDriver.SQLITE
        ? `ALTER TABLE "PassportCache" ADD COLUMN "${spec.name}" ${spec.sqliteDefinition}`
        : `ALTER TABLE PassportCache ADD COLUMN ${spec.name} ${spec.mysqlDefinition}`);
      columns = await this.readTableColumns("PassportCache");
      this.assertPassportCacheColumns(columns, false);
    }
    this.assertPassportCacheColumns(columns, true);
  }

  private async ensurePassportCacheStateRow(): Promise<void> {
    let rows = await this.readAndValidateCacheStateRows();
    if(rows.length === 0) {
      await this.db.run(
        "INSERT INTO PassportCacheState (Id, CacheGeneration, TrustGeneration) VALUES (1, '', '')",
      );
      rows = await this.readAndValidateCacheStateRows();
    }
    if(rows.length !== 1)
      throw new Error("PassportCacheState must contain exactly the Id = 1 state row.");
  }

  private async readAndValidateCacheStateRows(): Promise<unknown[]> {
    const rows = await this.db.all(
      "SELECT Id, CacheGeneration, TrustGeneration FROM PassportCacheState ORDER BY Id LIMIT 2",
    );
    if(rows.length > 1)
      throw new Error("PassportCacheState contains unexpected state rows.");
    if(rows.length === 0)
      return rows;

    const row = rows[0];
    const id = Number(getRecordField(row, "Id"));
    const cacheGeneration = getRecordField(row, "CacheGeneration");
    const trustGeneration = getRecordField(row, "TrustGeneration");
    const empty = cacheGeneration === "" && trustGeneration === "";
    const active = typeof cacheGeneration === "string"
      && /^[0-9a-f-]{36}$/i.test(cacheGeneration)
      && typeof trustGeneration === "string"
      && /^[0-9a-f]{64}$/i.test(trustGeneration);
    if(id !== 1 || (!empty && !active))
      throw new Error("PassportCacheState contains an invalid state row.");
    return rows;
  }

  private async ensureStampHashV3(): Promise<void> {
    let columns = await this.readTableColumns("PassportStamps");
    await this.assertPassportStampColumns(columns);

    if(
      faucetConfig.database.driver === FaucetDbDriver.MYSQL
      && !this.isCompatibleColumn(PASSPORT_STAMP_HASH_V3_COLUMN, columns.get("StampHash"))
    ) {
      await this.assertNoOversizedStampHash();
      await this.db.exec("ALTER TABLE PassportStamps MODIFY StampHash VARBINARY(1000) NOT NULL");
      columns = await this.readTableColumns("PassportStamps");
    }
    await this.assertPassportStampColumns(columns);
    this.assertCompatibleColumn("PassportStamps", PASSPORT_STAMP_HASH_V3_COLUMN, columns.get("StampHash"));
  }

  private async assertNoOversizedStampHash(): Promise<void> {
    if(faucetConfig.database.driver !== FaucetDbDriver.MYSQL)
      return;
    const oversizedStampHash = await this.db.get(`
      SELECT OCTET_LENGTH(StampHash) AS ByteLength
      FROM PassportStamps
      WHERE OCTET_LENGTH(StampHash) > ${MAX_STAMP_HASH_BYTES}
      LIMIT 1`);
    if(oversizedStampHash)
      throw new Error(`PassportStamps contains a StampHash exceeding the ${MAX_STAMP_HASH_BYTES}-byte identity limit`);
  }

  private assertConvertibleStampHash(row: unknown): void {
    if(faucetConfig.database.driver === FaucetDbDriver.SQLITE) {
      this.assertCompatibleColumn("PassportStamps", PASSPORT_STAMP_HASH_V3_COLUMN, row);
      return;
    }

    const dataType = getRecordField(row, "DataType");
    const maxLength = Number(getRecordField(row, "MaxLength"));
    const nullable = getRecordField(row, "Nullable");
    const defaultValue = getRecordField(row, "DefaultValue");
    const columnKey = getRecordField(row, "ColumnKey");
    const extra = getRecordField(row, "Extra");
    if(
      (dataType !== "varchar" && dataType !== "varbinary")
      || !Number.isSafeInteger(maxLength)
      || maxLength <= 0
      || nullable !== "NO"
      || defaultValue !== null
      || columnKey !== "PRI"
      || extra !== ""
    ) {
      throw new Error("Passport schema column PassportStamps.StampHash has an incompatible definition.");
    }
  }

  private async readTableColumns(table: PassportTable): Promise<Map<string, unknown>> {
    const rows = await this.db.all(faucetConfig.database.driver === FaucetDbDriver.SQLITE
      ? `PRAGMA table_xinfo("${table}")`
      : [
          "SELECT COLUMN_NAME AS Name, DATA_TYPE AS DataType, COLUMN_TYPE AS ColumnType,",
          "IS_NULLABLE AS Nullable, CHARACTER_MAXIMUM_LENGTH AS MaxLength,",
          "COLUMN_DEFAULT AS DefaultValue, COLUMN_KEY AS ColumnKey, EXTRA AS Extra",
          "FROM information_schema.columns",
          "WHERE table_schema = DATABASE() AND table_name = ?",
        ].join(" "),
      faucetConfig.database.driver === FaucetDbDriver.MYSQL ? [table] : undefined);
    const columns = new Map<string, unknown>();
    for(const row of rows) {
      const name = getRecordField(row, faucetConfig.database.driver === FaucetDbDriver.SQLITE ? "name" : "Name");
      if(typeof name !== "string" || name.length === 0 || columns.has(name))
        throw new Error(`Passport schema table ${table} contains an invalid column definition.`);
      if(
        faucetConfig.database.driver === FaucetDbDriver.SQLITE
        && getRecordField(row, "hidden") !== 0
      ) {
        throw new Error(`Passport schema table ${table} contains unsupported hidden column ${name}.`);
      }
      columns.set(name, row);
    }
    return columns;
  }

  private assertPassportCacheColumns(
    columns: Map<string, unknown>,
    requireV2Columns: boolean,
  ): void {
    this.assertKnownColumns("PassportCache", columns, PASSPORT_CACHE_COLUMN_NAMES);
    this.assertColumns("PassportCache", columns, PASSPORT_CACHE_BASE_COLUMNS);
    if(requireV2Columns)
      this.assertColumns("PassportCache", columns, PASSPORT_CACHE_V2_COLUMNS);
    else
      this.assertPresentColumns("PassportCache", columns, PASSPORT_CACHE_V2_COLUMNS);
  }

  private async assertPassportStampColumns(columns: Map<string, unknown>): Promise<void> {
    this.assertKnownColumns("PassportStamps", columns, PASSPORT_STAMP_COLUMN_NAMES);
    this.assertColumns("PassportStamps", columns, PASSPORT_STAMP_COLUMNS);
    const stampHash = columns.get("StampHash");
    if(!stampHash)
      throw new Error("Passport schema table PassportStamps is missing required column StampHash.");
    this.assertConvertibleStampHash(stampHash);
    await this.assertSQLiteStampHashPrimaryKey();
  }

  private assertPassportCacheStateColumns(columns: Map<string, unknown>): void {
    this.assertKnownColumns("PassportCacheState", columns, PASSPORT_CACHE_STATE_COLUMN_NAMES);
    this.assertColumns("PassportCacheState", columns, PASSPORT_CACHE_STATE_COLUMNS);
  }

  private assertKnownColumns(
    table: PassportTable,
    columns: Map<string, unknown>,
    expectedNames: readonly string[],
  ): void {
    const expected = new Set(expectedNames);
    for(const name of columns.keys()) {
      if(!expected.has(name))
        throw new Error(`Passport schema table ${table} contains unexpected column ${name}.`);
    }
  }

  private assertColumns(
    table: PassportTable,
    columns: Map<string, unknown>,
    specs: readonly PassportColumnSpec[],
  ): void {
    for(const spec of specs) {
      const row = columns.get(spec.name);
      if(!row)
        throw new Error(`Passport schema table ${table} is missing required column ${spec.name}.`);
      this.assertCompatibleColumn(table, spec, row);
    }
  }

  private assertPresentColumns(
    table: PassportTable,
    columns: Map<string, unknown>,
    specs: readonly PassportColumnSpec[],
  ): void {
    for(const spec of specs) {
      const row = columns.get(spec.name);
      if(row)
        this.assertCompatibleColumn(table, spec, row);
    }
  }

  private assertCompatibleColumn(table: PassportTable, spec: PassportColumnSpec, row: unknown): void {
    if(!this.isCompatibleColumn(spec, row))
      throw new Error(`Passport schema column ${table}.${spec.name} has an incompatible definition.`);
  }

  private isCompatibleColumn(spec: PassportColumnSpec, row: unknown): boolean {
    if(faucetConfig.database.driver === FaucetDbDriver.SQLITE) {
      const dataType = getRecordField(row, "type");
      const notNull = getRecordField(row, "notnull");
      const defaultValue = getRecordField(row, "dflt_value");
      const primaryKey = getRecordField(row, "pk");
      return typeof dataType === "string"
        && dataType.toUpperCase() === spec.sqliteType
        && notNull === spec.sqliteNotNull
        && defaultValue === spec.sqliteDefault
        && primaryKey === (spec.primaryKey ? 1 : 0);
    }

    const dataType = getRecordField(row, "DataType");
    const columnType = getRecordField(row, "ColumnType");
    const nullable = getRecordField(row, "Nullable");
    const maxLength = getRecordField(row, "MaxLength");
    const defaultValue = getRecordField(row, "DefaultValue");
    const columnKey = getRecordField(row, "ColumnKey");
    const extra = getRecordField(row, "Extra");
    const unsigned = typeof columnType === "string" && /\bunsigned\b/i.test(columnType);
    return dataType === spec.mysqlType
      && nullable === spec.mysqlNullable
      && (maxLength === null ? null : Number(maxLength)) === spec.mysqlMaxLength
      && defaultValue === spec.mysqlDefault
      && (columnKey === "PRI") === spec.primaryKey
      && extra === ""
      && unsigned === spec.mysqlUnsigned;
  }

  private async assertSQLiteStampHashPrimaryKey(): Promise<void> {
    if(faucetConfig.database.driver !== FaucetDbDriver.SQLITE)
      return;
    const indexes = await this.db.all('PRAGMA index_list("PassportStamps")');
    const primaryKeys = indexes.filter((row) => getRecordField(row, "origin") === "pk");
    const primaryKey = primaryKeys[0];
    if(
      primaryKeys.length !== 1
      || getRecordField(primaryKey, "unique") !== 1
      || getRecordField(primaryKey, "partial") !== 0
    ) {
      throw new Error("Passport schema primary key PassportStamps.StampHash has an incompatible definition.");
    }

    const indexName = getRecordField(primaryKey, "name");
    if(typeof indexName !== "string" || indexName.length === 0)
      throw new Error("Passport schema primary key PassportStamps.StampHash has an incompatible definition.");
    const columns = (await this.db.all(`PRAGMA index_xinfo("${indexName}")`))
      .filter((row) => getRecordField(row, "key") === 1);
    if(
      columns.length !== 1
      || getRecordField(columns[0], "seqno") !== 0
      || getRecordField(columns[0], "name") !== "StampHash"
      || getRecordField(columns[0], "desc") !== 0
      || getRecordField(columns[0], "coll") !== "BINARY"
    ) {
      throw new Error("Passport schema primary key PassportStamps.StampHash has an incompatible definition.");
    }
  }

  private async assertExistingTimeIndex(table: PassportTable, indexName: string): Promise<boolean> {
    if(faucetConfig.database.driver === FaucetDbDriver.SQLITE) {
      const indexes = await this.db.all(`PRAGMA index_list("${table}")`);
      const matching = indexes.filter((row) => getRecordField(row, "name") === indexName);
      if(matching.length === 0)
        return false;
      if(
        matching.length !== 1
        || getRecordField(matching[0], "unique") !== 0
        || getRecordField(matching[0], "partial") !== 0
      ) {
        throw new Error(`Passport schema index ${indexName} has an incompatible definition.`);
      }
      const columns = (await this.db.all(`PRAGMA index_xinfo("${indexName}")`))
        .filter((row) => getRecordField(row, "key") === 1);
      if(
        columns.length !== 1
        || getRecordField(columns[0], "seqno") !== 0
        || getRecordField(columns[0], "name") !== "Timeout"
        || getRecordField(columns[0], "desc") !== 0
        || getRecordField(columns[0], "coll") !== "BINARY"
      ) {
        throw new Error(`Passport schema index ${indexName} has an incompatible definition.`);
      }
      return true;
    }

    const indexes = await this.db.all([
      "SELECT NON_UNIQUE AS NonUnique, SEQ_IN_INDEX AS SequenceIndex,",
      "COLUMN_NAME AS ColumnName, COLLATION AS Collation, SUB_PART AS SubPart,",
      "INDEX_TYPE AS IndexType, IS_VISIBLE AS IsVisible",
      "FROM information_schema.statistics",
      "WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?",
      "ORDER BY SEQ_IN_INDEX",
    ].join(" "), [table, indexName]);
    if(indexes.length === 0)
      return false;
    if(
      indexes.length !== 1
      || Number(getRecordField(indexes[0], "NonUnique")) !== 1
      || Number(getRecordField(indexes[0], "SequenceIndex")) !== 1
      || getRecordField(indexes[0], "ColumnName") !== "Timeout"
      || getRecordField(indexes[0], "Collation") !== "A"
      || getRecordField(indexes[0], "SubPart") !== null
      || getRecordField(indexes[0], "IndexType") !== "BTREE"
      || getRecordField(indexes[0], "IsVisible") !== "YES"
    ) {
      throw new Error(`Passport schema index ${indexName} has an incompatible definition.`);
    }
    return true;
  }

  private async ensureTimeIndex(table: PassportTable, indexName: string): Promise<void> {
    if(await this.assertExistingTimeIndex(table, indexName))
      return;
    await this.db.exec(faucetConfig.database.driver === FaucetDbDriver.SQLITE
      ? `CREATE INDEX "${indexName}" ON "${table}" ("Timeout" ASC)`
      : `ALTER TABLE ${table} ADD INDEX ${indexName} (Timeout)`);
    if(!await this.assertExistingTimeIndex(table, indexName))
      throw new Error(`Passport schema migration did not create index ${indexName}.`);
  }

  public override async cleanStore(): Promise<void> {
    const now = this.now();
    const cacheCleanupSql = SQL.driverSql({
      [FaucetDbDriver.SQLITE]: `
        DELETE FROM PassportCache
        WHERE Address IN (
          SELECT Address FROM PassportCache INDEXED BY PassportCacheTimeIdx
          WHERE Timeout < ?
          ORDER BY Timeout ASC
          LIMIT ${PASSPORT_CLEANUP_BATCH_SIZE}
        )`,
      [FaucetDbDriver.MYSQL]: `
        DELETE FROM PassportCache
        WHERE Address IN (
          SELECT Address FROM (
            SELECT Address FROM PassportCache FORCE INDEX (PassportCacheTimeIdx)
            WHERE Timeout < ?
            ORDER BY Timeout ASC
            LIMIT ${PASSPORT_CLEANUP_BATCH_SIZE}
          ) AS ExpiredPassportCache
        )`,
    });
    let deletedCacheRows = 0;
    while(deletedCacheRows < PASSPORT_CLEANUP_RUN_LIMIT) {
      const result = await this.db.run(cacheCleanupSql, [now]);
      if(
        !Number.isSafeInteger(result.changes)
        || result.changes < 0
        || result.changes > PASSPORT_CLEANUP_BATCH_SIZE
      ) {
        throw new Error("Passport cache cleanup returned an invalid affected-row count.");
      }
      deletedCacheRows += result.changes;
      if(result.changes < PASSPORT_CLEANUP_BATCH_SIZE)
        break;
    }

    const stampCleanupSql = SQL.driverSql({
      [FaucetDbDriver.SQLITE]: `
        DELETE FROM PassportStamps
        WHERE StampHash IN (
          SELECT StampHash FROM PassportStamps INDEXED BY PassportStampsTimeIdx
          WHERE Timeout < ?
          ORDER BY Timeout ASC
          LIMIT ${PASSPORT_CLEANUP_BATCH_SIZE}
        )`,
      [FaucetDbDriver.MYSQL]: `
        DELETE FROM PassportStamps
        WHERE StampHash IN (
          SELECT StampHash FROM (
            SELECT StampHash FROM PassportStamps FORCE INDEX (PassportStampsTimeIdx)
            WHERE Timeout < ?
            ORDER BY Timeout ASC
            LIMIT ${PASSPORT_CLEANUP_BATCH_SIZE}
          ) AS ExpiredPassportStamps
        )`,
    });
    let deletedStampRows = 0;
    while(deletedStampRows < PASSPORT_CLEANUP_RUN_LIMIT) {
      const result = await this.db.run(stampCleanupSql, [now]);
      if(
        !Number.isSafeInteger(result.changes)
        || result.changes < 0
        || result.changes > PASSPORT_CLEANUP_BATCH_SIZE
      ) {
        throw new Error("Passport stamp cleanup returned an invalid affected-row count.");
      }
      deletedStampRows += result.changes;
      if(result.changes < PASSPORT_CLEANUP_BATCH_SIZE)
        break;
    }
  }

  public async activateCacheGeneration(
    cacheGeneration: string,
    trustGeneration: string,
    invalidateExisting: boolean,
  ): Promise<string> {
    this.validateCacheGeneration(cacheGeneration, trustGeneration);
    let state = await this.db.get(
      "SELECT CacheGeneration, TrustGeneration FROM PassportCacheState WHERE Id = 1",
    ) as unknown as PassportCacheStateRow | null;
    if(!state || typeof state.CacheGeneration !== "string" || typeof state.TrustGeneration !== "string")
      throw new Error("passport cache generation state is missing");

    if(!invalidateExisting && state.TrustGeneration === trustGeneration) {
      this.validateCacheGeneration(state.CacheGeneration, state.TrustGeneration);
      return state.CacheGeneration;
    }

    let result = await this.db.run(
      `UPDATE PassportCacheState SET CacheGeneration = ?, TrustGeneration = ?
       WHERE Id = 1 AND CacheGeneration = ? AND TrustGeneration = ?`,
      [cacheGeneration, trustGeneration, state.CacheGeneration, state.TrustGeneration],
    );
    if(result.changes !== 1)
      throw new Error("passport cache generation state changed during activation");
    return cacheGeneration;
  }

  public async getPassportInfo(
    address: string,
    cacheGeneration: string,
    trustGeneration: string,
  ): Promise<PassportCacheEntry | null> {
    this.validateCacheGeneration(cacheGeneration, trustGeneration);
    let now = this.now();
    let row = await this.db.get(
      `SELECT Json, Timeout, Outcome, OwnershipExpiry
       FROM PassportCache
       WHERE Address = ? AND Timeout > ? AND CacheGeneration = ? AND TrustGeneration = ?
         AND (OwnershipExpiry IS NULL OR OwnershipExpiry > ?)`,
      [address.toLowerCase(), now, cacheGeneration, trustGeneration, now],
    ) as unknown as PassportCacheRow | null;
    if(!row)
      return null;

    let info = this.parsePassportInfo(row.Json);
    if(!info)
      return null;
    switch(row.Outcome) {
      case "success":
        if(!info.found)
          return null;
        return {
          kind: "success",
          info,
          expiresAt: row.Timeout,
          ownershipExpiry: row.OwnershipExpiry,
        };
      case "empty":
        if(info.found)
          return null;
        return {kind: "empty", info, expiresAt: row.Timeout};
      case "error":
        if(info.found)
          return null;
        return {kind: "error", info, expiresAt: row.Timeout};
      default:
        return null;
    }
  }

  public async setPassportInfo(write: PassportCacheWrite): Promise<boolean> {
    this.validateCacheGeneration(write.cacheGeneration, write.trustGeneration);
    if(!Number.isSafeInteger(write.duration) || write.duration <= 0)
      throw new Error("invalid passport cache duration");
    if(write.outcome === "success" ? !write.info?.found : write.info?.found)
      throw new Error("passport cache outcome does not match passport info");

    let now = this.now();
    let ownershipExpiry = write.outcome === "success" ? write.ownershipExpiry ?? null : null;
    if(ownershipExpiry !== null && (!Number.isSafeInteger(ownershipExpiry) || ownershipExpiry <= now))
      return false;
    let timeout = now + write.duration;
    if(ownershipExpiry !== null)
      timeout = Math.min(timeout, ownershipExpiry);
    let args = [
      write.address.toLowerCase(),
      JSON.stringify(write.info),
      timeout,
      write.outcome,
      write.trustGeneration,
      ownershipExpiry,
      write.cacheGeneration,
      write.cacheGeneration,
      write.trustGeneration,
    ];
    let result = await this.db.run(SQL.driverSql({
      [FaucetDbDriver.SQLITE]: `
        INSERT INTO PassportCache
          (Address, Json, Timeout, Outcome, TrustGeneration, OwnershipExpiry, CacheGeneration)
        SELECT ?, ?, ?, ?, ?, ?, ? FROM PassportCacheState
        WHERE Id = 1 AND CacheGeneration = ? AND TrustGeneration = ?
        ON CONFLICT(Address) DO UPDATE SET
          Json = excluded.Json,
          Timeout = excluded.Timeout,
          Outcome = excluded.Outcome,
          TrustGeneration = excluded.TrustGeneration,
          OwnershipExpiry = excluded.OwnershipExpiry,
          CacheGeneration = excluded.CacheGeneration`,
      [FaucetDbDriver.MYSQL]: `
        INSERT INTO PassportCache
          (Address, Json, Timeout, Outcome, TrustGeneration, OwnershipExpiry, CacheGeneration)
        SELECT ?, ?, ?, ?, ?, ?, ? FROM PassportCacheState
        WHERE Id = 1 AND CacheGeneration = ? AND TrustGeneration = ?
        ON DUPLICATE KEY UPDATE
          Json = VALUES(Json),
          Timeout = VALUES(Timeout),
          Outcome = VALUES(Outcome),
          TrustGeneration = VALUES(TrustGeneration),
          OwnershipExpiry = VALUES(OwnershipExpiry),
          CacheGeneration = VALUES(CacheGeneration)`,
    }), args);
    return result.changes > 0;
  }

  public async getPassportStamps(stampHashes: string[]): Promise<{[hash: string]: string | null}> {
    let claims = await this.getPassportStampClaims(stampHashes);
    let stamps: {[hash: string]: string | null} = {};
    for(let [stampHash, claim] of Object.entries(claims))
      stamps[stampHash] = claim.address;
    return stamps;
  }

  public async claimPassportStamps(
    stampHashes: string[],
    address: string,
    duration?: number,
  ): Promise<{[hash: string]: string | null}> {
    let claims = await this.claimPassportStampsWithExpiry(stampHashes, address, duration);
    let stamps: {[hash: string]: string | null} = {};
    for(let [stampHash, claim] of Object.entries(claims))
      stamps[stampHash] = claim.address;
    return stamps;
  }

  public async claimPassportStampsWithExpiry(
    stampHashes: string[],
    address: string,
    duration?: number,
  ): Promise<{[hash: string]: PassportStampClaim}> {
    let uniqueHashes = this.getUniqueStampHashes(stampHashes);
    if(uniqueHashes.length === 0)
      return {};
    if(!address.match(/^0x[0-9a-fA-F]{40}$/) || address.match(/^0x0{40}$/i))
      throw new Error("invalid passport stamp owner address");
    if(duration !== undefined && (!Number.isSafeInteger(duration) || duration <= 0))
      throw new Error("invalid passport stamp claim duration");

    let normalizedAddress = address.toLowerCase();
    let claimDuration = typeof duration === "number" ? duration : 86400;
    let hashPlaceholders = uniqueHashes.map(() => "?").join(",");

    for(let attempt = 0; attempt < MAX_STAMP_CLAIM_ATTEMPTS; attempt++) {
      let now = this.now();
      let timeout = now + claimDuration;
      await this.db.run(
        `UPDATE PassportStamps SET Address = ?, Timeout = ?
         WHERE StampHash IN (${hashPlaceholders}) AND (Timeout <= ? OR LOWER(Address) = ?)`,
        [normalizedAddress, timeout, ...uniqueHashes, now, normalizedAddress],
      );

      let insertArgs: Array<string | number> = [];
      let insertRows = uniqueHashes.map((stampHash) => {
        insertArgs.push(stampHash, normalizedAddress, timeout);
        return "(?,?,?)";
      }).join(",");
      await this.db.run(SQL.driverSql({
        [FaucetDbDriver.SQLITE]: "INSERT OR IGNORE INTO PassportStamps (StampHash, Address, Timeout) VALUES " + insertRows,
        [FaucetDbDriver.MYSQL]: `INSERT INTO PassportStamps (StampHash, Address, Timeout) VALUES ${insertRows}
          ON DUPLICATE KEY UPDATE StampHash = VALUES(StampHash)`,
      }), insertArgs);

      let claims = await this.getPassportStampClaims(uniqueHashes);
      if(uniqueHashes.every((stampHash) => claims[stampHash].address !== null && claims[stampHash].expiresAt !== null))
        return claims;
    }

    throw new Error("passport stamp ownership could not be established");
  }

  private async getPassportStampClaims(stampHashes: string[]): Promise<{[hash: string]: PassportStampClaim}> {
    let uniqueHashes = this.getUniqueStampHashes(stampHashes);
    if(uniqueHashes.length === 0)
      return {};

    let now = this.now();
    let sql = uniqueHashes.map(
      () => "SELECT ? AS RequestedHash, Address, Timeout FROM PassportStamps WHERE StampHash = ? AND Timeout > ?",
    ).join(" UNION ALL ");
    let args: Array<string | number> = [];
    let claims: {[hash: string]: PassportStampClaim} = {};
    uniqueHashes.forEach((stampHash) => {
      args.push(stampHash, stampHash, now);
      claims[stampHash] = {address: null, expiresAt: null};
    });

    let rows = await this.db.all(sql, args) as {RequestedHash: string, Address: string, Timeout: number}[];
    rows.forEach((row) => {
      claims[row.RequestedHash] = {address: row.Address.toLowerCase(), expiresAt: row.Timeout};
    });
    return claims;
  }

  private getUniqueStampHashes(stampHashes: string[]): string[] {
    if(stampHashes.length > MAX_STAMP_CLAIMS_PER_REQUEST || stampHashes.some(
      (stampHash) => typeof stampHash !== "string" || stampHash.length === 0
        || stampHash.length > MAX_STAMP_HASH_CODE_UNITS
        || Buffer.byteLength(stampHash, "utf8") > MAX_STAMP_HASH_BYTES,
    ))
      throw new Error("invalid passport stamp hash batch");
    return Array.from(new Set(stampHashes));
  }

  private parsePassportInfo(json: string): IPassportInfo | null {
    let value: unknown;
    try {
      value = JSON.parse(json);
    } catch {
      return null;
    }
    if(!this.isRecord(value) || typeof value.found !== "boolean"
      || !Number.isSafeInteger(value.parsed) || !Number.isSafeInteger(value.newest)
    )
      return null;

    let stamps: IPassportStampInfo[] | undefined;
    if(value.stamps !== undefined) {
      if(!Array.isArray(value.stamps) || value.stamps.length > MAX_STAMP_CLAIMS_PER_REQUEST)
        return null;
      stamps = [];
      for(let stamp of value.stamps) {
        if(!this.isRecord(stamp) || typeof stamp.provider !== "string" || !Number.isSafeInteger(stamp.expiration))
          return null;
        if(stamp.duplicate !== undefined && typeof stamp.duplicate !== "string")
          return null;
        stamps.push({
          provider: stamp.provider,
          expiration: stamp.expiration as number,
          ...(typeof stamp.duplicate === "string" ? {duplicate: stamp.duplicate} : {}),
        });
      }
    }
    return {
      found: value.found,
      parsed: value.parsed as number,
      newest: value.newest as number,
      ...(stamps ? {stamps} : {}),
    };
  }

  private validateCacheGeneration(cacheGeneration: string, trustGeneration: string): void {
    if(typeof cacheGeneration !== "string" || !cacheGeneration.match(/^[0-9a-f-]{36}$/i))
      throw new Error("invalid passport cache generation");
    if(typeof trustGeneration !== "string" || !trustGeneration.match(/^[0-9a-f]{64}$/i))
      throw new Error("invalid passport trust generation");
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}
