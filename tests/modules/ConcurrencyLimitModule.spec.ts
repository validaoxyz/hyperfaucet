import 'mocha';
import { expect } from 'chai';
import { bindTestStubs, unbindTestStubs, loadDefaultTestConfig } from '../common.js';
import { ServiceManager } from '../../src/common/ServiceManager.js';
import { FaucetDatabase } from '../../src/db/FaucetDatabase.js';
import { ModuleHookAction, ModuleManager } from '../../src/modules/ModuleManager.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { faucetConfig } from '../../src/config/FaucetConfig.js';
import { FaucetError } from '../../src/common/FaucetError.js';
import { IConcurrencyLimitConfig } from '../../src/modules/concurrency-limit/ConcurrencyLimitConfig.js';
import { ConcurrencyLimitModule } from '../../src/modules/concurrency-limit/ConcurrencyLimitModule.js';
import { FaucetSession, FaucetSessionStatus } from '../../src/session/FaucetSession.js';


describe("Faucet module: concurrency-limit", () => {
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

  async function runTestSession(ip: string, addr: string, expectedStatus?: string): Promise<FaucetSession> {
    let sessionManager = ServiceManager.GetService(SessionManager);
    let testSession = await sessionManager.createSession(ip, {
      addr: addr,
    });
    if(expectedStatus)
      expect(testSession.getSessionStatus()).to.equal(expectedStatus, "unexpected session status");
    return testSession;
  }

  function configureConcurrencyLimit(overrides: Record<string, unknown> = {}): void {
    faucetConfig.modules["concurrency-limit"] = {
      enabled: true,
      concurrencyLimit: 1,
      byAddrOnly: false,
      byIPOnly: false,
      messageByAddr: null,
      messageByIP: null,
      ...overrides,
    } as unknown as IConcurrencyLimitConfig;
  }

  async function captureSessionError(ip: string, addr: string): Promise<unknown> {
    try {
      await runTestSession(ip, addr);
      return null;
    } catch(ex) {
      return ex;
    }
  }

  function expectConcurrencyError(error: unknown, message: RegExp): void {
    expect(error).to.be.instanceOf(FaucetError);
    if(!(error instanceof FaucetError))
      throw error;
    expect(error.getCode()).to.equal("CONCURRENCY_LIMIT");
    expect(error.message).to.match(message);
  }

  async function captureInitializationError(): Promise<unknown> {
    try {
      await ServiceManager.GetService(ModuleManager).initialize();
      return null;
    } catch(ex) {
      return ex;
    }
  }

  function addBlockingSessionHook(): void {
    ServiceManager.GetService(ModuleManager).addActionHook(
      null,
      ModuleHookAction.SessionStart,
      100,
      "test-task",
      (session: FaucetSession) => session.addBlockingTask("test", "test1", 10),
    );
  }

  const validScopes = [
    {
      name: "IP",
      flags: {byIPOnly: true},
      allowed: {ip: "8.8.4.4", addr: "0x0000000000000000000000000000000000001337"},
      denied: [{ip: "8.8.8.8", addr: "0x0000000000000000000000000000000000001338"}],
      message: /per IP/,
    },
    {
      name: "address",
      flags: {byAddrOnly: true},
      allowed: {ip: "8.8.8.8", addr: "0x0000000000000000000000000000000000001338"},
      denied: [{ip: "8.8.4.4", addr: "0x0000000000000000000000000000000000001337"}],
      message: /per wallet address/,
    },
    {
      name: "IP or address",
      flags: {},
      allowed: {ip: "8.8.4.4", addr: "0x0000000000000000000000000000000000001338"},
      denied: [
        {ip: "8.8.8.8", addr: "0x0000000000000000000000000000000000001339"},
        {ip: "1.1.1.1", addr: "0x0000000000000000000000000000000000001337"},
      ],
      message: /per (IP|wallet address)/,
    },
  ];

  for(let scope of validScopes) {
    it(`enforces the ${scope.name} scope`, async () => {
      configureConcurrencyLimit(scope.flags);
      await ServiceManager.GetService(ModuleManager).initialize();
      addBlockingSessionHook();

      await runTestSession("8.8.8.8", "0x0000000000000000000000000000000000001337", "running");
      await runTestSession(scope.allowed.ip, scope.allowed.addr, "running");
      for(let denied of scope.denied) {
        let error = await captureSessionError(denied.ip, denied.addr);
        expectConcurrencyError(error, scope.message);
      }
    });
  }

  it("rejects mutually exclusive legacy scope flags", async () => {
    configureConcurrencyLimit({byAddrOnly: true, byIPOnly: true});
    let error = await captureInitializationError();
    expect(String(error)).to.include("byAddrOnly and byIPOnly cannot both be true");
  });

  for(let [field, value, message] of [
    ["enabled", "true", "enabled must be a boolean"],
    ["byAddrOnly", "true", "byAddrOnly must be a boolean"],
    ["byIPOnly", 1, "byIPOnly must be a boolean"],
    ["messageByAddr", 1, "messageByAddr must be a string or null"],
    ["messageByIP", false, "messageByIP must be a string or null"],
  ] as const) {
    it(`rejects an invalid ${field} type`, async () => {
      configureConcurrencyLimit({[field]: value});
      let error = await captureInitializationError();
      expect(String(error)).to.include(message);
    });
  }

  for(let invalidLimit of [
    {name: "zero", value: 0},
    {name: "negative", value: -1},
    {name: "fractional", value: 1.5},
    {name: "NaN", value: Number.NaN},
    {name: "positive infinity", value: Number.POSITIVE_INFINITY},
    {name: "negative infinity", value: Number.NEGATIVE_INFINITY},
    {name: "unsafe", value: Number.MAX_SAFE_INTEGER + 1},
    {name: "string", value: "1"},
  ]) {
    it(`rejects concurrencyLimit when it is ${invalidLimit.name}`, async () => {
      configureConcurrencyLimit({concurrencyLimit: invalidLimit.value});
      let error = await captureInitializationError();
      expect(String(error)).to.include("concurrencyLimit must be a positive safe integer");
    });
  }

  it("allows a disabled module to retain the zero limit default", async () => {
    configureConcurrencyLimit({enabled: false, concurrencyLimit: 0});
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    expect(moduleManager.getModule("concurrency-limit")).to.equal(undefined);
  });

  it("restores the compiled scope after an invalid reload", async () => {
    configureConcurrencyLimit({byAddrOnly: true});
    let moduleManager = ServiceManager.GetService(ModuleManager);
    await moduleManager.initialize();
    let module = moduleManager.getModule<ConcurrencyLimitModule>("concurrency-limit");

    let reloadError: unknown;
    try {
      await module.setModuleConfig({
        enabled: true,
        concurrencyLimit: 1,
        byAddrOnly: true,
        byIPOnly: true,
        messageByAddr: null,
        messageByIP: null,
      });
    } catch(ex) {
      reloadError = ex;
    }
    expect(String(reloadError)).to.include("byAddrOnly and byIPOnly cannot both be true");

    addBlockingSessionHook();
    await runTestSession("8.8.8.8", "0x0000000000000000000000000000000000001337", "running");
    let error = await captureSessionError("8.8.4.4", "0x0000000000000000000000000000000000001337");
    expectConcurrencyError(error, /per wallet address/);
  });

  it("admits only the first concurrent start for a case-insensitive address", async () => {
    configureConcurrencyLimit({byAddrOnly: true});
    await ServiceManager.GetService(ModuleManager).initialize();
    addBlockingSessionHook();

    let upperAddress = "0x000000000000000000000000000000000000ABCD";
    let lowerAddress = upperAddress.toLowerCase();
    let results = await Promise.allSettled([
      runTestSession("8.8.8.8", upperAddress),
      runTestSession("8.8.4.4", lowerAddress),
    ]);
    let fulfilled = results.filter((result) => result.status === "fulfilled") as PromiseFulfilledResult<FaucetSession>[];
    let rejected = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];

    expect(fulfilled.length).to.equal(1);
    expect(rejected.length).to.equal(1);
    expect(fulfilled[0].value.getTargetAddr()).to.equal(lowerAddress);
    expect(rejected[0].reason).to.be.instanceOf(FaucetError);
    expect(rejected[0].reason.getCode()).to.equal("CONCURRENCY_LIMIT");
  });

  it("restores address reservations before admitting new traffic", async () => {
    configureConcurrencyLimit({byAddrOnly: true});
    await ServiceManager.GetService(ModuleManager).initialize();
    let upperAddress = "0x000000000000000000000000000000000000ABCD";
    let now = Math.floor(Date.now() / 1000);
    await ServiceManager.GetService(FaucetDatabase).updateSession({
      sessionId: "4e63566e-e482-46f3-bb91-da11f511c001",
      status: FaucetSessionStatus.RUNNING,
      startTime: now,
      targetAddr: upperAddress,
      dropAmount: "100",
      remoteIP: "8.8.8.8",
      tasks: [{module: "test", name: "test", timeout: 0}],
      data: {},
      claim: null,
    });

    let sessionManager = ServiceManager.GetService(SessionManager);
    await sessionManager.initialize();
    let restored = sessionManager.getSession("4e63566e-e482-46f3-bb91-da11f511c001");
    expect(restored.getTargetAddr()).to.equal(upperAddress.toLowerCase());

    let error: FaucetError | null = null;
    try {
      await runTestSession("8.8.4.4", upperAddress.toLowerCase());
    } catch(ex) {
      error = ex;
    }
    expect(error?.getCode()).to.equal("CONCURRENCY_LIMIT");
  });

  it("holds the old IP reservation until an IP move succeeds", async () => {
    configureConcurrencyLimit({byIPOnly: true});
    await ServiceManager.GetService(ModuleManager).initialize();
    addBlockingSessionHook();

    let first = await runTestSession("8.8.8.8", "0x0000000000000000000000000000000000001337", "running");
    let occupiedTarget = await runTestSession("8.8.4.4", "0x0000000000000000000000000000000000001338", "running");
    let moveError: FaucetError | null = null;
    try {
      await first.updateRemoteIP("8.8.4.4");
    } catch(ex) {
      moveError = ex;
    }
    expect(moveError?.getCode()).to.equal("CONCURRENCY_LIMIT");
    expect(first.getRemoteIP()).to.equal("8.8.8.8");

    let oldIpError: FaucetError | null = null;
    try {
      await runTestSession("8.8.8.8", "0x0000000000000000000000000000000000001339");
    } catch(ex) {
      oldIpError = ex;
    }
    expect(oldIpError?.getCode()).to.equal("CONCURRENCY_LIMIT");

    await occupiedTarget.setSessionFailed("TEST", "release target IP");
    await first.updateRemoteIP("8.8.4.4");
    expect(first.getRemoteIP()).to.equal("8.8.4.4");
    let replacement = await runTestSession("8.8.8.8", "0x0000000000000000000000000000000000001339");
    expect(replacement.getSessionStatus()).to.equal(FaucetSessionStatus.RUNNING);
  });

  it("releases reservations when a later start hook fails", async () => {
    configureConcurrencyLimit({byIPOnly: true});
    await ServiceManager.GetService(ModuleManager).initialize();
    let failNextSession = true;
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 8, "fail once", () => {
      if(!failNextSession)
        return;
      failNextSession = false;
      throw new FaucetError("TEST_FAILURE", "fail after admission");
    });

    let firstError: FaucetError | null = null;
    try {
      await runTestSession("8.8.8.8", "0x0000000000000000000000000000000000001337");
    } catch(ex) {
      firstError = ex;
    }
    expect(firstError?.getCode()).to.equal("TEST_FAILURE");

    let second = await runTestSession("8.8.8.8", "0x0000000000000000000000000000000000001338");
    expect(second.getSessionStatus()).to.equal(FaucetSessionStatus.CLAIMABLE);
  });

});
