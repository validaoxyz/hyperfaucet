import { IClientClaimStatusRsp, IClientFaucetStatusRsp } from "../types/FaucetStatus";
import { IPassportInfo } from "../types/PassportInfo";
import { IFaucetConfig } from "./FaucetConfig";
import { IFaucetSessionInfo, IFaucetSessionStatus } from "./FaucetSession";
import { FaucetTime } from "./FaucetTime";
import { IStakeChallengeResponse, IStakeInfoResponse } from "../types/StakeInfo";

type ApiQueryArgs = {[arg: string]: string | number | undefined};

class FaucetApiResponseError extends Error {
  public readonly status: number;

  public constructor(response: Response) {
    super(response.statusText || response.status.toString());
    this.status = response.status;
  }
}

export class FaucetApi {
  private faucetTime: FaucetTime;
  private apiBaseUrl: string;

  public constructor(apiUrl: string) {
    this.faucetTime = new FaucetTime();
    if(apiUrl.match(/\/$/))
      apiUrl = apiUrl.substring(0, apiUrl.length - 1);
    this.apiBaseUrl = apiUrl;
  }

  public getFaucetTime(): FaucetTime {
    return this.faucetTime;
  }

  public getApiUrl(endpoint?: string, fqdn?: boolean): string {
    if(!endpoint)
      endpoint = "";
    else if(!endpoint.match(/^\//))
      endpoint = "/" + endpoint;
    let apiUrl = this.apiBaseUrl + endpoint;
    if(fqdn && apiUrl.match(/^\//)) {
      // add current host
      let hostUrl = location.protocol + "//" + location.host;
      apiUrl = hostUrl + apiUrl;
    }
    return apiUrl;
  }

  private buildRequestUrl(endpoint: string, args?: ApiQueryArgs): string {
    if(!endpoint.match(/^\//))
      endpoint = "/" + endpoint;

    let queryString = "";
    if(args) {
      let argParts: string[] = [];
      Object.keys(args).forEach((key) => {
        const value = args[key];
        if(value === undefined)
          return;
        argParts.push(encodeURIComponent(key) + "=" + encodeURIComponent(value.toString()));
      });
      if(argParts.length > 0) {
        queryString = "?" + argParts.join("&");
      }
    }

    return this.apiBaseUrl + endpoint + queryString;
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    let responseData: unknown;
    try {
      responseData = await response.json();
    } catch {
      throw new FaucetApiResponseError(response);
    }

    if(!response.ok) {
      if(responseData !== null && typeof responseData === "object" && !Array.isArray(responseData))
        throw responseData;
      throw new FaucetApiResponseError(response);
    }

    return responseData as T;
  }

  private async apiRequest<T>(endpoint: string, args?: ApiQueryArgs, request?: RequestInit): Promise<T> {
    const response = await fetch(this.buildRequestUrl(endpoint, args), request);
    return this.parseResponse<T>(response);
  }

  private apiGet<T>(endpoint: string, args?: ApiQueryArgs): Promise<T> {
    return this.apiRequest<T>(endpoint, args);
  }

  private apiPost<T>(endpoint: string, args?: ApiQueryArgs, data?: unknown): Promise<T> {
    return this.apiRequest<T>(endpoint, args, {
      method: "POST",
      cache: "no-cache",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
  }

  public getFaucetConfig(): Promise<IFaucetConfig> {
    return this.apiGet<IFaucetConfig>("/getFaucetConfig", {
      cliver: FAUCET_CLIENT_VERSION,
    }).then((config) => {
      this.faucetTime.syncTimeOffset(config.time);
      return config;
    });
  }

  public getSession(sessionId: string): Promise<IFaucetSessionInfo> {
    return this.apiGet<IFaucetSessionInfo>("/getSession", {
      session: sessionId,
    });
  }

  public getSessionStatus(sessionId: string, details?: boolean): Promise<IFaucetSessionStatus> {
    return this.apiGet<IFaucetSessionStatus>("/getSessionStatus", {
      session: sessionId,
      details: details ? "true" : undefined,
    });
  }

  public startSession(inputData: any): Promise<IFaucetSessionInfo> {
    return this.apiPost<IFaucetSessionInfo>("/startSession", {
      cliver: FAUCET_CLIENT_VERSION,
    }, inputData);
  }

  public claimReward(inputData: any): Promise<IFaucetSessionStatus> {
    return this.apiPost<IFaucetSessionStatus>("/claimReward", {}, inputData);
  }

  public getQueueStatus(): Promise<IClientClaimStatusRsp> {
    return this.apiGet<IClientClaimStatusRsp>("/getQueueStatus");
  }

  public getFaucetStatus(): Promise<IClientFaucetStatusRsp> {
    return this.apiGet<IClientFaucetStatusRsp>("/getFaucetStatus");
  }

  public getPassportInfo(sessionId: string, address: string): Promise<IPassportInfo> {
    return this.apiGet<IPassportInfo>("/getPassportInfo", {
      session: sessionId,
      address: address,
    });
  }

  public refreshPassport(sessionId: string, address: string): Promise<IPassportInfo> {
    return this.apiGet<IPassportInfo>("/refreshPassport", {
      session: sessionId,
      address: address,
    });
  }

  public refreshPassportJson(sessionId: string, address: string, json: string): Promise<IPassportInfo> {
    return this.apiPost<IPassportInfo>("/refreshPassport", {
      session: sessionId,
      address: address,
    }, json);
  }

  public getStakeInfo(sessionId: string, address: string, refresh?: boolean): Promise<IStakeInfoResponse> {
    return this.apiGet<IStakeInfoResponse>("/getStakeInfo", sessionId ? {
      session: sessionId,
    } : {
      address: address,
      ...(refresh ? { refresh: 1 } : {}),
    });
  }

  public refreshStakeInfo(sessionId: string): Promise<IStakeInfoResponse> {
    return this.apiPost<IStakeInfoResponse>("/refreshStakeInfo", {
      session: sessionId,
    }, {});
  }

  public getStakeChallenge(sessionId: string): Promise<IStakeChallengeResponse> {
    return this.apiPost<IStakeChallengeResponse>("/getStakeChallenge", undefined, {
      session: sessionId,
    });
  }

  public verifyStakeOwnership(
    sessionId: string,
    challengeId: string,
    signature: string,
  ): Promise<IStakeInfoResponse> {
    return this.apiPost<IStakeInfoResponse>("/verifyStakeOwnership", undefined, {
      session: sessionId,
      challengeId,
      signature,
    });
  }

}
