import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { bindTestStubs, unbindTestStubs, loadDefaultTestConfig, awaitSleepPromise, createFuse, fusedSleep } from './common.js';
import { ServiceManager } from '../src/common/ServiceManager.js';
import {
  FaucetDatabase,
  SESSION_CLEANUP_BATCH_SIZE,
  SESSION_CLEANUP_RUN_LIMIT,
} from '../src/db/FaucetDatabase.js';
import { ModuleHookAction, ModuleManager } from '../src/modules/ModuleManager.js';
import { SessionManager } from '../src/session/SessionManager.js';
import { faucetConfig } from '../src/config/FaucetConfig.js';
import { FaucetError } from '../src/common/FaucetError.js';
import { FaucetSession, FaucetSessionStatus, FaucetSessionStoreData } from '../src/session/FaucetSession.js';
import { ClaimTxStatus, EthClaimData, EthClaimInfo, EthClaimManager, SignedClaimTransaction } from '../src/eth/EthClaimManager.js';
import { isClaimData } from '../src/eth/EthClaim.js';
import { getNewGuid } from '../src/utils/GuidUtils.js';
import { EthWalletManager, FaucetCoinType } from '../src/eth/EthWalletManager.js';
import { sleepPromise } from '../src/utils/PromiseUtils.js';
import { FakeWebSocket, injectFakeWebSocket } from './stubs/FakeWebSocket.js';
import { EthClaimNotificationClient } from '../src/eth/EthClaimNotificationClient.js';
import { FaucetHttpServer } from '../src/webserv/FaucetHttpServer.js';
import { IFaucetOutflowConfig } from '../src/modules/faucet-outflow/FaucetOutflowConfig.js';
import { FaucetOutflowModule } from '../src/modules/faucet-outflow/FaucetOutflowModule.js';


describe("ETH Claim Manager", () => {
  let globalStubs;

  function getTestTransaction(nonce: number): SignedClaimTransaction {
    return {
      txHash: "0x" + (nonce + 1).toString(16).padStart(64, "0"),
      txHex: "0x" + (nonce + 1).toString(16).padStart(2, "0"),
      txNonce: nonce,
    };
  }

  beforeEach(async () => {
    globalStubs = bindTestStubs({
      "EthWalletManager.prepareClaimTx": sinon.stub(EthWalletManager.prototype, "prepareClaimTx").resolves(getTestTransaction(0)),
      "EthWalletManager.canReserveClaimTx": sinon.stub(EthWalletManager.prototype, "canReserveClaimTx").returns(true),
      "EthWalletManager.reserveClaimTx": sinon.stub(EthWalletManager.prototype, "reserveClaimTx"),
      "EthWalletManager.cancelClaimTx": sinon.stub(EthWalletManager.prototype, "cancelClaimTx"),
      "EthWalletManager.releaseClaimTx": sinon.stub(EthWalletManager.prototype, "releaseClaimTx"),
      "EthWalletManager.broadcastClaimTx": sinon.stub(EthWalletManager.prototype, "broadcastClaimTx").resolves(),
      "EthWalletManager.watchClaimTx": sinon.stub(EthWalletManager.prototype, "watchClaimTx").returns(new Promise(() => {})),
    });
    loadDefaultTestConfig();
    await ServiceManager.GetService(FaucetDatabase).initialize();
    await ServiceManager.GetService(ModuleManager).initialize();
    faucetConfig.minDropAmount = 10;
    faucetConfig.maxDropAmount = 1000;
  });
  afterEach(async () => {
    let dbService = ServiceManager.GetService(FaucetDatabase);
    await ServiceManager.DisposeAllServices();
    await dbService.closeDatabase();
    await unbindTestStubs(globalStubs);
  });

  async function addTestSession(status: FaucetSessionStatus, claimData: any, amount?: string): Promise<FaucetSessionStoreData> {
    let sessionData: FaucetSessionStoreData = {
      sessionId: getNewGuid(),
      startTime: Math.floor(new Date().getTime() / 1000),
      status: status,
      dropAmount: amount || "100",
      remoteIP: "8.8.8.8",
      targetAddr: "0x0000000000000000000000000000000000001337",
      tasks: [],
      data: {},
      claim: claimData,
    }
    await ServiceManager.GetService(FaucetDatabase).updateSession(sessionData);
    return sessionData;
  }

  function getTestReceipt(): any {
    return {
      status: true,
      transactionHash: null,
      transactionIndex: 1,
      blockHash: "0xfce202c4104864d81d8bd78b7202a77e5dca634914a3fd6636f2765d65fa9a07",
      blockNumber: 0x8aa5ae,
      from: "0x0000000000000000000000000000000000004242",
      to: "0x0000000000000000000000000000000000001337",
      contractAddress: null,
      cumulativeGasUsed: 0x1752665,
      gasUsed: 10,
      effectiveGasPrice: 10,
      logs: [],
      logsBloom: "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
    };
  }

  it("sums claimable decimal strings exactly in SQLite", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    expect(await database.getClaimableAmount()).to.equal(0n, "empty claimable total was not zero");

    let amounts = [
      "9007199254740993",
      "9223372036854775808",
      "340282366920938463463374607431768211455",
      "99999999999999999999999999999999999999999999999999",
    ];
    for(let amount of amounts)
      await addTestSession(FaucetSessionStatus.CLAIMABLE, null, amount);
    await addTestSession(FaucetSessionStatus.FAILED, null, "99999999999999999999999999999999999999");

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
  });

  it("rejects malformed SQLite claimable decimal strings instead of truncating them", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    await addTestSession(FaucetSessionStatus.CLAIMABLE, null, "12e3");

    let aggregateError = await database.getClaimableAmount().then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(aggregateError).to.be.instanceOf(Error);
    expect(aggregateError?.message).to.equal(
      "Claimable DropAmount must be a non-empty decimal string.",
    );
  });

  it("rejects SQLite claimable amounts outside the 50-digit storage domain", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    await addTestSession(FaucetSessionStatus.CLAIMABLE, null, "9".repeat(51));

    let aggregateError = await database.getClaimableAmount().then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(aggregateError?.message).to.equal(
      "Claimable DropAmount exceeds the 50-digit storage limit.",
    );
  });

  it("rejects contradictory persisted claim states", () => {
    let queued = {
      claimFormat: 2,
      claimIdx: 1,
      claimStatus: ClaimTxStatus.QUEUE,
      claimTime: 1,
    };
    expect(isClaimData(queued)).to.equal(true, "valid queued claim was rejected");
    expect(isClaimData({ ...queued, txError: "impossible" })).to.equal(false, "queued claim accepted terminal fields");
    expect(isClaimData({
      ...queued,
      claimStatus: ClaimTxStatus.PREPARED,
      ...getTestTransaction(1),
      txBlock: 1,
    })).to.equal(false, "prepared claim accepted receipt fields");
    expect(isClaimData({
      ...queued,
      claimStatus: ClaimTxStatus.FAILED,
      txError: "failed",
      ...getTestTransaction(1),
    })).to.equal(false, "failed claim accepted signed transaction fields");
  });

  it("serializes claim admission and transitions with SQLite CAS", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let session = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);
    let claimTime = Math.floor(Date.now() / 1000);
    let candidates: EthClaimData[] = [
      { claimFormat: 2, claimIdx: 1, claimStatus: ClaimTxStatus.QUEUE, claimTime },
      { claimFormat: 2, claimIdx: 2, claimStatus: ClaimTxStatus.QUEUE, claimTime },
    ];

    let admissions = await Promise.all(candidates.map((claim) => database.tryCreateClaim(session.sessionId, "100", claim)));
    expect(admissions.filter(Boolean).length).to.equal(1, "more than one claim admission won");
    let admittedClaim = candidates[admissions[0] ? 0 : 1];

    let transitions: EthClaimData[] = [
      {
        claimFormat: 2,
        claimIdx: admittedClaim.claimIdx,
        claimTime: admittedClaim.claimTime,
        claimStatus: ClaimTxStatus.PREPARED,
        ...getTestTransaction(7),
      },
      {
        claimFormat: 2,
        claimIdx: admittedClaim.claimIdx,
        claimTime: admittedClaim.claimTime,
        claimStatus: ClaimTxStatus.FAILED,
        txError: "test failure",
      },
    ];
    let transitionResults = await Promise.all(transitions.map((claim) => database.compareAndSetClaim(session.sessionId, admittedClaim, claim)));
    expect(transitionResults.filter(Boolean).length).to.equal(1, "more than one claim transition won");

    let storedSession = await database.getSession(session.sessionId);
    expect(storedSession.claim).to.deep.equal(transitions[transitionResults[0] ? 0 : 1], "stored claim does not match the CAS winner");
  });

  it("serializes SQLite key-value accounting updates", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    await database.setKeyValueEntry("accounting-state", "v1");
    let results = await Promise.all([
      database.compareAndSetKeyValueEntry("accounting-state", "v1", "v2-a"),
      database.compareAndSetKeyValueEntry("accounting-state", "v1", "v2-b"),
    ]);

    expect(results.filter(Boolean)).to.have.length(1);
    expect(await database.getKeyValueEntry("accounting-state")).to.equal(results[0] ? "v2-a" : "v2-b");
  });

  it("excludes CLAIMING sessions from generic SQLite timeout cleanup", async () => {
    let oldStartTime = Math.floor(Date.now() / 1000) - 60;
    let claimingSession = await addTestSession(FaucetSessionStatus.CLAIMING, {
      claimFormat: 2,
      claimIdx: 1,
      claimStatus: ClaimTxStatus.QUEUE,
      claimTime: oldStartTime,
    });
    claimingSession.startTime = oldStartTime;
    await ServiceManager.GetService(FaucetDatabase).updateSession(claimingSession);
    let runningSession = await addTestSession(FaucetSessionStatus.RUNNING, null);
    runningSession.startTime = oldStartTime;
    await ServiceManager.GetService(FaucetDatabase).updateSession(runningSession);

    let timedOutSessions = await ServiceManager.GetService(FaucetDatabase).getTimedOutSessions(10);
    expect(timedOutSessions.some((session) => session.sessionId === runningSession.sessionId)).to.equal(true, "running timeout candidate was omitted");
    expect(timedOutSessions.some((session) => session.sessionId === claimingSession.sessionId)).to.equal(false, "generic timeout selected an active payout");
  });

  it("atomically arbitrates SQLite claim admission and timeout", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let session = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);
    session.startTime = Math.floor(Date.now() / 1000) - 60;
    session.data = { marker: "original" };
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

    let staleSession = await addTestSession(FaucetSessionStatus.RUNNING, null);
    staleSession.startTime = session.startTime;
    staleSession.data = { marker: "stale" };
    await database.updateSession(staleSession);
    let currentSession = JSON.parse(JSON.stringify(staleSession));
    currentSession.data.marker = "current";
    await database.updateSession(currentSession);
    expect(await database.tryTimeoutSession(staleSession, 10)).to.equal(false, "timeout overwrote concurrently updated session data");
    expect((await database.getSession(staleSession.sessionId)).data).to.deep.equal(currentSession.data, "losing timeout changed current session data");
  });

  it("does not let a generic SQLite save overwrite claim ownership", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let staleSession = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);
    let queuedClaim: EthClaimData = {
      claimFormat: 2,
      claimIdx: 1,
      claimStatus: ClaimTxStatus.QUEUE,
      claimTime: staleSession.startTime,
    };
    expect(await database.tryCreateClaim(staleSession.sessionId, staleSession.dropAmount, queuedClaim)).to.equal(true);

    staleSession.data = {marker: "stale generic save"};
    expect(await database.updateSession(staleSession)).to.equal(false, "stale generic save reported ownership");

    let storedSession = await database.getSession(staleSession.sessionId);
    expect(storedSession.status).to.equal(FaucetSessionStatus.CLAIMING);
    expect(storedSession.claim).to.deep.equal(queuedClaim, "generic save cleared durable ClaimData");
    expect(storedSession.data).to.deep.equal({}, "generic save changed data after losing ownership");
  });

  it("retains active SQLite payout liabilities during cleanup", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    faucetConfig.sessionCleanup = 10;
    let oldStartTime = Math.floor(Date.now() / 1000) - 60;
    let activeClaim = await addTestSession(FaucetSessionStatus.CLAIMING, {
      claimFormat: 2,
      claimIdx: 1,
      claimStatus: ClaimTxStatus.PREPARED,
      claimTime: oldStartTime,
      ...getTestTransaction(4),
    });
    activeClaim.startTime = oldStartTime;
    await database.updateSession(activeClaim);
    let legacyProcessing = await addTestSession(FaucetSessionStatus.FAILED, {
      claimIdx: 2,
      claimStatus: "processing",
      claimTime: oldStartTime,
    });
    legacyProcessing.startTime = oldStartTime;
    await database.updateSession(legacyProcessing);
    let contradictoryConfirmed = await addTestSession(FaucetSessionStatus.FAILED, {
      claimFormat: 2,
      claimIdx: 3,
      claimStatus: ClaimTxStatus.CONFIRMED,
      claimTime: oldStartTime,
      ...getTestTransaction(5),
      txBlock: 42,
      txFee: "100",
    });
    contradictoryConfirmed.startTime = oldStartTime;
    await database.updateSession(contradictoryConfirmed);
    let terminalSession = await addTestSession(FaucetSessionStatus.FAILED, null);
    terminalSession.startTime = oldStartTime;
    await database.updateSession(terminalSession);

    await database.cleanStore();

    expect(await database.getSession(activeClaim.sessionId)).to.not.equal(null, "cleanup deleted a PREPARED liability");
    expect(await database.getSession(legacyProcessing.sessionId)).to.not.equal(null, "cleanup deleted a legacy PROCESSING liability");
    expect(await database.getSession(contradictoryConfirmed.sessionId)).to.not.equal(null, "cleanup deleted contradictory confirmed payout evidence");
    expect(await database.getSession(terminalSession.sessionId)).to.equal(null, "cleanup retained an ordinary terminal session");
  });

  it("coalesces overlapping SQLite cleanup runs", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    faucetConfig.sessionCleanup = 10;
    let oldSession = await addTestSession(FaucetSessionStatus.FAILED, null);
    oldSession.startTime = Math.floor(Date.now() / 1000) - 60;
    expect(await database.updateSession(oldSession)).to.equal(true);

    let enterGuard!: () => void;
    let guardEntered = new Promise<void>((resolve) => {
      enterGuard = resolve;
    });
    let releaseGuard!: () => void;
    let guardRelease = new Promise<void>((resolve) => {
      releaseGuard = resolve;
    });
    let guardCalls = 0;
    let unregister = database.registerSessionCleanupGuard("test.single-flight", async () => {
      guardCalls++;
      enterGuard();
      await guardRelease;
      return false;
    });

    let firstCleanup = database.cleanStore();
    await guardEntered;
    let secondCleanup = database.cleanStore();
    try {
      releaseGuard();
      await Promise.all([firstCleanup, secondCleanup]);
    } finally {
      releaseGuard();
      unregister();
    }

    expect(guardCalls).to.equal(1, "overlapping cleanup started a second candidate pass");
    expect(await database.getSession(oldSession.sessionId)).to.not.equal(null);
  });

  it("waits for active SQLite cleanup before closing the database", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    faucetConfig.sessionCleanup = 10;
    let oldSession = await addTestSession(FaucetSessionStatus.FAILED, null);
    oldSession.startTime = Math.floor(Date.now() / 1000) - 60;
    expect(await database.updateSession(oldSession)).to.equal(true);

    let enterGuard!: () => void;
    let guardEntered = new Promise<void>((resolve) => {
      enterGuard = resolve;
    });
    let releaseGuard!: () => void;
    let guardRelease = new Promise<void>((resolve) => {
      releaseGuard = resolve;
    });
    let unregister = database.registerSessionCleanupGuard("test.close-drain", async () => {
      enterGuard();
      await guardRelease;
      return false;
    });
    let closeStarted = false;
    let queriesAfterCloseStarted = 0;
    let originalAll = driver.all.bind(driver);
    sinon.stub(driver, "all").callsFake(async (sql, values) => {
      if(closeStarted)
        queriesAfterCloseStarted++;
      return originalAll(sql, values);
    });
    let originalRun = driver.run.bind(driver);
    sinon.stub(driver, "run").callsFake(async (sql, values) => {
      if(closeStarted)
        queriesAfterCloseStarted++;
      return originalRun(sql, values);
    });
    let originalClose = driver.close.bind(driver);
    let closeStub = sinon.stub(driver, "close").callsFake(async () => {
      closeStarted = true;
      await originalClose();
    });

    let cleanup = database.cleanStore();
    await guardEntered;
    let close = database.closeDatabase();
    await Promise.resolve();
    try {
      expect(closeStub.called).to.equal(false, "database closed while cleanup still owned queries");
      releaseGuard();
      await Promise.all([cleanup, close]);
    } finally {
      releaseGuard();
      unregister();
    }

    expect(closeStub.calledOnce).to.equal(true);
    expect(queriesAfterCloseStarted).to.equal(0, "cleanup queried after database close began");
  });

  it("bounds SQLite cleanup pages and resumes after the per-run ceiling", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    faucetConfig.sessionCleanup = 10;
    let startTime = Math.floor(Date.now() / 1000) - 60;
    let candidateCount = SESSION_CLEANUP_RUN_LIMIT + 1;
    await driver.run([
      "WITH RECURSIVE Candidates(CandidateNumber) AS (",
      "SELECT 0 UNION ALL",
      "SELECT CandidateNumber + 1 FROM Candidates WHERE CandidateNumber + 1 < ?",
      ")",
      "INSERT INTO Sessions",
      "(SessionId, Status, StartTime, TargetAddr, DropAmount, RemoteIP, Tasks, Data, ClaimData)",
      "SELECT printf('00000000-0000-0000-0000-%012d', CandidateNumber),",
      "'failed', ?, '0x0000000000000000000000000000000000001337',",
      "'1', '8.8.8.8', '[]', '{}', NULL FROM Candidates",
    ].join(" "), [candidateCount, startTime]);

    let seenSessionIds = new Set<string>();
    let unregister = database.registerSessionCleanupGuard("voucher.reservation", (candidate) => {
      seenSessionIds.add(candidate.sessionId);
      return false;
    });
    let originalAll = driver.all.bind(driver);
    let batchSizes: number[] = [];
    let allStub = sinon.stub(driver, "all").callsFake(async (sql, values) => {
      let rows = await originalAll(sql, values);
      if(String(sql).includes("FROM Sessions INDEXED BY SessionsCleanupIdx"))
        batchSizes.push(rows.length);
      return rows;
    });

    try {
      await database.cleanStore();
      expect(seenSessionIds.size).to.equal(SESSION_CLEANUP_RUN_LIMIT);
      expect(batchSizes).to.have.length(
        Math.ceil(SESSION_CLEANUP_RUN_LIMIT / SESSION_CLEANUP_BATCH_SIZE),
      );
      expect(batchSizes.every((size) => size <= SESSION_CLEANUP_BATCH_SIZE)).to.equal(true);

      await database.cleanStore();
      expect(seenSessionIds.size).to.equal(candidateCount, "next cleanup did not resume after its cursor");
      expect(batchSizes.at(-1)).to.equal(1);
      expect((await driver.get("SELECT COUNT(*) AS Count FROM Sessions") as {Count: number}).Count)
        .to.equal(candidateCount, "guarded sessions were deleted while testing the work ceiling");
    } finally {
      allStub.restore();
      unregister();
    }
  });

  it("repairs a missing SQLite cleanup index at schema version 2", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    await driver.exec("DROP INDEX SessionsCleanupIdx");

    await (database as any).upgradeSchema();

    let index = (await driver.all('PRAGMA index_list("Sessions")'))
      .find((row) => row.name === "SessionsCleanupIdx");
    let columns = (await driver.all('PRAGMA index_xinfo("SessionsCleanupIdx")'))
      .filter((row) => row.key === 1);
    expect(index).to.include({unique: 0, partial: 0});
    expect(columns.map((row) => ({name: row.name, desc: row.desc, coll: row.coll}))).to.deep.equal([
      {name: "StartTime", desc: 0, coll: "BINARY"},
      {name: "SessionId", desc: 0, coll: "BINARY"},
    ]);
  });

  it("repairs an incompatible SQLite cleanup index at schema version 2", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    await driver.exec("DROP INDEX SessionsCleanupIdx");
    await driver.exec("CREATE INDEX SessionsCleanupIdx ON Sessions (SessionId DESC, StartTime ASC)");

    await (database as any).upgradeSchema();

    let columns = (await driver.all('PRAGMA index_xinfo("SessionsCleanupIdx")'))
      .filter((row) => row.key === 1);
    expect(columns.map((row) => ({name: row.name, desc: row.desc, coll: row.coll}))).to.deep.equal([
      {name: "StartTime", desc: 0, coll: "BINARY"},
      {name: "SessionId", desc: 0, coll: "BINARY"},
    ]);
  });

  it("rejects malformed and unsupported SQLite core schema versions", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    let storedVersions: Array<number | string> = [-1, 3, 1.5, "invalid"];

    for(let storedVersion of storedVersions) {
      await driver.run(
        "UPDATE SchemaVersion SET Version = ? WHERE Module IS NULL",
        [storedVersion],
      );
      let schemaError = await (database as any).upgradeSchema()
        .then(() => null, (error) => error as Error);

      expect(schemaError?.message, String(storedVersion)).to.equal(
        "FaucetStore has an unsupported schema version; expected a safe integer from 0 through 2.",
      );
    }
  });

  it("rejects duplicate SQLite core schema versions", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    await driver.run(
      "INSERT INTO SchemaVersion (Module, Version) VALUES (NULL, ?)",
      [3],
    );

    let schemaError = await (database as any).upgradeSchema()
      .then(() => null, (error) => error as Error);

    expect(schemaError?.message).to.equal("FaucetStore has duplicate schema version rows.");
    expect((await driver.get(
      "SELECT COUNT(*) AS Count FROM SchemaVersion WHERE Module IS NULL",
    ) as {Count: number}).Count).to.equal(2);
  });

  it("rejects malformed module schema versions before invoking their upgrader", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    let storedVersions: Array<number | string> = [-1, 4, 1.5, "invalid"];

    for(let index = 0; index < storedVersions.length; index++) {
      let moduleName = `invalid-schema-${index}`;
      await driver.run(
        "INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)",
        [moduleName, storedVersions[index]],
      );
      let upgrade = sinon.stub().resolves(3);

      let schemaError = await database.upgradeIfNeeded(moduleName, 3, upgrade)
        .then(() => null, (error) => error as Error);

      expect(schemaError?.message, moduleName).to.equal(
        `Module ${moduleName} has an unsupported schema version; expected a safe integer from 0 through 3.`,
      );
      expect(upgrade.called).to.equal(false, `${moduleName} invoked its upgrader`);
    }
  });

  it("requires a module schema upgrader to return its exact latest version", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let driver = database.getDatabase();
    let returnedVersions = [0, 1, 2, 4, 1.5];

    for(let index = 0; index < returnedVersions.length; index++) {
      let moduleName = `invalid-upgrade-result-${index}`;
      await driver.run(
        "INSERT INTO SchemaVersion (Module, Version) VALUES (?, ?)",
        [moduleName, 1],
      );

      let schemaError = await database.upgradeIfNeeded(
        moduleName,
        3,
        async () => returnedVersions[index],
      ).then(() => null, (error) => error as Error);

      expect(schemaError?.message, moduleName).to.equal(
        `Module ${moduleName} schema upgrade returned an invalid version; expected exactly 3.`,
      );
      expect((await driver.get(
        "SELECT Version FROM SchemaVersion WHERE Module = ?",
        [moduleName],
      ) as {Version: number}).Version).to.equal(1, `${moduleName} persisted an invalid version`);
    }
  });

  it("matches legacy mixed-case address history in SQLite", async () => {
    let database = ServiceManager.GetService(FaucetDatabase);
    let session = await addTestSession(FaucetSessionStatus.FINISHED, null);
    session.targetAddr = "0xAbCd000000000000000000000000000000001337";
    await database.updateSession(session);

    let history = await database.getFinishedSessions(
      "0xabcd000000000000000000000000000000001337",
      null,
      60,
    );
    expect(history.map((item) => item.sessionId)).to.include(session.sessionId);
  });

  it("admits only one concurrent claim for independent session snapshots", async () => {
    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let session = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);
    let snapshots = [
      JSON.parse(JSON.stringify(session)),
      JSON.parse(JSON.stringify(session)),
    ];

    let results = await Promise.allSettled(snapshots.map((snapshot) => claimManager.createSessionClaim(snapshot, {})));
    expect(results.filter((result) => result.status === "fulfilled").length).to.equal(1, "concurrent claim admission had multiple winners");
    let rejection = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(rejection.reason).to.be.instanceOf(FaucetError);
    expect(rejection.reason.getCode()).to.equal("RACE_CLAIMING", "concurrent loser reported the wrong error");
    expect(claimManager.getTransactionQueue(true).length).to.equal(1, "concurrent admission created duplicate queue entries");
  });

  it("persists signed bytes before the first broadcast", async () => {
    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let session = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);
    let claim = await claimManager.createSessionClaim(session, {});
    globalStubs["getWalletState"] = sinon.stub(EthWalletManager.prototype, "getWalletState").returns({
      ready: true,
      nonce: 0,
      balance: 1000000000000000000n,
      nativeBalance: 1000000000000000000n,
    });

    let database = ServiceManager.GetService(FaucetDatabase);
    let originalTransition = database.compareAndSetClaim.bind(database);
    let transitionEntered = false;
    let transitionFuse = createFuse();
    globalStubs["FaucetDatabase.compareAndSetClaim"] = sinon.stub(database, "compareAndSetClaim").callsFake(async (sessionId, expected, next) => {
      if(next.claimStatus === ClaimTxStatus.PREPARED) {
        transitionEntered = true;
        await fusedSleep(transitionFuse);
      }
      return originalTransition(sessionId, expected, next);
    });

    let persistedAtBroadcast: EthClaimData = null;
    globalStubs["EthWalletManager.broadcastClaimTx"].callsFake(async () => {
      persistedAtBroadcast = (await database.getSession(session.sessionId)).claim;
    });

    let processPromise = claimManager.processQueue();
    await awaitSleepPromise(100, () => transitionEntered);
    expect(transitionEntered).to.equal(true, "prepared transition did not start");
    expect(globalStubs["EthWalletManager.broadcastClaimTx"].called).to.equal(false, "transaction broadcast before persistence completed");
    expect((await database.getSession(session.sessionId)).claim.claimStatus).to.equal(ClaimTxStatus.QUEUE, "queue state changed before the delayed CAS");

    transitionFuse();
    await processPromise;
    await awaitSleepPromise(100, () => !!persistedAtBroadcast);
    expect(persistedAtBroadcast?.claimStatus).to.equal(ClaimTxStatus.PREPARED, "first broadcast did not observe durable prepared state");
    expect(persistedAtBroadcast?.txHex).to.equal(claim.claim.txHex, "broadcast bytes differ from persisted bytes");
    expect(persistedAtBroadcast?.txHash).to.equal(claim.claim.txHash, "broadcast hash differs from persisted hash");
    expect(persistedAtBroadcast?.txNonce).to.equal(claim.claim.txNonce, "broadcast nonce differs from persisted nonce");
  });

  it("keeps the wallet reservation when PREPARED commits before the CAS acknowledgement fails", async () => {
    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let session = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);
    await claimManager.createSessionClaim(session, {});
    globalStubs["getWalletState"] = sinon.stub(EthWalletManager.prototype, "getWalletState").returns({
      ready: true,
      nonce: 0,
      balance: 1000000000000000000n,
      nativeBalance: 1000000000000000000n,
    });

    let database = ServiceManager.GetService(FaucetDatabase);
    let originalTransition = database.compareAndSetClaim.bind(database);
    let injected = false;
    globalStubs["FaucetDatabase.compareAndSetClaim"] = sinon.stub(database, "compareAndSetClaim").callsFake(async (sessionId, expected, next) => {
      let changed = await originalTransition(sessionId, expected, next);
      if(!injected && changed && next.claimStatus === ClaimTxStatus.PREPARED) {
        injected = true;
        throw new Error("commit acknowledgement lost");
      }
      return changed;
    });

    await claimManager.processQueue();
    await awaitSleepPromise(100, () => claimManager.getTransactionQueue().some((claim) => {
      return claim.session === session.sessionId && claim.claim.claimStatus === ClaimTxStatus.PENDING;
    }));

    expect(injected).to.equal(true);
    expect(globalStubs["EthWalletManager.reserveClaimTx"].calledOnce).to.equal(true);
    expect(globalStubs["EthWalletManager.cancelClaimTx"].called).to.equal(false, "ambiguous PREPARED commit released its liability");
    expect((await database.getSession(session.sessionId)).claim.claimStatus).to.equal(ClaimTxStatus.PENDING);
  });

  it("restores a prepared claim by rebroadcasting its exact bytes without resigning", async () => {
    let transaction = getTestTransaction(17);
    let session = await addTestSession(FaucetSessionStatus.CLAIMING, {
      claimFormat: 2,
      claimIdx: 8,
      claimStatus: ClaimTxStatus.PREPARED,
      claimTime: Math.floor(Date.now() / 1000),
      ...transaction,
    });
    globalStubs["EthWalletManager.broadcastClaimTx"].rejects("ambiguous RPC response");

    let claimManager = ServiceManager.GetService(EthClaimManager);
    (claimManager as any).broadcastRetryDelay = 10;
    await claimManager.initialize();
    await awaitSleepPromise(100, () => globalStubs["EthWalletManager.broadcastClaimTx"].callCount >= 2);

    expect(globalStubs["EthWalletManager.prepareClaimTx"].called).to.equal(false, "restart resigned the prepared claim");
    expect(globalStubs["EthWalletManager.reserveClaimTx"].calledOnce).to.equal(true, "restored nonce was not reserved exactly once");
    let broadcasts = globalStubs["EthWalletManager.broadcastClaimTx"].getCalls().map((call) => call.args[0]);
    expect(broadcasts.length).to.be.greaterThanOrEqual(2, "prepared claim was not retried");
    expect(broadcasts.every((broadcast) => JSON.stringify(broadcast) === JSON.stringify(transaction))).to.equal(true, "restart changed the signed transaction");
    expect((await ServiceManager.GetService(FaucetDatabase).getSession(session.sessionId)).claim.claimStatus).to.equal(ClaimTxStatus.PREPARED, "ambiguous retry changed durable state");
  });

  it("reinitializes the same claim manager without duplicating restored liabilities", async () => {
    let transaction = getTestTransaction(18);
    let session = await addTestSession(FaucetSessionStatus.CLAIMING, {
      claimFormat: 2,
      claimIdx: 8,
      claimStatus: ClaimTxStatus.PREPARED,
      claimTime: Math.floor(Date.now() / 1000),
      ...transaction,
    });
    globalStubs["EthWalletManager.broadcastClaimTx"].rejects("ambiguous RPC response");

    let claimManager = ServiceManager.GetService(EthClaimManager);
    (claimManager as any).broadcastRetryDelay = 10;
    await claimManager.initialize();
    await awaitSleepPromise(100, () => globalStubs["EthWalletManager.broadcastClaimTx"].called);
    await claimManager.dispose();

    await claimManager.initialize();
    await awaitSleepPromise(100, () => globalStubs["EthWalletManager.reserveClaimTx"].callCount === 2);
    let restored = claimManager.getTransactionQueue().filter((claim) => claim.session === session.sessionId);
    expect(restored).to.have.length(1, "same-instance restart duplicated the restored claim");
    expect(globalStubs["EthWalletManager.reserveClaimTx"].callCount).to.equal(2, "restart reserved the liability more than once per lifecycle");
  });

  it("confirms from a receipt when every broadcast acknowledgement is lost", async () => {
    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let session = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);
    let claim = await claimManager.createSessionClaim(session, {});
    globalStubs["getWalletState"] = sinon.stub(EthWalletManager.prototype, "getWalletState").returns({
      ready: true,
      nonce: 0,
      balance: 1000000000000000000n,
      nativeBalance: 1000000000000000000n,
    });
    globalStubs["EthWalletManager.broadcastClaimTx"].rejects("response lost after acceptance");
    globalStubs["EthWalletManager.watchClaimTx"].resolves({
      status: true,
      block: 42,
      fee: 100n,
      receipt: getTestReceipt(),
    });

    await claimManager.processQueue();
    await awaitSleepPromise(200, () => claim.claim.claimStatus === ClaimTxStatus.CONFIRMED);

    expect(globalStubs["EthWalletManager.broadcastClaimTx"].called).to.equal(true, "claim was never broadcast");
    expect(claim.claim.claimStatus).to.equal(ClaimTxStatus.CONFIRMED, "receipt did not settle a prepared claim");
    expect(claim.claim.txHex).to.equal(getTestTransaction(0).txHex, "receipt reconciliation changed the signed bytes");
    expect((await ServiceManager.GetService(FaucetDatabase).getSession(session.sessionId)).claim.claimStatus).to.equal(ClaimTxStatus.CONFIRMED, "receipt confirmation was not durable");
  });

  it("quarantines legacy PROCESSING without replaying it", async () => {
    let session = await addTestSession(FaucetSessionStatus.CLAIMING, {
      claimIdx: 4,
      claimStatus: "processing",
      claimTime: Math.floor(Date.now() / 1000),
      txHash: "0x" + "ab".repeat(32),
    });

    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();

    expect(globalStubs["EthWalletManager.prepareClaimTx"].called).to.equal(false, "legacy PROCESSING was resigned");
    expect(globalStubs["EthWalletManager.broadcastClaimTx"].called).to.equal(false, "legacy PROCESSING was replayed");
    expect(globalStubs["EthWalletManager.watchClaimTx"].called).to.equal(false, "legacy PROCESSING entered automatic reconciliation");
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.sessionId);
    expect(storedSession.status).to.equal(FaucetSessionStatus.CLAIMING, "quarantine changed the session status");
    expect(storedSession.claim.claimStatus).to.equal("processing", "quarantine rewrote legacy evidence");
  });

  it("runs confirmation hooks only for the winning terminal CAS", async () => {
    let transaction = getTestTransaction(19);
    let session = await addTestSession(FaucetSessionStatus.CLAIMING, {
      claimFormat: 2,
      claimIdx: 9,
      claimStatus: ClaimTxStatus.PENDING,
      claimTime: Math.floor(Date.now() / 1000),
      ...transaction,
    });
    let hookCalls = 0;
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionClaimed, 100, "terminal-cas-test", () => {
      hookCalls++;
    });

    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let persistedClaim = (await ServiceManager.GetService(FaucetDatabase).getSession(session.sessionId)).claim;
    let claimInfos: EthClaimInfo[] = [0, 1].map(() => ({
      session: session.sessionId,
      target: session.targetAddr,
      amount: session.dropAmount,
      claim: JSON.parse(JSON.stringify(persistedClaim)),
    }));
    let receipt = {
      status: true,
      block: 42,
      fee: 100n,
      receipt: getTestReceipt(),
    };

    await Promise.all(claimInfos.map((claimInfo) => (claimManager as any).settleClaim(claimInfo, receipt)));
    expect(hookCalls).to.equal(1, "terminal hook ran without winning the CAS");
    expect((await ServiceManager.GetService(FaucetDatabase).getSession(session.sessionId)).claim.claimStatus).to.equal(ClaimTxStatus.CONFIRMED, "terminal CAS did not persist confirmation");
  });

  it("resumes required accounting from a receipt-confirmed CLAIMING session", async () => {
    let transaction = getTestTransaction(20);
    let session = await addTestSession(FaucetSessionStatus.CLAIMING, {
      claimFormat: 2,
      claimIdx: 10,
      claimStatus: ClaimTxStatus.CONFIRMED,
      claimTime: Math.floor(Date.now() / 1000),
      ...transaction,
      txBlock: 42,
      txFee: "100",
    });
    let hookCalls = 0;
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionClaimed, 100, "confirmed-restart-test", () => {
      hookCalls++;
    });

    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    await awaitSleepPromise(100, () => globalStubs["EthWalletManager.releaseClaimTx"].calledOnce);
    let storedSession = await ServiceManager.GetService(FaucetDatabase).getSession(session.sessionId);

    expect(hookCalls).to.equal(1);
    expect(storedSession.status).to.equal(FaucetSessionStatus.FINISHED, "restart did not cross the accounting terminal barrier");
    expect(storedSession.claim.claimStatus).to.equal(ClaimTxStatus.CONFIRMED);
  });

  it("reconciles a FINISHED CAS that commits before its acknowledgement fails", async () => {
    faucetConfig.sessionCleanup = 10;
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

    let transaction = getTestTransaction(21);
    let session = await addTestSession(FaucetSessionStatus.CLAIMING, {
      claimFormat: 2,
      claimIdx: 11,
      claimStatus: ClaimTxStatus.CONFIRMED,
      claimTime: Math.floor(Date.now() / 1000),
      ...transaction,
      txBlock: 42,
      txFee: "100",
    });
    session.startTime = Math.floor(Date.now() / 1000) - 60;
    expect(await ServiceManager.GetService(FaucetDatabase).updateSession(session)).to.equal(true);
    let hookCalls = 0;
    moduleManager.addActionHook(null, ModuleHookAction.SessionClaimed, 100, "finished-commit-test", () => {
      hookCalls++;
    });

    let database = ServiceManager.GetService(FaucetDatabase);
    let originalFinalize = database.finalizeConfirmedClaim.bind(database);
    let injected = false;
    globalStubs["FaucetDatabase.finalizeConfirmedClaim"] = sinon.stub(database, "finalizeConfirmedClaim").callsFake(async (sessionId, claim) => {
      let changed = await originalFinalize(sessionId, claim);
      if(!injected && changed) {
        injected = true;
        await database.cleanStore();
        throw new Error("commit acknowledgement lost");
      }
      return changed;
    });

    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    await awaitSleepPromise(100, () => globalStubs["EthWalletManager.releaseClaimTx"].calledOnce);
    let storedSession = await database.getSession(session.sessionId);

    expect(injected).to.equal(true);
    expect(hookCalls).to.equal(1, "ambiguous FINISHED acknowledgement replayed required accounting");
    expect(storedSession.status).to.equal(FaucetSessionStatus.FINISHED);
    let persistedOutflow = JSON.parse(await database.getKeyValueEntry("PoWOutflowLimiter.state"));
    expect(persistedOutflow.accountedClaimFees[session.claim.txHash]).to.equal(session.sessionId);

    await moduleManager.getModule<FaucetOutflowModule>("faucet-outflow").saveOutflowState();
    await database.cleanStore();
    expect(await database.getSession(session.sessionId)).to.equal(null);
  });

  it("stops admission and drains queue mutation work during disposal", async () => {
    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let httpServer = ServiceManager.GetService(FaucetHttpServer);
    expect((httpServer as any).wssEndpoints.claim).to.not.equal(undefined, "claim endpoint was not registered");
    let session = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);
    await claimManager.createSessionClaim(session, {});
    globalStubs["getWalletState"] = sinon.stub(EthWalletManager.prototype, "getWalletState").returns({
      ready: true,
      nonce: 0,
      balance: 1000000000000000000n,
      nativeBalance: 1000000000000000000n,
    });
    let preparationFuse = createFuse();
    globalStubs["EthWalletManager.prepareClaimTx"].returns(fusedSleep(preparationFuse).then(() => getTestTransaction(0)));

    void claimManager.processQueue();
    await awaitSleepPromise(100, () => globalStubs["EthWalletManager.prepareClaimTx"].called);
    let firstDrain = claimManager.dispose();
    expect(claimManager.dispose()).to.equal(firstDrain, "dispose did not return its existing drain promise");
    await firstDrain;
    expect((httpServer as any).wssEndpoints.claim).to.equal(undefined, "claim endpoint remained registered after disposal");

    let admissionError: FaucetError = null;
    try {
      await claimManager.createSessionClaim(JSON.parse(JSON.stringify(session)), {});
    } catch(ex) {
      admissionError = ex;
    }
    expect(admissionError?.getCode()).to.equal("SHUTTING_DOWN", "claim admission remained open during shutdown");
    expect(globalStubs["EthWalletManager.broadcastClaimTx"].called).to.equal(false, "aborted queue preparation reached broadcast");
    expect((await ServiceManager.GetService(FaucetDatabase).getSession(session.sessionId)).claim.claimStatus).to.equal(ClaimTxStatus.QUEUE, "shutdown changed the durable queued claim");
    preparationFuse();
  });

  it("leaves a late in-flight broadcast safely recoverable from durable bytes", async () => {
    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let session = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);
    await claimManager.createSessionClaim(session, {});
    globalStubs["getWalletState"] = sinon.stub(EthWalletManager.prototype, "getWalletState").returns({
      ready: true,
      nonce: 0,
      balance: 1000000000000000000n,
      nativeBalance: 1000000000000000000n,
    });
    let broadcastFuse = createFuse();
    globalStubs["EthWalletManager.broadcastClaimTx"].callsFake(() => fusedSleep(broadcastFuse));

    await claimManager.processQueue();
    await awaitSleepPromise(100, () => globalStubs["EthWalletManager.broadcastClaimTx"].calledOnce);
    let firstBroadcast = globalStubs["EthWalletManager.broadcastClaimTx"].firstCall.args[0];
    let persistedBeforeShutdown = await ServiceManager.GetService(FaucetDatabase).getSession(session.sessionId);
    expect(persistedBeforeShutdown.claim.claimStatus).to.equal(ClaimTxStatus.PREPARED, "broadcast started without durable prepared state");
    expect(persistedBeforeShutdown.claim.txHex).to.equal(firstBroadcast.txHex, "in-flight bytes differ from durable bytes");

    await claimManager.dispose();
    broadcastFuse();
    await sleepPromise(10);
    expect((await ServiceManager.GetService(FaucetDatabase).getSession(session.sessionId)).claim.claimStatus).to.equal(ClaimTxStatus.PREPARED, "late broadcast acknowledgement changed state after shutdown");

    globalStubs["EthWalletManager.broadcastClaimTx"].rejects("ambiguous restart response");
    let restartedManager = new EthClaimManager();
    (restartedManager as any).broadcastRetryDelay = 10;
    await restartedManager.initialize();
    await awaitSleepPromise(100, () => globalStubs["EthWalletManager.broadcastClaimTx"].callCount >= 2);
    let restartedBroadcast = globalStubs["EthWalletManager.broadcastClaimTx"].getCall(1).args[0];
    expect(restartedBroadcast).to.deep.equal(firstBroadcast, "restart did not rebroadcast the exact durable transaction");
    expect(globalStubs["EthWalletManager.prepareClaimTx"].calledOnce).to.equal(true, "restart resigned the prepared claim");
    await restartedManager.dispose();
  });

  it("Load stored claim queue", async () => {
    await addTestSession(FaucetSessionStatus.CLAIMING, {
      claimFormat: 2,
      claimIdx: 5,
      claimStatus: ClaimTxStatus.QUEUE,
      claimTime: Math.floor(new Date().getTime() / 1000),
    });
    await addTestSession(FaucetSessionStatus.CLAIMING, {
      claimIdx: 3,
      claimStatus: "unknown",
      claimTime: Math.floor(new Date().getTime() / 1000),
      txHash: "0xdb5950d44ceed2a5eb77970104b974b8c4234d7110fd8d0008edb2cfff835f04"
    });
    await addTestSession(FaucetSessionStatus.CLAIMING, {
      claimFormat: 2,
      claimIdx: 2,
      claimStatus: ClaimTxStatus.PENDING,
      claimTime: Math.floor(new Date().getTime() / 1000),
      ...getTestTransaction(2),
    });
    let ses4 = await addTestSession(FaucetSessionStatus.CLAIMING, {
      claimFormat: 2,
      claimIdx: 2,
      claimStatus: ClaimTxStatus.QUEUE,
      claimTime: Math.floor(new Date().getTime() / 1000),
    });

    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();

    expect(claimManager.getQueuedAmount()).to.equal(300n, "queued balance omitted a pending claim");
    let txQueue = claimManager.getTransactionQueue(true);
    expect(txQueue.length).to.equal(2, "unexpected queue length");
    expect(txQueue[0].session).to.equal(ses4.sessionId, "unexpected queue order");
  });

  it("Check restored pending claim processing", async () => {
    let ses1 = await addTestSession(FaucetSessionStatus.CLAIMING, {
      claimFormat: 2,
      claimIdx: 2,
      claimStatus: ClaimTxStatus.PENDING,
      claimTime: Math.floor(new Date().getTime() / 1000),
      ...getTestTransaction(11),
    });
    let ses2 = await addTestSession(FaucetSessionStatus.CLAIMING, {
      claimFormat: 2,
      claimIdx: 2,
      claimStatus: ClaimTxStatus.PENDING,
      claimTime: Math.floor(new Date().getTime() / 1000),
      ...getTestTransaction(12),
    });
    let ses3 = await addTestSession(FaucetSessionStatus.CLAIMING, {
      claimFormat: 2,
      claimIdx: 2,
      claimStatus: ClaimTxStatus.PENDING,
      claimTime: Math.floor(new Date().getTime() / 1000),
      ...getTestTransaction(13),
    });

    let txResFuse: any = {};
    let txResults: {[txHash: string]: Promise<{
      status: boolean;
      block: number;
      fee: bigint;
      receipt: any;
    }>} = {
      [getTestTransaction(11).txHash]: awaitSleepPromise(200, () => txResFuse.ses1).then(() => ({
        status: true,
        block: 1,
        fee: 100n,
        receipt: Object.assign(getTestReceipt()),
      })),
      [getTestTransaction(12).txHash]: awaitSleepPromise(200, () => txResFuse.ses2).then(() => ({
        status: true,
        block: 1,
        fee: 100n,
        receipt: Object.assign(getTestReceipt()),
      })),
      [getTestTransaction(13).txHash]: awaitSleepPromise(200, () => txResFuse.ses3).then(() => {
        throw "test error";
      }),
    };
    globalStubs["EthWalletManager.watchClaimTx"].callsFake((transaction) => txResults[transaction.txHash]);

    let claimed: {[s: string]: EthClaimInfo} = {};
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionClaimed, 100, "test-task", (claimInfo: EthClaimInfo) => {
      claimed[claimInfo.session] = claimInfo;
    });

    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();

    txResFuse.ses1 = true;
    await awaitSleepPromise(500, () => !!claimed[ses1.sessionId]);
    expect(claimed[ses1.sessionId]?.claim.claimStatus).to.equal(ClaimTxStatus.CONFIRMED, "unexpected ses1 claim status");

    txResFuse.ses2 = true;
    await awaitSleepPromise(500, () => !!claimed[ses2.sessionId]);
    expect(claimed[ses2.sessionId]?.claim.claimStatus).to.equal(ClaimTxStatus.CONFIRMED, "unexpected ses2 claim status");

    txResFuse.ses3 = true;
    let claim3 = claimManager.getTransactionQueue().filter(t => t.session === ses3.sessionId)[0];
    await sleepPromise(100);
    expect(claim3?.claim.claimStatus).to.equal(ClaimTxStatus.PENDING, "receipt transport failure made the claim terminal");
  });

  it("Create session claim, Invalid: session not claimable", async () => {
    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let testSession = await addTestSession(FaucetSessionStatus.FAILED, null);

    let error: FaucetError | null = null;
    try {
      await claimManager.createSessionClaim(testSession, {});
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("NOT_CLAIMABLE", "unexpected error code");
    expect(claimManager.getTransactionQueue().length).to.equal(0, "unexpected queue count");
  });

  it("Create session claim, Invalid: already claiming", async () => {
    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionClaim, 100, "test-task", (claimInfo: EthClaimInfo) => {
      return sleepPromise(50);
    });
    let testSession = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);
    claimManager.createSessionClaim(testSession, {});

    let error: FaucetError | null = null;
    try {
      await claimManager.createSessionClaim(testSession, {});
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("RACE_CLAIMING", "unexpected error code");
    expect(claimManager.getTransactionQueue().length).to.equal(1, "unexpected queue count");
  });

  it("Create session claim, Invalid: amount too low", async () => {
    faucetConfig.minDropAmount = 200;
    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let testSession = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);

    let error: FaucetError | null = null;
    try {
      await claimManager.createSessionClaim(testSession, {});
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("AMOUNT_TOO_LOW", "unexpected error code");
    expect(claimManager.getTransactionQueue().length).to.equal(0, "unexpected queue count");
  });

  it("Create session claim: Trim too high amount", async () => {
    faucetConfig.maxDropAmount = 50;
    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let testSession = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);

    let claim = await claimManager.createSessionClaim(testSession, {});
    expect(claim.claim.claimStatus).to.equal(ClaimTxStatus.QUEUE, "unexpected claim status");
    expect(claim.amount).to.equal("50", "unexpected claim amount");
    expect(claimManager.getTransactionQueue().length).to.equal(1, "unexpected queue count");

    let sessionData = await ServiceManager.GetService(SessionManager).getSessionData(testSession.sessionId);
    expect(sessionData.status).to.equal(FaucetSessionStatus.CLAIMING, "unexpected session status");
    expect(sessionData.dropAmount).to.equal("50", "unexpected session drop amount");
  });

  it("Queue processing: Check processing if wallet not ready (skip)", async () => {
    faucetConfig.ethQueueNoFunds = true;
    
    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let testSession = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);

    let claim = await claimManager.createSessionClaim(testSession, {});
    expect(claim.claim.claimStatus).to.equal(ClaimTxStatus.QUEUE, "unexpected claim status before processQueue");
    
    globalStubs["getWalletState"] = sinon.stub(EthWalletManager.prototype, "getWalletState").returns({
      ready: false,
      nonce: 0,
      balance: 0n,
      nativeBalance: 0n,
    });
    await claimManager.processQueue();

    expect(claim.claim.claimStatus).to.equal(ClaimTxStatus.QUEUE, "unexpected claim status after processQueue");
  });

  it("Queue processing: Check processing if wallet not ready (fail)", async () => {
    faucetConfig.ethQueueNoFunds = false;

    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let testSession = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);

    let claim = await claimManager.createSessionClaim(testSession, {});
    expect(claim.claim.claimStatus).to.equal(ClaimTxStatus.QUEUE, "unexpected claim status before processQueue");
    
    globalStubs["getWalletState"] = sinon.stub(EthWalletManager.prototype, "getWalletState").returns({
      ready: false,
      nonce: 0,
      balance: 0n,
      nativeBalance: 0n,
    });
    await claimManager.processQueue();

    expect(claim.claim.claimStatus).to.equal(ClaimTxStatus.FAILED, "unexpected claim status after processQueue");
    expect(claim.claim.txError).to.matches(/RPC is currently unreachable/, "unexpected claim error message");
  });

  it("Queue processing: Check processing if wallet is out of funds (fail)", async () => {
    faucetConfig.ethQueueNoFunds = false;

    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let testSession = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);

    let claim = await claimManager.createSessionClaim(testSession, {});
    expect(claim.claim.claimStatus).to.equal(ClaimTxStatus.QUEUE, "unexpected claim status before processQueue");
    
    globalStubs["getWalletState"] = sinon.stub(EthWalletManager.prototype, "getWalletState").returns({
      ready: true,
      nonce: 0,
      balance: 10n,
      nativeBalance: 10n,
    });
    globalStubs["EthWalletManager.canReserveClaimTx"].returns(false);
    await claimManager.processQueue();

    expect(claim.claim.claimStatus).to.equal(ClaimTxStatus.FAILED, "unexpected claim status after processQueue");
    expect(claim.claim.txError).to.matches(/wallet is out of funds/, "unexpected claim error message");
  });

  it("Queue processing: Check processing if transaction fails unexpectedly (fail)", async () => {
    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let testSession = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);

    let claim = await claimManager.createSessionClaim(testSession, {});
    expect(claim.claim.claimStatus).to.equal(ClaimTxStatus.QUEUE, "unexpected claim status before processQueue");
    
    globalStubs["getWalletState"] = sinon.stub(EthWalletManager.prototype, "getWalletState").returns({
      ready: true,
      nonce: 0,
      balance: 1000000000000000000n,
      nativeBalance: 1000000000000000000n,
    });
    globalStubs["EthWalletManager.prepareClaimTx"].rejects("test error");

    await claimManager.processQueue();

    expect(claim.claim.claimStatus).to.equal(ClaimTxStatus.FAILED, "unexpected claim status after processQueue");
    expect(claim.claim.txError).to.matches(/test error/, "unexpected claim error message");
  });

  it("Queue processing: Check processing if transaction creation fails unexpectedly", async () => {
    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let testSession = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);

    let claim = await claimManager.createSessionClaim(testSession, {});
    expect(claim.claim.claimStatus).to.equal(ClaimTxStatus.QUEUE, "unexpected claim status before processQueue");
    
    globalStubs["getWalletState"] = sinon.stub(EthWalletManager.prototype, "getWalletState").returns({
      ready: true,
      nonce: 0,
      balance: 1000000000000000000n,
      nativeBalance: 1000000000000000000n,
    });
    let claimFuse = createFuse();
    globalStubs["EthWalletManager.prepareClaimTx"].returns(fusedSleep(claimFuse, 500).then(() => {
      throw "test error";
    }));

    let processPromise = claimManager.processQueue();
    expect(claim.claim.claimStatus).to.equal(ClaimTxStatus.QUEUE, "claim left its durable queue state before preparation completed");

    claimFuse();
    await processPromise;

    expect(claim.claim.claimStatus).to.equal(ClaimTxStatus.FAILED, "unexpected claim status after processQueue");
    expect(claim.claim.txError).to.matches(/test error/, "unexpected claim error message");
  });

  it("Queue processing: Keep a claim active if receipt reconciliation fails", async () => {
    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let testSession = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);

    let claim = await claimManager.createSessionClaim(testSession, {});
    expect(claim.claim.claimStatus).to.equal(ClaimTxStatus.QUEUE, "unexpected claim status before processQueue");
    
    globalStubs["getWalletState"] = sinon.stub(EthWalletManager.prototype, "getWalletState").returns({
      ready: true,
      nonce: 0,
      balance: 1000000000000000000n,
      nativeBalance: 1000000000000000000n,
    });
    let claimFuse = createFuse();
    globalStubs["EthWalletManager.watchClaimTx"].returns(fusedSleep(claimFuse, 500).then(() => {
      throw "test error";
    }));

    await claimManager.processQueue();
    await awaitSleepPromise(100, () => claim.claim.claimStatus === ClaimTxStatus.PENDING);
    expect(claim.claim.claimStatus).to.equal(ClaimTxStatus.PENDING, "unexpected claim status after processQueue");

    claimFuse();
    await sleepPromise(100);
    expect(claim.claim.claimStatus).to.equal(ClaimTxStatus.PENDING, "receipt transport failure made the claim terminal");
  });

  it("Queue processing: Check processing for successful transaction", async () => {
    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let testSession = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);

    let claim = await claimManager.createSessionClaim(testSession, {});
    expect(claim.claim.claimStatus).to.equal(ClaimTxStatus.QUEUE, "unexpected claim status before processQueue");
    
    globalStubs["getWalletState"] = sinon.stub(EthWalletManager.prototype, "getWalletState").returns({
      ready: true,
      nonce: 0,
      balance: 1000000000000000000n,
      nativeBalance: 1000000000000000000n,
    });
    let claimFuse = createFuse();
    globalStubs["EthWalletManager.watchClaimTx"].returns(fusedSleep(claimFuse, 500).then(() => ({
      status: true,
      block: 1,
      fee: 100n,
      receipt: getTestReceipt(),
    })));

    await claimManager.processQueue();
    await awaitSleepPromise(100, () => claim.claim.claimStatus === ClaimTxStatus.PENDING);
    expect(claim.claim.claimStatus).to.equal(ClaimTxStatus.PENDING, "unexpected claim status after processQueue");

    claimFuse();
    await awaitSleepPromise(1000, () => claim.claim.claimStatus === ClaimTxStatus.CONFIRMED);

    expect(claim.claim.claimStatus).to.equal(ClaimTxStatus.CONFIRMED, "unexpected claim status after tx confirmation");
  });

  it("Notification Websocket: Check initialization (invalid url)", async () => {
    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();

    let fakeWs1 = await injectFakeWebSocket("/ws/claim?session=session=[]12&&session=false", "8.8.8.8");
    let errorMsg = fakeWs1.getSentMessage("error");
    expect(errorMsg.length).to.equal(1, "no error message returned");
    expect(errorMsg[0].data.reason).to.matches(/session not found/, "unexpected error message returned");
  });

  it("Notification Websocket: Check initialization (missing session id)", async () => {
    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();

    let fakeWs1 = await injectFakeWebSocket("/ws/claim", "8.8.8.8");
    let errorMsg = fakeWs1.getSentMessage("error");
    expect(errorMsg.length).to.equal(1, "no error message returned");
    expect(errorMsg[0].data.reason).to.matches(/session not found/, "unexpected error message returned");
  });

  it("Notification Websocket: Check claim notifications", async () => {
    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let testSession1 = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);
    let claim1 = await claimManager.createSessionClaim(testSession1, {});
    let testSession2 = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);
    let claim2 = await claimManager.createSessionClaim(testSession2, {});
    
    globalStubs["getWalletState"] = sinon.stub(EthWalletManager.prototype, "getWalletState").returns({
      ready: true,
      nonce: 0,
      balance: 1000000000000000000n,
      nativeBalance: 1000000000000000000n,
    });
    let claimFuses: (() => void)[] = [];
    let preparedNonce = 0;
    globalStubs["EthWalletManager.prepareClaimTx"].callsFake(() => Promise.resolve(getTestTransaction(preparedNonce++)));
    globalStubs["EthWalletManager.watchClaimTx"].callsFake(() => {
      let claimFuse = createFuse();
      claimFuses.push(claimFuse);
      return fusedSleep(claimFuse, 500).then(() => ({
        status: true,
        block: 1,
        fee: 100n,
        receipt: getTestReceipt(),
      }));
    });

    let fakeWs2 = await injectFakeWebSocket("/ws/claim?session=" + testSession2.sessionId, "8.8.8.8");
    expect(fakeWs2.isReady).to.equal(true, "websocket2 was closed");

    await claimManager.processQueue();
    await awaitSleepPromise(100, () => claim1.claim.claimStatus === ClaimTxStatus.PENDING && claim2.claim.claimStatus === ClaimTxStatus.PENDING);
    expect(claim1.claim.claimStatus).to.equal(ClaimTxStatus.PENDING, "unexpected claim1 status after processQueue");
    expect(claim2.claim.claimStatus).to.equal(ClaimTxStatus.PENDING, "unexpected claim2 status after processQueue");

    let fakeWs1 = await injectFakeWebSocket("/ws/claim?session=" + testSession1.sessionId, "8.8.8.8");
    expect(fakeWs1.isReady).to.equal(true, "websocket1 was closed");
    await awaitSleepPromise(100, () => fakeWs1.getSentMessage("update").length > 1);
    let updateMsg = fakeWs1.getSentMessage("update");
    expect(updateMsg.length).to.equal(1, "no update message sent");
    expect(updateMsg[updateMsg.length - 1].data.processedIdx).to.equal(2, "unexpected processed count in last update");

    updateMsg = fakeWs2.getSentMessage("update");
    expect(updateMsg.length).to.equal(1, "no update message sent");
    expect(updateMsg[updateMsg.length - 1].data.processedIdx).to.equal(2, "unexpected processed count in last update");

    claimFuses[0]();
    await awaitSleepPromise(100, () => claim1.claim.claimStatus === ClaimTxStatus.CONFIRMED);
    await claimManager.processQueue();
    await awaitSleepPromise(100, () => fakeWs2.getSentMessage("update").length > 2);

    updateMsg = fakeWs2.getSentMessage("update");
    expect(updateMsg.length).to.equal(2, "no update message sent on 1st confirmation");
    expect(updateMsg[updateMsg.length - 1].data.processedIdx).to.equal(2, "unexpected processed count in last update");
    expect(updateMsg[updateMsg.length - 1].data.confirmedIdx).to.equal(1, "unexpected confirmed count in last update");

    claimFuses[1]();
    await awaitSleepPromise(100, () => claim2.claim.claimStatus === ClaimTxStatus.CONFIRMED);
    await claimManager.processQueue();
    await awaitSleepPromise(100, () => fakeWs2.getSentMessage("update").length > 3);

    updateMsg = fakeWs2.getSentMessage("update");
    expect(updateMsg.length).to.equal(3, "no update message sent on 2nd confirmation");
    expect(updateMsg[updateMsg.length - 1].data.processedIdx).to.equal(2, "unexpected processed count in last update");
    expect(updateMsg[updateMsg.length - 1].data.confirmedIdx).to.equal(2, "unexpected confirmed count in last update");

    let errorMsg = fakeWs2.getSentMessage("error");
    expect(errorMsg.length).to.equal(1, "no error message sent after confirmation");
  });

  it("Notification Websocket: Check ping timeout handling", async () => {
    EthClaimNotificationClient.cfgPingInterval = 1;
    EthClaimNotificationClient.cfgPingTimeout = 2;
    globalStubs["FakeWebSocket.ping"] = sinon.stub(FakeWebSocket.prototype, "ping");
    globalStubs["FakeWebSocket.pong"] = sinon.stub(FakeWebSocket.prototype, "pong");

    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let testSession1 = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);
    await claimManager.createSessionClaim(testSession1, {});

    let fakeSocket = await injectFakeWebSocket("/ws/claim?session=" + testSession1.sessionId, "8.8.8.8");
    expect(fakeSocket.isReady).to.equal(true, "websocket1 was closed");

    fakeSocket.emit("pong");
    fakeSocket.emit("ping");
    expect(globalStubs["FakeWebSocket.pong"].called).to.equal(true, "pong not called");
    expect(globalStubs["FakeWebSocket.ping"].called).to.equal(false, "unexpected ping call");
    await awaitSleepPromise(1100, () => globalStubs["FakeWebSocket.ping"].called);
    expect(fakeSocket.isReady).to.equal(true, "client not ready");
    expect(globalStubs["FakeWebSocket.ping"].called).to.equal(true, "ping not called");
    expect(fakeSocket.isReady).to.equal(true, "unexpected close call");
    await awaitSleepPromise(3000, () => !fakeSocket.isReady);
    expect(fakeSocket.isReady).to.equal(false, "client is still ready");
  }).timeout(5000);

  it("Notification Websocket: Check client error handling", async () => {
    let claimManager = ServiceManager.GetService(EthClaimManager);
    await claimManager.initialize();
    let testSession1 = await addTestSession(FaucetSessionStatus.CLAIMABLE, null);
    await claimManager.createSessionClaim(testSession1, {});

    let fakeSocket = await injectFakeWebSocket("/ws/claim?session=" + testSession1.sessionId, "8.8.8.8");
    expect(fakeSocket.isReady).to.equal(true, "websocket1 was closed");

    fakeSocket.emit("error", "test error");
    fakeSocket.emit("close");
    expect(fakeSocket.isReady).to.equal(false, "client still ready");
  });
  
});
