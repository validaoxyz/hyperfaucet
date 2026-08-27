import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { createDB } from 'mysql-memory-server';
import { bindTestStubs, unbindTestStubs, loadDefaultTestConfig, awaitSleepPromise } from './common.js';
import { ServiceManager } from '../src/common/ServiceManager.js';
import {
  FaucetDatabase,
  FaucetDbDriver,
  SESSION_CLEANUP_BATCH_SIZE,
} from '../src/db/FaucetDatabase.js';
import { ModuleHookAction, ModuleManager } from '../src/modules/ModuleManager.js';
import { faucetConfig } from '../src/config/FaucetConfig.js';
import { FakeProvider } from './stubs/FakeProvider.js';
import { SessionManager } from '../src/session/SessionManager.js';
import { FaucetError } from '../src/common/FaucetError.js';
import { FaucetSession, FaucetSessionStatus } from '../src/session/FaucetSession.js';
import { ClaimTxStatus, EthClaimData } from '../src/eth/EthClaimManager.js';
import { PassportModule } from '../src/modules/passport/PassportModule.js';
import { PassportDB } from '../src/modules/passport/PassportDB.js';
import { FetchUtil } from '../src/utils/FetchUtil.js';
import { DATA as passportTestData } from './modules/PassportModule.data.js';
import { EthWalletManager, FaucetCoinType } from '../src/eth/EthWalletManager.js';
import { IFaucetOutflowConfig } from '../src/modules/faucet-outflow/FaucetOutflowConfig.js';
import { FaucetOutflowModule } from '../src/modules/faucet-outflow/FaucetOutflowModule.js';
import { getNewGuid } from '../src/utils/GuidUtils.js';
import { createConnection, type Connection, type RowDataPacket } from 'mysql2/promise';


describe("Session Management with MySQL DB Driver", () => {
  let globalStubs;
  let fakeProvider;
  let mysqlDb;

  before(async function() {
    this.timeout(120000);
    mysqlDb = await createDB({
      version: "8.4.8",
      downloadBinaryOnce: true,
    });
  });
  after(async function() {
    this.timeout(10000);
    await mysqlDb?.stop();
  });

  beforeEach(async function() {
    this.timeout(10000);

    globalStubs = bindTestStubs();
    fakeProvider = new FakeProvider();
    fakeProvider.injectResponse("net_version", "5");
    loadDefaultTestConfig();
    faucetConfig.database = {
      driver: FaucetDbDriver.MYSQL,
      host: "localhost",
      port: mysqlDb.port,
      username: mysqlDb.username,
      password: "",
      database: mysqlDb.dbName,
    };

    await ServiceManager.GetService(FaucetDatabase).initialize();
    await ServiceManager.GetService(ModuleManager).initialize();
  });
  afterEach(async () => {
    let dbService = ServiceManager.GetService(FaucetDatabase);
    await ServiceManager.DisposeAllServices();
    await dbService.dropAllTables();
    await dbService.closeDatabase();
    await unbindTestStubs(globalStubs);
  });

  async function createPassportDb(): Promise<PassportDB> {
    let module = new PassportModule(ServiceManager.GetService(ModuleManager), "passport");
    return ServiceManager.GetService(FaucetDatabase).createModuleDb(PassportDB, module);
  }

  it("upgrades the Passport schema from v1 to v3 on MySQL", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    await driver.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", ["passport", 1]);
    await driver.exec(`
      CREATE TABLE PassportCache (
        Address CHAR(42) NOT NULL UNIQUE,
        Json TEXT NOT NULL,
        Timeout INT(11) NOT NULL,
        PRIMARY KEY(Address)
      )`);
    await driver.exec(`
      CREATE TABLE PassportStamps (
        StampHash VARCHAR(250) NOT NULL UNIQUE,
        Address CHAR(42) NOT NULL,
        Timeout INT(11) NOT NULL,
        PRIMARY KEY(StampHash)
      )`);
    await driver.run(
      "INSERT INTO PassportCache (Address, Json, Timeout) VALUES (?, ?, ?)",
      ["0x0000000000000000000000000000000000000001", JSON.stringify({found: true}), Math.floor(Date.now() / 1000) + 300],
    );

    await createPassportDb();

    let version = await driver.get("SELECT Version FROM SchemaVersion WHERE Module = ?", ["passport"]) as {Version: number};
    let columns = await driver.all(
      "SELECT COLUMN_NAME AS Name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'PassportCache'",
    ) as {Name: string}[];
    let state = await driver.get("SELECT CacheGeneration, TrustGeneration FROM PassportCacheState WHERE Id = 1") as {
      CacheGeneration: string;
      TrustGeneration: string;
    };
    let oldRows = await driver.get("SELECT COUNT(*) AS Count FROM PassportCache") as {Count: number};
    let stampHashColumn = await driver.get(
      `SELECT DATA_TYPE AS DataType, CHARACTER_SET_NAME AS CharacterSet,
              CHARACTER_MAXIMUM_LENGTH AS MaxLength
       FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'PassportStamps' AND column_name = 'StampHash'`,
    ) as {DataType: string; CharacterSet: string | null; MaxLength: number};

    expect(version.Version).to.equal(3);
    expect(columns.map((column) => column.Name)).to.include.members([
      "Outcome",
      "TrustGeneration",
      "CacheGeneration",
      "OwnershipExpiry",
    ]);
    expect(state).to.deep.equal({CacheGeneration: "", TrustGeneration: ""});
    expect(Number(oldRows.Count)).to.equal(0, "untrusted v1 cache rows survived migration");
    expect(stampHashColumn).to.deep.equal({DataType: "varbinary", CharacterSet: null, MaxLength: 1000});
  });

  it("rejects an incompatible current MySQL Passport schema", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    await createPassportDb();
    await driver.exec("ALTER TABLE PassportCache ADD Poison VARCHAR(8) NOT NULL DEFAULT 'bad'");
    let reloaded = new PassportDB(
      new PassportModule(ServiceManager.GetService(ModuleManager), "passport"),
      database,
    );

    let schemaError = await reloaded.initSchema().then(() => null, (error) => error as Error);

    expect(schemaError?.message).to.equal(
      "Passport schema table PassportCache contains unexpected column Poison.",
    );
    expect((await driver.get(
      "SELECT Version FROM SchemaVersion WHERE Module = ?",
      ["passport"],
    ) as {Version: number}).Version).to.equal(3);
  });

  it("validates a current MySQL Passport schema without scanning stored stamp hashes", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    await createPassportDb();
    let getSpy = sinon.spy(driver, "get");
    let allSpy = sinon.spy(driver, "all");
    let reloaded = new PassportDB(
      new PassportModule(ServiceManager.GetService(ModuleManager), "passport"),
      database,
    );

    await reloaded.initSchema();

    expect(getSpy.getCalls().some(
      (call) => String(call.args[0]).includes("OCTET_LENGTH(StampHash)"),
    )).to.equal(false, "current schema validation scanned every stored stamp hash");
    expect(allSpy.getCalls().some(
      (call) => String(call.args[0]).includes(
        "FROM PassportCacheState ORDER BY Id LIMIT 2",
      ),
    )).to.equal(true, "state validation did not bound corrupt-row materialization");
  });

  it("rejects a version 1 MySQL Passport schema missing its ownership ledger", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    await driver.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", ["passport", 1]);
    await driver.exec(`
      CREATE TABLE PassportCache (
        Address CHAR(42) NOT NULL UNIQUE,
        Json TEXT NOT NULL,
        Timeout INT(11) NOT NULL,
        PRIMARY KEY(Address)
      )
    `);
    let passportDb = new PassportDB(
      new PassportModule(ServiceManager.GetService(ModuleManager), "passport"),
      database,
    );

    let schemaError = await passportDb.initSchema().then(() => null, (error) => error as Error);

    expect(schemaError?.message).to.equal(
      "Passport schema version 1 is missing required table PassportStamps.",
    );
    expect(Number((await driver.get([
      "SELECT COUNT(*) AS Count FROM information_schema.tables",
      "WHERE table_schema = DATABASE() AND table_name = 'PassportStamps'",
    ].join(" ")) as {Count: number}).Count)).to.equal(0);
  });

  it("rejects an invisible MySQL Passport cleanup index", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    await createPassportDb();
    await driver.exec("ALTER TABLE PassportCache ALTER INDEX PassportCacheTimeIdx INVISIBLE");
    let reloaded = new PassportDB(
      new PassportModule(ServiceManager.GetService(ModuleManager), "passport"),
      database,
    );

    let schemaError = await reloaded.initSchema().then(() => null, (error) => error as Error);

    expect(schemaError?.message).to.equal(
      "Passport schema index PassportCacheTimeIdx has an incompatible definition.",
    );
  });

  it("loops MySQL Passport cleanup batches through a tie-heavy backlog", async function() {
    this.timeout(20000);
    let passportDb = await createPassportDb();
    let driver = ServiceManager.GetService(FaucetDatabase).getDatabase();
    sinon.stub(passportDb as any, "now").returns(1000);
    let cachePlaceholders: string[] = [];
    let cacheValues: Array<string | number> = [];
    let stampPlaceholders: string[] = [];
    let stampValues: Array<string | number> = [];
    for(let index = 0; index < 1001; index++) {
      let address = "0x" + index.toString(16).padStart(40, "0");
      cachePlaceholders.push("(?, '{}', 999)");
      cacheValues.push(address);
      stampPlaceholders.push("(?, ?, 999)");
      stampValues.push(`cleanup-${String(index).padStart(4, "0")}`, address);
    }
    await driver.run(
      "INSERT INTO PassportCache (Address, Json, Timeout) VALUES " + cachePlaceholders.join(","),
      cacheValues,
    );
    await driver.run(
      "INSERT INTO PassportStamps (StampHash, Address, Timeout) VALUES " + stampPlaceholders.join(","),
      stampValues,
    );

    await passportDb.cleanStore();

    expect(Number((await driver.get("SELECT COUNT(*) AS Count FROM PassportCache") as {Count: number}).Count))
      .to.equal(0);
    expect(Number((await driver.get("SELECT COUNT(*) AS Count FROM PassportStamps") as {Count: number}).Count))
      .to.equal(0);
  });

  it("resumes MySQL Passport migrations after every committed schema and state mutation", async function() {
    this.timeout(30000);
    let databaseService = ServiceManager.GetService(FaucetDatabase);
    let database = databaseService.getDatabase();
    let fixtures = [0, 1];

    for(let fixtureVersion of fixtures) {
      await database.exec("DROP TABLE IF EXISTS PassportCacheState");
      await database.exec("DROP TABLE IF EXISTS PassportStamps");
      await database.exec("DROP TABLE IF EXISTS PassportCache");
      await database.run("DELETE FROM SchemaVersion WHERE Module = ?", ["passport"]);

      if(fixtureVersion === 1) {
        await database.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", ["passport", 1]);
        await database.exec(`
          CREATE TABLE PassportCache (
            Address CHAR(42) NOT NULL UNIQUE,
            Json TEXT NOT NULL,
            Timeout INT(11) NOT NULL,
            PRIMARY KEY(Address)
          )`);
        await database.exec(`
          CREATE TABLE PassportStamps (
            StampHash VARCHAR(250) NOT NULL UNIQUE,
            Address CHAR(42) NOT NULL,
            Timeout INT(11) NOT NULL,
            PRIMARY KEY(StampHash)
          )`);
        await database.run(
          "INSERT INTO PassportCache (Address, Json, Timeout) VALUES (?, ?, ?)",
          [
            "0x00000000000000000000000000000000000000aa",
            JSON.stringify({found: true, parsed: 1, newest: 1}),
            Math.floor(Date.now() / 1000) + 300,
          ],
        );
        await database.run(
          "INSERT INTO PassportStamps (StampHash, Address, Timeout) VALUES (?, ?, ?)",
          [
            "restart-stamp",
            "0x00000000000000000000000000000000000000bb",
            Math.floor(Date.now() / 1000) + 300,
          ],
        );
      }

      let passportDb = new PassportDB(
        {getModuleName: () => "passport"} as any,
        databaseService,
      );
      let originalExec = database.exec.bind(database);
      let originalRun = database.run.bind(database);
      let interruptedStatements = new Set<string>();
      let shouldInterrupt = (sql: string): boolean => {
        let statement = sql.replace(/\s+/g, " ").trim();
        return statement.startsWith("CREATE TABLE Passport")
          || statement.startsWith("ALTER TABLE PassportCache ADD COLUMN")
          || statement.startsWith("ALTER TABLE PassportCache ADD INDEX")
          || statement.startsWith("ALTER TABLE PassportStamps ADD INDEX")
          || statement.startsWith("ALTER TABLE PassportStamps MODIFY")
          || statement === "DELETE FROM PassportCache"
          || statement.startsWith("INSERT INTO PassportCacheState");
      };
      let execStub = sinon.stub(database, "exec").callsFake(async (sql) => {
        await originalExec(sql);
        let statement = String(sql).replace(/\s+/g, " ").trim();
        if(shouldInterrupt(statement) && !interruptedStatements.has(statement)) {
          interruptedStatements.add(statement);
          throw new Error("injected MySQL Passport migration interruption");
        }
      });
      let runStub = sinon.stub(database, "run").callsFake(async (sql, values) => {
        let result = await originalRun(sql, values);
        let statement = String(sql).replace(/\s+/g, " ").trim();
        if(shouldInterrupt(statement) && !interruptedStatements.has(statement)) {
          interruptedStatements.add(statement);
          throw new Error("injected MySQL Passport migration interruption");
        }
        return result;
      });

      let completed = false;
      try {
        for(let attempt = 0; attempt < 20 && !completed; attempt++) {
          try {
            await passportDb.initSchema();
            completed = true;
          } catch(error) {
            expect(String(error)).to.include("injected MySQL Passport migration interruption");
            let version = await database.get(
              "SELECT Version FROM SchemaVersion WHERE Module = ?",
              ["passport"],
            ) as Record<string, unknown>;
            expect(version.Version).to.equal(fixtureVersion);
          }
        }
      } finally {
        execStub.restore();
        runStub.restore();
      }

      expect(completed, `v${fixtureVersion}`).to.equal(true);
      expect((await database.get(
        "SELECT Version FROM SchemaVersion WHERE Module = ?",
        ["passport"],
      ) as Record<string, unknown>).Version).to.equal(3);
      expect((await database.all([
        "SELECT COLUMN_NAME AS Name FROM information_schema.columns",
        "WHERE table_schema = DATABASE() AND table_name = 'PassportCache'",
      ].join(" "))).map((column) => column.Name)).to.include.members([
        "Outcome",
        "TrustGeneration",
        "CacheGeneration",
        "OwnershipExpiry",
      ]);
      expect(await database.get(
        "SELECT CacheGeneration, TrustGeneration FROM PassportCacheState WHERE Id = 1",
      )).to.deep.equal({CacheGeneration: "", TrustGeneration: ""});
      if(fixtureVersion === 1) {
        expect(Array.from(interruptedStatements).some(
          (statement) => statement.includes("ADD COLUMN Outcome"),
        )).to.equal(true, "partial column migration was not exercised");
        expect(Array.from(interruptedStatements).some(
          (statement) => statement.startsWith("CREATE TABLE PassportCacheState"),
        )).to.equal(true, "partial state-table migration was not exercised");
        expect(Array.from(interruptedStatements).some(
          (statement) => statement.startsWith("INSERT INTO PassportCacheState"),
        )).to.equal(true, "partial state-row migration was not exercised");
        expect(await database.get("SELECT Address FROM PassportCache")).to.equal(null);
        expect(await database.get(
          "SELECT Address FROM PassportStamps WHERE StampHash = ?",
          ["restart-stamp"],
        )).to.deep.equal({Address: "0x00000000000000000000000000000000000000bb"});
      }
    }
  });

  it("rejects an incompatible partial MySQL Passport schema before changing it", async () => {
    let databaseService = ServiceManager.GetService(FaucetDatabase);
    let database = databaseService.getDatabase();
    await database.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", ["passport", 1]);
    await database.exec(`
      CREATE TABLE PassportCache (
        Address CHAR(42) NOT NULL UNIQUE,
        Json TEXT NOT NULL,
        Timeout INT(11) NOT NULL,
        Outcome INT(11) NOT NULL DEFAULT 0,
        PRIMARY KEY(Address)
      )`);
    await database.exec(`
      CREATE TABLE PassportStamps (
        StampHash VARCHAR(250) NOT NULL UNIQUE,
        Address CHAR(42) NOT NULL,
        Timeout INT(11) NOT NULL,
        PRIMARY KEY(StampHash)
      )`);
    await database.run(
      "INSERT INTO PassportCache (Address, Json, Timeout) VALUES (?, ?, ?)",
      [
        "0x00000000000000000000000000000000000000aa",
        JSON.stringify({found: true, parsed: 1, newest: 1}),
        Math.floor(Date.now() / 1000) + 300,
      ],
    );
    let before = await database.all([
      "SELECT COLUMN_NAME AS Name, DATA_TYPE AS DataType, COLUMN_DEFAULT AS DefaultValue",
      "FROM information_schema.columns",
      "WHERE table_schema = DATABASE() AND table_name = 'PassportCache'",
      "ORDER BY ORDINAL_POSITION",
    ].join(" "));
    let passportDb = new PassportDB(
      {getModuleName: () => "passport"} as any,
      databaseService,
    );

    let migrationError = await passportDb.initSchema().then(() => null, (error) => error);

    expect(String(migrationError)).to.include(
      "Passport schema column PassportCache.Outcome has an incompatible definition.",
    );
    expect(await database.all([
      "SELECT COLUMN_NAME AS Name, DATA_TYPE AS DataType, COLUMN_DEFAULT AS DefaultValue",
      "FROM information_schema.columns",
      "WHERE table_schema = DATABASE() AND table_name = 'PassportCache'",
      "ORDER BY ORDINAL_POSITION",
    ].join(" "))).to.deep.equal(before);
    expect(await database.get("SELECT Address FROM PassportCache")).to.deep.equal({
      Address: "0x00000000000000000000000000000000000000aa",
    });
    expect(Number((await database.get([
      "SELECT COUNT(*) AS Count FROM information_schema.tables",
      "WHERE table_schema = DATABASE() AND table_name = 'PassportCacheState'",
    ].join(" ")) as Record<string, unknown>).Count)).to.equal(0);
    expect((await database.get(
      "SELECT Version FROM SchemaVersion WHERE Module = ?",
      ["passport"],
    ) as Record<string, unknown>).Version).to.equal(1);
  });

  it("rejects an unexpected required MySQL Passport column before changing the schema", async () => {
    let databaseService = ServiceManager.GetService(FaucetDatabase);
    let database = databaseService.getDatabase();
    await database.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", ["passport", 1]);
    await database.exec(`
      CREATE TABLE PassportCache (
        Address CHAR(42) NOT NULL UNIQUE,
        Json TEXT NOT NULL,
        Timeout INT(11) NOT NULL,
        Poison VARCHAR(20) NOT NULL,
        PRIMARY KEY(Address)
      )`);
    await database.exec(`
      CREATE TABLE PassportStamps (
        StampHash VARCHAR(250) NOT NULL UNIQUE,
        Address CHAR(42) NOT NULL,
        Timeout INT(11) NOT NULL,
        PRIMARY KEY(StampHash)
      )`);
    await database.run(
      "INSERT INTO PassportCache (Address, Json, Timeout, Poison) VALUES (?, ?, ?, ?)",
      [
        "0x00000000000000000000000000000000000000aa",
        JSON.stringify({found: true, parsed: 1, newest: 1}),
        Math.floor(Date.now() / 1000) + 300,
        "required",
      ],
    );
    let before = await database.all([
      "SELECT COLUMN_NAME AS Name, DATA_TYPE AS DataType, IS_NULLABLE AS Nullable",
      "FROM information_schema.columns",
      "WHERE table_schema = DATABASE() AND table_name = 'PassportCache'",
      "ORDER BY ORDINAL_POSITION",
    ].join(" "));
    let passportDb = new PassportDB(
      {getModuleName: () => "passport"} as any,
      databaseService,
    );

    let migrationError = await passportDb.initSchema().then(() => null, (error) => error);

    expect(String(migrationError)).to.include(
      "Passport schema table PassportCache contains unexpected column Poison.",
    );
    expect(await database.all([
      "SELECT COLUMN_NAME AS Name, DATA_TYPE AS DataType, IS_NULLABLE AS Nullable",
      "FROM information_schema.columns",
      "WHERE table_schema = DATABASE() AND table_name = 'PassportCache'",
      "ORDER BY ORDINAL_POSITION",
    ].join(" "))).to.deep.equal(before);
    expect(await database.get("SELECT Address, Poison FROM PassportCache")).to.deep.equal({
      Address: "0x00000000000000000000000000000000000000aa",
      Poison: "required",
    });
    expect(Number((await database.get([
      "SELECT COUNT(*) AS Count FROM information_schema.tables",
      "WHERE table_schema = DATABASE() AND table_name = 'PassportCacheState'",
    ].join(" ")) as Record<string, unknown>).Count)).to.equal(0);
    expect((await database.get(
      "SELECT Version FROM SchemaVersion WHERE Module = ?",
      ["passport"],
    ) as Record<string, unknown>).Version).to.equal(1);
  });

  it("migrates v2 MySQL stamp hashes to bytewise identity without losing existing claims", async () => {
    let passportDb = await createPassportDb();
    let driver = ServiceManager.GetService(FaucetDatabase).getDatabase();
    let upperHash = "CaseSensitiveStamp";
    let lowerHash = "casesensitivestamp";
    let legacyMultibyteHash = "😀".repeat(250);
    let addressA = "0x00000000000000000000000000000000000000aa";
    let addressB = "0x00000000000000000000000000000000000000bb";
    let legacyAddress = "0x00000000000000000000000000000000000000cc";
    await passportDb.claimPassportStamps([upperHash], addressA, 300);
    await driver.exec("ALTER TABLE PassportStamps MODIFY StampHash VARCHAR(250) NOT NULL");
    let aliasedBeforeMigration = await passportDb.getPassportStamps([lowerHash]);
    await driver.run(
      "INSERT INTO PassportStamps (StampHash, Address, Timeout) VALUES (?, ?, ?)",
      [legacyMultibyteHash, legacyAddress, Math.floor(Date.now() / 1000) + 300],
    );
    let legacyBeforeMigration = await driver.get(
      "SELECT HEX(StampHash) AS StampHashHex, OCTET_LENGTH(StampHash) AS ByteLength FROM PassportStamps WHERE Address = ?",
      [legacyAddress],
    ) as {StampHashHex: string; ByteLength: number};
    await driver.run("UPDATE SchemaVersion SET Version = 2 WHERE Module = ?", ["passport"]);
    passportDb.dispose();

    let migratedDb = await createPassportDb();
    let version = await driver.get(
      "SELECT Version FROM SchemaVersion WHERE Module = ?",
      ["passport"],
    ) as {Version: number};
    let stampHashColumn = await driver.get(
      `SELECT DATA_TYPE AS DataType, CHARACTER_SET_NAME AS CharacterSet,
              CHARACTER_MAXIMUM_LENGTH AS MaxLength
       FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'PassportStamps' AND column_name = 'StampHash'`,
    ) as {DataType: string; CharacterSet: string | null; MaxLength: number};
    let legacyAfterMigration = await driver.get(
      "SELECT HEX(StampHash) AS StampHashHex, OCTET_LENGTH(StampHash) AS ByteLength FROM PassportStamps WHERE Address = ?",
      [legacyAddress],
    ) as {StampHashHex: string; ByteLength: number};
    let beforeSecondClaim = await migratedDb.getPassportStamps([upperHash, lowerHash]);
    await migratedDb.claimPassportStamps([lowerHash], addressB, 300);
    let afterSecondClaim = await migratedDb.getPassportStamps([upperHash, lowerHash]);

    expect(version.Version).to.equal(3);
    expect(stampHashColumn).to.deep.equal({DataType: "varbinary", CharacterSet: null, MaxLength: 1000});
    expect(legacyBeforeMigration.ByteLength).to.equal(1000);
    expect(legacyBeforeMigration.StampHashHex).to.equal(Buffer.from(legacyMultibyteHash, "utf8").toString("hex").toUpperCase());
    expect(legacyAfterMigration).to.deep.equal(legacyBeforeMigration, "migration changed a full-width legacy stamp identity");
    expect(aliasedBeforeMigration[lowerHash]).to.equal(addressA, "v2 fixture did not reproduce case-folded identity");
    expect(beforeSecondClaim).to.deep.equal({
      [upperHash]: addressA,
      [lowerHash]: null,
    });
    expect(afterSecondClaim).to.deep.equal({
      [upperHash]: addressA,
      [lowerHash]: addressB,
    });
  });

  it("preserves full-width multibyte Passport stamp identities on MySQL", async () => {
    let passportDb = await createPassportDb();
    let driver = ServiceManager.GetService(FaucetDatabase).getDatabase();
    let multibyteHash = "€".repeat(250);
    let sharedPrefix = "é".repeat(125);
    let longHashA = sharedPrefix + "A";
    let longHashB = sharedPrefix + "B";
    let addressA = "0x00000000000000000000000000000000000000aa";
    let addressB = "0x00000000000000000000000000000000000000bb";
    let addressC = "0x00000000000000000000000000000000000000cc";

    expect(multibyteHash.length).to.equal(250);
    expect(Buffer.byteLength(multibyteHash, "utf8")).to.equal(750);
    expect(Buffer.byteLength(sharedPrefix, "utf8")).to.equal(250);
    await passportDb.claimPassportStamps([multibyteHash], addressA, 300);
    await passportDb.claimPassportStamps([longHashA], addressB, 300);
    await passportDb.claimPassportStamps([longHashB], addressC, 300);

    let claims = await passportDb.getPassportStamps([multibyteHash, longHashA, longHashB]);
    let storedWidths = await driver.all(
      "SELECT Address, OCTET_LENGTH(StampHash) AS ByteLength FROM PassportStamps ORDER BY Address",
    ) as {Address: string; ByteLength: number}[];

    expect(claims).to.deep.equal({
      [multibyteHash]: addressA,
      [longHashA]: addressB,
      [longHashB]: addressC,
    });
    expect(storedWidths).to.deep.equal([
      {Address: addressA, ByteLength: 750},
      {Address: addressB, ByteLength: 251},
      {Address: addressC, ByteLength: 251},
    ]);
  });

  it("fails a v2 Passport migration before truncating an identity above 1000 bytes", async () => {
    let passportDb = await createPassportDb();
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    let oversizedHash = new Uint8Array(1001).fill(0x61);
    let address = "0x00000000000000000000000000000000000000aa";
    await driver.exec("ALTER TABLE PassportStamps MODIFY StampHash VARBINARY(1001) NOT NULL");
    await driver.run(
      "INSERT INTO PassportStamps (StampHash, Address, Timeout) VALUES (?, ?, ?)",
      [oversizedHash, address, Math.floor(Date.now() / 1000) + 300],
    );
    await driver.run("UPDATE SchemaVersion SET Version = 2 WHERE Module = ?", ["passport"]);
    passportDb.dispose();

    let migrationDb = new PassportDB(
      new PassportModule(ServiceManager.GetService(ModuleManager), "passport"),
      database,
    );
    let migrationError = await migrationDb.initSchema().then(() => null, (error) => error as Error);
    let version = await driver.get(
      "SELECT Version FROM SchemaVersion WHERE Module = ?",
      ["passport"],
    ) as {Version: number};
    let stored = await driver.get(
      "SELECT OCTET_LENGTH(StampHash) AS ByteLength FROM PassportStamps WHERE Address = ?",
      [address],
    ) as {ByteLength: number};

    expect(migrationError).to.be.instanceOf(Error);
    expect(migrationError?.message).to.equal("PassportStamps contains a StampHash exceeding the 1000-byte identity limit");
    expect(version.Version).to.equal(2, "failed migration advanced the schema version");
    expect(stored.ByteLength).to.equal(1001, "failed migration truncated the legacy identity");
  });

  it("rejects stale Passport cache upserts after a MySQL generation change", async () => {
    let passportDb = await createPassportDb();
    let oldGeneration = "11111111-1111-4111-8111-111111111111";
    let currentGeneration = "22222222-2222-4222-8222-222222222222";
    let trustGeneration = "ab".repeat(32);
    let address = "0x0000000000000000000000000000000000000001";
    await passportDb.activateCacheGeneration(oldGeneration, trustGeneration, false);
    expect(await passportDb.setPassportInfo({
      address,
      outcome: "empty",
      info: {found: false, parsed: 1, newest: 0},
      duration: 300,
      cacheGeneration: oldGeneration,
      trustGeneration,
    })).to.equal(true);

    await passportDb.activateCacheGeneration(currentGeneration, trustGeneration, true);
    let [staleWrite, currentWrite] = await Promise.all([
      passportDb.setPassportInfo({
        address,
        outcome: "empty",
        info: {found: false, parsed: 2, newest: 0},
        duration: 300,
        cacheGeneration: oldGeneration,
        trustGeneration,
      }),
      passportDb.setPassportInfo({
        address,
        outcome: "empty",
        info: {found: false, parsed: 3, newest: 0},
        duration: 300,
        cacheGeneration: currentGeneration,
        trustGeneration,
      }),
    ]);
    let current = await passportDb.getPassportInfo(address, currentGeneration, trustGeneration);

    expect(staleWrite).to.equal(false, "stale generation write was accepted");
    expect(currentWrite).to.equal(true, "current generation write was rejected");
    expect(current?.info.parsed).to.equal(3, "stale generation overwrote current cache data");
  });

  it("keeps stale MySQL cache rows inert across same-trust reuse and failed activation restart", async () => {
    let passportDb = await createPassportDb();
    let driver = ServiceManager.GetService(FaucetDatabase).getDatabase();
    let activeGeneration = "11111111-1111-4111-8111-111111111111";
    let staleGeneration = "22222222-2222-4222-8222-222222222222";
    let invalidatedGeneration = "33333333-3333-4333-8333-333333333333";
    let restartedGeneration = "44444444-4444-4444-8444-444444444444";
    let trustGeneration = "ab".repeat(32);
    let restartedTrustGeneration = "cd".repeat(32);
    let activeAddress = "0x0000000000000000000000000000000000000001";
    let staleAddress = "0x0000000000000000000000000000000000000002";
    let timeout = Math.floor(Date.now() / 1000) + 300;
    await passportDb.activateCacheGeneration(activeGeneration, trustGeneration, false);
    expect(await passportDb.setPassportInfo({
      address: activeAddress,
      outcome: "empty",
      info: {found: false, parsed: 1, newest: 0},
      duration: 300,
      cacheGeneration: activeGeneration,
      trustGeneration,
    })).to.equal(true);
    await driver.run(
      `INSERT INTO PassportCache
       (Address, Json, Timeout, Outcome, TrustGeneration, OwnershipExpiry, CacheGeneration)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        staleAddress,
        JSON.stringify({found: false, parsed: 2, newest: 0}),
        timeout,
        "empty",
        trustGeneration,
        null,
        staleGeneration,
      ],
    );

    let reusedGeneration = await passportDb.activateCacheGeneration(
      invalidatedGeneration,
      trustGeneration,
      false,
    );
    let rowsAfterReuse = await driver.all(
      "SELECT Address, CacheGeneration, TrustGeneration FROM PassportCache ORDER BY Address",
    );
    let activeAfterReuse = await passportDb.getPassportInfo(activeAddress, activeGeneration, trustGeneration);

    let publishedGeneration = await passportDb.activateCacheGeneration(
      invalidatedGeneration,
      trustGeneration,
      true,
    );
    let rowsAfterInvalidation = await driver.all(
      "SELECT Address, CacheGeneration, TrustGeneration FROM PassportCache ORDER BY Address",
    );
    let activeUnderInvalidatedGeneration = await passportDb.getPassportInfo(
      activeAddress,
      invalidatedGeneration,
      trustGeneration,
    );

    let run = driver.run.bind(driver);
    let activationFailure = new Error("test MySQL activation failure");
    let failActivation = sinon.stub(driver, "run").callsFake(async (sql, args) => {
      if(sql.includes("UPDATE PassportCacheState"))
        throw activationFailure;
      return run(sql, args);
    });
    let failedActivation = await passportDb.activateCacheGeneration(
      restartedGeneration,
      restartedTrustGeneration,
      true,
    ).then(() => null, (error) => error as Error);
    failActivation.restore();
    let stateAfterFailure = await driver.get(
      "SELECT CacheGeneration, TrustGeneration FROM PassportCacheState WHERE Id = 1",
    );
    let rowsAfterFailure = await driver.all(
      "SELECT Address, CacheGeneration, TrustGeneration FROM PassportCache ORDER BY Address",
    );

    let restartedPassportDb = new PassportDB(
      new PassportModule(ServiceManager.GetService(ModuleManager), "passport"),
      ServiceManager.GetService(FaucetDatabase),
    );
    await restartedPassportDb.initSchema();
    let restarted = await restartedPassportDb.activateCacheGeneration(
      restartedGeneration,
      restartedTrustGeneration,
      true,
    );
    let stateAfterRestart = await driver.get(
      "SELECT CacheGeneration, TrustGeneration FROM PassportCacheState WHERE Id = 1",
    );
    let rowsAfterRestart = await driver.all(
      "SELECT Address, CacheGeneration, TrustGeneration FROM PassportCache ORDER BY Address",
    );

    expect(reusedGeneration).to.equal(activeGeneration, "same-trust activation replaced the active generation");
    expect(activeAfterReuse?.info.parsed).to.equal(1, "same-trust activation lost the active cache row");
    expect(rowsAfterReuse).to.deep.equal([
      {Address: activeAddress, CacheGeneration: activeGeneration, TrustGeneration: trustGeneration},
      {Address: staleAddress, CacheGeneration: staleGeneration, TrustGeneration: trustGeneration},
    ]);
    expect(publishedGeneration).to.equal(invalidatedGeneration);
    expect(rowsAfterInvalidation).to.deep.equal(rowsAfterReuse, "explicit invalidation rewrote MySQL cache rows");
    expect(activeUnderInvalidatedGeneration).to.equal(null, "old active row remained readable after invalidation");
    expect(failedActivation).to.equal(activationFailure);
    expect(stateAfterFailure).to.deep.equal({
      CacheGeneration: invalidatedGeneration,
      TrustGeneration: trustGeneration,
    });
    expect(rowsAfterFailure).to.deep.equal(rowsAfterReuse, "failed activation changed MySQL cache rows");
    expect(restarted).to.equal(restartedGeneration);
    expect(stateAfterRestart).to.deep.equal({
      CacheGeneration: restartedGeneration,
      TrustGeneration: restartedTrustGeneration,
    });
    expect(rowsAfterRestart).to.deep.equal(rowsAfterReuse, "restart activation revived or rewrote a stale MySQL row");
  });

  it("drains a READ COMMITTED Passport cache writer before MySQL generation rotation", async function() {
    this.timeout(15000);
    let database = ServiceManager.GetService(FaucetDatabase);
    let gateConnection: Connection | undefined;
    let passportModule: PassportModule | undefined;
    let oldLookup: Promise<Error | null> | undefined;
    let rotation: Promise<void> | undefined;
    let restoreActivation: (() => void) | undefined;
    let gateHeld = false;
    let triggerCreated = false;
    let gateLock = "passport-cache-write-" + getNewGuid();
    let arrivalLock = "passport-cache-arrival-" + getNewGuid();
    let triggerName = "PassportCacheOldWriteGate";

    try {
      gateConnection = await createConnection({
        host: "localhost",
        port: mysqlDb.port,
        user: mysqlDb.username,
        password: "",
        database: mysqlDb.dbName,
      });
      await gateConnection.query("SET GLOBAL TRANSACTION ISOLATION LEVEL READ COMMITTED");
      database.dispose();
      await database.closeDatabase();
      await database.initialize();

      let driver = database.getDatabase();
      let isolation = await driver.get("SELECT @@transaction_isolation AS IsolationLevel") as {IsolationLevel: string};
      expect(isolation.IsolationLevel).to.equal("READ-COMMITTED");

      passportModule = new PassportModule(ServiceManager.GetService(ModuleManager), "passport");
      await passportModule.setModuleConfig({
        enabled: true,
        scorerApiKey: "test-api-key",
      } as any);
      await passportModule.enableModule();
      let passportDb = passportModule.getPassportDb();
      let resolver = passportModule.getPassportResolver() as any;
      let oldCacheGeneration = resolver.cacheGeneration as string;
      let oldTrustGeneration = resolver.trustGeneration as string;
      let address = "0x332e43696a505ef45b9319973785f837ce5267b9";

      let [gateRows] = await gateConnection.query<RowDataPacket[]>(
        "SELECT GET_LOCK(?, 1) AS Acquired",
        [gateLock],
      );
      gateHeld = Number(gateRows[0].Acquired) === 1;
      expect(gateHeld).to.equal(true, "could not acquire the Passport cache write gate");
      await driver.exec(`
        CREATE TRIGGER ${triggerName} BEFORE INSERT ON PassportCache
        FOR EACH ROW
        BEGIN
          IF NEW.Address = '${address}' AND NEW.CacheGeneration = '${oldCacheGeneration}' THEN
            SET @passportCacheArrival = GET_LOCK('${arrivalLock}', 0);
            SET @passportCacheGate = GET_LOCK('${gateLock}', 5);
            IF @passportCacheGate <> 1 THEN
              SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Passport cache write gate timed out';
            END IF;
            DO RELEASE_LOCK('${gateLock}');
            DO RELEASE_LOCK('${arrivalLock}');
          END IF;
        END`);
      triggerCreated = true;

      sinon.stub(FetchUtil, "fetch").resolves({
        status: 200,
        json: () => Promise.resolve(JSON.parse(JSON.stringify((passportTestData as any).testPassport1Rsp))),
      } as any);
      let activateCacheGeneration = passportDb.activateCacheGeneration.bind(passportDb);
      let activationFinished = false;
      let activateGeneration = sinon.stub(passportDb, "activateCacheGeneration").callsFake(async (
        cacheGeneration,
        trustGeneration,
        clearExisting,
      ) => {
        let publishedGeneration = await activateCacheGeneration(cacheGeneration, trustGeneration, clearExisting);
        activationFinished = true;
        return publishedGeneration;
      });
      restoreActivation = () => activateGeneration.restore();

      oldLookup = passportModule.getPassportResolver().getPassport(address, true)
        .then(() => null, (error) => error as Error);
      let triggerEntered = false;
      for(let attempt = 0; attempt < 200; attempt++) {
        let arrival = await driver.get("SELECT IS_USED_LOCK(?) AS Owner", [arrivalLock]) as {Owner: number | null};
        if(arrival.Owner !== null) {
          triggerEntered = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(triggerEntered).to.equal(true, "old cache write did not reach the server-side gate");

      let rotationCompleted = false;
      rotation = passportModule.getPassportResolver().reload().then(() => {
        rotationCompleted = true;
      });
      let activationStartedBeforeRelease = activateGeneration.callCount > 0;
      if(activationStartedBeforeRelease)
        await awaitSleepPromise(2000, () => activationFinished);
      let activationCompletedBeforeRelease = activationFinished;
      let rotationCompletedBeforeRelease = rotationCompleted;

      await gateConnection.query("SELECT RELEASE_LOCK(?)", [gateLock]);
      gateHeld = false;
      let oldLookupError = await oldLookup;
      await rotation;
      let staleAfterRotation = await driver.get(
        "SELECT COUNT(*) AS Count FROM PassportCache WHERE CacheGeneration = ?",
        [oldCacheGeneration],
      ) as {Count: number};
      await new Promise<void>((resolve) => setImmediate(resolve));
      let staleAfterDrain = await driver.get(
        "SELECT COUNT(*) AS Count FROM PassportCache WHERE CacheGeneration = ?",
        [oldCacheGeneration],
      ) as {Count: number};
      let state = await driver.get(
        "SELECT CacheGeneration, TrustGeneration FROM PassportCacheState WHERE Id = 1",
      ) as {CacheGeneration: string; TrustGeneration: string};
      let currentEntry = await passportDb.getPassportInfo(address, state.CacheGeneration, state.TrustGeneration);
      await driver.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
      triggerCreated = false;
      let remainingGates = await driver.get(
        "SELECT IS_USED_LOCK(?) AS GateOwner, IS_USED_LOCK(?) AS ArrivalOwner",
        [gateLock, arrivalLock],
      ) as {GateOwner: number | null; ArrivalOwner: number | null};

      expect(activationStartedBeforeRelease).to.equal(false, "MySQL cache activation raced an old writer");
      expect(activationCompletedBeforeRelease).to.equal(false, "MySQL cache rotation completed before the old writer drained");
      expect(rotationCompletedBeforeRelease).to.equal(false, "resolver rotation completed before the old writer drained");
      expect(oldLookupError?.name).to.equal("PassportLookupInvalidatedError");
      expect(Number(staleAfterRotation.Count)).to.equal(1, "rotation deleted the drained old-generation row");
      expect(Number(staleAfterDrain.Count)).to.equal(1, "old-generation row was remapped after rotation");
      expect(currentEntry).to.equal(null, "drained old-generation row revived under the current state");
      expect(state.CacheGeneration).to.not.equal(oldCacheGeneration);
      expect(state.TrustGeneration).to.equal(oldTrustGeneration);
      expect(remainingGates).to.deep.equal({GateOwner: null, ArrivalOwner: null});
    } finally {
      if(gateConnection && gateHeld) {
        await gateConnection.query("SELECT RELEASE_LOCK(?)", [gateLock]).catch(() => undefined);
        gateHeld = false;
      }
      await Promise.allSettled([
        oldLookup || Promise.resolve(null),
        rotation || Promise.resolve(),
      ]);
      restoreActivation?.();
      if(triggerCreated) {
        await database.getDatabase().exec(`DROP TRIGGER IF EXISTS ${triggerName}`).catch(() => undefined);
        triggerCreated = false;
      }
      if(passportModule)
        await passportModule.disableModule().catch(() => undefined);
      if(gateConnection) {
        await gateConnection.query("SET GLOBAL TRANSACTION ISOLATION LEVEL REPEATABLE READ").catch(() => undefined);
        await gateConnection.end();
      }
    }
  });

  it("gives one claimant an expired Passport stamp on MySQL", async () => {
    let passportDb = await createPassportDb();
    let driver = ServiceManager.GetService(FaucetDatabase).getDatabase();
    let stampHash = "expired-stamp";
    let oldOwner = "0x0000000000000000000000000000000000000001";
    let claimantA = "0x0000000000000000000000000000000000000002";
    let claimantB = "0x0000000000000000000000000000000000000003";
    await driver.run(
      "INSERT INTO PassportStamps (StampHash, Address, Timeout) VALUES (?, ?, ?)",
      [stampHash, oldOwner, Math.floor(Date.now() / 1000) - 1],
    );

    let claims = await Promise.all([
      passportDb.claimPassportStampsWithExpiry([stampHash], claimantA, 300),
      passportDb.claimPassportStampsWithExpiry([stampHash], claimantB, 300),
    ]);
    let owners = claims.map((claim) => claim[stampHash].address);
    let stored = await driver.get(
      "SELECT Address, Timeout FROM PassportStamps WHERE StampHash = ?",
      [stampHash],
    ) as {Address: string, Timeout: number};

    expect(owners.filter((owner, index) => owner === [claimantA, claimantB][index])).to.have.length(1);
    expect([claimantA, claimantB]).to.include(stored.Address.toLowerCase());
    expect(stored.Timeout).to.be.greaterThan(Math.floor(Date.now() / 1000));
  });

  it("reclaims a Passport stamp when MySQL cleanup runs between claim steps", async () => {
    let passportDb = await createPassportDb();
    let driver = ServiceManager.GetService(FaucetDatabase).getDatabase();
    let dbNow = 1000;
    sinon.stub(passportDb as any, "now").callsFake(() => dbNow);
    let stampHash = "mysql-cleanup-race-stamp";
    let oldOwner = "0x0000000000000000000000000000000000000001";
    let claimant = "0x0000000000000000000000000000000000000002";
    await driver.run(
      "INSERT INTO PassportStamps (StampHash, Address, Timeout) VALUES (?, ?, ?)",
      [stampHash, oldOwner, dbNow - 1],
    );
    let run = driver.run.bind(driver);
    let cleanupRan = false;
    sinon.stub(driver, "run").callsFake(async (sql, args) => {
      if(!cleanupRan && sql.includes("UPDATE PassportStamps SET Address")) {
        cleanupRan = true;
        await passportDb.cleanStore();
      }
      return run(sql, args);
    });

    let claims = await passportDb.claimPassportStampsWithExpiry([stampHash], claimant, 60);

    expect(cleanupRan).to.equal(true, "MySQL cleanup interleaving was not exercised");
    expect(claims[stampHash].address).to.equal(claimant);
    expect(claims[stampHash].expiresAt).to.equal(dbNow + 60);
  });

  it("rejects positive Passport credit when ownership expires before a MySQL cache write", async () => {
    let passportModule = new PassportModule(ServiceManager.GetService(ModuleManager), "passport");
    await passportModule.setModuleConfig({
      enabled: true,
      scorerApiKey: "test-api-key",
      stampDeduplicationTime: 1,
    } as any);
    await passportModule.enableModule();
    try {
      let passportDb = passportModule.getPassportDb();
      let dbNow = 1000;
      sinon.stub(passportDb as any, "now").callsFake(() => dbNow);
      let claimStamps = passportDb.claimPassportStampsWithExpiry.bind(passportDb);
      sinon.stub(passportDb, "claimPassportStampsWithExpiry").callsFake(async (stampHashes, address, duration) => {
        let claims = await claimStamps(stampHashes, address, duration);
        dbNow++;
        return claims;
      });
      sinon.stub(FetchUtil, "fetch").resolves({
        status: 200,
        json: () => Promise.resolve(JSON.parse(JSON.stringify((passportTestData as any).testPassport1Rsp))),
      } as any);

      let address = "0x332E43696A505EF45b9319973785F837ce5267b9";
      let lookupError = await passportModule.getPassportResolver().getPassport(address)
        .then(() => null, (error) => error as Error);
      let cacheRow = await ServiceManager.GetService(FaucetDatabase).getDatabase().get(
        "SELECT Address FROM PassportCache WHERE Address = ?",
        [address.toLowerCase()],
      );

      expect(lookupError).to.be.instanceOf(Error, "expired MySQL ownership returned positive lookup credit");
      expect(cacheRow).to.equal(null, "expired MySQL ownership was written to the positive cache");
    } finally {
      await passportModule.disableModule();
    }
  });

  it("sums claimable decimal strings exactly", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    expect(await database.getClaimableAmount()).to.equal(0n, "empty claimable total was not zero");

    let amounts = [
      "9007199254740993",
      "9223372036854775808",
      "340282366920938463463374607431768211455",
      "99999999999999999999999999999999999999999999999999",
    ];
    for(let idx = 0; idx < amounts.length; idx++) {
      await database.updateSession({
        sessionId: "00000000-0000-0000-0000-00000000000" + (idx + 1),
        status: FaucetSessionStatus.CLAIMABLE,
        startTime: 1,
        targetAddr: "0x0000000000000000000000000000000000001337",
        dropAmount: amounts[idx],
        remoteIP: "8.8.8.8",
        tasks: [],
        data: {},
        claim: null,
      });
    }
    await database.updateSession({
      sessionId: "00000000-0000-0000-0000-000000000005",
      status: FaucetSessionStatus.FAILED,
      startTime: 1,
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "99999999999999999999999999999999999999",
      remoteIP: "8.8.8.8",
      tasks: [],
      data: {},
      claim: null,
    });

    let driver = database.getDatabase();
    let originalAll = driver.all.bind(driver);
    let aggregateRows = -1;
    let allStub = sinon.stub(driver, "all").callsFake(async (sql, values) => {
      let rows = await originalAll(sql, values);
      if(String(sql).includes("Validation(InvalidAmount, OversizedAmount)"))
        aggregateRows = rows.length;
      return rows;
    });
    let expected = amounts.reduce((total, amount) => total + BigInt(amount), 0n);
    expect(await database.getClaimableAmount()).to.equal(expected, "claimable total lost integer precision");
    expect(aggregateRows).to.equal(Math.max(...amounts.map((amount) => amount.length)));
    expect(allStub.getCalls().some(
      (call) => String(call.args[0]).trim() === "SELECT DropAmount FROM Sessions WHERE Status = 'claimable'",
    )).to.equal(false, "claimable total materialized every stored amount");

    await driver.run(
      "UPDATE Sessions SET DropAmount = ? WHERE SessionId = ?",
      ["12e3", "00000000-0000-0000-0000-000000000001"],
    );
    let aggregateError = await database.getClaimableAmount().then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(aggregateError).to.be.instanceOf(Error);
    expect(aggregateError?.message).to.equal(
      "Claimable DropAmount must be a non-empty decimal string.",
    );

    await driver.run(
      "UPDATE Sessions SET DropAmount = ? WHERE SessionId = ?",
      ["1", "00000000-0000-0000-0000-000000000001"],
    );
    await driver.exec("ALTER TABLE Sessions MODIFY DropAmount VARCHAR(51) NOT NULL");
    await driver.run(
      "UPDATE Sessions SET DropAmount = ? WHERE SessionId = ?",
      ["9".repeat(51), "00000000-0000-0000-0000-000000000001"],
    );
    let oversizedError = await database.getClaimableAmount().then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(oversizedError?.message).to.equal(
      "Claimable DropAmount exceeds the 50-digit storage limit.",
    );
  });

  it("uses bounded MySQL keyset pages for session cleanup", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    faucetConfig.sessionCleanup = 10;
    let startTime = Math.floor(Date.now() / 1000) - 60;
    let candidateCount = SESSION_CLEANUP_BATCH_SIZE + 1;
    let placeholders: string[] = [];
    let values: (string | number | null)[] = [];
    for(let index = 0; index < candidateCount; index++) {
      placeholders.push("(?, 'failed', ?, ?, '1', '8.8.8.8', '[]', '{}', NULL)");
      values.push(
        `10000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
        startTime,
        "0x0000000000000000000000000000000000001337",
      );
    }
    await driver.run([
      "INSERT INTO Sessions",
      "(SessionId, Status, StartTime, TargetAddr, DropAmount, RemoteIP, Tasks, Data, ClaimData)",
      "VALUES",
      placeholders.join(", "),
    ].join(" "), values);

    let seenSessionIds = new Set<string>();
    let unregister = database.registerSessionCleanupGuard("voucher.reservation", (candidate) => {
      seenSessionIds.add(candidate.sessionId);
      return false;
    });
    let originalAll = driver.all.bind(driver);
    let batchSizes: number[] = [];
    let allStub = sinon.stub(driver, "all").callsFake(async (sql, queryValues) => {
      let rows = await originalAll(sql, queryValues);
      if(String(sql).includes("FROM Sessions FORCE INDEX (SessionsCleanupIdx)"))
        batchSizes.push(rows.length);
      return rows;
    });

    try {
      await database.cleanStore();
      expect(seenSessionIds.size).to.equal(candidateCount);
      expect(batchSizes).to.deep.equal([SESSION_CLEANUP_BATCH_SIZE, 1]);
      let indexColumns = await driver.all([
        "SELECT COLUMN_NAME AS ColumnName FROM information_schema.statistics",
        "WHERE table_schema = DATABASE() AND table_name = 'Sessions'",
        "AND index_name = 'SessionsCleanupIdx' ORDER BY SEQ_IN_INDEX",
      ].join(" ")) as {ColumnName: string}[];
      expect(indexColumns.map((column) => column.ColumnName)).to.deep.equal(["StartTime", "SessionId"]);
    } finally {
      allStub.restore();
      unregister();
    }
  });

  it("resumes the MySQL cleanup-index migration after its DDL commits", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    await driver.run("UPDATE SchemaVersion SET Version = 1 WHERE Module IS NULL");
    let execSpy = sinon.spy(driver, "exec");

    await (database as any).upgradeSchema();

    expect((await driver.get(
      "SELECT Version FROM SchemaVersion WHERE Module IS NULL",
    ) as {Version: number}).Version).to.equal(2);
    expect(execSpy.getCalls().some(
      (call) => String(call.args[0]).includes("ADD INDEX SessionsCleanupIdx"),
    )).to.equal(false, "restart attempted to recreate the committed cleanup index");
  });

  it("repairs a missing MySQL cleanup index at schema version 2", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    await driver.exec("ALTER TABLE Sessions DROP INDEX SessionsCleanupIdx");

    await (database as any).upgradeSchema();

    let columns = await driver.all([
      "SELECT NON_UNIQUE AS NonUnique, SEQ_IN_INDEX AS SequenceIndex,",
      "COLUMN_NAME AS ColumnName, COLLATION AS Collation, SUB_PART AS SubPart,",
      "INDEX_TYPE AS IndexType, IS_VISIBLE AS IsVisible FROM information_schema.statistics",
      "WHERE table_schema = DATABASE() AND table_name = 'Sessions'",
      "AND index_name = 'SessionsCleanupIdx' ORDER BY SEQ_IN_INDEX",
    ].join(" "));
    expect(columns).to.deep.equal([
      {
        NonUnique: 1,
        SequenceIndex: 1,
        ColumnName: "StartTime",
        Collation: "A",
        SubPart: null,
        IndexType: "BTREE",
        IsVisible: "YES",
      },
      {
        NonUnique: 1,
        SequenceIndex: 2,
        ColumnName: "SessionId",
        Collation: "A",
        SubPart: null,
        IndexType: "BTREE",
        IsVisible: "YES",
      },
    ]);
  });

  it("repairs an incompatible MySQL cleanup index at schema version 2", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    await driver.exec("ALTER TABLE Sessions DROP INDEX SessionsCleanupIdx");
    await driver.exec("ALTER TABLE Sessions ADD INDEX SessionsCleanupIdx (SessionId DESC, StartTime ASC)");

    await (database as any).upgradeSchema();

    let columns = await driver.all([
      "SELECT COLUMN_NAME AS ColumnName, COLLATION AS Collation, IS_VISIBLE AS IsVisible",
      "FROM information_schema.statistics",
      "WHERE table_schema = DATABASE() AND table_name = 'Sessions'",
      "AND index_name = 'SessionsCleanupIdx' ORDER BY SEQ_IN_INDEX",
    ].join(" "));
    expect(columns).to.deep.equal([
      {ColumnName: "StartTime", Collation: "A", IsVisible: "YES"},
      {ColumnName: "SessionId", Collation: "A", IsVisible: "YES"},
    ]);
  });

  it("repairs an invisible MySQL cleanup index at schema version 2", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    await driver.exec("ALTER TABLE Sessions ALTER INDEX SessionsCleanupIdx INVISIBLE");

    await (database as any).upgradeSchema();

    let visibility = await driver.get([
      "SELECT DISTINCT IS_VISIBLE AS IsVisible FROM information_schema.statistics",
      "WHERE table_schema = DATABASE() AND table_name = 'Sessions'",
      "AND index_name = 'SessionsCleanupIdx'",
    ].join(" ")) as {IsVisible: string};
    expect(visibility.IsVisible).to.equal("YES");
  });

  it("rejects future MySQL core and module schema versions", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    await driver.run("UPDATE SchemaVersion SET Version = 3 WHERE Module IS NULL");

    let coreError = await (database as any).upgradeSchema()
      .then(() => null, (error) => error as Error);
    expect(coreError?.message).to.equal(
      "FaucetStore has an unsupported schema version; expected a safe integer from 0 through 2.",
    );

    await driver.run("UPDATE SchemaVersion SET Version = 2 WHERE Module IS NULL");
    await driver.run(
      "INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)",
      ["future-module", 4],
    );
    let upgrade = sinon.stub().resolves(3);
    let moduleError = await database.upgradeIfNeeded("future-module", 3, upgrade)
      .then(() => null, (error) => error as Error);

    expect(moduleError?.message).to.equal(
      "Module future-module has an unsupported schema version; expected a safe integer from 0 through 3.",
    );
    expect(upgrade.called).to.equal(false);
  });

  it("rejects duplicate MySQL core and module schema versions", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    await driver.run(
      "INSERT INTO SchemaVersion (Module, Version) VALUES (NULL, ?)",
      [3],
    );

    let coreError = await (database as any).upgradeSchema()
      .then(() => null, (error) => error as Error);
    expect(coreError?.message).to.equal("FaucetStore has duplicate schema version rows.");

    await driver.run("DELETE FROM SchemaVersion WHERE Module IS NULL AND Version = 3");
    await driver.run(
      "INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?), (?, ?)",
      ["duplicate-module", 1, "duplicate-module", 4],
    );
    let upgrade = sinon.stub().resolves(3);
    let moduleError = await database.upgradeIfNeeded("duplicate-module", 3, upgrade)
      .then(() => null, (error) => error as Error);

    expect(moduleError?.message).to.equal(
      "Module duplicate-module has duplicate schema version rows.",
    );
    expect(upgrade.called).to.equal(false);
    expect(Number((await driver.get(
      "SELECT COUNT(*) AS Count FROM SchemaVersion WHERE Module = ?",
      ["duplicate-module"],
    ) as {Count: number}).Count)).to.equal(2);
  });

  it("uses exact compare-and-set claim transitions", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let sessionId = "00000000-0000-0000-0000-000000000010";
    await database.updateSession({
      sessionId,
      status: FaucetSessionStatus.CLAIMABLE,
      startTime: 1,
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "100",
      remoteIP: "8.8.8.8",
      tasks: [],
      data: {},
      claim: null,
    });
    let queued: EthClaimData = {
      claimFormat: 2,
      claimIdx: 1,
      claimStatus: ClaimTxStatus.QUEUE,
      claimTime: 1,
    };
    expect(await database.tryCreateClaim(sessionId, "100", queued)).to.equal(true, "claim admission failed");
    expect(await database.tryCreateClaim(sessionId, "100", queued)).to.equal(false, "claim admission was not exclusive");

    let caseChangedExpected = {
      ...queued,
      claimStatus: "QUEUE",
    } as any;
    let failed: EthClaimData = {
      claimFormat: 2,
      claimIdx: 1,
      claimStatus: ClaimTxStatus.FAILED,
      claimTime: 1,
      txError: "test failure",
    };
    expect(await database.compareAndSetClaim(sessionId, caseChangedExpected, failed)).to.equal(false, "claim CAS used case-insensitive text equality");

    let prepared: EthClaimData = {
      claimFormat: 2,
      claimIdx: 1,
      claimStatus: ClaimTxStatus.PREPARED,
      claimTime: 1,
      txHash: "0x" + "ab".repeat(32),
      txHex: "0xab",
      txNonce: 7,
    };
    let transitions = await Promise.all([
      database.compareAndSetClaim(sessionId, queued, prepared),
      database.compareAndSetClaim(sessionId, queued, failed),
    ]);
    expect(transitions.filter(Boolean).length).to.equal(1, "claim CAS had multiple winners");
  });

  it("serializes MySQL key-value accounting updates", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    await database.setKeyValueEntry("accounting-state", "v1");
    let results = await Promise.all([
      database.compareAndSetKeyValueEntry("accounting-state", "v1", "v2-a"),
      database.compareAndSetKeyValueEntry("accounting-state", "v1", "v2-b"),
    ]);

    expect(results.filter(Boolean)).to.have.length(1);
    expect(await database.getKeyValueEntry("accounting-state")).to.equal(results[0] ? "v2-a" : "v2-b");
  });

  it("atomically arbitrates claim admission and timeout", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let session = {
      sessionId: "00000000-0000-0000-0000-000000000011",
      status: FaucetSessionStatus.CLAIMABLE,
      startTime: Math.floor(Date.now() / 1000) - 60,
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "100",
      remoteIP: "8.8.8.8",
      tasks: [],
      data: { marker: "original" },
      claim: null,
    };
    await database.updateSession(session);
    let queuedClaim: EthClaimData = {
      claimFormat: 2,
      claimIdx: 1,
      claimStatus: ClaimTxStatus.QUEUE,
      claimTime: session.startTime,
    };

    let [claimWon, timeoutWon] = await Promise.all([
      database.tryCreateClaim(session.sessionId, session.dropAmount, queuedClaim),
      database.tryTimeoutSession(session, 10),
    ]);
    expect(Number(claimWon) + Number(timeoutWon)).to.equal(1, "claim admission and timeout did not have exactly one winner");

    let storedSession = await database.getSession(session.sessionId);
    if(claimWon) {
      expect(storedSession.status).to.equal(FaucetSessionStatus.CLAIMING, "claim winner did not own the session");
      expect(storedSession.claim).to.deep.equal(queuedClaim, "claim winner lost its durable claim state");
      expect(storedSession.data).to.deep.equal(session.data, "losing timeout changed session data");
    } else {
      expect(storedSession.status).to.equal(FaucetSessionStatus.FAILED, "timeout winner did not fail the session");
      expect(storedSession.claim).to.equal(null, "timeout winner created claim state");
      expect(storedSession.data).to.deep.equal({
        marker: "original",
        "failed.code": "SESSION_TIMEOUT",
        "failed.reason": "Session timed out",
      });
    }

    let staleSession = {
      ...session,
      sessionId: "00000000-0000-0000-0000-000000000012",
      status: FaucetSessionStatus.RUNNING,
      data: { marker: "stale" },
    };
    await database.updateSession(staleSession);
    let currentSession = {
      ...staleSession,
      data: { marker: "current" },
    };
    await database.updateSession(currentSession);
    expect(await database.tryTimeoutSession(staleSession, 10)).to.equal(false, "timeout overwrote concurrently updated session data");
    expect((await database.getSession(staleSession.sessionId)).data).to.deep.equal(currentSession.data, "losing timeout changed current session data");
  });

  it("protects MySQL claim ownership from generic saves and cleanup", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    faucetConfig.sessionCleanup = 10;
    let oldStartTime = Math.floor(Date.now() / 1000) - 60;
    let staleSession = {
      sessionId: "00000000-0000-0000-0000-000000000013",
      status: FaucetSessionStatus.CLAIMABLE,
      startTime: oldStartTime,
      targetAddr: "0xAbCd000000000000000000000000000000001337",
      dropAmount: "100",
      remoteIP: "8.8.8.8",
      tasks: [],
      data: {},
      claim: null,
    };
    await database.updateSession(staleSession);
    let queuedClaim: EthClaimData = {
      claimFormat: 2,
      claimIdx: 1,
      claimStatus: ClaimTxStatus.QUEUE,
      claimTime: oldStartTime,
    };
    expect(await database.tryCreateClaim(staleSession.sessionId, staleSession.dropAmount, queuedClaim)).to.equal(true);

    staleSession.data = {marker: "stale generic save"};
    expect(await database.updateSession(staleSession)).to.equal(false);
    await database.cleanStore();

    let storedSession = await database.getSession(staleSession.sessionId);
    expect(storedSession.status).to.equal(FaucetSessionStatus.CLAIMING);
    expect(storedSession.claim).to.deep.equal(queuedClaim);
    let history = await database.getFinishedSessions(
      "0xabcd000000000000000000000000000000001337",
      null,
      120,
    );
    expect(history.map((item) => item.sessionId)).to.include(staleSession.sessionId);
  });

  it("keeps a confirmed MySQL claim staged until accounting finalizes", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let pending: EthClaimData = {
      claimFormat: 2,
      claimIdx: 1,
      claimStatus: ClaimTxStatus.PENDING,
      claimTime: Math.floor(Date.now() / 1000),
      txHash: "0x" + "ab".repeat(32),
      txHex: "0xab",
      txNonce: 7,
    };
    let session = {
      sessionId: "00000000-0000-0000-0000-000000000014",
      status: FaucetSessionStatus.CLAIMING,
      startTime: pending.claimTime,
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "100",
      remoteIP: "8.8.8.8",
      tasks: [],
      data: {},
      claim: pending,
    };
    await database.updateSession(session);
    let confirmed: EthClaimData = {
      ...pending,
      claimStatus: ClaimTxStatus.CONFIRMED,
      txBlock: 42,
      txFee: "100",
    };

    expect(await database.compareAndSetClaim(session.sessionId, pending, confirmed)).to.equal(true);
    expect((await database.getSession(session.sessionId)).status).to.equal(FaucetSessionStatus.CLAIMING);
    expect(await database.finalizeConfirmedClaim(session.sessionId, confirmed)).to.equal(true);
    expect((await database.getSession(session.sessionId)).status).to.equal(FaucetSessionStatus.FINISHED);
  });

  it("reconciles MySQL session inserts and terminal transitions after lost acknowledgements", async () => {
    let moduleManager = ServiceManager.GetService(ModuleManager);
    moduleManager.addActionHook(null, ModuleHookAction.SessionStart, 100, "keep-running", (session: FaucetSession) => {
      session.addBlockingTask("test", "hold", 60);
    });
    let completionHookCalls = 0;
    moduleManager.addActionHook(null, ModuleHookAction.SessionComplete, 100, "completion-count", () => {
      completionHookCalls++;
    });
    let database = ServiceManager.GetService(FaucetDatabase);
    let originalInsert = database.insertRunningSession.bind(database);
    let insertAcknowledgementLost = false;
    sinon.stub(database, "insertRunningSession").callsFake(async (sessionData) => {
      await originalInsert(sessionData);
      if(!insertAcknowledgementLost) {
        insertAcknowledgementLost = true;
        throw new Error("insert acknowledgement lost");
      }
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let session = await sessionManager.createSession("8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });

    expect(insertAcknowledgementLost).to.equal(true);
    expect((await database.getSession(session.getSessionId())).status).to.equal(FaucetSessionStatus.RUNNING);

    let originalTransition = database.transitionSession.bind(database);
    let terminalAcknowledgementLost = false;
    sinon.stub(database, "transitionSession").callsFake(async (sessionData, expectedStatus) => {
      let transitioned = await originalTransition(sessionData, expectedStatus);
      if(!terminalAcknowledgementLost && transitioned) {
        terminalAcknowledgementLost = true;
        throw new Error("terminal acknowledgement lost");
      }
      return transitioned;
    });
    await session.setSessionFailed("TEST", "test failure");

    expect(terminalAcknowledgementLost).to.equal(true);
    expect(completionHookCalls).to.equal(1);
    expect((await database.getSession(session.getSessionId())).status).to.equal(FaucetSessionStatus.FAILED);
  });

  it("retires MySQL native fee markers safely across cleanup, restart, and the marker bound", async () => {
    faucetConfig.sessionCleanup = 10;
    faucetConfig.ethMaxPending = 1;
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 1,
      duration: 1000000,
      lowerLimit: -100000,
      upperLimit: 100000,
    } as IFaucetOutflowConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.dispose();
    sinon.stub(EthWalletManager.prototype, "getClaimCoinType").returns(FaucetCoinType.NATIVE);
    await moduleManager.initialize();
    let database = ServiceManager.GetService(FaucetDatabase);
    let outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
    let outflowState = (outflowModule as any).outflowState;
    outflowState.balanceNumerator = 1000n;
    outflowState.balanceDenominator = 1n;
    outflowState.updateTime = Math.floor(Date.now() / 1000);
    await outflowModule.saveOutflowState();

    for(let [index, txByte] of ["d1", "d2", "d3"].entries()) {
      let sessionId = getNewGuid();
      let claim: EthClaimData = {
        claimFormat: 2,
        claimIdx: Number.parseInt(txByte, 16),
        claimStatus: ClaimTxStatus.CONFIRMED,
        claimTime: Math.floor(Date.now() / 1000),
        txHash: "0x" + txByte.repeat(32),
        txHex: "0x" + txByte,
        txNonce: Number.parseInt(txByte, 16),
        txBlock: 42,
        txFee: "25",
      };
      await database.updateSession({
        sessionId,
        status: FaucetSessionStatus.CLAIMING,
        startTime: Math.floor(Date.now() / 1000) - 60,
        targetAddr: "0x0000000000000000000000000000000000001337",
        dropAmount: "100",
        remoteIP: "8.8.8.8",
        tasks: [],
        data: {},
        claim,
      });
      let claimInfo = {
        session: sessionId,
        target: "0x0000000000000000000000000000000000001337",
        amount: "100",
        claim,
      };

      await moduleManager.processActionHooks([], ModuleHookAction.SessionClaimed, [claimInfo]);
      expect(await database.finalizeConfirmedClaim(sessionId, claim)).to.equal(true);
      await database.cleanStore();
      expect(await database.getSession(sessionId)).to.not.equal(null, "cleanup removed a marker-owned MySQL finalization proof");

      if(index === 0) {
        let skipGracefulSave = sinon.stub(outflowModule, "saveOutflowState").resolves();
        await moduleManager.dispose();
        skipGracefulSave.restore();
        await moduleManager.initialize();
        outflowModule = moduleManager.getModule<FaucetOutflowModule>("faucet-outflow");
      } else {
        await outflowModule.saveOutflowState();
      }
      await database.cleanStore();
      expect(await database.getSession(sessionId)).to.equal(null);
      let persistedState = JSON.parse(await database.getKeyValueEntry("PoWOutflowLimiter.state"));
      expect(persistedState.accountedClaimFees).to.deep.equal({});
    }
  });

  it("retains MySQL native fee-marker proof while faucet-outflow is disabled at cold start", async () => {
    faucetConfig.sessionCleanup = 10;
    faucetConfig.ethMaxPending = 1;
    let database = ServiceManager.GetService(FaucetDatabase);
    let sessionId = getNewGuid();
    let claim: EthClaimData = {
      claimFormat: 2,
      claimIdx: 0xdf,
      claimStatus: ClaimTxStatus.CONFIRMED,
      claimTime: Math.floor(Date.now() / 1000),
      txHash: "0x" + "df".repeat(32),
      txHex: "0xdf",
      txNonce: 0xdf,
      txBlock: 42,
      txFee: "25",
    };
    await database.updateSession({
      sessionId,
      status: FaucetSessionStatus.CLAIMING,
      startTime: claim.claimTime - 60,
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "100",
      remoteIP: "8.8.8.8",
      tasks: [],
      data: {},
      claim,
    });
    await database.setKeyValueEntry("PoWOutflowLimiter.state", JSON.stringify({
      version: 3,
      balanceNumerator: "0",
      balanceDenominator: "1",
      updateTime: claim.claimTime,
      rateAmount: "1",
      rateDuration: 1000000,
      accountedClaimFees: {[claim.txHash]: sessionId},
    }));
    expect(await database.finalizeConfirmedClaim(sessionId, claim)).to.equal(true);

    await database.cleanStore();

    expect(await database.getSession(sessionId)).to.not.equal(null, "disabled MySQL cold start removed fee-marker finalization proof");
    faucetConfig.modules["faucet-outflow"] = {
      enabled: true,
      amount: 1,
      duration: 1000000,
      lowerLimit: -100000,
      upperLimit: 100000,
    } as IFaucetOutflowConfig;
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.dispose();
    await moduleManager.initialize();
    await database.cleanStore();

    expect(await database.getSession(sessionId)).to.equal(null);
    let storedState = JSON.parse(await database.getKeyValueEntry("PoWOutflowLimiter.state"));
    expect(storedState.accountedClaimFees).to.deep.equal({});
  });

  it("Create normal session", async () => {
    let sessionManager = ServiceManager.GetService(SessionManager);
    let now = Math.floor(new Date().getTime() / 1000);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    expect(testSession).to.not.equal(null, "createSession failed");
    expect(testSession.getRemoteIP()).to.equal("8.8.8.8", "unexpected remoteIP");
    expect(testSession.getTargetAddr()).to.equal("0x0000000000000000000000000000000000001337", "unexpected targetAddr");
    expect(Math.abs(testSession.getStartTime() - now)).to.be.lessThan(2, "unexpected startTime");
    expect(testSession.getBlockingTasks().length).to.equal(0, "unexpected blockingTasks");
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(testSession.getDropAmount()).to.equal(BigInt(faucetConfig.maxDropAmount), "unexpected drop amount");
  });

  it("Create invalid session (missing addr)", async () => {
    let sessionManager = ServiceManager.GetService(SessionManager);
    let error: FaucetError | null = null;
    try {
      await sessionManager.createSession("8.8.8.8", { });
    } catch(ex) { error = ex; }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("INVALID_ADDR", "unexpected error code");
  });

  it("Create invalid session (invalid addr)", async () => {
    let sessionManager = ServiceManager.GetService(SessionManager);
    let error: FaucetError | null = null;
    try {
      await sessionManager.createSession("8.8.8.8", { addr: "not_a_eth_address" });
    } catch(ex) { error = ex; }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("INVALID_ADDR", "unexpected error code");
  });

  it("Create session with blocking task", async () => {
    faucetConfig.minDropAmount = 1000;
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let now = Math.floor(new Date().getTime() / 1000);
    let testSession = await sessionManager.createSession("8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    expect(testSession).to.not.equal(null, "createSession failed");
    expect(testSession.getRemoteIP()).to.equal("8.8.8.8", "unexpected remoteIP");
    expect(testSession.getTargetAddr()).to.equal("0x0000000000000000000000000000000000001337", "unexpected targetAddr");
    expect(Math.abs(testSession.getStartTime() - now)).to.be.lessThan(2, "unexpected startTime");
    expect(testSession.getBlockingTasks().length).to.equal(1, "unexpected blockingTasks");
    expect(testSession.getSessionStatus()).to.equal(FaucetSessionStatus.RUNNING, "unexpected session status");
    await testSession.addReward(1337n);
    expect(testSession.getDropAmount()).to.equal(1337n, "unexpected drop amount after addReward()");
    await testSession.subPenalty(10n);
    expect(testSession.getDropAmount()).to.equal(1327n, "unexpected drop amount after subPenalty()");
    let runningSession = sessionManager.getSession(testSession.getSessionId(), [FaucetSessionStatus.RUNNING]);
    expect(runningSession === testSession).to.equal(true, "sessionManager.getSession did not return running session (running state)");
    let runningSession2 = sessionManager.getSession(testSession.getSessionId());
    expect(runningSession2 === testSession).to.equal(true, "sessionManager.getSession did not return running session (stateless)");
    await awaitSleepPromise(4000, () => testSession.getSessionStatus() === FaucetSessionStatus.CLAIMABLE);
    expect(testSession.getSessionStatus()).to.equal(FaucetSessionStatus.CLAIMABLE, "unexpected session status");
    testSession.setDropAmount(42n); // this may not work anymore as the balance is already set
    expect(testSession.getDropAmount()).to.equal(1327n, "unexpected drop amount after setDropAmount()");
  }).timeout(5000);

  it("Create invalid session (amount too low)", async () => {
    faucetConfig.minDropAmount = 1000;
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.setDropAmount(500n);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    expect(testSession).to.not.equal(null, "createSession failed");
    expect(testSession.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED, "unexpected session status");
    expect(testSession.getSessionData("failed.code")).to.equal("AMOUNT_TOO_LOW", "unexpected error code");
  });

  it("Restore valid session", async () => {
    faucetConfig.sessionTimeout = 10;
    faucetConfig.minDropAmount = 1000;
    let now = Math.floor(new Date().getTime() / 1000);
    await ServiceManager.GetService(FaucetDatabase).updateSession({
      sessionId: "4e63566e-e482-46f3-bb91-da11f511aae5",
      status: FaucetSessionStatus.RUNNING,
      startTime: now,
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1337",
      remoteIP: "8.8.8.8",
      tasks: [],
      data: {"test.info": "test1"},
      claim: null,
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    await sessionManager.initialize();
    let testSession = sessionManager.getSession("4e63566e-e482-46f3-bb91-da11f511aae5", [FaucetSessionStatus.RUNNING]);
    expect(testSession).to.not.equal(undefined, "getSession failed");
    await testSession.tryProceedSession();
    expect(testSession.getRemoteIP()).to.equal("8.8.8.8", "unexpected remoteIP");
    expect(testSession.getTargetAddr()).to.equal("0x0000000000000000000000000000000000001337", "unexpected targetAddr");
    expect(Math.abs(testSession.getStartTime() - now)).to.be.lessThan(2, "unexpected startTime");
    expect(testSession.getBlockingTasks().length).to.equal(0, "unexpected blockingTasks");
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(testSession.getDropAmount()).to.equal(1337n, "unexpected drop amount");
    testSession.setSessionModuleRef("test.info", "info1234");
    expect(testSession.getSessionModuleRef("test.info")).to.equal("info1234", "unexpected getSessionModuleRef result");
  });

  it("Restore invalid session (timed out)", async () => {
    faucetConfig.sessionTimeout = 10;
    faucetConfig.minDropAmount = 1000;
    let now = Math.floor(new Date().getTime() / 1000);
    await ServiceManager.GetService(FaucetDatabase).updateSession({
      sessionId: "4e63566e-e482-46f3-bb91-da11f511aae6",
      status: FaucetSessionStatus.RUNNING,
      startTime: now - 60,
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1337",
      remoteIP: "8.8.8.8",
      tasks: [],
      data: {},
      claim: null,
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    await sessionManager.initialize();
    let testSession = sessionManager.getSession("4e63566e-e482-46f3-bb91-da11f511aae6", [FaucetSessionStatus.RUNNING]);
    expect(testSession).to.not.equal(undefined, "getSession failed");
    await testSession.tryProceedSession();
    let sessionData = await sessionManager.getSessionData("4e63566e-e482-46f3-bb91-da11f511aae6");
    expect(sessionData).to.not.equal(null, "getSessionData failed");
    expect(sessionData.status).to.equal(FaucetSessionStatus.FAILED, "unexpected session status");
    expect(sessionData.data["failed.code"]).to.equal("SESSION_TIMEOUT", "unexpected error code");
  });

  it("Check session task handling ", async () => {
    faucetConfig.minDropAmount = 1000;
    let changeAddrCalled = 0;
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test1", 1);
      session.addBlockingTask("test", "test2", 10);
    });
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionIpChange, 100, "test-task", (session: FaucetSession) => {
      changeAddrCalled++;
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    expect(testSession).to.not.equal(null, "createSession failed");
    expect(testSession.getBlockingTasks().length).to.equal(2, "unexpected blockingTasks");
    expect(testSession.getSessionStatus()).to.equal(FaucetSessionStatus.RUNNING, "unexpected session status");
    let error: FaucetError | null = null;
    try {
      testSession.setTargetAddr("0x0000000000000000000000000000000000001338");
    } catch(ex) {
      error = ex;
    }
    expect(error && error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("INVALID_STATE", "unexpected error code");
    await testSession.updateRemoteIP("::ffff:8.8.8.8");
    expect(changeAddrCalled).to.equal(0, "SessionIpChange for non-changed ip");
    await testSession.updateRemoteIP("8.8.4.4");
    expect(changeAddrCalled).to.equal(1, "no SessionIpChange for changed ip");
    expect(testSession.getRemoteIP()).to.equal("8.8.4.4", "unexpected remoteIP");
    testSession.setDropAmount(0n);
    expect(testSession.getDropAmount()).to.equal(0n, "unexpected drop amount");
    await testSession.addReward(1000n);
    testSession.resolveBlockingTask("test", "test1");
    expect(testSession.getBlockingTasks().length).to.equal(1, "unexpected blockingTasks count after resolving first task");
    testSession.resolveBlockingTask("test", "test2");
    expect(testSession.getBlockingTasks().length).to.equal(0, "unexpected blockingTasks count after resolving second task");
    await awaitSleepPromise(4000, () => testSession.getSessionStatus() === FaucetSessionStatus.CLAIMABLE);
    expect(testSession.getSessionStatus()).to.equal(FaucetSessionStatus.CLAIMABLE, "unexpected session status");
  }).timeout(5000);

  it("Check invalid session property changes", async () => {
    faucetConfig.minDropAmount = 1000;
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test1", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    expect(testSession).to.not.equal(null, "createSession failed");
    expect(testSession.getRemoteIP()).to.equal("8.8.8.8", "unexpected remoteIP");
    await testSession.subPenalty(1000n);
    expect(testSession.getDropAmount()).to.equal(0n, "unexpected drop amount after subPenalty from initial balance");
    await testSession.addReward(50n);
    testSession.resolveBlockingTask("test", "test1");
    await testSession.tryProceedSession(); // should fail with 0 balance
    expect(testSession.getSessionStatus()).to.equal(FaucetSessionStatus.FAILED, "unexpected session status");
    await testSession.setDropAmount(1000n);
    expect(testSession.getDropAmount()).to.equal(50n, "unexpected drop amount after setDropAmount on failed session");
    await testSession.addReward(1000n);
    expect(testSession.getDropAmount()).to.equal(50n, "unexpected drop amount after addReward on failed session");
    await testSession.subPenalty(1000n);
    expect(testSession.getDropAmount()).to.equal(50n, "unexpected drop amount after subPenalty on failed session");
    let sessionInfo = await testSession.getSessionInfo();
    expect(sessionInfo.session).to.equal(testSession.getSessionId(), "invalid sessioninfo: id mismatch");
    expect(sessionInfo.balance).to.equal(testSession.getDropAmount().toString(), "invalid sessioninfo: balance mismatch");
    expect(sessionInfo.failedCode).to.equal("AMOUNT_TOO_LOW", "invalid sessioninfo: failedCode mismatch");
  });

  it("Check invalid balance change on failed session", async () => {
    faucetConfig.minDropAmount = 1000;
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test1", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    expect(testSession).to.not.equal(null, "createSession failed");
    expect(testSession.getRemoteIP()).to.equal("8.8.8.8", "unexpected remoteIP");
    await testSession.setSessionFailed("TEST_ERROR", "test");
    testSession.setDropAmount(1000n);
    expect(testSession.getDropAmount()).to.equal(0n, "unexpected drop amount after setDropAmount on failed session");
  });

  it("Check SessionManager: get session data", async () => {
    faucetConfig.minDropAmount = 1000;
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test1", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    expect(testSession).to.not.equal(null, "createSession failed");
    expect(sessionManager.getSession(testSession.getSessionId(), [FaucetSessionStatus.UNKNOWN])).to.equal(null, "unexpected getSession result for non-matching state");
    expect(sessionManager.getSession("4e63566e-e482-46f3-bb91-da11f511aae0", [FaucetSessionStatus.UNKNOWN])).to.equal(undefined, "unexpected getSession result for unknown session");
    expect(await sessionManager.getSessionData(testSession.getSessionId())).to.not.equal(null, "unexpected getSessionData result for known session");
    expect(await sessionManager.getSessionData("4e63566e-e482-46f3-bb91-da11f511aae0")).to.equal(null, "unexpected getSessionData result for unknown session");
    expect(sessionManager.getActiveSessions().length).to.equal(1, "unexpected getActiveSessions result count");
  });

  it("Check SessionManager: getUnclaimedBalance", async () => {
    faucetConfig.minDropAmount = 1000;
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test1", 1);
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    await testSession.addReward(1000n);
    expect(await sessionManager.getUnclaimedBalance()).to.equal(1000n, "unexpected getUnclaimedBalance result");
  });

  it("Check SessionManager: session timeout processing", async () => {
    faucetConfig.sessionTimeout = 10;
    faucetConfig.minDropAmount = 1000;
    let now = Math.floor(new Date().getTime() / 1000);
    await ServiceManager.GetService(FaucetDatabase).updateSession({
      sessionId: "4e63566e-e482-46f3-bb91-da11f511ab01",
      status: FaucetSessionStatus.RUNNING,
      startTime: now - 60,
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1337",
      remoteIP: "8.8.8.8",
      tasks: [],
      data: {},
      claim: null,
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    await sessionManager.initialize();
    await ServiceManager.GetService(FaucetDatabase).updateSession({
      sessionId: "4e63566e-e482-46f3-bb91-da11f511ab02",
      status: FaucetSessionStatus.RUNNING,
      startTime: now - 60,
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1337",
      remoteIP: "8.8.8.8",
      tasks: [],
      data: {},
      claim: null,
    });
    await ServiceManager.GetService(FaucetDatabase).updateSession({
      sessionId: "4e63566e-e482-46f3-bb91-da11f511ab03",
      status: FaucetSessionStatus.CLAIMING,
      startTime: now - 60,
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1337",
      remoteIP: "8.8.8.8",
      tasks: [],
      data: {},
      claim: {
        claimFormat: 2,
        claimIdx: 1,
        claimStatus: ClaimTxStatus.QUEUE,
        claimTime: now - 60,
      },
    });
    await sessionManager.processSessionTimeouts();
    await sessionManager.saveAllSessions();
    let session1 = await sessionManager.getSessionData("4e63566e-e482-46f3-bb91-da11f511ab01");
    expect(session1).to.not.equal(null, "getSessionData failed");
    expect(session1.status).to.equal(FaucetSessionStatus.FAILED, "unexpected session status");
    expect(session1.data["failed.code"]).to.equal("SESSION_TIMEOUT", "unexpected error code");
    let session2 = await sessionManager.getSessionData("4e63566e-e482-46f3-bb91-da11f511ab02");
    expect(session2).to.not.equal(null, "getSessionData failed");
    expect(session2.status).to.equal(FaucetSessionStatus.FAILED, "unexpected session status");
    expect(session2.data["failed.code"]).to.equal("SESSION_TIMEOUT", "unexpected error code");
    let claimingSession = await sessionManager.getSessionData("4e63566e-e482-46f3-bb91-da11f511ab03");
    expect(claimingSession.status).to.equal(FaucetSessionStatus.CLAIMING, "generic timeout changed an active payout");
    expect(claimingSession.claim.claimStatus).to.equal(ClaimTxStatus.QUEUE, "generic timeout rewrote payout state");
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", { addr: "0x0000000000000000000000000000000000001337" });
    await sessionManager.processSessionTimeouts();
    expect(testSession.getSessionStatus()).to.equal(FaucetSessionStatus.CLAIMABLE, "unexpected session status");
  });

  it("preserves a real MySQL deadlock as structured evidence for VoucherDB", async function() {
    this.timeout(20000);
    const {MySQLDriver} = await import("../src/db/driver/MySQLDriver.js");
    const {VoucherDB} = await import("../src/modules/voucher/VoucherDB.js");
    const left = new MySQLDriver();
    const right = new MySQLDriver();
    const options = {
      ...faucetConfig.database,
      driver: FaucetDbDriver.MYSQL,
      poolLimit: 1,
    } as any;
    let leftOpen = false;
    let rightOpen = false;
    let deadlockError: unknown;
    try {
      await left.open(options);
      leftOpen = true;
      await right.open(options);
      rightOpen = true;
      await left.exec(`
        CREATE TABLE VoucherDriverDeadlockProbe (
          Id INT NOT NULL PRIMARY KEY,
          Value INT NOT NULL
        )
      `);
      await left.run(
        "INSERT INTO VoucherDriverDeadlockProbe (Id, Value) VALUES (1, 0), (2, 0)",
      );
      await Promise.all([left.exec("START TRANSACTION"), right.exec("START TRANSACTION")]);
      await Promise.all([
        left.run("UPDATE VoucherDriverDeadlockProbe SET Value = 1 WHERE Id = 1"),
        right.run("UPDATE VoucherDriverDeadlockProbe SET Value = 2 WHERE Id = 2"),
      ]);
      const leftWait = left.run(
        "UPDATE VoucherDriverDeadlockProbe SET Value = 1 WHERE Id = 2",
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      const rightWait = right.run(
        "UPDATE VoucherDriverDeadlockProbe SET Value = 2 WHERE Id = 1",
      );
      const results = await Promise.allSettled([leftWait, rightWait]);
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(failures).to.have.length(1);
      deadlockError = failures[0].reason;
      await Promise.all([left.exec("ROLLBACK"), right.exec("ROLLBACK")]);
    } finally {
      if(leftOpen)
        await left.close();
      if(rightOpen)
        await right.close();
    }

    expect(deadlockError).to.be.instanceOf(Error);
    const structured = deadlockError as Error & {
      readonly code: string | undefined;
      readonly errno: number | undefined;
      readonly sqlState: string | undefined;
    };
    expect(structured.name).to.equal("MySQLDriverError");
    expect(structured.code).to.equal("ER_LOCK_DEADLOCK");
    expect(structured.errno).to.equal(1213);
    expect(structured.sqlState).to.equal("40001");
    expect(structured.cause).to.be.instanceOf(Error);
    expect(String(structured)).to.include(
      "mysql run() error [UPDATE VoucherDriverDeadlockProbe SET Value",
    );
    for(const field of ["code", "errno", "sqlState"])
      expect(Object.getOwnPropertyDescriptor(structured, field)?.writable, field).to.equal(false);

    const persistedAvailableRow = {
      Code: "MYSQLDEAD1",
      DropAmount: "1",
      SessionId: null,
      TargetAddr: null,
      StartTime: null,
      CleanupVoucherCode: null,
      CleanupSessionId: null,
      CleanupStartTime: null,
      CleanupTargetAddr: null,
      CleanupStatus: null,
      CleanupExpectedState: null,
      CleanupDataHash: null,
      CleanupClaimDataHash: null,
    };
    const snapshotDriver = {
      get: async () => persistedAvailableRow,
    } as any;
    let attempts = 0;
    expect(await (VoucherDB as any).runReservationCas(
      snapshotDriver,
      "MYSQLDEAD1",
      "77bfbd3d-c468-488d-a5f3-e88cc2f77187",
      1700000000,
      async () => {
        attempts++;
        if(attempts === 1)
          throw structured;
        return {changes: 1};
      },
    )).to.equal(true);
    expect(attempts).to.equal(2);
  });

  it("resumes v0, v1, and v2 MySQL voucher migrations after every committed DDL", async function() {
    this.timeout(30000);
    const {VoucherDB} = await import("../src/modules/voucher/VoucherDB.js");
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const database = databaseService.getDatabase();
    const fixtures = [
      {
        version: 0,
        expectedInterruptions: 2,
        createSql: null,
      },
      {
        version: 1,
        expectedInterruptions: 9,
        createSql: `
          CREATE TABLE Vouchers (
            Code VARCHAR(50) NOT NULL,
            DropAmount VARCHAR(50) NOT NULL,
            SessionId CHAR(36) NULL,
            TargetAddr CHAR(42) NULL,
            StartTime INT(11) NULL,
            PRIMARY KEY(Code)
          )
        `,
      },
      {
        version: 2,
        expectedInterruptions: 2,
        createSql: `
          CREATE TABLE Vouchers (
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
            PRIMARY KEY(Code)
          )
        `,
      },
    ];

    for(const fixture of fixtures) {
      await database.exec("DROP TABLE IF EXISTS Vouchers");
      await database.run("DELETE FROM SchemaVersion WHERE Module = ?", ["voucher"]);
      if(fixture.version > 0) {
        await database.run(
          "INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)",
          ["voucher", fixture.version],
        );
        await database.exec(fixture.createSql as string);
        await database.run(
          "INSERT INTO Vouchers (Code, DropAmount, SessionId, TargetAddr, StartTime) VALUES (?, ?, NULL, NULL, NULL)",
          [`MYSQLV${fixture.version}`, "1"],
        );
      }

      const voucherDb = new VoucherDB(
        {getModuleName: () => "voucher"} as any,
        databaseService,
      );
      const originalExec = database.exec.bind(database);
      const interruptedStatements = new Set<string>();
      let interruptions = 0;
      const execStub = sinon.stub(database, "exec").callsFake(async (sql) => {
        await originalExec(sql);
        const statement = String(sql).replace(/\s+/g, " ").trim();
        const isVoucherDdl = statement.includes("CREATE TABLE IF NOT EXISTS Vouchers")
          || statement.startsWith("ALTER TABLE Vouchers ADD COLUMN")
          || statement.startsWith("ALTER TABLE Vouchers ADD INDEX");
        if(isVoucherDdl && !interruptedStatements.has(statement)) {
          interruptedStatements.add(statement);
          interruptions++;
          throw new Error(`injected MySQL migration interruption ${interruptions}`);
        }
      });

      let completed = false;
      try {
        for(let attempt = 0; attempt < 12 && !completed; attempt++) {
          try {
            await voucherDb.initSchema();
            completed = true;
          } catch(error) {
            expect(String(error)).to.include("injected MySQL migration interruption");
            const version = await database.get(
              "SELECT Version FROM SchemaVersion WHERE Module = ?",
              ["voucher"],
            ) as Record<string, unknown>;
            expect(version.Version).to.equal(fixture.version);
          }
        }
      } finally {
        execStub.restore();
      }

      expect(completed, `v${fixture.version}`).to.equal(true);
      expect(interruptions, `v${fixture.version}`).to.equal(fixture.expectedInterruptions);
      const version = await database.get(
        "SELECT Version FROM SchemaVersion WHERE Module = ?",
        ["voucher"],
      ) as Record<string, unknown>;
      expect(version.Version).to.equal(3);
      const columns = await database.all([
        "SELECT COLUMN_NAME AS Name FROM information_schema.columns",
        "WHERE table_schema = DATABASE() AND table_name = 'Vouchers'",
      ].join(" "));
      expect(columns.map((column) => column.Name)).to.include.members([
        "CleanupVoucherCode",
        "CleanupSessionId",
        "CleanupStartTime",
        "CleanupTargetAddr",
        "CleanupStatus",
        "CleanupExpectedState",
        "CleanupDataHash",
        "CleanupClaimDataHash",
      ]);
      const indexes = await database.all([
        "SELECT INDEX_NAME AS Name FROM information_schema.statistics",
        "WHERE table_schema = DATABASE() AND table_name = 'Vouchers'",
      ].join(" "));
      expect(indexes.map((index) => index.Name)).to.include("VouchersSessionIdIdx");
      if(fixture.version > 0) {
        expect(await database.get(
          "SELECT Code, DropAmount, SessionId, TargetAddr, StartTime FROM Vouchers",
        )).to.deep.equal({
          Code: `MYSQLV${fixture.version}`,
          DropAmount: "1",
          SessionId: null,
          TargetAddr: null,
          StartTime: null,
        });
      }
    }
  });

  it("uses MySQL indexes for exact voucher and cleanup predicates", async function() {
    this.timeout(20000);
    const {VoucherDB} = await import("../src/modules/voucher/VoucherDB.js");
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const database = databaseService.getDatabase();
    const serverVersion = await database.get("SELECT VERSION() AS Version") as Record<string, unknown>;
    expect(String(serverVersion.Version)).to.match(/^8\.4\./);
    const voucherDb = new VoucherDB(
      {getModuleName: () => "voucher"} as any,
      databaseService,
    );
    await voucherDb.initSchema();

    const code = "MYSQLPRIMARY";
    const sessionId = "0930d6b1-0b02-424d-a8e5-d084ab6c5a65";
    const startTime = Math.floor(Date.now() / 1000) - 60;
    const dataJson = JSON.stringify({voucherCode: code});
    await databaseService.updateSession({
      sessionId,
      status: FaucetSessionStatus.FAILED,
      startTime,
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1",
      remoteIP: "8.8.8.8",
      tasks: [],
      data: {voucherCode: code},
      claim: null,
    });
    const insertValues = [];
    const placeholders = [];
    for(let index = 0; index < 256; index++) {
      const rowCode = index === 137 ? code : `MYSQLPLAN${String(index).padStart(3, "0")}`;
      placeholders.push("(?, ?, ?, NULL, ?)");
      insertValues.push(
        rowCode,
        "1",
        index === 137 ? sessionId : null,
        index === 137 ? startTime : null,
      );
    }
    await database.run([
      "INSERT INTO Vouchers (Code, DropAmount, SessionId, TargetAddr, StartTime) VALUES",
      placeholders.join(", "),
    ].join(" "), insertValues);
    await database.exec("ANALYZE TABLE Vouchers");
    await database.exec("ANALYZE TABLE Sessions");

    const codePlan = await database.all([
      "EXPLAIN FORMAT=TRADITIONAL SELECT Code, DropAmount, SessionId, TargetAddr, StartTime FROM Vouchers",
      "WHERE Code = ? AND BINARY Code = BINARY ?",
    ].join(" "), [code, code]);
    const sessionPlan = await database.all([
      "EXPLAIN FORMAT=TRADITIONAL SELECT Code FROM Vouchers WHERE SessionId = ?",
      "AND BINARY SessionId = BINARY ? LIMIT 2",
    ].join(" "), [sessionId, sessionId]);
    const cleanupPlan = await database.all([
      "EXPLAIN FORMAT=TRADITIONAL SELECT SessionId FROM Sessions WHERE SessionId = ?",
      "AND BINARY SessionId = BINARY ? AND Status = ? AND BINARY Status = BINARY ?",
      "AND StartTime = ? AND TargetAddr = ? AND BINARY TargetAddr = BINARY ?",
      "AND BINARY Data = BINARY ? AND ClaimData IS NULL",
    ].join(" "), [
      sessionId,
      sessionId,
      FaucetSessionStatus.FAILED,
      FaucetSessionStatus.FAILED,
      startTime,
      "0x0000000000000000000000000000000000001337",
      "0x0000000000000000000000000000000000001337",
      dataJson,
    ]);
    const correlatedPlan = await database.all([
      "EXPLAIN FORMAT=TRADITIONAL SELECT Vouchers.Code FROM Vouchers STRAIGHT_JOIN Sessions",
      "ON Sessions.SessionId = Vouchers.SessionId",
      "AND BINARY Sessions.SessionId = BINARY Vouchers.SessionId",
      "WHERE Vouchers.SessionId = ? AND BINARY Vouchers.SessionId = BINARY ?",
    ].join(" "), [sessionId, sessionId]);
    const expectIndexedPlan = (
      rows: Record<string, unknown>[],
      table: string,
      key: string,
      accessTypes: string[],
    ): void => {
      const row = rows.find((candidate) => candidate.table === table);
      expect(row, `${table} EXPLAIN row`).to.not.equal(undefined);
      expect(row?.key, `${table} index`).to.equal(key);
      expect(accessTypes, `${table} access type`).to.include(row?.type as string);
      expect(["ALL", "index"], `${table} avoided a full or covering scan`).to.not.include(
        row?.type as string,
      );
    };

    expectIndexedPlan(codePlan as Record<string, unknown>[], "Vouchers", "PRIMARY", ["const"]);
    expectIndexedPlan(
      sessionPlan as Record<string, unknown>[],
      "Vouchers",
      "VouchersSessionIdIdx",
      ["ref"],
    );
    expectIndexedPlan(cleanupPlan as Record<string, unknown>[], "Sessions", "PRIMARY", ["const"]);
    expectIndexedPlan(
      correlatedPlan as Record<string, unknown>[],
      "Vouchers",
      "VouchersSessionIdIdx",
      ["ref"],
    );
    expectIndexedPlan(
      correlatedPlan as Record<string, unknown>[],
      "Sessions",
      "PRIMARY",
      ["const", "eq_ref", "ref"],
    );
    expect(await voucherDb.getVoucher(code.toLowerCase())).to.equal(null);
  });

  it("runs MySQL voucher transitions with exact cleanup snapshots", async function() {
    this.timeout(20000);
    const {VoucherDB, VoucherState} = await import("../src/modules/voucher/VoucherDB.js");
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const database = databaseService.getDatabase();
    const voucherDb = new VoucherDB(
      {getModuleName: () => "voucher"} as any,
      databaseService,
    );
    await voucherDb.initSchema();

    const transitionCode = "MYSQLFLOW1";
    const firstOwner = "6f0656ea-988f-41d8-9131-bb39669a7547";
    const secondOwner = "0e020a4f-81c8-41f1-9d13-b29c50ae5cef";
    const transitionTime = Math.floor(Date.now() / 1000) - 120;
    const targetAddr = "0x0000000000000000000000000000000000001337";
    await VoucherDB.insertVoucher(database, transitionCode, "1");
    expect(await voucherDb.reserveVoucher(transitionCode, firstOwner, transitionTime)).to.equal(true);
    expect(await voucherDb.releaseVoucher(transitionCode, firstOwner)).to.equal(true);
    expect(await voucherDb.reserveVoucher(transitionCode, secondOwner, transitionTime + 1)).to.equal(true);
    expect(await voucherDb.consumeVoucher(transitionCode, secondOwner, targetAddr)).to.equal(true);
    expect((await voucherDb.getVoucher(transitionCode))?.state).to.equal(VoucherState.CONSUMED);

    const fixtures = [
      {
        code: "MYSQLCLN1",
        sessionId: "da28dab7-2533-475f-969b-e38a6661fb1e",
        status: FaucetSessionStatus.FAILED,
        voucherTarget: null,
        finalState: VoucherState.AVAILABLE,
        takeoverOwner: "76db652a-1ee9-402d-adbd-95cacaa0b994",
      },
      {
        code: "MYSQLCLN2",
        sessionId: "460b4df5-d539-482f-809e-f01b9818d649",
        status: FaucetSessionStatus.FAILED,
        voucherTarget: targetAddr,
        finalState: VoucherState.AVAILABLE,
        takeoverOwner: "bcf23afd-a744-463a-86d7-642d658c6e87",
      },
      {
        code: "MYSQLCLN3",
        sessionId: "c432630a-a551-488b-bf24-6fd76c9598e3",
        status: FaucetSessionStatus.FINISHED,
        voucherTarget: null,
        finalState: VoucherState.CONSUMED,
        takeoverOwner: null,
      },
      {
        code: "MYSQLCLN4",
        sessionId: "6f44208c-e6a2-4fa1-b2f8-7fc018c3e887",
        status: FaucetSessionStatus.FINISHED,
        voucherTarget: targetAddr,
        finalState: VoucherState.CONSUMED,
        takeoverOwner: null,
      },
    ];

    for(const [index, fixture] of fixtures.entries()) {
      const startTime = transitionTime - 10 - index;
      const dataJson = JSON.stringify({voucherCode: fixture.code});
      await databaseService.updateSession({
        sessionId: fixture.sessionId,
        status: fixture.status,
        startTime,
        targetAddr,
        dropAmount: "1",
        remoteIP: "8.8.8.8",
        tasks: [],
        data: {voucherCode: fixture.code},
        claim: null,
      });
      await database.run(
        "INSERT INTO Vouchers (Code, DropAmount, SessionId, TargetAddr, StartTime) VALUES (?, ?, ?, ?, ?)",
        [fixture.code, "1", fixture.sessionId, fixture.voucherTarget, startTime],
      );
      const candidate = {
        sessionId: fixture.sessionId,
        status: fixture.status,
        startTime,
        targetAddr,
        dataJson,
        claimDataJson: null,
        claim: null,
      };

      expect(await VoucherDB.prepareSessionCleanup(databaseService, candidate), fixture.code).to.equal(true);
      expect(await VoucherDB.prepareSessionCleanup(databaseService, candidate), fixture.code).to.equal(true);
      expect((await voucherDb.getVoucher(fixture.code))?.state, fixture.code).to.equal(
        fixture.finalState,
      );
      if(fixture.takeoverOwner !== null) {
        await database.run(
          "DELETE FROM Sessions WHERE SessionId = ?",
          [fixture.sessionId],
        );
        expect(
          await voucherDb.reserveVoucher(fixture.code, fixture.takeoverOwner, startTime + 100),
          fixture.code,
        ).to.equal(true);
        expect((await voucherDb.getVoucher(fixture.code))?.state, fixture.code).to.equal(
          VoucherState.LEASED,
        );
        expect(await voucherDb.reconcileOrphanedLeases(), fixture.code).to.equal(1);
        expect((await voucherDb.getVoucher(fixture.code))?.state, fixture.code).to.equal(
          VoucherState.AVAILABLE,
        );
      }
    }

    expect(await voucherDb.getVoucher(transitionCode.toLowerCase())).to.equal(null);
  });

  
});
