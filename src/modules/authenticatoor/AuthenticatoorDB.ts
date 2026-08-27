import { FaucetDbDriver } from '../../db/FaucetDatabase.js';
import { FaucetModuleDB } from '../../db/FaucetModuleDB.js';
import { SQL } from '../../db/SQL.js';
import { FaucetSessionStoreData } from '../../session/FaucetSession.js';
import { faucetConfig } from '../../config/FaucetConfig.js';

export interface IAuthenticatoorPrincipal {
  issuer: string;
  subject: string;
}

export interface IAuthenticatoorLegacyPrincipal {
  issuer: string;
  userId: string;
}

export class AuthenticatoorDB extends FaucetModuleDB {
  protected override latestSchemaVersion = 2;

  protected override async upgradeSchema(version: number): Promise<number> {
    switch(version) {
      case 0:
        version = 1;
        await this.db.exec(SQL.driverSql({
          [FaucetDbDriver.SQLITE]: `
            CREATE TABLE "AuthenticatoorSessions" (
              "SessionId" TEXT NOT NULL UNIQUE,
              "UserId" TEXT NOT NULL,
              "Issuer" TEXT NOT NULL,
              PRIMARY KEY("SessionId")
            );`,
          [FaucetDbDriver.MYSQL]: `
            CREATE TABLE AuthenticatoorSessions (
              SessionId CHAR(36) NOT NULL,
              UserId VARCHAR(190) NOT NULL,
              Issuer VARCHAR(190) NOT NULL,
              PRIMARY KEY(SessionId)
            );`,
        }));
        await this.db.exec(SQL.driverSql({
          [FaucetDbDriver.SQLITE]: `CREATE INDEX "AuthenticatoorSessionsUserIdx" ON "AuthenticatoorSessions" ("UserId" ASC);`,
          [FaucetDbDriver.MYSQL]: `ALTER TABLE AuthenticatoorSessions ADD INDEX AuthenticatoorSessionsUserIdx (UserId);`,
        }));
        // Schema-v1 UserId rows may contain either email or subject. Reads accept
        // both identifiers, while writes from new tokens use subject.
      case 1:
        version = 2;
        await this.db.exec(SQL.driverSql({
          [FaucetDbDriver.SQLITE]: `ALTER TABLE "AuthenticatoorSessions" ADD COLUMN "StartTime" INTEGER NULL;`,
          [FaucetDbDriver.MYSQL]: `ALTER TABLE AuthenticatoorSessions ADD COLUMN StartTime INT(11) NULL;`,
        }));
        await this.db.exec([
          "UPDATE AuthenticatoorSessions",
          "SET StartTime = (SELECT Sessions.StartTime FROM Sessions WHERE Sessions.SessionId = AuthenticatoorSessions.SessionId)",
        ].join(" "));
        await this.db.exec(SQL.driverSql({
          [FaucetDbDriver.SQLITE]: `CREATE INDEX "AuthenticatoorSessionsPrincipalIdx" ON "AuthenticatoorSessions" ("Issuer" ASC, "UserId" ASC);`,
          [FaucetDbDriver.MYSQL]: `ALTER TABLE AuthenticatoorSessions ADD INDEX AuthenticatoorSessionsPrincipalIdx (Issuer, UserId);`,
        }));
    }
    return version;
  }

  public override async cleanStore(): Promise<void> {
    await this.db.run([
      "DELETE FROM AuthenticatoorSessions",
      "WHERE (StartTime IS NULL OR StartTime < ?)",
      "AND NOT EXISTS (",
      "SELECT 1 FROM Sessions WHERE Sessions.SessionId = AuthenticatoorSessions.SessionId",
      ")",
    ].join(" "), [this.now() - faucetConfig.sessionCleanup]);
  }

  public getPrincipalSessions(
    principal: IAuthenticatoorPrincipal,
    legacyUserIds: readonly string[],
    duration: number,
    skipData?: boolean,
  ): Promise<FaucetSessionStoreData[]> {
    let now = this.now();
    let userIds = Array.from(new Set([principal.subject, ...legacyUserIds].filter((userId) => userId.length > 0)));
    return this.faucetStore.selectSessionsSql([
      "FROM AuthenticatoorSessions",
      "INNER JOIN Sessions ON Sessions.SessionId = AuthenticatoorSessions.SessionId",
      "WHERE AuthenticatoorSessions.Issuer = ?",
      "AND AuthenticatoorSessions.UserId IN (" + userIds.map(() => "?").join(",") + ")",
      "AND Sessions.StartTime > ? AND Sessions.Status IN ('claimable','claiming','finished')",
    ].join(" "), [principal.issuer, ...userIds, now - duration], skipData);
  }

  public async setPrincipalSession(
    sessionId: string,
    principal: IAuthenticatoorPrincipal,
    startTime: number,
  ): Promise<void> {
    await this.setSessionUserId(sessionId, principal.issuer, principal.subject, startTime);
  }

  public async setLegacySession(
    sessionId: string,
    principal: IAuthenticatoorLegacyPrincipal,
    startTime: number,
  ): Promise<void> {
    await this.setSessionUserId(sessionId, principal.issuer, principal.userId, startTime);
  }

  private async setSessionUserId(
    sessionId: string,
    issuer: string,
    userId: string,
    startTime: number,
  ): Promise<void> {
    await this.db.run(
      SQL.driverSql({
        [FaucetDbDriver.SQLITE]: "INSERT OR REPLACE INTO AuthenticatoorSessions (SessionId,UserId,Issuer,StartTime) VALUES (?,?,?,?)",
        [FaucetDbDriver.MYSQL]: "REPLACE INTO AuthenticatoorSessions (SessionId,UserId,Issuer,StartTime) VALUES (?,?,?,?)",
      }),
      [sessionId, userId, issuer, startTime]
    );
  }

}
