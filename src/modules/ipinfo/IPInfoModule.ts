import * as fs from 'fs';
import YAML from 'yaml'
import { ServiceManager } from "../../common/ServiceManager.js";
import { FaucetSession } from "../../session/FaucetSession.js";
import { BaseModule } from "../BaseModule.js";
import { ModuleHookAction } from "../ModuleManager.js";
import { FaucetError, PublicFaucetError } from '../../common/FaucetError.js';
import { defaultConfig, IIPInfoConfig, IIPInfoRestrictionConfig } from "./IPInfoConfig.js";
import { IIPInfo, IPInfoResolver } from "./IPInfoResolver.js";
import { resolveRelativePath } from "../../config/FaucetConfig.js";
import { ISessionRewardFactor } from '../../session/SessionRewardFactor.js';
import { IPInfoDB } from './IPInfoDB.js';
import { FaucetDatabase } from '../../db/FaucetDatabase.js';
import { FaucetLogLevel, FaucetProcess } from '../../common/FaucetProcess.js';

export interface IIPInfoRestriction {
  reward: number;
  messages: {
    key: string;
    text: string;
    notify: boolean|string;
  }[];
  blocked: false|"close"|"kill";
  hostingBased: boolean;
  proxyBased: boolean;
}

export class IPInfoModule extends BaseModule<IIPInfoConfig> {
  protected readonly moduleDefaultConfig = defaultConfig;
  private ipInfoDb: IPInfoDB;
  private ipInfoResolver: IPInfoResolver;
  private ipInfoMatchRestrictions: [pattern: string, restriction: number | IIPInfoRestrictionConfig][];
  private ipInfoMatchRestrictionsRefresh: number;
  private sessionRewardFactorCacheTimeout: number = 30;

  protected override async startModule(): Promise<void> {
    this.validateApiUrl();
    this.ipInfoDb = await ServiceManager.GetService(FaucetDatabase).createModuleDb(IPInfoDB, this);
    this.ipInfoResolver = new IPInfoResolver(this.ipInfoDb, this.moduleConfig.apiUrl, this.moduleConfig.cacheTime);
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionStart, 7, "IP Info check", 
      (session: FaucetSession) => this.processSessionStart(session)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionIpChange, 6, "IP Info check", 
      (session: FaucetSession) => this.processSessionStart(session)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionRewardFactor, 6, "IP restrictions", 
      (session: FaucetSession, rewardFactors: ISessionRewardFactor[]) => this.processSessionRewardFactor(session, rewardFactors)
    );
  }

  protected override async stopModule(): Promise<void> {
    await this.ipInfoResolver?.stop();
    this.ipInfoDb?.dispose();
    this.ipInfoResolver = null;
    this.ipInfoDb = null;
  }

  protected override async onConfigReload(): Promise<void> {
    this.validateApiUrl();
    await this.ipInfoResolver.reload(this.moduleConfig.apiUrl, this.moduleConfig.cacheTime);
    this.ipInfoMatchRestrictionsRefresh = 0;
  }

  private validateApiUrl(): void {
    if(typeof this.moduleConfig.apiUrl !== "string" || this.moduleConfig.apiUrl.split("{ip}").length !== 2)
      throw new Error("ipinfo apiUrl must contain exactly one {ip} placeholder");

    let parsed: URL;
    let alternate: URL;
    try {
      parsed = new URL(this.moduleConfig.apiUrl.replace("{ip}", "192.0.2.1"));
      alternate = new URL(this.moduleConfig.apiUrl.replace("{ip}", "198.51.100.1"));
    } catch(ex) {
      throw new Error("ipinfo apiUrl is invalid");
    }
    if(parsed.protocol !== "https:")
      throw new Error("ipinfo apiUrl must use HTTPS");
    if(parsed.host !== alternate.host || parsed.username !== alternate.username || parsed.password !== alternate.password)
      throw new Error("ipinfo apiUrl must not place {ip} in the URL authority");
    let fragmentIndex = this.moduleConfig.apiUrl.indexOf("#");
    if(fragmentIndex !== -1 && this.moduleConfig.apiUrl.indexOf("{ip}") > fragmentIndex)
      throw new Error("ipinfo apiUrl must not place {ip} in the URL fragment");
    if(!Number.isSafeInteger(this.moduleConfig.cacheTime) || this.moduleConfig.cacheTime < 1 || this.moduleConfig.cacheTime > 365 * 86400)
      throw new Error("ipinfo cacheTime must be an integer between 1 and 31536000");
  }

  private async processSessionStart(session: FaucetSession): Promise<void> {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    let remoteIp = session.getRemoteIP();
    let ipInfo: IIPInfo;
    try {
      ipInfo = await this.ipInfoResolver.getIpInfo(remoteIp);
      if(ipInfo.status !== "success" && this.moduleConfig.required)
        throw new FaucetError("INVALID_IPINFO", "Error while checking your IP: " + ipInfo.status);
    } catch(ex) {
      ServiceManager.GetService(FaucetProcess).emitLog(FaucetLogLevel.WARNING, "Error while fetching IP-Info for " + remoteIp + ": " + ex.toString());
      if(this.moduleConfig.required)
        throw new FaucetError("INVALID_IPINFO", "Error while checking your IP: " + ex.toString());
      ipInfo = {status: "error: IP info lookup unavailable"};
    }

    let overrideHosting = session.getSessionData<boolean>("ipinfo.override_hosting", undefined);
    if(overrideHosting !== undefined) {
      ipInfo.hosting = overrideHosting;
    }

    let overrideProxy = session.getSessionData<boolean>("ipinfo.override_proxy", undefined);
    if(overrideProxy !== undefined) {
      ipInfo.proxy = overrideProxy;
    }

    session.setSessionData("ipinfo.data", ipInfo);

    let sessionRestriction = this.getSessionRestriction(session);
    if(sessionRestriction.blocked) {
      throw new PublicFaucetError({
        code: "IPINFO_RESTRICTION",
        message: "IP Blocked: " + sessionRestriction.messages.map((msg) => msg.text).join(", "),
        ...(sessionRestriction.hostingBased || sessionRestriction.proxyBased ? {
          data: {
            address: session.getTargetAddr(),
            ipflags: [sessionRestriction.hostingBased, sessionRestriction.proxyBased],
          },
        } : {}),
      });
    }
    session.setSessionModuleRef("ipinfo.restriction.time", Math.floor((new Date()).getTime() / 1000));
    session.setSessionModuleRef("ipinfo.restriction.data", sessionRestriction);
  }

  private async processSessionRewardFactor(session: FaucetSession, rewardFactors: ISessionRewardFactor[]) {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    let refreshTime = session.getSessionModuleRef("ipinfo.restriction.time") || 0;
    let now = Math.floor((new Date()).getTime() / 1000);
    let sessionRestriction: IIPInfoRestriction;
    if(now - refreshTime > this.sessionRewardFactorCacheTimeout) {
      sessionRestriction = this.getSessionRestriction(session);
      session.setSessionModuleRef("ipinfo.restriction.time", Math.floor((new Date()).getTime() / 1000));
      session.setSessionModuleRef("ipinfo.restriction.data", sessionRestriction);
      if(sessionRestriction.blocked) {
        let blockReason = "IP Blocked: " + sessionRestriction.messages.map((msg) => msg.text).join(", ");
        if(sessionRestriction.blocked == "kill") {
          await session.setSessionFailed("RESTRICTION", blockReason);
        } else {
          await session.completeSession();
        }
        return;
      }
    }
    else
      sessionRestriction = session.getSessionModuleRef("ipinfo.restriction.data");
    
    if(sessionRestriction.reward !== 100) {
      rewardFactors.push({
        factor: sessionRestriction.reward / 100,
        module: this.moduleName,
      });
    }
  }

  private getIPInfoString(session: FaucetSession, ipinfo: IIPInfo) {
    let infoStr = [
      "ETH: " + session.getTargetAddr(),
      "IP: " + session.getRemoteIP(),
      "Ident: " + (session.getSessionData("captcha.ident") || ""),
    ];
    if(ipinfo) {
      infoStr.push(
        "Country: " + ipinfo.countryCode,
        "Region: " + ipinfo.regionCode,
        "City: " + ipinfo.city,
        "ISP: " + ipinfo.isp,
        "Org: " + ipinfo.org,
        "AS: " + ipinfo.as,
        "Proxy: " + (ipinfo.proxy ? "true" : "false"),
        "Hosting: " + (ipinfo.hosting ? "true" : "false")
      );
    }
    return infoStr.join("\n");
  }

  public refreshIpInfoMatchRestrictions(force?: boolean) {
    let now = Math.floor((new Date()).getTime() / 1000);
    let refresh = this.moduleConfig.restrictionsFile ? this.moduleConfig.restrictionsFile.refresh : 30;
    if(this.ipInfoMatchRestrictionsRefresh > now - refresh && !force)
      return;
    
    this.ipInfoMatchRestrictionsRefresh = now;
    this.ipInfoMatchRestrictions = [];
    Object.keys(this.moduleConfig.restrictionsPattern).forEach((pattern) => {
      this.ipInfoMatchRestrictions.push([pattern, this.moduleConfig.restrictionsPattern[pattern]]);
    });
    
    if(this.moduleConfig.restrictionsFile && this.moduleConfig.restrictionsFile.file && fs.existsSync(resolveRelativePath(this.moduleConfig.restrictionsFile.file))) {
      // load restrictions list
      fs.readFileSync(this.moduleConfig.restrictionsFile.file, "utf8").split(/\r?\n/).forEach((line) => {
        let match = /^([0-9]{1,2}): (.*)$/.exec(line);
        if(!match)
          return;
        this.ipInfoMatchRestrictions.push([match[2], parseInt(match[1])]);
      });
    }
    if(this.moduleConfig.restrictionsFile && this.moduleConfig.restrictionsFile.yaml) {
      // load yaml file
      if(Array.isArray(this.moduleConfig.restrictionsFile.yaml))
      this.moduleConfig.restrictionsFile.yaml.forEach((file) => this.refreshIpInfoMatchRestrictionsFromYaml(resolveRelativePath(file)));
      else
        this.refreshIpInfoMatchRestrictionsFromYaml(resolveRelativePath(this.moduleConfig.restrictionsFile.yaml));
    }
  }

  private refreshIpInfoMatchRestrictionsFromYaml(yamlFile: string) {
    if(!fs.existsSync(yamlFile))
      return;
    
    let yamlSrc = fs.readFileSync(yamlFile, "utf8");
    let yamlObj = YAML.parse(yamlSrc);

    if(Array.isArray(yamlObj.restrictions)) {
      yamlObj.restrictions.forEach((entry) => {
        let pattern = entry.pattern;
        delete entry.pattern;
        this.ipInfoMatchRestrictions.push([pattern, entry]);
      })
    }
  }

  private wrapFactorRestriction(restriction: number | IIPInfoRestrictionConfig): IIPInfoRestrictionConfig {
    if(typeof restriction === "number") {
      return {
        reward: restriction,
      };
    }
    return restriction;
  }

  private getSessionRestriction(session: FaucetSession): IIPInfoRestriction {
    let restriction: IIPInfoRestriction = {
      reward: 100,
      messages: [],
      blocked: false,
      hostingBased: false,
      proxyBased: false,
    };
    let msgKeyDict = {};
    let sessionIpInfo: IIPInfo = session.getSessionData("ipinfo.data");

    let applyRestriction = (restr: number | IIPInfoRestrictionConfig) => {
      restr = this.wrapFactorRestriction(restr);
      if(restr.reward < restriction.reward)
        restriction.reward = restr.reward;
      if(restr.blocked) {
        if(restr.blocked === "close" && !restriction.blocked)
          restriction.blocked = restr.blocked;
        else if(restr.blocked === "kill")
          restriction.blocked = restr.blocked;
        else if(restr.blocked === true && !restriction.blocked)
          restriction.blocked = "close";
      }
      if(restr.message && (!restr.msgkey || !msgKeyDict.hasOwnProperty(restr.msgkey))) {
        if(restr.msgkey)
          msgKeyDict[restr.msgkey] = true;
        restriction.messages.push({
          text: restr.message,
          notify: restr.notify,
          key: restr.msgkey,
        });
      }
    };

    if(sessionIpInfo && this.moduleConfig.restrictions) {
      if(sessionIpInfo.hosting && this.moduleConfig.restrictions.hosting) {
        applyRestriction(this.moduleConfig.restrictions.hosting);
        restriction.hostingBased = true;
      }
      if(sessionIpInfo.proxy && this.moduleConfig.restrictions.proxy) {
        applyRestriction(this.moduleConfig.restrictions.proxy);
        restriction.proxyBased = true;
      }
      if(sessionIpInfo.countryCode && typeof this.moduleConfig.restrictions[sessionIpInfo.countryCode] !== "undefined")
        applyRestriction(this.moduleConfig.restrictions[sessionIpInfo.countryCode]);
    }

    if(this.moduleConfig.restrictionsPattern || this.moduleConfig.restrictionsFile) {
      this.refreshIpInfoMatchRestrictions();
      let infoStr = this.getIPInfoString(session, sessionIpInfo);
      this.ipInfoMatchRestrictions.forEach((entry) => {
        if(infoStr.match(new RegExp(entry[0], "mi"))) {
          applyRestriction(entry[1]);
        }
      });
    }
    
    return restriction;
  }


}
