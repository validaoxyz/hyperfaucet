import 'mocha';
import { createHash } from 'node:crypto';
import sinon from 'sinon';
import { expect } from 'chai';
import { bindTestStubs, unbindTestStubs, loadDefaultTestConfig } from '../common.js';
import { ServiceManager } from '../../src/common/ServiceManager.js';
import { FaucetDatabase, FaucetDbDriver, SessionCleanupCandidate } from '../../src/db/FaucetDatabase.js';
import { ModuleHookAction, ModuleManager } from '../../src/modules/ModuleManager.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { faucetConfig } from '../../src/config/FaucetConfig.js';
import { FaucetError } from '../../src/common/FaucetError.js';
import { FaucetWebApi } from '../../src/webserv/FaucetWebApi.js';
import { IVoucherConfig } from '../../src/modules/voucher/VoucherConfig.js';
import { IVoucher, VoucherDB, VoucherState } from '../../src/modules/voucher/VoucherDB.js';
import { FaucetSession, FaucetSessionStatus, FaucetSessionStoreData } from '../../src/session/FaucetSession.js';
import { VoucherModule } from '../../src/modules/voucher/VoucherModule.js';
import { BaseDriver } from '../../src/db/driver/BaseDriver.js';
import { FaucetProcess } from '../../src/common/FaucetProcess.js';
import { toClientFailure } from '../../src/webserv/PublicErrors.js';
import { ClaimTxStatus, EthClaimData } from '../../src/eth/EthClaim.js';


const PRIMARY_TARGET = "0x0000000000000000000000000000000000001337";
const SECONDARY_TARGET = "0x0000000000000000000000000000000000001338";

function storedSession(
  sessionId: string,
  status: FaucetSessionStatus,
  targetAddr: string,
  startTime = Math.floor(Date.now() / 1000),
  voucherCode?: string,
  claim: EthClaimData | null = null,
): FaucetSessionStoreData {
  return {
    sessionId,
    status,
    startTime,
    targetAddr,
    dropAmount: "1000000000000000000",
    remoteIP: "8.8.8.8",
    tasks: [],
    data: voucherCode === undefined ? {} : {voucherCode},
    claim,
  };
}

async function startVoucherModule(
  config: Partial<IVoucherConfig> = {},
): Promise<{voucherModule: VoucherModule; voucherDb: VoucherDB; database: BaseDriver}> {
  faucetConfig.modules["voucher"] = {
    enabled: true,
    voucherLabel: null,
    infoHtml: null,
    ...config,
  };
  const moduleManager = ServiceManager.GetService(ModuleManager);
  await moduleManager.initialize();
  const voucherModule = moduleManager.getModule<VoucherModule>("voucher");
  const voucherDb = (voucherModule as any).voucherDb as VoucherDB;
  return {
    voucherModule,
    voucherDb,
    database: (voucherDb as any).db as BaseDriver,
  };
}

function claimData(status: ClaimTxStatus): EthClaimData {
  const common = {
    claimFormat: 2 as const,
    claimIdx: 1,
    claimTime: 1700000000,
  };
  switch(status) {
    case ClaimTxStatus.FAILED:
      return {...common, claimStatus: status, txError: "failed claim"};
    case ClaimTxStatus.REVERTED:
      return {
        ...common,
        claimStatus: status,
        txHash: `0x${"11".repeat(32)}`,
        txHex: "0x01",
        txNonce: 1,
        txBlock: 1,
        txFee: "1",
        txError: "reverted claim",
      };
    case ClaimTxStatus.CONFIRMED:
      return {
        ...common,
        claimStatus: status,
        txHash: `0x${"22".repeat(32)}`,
        txHex: "0x02",
        txNonce: 2,
        txBlock: 2,
        txFee: "2",
      };
    case ClaimTxStatus.PENDING:
      return {
        ...common,
        claimStatus: status,
        txHash: `0x${"33".repeat(32)}`,
        txHex: "0x03",
        txNonce: 3,
      };
    default:
      throw new Error(`Unsupported claim fixture status: ${status}`);
  }
}

function cleanupClaimDataHash(claimDataJson: string | null): string {
  const hash = createHash("sha256").update("hyperfaucet:voucher-cleanup:claim-data:v1\0");
  if(claimDataJson === null)
    return hash.update("null").digest("hex");
  return hash.update("value\0").update(claimDataJson).digest("hex");
}

async function insertVoucher(
  database: BaseDriver,
  code: string,
  sessionId: string | null = null,
  targetAddr: string | null = null,
  startTime: number | null = null,
  dropAmount = "1000000000000000000",
): Promise<void> {
  await database.run(
    "INSERT INTO Vouchers (Code, DropAmount, SessionId, TargetAddr, StartTime) VALUES (?, ?, ?, ?, ?)",
    [code, dropAmount, sessionId, targetAddr, startTime],
  );
}

async function writeFailedCleanupReceipt(
  code: string,
  sessionId: string,
  startTime: number,
  claim: EthClaimData | null = null,
): Promise<{database: BaseDriver; candidate: SessionCleanupCandidate}> {
  const databaseService = ServiceManager.GetService(FaucetDatabase);
  const database = databaseService.getDatabase();
  await databaseService.updateSession(
    storedSession(sessionId, FaucetSessionStatus.FAILED, PRIMARY_TARGET, startTime, code, claim),
  );
  await insertVoucher(database, code, sessionId, PRIMARY_TARGET, startTime);
  const candidate: SessionCleanupCandidate = {
    sessionId,
    status: FaucetSessionStatus.FAILED,
    startTime,
    targetAddr: PRIMARY_TARGET,
    dataJson: JSON.stringify({voucherCode: code}),
    claimDataJson: claim === null ? null : JSON.stringify(claim),
    claim,
  };
  if(!await VoucherDB.prepareSessionCleanup(databaseService, candidate))
    throw new Error("Failed to prepare the cleanup receipt fixture.");
  return {database, candidate};
}


describe("Faucet module: voucher", () => {
  let globalStubs;

  beforeEach(async () => {
    globalStubs = bindTestStubs();
    loadDefaultTestConfig();
    await ServiceManager.GetService(FaucetDatabase).initialize();
  });
  
  afterEach(async () => {
    let dbService = ServiceManager.GetService(FaucetDatabase);
    await ServiceManager.DisposeAllServices();
    await dbService.closeDatabase();
    await unbindTestStubs(globalStubs);
  });

  it("Check client config exports", async () => {
    await startVoucherModule({
      voucherLabel: "Voucher",
      infoHtml: "Voucher info",
    });
    let clientConfig = await ServiceManager.GetService(FaucetWebApi).onGetFaucetConfig();
    expect(!!clientConfig.modules['voucher']).to.equal(true, "no voucher config exported");
    expect(clientConfig.modules['voucher'].voucherLabel).to.equal("Voucher", "client config mismatch: voucherLabel");
    expect(clientConfig.modules['voucher'].infoHtml).to.equal("Voucher info", "client config mismatch: infoHtml");
  });

  it("Upgrades an enabled v1 schema before voucher-bound terminal cleanup", async () => {
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const database = databaseService.getDatabase();
    await database.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", ["voucher", 1]);
    await database.exec(`
      CREATE TABLE Vouchers (
        Code TEXT NOT NULL UNIQUE,
        DropAmount TEXT NOT NULL,
        SessionId TEXT NULL,
        TargetAddr TEXT NULL,
        StartTime INTEGER NULL,
        PRIMARY KEY(Code)
      );
    `);
    const sessionId = "bf9674c4-ae03-43e8-8fea-b9e561453d91";
    const startTime = Math.floor(Date.now() / 1000) - 60;
    await databaseService.updateSession(
      storedSession(sessionId, FaucetSessionStatus.FAILED, PRIMARY_TARGET, startTime, "UPGRADEV1"),
    );
    await insertVoucher(database, "UPGRADEV1", sessionId, PRIMARY_TARGET, startTime);
    faucetConfig.modules["voucher"] = {enabled: true} as IVoucherConfig;
    faucetConfig.sessionCleanup = 10;

    await ServiceManager.GetService(ModuleManager).initialize();

    const schema = await database.get(
      "SELECT Version FROM SchemaVersion WHERE Module = ?",
      ["voucher"],
    ) as Record<string, unknown>;
    const columns = await database.all("PRAGMA table_info(Vouchers)");
    const columnNames = columns.map((column) => (column as Record<string, unknown>).name);
    expect(schema.Version).to.equal(3);
    expect(columnNames).to.include.members([
      "CleanupVoucherCode",
      "CleanupSessionId",
      "CleanupStartTime",
      "CleanupTargetAddr",
      "CleanupStatus",
      "CleanupExpectedState",
      "CleanupDataHash",
      "CleanupClaimDataHash",
    ]);
    const indexes = await database.all("PRAGMA index_list(Vouchers)");
    expect(indexes.map((index) => (index as Record<string, unknown>).name)).to.include(
      "VouchersSessionIdIdx",
    );
    await databaseService.cleanStore();
    expect(await databaseService.getSession(sessionId)).to.equal(null);
    const voucherModule = ServiceManager.GetService(ModuleManager).getModule<VoucherModule>("voucher");
    const voucherDb = (voucherModule as any).voucherDb as VoucherDB;
    expect((await voucherDb.getVoucher("UPGRADEV1") as IVoucher).state).to.equal(VoucherState.AVAILABLE);
  });

  it("Upgrades a v2 schema to v3 without changing voucher tuples", async () => {
    const database = ServiceManager.GetService(FaucetDatabase).getDatabase();
    await database.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", ["voucher", 2]);
    await database.exec(`
      CREATE TABLE Vouchers (
        Code TEXT NOT NULL UNIQUE,
        DropAmount TEXT NOT NULL,
        SessionId TEXT NULL,
        TargetAddr TEXT NULL,
        StartTime INTEGER NULL,
        CleanupVoucherCode TEXT NULL,
        CleanupSessionId TEXT NULL,
        CleanupStartTime INTEGER NULL,
        CleanupTargetAddr TEXT NULL,
        CleanupStatus TEXT NULL,
        CleanupExpectedState TEXT NULL,
        CleanupDataHash TEXT NULL,
        PRIMARY KEY(Code)
      );
    `);
    await insertVoucher(database, "UPGRADEV2", "v2-owner", PRIMARY_TARGET, 1700000000);
    const before = await database.get("SELECT * FROM Vouchers WHERE Code = ?", ["UPGRADEV2"]);
    faucetConfig.modules["voucher"] = {enabled: true} as IVoucherConfig;

    await ServiceManager.GetService(ModuleManager).initialize();

    const schema = await database.get(
      "SELECT Version FROM SchemaVersion WHERE Module = ?",
      ["voucher"],
    ) as Record<string, unknown>;
    const columns = await database.all("PRAGMA table_info(Vouchers)");
    const indexes = await database.all("PRAGMA index_list(Vouchers)");
    const after = await database.get(
      [
        "SELECT Code, DropAmount, SessionId, TargetAddr, StartTime, CleanupVoucherCode,",
        "CleanupSessionId, CleanupStartTime, CleanupTargetAddr, CleanupStatus,",
        "CleanupExpectedState, CleanupDataHash FROM Vouchers WHERE Code = ?",
      ].join(" "),
      ["UPGRADEV2"],
    );
    expect(schema.Version).to.equal(3);
    expect(columns.map((column) => (column as Record<string, unknown>).name)).to.include(
      "CleanupClaimDataHash",
    );
    expect(indexes.map((index) => (index as Record<string, unknown>).name)).to.include(
      "VouchersSessionIdIdx",
    );
    expect(after).to.deep.equal(before);
  });

  it("Creates a fresh v3 schema whose owner lookup uses the SessionId index", async () => {
    const {database} = await startVoucherModule();
    const schema = await database.get(
      "SELECT Version FROM SchemaVersion WHERE Module = ?",
      ["voucher"],
    ) as Record<string, unknown>;
    const columns = await database.all("PRAGMA table_info(Vouchers)");
    const indexes = await database.all("PRAGMA index_list(Vouchers)");
    const plan = await database.all(
      [
        "EXPLAIN QUERY PLAN SELECT Code FROM Vouchers",
        "WHERE SessionId = ? AND SessionId = ? LIMIT 2",
      ].join(" "),
      ["index-owner", "index-owner"],
    ) as Array<Record<string, unknown>>;

    expect(schema.Version).to.equal(3);
    expect(columns.map((column) => column.name)).to.include("CleanupClaimDataHash");
    expect(indexes.map((index) => (index as Record<string, unknown>).name)).to.include(
      "VouchersSessionIdIdx",
    );
    expect(plan.some((row) => String(row.detail).includes("VouchersSessionIdIdx"))).to.equal(true);
  });

  it("Resumes v0, v1, and v2 SQLite migrations after every committed DDL boundary", async () => {
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
            Code TEXT NOT NULL UNIQUE,
            DropAmount TEXT NOT NULL,
            SessionId TEXT NULL,
            TargetAddr TEXT NULL,
            StartTime INTEGER NULL,
            PRIMARY KEY(Code)
          )
        `,
      },
      {
        version: 2,
        expectedInterruptions: 2,
        createSql: `
          CREATE TABLE Vouchers (
            Code TEXT NOT NULL UNIQUE,
            DropAmount TEXT NOT NULL,
            SessionId TEXT NULL,
            TargetAddr TEXT NULL,
            StartTime INTEGER NULL,
            CleanupVoucherCode TEXT NULL,
            CleanupSessionId TEXT NULL,
            CleanupStartTime INTEGER NULL,
            CleanupTargetAddr TEXT NULL,
            CleanupStatus TEXT NULL,
            CleanupExpectedState TEXT NULL,
            CleanupDataHash TEXT NULL,
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
        await insertVoucher(database, `MIGRATEV${fixture.version}`);
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
        const isVoucherDdl = statement.includes('CREATE TABLE IF NOT EXISTS "Vouchers"')
          || statement.startsWith("ALTER TABLE Vouchers ADD COLUMN")
          || statement.startsWith("CREATE INDEX VouchersSessionIdIdx");
        if(isVoucherDdl && !interruptedStatements.has(statement)) {
          interruptedStatements.add(statement);
          interruptions++;
          throw new Error(`injected migration interruption ${interruptions}`);
        }
      });

      let completed = false;
      try {
        for(let attempt = 0; attempt < 12 && !completed; attempt++) {
          try {
            await voucherDb.initSchema();
            completed = true;
          } catch(error) {
            expect(String(error)).to.include("injected migration interruption");
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
      const columns = await database.all("PRAGMA table_info(Vouchers)");
      expect(columns.map((column) => column.name)).to.include.members([
        "CleanupVoucherCode",
        "CleanupSessionId",
        "CleanupStartTime",
        "CleanupTargetAddr",
        "CleanupStatus",
        "CleanupExpectedState",
        "CleanupDataHash",
        "CleanupClaimDataHash",
      ]);
      const indexes = await database.all("PRAGMA index_list(Vouchers)");
      expect(indexes.map((index) => index.name)).to.include("VouchersSessionIdIdx");
      if(fixture.version > 0) {
        const voucher = await database.get(
          "SELECT Code, DropAmount, SessionId, TargetAddr, StartTime FROM Vouchers",
        );
        expect(voucher).to.deep.equal({
          Code: `MIGRATEV${fixture.version}`,
          DropAmount: "1000000000000000000",
          SessionId: null,
          TargetAddr: null,
          StartTime: null,
        });
      }
    }
  });

  it("Rejects an incompatible partial voucher migration without changing it", async () => {
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const database = databaseService.getDatabase();
    await database.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", ["voucher", 1]);
    await database.exec(`
      CREATE TABLE Vouchers (
        Code TEXT NOT NULL UNIQUE,
        DropAmount TEXT NOT NULL,
        SessionId TEXT NULL,
        TargetAddr TEXT NULL,
        StartTime INTEGER NULL,
        CleanupVoucherCode INTEGER NULL,
        PRIMARY KEY(Code)
      )
    `);
    const before = await database.all("PRAGMA table_info(Vouchers)");
    const voucherDb = new VoucherDB(
      {getModuleName: () => "voucher"} as any,
      databaseService,
    );

    let migrationError: unknown;
    try {
      await voucherDb.initSchema();
    } catch(error) {
      migrationError = error;
    }

    expect(String(migrationError)).to.include("incompatible definition");
    expect(await database.all("PRAGMA table_info(Vouchers)")).to.deep.equal(before);
    const version = await database.get(
      "SELECT Version FROM SchemaVersion WHERE Module = ?",
      ["voucher"],
    ) as Record<string, unknown>;
    expect(version.Version).to.equal(1);
  });

  it("Allows only unambiguous non-voucher cleanup while a disabled schema remains at v1", async () => {
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const database = databaseService.getDatabase();
    await database.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", ["voucher", 1]);
    await database.exec(`
      CREATE TABLE Vouchers (
        Code TEXT NOT NULL UNIQUE,
        DropAmount TEXT NOT NULL,
        SessionId TEXT NULL,
        TargetAddr TEXT NULL,
        StartTime INTEGER NULL,
        PRIMARY KEY(Code)
      );
    `);
    faucetConfig.modules["voucher"] = {enabled: false} as IVoucherConfig;
    faucetConfig.sessionCleanup = 10;
    const startTime = Math.floor(Date.now() / 1000) - 60;
    const plainSessionId = "4b51f621-2e28-47ff-89f8-652162056218";
    const boundSessionId = "e0916c9a-aa62-45dc-84f5-64601622f0e8";
    const boundWithoutRowSessionId = "6662bcc1-bdd6-4699-bdd7-2a810883eff0";
    const ownedPlainSessionId = "97f63708-3555-4dd1-b791-47b9706d92b8";
    const invalidSessionId = "63ed496a-ec75-4b7b-b37e-d688320d2bc7";
    await databaseService.updateSession(
      storedSession(plainSessionId, FaucetSessionStatus.FAILED, PRIMARY_TARGET, startTime),
    );
    await databaseService.updateSession(
      storedSession(boundSessionId, FaucetSessionStatus.FAILED, PRIMARY_TARGET, startTime, "BOUNDV101"),
    );
    await databaseService.updateSession(
      storedSession(
        boundWithoutRowSessionId,
        FaucetSessionStatus.FAILED,
        PRIMARY_TARGET,
        startTime,
        "MISSINGV1",
      ),
    );
    await databaseService.updateSession(
      storedSession(ownedPlainSessionId, FaucetSessionStatus.FAILED, PRIMARY_TARGET, startTime),
    );
    await databaseService.updateSession(
      storedSession(invalidSessionId, FaucetSessionStatus.FAILED, PRIMARY_TARGET, startTime),
    );
    await database.run("UPDATE Sessions SET Data = ? WHERE SessionId = ?", ["{", invalidSessionId]);
    await insertVoucher(database, "BOUNDV101", boundSessionId, null, startTime);
    await insertVoucher(database, "OWNEDV101", ownedPlainSessionId, null, startTime);

    await databaseService.cleanStore();

    expect(await databaseService.getSession(plainSessionId)).to.equal(null);
    expect(await databaseService.getSession(boundSessionId)).to.not.equal(null);
    expect(await databaseService.getSession(boundWithoutRowSessionId)).to.not.equal(null);
    expect(await databaseService.getSession(ownedPlainSessionId)).to.not.equal(null);
    const invalidRow = await database.get(
      "SELECT SessionId FROM Sessions WHERE SessionId = ?",
      [invalidSessionId],
    );
    expect(invalidRow).to.not.equal(null);
  });

  it("Retains terminal sessions while an installed voucher schema is pre-v1", async () => {
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const database = databaseService.getDatabase();
    await database.run("INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)", ["voucher", 0]);
    faucetConfig.modules["voucher"] = {enabled: false} as IVoucherConfig;
    faucetConfig.sessionCleanup = 10;
    const sessionId = "57d6706a-0ad0-41ce-8cc9-f0a48298023e";
    await databaseService.updateSession(
      storedSession(
        sessionId,
        FaucetSessionStatus.FAILED,
        PRIMARY_TARGET,
        Math.floor(Date.now() / 1000) - 60,
      ),
    );

    await databaseService.cleanStore();

    expect(await databaseService.getSession(sessionId)).to.not.equal(null);
  });

  it("Process session start with valid voucher code", async () => {
    const {voucherDb, database: faucetDb} = await startVoucherModule();
    
    await faucetDb.run(
      "INSERT INTO Vouchers (Code, DropAmount, SessionId, TargetAddr, StartTime) VALUES (?, ?, ?, ?, ?)",
      ["VALID123", "1000000000000000000", null, null, null]
    );
    const logSpy = sinon.spy(ServiceManager.GetService(FaucetProcess), "emitLog");
    
    // Create session with valid voucher code
    const testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      voucherCode: "VALID123"
    });
    
    // Verify session was created successfully
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    
    // Verify voucher was updated in the database
    const voucher = await voucherDb.getVoucher("VALID123") as IVoucher;

    expect(!!voucher).to.equal(true, "voucher not found");
    expect(voucher.sessionId).to.equal(testSession.getSessionId(), "voucher not updated with session ID");
    expect(voucher.targetAddr).to.equal(testSession.getTargetAddr(), "voucher not updated with target address");
    
    // Verify drop amount was set from voucher
    expect(testSession.getSessionData("overrideMaxDropAmount")).to.equal("1000000000000000000", "drop amount not overridden");
    expect(logSpy.getCalls().every((call) => !String(call.args[1]).includes("VALID123"))).to.equal(
      true,
      "voucher capability leaked into logs",
    );
  });
  
  it("Process session start without voucher code", async () => {
    await startVoucherModule();
    let sessionManager = ServiceManager.GetService(SessionManager);
    
    // Try to create session without voucher code
    let error: FaucetError | null = null;
    try {
      await sessionManager.createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337"
      });
    } catch(ex) {
      error = ex;
    }
    
    // Verify correct error was thrown
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("VOUCHER_REQUIRED", "unexpected error code");
  });
  
  it("Process session start with invalid voucher code", async () => {
    await startVoucherModule({
      voucherLabel: "Voucher",
      infoHtml: "Voucher info",
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    
    // Try to create session with invalid voucher code
    let error: FaucetError | null = null;
    try {
      await sessionManager.createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        voucherCode: "INVALID123"
      });
    } catch(ex) {
      error = ex;
    }
    
    // Verify correct error was thrown
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("VOUCHER_INVALID", "unexpected error code");
  });
  
  it("Process session start with already used voucher code", async () => {
    const {voucherDb, database: faucetDb} = await startVoucherModule({
      voucherLabel: "Voucher",
      infoHtml: "Voucher info",
    });
    const dbService = ServiceManager.GetService(FaucetDatabase);
    
    // Create a used voucher in the database (with session info)
    const usedSessionId = "existing-session-id";
    await faucetDb.run(
      "INSERT INTO Vouchers (Code, DropAmount, SessionId, TargetAddr, StartTime) VALUES (?, ?, ?, ?, ?)",
      ["USED123", "1000000000000000000", usedSessionId, "0x0000000000000000000000000000000000000123", 123456789]
    );
    
    // Create a completed session in the sessions table
    await dbService.updateSession({
      sessionId: usedSessionId,
      status: FaucetSessionStatus.FINISHED,
      startTime: 123456789,
      targetAddr: "0x0000000000000000000000000000000000000123",
      dropAmount: "1000000000000000000",
      remoteIP: "1.2.3.4",
      tasks: [],
      data: {},
      claim: null
    });
    
    // Try to create a new session with the used voucher code
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        voucherCode: "USED123"
      });
    } catch(ex) {
      error = ex;
    }
    
    // Verify correct error was thrown
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("VOUCHER_USED", "unexpected error code");
  });
  
  it("Allow reuse of voucher if previous session failed", async () => {
    const {voucherDb, database: faucetDb} = await startVoucherModule({
      voucherLabel: "Voucher",
      infoHtml: "Voucher info",
    });
    const dbService = ServiceManager.GetService(FaucetDatabase);
    
    // Create a voucher used in a failed session
    const failedSessionId = "failed-session-id";
    await faucetDb.run(
      "INSERT INTO Vouchers (Code, DropAmount, SessionId, TargetAddr, StartTime) VALUES (?, ?, ?, ?, ?)",
      ["FAILED123", "1000000000000000000", failedSessionId, "0x0000000000000000000000000000000000000123", 123456789]
    );
    await dbService.updateSession({
      sessionId: failedSessionId,
      status: FaucetSessionStatus.FAILED,
      startTime: 123456789,
      targetAddr: "0x0000000000000000000000000000000000000123",
      dropAmount: "1000000000000000000",
      remoteIP: "1.2.3.4",
      tasks: [],
      data: {voucherCode: "FAILED123"},
      claim: null
    });
    
    // Create session with voucher code from a failed session
    const testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      voucherCode: "FAILED123"
    });
    
    // Verify session was created successfully
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    
    // Verify voucher was updated
    const voucher = await voucherDb.getVoucher("FAILED123") as IVoucher;
    expect(!!voucher).to.equal(true, "voucher not found");
    expect(voucher.sessionId).to.equal(testSession.getSessionId(), "voucher not updated with new session ID");
  });

  it("Finishes failed-owner cleanup before takeover across restart and repeated reuse", async () => {
    const {voucherDb, database} = await startVoucherModule();
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const owners = Array.from({length: 7}, (_, index) => (
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
    ));
    const initialStartTime = 1700000900;
    await insertVoucher(database, "REUSEBOUND", owners[0], PRIMARY_TARGET, initialStartTime);
    await databaseService.updateSession(
      storedSession(
        owners[0],
        FaucetSessionStatus.FAILED,
        PRIMARY_TARGET,
        initialStartTime,
        "REUSEBOUND",
      ),
    );

    let allowCleanup = false;
    const unregisterGuard = databaseService.registerSessionCleanupGuard(
      "paused failed-owner takeover",
      () => allowCleanup,
    );
    expect(await voucherDb.reserveVoucher("REUSEBOUND", owners[1], initialStartTime + 1)).to.equal(false);
    const pausedVoucher = await voucherDb.getVoucher("REUSEBOUND") as IVoucher;
    const pausedReceipt = await database.get(
      "SELECT CleanupSessionId, CleanupStatus FROM Vouchers WHERE Code = ?",
      ["REUSEBOUND"],
    ) as Record<string, unknown>;
    expect(pausedVoucher.state).to.equal(VoucherState.AVAILABLE);
    expect(pausedReceipt).to.deep.equal({
      CleanupSessionId: owners[0],
      CleanupStatus: FaucetSessionStatus.FAILED,
    });
    expect(await databaseService.getSession(owners[0])).to.not.equal(null);

    allowCleanup = true;
    unregisterGuard();
    const restartedVoucherDb = new VoucherDB(
      {getModuleName: () => "voucher"} as any,
      databaseService,
    );
    expect(
      await restartedVoucherDb.reserveVoucher("REUSEBOUND", owners[1], initialStartTime + 1),
    ).to.equal(true);
    expect(await databaseService.getSession(owners[0])).to.equal(null);

    for(let index = 1; index < owners.length - 1; index++) {
      const startTime = initialStartTime + index;
      expect(
        await restartedVoucherDb.consumeVoucher("REUSEBOUND", owners[index], PRIMARY_TARGET),
      ).to.equal(true);
      await databaseService.updateSession(
        storedSession(
          owners[index],
          FaucetSessionStatus.FAILED,
          PRIMARY_TARGET,
          startTime,
          "REUSEBOUND",
        ),
      );
      expect(
        await restartedVoucherDb.reserveVoucher(
          "REUSEBOUND",
          owners[index + 1],
          startTime + 1,
        ),
      ).to.equal(true);
      expect(await databaseService.getSession(owners[index])).to.equal(null);
    }

    const retainedFailedSessions = await database.all(
      "SELECT SessionId FROM Sessions WHERE Status = ?",
      [FaucetSessionStatus.FAILED],
    );
    expect(retainedFailedSessions).to.deep.equal([]);
    const finalVoucher = await restartedVoucherDb.getVoucher("REUSEBOUND") as IVoucher;
    expect(finalVoucher.state).to.equal(VoucherState.LEASED);
    expect(finalVoucher.sessionId).to.equal(owners.at(-1));
    const finalReceipt = await database.get([
      "SELECT CleanupVoucherCode, CleanupSessionId, CleanupStartTime, CleanupTargetAddr,",
      "CleanupStatus, CleanupExpectedState, CleanupDataHash, CleanupClaimDataHash",
      "FROM Vouchers WHERE Code = ?",
    ].join(" "), ["REUSEBOUND"]) as Record<string, unknown>;
    expect(Object.values(finalReceipt).every((value) => value === null)).to.equal(true);
  });

  it("Retains failed sessions when their cleanup proof is forged or missing", async () => {
    const {voucherDb, database} = await startVoucherModule();
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    faucetConfig.sessionCleanup = -1;
    const forgedSessionId = "f83af69a-91d2-4422-af1a-d1115290480f";
    const missingSessionId = "7267458d-f71b-460a-a1d3-b30f69040014";
    await writeFailedCleanupReceipt("FORGED01", forgedSessionId, 1700000950);
    await database.run(
      "UPDATE Vouchers SET CleanupDataHash = ? WHERE Code = ?",
      ["0".repeat(64), "FORGED01"],
    );
    const forgedBefore = await database.get("SELECT * FROM Vouchers WHERE Code = ?", ["FORGED01"]);
    expect(
      await voucherDb.reserveVoucher(
        "FORGED01",
        "a5885da0-43c7-4c17-b471-3d553f4d3295",
        1700000951,
      ),
    ).to.equal(false);

    await writeFailedCleanupReceipt("MISSING01", missingSessionId, 1700000960);
    await database.run([
      "UPDATE Vouchers SET CleanupVoucherCode = NULL, CleanupSessionId = NULL,",
      "CleanupStartTime = NULL, CleanupTargetAddr = NULL, CleanupStatus = NULL,",
      "CleanupExpectedState = NULL, CleanupDataHash = NULL, CleanupClaimDataHash = NULL",
      "WHERE Code = ?",
    ].join(" "), ["MISSING01"]);
    const missingBefore = await database.get("SELECT * FROM Vouchers WHERE Code = ?", ["MISSING01"]);

    await databaseService.cleanStore();

    expect(await databaseService.getSession(forgedSessionId)).to.not.equal(null);
    expect(await databaseService.getSession(missingSessionId)).to.not.equal(null);
    expect(await database.get("SELECT * FROM Vouchers WHERE Code = ?", ["FORGED01"])).to.deep.equal(
      forgedBefore,
    );
    expect(await database.get("SELECT * FROM Vouchers WHERE Code = ?", ["MISSING01"])).to.deep.equal(
      missingBefore,
    );
  });

  it("Reuses failed-session vouchers only for exact eligible ClaimData", async () => {
    const {voucherDb, database} = await startVoucherModule();
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const cases: Array<{
      code: string;
      oldSessionId: string;
      newSessionId: string;
      claim: EthClaimData | "malformed";
      expected: boolean;
    }> = [
      {
        code: "CLAIMFAIL",
        oldSessionId: "2823707c-9e48-4382-a178-d6428221c235",
        newSessionId: "a826fa63-592e-450d-a388-ccbf6a8e6ef9",
        claim: claimData(ClaimTxStatus.FAILED),
        expected: true,
      },
      {
        code: "CLAIMREV1",
        oldSessionId: "bca192df-063d-4f79-a745-b8d9af4f0f3e",
        newSessionId: "66360edf-63ef-492f-858d-5ef0431a1db1",
        claim: claimData(ClaimTxStatus.REVERTED),
        expected: true,
      },
      {
        code: "CLAIMCONF",
        oldSessionId: "fb0080c3-5fd3-435f-aef2-2ab40f45e833",
        newSessionId: "4641821d-f426-44da-86b0-da66c6af37ca",
        claim: claimData(ClaimTxStatus.CONFIRMED),
        expected: false,
      },
      {
        code: "CLAIMPEND",
        oldSessionId: "90a6d66c-5493-4375-8a37-98c4cd4c54f1",
        newSessionId: "dafb78c2-225c-462f-a8a3-4ad3adbce33a",
        claim: claimData(ClaimTxStatus.PENDING),
        expected: false,
      },
      {
        code: "CLAIMBAD1",
        oldSessionId: "f29af868-f70a-4ca0-b376-98897be8a02c",
        newSessionId: "062aec5c-bbd4-484f-9f36-c73381172642",
        claim: "malformed",
        expected: false,
      },
    ];

    for(const [index, testCase] of cases.entries()) {
      const startTime = 1700001000 + index;
      const storedClaim = testCase.claim === "malformed" ? null : testCase.claim;
      await databaseService.updateSession(
        storedSession(
          testCase.oldSessionId,
          FaucetSessionStatus.FAILED,
          PRIMARY_TARGET,
          startTime,
          testCase.code,
          storedClaim,
        ),
      );
      if(testCase.claim === "malformed") {
        await database.run(
          "UPDATE Sessions SET ClaimData = ? WHERE SessionId = ?",
          ["{", testCase.oldSessionId],
        );
      }
      await insertVoucher(
        database,
        testCase.code,
        testCase.oldSessionId,
        PRIMARY_TARGET,
        startTime,
      );
      const before = await database.get("SELECT * FROM Vouchers WHERE Code = ?", [testCase.code]);

      expect(
        await voucherDb.reserveVoucher(testCase.code, testCase.newSessionId, startTime + 100),
        testCase.code,
      ).to.equal(testCase.expected);

      if(testCase.expected) {
        const reused = await voucherDb.getVoucher(testCase.code) as IVoucher;
        expect(reused.state).to.equal(VoucherState.LEASED);
        expect(reused.sessionId).to.equal(testCase.newSessionId);
      } else {
        expect(await database.get("SELECT * FROM Vouchers WHERE Code = ?", [testCase.code])).to.deep.equal(
          before,
        );
      }
    }
  });

  it("Rejects failed-session reuse when its persisted voucher binding is malformed", async () => {
    const {voucherDb, database} = await startVoucherModule();
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const cases = [
      {
        code: "BINDDATA",
        oldSessionId: "5d963b24-2e3e-4c9b-b508-0177b8c7bdb3",
        newSessionId: "d0882e9f-24f6-46af-af47-b96d94851c30",
        mutate: (sessionId: string) => database.run(
          "UPDATE Sessions SET Data = ? WHERE SessionId = ?",
          ["{", sessionId],
        ),
      },
      {
        code: "BINDTARG",
        oldSessionId: "05d694a9-c302-4558-bfc9-f811a294f766",
        newSessionId: "33c8a57b-edf2-4ead-b441-0b7346d4ea3c",
        mutate: (sessionId: string) => database.run(
          "UPDATE Sessions SET TargetAddr = ? WHERE SessionId = ?",
          ["invalid-target", sessionId],
        ),
      },
    ];

    for(const [index, testCase] of cases.entries()) {
      const startTime = 1700001050 + index;
      await databaseService.updateSession(
        storedSession(
          testCase.oldSessionId,
          FaucetSessionStatus.FAILED,
          PRIMARY_TARGET,
          startTime,
          testCase.code,
        ),
      );
      await testCase.mutate(testCase.oldSessionId);
      await insertVoucher(
        database,
        testCase.code,
        testCase.oldSessionId,
        PRIMARY_TARGET,
        startTime,
      );
      const before = await database.get("SELECT * FROM Vouchers WHERE Code = ?", [testCase.code]);

      expect(
        await voucherDb.reserveVoucher(testCase.code, testCase.newSessionId, startTime + 100),
      ).to.equal(false);
      expect(await database.get("SELECT * FROM Vouchers WHERE Code = ?", [testCase.code])).to.deep.equal(
        before,
      );
    }
  });

  it("Rejects a failed-session takeover if ClaimData changes during its CAS", async () => {
    const {voucherDb, database} = await startVoucherModule();
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const oldSessionId = "6a817536-681d-44b6-a1c1-a85bb22df140";
    const newSessionId = "ea860323-b66e-46bd-aa57-d4f09d165974";
    const startTime = 1700001100;
    await databaseService.updateSession(
      storedSession(
        oldSessionId,
        FaucetSessionStatus.FAILED,
        PRIMARY_TARGET,
        startTime,
        "CLAIMCAS1",
        claimData(ClaimTxStatus.FAILED),
      ),
    );
    await insertVoucher(database, "CLAIMCAS1", oldSessionId, PRIMARY_TARGET, startTime);
    const before = await database.get("SELECT * FROM Vouchers WHERE Code = ?", ["CLAIMCAS1"]);
    const originalRun = database.run.bind(database);
    let mutateClaim = true;
    sinon.stub(database, "run").callsFake(async (sql, values) => {
      if(
        mutateClaim
        && String(sql).includes("UPDATE Vouchers SET SessionId = NULL, TargetAddr = NULL, StartTime = NULL")
        && String(sql).includes("CleanupClaimDataHash")
      ) {
        mutateClaim = false;
        await originalRun(
          "UPDATE Sessions SET ClaimData = ? WHERE SessionId = ?",
          [JSON.stringify(claimData(ClaimTxStatus.REVERTED)), oldSessionId],
        );
      }
      return originalRun(sql, values);
    });

    expect(await voucherDb.reserveVoucher("CLAIMCAS1", newSessionId, startTime + 1)).to.equal(false);
    expect(await database.get("SELECT * FROM Vouchers WHERE Code = ?", ["CLAIMCAS1"])).to.deep.equal(before);
  });

  it("Process session start with voucher without drop amount", async () => {
    const {voucherDb, database: faucetDb} = await startVoucherModule({
      voucherLabel: "Voucher",
      infoHtml: "Voucher info",
    });
    
    // Create a voucher in the database without drop amount
    await faucetDb.run(
      "INSERT INTO Vouchers (Code, DropAmount, SessionId, TargetAddr, StartTime) VALUES (?, ?, ?, ?, ?)",
      ["NODROP123", "", null, null, null]
    );
    
    // Create session with voucher that has no drop amount
    const testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      voucherCode: "NODROP123"
    });
    
    // Verify session was created successfully
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    
    // Verify voucher was updated
    const voucher = await voucherDb.getVoucher("NODROP123") as IVoucher;
    expect(!!voucher).to.equal(true, "voucher not found");
    expect(voucher.sessionId).to.equal(testSession.getSessionId(), "voucher not updated with session ID");
    
    // Verify drop amount was not set (should be undefined)
    expect(testSession.getSessionData("overrideMaxDropAmount")).to.be.undefined;
  });

  it("Handle race condition when submitting the same voucher simultaneously", async () => {
    const {voucherDb, database: faucetDb} = await startVoucherModule();
    
    // Create a voucher in the database
    await faucetDb.run(
      "INSERT INTO Vouchers (Code, DropAmount, SessionId, TargetAddr, StartTime) VALUES (?, ?, ?, ?, ?)",
      ["RACE123", "1000000000000000000", null, null, null]
    );
    
    // Try to create two sessions with the same voucher code simultaneously
    const sessionManager = ServiceManager.GetService(SessionManager);
    
    // Start two session creations at the same time
    const session1Promise = sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      voucherCode: "RACE123"
    });
    
    const session2Promise = sessionManager.createSession("::ffff:8.8.8.9", {
      addr: "0x0000000000000000000000000000000000001338",
      voucherCode: "RACE123"
    });
    
    // Wait for both to complete
    let successCount = 0;
    let errorCount = 0;
    let errorCode = "";
    
    try {
      await session1Promise;
      successCount++;
    } catch (ex) {
      errorCount++;
      if (ex instanceof FaucetError) {
        errorCode = ex.getCode();
      }
    }
    
    try {
      await session2Promise;
      successCount++;
    } catch (ex) {
      errorCount++;
      if (ex instanceof FaucetError) {
        errorCode = ex.getCode();
      }
    }
    
    // Verify only one session succeeded and one failed with VOUCHER_USED
    expect(successCount).to.equal(1, "expected exactly one session to succeed");
    expect(errorCount).to.equal(1, "expected exactly one session to fail");
    expect(errorCode).to.equal("VOUCHER_USED", "expected failure with VOUCHER_USED error code");
    
    // Verify the voucher was updated with the correct session info
    const voucher = await voucherDb.getVoucher("RACE123") as IVoucher;
    expect(!!voucher).to.equal(true, "voucher not found");
    expect(!!voucher.sessionId).to.equal(true, "voucher not updated with session ID");
    expect(voucher.state).to.equal(VoucherState.CONSUMED, "winning reservation was not consumed");
  });

  it("Allows only one concurrent voucher reservation for the same session owner", async () => {
    const {voucherDb, database} = await startVoucherModule();
    const sessionId = "370bc989-1352-4f64-a6d1-9e37f773c009";
    const attempts = [
      {code: "OWNRACE01", startTime: 1700001201},
      {code: "OWNRACE02", startTime: 1700001202},
    ];
    for(const attempt of attempts)
      await insertVoucher(database, attempt.code);

    const results = await Promise.all(
      attempts.map((attempt) => voucherDb.reserveVoucher(attempt.code, sessionId, attempt.startTime)),
    );
    expect(results.filter(Boolean)).to.have.length(1);
    const winner = attempts[results.findIndex(Boolean)];
    const loser = attempts[results.findIndex((result) => !result)];
    expect(await voucherDb.reserveVoucher(winner.code, sessionId, winner.startTime)).to.equal(true);
    expect(await voucherDb.reserveVoucher(loser.code, sessionId, loser.startTime)).to.equal(false);
    expect(await voucherDb.consumeVoucher(winner.code, sessionId, PRIMARY_TARGET)).to.equal(true);
    expect(await voucherDb.reserveVoucher(loser.code, sessionId, loser.startTime)).to.equal(false);
    const ownedRows = await database.all(
      "SELECT Code FROM Vouchers WHERE SessionId = ?",
      [sessionId],
    ) as Array<Record<string, unknown>>;
    expect(ownedRows).to.deep.equal([{Code: winner.code}]);
  });

  it("Does not retry a SQLite error that only contains a deadlock phrase", async () => {
    const {voucherDb, database} = await startVoucherModule();
    const sessionId = "e28773fd-f22c-40f6-a68e-fb491c08f607";
    const startTime = 1700001250;
    await insertVoucher(database, "DEADLOSE");
    const originalRun = database.run.bind(database);
    const injectedError = new Error("ER_LOCK_DEADLOCK: Deadlock found when trying to get lock");
    let reservationAttempts = 0;
    sinon.stub(database, "run").callsFake(async (sql, values) => {
      if(
        String(sql).includes("UPDATE Vouchers SET SessionId = ?, TargetAddr = NULL, StartTime = ?")
        && Array.isArray(values)
        && values[2] === "DEADLOSE"
      ) {
        reservationAttempts++;
        throw injectedError;
      }
      return originalRun(sql, values);
    });

    let reservationError: unknown;
    try {
      await voucherDb.reserveVoucher("DEADLOSE", sessionId, startTime);
    } catch(error) {
      reservationError = error;
    }
    expect(reservationError).to.equal(injectedError);
    expect(reservationAttempts).to.equal(1);
    expect((await voucherDb.getVoucher("DEADLOSE") as IVoucher).state).to.equal(VoucherState.AVAILABLE);
  });

  it("Retries a structured MySQL deadlock only once", async () => {
    const persistedAvailableRow = {
      Code: "DEADMYSQL",
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
    const driver = {
      get: async () => persistedAvailableRow,
    } as unknown as BaseDriver;
    const codeError = Object.assign(new Error("first structured deadlock"), {
      code: "ER_LOCK_DEADLOCK",
    });
    const errnoError = Object.assign(new Error("second structured deadlock"), {
      errno: 1213,
    });
    const originalDriver = faucetConfig.database.driver;
    (faucetConfig.database as {driver: FaucetDbDriver}).driver = FaucetDbDriver.MYSQL;
    try {
      expect((VoucherDB as any).isReservationDeadlock(
        new Error("ER_LOCK_DEADLOCK: Deadlock found when trying to get lock"),
      )).to.equal(false);

      let successfulAttempts = 0;
      expect(await (VoucherDB as any).runReservationCas(
        driver,
        "DEADMYSQL",
        "6ff90160-fcd3-403b-b36c-b5962096c050",
        1700001251,
        async () => {
          successfulAttempts++;
          if(successfulAttempts === 1)
            throw codeError;
          return {changes: 1};
        },
      )).to.equal(true);
      expect(successfulAttempts).to.equal(2);

      let failedAttempts = 0;
      let secondFailure: unknown;
      try {
        await (VoucherDB as any).runReservationCas(
          driver,
          "DEADMYSQL",
          "d088ce52-a5d0-40ae-bfa3-83130fb6148c",
          1700001252,
          async () => {
            failedAttempts++;
            throw failedAttempts === 1 ? codeError : errnoError;
          },
        );
      } catch(error) {
        secondFailure = error;
      }
      expect(secondFailure).to.equal(errnoError);
      expect(failedAttempts).to.equal(2);
    } finally {
      (faucetConfig.database as {driver: FaucetDbDriver}).driver = originalDriver;
    }

    expect((VoucherDB as any).isReservationDeadlock(codeError)).to.equal(false);
  });

  it("Reconciles a committed reservation after its acknowledgement is lost", async () => {
    const {voucherDb, database} = await startVoucherModule();
    const sessionId = "91eab5ee-d51f-40d8-a82b-10cd854f1fa9";
    const startTime = 1700000100;
    await insertVoucher(database, "ACKLOSS1");
    const originalRun = database.run.bind(database);
    let loseAcknowledgement = true;
    const runStub = sinon.stub(database, "run").callsFake(async (sql, values) => {
      if(
        loseAcknowledgement
        && String(sql).includes("UPDATE Vouchers SET SessionId = ?, TargetAddr = NULL, StartTime = ?")
      ) {
        loseAcknowledgement = false;
        await originalRun(sql, values);
        throw new Error("injected reservation acknowledgement loss");
      }
      return originalRun(sql, values);
    });

    expect(await voucherDb.reserveVoucher("ACKLOSS1", sessionId, startTime)).to.equal(true);
    expect(await voucherDb.reserveVoucher("ACKLOSS1", sessionId, startTime)).to.equal(true);
    expect(await voucherDb.reserveVoucher("ACKLOSS1", sessionId, startTime + 1)).to.equal(false);
    expect(
      await voucherDb.reserveVoucher(
        "ACKLOSS1",
        "9a95b323-fe35-4a3e-ac9f-7daa6eb76ee4",
        startTime,
      ),
    ).to.equal(false);

    const reservationUpdates = runStub.getCalls().filter((call) => (
      String(call.args[0]).includes("UPDATE Vouchers SET SessionId = ?, TargetAddr = NULL, StartTime = ?")
    ));
    expect(reservationUpdates).to.have.length(1);
    const voucher = await voucherDb.getVoucher("ACKLOSS1") as IVoucher;
    expect(voucher.state).to.equal(VoucherState.LEASED);
    expect(voucher.sessionId).to.equal(sessionId);
    expect(voucher.startTime).to.equal(startTime);
  });

  it("Reconciles committed release and consume transitions after acknowledgement loss", async () => {
    const {voucherDb, database} = await startVoucherModule();
    const releaseOwner = "db55d375-eaa8-47ed-97dd-61e431c85511";
    await insertVoucher(database, "RELACK01");
    expect(await voucherDb.reserveVoucher("RELACK01", releaseOwner, 1700000150)).to.equal(true);

    const originalRun = database.run.bind(database);
    let loseReleaseAcknowledgement = true;
    let loseConsumeAcknowledgement = true;
    sinon.stub(database, "run").callsFake(async (sql, values) => {
      if(
        loseReleaseAcknowledgement
        && String(sql).startsWith(
          "UPDATE Vouchers SET SessionId = NULL, TargetAddr = NULL, StartTime = NULL",
        )
      ) {
        loseReleaseAcknowledgement = false;
        await originalRun(sql, values);
        throw new Error("injected release acknowledgement loss");
      }
      if(
        loseConsumeAcknowledgement
        && String(sql).startsWith("UPDATE Vouchers SET TargetAddr = ?")
      ) {
        loseConsumeAcknowledgement = false;
        await originalRun(sql, values);
        throw new Error("injected consume acknowledgement loss");
      }
      return originalRun(sql, values);
    });

    expect(await voucherDb.releaseVoucher("RELACK01", releaseOwner)).to.equal(true);
    expect((await voucherDb.getVoucher("RELACK01") as IVoucher).state).to.equal(VoucherState.AVAILABLE);

    await insertVoucher(database, "CONACK01", null, null, null, "");
    const session = await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: PRIMARY_TARGET,
      voucherCode: "CONACK01",
    });
    expect(session.getSessionStatus()).to.equal(FaucetSessionStatus.CLAIMABLE);
    const consumed = await voucherDb.getVoucher("CONACK01") as IVoucher;
    expect(consumed.state).to.equal(VoucherState.CONSUMED);
    expect(consumed.sessionId).to.equal(session.getSessionId());
    expect(consumed.targetAddr).to.equal(PRIMARY_TARGET);
    expect(loseReleaseAcknowledgement).to.equal(false);
    expect(loseConsumeAcknowledgement).to.equal(false);
  });

  it("Fails closed when transition acknowledgement reconciliation finds a divergent state", async () => {
    const {voucherDb, database} = await startVoucherModule();
    const oldOwner = "250b7d36-d3b9-4a77-936f-73ee3d2485c5";
    const newerOwner = "d7206240-8fbc-4559-8c39-992609465662";
    await insertVoucher(database, "RELDIVER1");
    expect(await voucherDb.reserveVoucher("RELDIVER1", oldOwner, 1700000160)).to.equal(true);
    const transitionError = new Error("injected divergent transition failure");
    const originalRun = database.run.bind(database);
    let injected = false;
    sinon.stub(database, "run").callsFake(async (sql, values) => {
      if(
        !injected
        && String(sql).startsWith(
          "UPDATE Vouchers SET SessionId = NULL, TargetAddr = NULL, StartTime = NULL",
        )
      ) {
        injected = true;
        await originalRun(
          "UPDATE Vouchers SET SessionId = ?, StartTime = ? WHERE Code = ? AND SessionId = ?",
          [newerOwner, 1700000161, "RELDIVER1", oldOwner],
        );
        throw transitionError;
      }
      return originalRun(sql, values);
    });

    let releaseError: unknown;
    try {
      await voucherDb.releaseVoucher("RELDIVER1", oldOwner);
    } catch(error) {
      releaseError = error;
    }
    expect(releaseError).to.equal(transitionError);
    const current = await voucherDb.getVoucher("RELDIVER1") as IVoucher;
    expect(current.state).to.equal(VoucherState.LEASED);
    expect(current.sessionId).to.equal(newerOwner);
  });

  it("Preserves transition and reconciliation errors when both fail", async () => {
    const {voucherDb, database} = await startVoucherModule();
    const sessionId = "1b7737e2-75c0-4cd3-ab1b-95042c6c0e93";
    await insertVoucher(database, "CONDUAL1");
    expect(await voucherDb.reserveVoucher("CONDUAL1", sessionId, 1700000165)).to.equal(true);
    const transitionError = new Error("injected consume transition failure");
    const reconciliationError = new Error("injected consume reconciliation failure");
    const originalRun = database.run.bind(database);
    sinon.stub(database, "run").callsFake(async (sql, values) => {
      if(String(sql).startsWith("UPDATE Vouchers SET TargetAddr = ?"))
        throw transitionError;
      return originalRun(sql, values);
    });
    const originalGet = database.get.bind(database);
    let snapshotReads = 0;
    sinon.stub(database, "get").callsFake(async (sql, values) => {
      if(String(sql).includes("CleanupDataHash") && String(sql).includes("DropAmount")) {
        snapshotReads++;
        if(snapshotReads === 2)
          throw reconciliationError;
      }
      return originalGet(sql, values);
    });

    let consumeError: unknown;
    try {
      await voucherDb.consumeVoucher("CONDUAL1", sessionId, PRIMARY_TARGET);
    } catch(error) {
      consumeError = error;
    }

    expect(consumeError).to.be.instanceOf(AggregateError);
    expect((consumeError as AggregateError).errors).to.deep.equal([
      transitionError,
      reconciliationError,
    ]);
  });

  it("Reconciles a zero-change reservation result from the exact persisted lease", async () => {
    const {voucherDb, database} = await startVoucherModule();
    const sessionId = "50594582-d717-4662-abcd-f9c12a4011e4";
    const startTime = 1700000200;
    await insertVoucher(database, "ZEROACK1");
    const originalRun = database.run.bind(database);
    let hideCommittedChange = true;
    sinon.stub(database, "run").callsFake(async (sql, values) => {
      if(
        hideCommittedChange
        && String(sql).includes("UPDATE Vouchers SET SessionId = ?, TargetAddr = NULL, StartTime = ?")
      ) {
        hideCommittedChange = false;
        const result = await originalRun(sql, values);
        return {...result, changes: 0};
      }
      return originalRun(sql, values);
    });

    expect(await voucherDb.reserveVoucher("ZEROACK1", sessionId, startTime)).to.equal(true);
    const voucher = await voucherDb.getVoucher("ZEROACK1") as IVoucher;
    expect(voucher.state).to.equal(VoucherState.LEASED);
    expect(voucher.sessionId).to.equal(sessionId);
    expect(voucher.startTime).to.equal(startTime);
  });

  it("Preserves reservation and reconciliation errors when both operations fail", async () => {
    const {voucherDb, database} = await startVoucherModule();
    await insertVoucher(database, "DUALFAIL1");
    const updateError = new Error("injected reservation update failure");
    const reconciliationError = new Error("injected reservation reconciliation failure");
    const originalRun = database.run.bind(database);
    sinon.stub(database, "run").callsFake(async (sql, values) => {
      if(String(sql).includes("UPDATE Vouchers SET SessionId = ?, TargetAddr = NULL, StartTime = ?"))
        throw updateError;
      return originalRun(sql, values);
    });
    const originalGet = database.get.bind(database);
    let reservationReads = 0;
    sinon.stub(database, "get").callsFake(async (sql, values) => {
      if(String(sql).includes("CleanupDataHash") && String(sql).includes("DropAmount")) {
        reservationReads++;
        if(reservationReads === 2)
          throw reconciliationError;
      }
      return originalGet(sql, values);
    });

    let reservationError: unknown;
    try {
      await voucherDb.reserveVoucher(
        "DUALFAIL1",
        "9fac3637-2eb4-4cfe-b904-337649830e62",
        1700000300,
      );
    } catch(error) {
      reservationError = error;
    }

    expect(reservationError).to.be.instanceOf(AggregateError);
    expect((reservationError as AggregateError).errors).to.deep.equal([
      updateError,
      reconciliationError,
    ]);
    expect((await voucherDb.getVoucher("DUALFAIL1") as IVoucher).state).to.equal(VoucherState.AVAILABLE);
  });

  it("Releases a reservation when another same-priority start hook fails", async () => {
    const {voucherDb, database} = await startVoucherModule();
    const moduleManager = ServiceManager.GetService(ModuleManager);
    await insertVoucher(database, "PEERFAIL1", null, null, null, "");
    let failedSessionId: string;
    moduleManager.addActionHook(
      null,
      ModuleHookAction.SessionStart,
      2,
      "same-priority injected failure",
      (session: FaucetSession) => {
        failedSessionId = session.getSessionId();
        throw new Error("same-priority failure");
      },
    );

    let startError: unknown;
    try {
      await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
        addr: PRIMARY_TARGET,
        voucherCode: "PEERFAIL1",
      });
    } catch(ex) {
      startError = ex;
    }

    expect(String(startError)).to.include("same-priority failure");
    const voucher = await voucherDb.getVoucher("PEERFAIL1") as IVoucher;
    expect(voucher.state).to.equal(VoucherState.AVAILABLE);
    expect(voucher.sessionId).to.equal(null);
    expect(await ServiceManager.GetService(FaucetDatabase).getSession(failedSessionId)).to.equal(null);
  });

  it("Releases a reservation when later voucher work fails", async () => {
    const {voucherDb, database} = await startVoucherModule();
    await insertVoucher(database, "POSTFAIL1");
    sinon.stub(FaucetSession.prototype, "setDropAmount").rejects(new Error("post-reservation failure"));

    let startError: unknown;
    try {
      await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
        addr: PRIMARY_TARGET,
        voucherCode: "POSTFAIL1",
      });
    } catch(ex) {
      startError = ex;
    }

    expect(String(startError)).to.include("post-reservation failure");
    const voucher = await voucherDb.getVoucher("POSTFAIL1") as IVoucher;
    expect(voucher.state).to.equal(VoucherState.AVAILABLE);
    expect(voucher.sessionId).to.equal(null);
  });

  it("Releases a reservation when rollback registration fails", async () => {
    const {voucherDb, database} = await startVoucherModule();
    await insertVoucher(database, "REGFAIL1", null, null, null, "");
    sinon.stub(FaucetSession.prototype, "registerStartRollback").throws(new Error("registration failure"));

    let startError: unknown;
    try {
      await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
        addr: PRIMARY_TARGET,
        voucherCode: "REGFAIL1",
      });
    } catch(ex) {
      startError = ex;
    }

    expect(String(startError)).to.include("registration failure");
    const voucher = await voucherDb.getVoucher("REGFAIL1") as IVoucher;
    expect(voucher.state).to.equal(VoucherState.AVAILABLE);
    expect(voucher.sessionId).to.equal(null);
  });

  it("Does not let an old rollback clear a newer voucher owner", async () => {
    const {voucherDb, database} = await startVoucherModule();
    const oldSessionId = "8cb93331-eddb-4342-a7b8-3588945e5ed1";
    const newSessionId = "cf4e9012-bad7-4550-b075-961b96fd5a9b";
    await insertVoucher(database, "CASOWNER1");
    expect(await voucherDb.reserveVoucher("CASOWNER1", oldSessionId, 100)).to.equal(true);
    await ServiceManager.GetService(FaucetDatabase).updateSession(
      storedSession(oldSessionId, FaucetSessionStatus.FAILED, PRIMARY_TARGET, 100, "CASOWNER1"),
    );
    expect(await voucherDb.reserveVoucher("CASOWNER1", newSessionId, 200)).to.equal(true);

    expect(await voucherDb.releaseVoucher("CASOWNER1", oldSessionId)).to.equal(false);
    const voucher = await voucherDb.getVoucher("CASOWNER1") as IVoucher;
    expect(voucher.state).to.equal(VoucherState.LEASED);
    expect(voucher.sessionId).to.equal(newSessionId);
  });

  it("Rejects contradictory, fractional, unsafe, and invalid-target voucher tuples", async () => {
    const {voucherDb, database} = await startVoucherModule();
    const invalidRows: Array<{
      code: string;
      sessionId: string | null;
      targetAddr: string | null;
      startTime: number | null;
    }> = [
      {code: "BADAVAIL1", sessionId: null, targetAddr: null, startTime: 100},
      {code: "BADCOMBO1", sessionId: null, targetAddr: PRIMARY_TARGET, startTime: null},
      {code: "BADEMPTY1", sessionId: "", targetAddr: null, startTime: 100},
      {code: "BADLEASE1", sessionId: "fractional-owner", targetAddr: null, startTime: 100.5},
      {
        code: "BADSAFE01",
        sessionId: "unsafe-owner",
        targetAddr: null,
        startTime: Number.MAX_SAFE_INTEGER + 1,
      },
      {code: "BADTIME01", sessionId: "missing-time-owner", targetAddr: null, startTime: null},
      {code: "BADTARGET", sessionId: "consumed-owner", targetAddr: "not-an-address", startTime: 100},
      {
        code: "BADZERO01",
        sessionId: "zero-target-owner",
        targetAddr: "0x0000000000000000000000000000000000000000",
        startTime: 100,
      },
    ];

    for(const row of invalidRows) {
      await insertVoucher(database, row.code, row.sessionId, row.targetAddr, row.startTime);
      let decodeError: unknown;
      try {
        await voucherDb.getVoucher(row.code);
      } catch(ex) {
        decodeError = ex;
      }
      expect(decodeError).to.be.instanceOf(Error, `accepted invalid row ${row.code}`);
      expect(String(decodeError)).to.not.include(row.code);
    }
  });

  it("Releases and reuses a consumed voucher after a priority-5 peer completion hook fails", async () => {
    faucetConfig.sessionCleanup = -1;
    const {voucherDb, database} = await startVoucherModule();
    const moduleManager = ServiceManager.GetService(ModuleManager);
    await insertVoucher(database, "CONSUMED1", null, null, null, "");
    let shouldFail = true;
    let failedSessionId = "";
    moduleManager.addActionHook(
      null,
      ModuleHookAction.SessionComplete,
      5,
      "same-priority completion failure",
      (session: FaucetSession) => {
        failedSessionId = session.getSessionId();
        if(shouldFail)
          throw new Error("same-priority completion failure");
      },
    );

    let completionError: unknown;
    try {
      await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
        addr: PRIMARY_TARGET,
        voucherCode: "CONSUMED1",
      });
    } catch(ex) {
      completionError = ex;
    }

    expect(String(completionError)).to.include("same-priority completion failure");
    const failedSession = await ServiceManager.GetService(FaucetDatabase).getSession(failedSessionId);
    expect(failedSession.status).to.equal(FaucetSessionStatus.FAILED);
    expect(failedSession.data.voucherCode).to.equal("CONSUMED1");
    const consumed = await voucherDb.getVoucher("CONSUMED1") as IVoucher;
    expect(consumed.state).to.equal(VoucherState.CONSUMED);
    expect(consumed.sessionId).to.equal(failedSessionId);
    expect(consumed.targetAddr).to.equal(PRIMARY_TARGET);

    shouldFail = false;
    await ServiceManager.GetService(FaucetDatabase).cleanStore();
    expect(await ServiceManager.GetService(FaucetDatabase).getSession(failedSessionId)).to.equal(null);
    expect((await voucherDb.getVoucher("CONSUMED1") as IVoucher).state).to.equal(VoucherState.AVAILABLE);

    const reused = await ServiceManager.GetService(SessionManager).createSession("8.8.8.9", {
      addr: SECONDARY_TARGET,
      voucherCode: "CONSUMED1",
    });
    expect(reused.getSessionStatus()).to.equal(FaucetSessionStatus.CLAIMABLE);
    const reusedVoucher = await voucherDb.getVoucher("CONSUMED1") as IVoucher;
    expect(reusedVoucher.state).to.equal(VoucherState.CONSUMED);
    expect(reusedVoucher.sessionId).to.equal(reused.getSessionId());
    expect(reusedVoucher.targetAddr).to.equal(SECONDARY_TARGET);
  });

  it("Reconciles only orphaned leases after running sessions restore", async () => {
    faucetConfig.modules["voucher"] = {enabled: true} as IVoucherConfig;
    const moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    const voucherModule = moduleManager.getModule<VoucherModule>("voucher");
    const voucherDb = (voucherModule as any).voucherDb as VoucherDB;
    const database = (voucherDb as any).db as BaseDriver;
    const now = Math.floor(Date.now() / 1000);
    const runningSessionId = "430b31fa-ce23-414d-935b-b669983d61a7";
    const failedSessionId = "ec46d209-5166-40a2-acf6-d674f913bf7a";
    const consumedSessionId = "ec8b01f0-8ddd-4f4d-8436-4fa80c97f0b4";
    const running = storedSession(runningSessionId, FaucetSessionStatus.RUNNING, PRIMARY_TARGET, now);
    running.tasks = [{module: "test", name: "hold", timeout: now + 600}];
    await ServiceManager.GetService(FaucetDatabase).updateSession(running);
    await ServiceManager.GetService(FaucetDatabase).updateSession(
      storedSession(failedSessionId, FaucetSessionStatus.FAILED, SECONDARY_TARGET, now),
    );
    await insertVoucher(database, "ORPHAN01", "missing-session", null, now);
    await insertVoucher(database, "RUNNING01", runningSessionId, null, now);
    await insertVoucher(database, "FAILED01", failedSessionId, null, now);
    await insertVoucher(database, "CONSUMED2", consumedSessionId, SECONDARY_TARGET, now);

    await ServiceManager.GetService(SessionManager).initialize();
    await moduleManager.activateModulesAfterStateRestore();

    const orphan = await voucherDb.getVoucher("ORPHAN01") as IVoucher;
    const runningVoucher = await voucherDb.getVoucher("RUNNING01") as IVoucher;
    const failedVoucher = await voucherDb.getVoucher("FAILED01") as IVoucher;
    const consumed = await voucherDb.getVoucher("CONSUMED2") as IVoucher;
    expect(orphan.state).to.equal(VoucherState.AVAILABLE);
    expect(orphan.sessionId).to.equal(null);
    expect(runningVoucher.state).to.equal(VoucherState.LEASED);
    expect(runningVoucher.sessionId).to.equal(runningSessionId);
    expect(failedVoucher.state).to.equal(VoucherState.LEASED);
    expect(failedVoucher.sessionId).to.equal(failedSessionId);
    expect(consumed.state).to.equal(VoucherState.CONSUMED);
    expect(consumed.sessionId).to.equal(consumedSessionId);
    expect(consumed.targetAddr).to.equal(SECONDARY_TARGET);
  });

  it("Reconciles orphaned leases on the first enable after a disabled boot", async () => {
    const moduleManager = ServiceManager.GetService(ModuleManager);
    faucetConfig.modules["voucher"] = {enabled: true} as IVoucherConfig;
    await moduleManager.initialize();
    const installedModule = moduleManager.getModule<VoucherModule>("voucher");
    const installedVoucherDb = (installedModule as any).voucherDb as VoucherDB;
    const database = (installedVoucherDb as any).db as BaseDriver;
    await insertVoucher(database, "LATEBOOT1", "missing-before-enable", null, 100);
    await moduleManager.dispose();

    faucetConfig.modules["voucher"] = {enabled: false} as IVoucherConfig;
    await moduleManager.initialize();
    await ServiceManager.GetService(SessionManager).initialize();
    await moduleManager.activateModulesAfterStateRestore();
    expect((await installedVoucherDb.getVoucher("LATEBOOT1") as IVoucher).state).to.equal(VoucherState.LEASED);

    faucetConfig.modules["voucher"] = {enabled: true} as IVoucherConfig;
    ServiceManager.GetService(FaucetProcess).emit("reload");
    await moduleManager.getLoadingPromise();

    const enabledModule = moduleManager.getModule<VoucherModule>("voucher");
    const enabledVoucherDb = (enabledModule as any).voucherDb as VoucherDB;
    const reconciled = await enabledVoucherDb.getVoucher("LATEBOOT1") as IVoucher;
    expect(reconciled.state).to.equal(VoucherState.AVAILABLE);
    expect(reconciled.sessionId).to.equal(null);
  });

  it("Retries one failed reconciliation and retains the successful shared promise", async () => {
    faucetConfig.modules["voucher"] = {enabled: true} as IVoucherConfig;
    const moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    const voucherModule = moduleManager.getModule<VoucherModule>("voucher");
    const voucherDb = (voucherModule as any).voucherDb as VoucherDB;
    const reconcileStub = sinon.stub(voucherDb, "reconcileOrphanedLeases");
    reconcileStub.onFirstCall().rejects(new Error("injected reconciliation failure"));
    reconcileStub.onSecondCall().resolves(0);

    let firstError: unknown;
    try {
      await (voucherModule as any).onStateRestoreComplete();
    } catch(error) {
      firstError = error;
    }
    expect(String(firstError)).to.include("injected reconciliation failure");

    await Promise.all([
      (voucherModule as any).onStateRestoreComplete(),
      (voucherModule as any).onStateRestoreComplete(),
    ]);
    await (voucherModule as any).onStateRestoreComplete();

    expect(reconcileStub.callCount).to.equal(2);
  });

  it("Does not reconcile a paused pre-insert lease again after disable and re-enable", async () => {
    faucetConfig.modules["voucher"] = {enabled: true} as IVoucherConfig;
    const moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    await ServiceManager.GetService(SessionManager).initialize();
    await moduleManager.activateModulesAfterStateRestore();
    const initialModule = moduleManager.getModule<VoucherModule>("voucher");
    const initialVoucherDb = (initialModule as any).voucherDb as VoucherDB;
    const database = (initialVoucherDb as any).db as BaseDriver;
    await insertVoucher(database, "HOTLEASE1");

    let signalPaused!: (sessionId: string) => void;
    const paused = new Promise<string>((resolve) => {
      signalPaused = resolve;
    });
    let resumeStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      resumeStart = resolve;
    });
    const originalSetDropAmount = FaucetSession.prototype.setDropAmount;
    sinon.stub(FaucetSession.prototype, "setDropAmount").callsFake(async function(
      this: FaucetSession,
      amount: bigint,
    ): Promise<bigint> {
      signalPaused(this.getSessionId());
      await startGate;
      return originalSetDropAmount.call(this, amount);
    });

    const startPromise = ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
      addr: PRIMARY_TARGET,
      voucherCode: "HOTLEASE1",
    });
    const pausedSessionId = await paused;
    let beforeReload: IVoucher | null = null;
    let afterReload: IVoucher | null = null;
    let durableBeforeReload: FaucetSessionStoreData | null = null;
    let reloadError: unknown;
    try {
      beforeReload = await initialVoucherDb.getVoucher("HOTLEASE1");
      durableBeforeReload = await ServiceManager.GetService(FaucetDatabase).getSession(pausedSessionId);

      faucetConfig.modules["voucher"] = {enabled: false} as IVoucherConfig;
      ServiceManager.GetService(FaucetProcess).emit("reload");
      await moduleManager.getLoadingPromise();
      faucetConfig.modules["voucher"] = {enabled: true} as IVoucherConfig;
      ServiceManager.GetService(FaucetProcess).emit("reload");
      await moduleManager.getLoadingPromise();

      const reloadedModule = moduleManager.getModule<VoucherModule>("voucher");
      const reloadedVoucherDb = (reloadedModule as any).voucherDb as VoucherDB;
      afterReload = await reloadedVoucherDb.getVoucher("HOTLEASE1");
    } catch(ex) {
      reloadError = ex;
    } finally {
      resumeStart();
    }

    let session: FaucetSession | null = null;
    let startError: unknown;
    try {
      session = await startPromise;
    } catch(ex) {
      startError = ex;
    }
    if(reloadError)
      throw reloadError;
    if(startError)
      throw startError;

    expect(durableBeforeReload).to.equal(null);
    expect(beforeReload?.state).to.equal(VoucherState.LEASED);
    expect(beforeReload?.sessionId).to.equal(pausedSessionId);
    expect(afterReload?.state).to.equal(VoucherState.LEASED);
    expect(afterReload?.sessionId).to.equal(pausedSessionId);
    expect(session?.getSessionStatus()).to.equal(FaucetSessionStatus.CLAIMABLE);
    const completed = await initialVoucherDb.getVoucher("HOTLEASE1") as IVoucher;
    expect(completed.state).to.equal(VoucherState.CONSUMED);
    expect(completed.sessionId).to.equal(pausedSessionId);
    expect(completed.targetAddr).to.equal(PRIMARY_TARGET);
  });

  it("Uses the cleanup candidate data snapshot instead of rereading a changed session", async () => {
    const {voucherDb, database} = await startVoucherModule();
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const sessionId = "17cf7006-a334-4055-b1b3-e0a91ef21c99";
    const startTime = Math.floor(Date.now() / 1000) - 60;
    const dataJson = JSON.stringify({voucherCode: "SNAPSHOT1"});
    await databaseService.updateSession(
      storedSession(sessionId, FaucetSessionStatus.FAILED, PRIMARY_TARGET, startTime, "SNAPSHOT1"),
    );
    await insertVoucher(database, "SNAPSHOT1", sessionId, PRIMARY_TARGET, startTime);
    const candidate: SessionCleanupCandidate = {
      sessionId,
      status: FaucetSessionStatus.FAILED,
      startTime,
      targetAddr: PRIMARY_TARGET,
      dataJson,
      claimDataJson: null,
      claim: null,
    };
    await database.run(
      "UPDATE Sessions SET Data = ? WHERE SessionId = ?",
      ['{ "voucherCode": "SNAPSHOT1" }', sessionId],
    );

    expect(await VoucherDB.prepareSessionCleanup(databaseService, candidate)).to.equal(false);
    const voucher = await voucherDb.getVoucher("SNAPSHOT1") as IVoucher;
    expect(voucher.state).to.equal(VoucherState.CONSUMED);
    expect(voucher.sessionId).to.equal(sessionId);
    expect(voucher.targetAddr).to.equal(PRIMARY_TARGET);
  });

  it("Retains sessions whose data or target changes between cleanup guards and delete", async () => {
    faucetConfig.sessionCleanup = 10;
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const database = databaseService.getDatabase();
    const startTime = Math.floor(Date.now() / 1000) - 60;
    const dataSessionId = "c9917aa3-49d5-4302-be47-9d2cb47bb199";
    const targetSessionId = "2df68d6f-311a-410a-b464-d5c949133112";
    await databaseService.updateSession(
      storedSession(dataSessionId, FaucetSessionStatus.FAILED, PRIMARY_TARGET, startTime),
    );
    await databaseService.updateSession(
      storedSession(targetSessionId, FaucetSessionStatus.FAILED, PRIMARY_TARGET, startTime),
    );
    const changedData = '{ "changed": true }';
    databaseService.registerSessionCleanupGuard("snapshot mutation test", async (candidate) => {
      expect(candidate.dataJson).to.equal("{}");
      expect(candidate.claimDataJson).to.equal(null);
      if(candidate.sessionId === dataSessionId) {
        await database.run(
          "UPDATE Sessions SET Data = ? WHERE SessionId = ?",
          [changedData, candidate.sessionId],
        );
      } else if(candidate.sessionId === targetSessionId) {
        expect(candidate.targetAddr).to.equal(PRIMARY_TARGET);
        await database.run(
          "UPDATE Sessions SET TargetAddr = ? WHERE SessionId = ?",
          [SECONDARY_TARGET, candidate.sessionId],
        );
      }
      return true;
    });

    await databaseService.cleanStore();

    const dataRow = await database.get(
      "SELECT Data FROM Sessions WHERE SessionId = ?",
      [dataSessionId],
    ) as Record<string, unknown>;
    const targetRow = await database.get(
      "SELECT TargetAddr FROM Sessions WHERE SessionId = ?",
      [targetSessionId],
    ) as Record<string, unknown>;
    expect(dataRow.Data).to.equal(changedData);
    expect(targetRow.TargetAddr).to.equal(SECONDARY_TARGET);
  });

  it("Releases failed-session vouchers with exact failed or reverted ClaimData", async () => {
    const {voucherDb, database} = await startVoucherModule();
    faucetConfig.sessionCleanup = 10;
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const fixtures = [
      {
        code: "CLEANCLM1",
        sessionId: "2ba30707-3bc7-4571-8f9f-0e441cf09f21",
        claim: claimData(ClaimTxStatus.FAILED),
      },
      {
        code: "CLEANCLM2",
        sessionId: "ff94be34-2477-4f22-8077-fe9582b3c03a",
        claim: claimData(ClaimTxStatus.REVERTED),
      },
    ];

    for(const [index, fixture] of fixtures.entries()) {
      const startTime = Math.floor(Date.now() / 1000) - 60 - index;
      await databaseService.updateSession(
        storedSession(
          fixture.sessionId,
          FaucetSessionStatus.FAILED,
          PRIMARY_TARGET,
          startTime,
          fixture.code,
          fixture.claim,
        ),
      );
      await insertVoucher(database, fixture.code, fixture.sessionId, PRIMARY_TARGET, startTime);

      await databaseService.cleanStore();

      expect(await databaseService.getSession(fixture.sessionId)).to.equal(null);
      expect((await voucherDb.getVoucher(fixture.code) as IVoucher).state).to.equal(VoucherState.AVAILABLE);
      const receipt = await database.get(
        "SELECT CleanupClaimDataHash FROM Vouchers WHERE Code = ?",
        [fixture.code],
      ) as Record<string, unknown>;
      expect(receipt.CleanupClaimDataHash).to.equal(
        cleanupClaimDataHash(JSON.stringify(fixture.claim)),
      );
    }
  });

  it("Rejects failed cleanup with confirmed, pending, or malformed ClaimData", async () => {
    const {database} = await startVoucherModule();
    faucetConfig.sessionCleanup = 10;
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const fixtures: Array<{
      code: string;
      sessionId: string;
      claim: EthClaimData | "malformed";
    }> = [
      {
        code: "BADCLM001",
        sessionId: "55971803-e2df-418c-9e88-4c1e2bc01af0",
        claim: claimData(ClaimTxStatus.CONFIRMED),
      },
      {
        code: "BADCLM002",
        sessionId: "70f5a957-29f2-4e9f-9494-2501253178b7",
        claim: claimData(ClaimTxStatus.PENDING),
      },
      {
        code: "BADCLM003",
        sessionId: "691a4b7b-3f60-4ed3-ac3c-16b9297d50cb",
        claim: "malformed",
      },
    ];

    for(const [index, fixture] of fixtures.entries()) {
      const startTime = Math.floor(Date.now() / 1000) - 60 - index;
      const storedClaim = fixture.claim === "malformed" ? null : fixture.claim;
      await databaseService.updateSession(
        storedSession(
          fixture.sessionId,
          FaucetSessionStatus.FAILED,
          PRIMARY_TARGET,
          startTime,
          fixture.code,
          storedClaim,
        ),
      );
      if(fixture.claim === "malformed") {
        await database.run(
          "UPDATE Sessions SET ClaimData = ? WHERE SessionId = ?",
          ["{", fixture.sessionId],
        );
      }
      await insertVoucher(database, fixture.code, fixture.sessionId, PRIMARY_TARGET, startTime);
      const before = await database.get("SELECT * FROM Vouchers WHERE Code = ?", [fixture.code]);

      await databaseService.cleanStore();

      expect(await database.get(
        "SELECT SessionId FROM Sessions WHERE SessionId = ?",
        [fixture.sessionId],
      )).to.not.equal(null);
      expect(await database.get("SELECT * FROM Vouchers WHERE Code = ?", [fixture.code])).to.deep.equal(before);
    }
  });

  it("Rejects failed cleanup if ClaimData changes during the voucher CAS", async () => {
    const {voucherDb, database} = await startVoucherModule();
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const sessionId = "96e30179-2409-40c2-aee6-1579e33e2f5c";
    const startTime = Math.floor(Date.now() / 1000) - 60;
    const initialClaim = claimData(ClaimTxStatus.FAILED);
    const candidate = storedSession(
      sessionId,
      FaucetSessionStatus.FAILED,
      PRIMARY_TARGET,
      startTime,
      "CLMCLEAN1",
      initialClaim,
    );
    await databaseService.updateSession(candidate);
    await insertVoucher(database, "CLMCLEAN1", sessionId, PRIMARY_TARGET, startTime);
    const before = await database.get("SELECT * FROM Vouchers WHERE Code = ?", ["CLMCLEAN1"]);
    const originalRun = database.run.bind(database);
    let mutateClaim = true;
    sinon.stub(database, "run").callsFake(async (sql, values) => {
      if(
        mutateClaim
        && String(sql).includes("UPDATE Vouchers SET SessionId = NULL")
        && String(sql).includes("CleanupClaimDataHash")
      ) {
        mutateClaim = false;
        await originalRun(
          "UPDATE Sessions SET ClaimData = ? WHERE SessionId = ?",
          [JSON.stringify(claimData(ClaimTxStatus.REVERTED)), sessionId],
        );
      }
      return originalRun(sql, values);
    });
    const cleanupCandidate: SessionCleanupCandidate = {
      sessionId,
      status: FaucetSessionStatus.FAILED,
      startTime,
      targetAddr: PRIMARY_TARGET,
      dataJson: JSON.stringify({voucherCode: "CLMCLEAN1"}),
      claimDataJson: JSON.stringify(initialClaim),
      claim: initialClaim,
    };

    expect(await VoucherDB.prepareSessionCleanup(databaseService, cleanupCandidate)).to.equal(false);
    expect(await database.get("SELECT * FROM Vouchers WHERE Code = ?", ["CLMCLEAN1"])).to.deep.equal(before);
    expect((await voucherDb.getVoucher("CLMCLEAN1") as IVoucher).state).to.equal(VoucherState.CONSUMED);
  });

  it("Reads each voucher and cleanup receipt from one row snapshot", async () => {
    const {database} = await startVoucherModule();
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const getSpy = sinon.spy(database, "get");
    const snapshotReadCount = (): number => getSpy.getCalls().filter((call) => {
      const sql = String(call.args[0]).replace(/\s+/g, " ");
      return sql.includes("SELECT Code, DropAmount, SessionId, TargetAddr, StartTime,")
        && sql.includes("CleanupVoucherCode")
        && sql.includes("FROM Vouchers WHERE Code = ?");
    }).length;
    const receiptOnlyReadCount = (): number => getSpy.getCalls().filter((call) => (
      String(call.args[0]).replace(/\s+/g, " ").includes("SELECT Code, CleanupVoucherCode")
    )).length;
    const fixtures = [
      {
        code: "SNAPFAIL1",
        sessionId: "c020a29b-1976-4b3d-afc8-c9d4af17836c",
        status: FaucetSessionStatus.FAILED,
        voucherTarget: PRIMARY_TARGET,
      },
      {
        code: "SNAPLEASE",
        sessionId: "d04ddf86-70cf-460f-b25d-83604ce49093",
        status: FaucetSessionStatus.FINISHED,
        voucherTarget: null,
      },
      {
        code: "SNAPCONSM",
        sessionId: "ea3bdf4c-e302-4b8b-a890-e8f0f1e0c155",
        status: FaucetSessionStatus.FINISHED,
        voucherTarget: PRIMARY_TARGET,
      },
    ];

    for(const [index, fixture] of fixtures.entries()) {
      const startTime = Math.floor(Date.now() / 1000) - 60 - index;
      const session = storedSession(
        fixture.sessionId,
        fixture.status,
        PRIMARY_TARGET,
        startTime,
        fixture.code,
      );
      await databaseService.updateSession(session);
      await insertVoucher(
        database,
        fixture.code,
        fixture.sessionId,
        fixture.voucherTarget,
        startTime,
      );
      const candidate: SessionCleanupCandidate = {
        sessionId: fixture.sessionId,
        status: fixture.status,
        startTime,
        targetAddr: PRIMARY_TARGET,
        dataJson: JSON.stringify({voucherCode: fixture.code}),
        claimDataJson: null,
        claim: null,
      };

      getSpy.resetHistory();
      expect(await VoucherDB.prepareSessionCleanup(databaseService, candidate), fixture.code).to.equal(true);
      expect(snapshotReadCount(), fixture.code).to.equal(2);
      expect(receiptOnlyReadCount(), fixture.code).to.equal(0);

      getSpy.resetHistory();
      expect(await VoucherDB.prepareSessionCleanup(databaseService, candidate), fixture.code).to.equal(true);
      expect(snapshotReadCount(), fixture.code).to.equal(1);
      expect(receiptOnlyReadCount(), fixture.code).to.equal(0);
    }
  });

  it("Releases a failed session lease before deleting the session", async () => {
    faucetConfig.sessionCleanup = 10;
    const {voucherDb, database} = await startVoucherModule();
    const sessionId = "3032951c-566d-4adb-81b9-5bd5b9d223c0";
    const startTime = Math.floor(Date.now() / 1000) - 60;
    await ServiceManager.GetService(FaucetDatabase).updateSession(
      storedSession(sessionId, FaucetSessionStatus.FAILED, PRIMARY_TARGET, startTime, "CLEANFAIL"),
    );
    await insertVoucher(database, "CLEANFAIL", sessionId, null, startTime);
    const runSpy = sinon.spy(database, "run");

    await ServiceManager.GetService(FaucetDatabase).cleanStore();

    const statements = runSpy.getCalls().map((call) => String(call.args[0]));
    const releaseIndex = statements.findIndex((sql) => sql.includes("UPDATE Vouchers SET SessionId = NULL"));
    const deleteIndex = statements.findIndex((sql) => sql.includes("DELETE FROM Sessions"));
    expect(releaseIndex).to.be.greaterThan(-1);
    expect(deleteIndex).to.be.greaterThan(releaseIndex);
    expect(await ServiceManager.GetService(FaucetDatabase).getSession(sessionId)).to.equal(null);
    expect((await voucherDb.getVoucher("CLEANFAIL") as IVoucher).state).to.equal(VoucherState.AVAILABLE);
  });

  it("Replays a committed session delete and admits only one concurrent receipt recovery", async () => {
    faucetConfig.sessionCleanup = 10;
    const {voucherDb, database} = await startVoucherModule();
    const sessionId = "3d53a3e5-bfc8-4a36-bcc0-c1cfc613c62f";
    const racingSessionIds = [
      "740cfed5-232c-45bb-8ed7-d622c592f21c",
      "f70bed7f-7454-43b5-856c-0ab575f8daa1",
    ];
    const startTime = Math.floor(Date.now() / 1000) - 60;
    await ServiceManager.GetService(FaucetDatabase).updateSession(
      storedSession(sessionId, FaucetSessionStatus.FAILED, PRIMARY_TARGET, startTime, "REPLAY001"),
    );
    await insertVoucher(database, "REPLAY001", sessionId, PRIMARY_TARGET, startTime);

    let signalDelete!: () => void;
    const deleteReached = new Promise<void>((resolve) => {
      signalDelete = resolve;
    });
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let rejectDelete = true;
    const originalRun = database.run.bind(database);
    sinon.stub(database, "run").callsFake(async (sql, values) => {
      if(rejectDelete && String(sql).includes("DELETE FROM Sessions")) {
        rejectDelete = false;
        await originalRun(sql, values);
        signalDelete();
        await deleteGate;
        throw new Error("injected session delete acknowledgement loss");
      }
      return originalRun(sql, values);
    });

    const firstCleanup = ServiceManager.GetService(FaucetDatabase).cleanStore().then(
      () => null,
      (error: unknown) => error,
    );
    await deleteReached;
    const transitioned = await voucherDb.getVoucher("REPLAY001") as IVoucher;
    const receipt = await database.get([
      "SELECT CleanupVoucherCode, CleanupSessionId, CleanupStartTime,",
      "CleanupTargetAddr, CleanupStatus, CleanupExpectedState, CleanupDataHash,",
      "CleanupClaimDataHash",
      "FROM Vouchers WHERE Code = ?",
    ].join(" "), ["REPLAY001"]) as Record<string, unknown>;
    const persistedSession = await database.get(
      "SELECT Data, ClaimData FROM Sessions WHERE SessionId = ?",
      [sessionId],
    );
    let racingReservations: boolean[];
    try {
      racingReservations = await Promise.all(racingSessionIds.map((racingSessionId, index) => (
        voucherDb.reserveVoucher("REPLAY001", racingSessionId, startTime + 1 + index)
      )));
    } finally {
      releaseDelete();
    }
    const firstCleanupError = await firstCleanup;

    expect(firstCleanupError).to.equal(null);
    expect(transitioned.state).to.equal(VoucherState.AVAILABLE);
    expect(receipt.CleanupVoucherCode).to.equal("REPLAY001");
    expect(receipt.CleanupSessionId).to.equal(sessionId);
    expect(receipt.CleanupStartTime).to.equal(startTime);
    expect(receipt.CleanupTargetAddr).to.equal(PRIMARY_TARGET);
    expect(receipt.CleanupStatus).to.equal(FaucetSessionStatus.FAILED);
    expect(receipt.CleanupExpectedState).to.equal(VoucherState.CONSUMED);
    expect(receipt.CleanupDataHash).to.equal(
      createHash("sha256").update(JSON.stringify({voucherCode: "REPLAY001"})).digest("hex"),
    );
    expect(receipt.CleanupClaimDataHash).to.equal(cleanupClaimDataHash(null));
    expect(persistedSession).to.equal(null);
    expect(racingReservations.filter(Boolean)).to.have.length(1);
    expect(await ServiceManager.GetService(FaucetDatabase).getSession(sessionId)).to.equal(null);
    const racingOwner = await voucherDb.getVoucher("REPLAY001") as IVoucher;
    expect(racingOwner.state).to.equal(VoucherState.LEASED);
    const winnerIndex = racingReservations.findIndex(Boolean);
    expect(racingOwner.sessionId).to.equal(racingSessionIds[winnerIndex]);
    expect(racingOwner.startTime).to.equal(startTime + 1 + winnerIndex);
    const clearedReceipt = await database.get([
      "SELECT CleanupVoucherCode, CleanupSessionId, CleanupStartTime, CleanupTargetAddr,",
      "CleanupStatus, CleanupExpectedState, CleanupDataHash, CleanupClaimDataHash",
      "FROM Vouchers WHERE Code = ?",
    ].join(" "), ["REPLAY001"]) as Record<string, unknown>;
    expect(Object.values(clearedReceipt).every((value) => value === null)).to.equal(true);

    await ServiceManager.GetService(FaucetDatabase).updateSession(
      storedSession(sessionId, FaucetSessionStatus.FAILED, PRIMARY_TARGET, startTime, "REPLAY001"),
    );
    await ServiceManager.GetService(FaucetDatabase).cleanStore();
    expect(await ServiceManager.GetService(FaucetDatabase).getSession(sessionId)).to.not.equal(null);
    const ownerAfterReplay = await voucherDb.getVoucher("REPLAY001") as IVoucher;
    expect(ownerAfterReplay.state).to.equal(VoucherState.LEASED);
    expect(ownerAfterReplay.sessionId).to.equal(racingSessionIds[winnerIndex]);
  });

  it("Retains a failed session for a wrong-state receipt with a leased post-state", async () => {
    const {voucherDb} = await startVoucherModule();
    faucetConfig.sessionCleanup = 10;
    const sessionId = "19e58416-a931-4412-98c8-21747ee9fd1e";
    const startTime = Math.floor(Date.now() / 1000) - 60;
    const {database} = await writeFailedCleanupReceipt("BADSTATE1", sessionId, startTime);
    await database.run([
      "UPDATE Vouchers SET SessionId = ?, TargetAddr = NULL, StartTime = ?,",
      "CleanupExpectedState = ? WHERE Code = ?",
    ].join(" "), [sessionId, startTime, VoucherState.LEASED, "BADSTATE1"]);
    const before = await database.get("SELECT * FROM Vouchers WHERE Code = ?", ["BADSTATE1"]);

    expect(await voucherDb.reserveVoucher("BADSTATE1", "new-owner", startTime + 1)).to.equal(false);
    expect(await voucherDb.releaseVoucher("BADSTATE1", sessionId)).to.equal(false);
    expect(await voucherDb.consumeVoucher("BADSTATE1", sessionId, PRIMARY_TARGET)).to.equal(false);
    expect(await voucherDb.reconcileOrphanedLeases()).to.equal(0);

    await ServiceManager.GetService(FaucetDatabase).cleanStore();

    expect(await ServiceManager.GetService(FaucetDatabase).getSession(sessionId)).to.not.equal(null);
    expect((await voucherDb.getVoucher("BADSTATE1") as IVoucher).state).to.equal(VoucherState.LEASED);
    expect(await database.get("SELECT * FROM Vouchers WHERE Code = ?", ["BADSTATE1"])).to.deep.equal(before);
  });

  it("Does not clear a finished receipt from an available voucher", async () => {
    const {voucherDb, database} = await startVoucherModule();
    faucetConfig.sessionCleanup = 10;
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const sessionId = "bddecb9f-440b-489d-a962-3ab7f2b5a7f4";
    const startTime = Math.floor(Date.now() / 1000) - 60;
    await databaseService.updateSession(
      storedSession(sessionId, FaucetSessionStatus.FINISHED, PRIMARY_TARGET, startTime, "FINAVAIL1"),
    );
    await insertVoucher(database, "FINAVAIL1", sessionId, null, startTime);
    const candidate: SessionCleanupCandidate = {
      sessionId,
      status: FaucetSessionStatus.FINISHED,
      startTime,
      targetAddr: PRIMARY_TARGET,
      dataJson: JSON.stringify({voucherCode: "FINAVAIL1"}),
      claimDataJson: null,
      claim: null,
    };
    expect(await VoucherDB.prepareSessionCleanup(databaseService, candidate)).to.equal(true);
    await database.run(
      "UPDATE Vouchers SET SessionId = NULL, TargetAddr = NULL, StartTime = NULL WHERE Code = ?",
      ["FINAVAIL1"],
    );
    const before = await database.get("SELECT * FROM Vouchers WHERE Code = ?", ["FINAVAIL1"]);

    expect(await voucherDb.reserveVoucher("FINAVAIL1", "new-finished-owner", startTime + 1)).to.equal(false);
    await databaseService.cleanStore();

    expect(await databaseService.getSession(sessionId)).to.not.equal(null);
    expect(await database.get("SELECT * FROM Vouchers WHERE Code = ?", ["FINAVAIL1"])).to.deep.equal(before);
  });

  it("Retains failed receipt evidence when its session owns an extra leased or consumed voucher", async () => {
    await startVoucherModule();
    faucetConfig.sessionCleanup = 10;
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const fixtures = [
      {
        code: "FAILOWN01",
        extraCode: "FAILXLS1",
        sessionId: "b03780f8-2f8c-46b9-b85b-e6a564e2b5dc",
        extraTarget: null,
      },
      {
        code: "FAILOWN02",
        extraCode: "FAILXCN1",
        sessionId: "0a28f7aa-7dd1-498d-bd45-0593086661ea",
        extraTarget: PRIMARY_TARGET,
      },
    ];

    for(const [index, fixture] of fixtures.entries()) {
      const startTime = Math.floor(Date.now() / 1000) - 60 - index;
      const {database} = await writeFailedCleanupReceipt(fixture.code, fixture.sessionId, startTime);
      await insertVoucher(
        database,
        fixture.extraCode,
        fixture.sessionId,
        fixture.extraTarget,
        startTime + 1,
      );

      await databaseService.cleanStore();

      expect(await databaseService.getSession(fixture.sessionId)).to.not.equal(null);
      const receiptVoucher = await database.get(
        "SELECT * FROM Vouchers WHERE Code = ?",
        [fixture.code],
      ) as Record<string, unknown>;
      expect(receiptVoucher.SessionId).to.equal(null);
      expect(receiptVoucher.CleanupStatus).to.equal(FaucetSessionStatus.FAILED);
    }
  });

  it("Retains finished receipt evidence when its session owns an extra leased or consumed voucher", async () => {
    const {database} = await startVoucherModule();
    faucetConfig.sessionCleanup = 10;
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const fixtures = [
      {
        code: "FINOWN001",
        extraCode: "FINXLES1",
        sessionId: "46aedff0-4398-49cb-ae3e-d7670dc721eb",
        extraTarget: null,
      },
      {
        code: "FINOWN002",
        extraCode: "FINXCON1",
        sessionId: "3a811bbe-1bff-4a56-bdbc-080cfc43ea58",
        extraTarget: SECONDARY_TARGET,
      },
    ];

    for(const [index, fixture] of fixtures.entries()) {
      const startTime = Math.floor(Date.now() / 1000) - 60 - index;
      await databaseService.updateSession(
        storedSession(
          fixture.sessionId,
          FaucetSessionStatus.FINISHED,
          PRIMARY_TARGET,
          startTime,
          fixture.code,
        ),
      );
      await insertVoucher(database, fixture.code, fixture.sessionId, null, startTime);
      const candidate: SessionCleanupCandidate = {
        sessionId: fixture.sessionId,
        status: FaucetSessionStatus.FINISHED,
        startTime,
        targetAddr: PRIMARY_TARGET,
        dataJson: JSON.stringify({voucherCode: fixture.code}),
        claimDataJson: null,
        claim: null,
      };
      expect(await VoucherDB.prepareSessionCleanup(databaseService, candidate)).to.equal(true);
      await insertVoucher(
        database,
        fixture.extraCode,
        fixture.sessionId,
        fixture.extraTarget,
        startTime + 1,
      );

      await databaseService.cleanStore();

      expect(await databaseService.getSession(fixture.sessionId)).to.not.equal(null);
      const receiptVoucher = await database.get(
        "SELECT * FROM Vouchers WHERE Code = ?",
        [fixture.code],
      ) as Record<string, unknown>;
      expect(receiptVoucher.TargetAddr).to.equal(PRIMARY_TARGET);
      expect(receiptVoucher.CleanupStatus).to.equal(FaucetSessionStatus.FINISHED);
    }
  });

  it("Retains a failed session when its raw data changes after receipt commit", async () => {
    await startVoucherModule();
    faucetConfig.sessionCleanup = 10;
    const sessionId = "de05bf0c-50e4-486a-8582-16d80c604c8e";
    const startTime = Math.floor(Date.now() / 1000) - 60;
    const {database} = await writeFailedCleanupReceipt("DATAHASH1", sessionId, startTime);
    const changedData = '{ "voucherCode": "DATAHASH1" }';
    await database.run("UPDATE Sessions SET Data = ? WHERE SessionId = ?", [changedData, sessionId]);

    await ServiceManager.GetService(FaucetDatabase).cleanStore();

    const persisted = await database.get(
      "SELECT Data FROM Sessions WHERE SessionId = ?",
      [sessionId],
    ) as Record<string, unknown>;
    expect(persisted.Data).to.equal(changedData);
  });

  it("Retains a failed session when its raw ClaimData changes after receipt commit", async () => {
    const {database} = await startVoucherModule();
    faucetConfig.sessionCleanup = 10;
    const sessionId = "551e2762-5902-436f-80a7-007f2b0f07d7";
    const startTime = Math.floor(Date.now() / 1000) - 60;
    const initialClaim = claimData(ClaimTxStatus.FAILED);
    await writeFailedCleanupReceipt("CLAIMHASH", sessionId, startTime, initialClaim);
    const changedClaim = JSON.stringify(claimData(ClaimTxStatus.REVERTED));
    await database.run(
      "UPDATE Sessions SET ClaimData = ? WHERE SessionId = ?",
      [changedClaim, sessionId],
    );

    await ServiceManager.GetService(FaucetDatabase).cleanStore();

    const persisted = await database.get(
      "SELECT ClaimData FROM Sessions WHERE SessionId = ?",
      [sessionId],
    ) as Record<string, unknown>;
    expect(persisted.ClaimData).to.equal(changedClaim);
  });

  it("Retains a failed session when the receipt names another voucher code", async () => {
    await startVoucherModule();
    faucetConfig.sessionCleanup = 10;
    const sessionId = "2a4cd922-9447-4ed7-99fe-08554fc9293f";
    const startTime = Math.floor(Date.now() / 1000) - 60;
    const {database} = await writeFailedCleanupReceipt("WRONGCODE", sessionId, startTime);
    await database.run(
      "UPDATE Vouchers SET CleanupVoucherCode = ? WHERE Code = ?",
      ["OTHER001", "WRONGCODE"],
    );

    await ServiceManager.GetService(FaucetDatabase).cleanStore();

    expect(await ServiceManager.GetService(FaucetDatabase).getSession(sessionId)).to.not.equal(null);
  });

  it("Rejects a stale receipt carried into a same-tuple newer lease and consume", async () => {
    const {voucherDb} = await startVoucherModule();
    faucetConfig.sessionCleanup = 10;
    const sessionId = "75fbe9fd-4f4e-44a4-b215-58f1f8c2a44a";
    const startTime = Math.floor(Date.now() / 1000) - 60;
    const {database} = await writeFailedCleanupReceipt("STALE001", sessionId, startTime);
    await database.run(
      "UPDATE Vouchers SET SessionId = ?, TargetAddr = NULL, StartTime = ? WHERE Code = ?",
      [sessionId, startTime, "STALE001"],
    );

    await ServiceManager.GetService(FaucetDatabase).cleanStore();
    expect(await ServiceManager.GetService(FaucetDatabase).getSession(sessionId)).to.not.equal(null);

    await database.run(
      "UPDATE Vouchers SET TargetAddr = ? WHERE Code = ? AND SessionId = ? AND StartTime = ?",
      [PRIMARY_TARGET, "STALE001", sessionId, startTime],
    );
    await ServiceManager.GetService(FaucetDatabase).cleanStore();

    expect(await ServiceManager.GetService(FaucetDatabase).getSession(sessionId)).to.not.equal(null);
    expect((await voucherDb.getVoucher("STALE001") as IVoucher).state).to.equal(VoucherState.CONSUMED);
  });

  it("Retains a failed session for an unexplained available voucher", async () => {
    const {voucherDb, database} = await startVoucherModule();
    faucetConfig.sessionCleanup = 10;
    const sessionId = "689719a5-6976-47a6-a67e-929034f0f2e1";
    const startTime = Math.floor(Date.now() / 1000) - 60;
    await ServiceManager.GetService(FaucetDatabase).updateSession(
      storedSession(sessionId, FaucetSessionStatus.FAILED, PRIMARY_TARGET, startTime, "NORECEIPT"),
    );
    await insertVoucher(database, "NORECEIPT");

    await ServiceManager.GetService(FaucetDatabase).cleanStore();

    expect(await ServiceManager.GetService(FaucetDatabase).getSession(sessionId)).to.not.equal(null);
    expect((await voucherDb.getVoucher("NORECEIPT") as IVoucher).state).to.equal(VoucherState.AVAILABLE);
  });

  it("Retains a failed session when its persisted voucher code conflicts", async () => {
    const {voucherDb, database} = await startVoucherModule();
    faucetConfig.sessionCleanup = 10;
    const sessionId = "cf94dc50-f130-4f1c-8529-dd9f4a6c3b1d";
    const startTime = Math.floor(Date.now() / 1000) - 60;
    await ServiceManager.GetService(FaucetDatabase).updateSession(
      storedSession(sessionId, FaucetSessionStatus.FAILED, PRIMARY_TARGET, startTime, "EXPECTED1"),
    );
    await insertVoucher(database, "ACTUAL001", sessionId, PRIMARY_TARGET, startTime);

    await ServiceManager.GetService(FaucetDatabase).cleanStore();

    expect(await ServiceManager.GetService(FaucetDatabase).getSession(sessionId)).to.not.equal(null);
    const voucher = await voucherDb.getVoucher("ACTUAL001") as IVoucher;
    expect(voucher.state).to.equal(VoucherState.CONSUMED);
    expect(voucher.sessionId).to.equal(sessionId);
  });

  it("Retains a failed session when its persisted voucher has another owner", async () => {
    const {voucherDb, database} = await startVoucherModule();
    faucetConfig.sessionCleanup = 10;
    const sessionId = "a3ee0807-f931-4264-be74-d16ac691f153";
    const newerOwner = "548f3172-66a4-4c77-9002-55fa8cd7b924";
    const startTime = Math.floor(Date.now() / 1000) - 60;
    await ServiceManager.GetService(FaucetDatabase).updateSession(
      storedSession(sessionId, FaucetSessionStatus.FAILED, PRIMARY_TARGET, startTime, "OWNERBAD1"),
    );
    await insertVoucher(database, "OWNERBAD1", newerOwner, PRIMARY_TARGET, startTime + 1);

    await ServiceManager.GetService(FaucetDatabase).cleanStore();

    expect(await ServiceManager.GetService(FaucetDatabase).getSession(sessionId)).to.not.equal(null);
    const voucher = await voucherDb.getVoucher("OWNERBAD1") as IVoucher;
    expect(voucher.state).to.equal(VoucherState.CONSUMED);
    expect(voucher.sessionId).to.equal(newerOwner);
    expect(voucher.targetAddr).to.equal(PRIMARY_TARGET);
  });

  it("Consumes a finished session lease before cleanup when the module is disabled", async () => {
    faucetConfig.modules["voucher"] = {enabled: true} as IVoucherConfig;
    faucetConfig.sessionCleanup = 10;
    const moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    const voucherModule = moduleManager.getModule<VoucherModule>("voucher");
    const voucherDb = (voucherModule as any).voucherDb as VoucherDB;
    const database = (voucherDb as any).db as BaseDriver;
    const sessionId = "3532ed0e-67ed-4d58-b9c5-dfe6489f15f3";
    const startTime = Math.floor(Date.now() / 1000) - 60;
    const session = storedSession(
      sessionId,
      FaucetSessionStatus.FINISHED,
      PRIMARY_TARGET,
      startTime,
      "CLEANFIN1",
      claimData(ClaimTxStatus.CONFIRMED),
    );
    await ServiceManager.GetService(FaucetDatabase).updateSession(session);
    await insertVoucher(database, "CLEANFIN1", sessionId, null, startTime);
    await moduleManager.dispose();
    const runSpy = sinon.spy(database, "run");

    await ServiceManager.GetService(FaucetDatabase).cleanStore();

    const statements = runSpy.getCalls().map((call) => String(call.args[0]));
    const consumeIndex = statements.findIndex((sql) => sql.includes("UPDATE Vouchers SET TargetAddr"));
    const deleteIndex = statements.findIndex((sql) => sql.includes("DELETE FROM Sessions"));
    expect(consumeIndex).to.be.greaterThan(-1);
    expect(deleteIndex).to.be.greaterThan(consumeIndex);
    expect(await ServiceManager.GetService(FaucetDatabase).getSession(sessionId)).to.equal(null);
    const voucher = await voucherDb.getVoucher("CLEANFIN1") as IVoucher;
    expect(voucher.state).to.equal(VoucherState.CONSUMED);
    expect(voucher.sessionId).to.equal(sessionId);
    expect(voucher.targetAddr).to.equal(PRIMARY_TARGET);

    await ServiceManager.GetService(FaucetDatabase).updateSession(session);
    await ServiceManager.GetService(FaucetDatabase).cleanStore();
    expect(await ServiceManager.GetService(FaucetDatabase).getSession(sessionId)).to.equal(null);
    expect(await voucherDb.getVoucher("CLEANFIN1")).to.deep.equal(voucher);
  });

  it("Retains a finished session when its consumed voucher target conflicts", async () => {
    faucetConfig.modules["voucher"] = {enabled: true} as IVoucherConfig;
    faucetConfig.sessionCleanup = 10;
    const moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    const voucherModule = moduleManager.getModule<VoucherModule>("voucher");
    const voucherDb = (voucherModule as any).voucherDb as VoucherDB;
    const database = (voucherDb as any).db as BaseDriver;
    const sessionId = "949c7918-7282-40c1-9066-77ad16f6ff70";
    const startTime = Math.floor(Date.now() / 1000) - 60;
    await ServiceManager.GetService(FaucetDatabase).updateSession(
      storedSession(
        sessionId,
        FaucetSessionStatus.FINISHED,
        PRIMARY_TARGET,
        startTime,
        "BADTARGET1",
      ),
    );
    await insertVoucher(database, "BADTARGET1", sessionId, SECONDARY_TARGET, startTime);
    await moduleManager.dispose();

    await ServiceManager.GetService(FaucetDatabase).cleanStore();

    expect(await ServiceManager.GetService(FaucetDatabase).getSession(sessionId)).to.not.equal(null);
    const voucher = await voucherDb.getVoucher("BADTARGET1") as IVoucher;
    expect(voucher.state).to.equal(VoucherState.CONSUMED);
    expect(voucher.targetAddr).to.equal(SECONDARY_TARGET);
  });

  it("Cleans only exact lowercase terminal statuses even if candidate selection returns case variants", async () => {
    faucetConfig.sessionCleanup = 10;
    const databaseService = ServiceManager.GetService(FaucetDatabase);
    const database = databaseService.getDatabase();
    const startTime = Math.floor(Date.now() / 1000) - 60;
    const fixtures = [
      {sessionId: "85dad636-17d1-4d3f-a3c9-37c9944bb1e0", status: "failed", deleted: true},
      {sessionId: "10edbf93-c597-47dd-a284-d97241d05656", status: "finished", deleted: true},
      {sessionId: "d88e1aa5-822d-4588-9630-e1c2f7ce6731", status: "FAILED", deleted: false},
      {sessionId: "11480411-ee20-4361-9973-37b54e4d3303", status: "Failed", deleted: false},
      {sessionId: "4cd6c5eb-49ad-4ee7-9287-6932c713b67e", status: "FINISHED", deleted: false},
    ];
    for(const fixture of fixtures) {
      await databaseService.updateSession(
        storedSession(
          fixture.sessionId,
          FaucetSessionStatus.FAILED,
          PRIMARY_TARGET,
          startTime,
        ),
      );
      await database.run(
        "UPDATE Sessions SET Status = ? WHERE SessionId = ?",
        [fixture.status, fixture.sessionId],
      );
    }
    const originalAll = database.all.bind(database);
    sinon.stub(database, "all").callsFake(async (sql, values) => {
      if(String(sql).includes("SELECT SessionId, Status, StartTime, TargetAddr, Data, ClaimData")) {
        return originalAll(
          [
            "SELECT SessionId, Status, StartTime, TargetAddr, Data, ClaimData",
            "FROM Sessions WHERE StartTime < ?",
            "ORDER BY StartTime ASC, SessionId ASC LIMIT ?",
          ].join(" "),
          values,
        );
      }
      return originalAll(sql, values);
    });

    await databaseService.cleanStore();

    for(const fixture of fixtures) {
      const persisted = await database.get(
        "SELECT SessionId FROM Sessions WHERE SessionId = ?",
        [fixture.sessionId],
      );
      expect(!!persisted, fixture.status).to.equal(!fixture.deleted);
    }
  });

  it("Skips the voucher cleanup guard when its schema was never installed", async () => {
    faucetConfig.sessionCleanup = 10;
    const sessionId = "9785beed-4ff2-4454-b4a3-ce35f0b6e529";
    await ServiceManager.GetService(FaucetDatabase).updateSession(
      storedSession(
        sessionId,
        FaucetSessionStatus.FAILED,
        PRIMARY_TARGET,
        Math.floor(Date.now() / 1000) - 60,
      ),
    );

    await ServiceManager.GetService(FaucetDatabase).cleanStore();

    expect(await ServiceManager.GetService(FaucetDatabase).getSession(sessionId)).to.equal(null);
  });

  it("Keeps voucher capabilities out of public errors and logs", async () => {
    await startVoucherModule();
    const voucherCode = "SECRET77";
    const logSpy = sinon.spy(ServiceManager.GetService(FaucetProcess), "emitLog");
    let startError: unknown;

    try {
      await ServiceManager.GetService(SessionManager).createSession("8.8.8.8", {
        addr: PRIMARY_TARGET,
        voucherCode,
      });
    } catch(ex) {
      startError = ex;
    }

    expect(startError).to.be.instanceOf(FaucetError);
    const publicFailure = toClientFailure(startError, "starting voucher session");
    expect(publicFailure.failedCode).to.equal("VOUCHER_INVALID");
    expect(JSON.stringify(publicFailure)).to.not.include(voucherCode);
    expect(String((startError as Error).message)).to.not.include(voucherCode);
    expect(logSpy.getCalls().every((call) => !String(call.args[1]).includes(voucherCode))).to.equal(true);
  });
});
