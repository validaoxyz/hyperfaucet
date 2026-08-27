import { FetchUtil } from '../../utils/FetchUtil.js';
import { faucetConfig } from "../../config/FaucetConfig.js";
import { decryptTokenPayload, encryptTokenPayload } from "../../utils/CryptoUtils.js";
import { GithubModule } from "./GithubModule.js";

export interface IGithubAuthInfo {
  time: number;
  uid: number;
  user: string;
  url: string;
  avatar: string;
  token: string;
}

export interface IGithubUserInfo {
  uid: number;
  user: string;
  api: string;
  url: string;
  avatar: string;
  repos: number;
  followers: number;
  created: number;
}

export interface IGithubInfoOpts {
  loadOwnRepo: boolean;
}

export interface IGithubInfo {
  time: number;
  uid: number;
  user: string;
  loaded: string[];
  info: {
    createTime: number;
    repoCount: number;
    followers: number;
    ownRepoCount?: number;
    ownRepoStars?: number;
    ownRepoForks?: number;
  }
}

interface IGithubFaucetTokenPayload {
  kind: "github";
  issuedAt: number;
  userId: number;
  accessToken: string;
}

const GITHUB_TOKEN_PAYLOAD_KEYS = ["kind", "issuedAt", "userId", "accessToken"] as const;
const GITHUB_ACCESS_TOKEN_MAX_LENGTH = 4096;
const GITHUB_PROFILE_STRING_MAX_LENGTH = 4096;
const MAX_CONCURRENT_AUTH_EXCHANGES = 4;
const GITHUB_TOKEN_RESPONSE_MAX_BYTES = 16 * 1024;
const GITHUB_PROFILE_RESPONSE_MAX_BYTES = 64 * 1024;
const GITHUB_GRAPHQL_RESPONSE_MAX_BYTES = 256 * 1024;
const GITHUB_AUTH_EXCHANGE_WINDOW_MS = 60 * 1000;
const GITHUB_AUTH_EXCHANGE_GLOBAL_LIMIT = 60;
export const GITHUB_AUTH_EXCHANGE_OWNER_LIMIT = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isGithubFaucetTokenPayload(value: unknown): value is IGithubFaucetTokenPayload {
  if(!isRecord(value) || Object.keys(value).length !== GITHUB_TOKEN_PAYLOAD_KEYS.length)
    return false;

  return GITHUB_TOKEN_PAYLOAD_KEYS.every((key) => key in value)
    && value.kind === "github"
    && isSafeInteger(value.issuedAt, 0)
    && isSafeInteger(value.userId, 1)
    && isBoundedString(value.accessToken, GITHUB_ACCESS_TOKEN_MAX_LENGTH);
}

function parseGithubUserInfo(value: unknown): IGithubUserInfo {
  if(!isRecord(value))
    throw new Error("GitHub returned an invalid user profile.");

  const user = isBoundedString(value.name, GITHUB_PROFILE_STRING_MAX_LENGTH)
    ? value.name
    : value.login;
  const created = typeof value.created_at === "string"
    ? Math.floor(Date.parse(value.created_at) / 1000)
    : Number.NaN;

  if(!isSafeInteger(value.id, 1)
    || !isBoundedString(user, GITHUB_PROFILE_STRING_MAX_LENGTH)
    || !isBoundedString(value.url, GITHUB_PROFILE_STRING_MAX_LENGTH)
    || !isBoundedString(value.html_url, GITHUB_PROFILE_STRING_MAX_LENGTH)
    || !isBoundedString(value.avatar_url, GITHUB_PROFILE_STRING_MAX_LENGTH)
    || !isSafeInteger(value.public_repos, 0)
    || !isSafeInteger(value.followers, 0)
    || !Number.isSafeInteger(created)
    || created < 0
  ) {
    throw new Error("GitHub returned an invalid user profile.");
  }

  return {
    uid: value.id,
    user,
    api: value.url,
    url: value.html_url,
    avatar: value.avatar_url,
    repos: value.public_repos,
    followers: value.followers,
    created,
  };
}


export class GithubResolver {
  private module: GithubModule;
  private authExchangesInFlight = 0;
  private readonly authExchangeStarts: number[] = [];
  private readonly authExchangeStartsByOwner = new Map<string, number[]>();

  public constructor(module: GithubModule) {
    this.module = module;
  }

  private now(): number {
    return Math.floor((new Date()).getTime() / 1000);
  }

  public async createAuthInfo(authCode: string, ownerIp: string): Promise<IGithubAuthInfo> {
    if(this.authExchangesInFlight >= MAX_CONCURRENT_AUTH_EXCHANGES)
      throw new Error("GitHub authentication capacity reached.");
    this.reserveAuthExchange(ownerIp);

    this.authExchangesInFlight++;
    try {
      return await this.exchangeAuthInfo(authCode);
    } finally {
      this.authExchangesInFlight--;
    }
  }

  private async exchangeAuthInfo(authCode: string): Promise<IGithubAuthInfo> {
    // get access token
    let accessToken: string;

    try {
      let tokenReqData = new URLSearchParams();
      tokenReqData.append("client_id", this.module.getModuleConfig().appClientId);
      tokenReqData.append("client_secret", this.module.getModuleConfig().appSecret);
      tokenReqData.append("code", authCode);
      let tokenRsp = await FetchUtil.fetchWithTimeout("https://github.com/login/oauth/access_token", {
        method: 'POST',
        body: tokenReqData,
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        size: GITHUB_TOKEN_RESPONSE_MAX_BYTES,
      }, 10000).then((rsp) => rsp.text());
      
      const tokenRspData = new URLSearchParams(tokenRsp);
      const responseAccessToken = tokenRspData.get("access_token");
      if(responseAccessToken) {
        accessToken = responseAccessToken;
      } else {
        const errorCode = tokenRspData.get("error");
        const errorDescription = tokenRspData.get("error_description");
        const errorSuffix = errorCode
          ? `: [${errorCode}] ${errorDescription || ""}`
          : "";
        throw new Error("could not fetch access token" + errorSuffix);
      }
    } catch(ex) {
      const message = ex instanceof Error ? ex.message : String(ex);
      throw new Error("error while fetching access token: " + message);
    }

    let userInfo = await this.fetchProfileInfo(accessToken);
    let now = Math.floor(new Date().getTime() / 1000);
    let faucetToken = this.generateFaucetToken(accessToken, userInfo.uid, now);
    return {
      time: now,
      uid: userInfo.uid,
      user: userInfo.user,
      url: userInfo.url,
      avatar: userInfo.avatar,
      token: faucetToken,
    };
  }

  private getTokenPassphrase() {
    return faucetConfig.faucetSecret + "-" + this.module.getModuleName() + "-authtoken";
  }

  private generateFaucetToken(accessToken: string, userId: number, time: number): string {
    const payload: IGithubFaucetTokenPayload = {
      kind: "github",
      issuedAt: time,
      userId,
      accessToken,
    };
    if(!isGithubFaucetTokenPayload(payload))
      throw new Error("Invalid GitHub token payload.");

    return encryptTokenPayload(payload, this.getTokenPassphrase());
  }

  private parseFaucetToken(faucetToken: string): IGithubFaucetTokenPayload | null {
    const payload = decryptTokenPayload(faucetToken, this.getTokenPassphrase());
    if(!isGithubFaucetTokenPayload(payload))
      return null;
    return payload;
  }

  private async fetchProfileInfo(accessToken: string): Promise<IGithubUserInfo> {
    const userData: unknown = await FetchUtil.fetchWithTimeout("https://api.github.com/user", {
      method: 'GET',
      headers: {'Authorization': 'token ' + accessToken},
      size: GITHUB_PROFILE_RESPONSE_MAX_BYTES,
    }, 10000).then((rsp) => rsp.json());
    return parseGithubUserInfo(userData);
  }

  public async getGithubInfo(token: string, opts: IGithubInfoOpts): Promise<IGithubInfo> {
    // parse token
    let tokenData = this.parseFaucetToken(token);
    if(!tokenData)
      throw "invalid github token";
    if(tokenData.issuedAt + this.module.getModuleConfig().authTimeout < this.now())
      throw "github token expired";
    const accessToken = tokenData.accessToken;
    const userId = tokenData.userId;
    
    let cachedGithubInfo = await this.module.getGithubDb().getGithubInfo(userId);
    if(cachedGithubInfo && // check if all optional fields are loaded in the cached info
      (!opts.loadOwnRepo || cachedGithubInfo.loaded.indexOf("ownrepos") !== -1)
    ) {
      return cachedGithubInfo;
    }

    let userInfo = await this.fetchProfileInfo(accessToken);
    if(userInfo.uid !== userId)
      throw new Error("GitHub token identity mismatch.");
    let promises: Promise<void>[] = [];
    let githubInfo: IGithubInfo = {
      time: this.now(),
      uid: userInfo.uid,
      user: userInfo.user,
      loaded: [],
      info: {
        createTime: userInfo.created,
        repoCount: userInfo.repos,
        followers: userInfo.followers,
      }
    };
    if(opts.loadOwnRepo) {
      githubInfo.loaded.push("ownrepos");
      promises.push(this.loadOwnRepoInfo(githubInfo, accessToken));
    }

    await Promise.all(promises);
    await this.module.getGithubDb().setGithubInfo(userId, githubInfo, this.module.getModuleConfig().cacheTime);
    return githubInfo;
  }

  private async loadOwnRepoInfo(githubInfo: IGithubInfo, accessToken: string) {
    let graphQuery = `{
      viewer {
        repositories(
          first: 100
          isFork: false
          privacy: PUBLIC
          ownerAffiliations: OWNER
        ) {
          edges {
            node {
              id
              name
              forkCount
              stargazerCount
              url
            }
          }
        }
      }
    }`;
    let graphData = await FetchUtil.fetchWithTimeout("https://api.github.com/graphql", {
      method: 'POST',
      body: JSON.stringify({
        query: graphQuery,
      }),
      headers: {
        'Authorization': 'token ' + accessToken,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      size: GITHUB_GRAPHQL_RESPONSE_MAX_BYTES,
    }, 15000).then((rsp) => rsp.json()) as any;

    githubInfo.info.ownRepoCount = 0;
    githubInfo.info.ownRepoStars = 0;
    githubInfo.info.ownRepoForks = 0;
    let repositories = graphData.data.viewer.repositories.edges;
    for(let i = 0; i < repositories.length; i++) {
      githubInfo.info.ownRepoCount++;
      githubInfo.info.ownRepoStars += repositories[i].node.stargazerCount;
      githubInfo.info.ownRepoForks += repositories[i].node.forkCount;
    }
  }

  private reserveAuthExchange(ownerIp: string): void {
    if(typeof ownerIp !== "string" || ownerIp.length === 0 || ownerIp.length > 64)
      throw new Error("GitHub authentication owner is invalid.");

    const now = Date.now();
    const cutoff = now - GITHUB_AUTH_EXCHANGE_WINDOW_MS;
    this.pruneAuthExchangeStarts(this.authExchangeStarts, cutoff);
    for(const [owner, starts] of this.authExchangeStartsByOwner) {
      this.pruneAuthExchangeStarts(starts, cutoff);
      if(starts.length === 0)
        this.authExchangeStartsByOwner.delete(owner);
    }

    const ownerStarts = this.authExchangeStartsByOwner.get(ownerIp) || [];
    if(this.authExchangeStarts.length >= GITHUB_AUTH_EXCHANGE_GLOBAL_LIMIT
      || ownerStarts.length >= GITHUB_AUTH_EXCHANGE_OWNER_LIMIT
    ) {
      throw new Error("GitHub authentication rate limit reached.");
    }

    this.authExchangeStarts.push(now);
    ownerStarts.push(now);
    this.authExchangeStartsByOwner.set(ownerIp, ownerStarts);
  }

  private pruneAuthExchangeStarts(starts: number[], cutoff: number): void {
    while(starts.length > 0 && starts[0] <= cutoff)
      starts.shift();
  }

}
