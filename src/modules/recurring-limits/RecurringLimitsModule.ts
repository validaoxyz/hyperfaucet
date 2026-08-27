import { ServiceManager } from "../../common/ServiceManager.js";
import { EthWalletManager } from "../../eth/EthWalletManager.js";
import { FaucetSession, FaucetSessionStoreData } from "../../session/FaucetSession.js";
import { BaseModule } from "../BaseModule.js";
import { ModuleHookAction } from "../ModuleManager.js";
import { defaultConfig, IRecurringLimitConfig, IRecurringLimitsConfig } from './RecurringLimitsConfig.js';
import { PublicFaucetError } from '../../common/FaucetError.js';
import { FaucetDatabase } from "../../db/FaucetDatabase.js";
import { renderTimespan } from "../../utils/DateUtils.js";
import { ISessionRewardFactor } from "../../session/SessionRewardFactor.js";
import { AdmissionSubject, AdmissionUsage, admissionSubject, excludeCommittedUsage } from "../../session/AdmissionLedger.js";
import { SessionManager } from "../../session/SessionManager.js";

interface RecurringLimitCheck {
  limit: IRecurringLimitConfig;
  finishedSessions: Promise<FaucetSessionStoreData[]>;
  priorUsage: AdmissionUsage;
}

export class RecurringLimitsModule extends BaseModule<IRecurringLimitsConfig> {
  protected readonly moduleDefaultConfig = defaultConfig;

  protected override startModule(): Promise<void> {
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionStart, 7, "Recurring limits check", 
      (session: FaucetSession, userInput: any) => this.processSessionStart(session, userInput)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionRestore, 7, "Restore recurring limit reservations",
      (session: FaucetSession) => this.restoreSessionReservations(session)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionRewardFactor, 6, "recurring limits factor", 
      (session: FaucetSession, rewardFactors: ISessionRewardFactor[]) => this.processSessionRewardFactor(session, rewardFactors)
    );
    return Promise.resolve();
  }

  protected override stopModule(): Promise<void> {
    return Promise.resolve();
  }

  private async processSessionStart(session: FaucetSession, userInput: any): Promise<void> {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;

    let checks = this.moduleConfig.limits.map((limit) => this.prepareLimitCheck(session, limit));
    let finishedSessions = await Promise.all(checks.map((check) => check.finishedSessions));
    for(let i = 0; i < checks.length; i++)
      this.checkLimit(session, checks[i].limit, finishedSessions[i], checks[i].priorUsage);
  }

  private prepareLimitCheck(session: FaucetSession, limit: IRecurringLimitConfig): RecurringLimitCheck {
    let {remoteIp, subjects} = this.getLimitSubjects(session, limit);
    let sessionManager = ServiceManager.GetService(SessionManager);
    sessionManager.bindAdmissionSubjects(session, subjects);
    let priorUsage = sessionManager.getPriorAdmissionUsage(session, subjects, {
      minStartTime: Math.floor((new Date()).getTime() / 1000) - limit.duration,
    });

    let finishedSessions: Promise<FaucetSessionStoreData[]>;
    if(limit.byAddrOnly)
      finishedSessions = ServiceManager.GetService(FaucetDatabase).getFinishedSessions(session.getTargetAddr(), null, limit.duration, true);
    else if(limit.byIPOnly)
      finishedSessions = ServiceManager.GetService(FaucetDatabase).getFinishedSessions(null, remoteIp, limit.duration, true);
    else
      finishedSessions = ServiceManager.GetService(FaucetDatabase).getFinishedSessions(session.getTargetAddr(), remoteIp, limit.duration, true);

    return {limit, finishedSessions, priorUsage};
  }

  private getLimitSubjects(session: FaucetSession, limit: IRecurringLimitConfig): {remoteIp: string; subjects: AdmissionSubject[]} {
    let remoteIp = session.getRemoteIP();
    let ipSubject = admissionSubject.ip(remoteIp);
    if(limit.ip4Subnet && remoteIp.match(/^[0-9.]+$/)) {
      let ipParts = remoteIp.split(".").slice(0, limit.ip4Subnet / 8);
      if(ipParts.length < 4) {
        ipParts.push("%");
        remoteIp = ipParts.join(".");
        ipSubject = admissionSubject.scope("recurring-limits.ip4-" + limit.ip4Subnet, remoteIp);
      }
    }

    let subjects: AdmissionSubject[] = [];
    if(limit.byAddrOnly)
      subjects.push(admissionSubject.address(session.getTargetAddr()));
    else if(limit.byIPOnly)
      subjects.push(ipSubject);
    else {
      subjects.push(admissionSubject.address(session.getTargetAddr()));
      subjects.push(ipSubject);
    }
    return {remoteIp, subjects};
  }

  private restoreSessionReservations(session: FaucetSession): void {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    let sessionManager = ServiceManager.GetService(SessionManager);
    for(let limit of this.moduleConfig.limits)
      sessionManager.bindAdmissionSubjects(session, this.getLimitSubjects(session, limit).subjects);
  }

  private checkLimit(
    session: FaucetSession,
    limit: IRecurringLimitConfig,
    finishedSessions: FaucetSessionStoreData[],
    priorUsage: AdmissionUsage,
  ): void {
    let activeUsage = excludeCommittedUsage(priorUsage, finishedSessions.map((finishedSession) => finishedSession.sessionId));
    let usedCount = finishedSessions.length + activeUsage.count;

    let limitApplies = false;
    if(limit.limitCount > 0 && usedCount >= limit.limitCount) {
      limitApplies = true;
      if(!limit.action || limit.action == "block") {
        let errMsg = limit.message || [
          "You have already created ",
          usedCount,
          (usedCount > 1 ? " sessions" : " session"),
          " in the last ",
          renderTimespan(limit.duration)
        ].join("");
        throw new PublicFaucetError({
          code: "RECURRING_LIMIT",
          message: errMsg,
        });
        }
    }
    if(limit.limitAmount > 0) {
      let totalAmount = activeUsage.amount;
      finishedSessions.forEach((session) => totalAmount += BigInt(session.dropAmount));
      if(activeUsage.hasProvisionalAmount || totalAmount >= BigInt(limit.limitAmount)) {
        limitApplies = true;
        if(!limit.action || limit.action == "block") {
          let errMsg = limit.message || (activeUsage.hasProvisionalAmount
            ? "Another matching faucet request is still being processed. Please try again."
            : [
              "You have already requested ",
              ServiceManager.GetService(EthWalletManager).readableAmount(totalAmount),
              " in the last ",
              renderTimespan(limit.duration)
            ].join(""));
          throw new PublicFaucetError({
            code: "RECURRING_LIMIT",
            message: errMsg,
          });
        }
      }
    }

    if(limitApplies && typeof limit.rewards !== "undefined") {
      let cfactor = session.getSessionData("recurring-limits.factor");
      if(typeof cfactor === "undefined" || limit.rewards < cfactor)
        session.setSessionData("recurring-limits.factor", limit.rewards);
    }
  }

  private async processSessionRewardFactor(session: FaucetSession, rewardFactors: ISessionRewardFactor[]) {
    if(session.getSessionData<Array<string>>("skip.modules", []).indexOf(this.moduleName) !== -1)
      return;
    let rewardPerc = session.getSessionData("recurring-limits.factor", 100);
    if(rewardPerc !== 100) {
      rewardFactors.push({
        factor: rewardPerc / 100,
        module: this.moduleName,
      });
    }
  }

}
