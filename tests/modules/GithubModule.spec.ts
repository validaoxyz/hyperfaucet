import 'mocha';
import sinon from 'sinon';
import { expect } from 'chai';
import { FetchUtil } from '../../src/utils/FetchUtil.js';
import { bindTestStubs, unbindTestStubs, loadDefaultTestConfig } from '../common.js';
import { ServiceManager } from '../../src/common/ServiceManager.js';
import { FaucetDatabase } from '../../src/db/FaucetDatabase.js';
import { ModuleHookAction, ModuleManager } from '../../src/modules/ModuleManager.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { faucetConfig } from '../../src/config/FaucetConfig.js';
import { FaucetError } from '../../src/common/FaucetError.js';
import { IGithubConfig } from '../../src/modules/github/GithubConfig.js';
import { FaucetWebApi } from '../../src/webserv/FaucetWebApi.js';
import { FaucetSession, FaucetSessionStatus } from '../../src/session/FaucetSession.js';
import { encryptTokenPayload } from '../../src/utils/CryptoUtils.js';
import { FaucetHttpResponse } from '../../src/webserv/FaucetHttpServer.js';
import { FaucetProcess } from '../../src/common/FaucetProcess.js';
import { GITHUB_AUTH_EXCHANGE_OWNER_LIMIT } from '../../src/modules/github/GithubResolver.js';

interface IFakeFetchResponse {
  url: RegExp;
  rsp?: any;
  json?: any;
  fail?: boolean;
  promise?: Promise<void>;
  calls: {
    url: string;
    opts: any;
  }[];
}

const AUTH_STATE = "a".repeat(64);
const CALLBACK_ORIGIN = "https://faucets.pk910.de";
const GITHUB_AUTH_BINDING_COOKIE_PREFIX = "__Host-hyperfaucet-github-auth-";

function withCallbackContext(url: string, clientOrigin = CALLBACK_ORIGIN, state = AUTH_STATE): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}state=${state}&clientOrigin=${encodeURIComponent(clientOrigin)}`;
}


describe("Faucet module: github", () => {
  let globalStubs;
  let fakeFetchResponses: IFakeFetchResponse[];

  beforeEach(async () => {
    fakeFetchResponses = [];
    globalStubs = bindTestStubs({
      "fetch": sinon.stub(FetchUtil, "fetch").callsFake(fakeFetch),
    });
    loadDefaultTestConfig();
    await ServiceManager.GetService(FaucetDatabase).initialize();
    faucetConfig.modules["github"] = {
      enabled: true,
      appClientId: "test-client-id",
      appSecret: "test-app-secret",
      redirectUrl: CALLBACK_ORIGIN + "/api/githubCallback",
      authTimeout: 86400,
      cacheTime: 86400,
      checks: [],
      restrictions: [],
    } as IGithubConfig;
  });
  afterEach(async () => {
    let dbService = ServiceManager.GetService(FaucetDatabase);
    await ServiceManager.DisposeAllServices();
    await dbService.closeDatabase();
    await unbindTestStubs(globalStubs);
  });

  function fakeFetch(url: any, opts: any): Promise<any> {
    for(let i = 0; i < fakeFetchResponses.length; i++) {
      if(fakeFetchResponses[i].url.test(url)) {
        let promise = fakeFetchResponses[i].promise || Promise.resolve();
        if(!fakeFetchResponses[i].calls)
          fakeFetchResponses[i].calls = [];
        fakeFetchResponses[i].calls.push({
          url: url,
          opts: opts,
        });
        return promise.then(() => {
          if(fakeFetchResponses[i].fail)
            throw fakeFetchResponses[i].rsp;
          return fakeFetchResponses[i].rsp;
        });
      }
    }
    return Promise.reject("no fake response");
  }

  function addFakeFetchResponse(opts: IFakeFetchResponse): IFakeFetchResponse {
    if(opts.json && !opts.rsp) {
      opts.rsp = { json: () => {
        return Promise.resolve(opts.json);
      }};
    }
    fakeFetchResponses.push(opts);
    return opts;
  }

  async function requestAuthState(
    clientOrigin = CALLBACK_ORIGIN,
    requestOrigin: string | null = clientOrigin,
    remoteAddress = "::ffff:8.8.8.8",
    browserCookie?: string,
    secFetchSite: string | null = clientOrigin === CALLBACK_ORIGIN ? null : "same-site",
  ): Promise<FaucetHttpResponse> {
    const headers: Record<string, string> = { host: "faucets.pk910.de" };
    if(requestOrigin !== null)
      headers.origin = requestOrigin;
    if(browserCookie !== undefined)
      headers.cookie = browserCookie;
    if(secFetchSite !== null)
      headers["sec-fetch-site"] = secFetchSite;

    const response = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "POST",
      url: `/api/githubAuthState?clientOrigin=${encodeURIComponent(clientOrigin)}`,
      headers,
      socket: { encrypted: true, remoteAddress },
    } as any);
    expect(response).to.be.instanceOf(FaucetHttpResponse);
    return response;
  }

  function getIssuedState(response: FaucetHttpResponse): string {
    const capability: unknown = JSON.parse(response.body);
    expect(capability).to.be.an("object");
    expect((capability as any).state).to.match(/^[0-9a-f]{64}$/);
    expect((capability as any).expiresAt).to.be.a("number");
    return (capability as any).state;
  }

  function getBindingCookie(response: FaucetHttpResponse, state: string): string {
    const setCookie = response.headers["Set-Cookie"];
    expect(setCookie).to.be.a("string");
    expect(setCookie).to.match(
      new RegExp(
        `^${GITHUB_AUTH_BINDING_COOKIE_PREFIX}${state}=[0-9a-f]{64}; `
        + "Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Lax$",
      ),
    );
    return (setCookie as string).split(";", 1)[0];
  }

  async function issueAuthState(
    clientOrigin = CALLBACK_ORIGIN,
    remoteAddress = "::ffff:8.8.8.8",
  ): Promise<string> {
    const response = await requestAuthState(clientOrigin, clientOrigin, remoteAddress);
    expect(response.code).to.equal(200);
    expect(response.headers["Cache-Control"]).to.equal("no-store");
    return getIssuedState(response);
  }

  async function issueBoundAuthState(
    clientOrigin: string,
    remoteAddress = "::ffff:8.8.8.8",
  ): Promise<{state: string; browserCookie: string; response: FaucetHttpResponse}> {
    const response = await requestAuthState(
      clientOrigin,
      clientOrigin,
      remoteAddress,
    );
    expect(response.code).to.equal(200);
    const state = getIssuedState(response);
    return {
      state,
      browserCookie: getBindingCookie(response, state),
      response,
    };
  }

  async function requestAuthResult(
    state: string,
    clientOrigin: string,
    requestOrigin = clientOrigin,
    browserCookie?: string,
    secFetchSite: string | null = clientOrigin === CALLBACK_ORIGIN ? null : "same-site",
  ): Promise<FaucetHttpResponse> {
    const headers: Record<string, string> = {
      host: "faucets.pk910.de",
      origin: requestOrigin,
    };
    if(browserCookie !== undefined)
      headers.cookie = browserCookie;
    if(secFetchSite !== null)
      headers["sec-fetch-site"] = secFetchSite;
    const response = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "POST",
      url: withCallbackContext("/api/githubAuthResult", clientOrigin, state),
      headers,
      socket: { encrypted: true, remoteAddress: "::ffff:8.8.8.8" },
    } as any);
    expect(response).to.be.instanceOf(FaucetHttpResponse);
    return response;
  }

  function addGithubApiResponses(): {
    authToken: IFakeFetchResponse;
    userInfo: IFakeFetchResponse;
    ownRepos: IFakeFetchResponse;
  } {
    return {
      authToken: addFakeFetchResponse({
        url: /github\.com\/login\/oauth\/access_token/,
        rsp: { text: () => Promise.resolve("access_token=test_access_token&scope=&token_type=bearer") },
        calls: [],
      }),
      userInfo: addFakeFetchResponse({
        url: /api\.github\.com\/user$/,
        json: {
          id: 1337,
          name: "testus",
          login: "testus-login",
          url: "https://api.github.com/users/testus",
          html_url: "https://github.com/testus",
          avatar_url: "https://avatars.githubusercontent.com/u/1337?v=4",
          created_at: "2010-11-21T22:06:08Z",
          public_repos: 10,
          followers: 5,
        },
        calls: [],
      }),
      ownRepos: addFakeFetchResponse({
        url: /api\.github\.com\/graphql$/,
        json: {
          data: {
            viewer: {
              repositories: {
                edges: [
                  { node: {
                    id: "R_kgDOHCncMQ",
                    name: "PoWFaucet",
                    forkCount: 629,
                    stargazerCount: 1521,
                    url: "https://github.com/pk910/PoWFaucet",
                  }},
                ]
              }
            }
          }
        },
        calls: [],
      }),
    };
  }

  function generateTestToken(accessToken: string, userId: number, time?: number): string {
    if(!time)
      time = Math.floor(new Date().getTime() / 1000);
    let resolver = ServiceManager.GetService(ModuleManager).getModule<any>("github").githubResolver;
    return resolver.generateFaucetToken(accessToken, userId, time);
  }

  it("Check client config exports", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    let clientConfig = await ServiceManager.GetService(FaucetWebApi).onGetFaucetConfig();
    expect(!!clientConfig.modules['github']).to.equal(true, "no github config exported");
    expect(clientConfig.modules['github'].clientId).to.equal("test-client-id", "client config mismatch: clientId");
    expect(clientConfig.modules['github'].authTimeout).to.equal(86400, "client config mismatch: authTimeout");
    expect(clientConfig.modules['github'].redirectUrl).to.equal(CALLBACK_ORIGIN + "/api/githubCallback", "client config mismatch: redirectUrl");
    expect("callbackState" in clientConfig.modules['github']).to.equal(false, "obsolete callbackState exported");
  });

  it("Start session with github token", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    let apiRsp = addGithubApiResponses();
    let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      githubToken: generateTestToken("test-github-token", 1337),
    });
    expect(testSession.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(apiRsp.userInfo.calls?.length || 0).to.equal(1, "unexpected number of user info api calls");
    expect(apiRsp.userInfo.calls[0].opts?.headers['Authorization']).to.equal("token test-github-token", "unexpected access token in api call");
    expect(apiRsp.ownRepos.calls?.length || 0).to.equal(0, "unexpected number of own repos api calls");
    expect(testSession.getSessionData("github.uid")).to.equal(1337, "unexpected github info in session data: github.uid");
    expect(testSession.getSessionData("github.user")).to.equal("testus", "unexpected github info in session data: github.user");
  });

  it("Uses the github login when the optional profile name is missing", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const apiRsp = addGithubApiResponses();
    apiRsp.userInfo.json.name = null;

    const testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      githubToken: generateTestToken("test-github-token", 1337),
    });

    expect(testSession.getSessionData("github.user")).to.equal("testus-login");
  });

  it("Check github requirements: unexpected api error", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    (faucetConfig.modules["github"] as IGithubConfig).checks.push({
      required: true,
    });
    let apiRsp = addGithubApiResponses();
    apiRsp.userInfo.fail = true;
    apiRsp.userInfo.rsp = "test-error";
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        githubToken: generateTestToken("test-github-token", 1337),
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("GITHUB_CHECK", "unexpected error code");
    expect(error?.message).to.matches(/missing or invalid github token/, "unexpected error message");

    expect(apiRsp.userInfo.calls?.length || 0).to.equal(1, "unexpected number of user info api calls");
    expect(apiRsp.ownRepos.calls?.length || 0).to.equal(0, "unexpected number of own repos api calls");
  });

  it("Check github requirements: missing authentication", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    (faucetConfig.modules["github"] as IGithubConfig).checks.push({
      required: true,
    });
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("GITHUB_CHECK", "unexpected error code");
    expect(error?.message).to.matches(/missing or invalid github token/, "unexpected error message");
  });

  it("Check github requirements: invalid token 1", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    (faucetConfig.modules["github"] as IGithubConfig).checks.push({
      required: true,
    });
    let apiRsp = addGithubApiResponses();
    apiRsp.userInfo.json.created_at = new Date().toISOString();
    let error: FaucetError | null = null;
    try {
      let resolver = ServiceManager.GetService(ModuleManager).getModule<any>("github").githubResolver;
      let invalidToken = encryptTokenPayload({
        kind: "github",
        issuedAt: 13,
      }, resolver.getTokenPassphrase());
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        githubToken: invalidToken,
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("GITHUB_CHECK", "unexpected error code");
    expect(error?.message).to.matches(/missing or invalid github token/, "unexpected error message");

    expect(apiRsp.userInfo.calls?.length || 0).to.equal(0, "unexpected number of user info api calls");
    expect(apiRsp.ownRepos.calls?.length || 0).to.equal(0, "unexpected number of own repos api calls");
  });

  it("Check github requirements: invalid token 2", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    (faucetConfig.modules["github"] as IGithubConfig).checks.push({
      required: true,
    });
    let apiRsp = addGithubApiResponses();
    apiRsp.userInfo.json.created_at = new Date().toISOString();
    let error: FaucetError | null = null;
    try {
      let resolver = ServiceManager.GetService(ModuleManager).getModule<any>("github").githubResolver;
      let invalidToken = encryptTokenPayload({
        kind: "not_github",
        issuedAt: 13,
        userId: 1337,
        accessToken: "test",
      }, resolver.getTokenPassphrase());
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        githubToken: invalidToken,
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("GITHUB_CHECK", "unexpected error code");
    expect(error?.message).to.matches(/missing or invalid github token/, "unexpected error message");

    expect(apiRsp.userInfo.calls?.length || 0).to.equal(0, "unexpected number of user info api calls");
    expect(apiRsp.ownRepos.calls?.length || 0).to.equal(0, "unexpected number of own repos api calls");
  });

  it("Check github requirements: expired token", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    (faucetConfig.modules["github"] as IGithubConfig).checks.push({
      required: true,
    });
    let apiRsp = addGithubApiResponses();
    apiRsp.userInfo.json.created_at = new Date().toISOString();
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        githubToken: generateTestToken("test-github-token", 1337, 100),
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("GITHUB_CHECK", "unexpected error code");
    expect(error?.message).to.matches(/missing or invalid github token/, "unexpected error message");

    expect(apiRsp.userInfo.calls?.length || 0).to.equal(0, "unexpected number of user info api calls");
    expect(apiRsp.ownRepos.calls?.length || 0).to.equal(0, "unexpected number of own repos api calls");
  });

  it("Check github requirements: account age", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    (faucetConfig.modules["github"] as IGithubConfig).checks.push({
      required: true,
      minAccountAge: 86400,
    });
    let apiRsp = addGithubApiResponses();
    apiRsp.userInfo.json.created_at = new Date().toISOString();
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        githubToken: generateTestToken("test-github-token", 1337),
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("GITHUB_CHECK", "unexpected error code");
    expect(error?.message).to.matches(/account age check failed/, "unexpected error message");

    expect(apiRsp.userInfo.calls?.length || 0).to.equal(1, "unexpected number of user info api calls");
    expect(apiRsp.ownRepos.calls?.length || 0).to.equal(0, "unexpected number of own repos api calls");
  });

  it("Check github requirements: repository count", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    (faucetConfig.modules["github"] as IGithubConfig).checks.push({
      required: true,
      minRepoCount: 20,
    });
    let apiRsp = addGithubApiResponses();
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        githubToken: generateTestToken("test-github-token", 1337),
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("GITHUB_CHECK", "unexpected error code");
    expect(error?.message).to.matches(/repository count check failed/, "unexpected error message");

    expect(apiRsp.userInfo.calls?.length || 0).to.equal(1, "unexpected number of user info api calls");
    expect(apiRsp.ownRepos.calls?.length || 0).to.equal(0, "unexpected number of own repos api calls");
  });

  it("Check github requirements: follower count", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    (faucetConfig.modules["github"] as IGithubConfig).checks.push({
      required: true,
      minFollowers: 20,
      message: "test error: {0}",
    });
    let apiRsp = addGithubApiResponses();
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        githubToken: generateTestToken("test-github-token", 1337),
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("GITHUB_CHECK", "unexpected error code");
    expect(error?.message).to.matches(/follower count check failed/, "unexpected error message");
    expect(error?.message).to.matches(/test error/, "unexpected error message");

    expect(apiRsp.userInfo.calls?.length || 0).to.equal(1, "unexpected number of user info api calls");
    expect(apiRsp.ownRepos.calls?.length || 0).to.equal(0, "unexpected number of own repos api calls");
  });

  it("Check github requirements: own repository count", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    (faucetConfig.modules["github"] as IGithubConfig).checks.push({
      required: true,
      minOwnRepoCount: 20,
    });
    let apiRsp = addGithubApiResponses();
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        githubToken: generateTestToken("test-github-token", 1337),
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("GITHUB_CHECK", "unexpected error code");
    expect(error?.message).to.matches(/own repository count check failed/, "unexpected error message");

    expect(apiRsp.userInfo.calls?.length || 0).to.equal(1, "unexpected number of user info api calls");
    expect(apiRsp.ownRepos.calls?.length || 0).to.equal(1, "unexpected number of own repos api calls");
    expect(apiRsp.ownRepos.calls[0].opts.size).to.equal(256 * 1024);
  });

  it("Check github requirements: own repository stars", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    (faucetConfig.modules["github"] as IGithubConfig).checks.push({
      required: true,
      minOwnRepoStars: 2000,
    });
    let apiRsp = addGithubApiResponses();
    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        githubToken: generateTestToken("test-github-token", 1337),
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("GITHUB_CHECK", "unexpected error code");
    expect(error?.message).to.matches(/own repository star count check failed/, "unexpected error message");

    expect(apiRsp.userInfo.calls?.length || 0).to.equal(1, "unexpected number of user info api calls");
    expect(apiRsp.ownRepos.calls?.length || 0).to.equal(1, "unexpected number of own repos api calls");
  });

  it("Check reward factor handling", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession, userInput: any) => {
      session.addBlockingTask("test", "test1", 1);
    });
    (faucetConfig.modules["github"] as IGithubConfig).checks.push({
      minOwnRepoStars: 1000,
      rewardFactor: 2,
    });
    (faucetConfig.modules["github"] as IGithubConfig).checks.push({
      minOwnRepoStars: 3000,
      rewardFactor: 3,
    });
    let apiRsp = addGithubApiResponses();
    let testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      githubToken: generateTestToken("test-github-token", 1337),
    });
    expect(testSession.getSessionStatus()).to.equal("running", "unexpected session status");
    expect(apiRsp.userInfo.calls?.length || 0).to.equal(1, "unexpected number of user info api calls");
    expect(apiRsp.ownRepos.calls?.length || 0).to.equal(1, "unexpected number of own repos api calls");
    expect(testSession.getSessionData("github.factor")).to.equal(2, "unexpected github info in session data: github.factor");

    let reward = await testSession.addReward(100n);
    expect(reward).to.equal(200n, "unexpected reward");
  });

  it("Does not grant an optional reward factor without valid GitHub authentication", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    ServiceManager.GetService(ModuleManager).addActionHook(null, ModuleHookAction.SessionStart, 100, "test-task", (session: FaucetSession) => {
      session.addBlockingTask("test", "test1", 1);
    });
    (faucetConfig.modules["github"] as IGithubConfig).checks.push({
      minOwnRepoStars: 1000,
      rewardFactor: 2,
    });
    const apiRsp = addGithubApiResponses();
    const testSession = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
    });

    expect(testSession.getSessionStatus()).to.equal("running");
    expect(testSession.getSessionData("github.factor")).to.equal(undefined);
    expect(await testSession.addReward(100n)).to.equal(100n);
    expect(apiRsp.userInfo.calls?.length || 0).to.equal(0);
    expect(apiRsp.ownRepos.calls?.length || 0).to.equal(0);
  });

  it("Check github info caching", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    (faucetConfig.modules["github"] as IGithubConfig).checks.push({
      required: true,
      minOwnRepoStars: 1000,
    });
    let apiRsp = addGithubApiResponses();
    let testSession1 = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      githubToken: generateTestToken("test-github-token", 1337),
    });
    expect(testSession1.getSessionStatus()).to.equal("claimable", "unexpected session status");
    let testSession2 = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      githubToken: generateTestToken("test-github-token", 1337),
    });
    expect(testSession2.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(apiRsp.userInfo.calls?.length || 0).to.equal(1, "unexpected number of user info api calls");
    expect(apiRsp.ownRepos.calls?.length || 0).to.equal(1, "unexpected number of own repos api calls");
  });

  it("Check authentication callback: authentication error", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const authState = await issueAuthState();
    let callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: withCallbackContext(
        "/api/githubCallback?error=test_error&error_description=test+error+message",
        CALLBACK_ORIGIN,
        authState,
      ),
    } as any);
    expect(callbackRsp instanceof FaucetHttpResponse).to.equal(true, "unexpected api response");
    expect(callbackRsp.body).to.matches(/AUTH_DENIED/, "fixed error code not in response page");
    expect(callbackRsp.body).to.not.include("test_error");
    expect(callbackRsp.body).to.not.include("test+error+message");
  });

  it("Check authentication callback: unknown parameters", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const authState = await issueAuthState();
    let callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: withCallbackContext("/api/githubCallback?test=test_error", CALLBACK_ORIGIN, authState),
    } as any);
    expect(callbackRsp instanceof FaucetHttpResponse).to.equal(true, "unexpected api response");
    expect(callbackRsp.body).to.matches(/AUTH_ERROR/, "fixed error code not in response page");
  });

  it("requires the allowed browser origin before allocating authentication state", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const apiRsp = addGithubApiResponses();

    const rejectedOrigins: ReadonlyArray<readonly [string, string | null]> = [
      ["cross-site", "https://attacker.example"],
      ["missing", null],
      ["malformed", "not an origin"],
    ];
    for(const [label, requestOrigin] of rejectedOrigins) {
      const rejectedRsp = await requestAuthState(CALLBACK_ORIGIN, requestOrigin);
      expect(rejectedRsp.code, `${label} Origin`).to.equal(400);
      expect(rejectedRsp.body, `${label} Origin`).to.equal("Invalid authentication callback request.");
    }

    const splitOrigin = "https://client.pk910.de";
    faucetConfig.corsAllowOrigin = [splitOrigin];
    const sameOriginRsp = await requestAuthState();
    expect(sameOriginRsp.code).to.equal(200);
    expect(sameOriginRsp.headers["Access-Control-Allow-Origin"]).to.equal(undefined);
    expect(sameOriginRsp.headers["Access-Control-Allow-Credentials"]).to.equal(undefined);
    expect(sameOriginRsp.headers["Set-Cookie"]).to.equal(undefined);

    const splitOriginRsp = await requestAuthState(splitOrigin);
    expect(splitOriginRsp.code).to.equal(200);
    expect(splitOriginRsp.headers["Access-Control-Allow-Origin"]).to.equal(splitOrigin);
    expect(splitOriginRsp.headers["Access-Control-Allow-Credentials"]).to.equal("true");
    expect(splitOriginRsp.headers.Vary).to.equal("Origin");
    getBindingCookie(splitOriginRsp, getIssuedState(splitOriginRsp));

    for(let index = 0; index < 6; index++)
      await issueAuthState(CALLBACK_ORIGIN);

    expect(apiRsp.authToken.calls.length).to.equal(0);
    expect(apiRsp.userInfo.calls.length).to.equal(0);
    expect(apiRsp.ownRepos.calls.length).to.equal(0);
  });

  it("rejects an insecure split-origin callback before issuing a binding cookie", async () => {
    const clientOrigin = "https://client.pk910.de";
    faucetConfig.corsAllowOrigin = [clientOrigin];
    (faucetConfig.modules.github as IGithubConfig).redirectUrl =
      "http://faucets.pk910.de/api/githubCallback";
    await ServiceManager.GetService(ModuleManager).initialize();

    const response = await requestAuthState(clientOrigin);
    expect(response.code).to.equal(400);
    expect(response.headers["Access-Control-Allow-Origin"]).to.equal(clientOrigin);
    expect(response.headers["Access-Control-Allow-Credentials"]).to.equal("true");
    expect(response.headers["Set-Cookie"]).to.equal(undefined);
  });

  it("rejects cross-site or unclassified split-origin browser requests", async () => {
    const clientOrigin = "https://client.example";
    faucetConfig.corsAllowOrigin = [clientOrigin];
    await ServiceManager.GetService(ModuleManager).initialize();

    for(const [label, secFetchSite] of [
      ["cross-site", "cross-site"],
      ["missing", null],
    ] as const) {
      const response = await requestAuthState(
        clientOrigin,
        clientOrigin,
        "::ffff:8.8.8.8",
        undefined,
        secFetchSite,
      );
      expect(response.code, label).to.equal(400);
      expect(response.headers["Access-Control-Allow-Origin"], label).to.equal(clientOrigin);
      expect(response.headers["Access-Control-Allow-Credentials"], label).to.equal("true");
      expect(response.headers.Vary, label).to.equal("Origin");
      expect(response.headers["Set-Cookie"], label).to.equal(undefined);
    }

    for(let index = 0; index < 8; index++)
      await issueAuthState();
  });

  it("Rejects invalid callback context before exchanging an OAuth code", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const apiRsp = addGithubApiResponses();
    const issuedState = await issueAuthState();
    const urls = [
      `/api/githubCallback?code=test_auth_code&clientOrigin=${encodeURIComponent(CALLBACK_ORIGIN)}`,
      withCallbackContext("/api/githubCallback?code=test_auth_code", CALLBACK_ORIGIN, "A".repeat(64)),
      withCallbackContext("/api/githubCallback?code=test_auth_code", "https://attacker.example", issuedState),
      withCallbackContext("/api/githubCallback?code=test_auth_code", encodeURIComponent(CALLBACK_ORIGIN), issuedState),
      `/api/githubCallback?code=test_auth_code&state=${issuedState}&clientOrigin=%E0%A4%A`,
      withCallbackContext("/api/githubCallback?code=test_auth_code"),
    ];

    for(const url of urls) {
      const callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({ method: "GET", url } as any);
      expect(callbackRsp.code).to.equal(400);
      expect(callbackRsp.headers["Cache-Control"]).to.equal("no-store");
      expect(callbackRsp.body).to.equal("Invalid authentication callback request.");
    }
    expect(apiRsp.authToken.calls.length).to.equal(0);

    faucetConfig.corsAllowOrigin = ["*"];
    const wildcardRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: withCallbackContext(
        "/api/githubCallback?code=test_auth_code",
        "https://attacker.example",
        issuedState,
      ),
    } as any);
    expect(wildcardRsp.code).to.equal(400);
    expect(apiRsp.authToken.calls.length).to.equal(0);

    const validRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: withCallbackContext("/api/githubCallback?code=test_auth_code", CALLBACK_ORIGIN, issuedState),
    } as any);
    expect(validRsp.code).to.equal(200);
    expect(apiRsp.authToken.calls.length).to.equal(1);
  });

  it("Rejects unissued and replayed callback states before outbound work", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const apiRsp = addGithubApiResponses();

    const unissuedRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: withCallbackContext("/api/githubCallback?code=unissued_auth_code"),
    } as any);
    expect(unissuedRsp.code).to.equal(400);
    expect(apiRsp.authToken.calls.length).to.equal(0);

    const authState = await issueAuthState();
    const callbackUrl = withCallbackContext(
      "/api/githubCallback?code=issued_auth_code",
      CALLBACK_ORIGIN,
      authState,
    );
    const acceptedRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: callbackUrl,
    } as any);
    expect(acceptedRsp.code).to.equal(200);
    expect(apiRsp.authToken.calls.length).to.equal(1);

    const replayRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: callbackUrl,
    } as any);
    expect(replayRsp.code).to.equal(400);
    expect(apiRsp.authToken.calls.length).to.equal(1);
  });

  it("Atomically admits only one concurrent callback for an issued state", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const apiRsp = addGithubApiResponses();
    let releaseExchange: () => void = () => {};
    apiRsp.authToken.promise = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    const authState = await issueAuthState();
    const callbackUrl = withCallbackContext(
      "/api/githubCallback?code=duplicate_auth_code",
      CALLBACK_ORIGIN,
      authState,
    );

    const firstRequest = ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: callbackUrl,
    } as any);
    const duplicateRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: callbackUrl,
    } as any);
    expect(duplicateRsp.code).to.equal(400);
    expect(apiRsp.authToken.calls.length).to.equal(1);

    releaseExchange();
    const firstRsp = await firstRequest;
    expect(firstRsp.code).to.equal(200);
    expect(apiRsp.authToken.calls.length).to.equal(1);
  });

  it("Rejects expired callback state before outbound work", async () => {
    const clock = sinon.useFakeTimers({ now: Date.now() });
    try {
      await ServiceManager.GetService(ModuleManager).initialize();
      const apiRsp = addGithubApiResponses();
      const authState = await issueAuthState();
      await clock.tickAsync(5 * 60 * 1000);

      const callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
        method: "GET",
        url: withCallbackContext("/api/githubCallback?code=expired_auth_code", CALLBACK_ORIGIN, authState),
      } as any);
      expect(callbackRsp.code).to.equal(400);
      expect(apiRsp.authToken.calls.length).to.equal(0);
    } finally {
      clock.restore();
    }
  });

  it("Enforces state-issuance and callback HTTP methods before outbound work", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const apiRsp = addGithubApiResponses();
    const wrongIssueMethodRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: `/api/githubAuthState?clientOrigin=${encodeURIComponent(CALLBACK_ORIGIN)}`,
    } as any);
    expect(wrongIssueMethodRsp.code).to.equal(405);
    expect(wrongIssueMethodRsp.headers.Allow).to.equal("POST");

    const authState = await issueAuthState();
    const callbackUrl = withCallbackContext("/api/githubCallback?code=test_auth_code", CALLBACK_ORIGIN, authState);
    const headRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "HEAD",
      url: callbackUrl,
    } as any);
    expect(headRsp.code).to.equal(405);
    expect(headRsp.headers.Allow).to.equal("GET");
    expect(apiRsp.authToken.calls.length).to.equal(0);

    const getRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: callbackUrl,
    } as any);
    expect(getRsp.code).to.equal(200);
    expect(apiRsp.authToken.calls.length).to.equal(1);
  });

  it("caps concurrent OAuth exchanges and releases capacity after failure", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const apiRsp = addGithubApiResponses();
    const successfulTokenResponse = apiRsp.authToken.rsp;
    apiRsp.authToken.fail = true;
    apiRsp.authToken.rsp = new Error("exchange failed");
    let releaseExchange: () => void = () => {};
    apiRsp.authToken.promise = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });

    const authStates = await Promise.all(Array.from({length: 5}, () => issueAuthState()));
    const requests = Array.from({length: 5}, (_, index) =>
      ServiceManager.GetService(FaucetWebApi).onApiRequest({
        method: "GET",
        url: withCallbackContext(
          `/api/githubCallback?code=test_auth_code_${index}`,
          CALLBACK_ORIGIN,
          authStates[index],
        ),
      } as any)
    );
    const capacityResponse = await requests[4];
    expect(capacityResponse.body).to.include("AUTH_ERROR");
    expect(apiRsp.authToken.calls.length).to.equal(4);

    releaseExchange();
    const admittedResponses = await Promise.all(requests.slice(0, 4));
    for(const response of admittedResponses)
      expect(response.body).to.include("AUTH_ERROR");

    apiRsp.authToken.fail = false;
    apiRsp.authToken.rsp = successfulTokenResponse;
    apiRsp.authToken.promise = Promise.resolve();

    const replacementState = await issueAuthState();
    const nextResponse = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: withCallbackContext(
        "/api/githubCallback?code=test_auth_code_replacement",
        CALLBACK_ORIGIN,
        replacementState,
      ),
    } as any);
    expect(nextResponse.body).to.include('authModule":"github"');
    expect(apiRsp.authToken.calls.length).to.equal(5);
  });

  it("caps sequential OAuth exchange throughput before outbound work", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const apiRsp = addGithubApiResponses();

    for(let index = 0; index < GITHUB_AUTH_EXCHANGE_OWNER_LIMIT; index++) {
      const authState = await issueAuthState();
      const callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
        method: "GET",
        url: withCallbackContext(
          `/api/githubCallback?code=sequential_auth_code_${index}`,
          CALLBACK_ORIGIN,
          authState,
        ),
      } as any);
      expect(callbackRsp.body).to.include('authModule":"github"');
    }
    expect(apiRsp.authToken.calls.length).to.equal(GITHUB_AUTH_EXCHANGE_OWNER_LIMIT);

    const rejectedState = await issueAuthState();
    const rejectedRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: withCallbackContext(
        "/api/githubCallback?code=rate_limited_auth_code",
        CALLBACK_ORIGIN,
        rejectedState,
      ),
    } as any);
    expect(rejectedRsp.body).to.include("AUTH_ERROR");
    expect(apiRsp.authToken.calls.length).to.equal(GITHUB_AUTH_EXCHANGE_OWNER_LIMIT);
  });

  it("Check authentication callback: successful authentication", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    let apiRsp = addGithubApiResponses();
    const authState = await issueAuthState();
    let callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: withCallbackContext("/api/githubCallback?code=test_auth_code", CALLBACK_ORIGIN, authState),
    } as any);
    expect(callbackRsp instanceof FaucetHttpResponse).to.equal(true, "unexpected api response");
    expect(callbackRsp.code).to.equal(200);
    expect(callbackRsp.headers["Cache-Control"]).to.equal("no-store");
    expect(callbackRsp.body).to.include('authModule":"github"');
    expect(callbackRsp.body).to.include(`authState":"${authState}"`);
    expect(callbackRsp.body).to.include(`github.AuthResult.${authState}`);
    expect(callbackRsp.body).to.include(`targetOrigin = "${CALLBACK_ORIGIN}"`);
    expect(callbackRsp.body).to.matches(/"user": *"testus"/, "auth result not in response page");
    expect(apiRsp.authToken.calls.length).to.equal(1);
    expect(apiRsp.authToken.calls[0].opts.size).to.equal(16 * 1024);
    expect(apiRsp.userInfo.calls[0].opts.size).to.equal(64 * 1024);
  });

  it("retains and redeems a split-origin result once after a parent reload", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const apiRsp = addGithubApiResponses();
    const clientOrigin = "https://client.pk910.de";
    faucetConfig.corsAllowOrigin = [clientOrigin];

    const wrongIssueOriginRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "POST",
      url: `/api/githubAuthState?clientOrigin=${encodeURIComponent(clientOrigin)}`,
      headers: { host: "faucets.pk910.de", origin: "https://attacker.example" },
      socket: { encrypted: true, remoteAddress: "::ffff:8.8.8.8" },
    } as any);
    expect(wrongIssueOriginRsp.code).to.equal(400);

    const issued = await issueBoundAuthState(clientOrigin);
    const authState = issued.state;

    const wrongOriginRsp = await requestAuthResult(
      authState,
      clientOrigin,
      "https://attacker.example",
      issued.browserCookie,
    );
    expect(wrongOriginRsp.code).to.equal(400);

    const pendingRsp = await requestAuthResult(
      authState,
      clientOrigin,
      clientOrigin,
      issued.browserCookie,
    );
    expect(pendingRsp.code).to.equal(202);
    expect(pendingRsp.headers["Access-Control-Allow-Origin"]).to.equal(clientOrigin);
    expect(pendingRsp.headers["Access-Control-Allow-Credentials"]).to.equal("true");
    expect(pendingRsp.headers.Vary).to.equal("Origin");
    expect(JSON.parse(pendingRsp.body)).to.deep.equal({ status: "pending" });

    const callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: withCallbackContext(
        "/api/githubCallback?code=test_auth_code",
        clientOrigin,
        authState,
      ),
      headers: {
        cookie: issued.browserCookie,
        "sec-fetch-site": "cross-site",
      },
    } as any);
    expect(callbackRsp.code).to.equal(200);
    expect(callbackRsp.body).to.include('authModule":"github"');
    expect(callbackRsp.body).to.include(`targetOrigin = "${clientOrigin}"`);
    expect(callbackRsp.body).to.not.include("window.localStorage");
    expect(getBindingCookie(callbackRsp, authState)).to.equal(issued.browserCookie);
    expect(apiRsp.authToken.calls.length).to.equal(1);

    const recoveredRsp = await requestAuthResult(
      authState,
      clientOrigin,
      clientOrigin,
      issued.browserCookie,
    );
    expect(recoveredRsp.code).to.equal(200);
    expect(recoveredRsp.headers["Cache-Control"]).to.equal("no-store");
    expect(recoveredRsp.headers["Access-Control-Allow-Origin"]).to.equal(clientOrigin);
    expect(recoveredRsp.headers["Access-Control-Allow-Credentials"]).to.equal("true");
    const recoveredEnvelope = JSON.parse(recoveredRsp.body);
    expect(recoveredEnvelope.authModule).to.equal("github");
    expect(recoveredEnvelope.authState).to.equal(authState);
    expect(recoveredEnvelope.authResult.data.user).to.equal("testus");

    const replayRsp = await requestAuthResult(
      authState,
      clientOrigin,
      clientOrigin,
      issued.browserCookie,
    );
    expect(replayRsp.code).to.equal(400);
    expect(apiRsp.authToken.calls.length).to.equal(1);
  });

  it("rejects a callback from another browser without consuming the issuer state", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const apiRsp = addGithubApiResponses();
    const clientOrigin = "https://client.pk910.de";
    faucetConfig.corsAllowOrigin = [clientOrigin];
    const browserA = await issueBoundAuthState(clientOrigin);
    const browserB = await issueBoundAuthState(clientOrigin);
    expect(browserB.browserCookie).to.not.equal(browserA.browserCookie);

    const callbackUrl = withCallbackContext(
      "/api/githubCallback?code=test_auth_code",
      clientOrigin,
      browserA.state,
    );
    const browserBRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: callbackUrl,
      headers: { cookie: browserB.browserCookie },
    } as any);
    expect(browserBRsp.code).to.equal(400);
    expect(apiRsp.authToken.calls.length).to.equal(0);

    const browserARsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: callbackUrl,
      headers: { cookie: browserA.browserCookie },
    } as any);
    expect(browserARsp.code).to.equal(200);
    expect(apiRsp.authToken.calls.length).to.equal(1);
  });

  it("allows only the issuing browser to redeem a split-origin result", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const apiRsp = addGithubApiResponses();
    const clientOrigin = "https://client.pk910.de";
    faucetConfig.corsAllowOrigin = [clientOrigin];
    const browserA = await issueBoundAuthState(clientOrigin);
    const browserB = await issueBoundAuthState(clientOrigin);

    const callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: withCallbackContext(
        "/api/githubCallback?code=test_auth_code",
        clientOrigin,
        browserA.state,
      ),
      headers: { cookie: browserA.browserCookie },
    } as any);
    expect(callbackRsp.code).to.equal(200);
    expect(apiRsp.authToken.calls.length).to.equal(1);

    const browserBRsp = await requestAuthResult(
      browserA.state,
      clientOrigin,
      clientOrigin,
      browserB.browserCookie,
    );
    expect(browserBRsp.code).to.equal(400);
    expect(browserBRsp.headers["Access-Control-Allow-Origin"]).to.equal(clientOrigin);
    expect(browserBRsp.headers["Access-Control-Allow-Credentials"]).to.equal("true");

    const browserARsp = await requestAuthResult(
      browserA.state,
      clientOrigin,
      clientOrigin,
      browserA.browserCookie,
    );
    expect(browserARsp.code).to.equal(200);
    expect(JSON.parse(browserARsp.body).authResult.data.user).to.equal("testus");

    const replayRsp = await requestAuthResult(
      browserA.state,
      clientOrigin,
      clientOrigin,
      browserA.browserCookie,
    );
    expect(replayRsp.code).to.equal(400);
    expect(apiRsp.authToken.calls.length).to.equal(1);
  });

  it("rejects cross-site or unclassified result requests without consuming the result", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    addGithubApiResponses();
    const clientOrigin = "https://client.pk910.de";
    faucetConfig.corsAllowOrigin = [clientOrigin];
    const issued = await issueBoundAuthState(clientOrigin);

    const callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: withCallbackContext(
        "/api/githubCallback?code=test_auth_code",
        clientOrigin,
        issued.state,
      ),
      headers: { cookie: issued.browserCookie },
    } as any);
    expect(callbackRsp.code).to.equal(200);

    for(const [label, secFetchSite] of [
      ["cross-site", "cross-site"],
      ["missing", null],
    ] as const) {
      const response = await requestAuthResult(
        issued.state,
        clientOrigin,
        clientOrigin,
        issued.browserCookie,
        secFetchSite,
      );
      expect(response.code, label).to.equal(400);
      expect(response.headers["Access-Control-Allow-Origin"], label).to.equal(clientOrigin);
      expect(response.headers["Access-Control-Allow-Credentials"], label).to.equal("true");
      expect(response.headers.Vary, label).to.equal("Origin");
    }

    const issuerResponse = await requestAuthResult(
      issued.state,
      clientOrigin,
      clientOrigin,
      issued.browserCookie,
    );
    expect(issuerResponse.code).to.equal(200);
    expect(JSON.parse(issuerResponse.body).authResult.data.user).to.equal("testus");
  });

  it("rejects missing, malformed, and duplicate binding cookies without consuming the flow", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const apiRsp = addGithubApiResponses();
    const clientOrigin = "https://client.pk910.de";
    faucetConfig.corsAllowOrigin = [clientOrigin];
    const issued = await issueBoundAuthState(clientOrigin);
    const callbackUrl = withCallbackContext(
      "/api/githubCallback?code=test_auth_code",
      clientOrigin,
      issued.state,
    );
    const malformedCookies = [
      undefined,
      `${GITHUB_AUTH_BINDING_COOKIE_PREFIX}${issued.state}=not-hex`,
      `${issued.browserCookie}; ${GITHUB_AUTH_BINDING_COOKIE_PREFIX}${issued.state}=${"b".repeat(64)}`,
    ];

    for(const browserCookie of malformedCookies) {
      const callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
        method: "GET",
        url: callbackUrl,
        headers: browserCookie ? { cookie: browserCookie } : {},
      } as any);
      expect(callbackRsp.code).to.equal(400);
      expect(apiRsp.authToken.calls.length).to.equal(0);
    }

    const validCallbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: callbackUrl,
      headers: { cookie: issued.browserCookie },
    } as any);
    expect(validCallbackRsp.code).to.equal(200);
    expect(apiRsp.authToken.calls.length).to.equal(1);

    for(const browserCookie of malformedCookies) {
      const resultRsp = await requestAuthResult(
        issued.state,
        clientOrigin,
        clientOrigin,
        browserCookie,
      );
      expect(resultRsp.code).to.equal(400);
    }

    const validResultRsp = await requestAuthResult(
      issued.state,
      clientOrigin,
      clientOrigin,
      issued.browserCookie,
    );
    expect(validResultRsp.code).to.equal(200);
  });

  it("keeps parallel split-origin flows independently browser-bound", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    const apiRsp = addGithubApiResponses();
    const clientOrigin = "https://client.pk910.de";
    faucetConfig.corsAllowOrigin = [clientOrigin];
    const [first, second] = await Promise.all([
      issueBoundAuthState(clientOrigin),
      issueBoundAuthState(clientOrigin),
    ]);
    expect(second.browserCookie).to.not.equal(first.browserCookie);
    const browserCookies = `unrelated=value; ${first.browserCookie}; ${second.browserCookie}`;

    const responses = await Promise.all([first.state, second.state].map((state, index) =>
      ServiceManager.GetService(FaucetWebApi).onApiRequest({
        method: "GET",
        url: withCallbackContext(
          `/api/githubCallback?code=parallel_auth_code_${index}`,
          clientOrigin,
          state,
        ),
        headers: { cookie: browserCookies },
      } as any)
    ));
    expect(responses.map((response) => response.code)).to.deep.equal([200, 200]);
    expect(apiRsp.authToken.calls.length).to.equal(2);
  });

  it("expires an unclaimed split-origin result", async () => {
    const clock = sinon.useFakeTimers({ now: Date.now() });
    try {
      await ServiceManager.GetService(ModuleManager).initialize();
      const clientOrigin = "https://client.pk910.de";
      faucetConfig.corsAllowOrigin = [clientOrigin];
      const issued = await issueBoundAuthState(clientOrigin);
      const authState = issued.state;
      const callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
        method: "GET",
        url: withCallbackContext("/api/githubCallback?error=access_denied", clientOrigin, authState),
        headers: { cookie: issued.browserCookie },
      } as any);
      expect(callbackRsp.code).to.equal(200);

      await clock.tickAsync(5 * 60 * 1000);
      const expiredRsp = await requestAuthResult(
        authState,
        clientOrigin,
        clientOrigin,
        issued.browserCookie,
      );
      expect(expiredRsp.code).to.equal(400);
    } finally {
      clock.restore();
    }
  });

  it("Check authentication callback: api error", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    let apiRsp = addGithubApiResponses();
    apiRsp.authToken.fail = true;
    apiRsp.authToken.rsp = "test error";
    const emitLog = sinon.stub(ServiceManager.GetService(FaucetProcess), "emitLog");
    const authState = await issueAuthState();
    let callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: withCallbackContext("/api/githubCallback?code=test_auth_code", CALLBACK_ORIGIN, authState),
    } as any);
    expect(callbackRsp instanceof FaucetHttpResponse).to.equal(true, "unexpected api response");
    expect(callbackRsp.body).to.matches(/AUTH_ERROR/, "AUTH_ERROR error code not in response page");
    expect(callbackRsp.body).to.include("Could not complete GitHub authentication.");
    expect(callbackRsp.body).to.not.include("test error");
    expect(emitLog.calledOnce).to.equal(true, "unexpected exchange failure was not logged");
    expect(emitLog.firstCall.args[1]).to.include("test error");
  });

  it("Check authentication callback: unexpected error", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    let apiRsp = addGithubApiResponses();
    apiRsp.authToken.rsp = {text: () => Promise.resolve("no proper response")};
    const authState = await issueAuthState();
    let callbackRsp = await ServiceManager.GetService(FaucetWebApi).onApiRequest({
      method: "GET",
      url: withCallbackContext("/api/githubCallback?code=test_auth_code", CALLBACK_ORIGIN, authState),
    } as any);
    expect(callbackRsp instanceof FaucetHttpResponse).to.equal(true, "unexpected api response");
    expect(callbackRsp.body).to.matches(/AUTH_ERROR/, "AUTH_ERROR error code not in response page");
    expect(callbackRsp.body).to.include("Could not complete GitHub authentication.");
    expect(callbackRsp.body).to.not.include("no proper response");
  });

  it("Check github based recurring restrictions: exceed session count", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    (faucetConfig.modules["github"] as IGithubConfig).restrictions.push({
      limitCount: 1,
      limitAmount: 0,
      duration: 10,
      message: "test-message"
    });
    let apiRsp = addGithubApiResponses();
    let testSession1 = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      githubToken: generateTestToken("test-github-token", 1337),
    });
    expect(testSession1.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(testSession1.getSessionData("github.uid")).to.equal(1337, "unexpected github info in session data: github.uid");

    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        githubToken: generateTestToken("test-github-token", 1337),
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("GITHUB_LIMIT", "unexpected error code");
    expect(error?.message).to.matches(/test-message/, "unexpected error message");
  });

  it("Check github based recurring restrictions: exceed total amount", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    (faucetConfig.modules["github"] as IGithubConfig).restrictions.push({
      limitCount: 0,
      limitAmount: 10,
      duration: 10,
      message: "test-message"
    });
    let apiRsp = addGithubApiResponses();
    let testSession1 = await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
      addr: "0x0000000000000000000000000000000000001337",
      githubToken: generateTestToken("test-github-token", 1337),
    });
    expect(testSession1.getSessionStatus()).to.equal("claimable", "unexpected session status");
    expect(testSession1.getSessionData("github.uid")).to.equal(1337, "unexpected github info in session data: github.uid");

    let error: FaucetError | null = null;
    try {
      await ServiceManager.GetService(SessionManager).createSession("::ffff:8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        githubToken: generateTestToken("test-github-token", 1337),
      });
    } catch(ex) {
      error = ex;
    }
    expect(error).to.not.equal(null, "no exception thrown");
    expect(error instanceof FaucetError).to.equal(true, "unexpected error type");
    expect(error?.getCode()).to.equal("GITHUB_LIMIT", "unexpected error code");
    expect(error?.message).to.matches(/test-message/, "unexpected error message");
  });

  it("admits only the first concurrent restriction check for one Github user", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    (faucetConfig.modules["github"] as IGithubConfig).restrictions.push({
      limitCount: 1,
      limitAmount: 0,
      duration: 10,
    });
    let githubModule = ServiceManager.GetService(ModuleManager).getModule<any>("github");
    sinon.stub(githubModule.githubResolver, "getGithubInfo").resolves({
      uid: 1337,
      user: "testus",
      info: {},
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    let results = await Promise.allSettled([
      sessionManager.createSession("8.8.8.8", {
        addr: "0x0000000000000000000000000000000000001337",
        githubToken: "first-token",
      }),
      sessionManager.createSession("8.8.4.4", {
        addr: "0x0000000000000000000000000000000000001338",
        githubToken: "second-token",
      }),
    ]);
    let fulfilled = results.filter((result) => result.status === "fulfilled") as PromiseFulfilledResult<FaucetSession>[];
    let rejected = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];

    expect(fulfilled.length).to.equal(1);
    expect(fulfilled[0].value.getSessionStatus()).to.equal(FaucetSessionStatus.CLAIMABLE);
    expect(rejected.length).to.equal(1);
    expect(rejected[0].reason).to.be.instanceOf(FaucetError);
    expect(rejected[0].reason.getCode()).to.equal("GITHUB_LIMIT");
  });

  it("restores Github reservations before admitting new traffic", async () => {
    await ServiceManager.GetService(ModuleManager).initialize();
    (faucetConfig.modules["github"] as IGithubConfig).restrictions.push({
      limitCount: 1,
      limitAmount: 0,
      duration: 10,
    });
    let now = Math.floor(Date.now() / 1000);
    await ServiceManager.GetService(FaucetDatabase).updateSession({
      sessionId: "4e63566e-e482-46f3-bb91-da11f511c004",
      status: FaucetSessionStatus.RUNNING,
      startTime: now,
      targetAddr: "0x0000000000000000000000000000000000001337",
      dropAmount: "1000000000000000000",
      remoteIP: "8.8.8.8",
      tasks: [{module: "test", name: "test", timeout: 0}],
      data: {"github.uid": 1337, "github.user": "testus"},
      claim: null,
    });
    let sessionManager = ServiceManager.GetService(SessionManager);
    await sessionManager.initialize();
    addGithubApiResponses();

    let error: FaucetError | null = null;
    try {
      await sessionManager.createSession("8.8.4.4", {
        addr: "0x0000000000000000000000000000000000001338",
        githubToken: generateTestToken("test-github-token", 1337),
      });
    } catch(ex) {
      error = ex;
    }
    expect(error?.getCode()).to.equal("GITHUB_LIMIT");
  });

});
