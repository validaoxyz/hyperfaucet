import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { bindTestStubs, unbindTestStubs, loadDefaultTestConfig, awaitSleepPromise } from '../common.js';
import { ServiceManager } from '../../src/common/ServiceManager.js';
import { FaucetDatabase } from '../../src/db/FaucetDatabase.js';
import { ModuleManager } from '../../src/modules/ModuleManager.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { faucetConfig } from '../../src/config/FaucetConfig.js';
import { FaucetError } from '../../src/common/FaucetError.js';
import { ICaptchaConfig } from '../../src/modules/captcha/CaptchaConfig.js';
import { EthClaimManager } from '../../src/eth/EthClaimManager.js';
import { CaptchaModule, HCaptchaApi } from '../../src/modules/captcha/CaptchaModule.js';
import { FaucetWebApi } from '../../src/webserv/FaucetWebApi.js';
import { FetchUtil } from '../../src/utils/FetchUtil.js';


describe("Faucet module: captcha", () => {
  let globalStubs;

  beforeEach(async () => {
    globalStubs = bindTestStubs({
      "fetch": sinon.stub(FetchUtil, "fetch"),
      "hcaptcha.verify": sinon.stub(HCaptchaApi, "verify"),
    });
    loadDefaultTestConfig();
    await ServiceManager.GetService(FaucetDatabase).initialize();
    await ServiceManager.GetService(EthClaimManager).initialize();
  });
  afterEach(async () => {
    let dbService = ServiceManager.GetService(FaucetDatabase);
    await ServiceManager.DisposeAllServices();
    await dbService.closeDatabase();
    await unbindTestStubs(globalStubs);
  });

  it("Check client config exports", async () => {
    faucetConfig.modules["captcha"] = {
      enabled: true,
      provider: "hcaptcha",
      siteKey: "test-site-key",
      secret: "test-secret",
      checkSessionStart: true,
      checkBalanceClaim: true,
    } as ICaptchaConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    let clientConfig = await ServiceManager.GetService(FaucetWebApi).onGetFaucetConfig();
    expect(!!clientConfig.modules['captcha']).to.equal(true, "no captcha config exported");
    expect(clientConfig.modules['captcha'].provider).to.equal("hcaptcha", "client config mismatch: provider");
    expect(clientConfig.modules['captcha'].siteKey).to.equal("test-site-key", "client config mismatch: siteKey");
    expect(clientConfig.modules['captcha'].requiredForStart).to.equal(true, "client config mismatch: requiredForStart");
    expect(clientConfig.modules['captcha'].requiredForClaim).to.equal(true, "client config mismatch: requiredForClaim");
  });

  it("Rejects an unsupported provider during module startup", async () => {
    faucetConfig.modules["captcha"] = {
      enabled: true,
      provider: "unsupported",
      siteKey: "test-site-key",
      secret: "test-secret",
      checkSessionStart: true,
      checkBalanceClaim: false,
    } as any;

    let error: Error | null = null;
    try {
      await ServiceManager.GetService(ModuleManager).initialize();
    } catch(ex) {
      error = ex;
    }
    expect(error?.message).to.include("captcha provider is missing or unsupported");
  });

  it("Rejects missing provider credentials during module startup", async () => {
    faucetConfig.modules["captcha"] = {
      enabled: true,
      provider: "turnstile",
      siteKey: "test-site-key",
      secret: "",
      checkSessionStart: true,
      checkBalanceClaim: false,
    } as ICaptchaConfig;

    let error: Error | null = null;
    try {
      await ServiceManager.GetService(ModuleManager).initialize();
    } catch(ex) {
      error = ex;
    }
    expect(error?.message).to.include("captcha secret is required");
  });

  it("Checks the Turnstile action and configured hostname", async () => {
    faucetConfig.modules["captcha"] = {
      enabled: true,
      provider: "turnstile",
      siteKey: "test-site-key",
      secret: "test-secret",
      checkSessionStart: true,
      checkBalanceClaim: false,
      allowedHostnames: ["HyperFaucet.Dev."],
    } as ICaptchaConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    let captchaModule = ServiceManager.GetService(ModuleManager).getModule<CaptchaModule>("captcha");

    globalStubs["fetch"].onCall(0).resolves({
      json: () => Promise.resolve({ success: true, action: "session", hostname: "hyperfaucet.dev" }),
    });
    globalStubs["fetch"].onCall(1).resolves({
      json: () => Promise.resolve({ success: true, action: "claim", hostname: "hyperfaucet.dev" }),
    });
    globalStubs["fetch"].onCall(2).resolves({
      json: () => Promise.resolve({ success: true, action: "session", hostname: "attacker.example" }),
    });

    expect(await captchaModule.verifyToken("valid", "8.8.8.8", "session")).to.equal(true);
    expect(await captchaModule.verifyToken("wrong-action", "8.8.8.8", "session")).to.equal(false);
    expect(await captchaModule.verifyToken("wrong-host", "8.8.8.8", "session")).to.equal(false);
  });

  it("Require hcaptcha for session start", async () => {
    faucetConfig.modules["captcha"] = {
      enabled: true,
      provider: "hcaptcha",
      siteKey: "test-site-key",
      secret: "test-secret",
      checkSessionStart: true,
      checkBalanceClaim: false,
    } as ICaptchaConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    globalStubs["hcaptcha.verify"].returns(Promise.resolve({
      success: true,
    }));
    // create session with token
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      captchaToken: "test-token",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(globalStubs["hcaptcha.verify"].calledWith("test-secret", "test-token", "8.8.8.8", "test-site-key")).to.equal(true, "hcaptcha.verify not called as expected");
    await ServiceManager.GetService(EthClaimManager).createSessionClaim(testSession.getStoreData(), {});
    let sessionData = await sessionManager.getSessionData(testSession.getSessionId());
    expect(sessionData?.status).to.equal("claiming", "unexpected session status after claim");
  });

  it("Require recaptcha for session claim", async () => {
    faucetConfig.modules["captcha"] = {
      enabled: true,
      provider: "recaptcha",
      siteKey: "test-site-key",
      secret: "test-secret",
      checkSessionStart: false,
      checkBalanceClaim: true,
    } as ICaptchaConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    globalStubs["fetch"].returns(Promise.resolve({
      json: () => Promise.resolve({
        success: true,
      }),
    }));
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status after start");
    await ServiceManager.GetService(EthClaimManager).createSessionClaim(testSession.getStoreData(), {
      captchaToken: "test-token",
    });
    let sessionData = await sessionManager.getSessionData(testSession.getSessionId());
    expect(sessionData?.status).to.equal("claiming", "unexpected session status after claim");
    let reqBody = globalStubs["fetch"].getCall(0).args[1].body;
    expect(reqBody.get("secret")).to.equal("test-secret", "fetch not called with test secret");
    expect(reqBody.get("response")).to.equal("test-token", "fetch not called with test token");
    expect(reqBody.get("remoteip")).to.equal("8.8.8.8", "fetch not called with claimant IP");
  });

  it("Require hcaptcha for session start (missing token)", async () => {
    faucetConfig.modules["captcha"] = {
      enabled: true,
      provider: "hcaptcha",
      siteKey: "test-site-key",
      secret: "test-secret",
      checkSessionStart: true,
      checkBalanceClaim: false,
    } as ICaptchaConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    globalStubs["hcaptcha.verify"].returns(Promise.resolve({
      success: true,
    }));
    let error: FaucetError | null = null;
    try {
      await sessionManager.createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("INVALID_CAPTCHA", "unexpected error code");
  });

  it("Require hcaptcha for session start (invalid token)", async () => {
    faucetConfig.modules["captcha"] = {
      enabled: true,
      provider: "hcaptcha",
      siteKey: "test-site-key",
      secret: "test-secret",
      checkSessionStart: true,
      checkBalanceClaim: false,
    } as ICaptchaConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    globalStubs["hcaptcha.verify"].returns(Promise.resolve({
      success: false,
    }));
    let error: FaucetError | null = null;
    try {
      await sessionManager.createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        captchaToken: "test-token",
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("INVALID_CAPTCHA", "unexpected error code");
  });

  it("Require recaptcha for session claim (missing token)", async () => {
    faucetConfig.modules["captcha"] = {
      enabled: true,
      provider: "recaptcha",
      siteKey: "test-site-key",
      secret: "test-secret",
      checkSessionStart: false,
      checkBalanceClaim: true,
    } as ICaptchaConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    globalStubs["fetch"].returns(Promise.resolve({
      json: () => Promise.resolve({
        success: true,
      }),
    }));
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status after start");
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(EthClaimManager).createSessionClaim(testSession.getStoreData(), {});
    } catch(ex) {
      error = ex;
    }
    let sessionData = await sessionManager.getSessionData(testSession.getSessionId());
    expect(sessionData?.status).to.equal("claimable", "unexpected session status after invalid claim attempt");
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("INVALID_CAPTCHA", "unexpected error code");
  });

  it("Require recaptcha for session claim (invalid token)", async () => {
    faucetConfig.modules["captcha"] = {
      enabled: true,
      provider: "recaptcha",
      siteKey: "test-site-key",
      secret: "test-secret",
      checkSessionStart: false,
      checkBalanceClaim: true,
    } as ICaptchaConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    globalStubs["fetch"].returns(Promise.resolve({
      json: () => Promise.resolve({
        success: false,
      }),
    }));
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status after start");
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(EthClaimManager).createSessionClaim(testSession.getStoreData(), {
        captchaToken: "test-token",
      });
    } catch(ex) {
      error = ex;
    }
    let sessionData = await sessionManager.getSessionData(testSession.getSessionId());
    expect(sessionData?.status).to.equal("claimable", "unexpected session status after invalid claim attempt");
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("INVALID_CAPTCHA", "unexpected error code");
  });

  it("Require turnstile for session claim (missing token)", async () => {
    faucetConfig.modules["captcha"] = {
      enabled: true,
      provider: "turnstile",
      siteKey: "test-site-key",
      secret: "test-secret",
      checkSessionStart: false,
      checkBalanceClaim: true,
    } as ICaptchaConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    globalStubs["fetch"].returns(Promise.resolve({
      json: () => Promise.resolve({
        success: true,
      }),
    }));
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status after start");
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(EthClaimManager).createSessionClaim(testSession.getStoreData(), {});
    } catch(ex) {
      error = ex;
    }
    let sessionData = await sessionManager.getSessionData(testSession.getSessionId());
    expect(sessionData?.status).to.equal("claimable", "unexpected session status after invalid claim attempt");
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("INVALID_CAPTCHA", "unexpected error code");
  });

  it("Require turnstile for session claim (invalid token)", async () => {
    faucetConfig.modules["captcha"] = {
      enabled: true,
      provider: "turnstile",
      siteKey: "test-site-key",
      secret: "test-secret",
      checkSessionStart: false,
      checkBalanceClaim: true,
    } as ICaptchaConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    globalStubs["fetch"].returns(Promise.resolve({
      json: () => Promise.resolve({
        success: false,
      }),
    }));
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status after start");
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(EthClaimManager).createSessionClaim(testSession.getStoreData(), {
        captchaToken: "test-token",
      });
    } catch(ex) {
      error = ex;
    }
    let sessionData = await sessionManager.getSessionData(testSession.getSessionId());
    expect(sessionData?.status).to.equal("claimable", "unexpected session status after invalid claim attempt");
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("INVALID_CAPTCHA", "unexpected error code");
  });

  it("Require custom captcha for session start", async () => {
    faucetConfig.modules["captcha"] = {
      enabled: true,
      provider: "custom",
      siteKey: "http://test-client-script-url.com",
      secret: "http://test-verify-url.com",
      checkSessionStart: true,
      checkBalanceClaim: false,
    } as ICaptchaConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    globalStubs["fetch"].returns(Promise.resolve({
      json: () => Promise.resolve({
        success: true,
        ident: "test-ident",
      }),
    }));
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      captchaToken: "test-token",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(testSession.getSessionData("captcha.ident")).to.equal("test-ident", "unexpected session ident");
    let reqBody = globalStubs["fetch"].getCall(0).args[1].body;
    expect(reqBody.get("remoteip")).to.equal("8.8.8.8", "fetch not called with test remote ip");
    expect(reqBody.get("response")).to.equal("test-token", "fetch not called with test token");
  });

  it("Require custom captcha for session claim (invalid token)", async () => {
    faucetConfig.modules["captcha"] = {
      enabled: true,
      provider: "custom",
      siteKey: "http://test-client-script-url.com",
      secret: "http://test-verify-url.com",
      checkSessionStart: false,
      checkBalanceClaim: true,
    } as ICaptchaConfig;
    await ServiceManager.GetService(ModuleManager).initialize();
    let sessionManager = ServiceManager.GetService(SessionManager);
    globalStubs["fetch"].returns(Promise.resolve({
      json: () => Promise.resolve({
        success: false,
      }),
    }));
    let testSession = await sessionManager.createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status after start");
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(EthClaimManager).createSessionClaim(testSession.getStoreData(), {
        captchaToken: "test-token",
      });
    } catch(ex) {
      error = ex;
    }
    let sessionData = await sessionManager.getSessionData(testSession.getSessionId());
    expect(sessionData?.status).to.equal("claimable", "unexpected session status after invalid claim attempt");
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("INVALID_CAPTCHA", "unexpected error code");
  });

});
