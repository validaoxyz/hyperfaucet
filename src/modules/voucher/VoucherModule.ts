import { ServiceManager } from "../../common/ServiceManager.js";
import { EthWalletManager } from "../../eth/EthWalletManager.js";
import { FaucetSession } from "../../session/FaucetSession.js";
import { BaseModule } from "../BaseModule.js";
import { ModuleHookAction } from "../ModuleManager.js";
import { defaultConfig, IVoucherConfig } from './VoucherConfig.js';
import { FaucetError } from '../../common/FaucetError.js';
import { FaucetDatabase } from "../../db/FaucetDatabase.js";
import { registerDefaultSessionCleanupGuard } from "../../db/SessionCleanupGuards.js";
import { FaucetLogLevel, FaucetProcess } from "../../common/FaucetProcess.js";
import { VoucherDB } from './VoucherDB.js';

const VOUCHER_RESERVATION_OWNER = "voucher.reservation";
const voucherDatabaseReconciliations = new WeakMap<FaucetDatabase, Promise<void>>();

registerDefaultSessionCleanupGuard(
  VOUCHER_RESERVATION_OWNER,
  (database, candidate) => VoucherDB.prepareSessionCleanup(database, candidate),
);

export class VoucherModule extends BaseModule<IVoucherConfig> {
  protected readonly moduleDefaultConfig = defaultConfig;
  private voucherDb: VoucherDB;

  protected override async startModule(): Promise<void> {
    this.voucherDb = await ServiceManager.GetService(FaucetDatabase).createModuleDb(VoucherDB, this);

    this.moduleManager.addActionHook(
      this, ModuleHookAction.ClientConfig, 1, "Voucher config",
      async (clientConfig: any) => {
        clientConfig[this.moduleName] = {
          voucherLabel: this.moduleConfig.voucherLabel,
          infoHtml: this.moduleConfig.infoHtml,
        };
      }
    );

    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionStart, 2, "Voucher check",
      (session: FaucetSession, userInput: any) => this.processSessionStart(session, userInput)
    );
    this.moduleManager.addActionHook(
      this, ModuleHookAction.SessionComplete, 5, "Voucher save session", 
      (session: FaucetSession) => this.processSessionComplete(session)
    );

    return Promise.resolve();
  }

  protected override stopModule(): Promise<void> {
    this.voucherDb?.dispose();
    return Promise.resolve();
  }

  protected override async onStateRestoreComplete(): Promise<void> {
    const database = ServiceManager.GetService(FaucetDatabase);
    let reconciliation = voucherDatabaseReconciliations.get(database);
    if(!reconciliation) {
      reconciliation = this.voucherDb.reconcileOrphanedLeases().then(() => undefined);
      voucherDatabaseReconciliations.set(database, reconciliation);
    }
    try {
      await reconciliation;
    } catch(error) {
      if(voucherDatabaseReconciliations.get(database) === reconciliation)
        voucherDatabaseReconciliations.delete(database);
      throw error;
    }
  }

  private async processSessionStart(session: FaucetSession, userInput: any): Promise<void> {
    let voucherCode = userInput?.voucherCode as string | undefined;

    if (!voucherCode) {
      throw new FaucetError("VOUCHER_REQUIRED", "A valid voucher code is required.");
    }

    voucherCode = voucherCode.replace(/[^A-Z0-9]/g, "");

    ServiceManager.GetService(FaucetProcess).emitLog(
      FaucetLogLevel.INFO,
      `Voucher provided for session ${session.getSessionId()}`,
    );
    const voucher = await this.voucherDb.getVoucher(voucherCode);

    if (!voucher) {
      ServiceManager.GetService(FaucetProcess).emitLog(
        FaucetLogLevel.WARNING,
        `Invalid voucher provided for session ${session.getSessionId()}`,
      );
      throw new FaucetError(
        "VOUCHER_INVALID",
        "The provided voucher code is not valid.",
      );
    }

    if (voucher.dropAmount)
      session.reserveAdmissionClaimCeiling(BigInt(voucher.dropAmount));

    const voucherDb = this.voucherDb;
    const sessionId = session.getSessionId();
    if (!(await voucherDb.reserveVoucher(
      voucher.code,
      sessionId,
      session.getStartTime(),
    ))) {
      throw new FaucetError(
        "VOUCHER_USED",
        "This voucher code has already been used.",
      );
    }

    try {
      session.registerStartRollback(
        VOUCHER_RESERVATION_OWNER,
        async () => {
          await voucherDb.releaseVoucher(voucher.code, sessionId);
        },
      );
      session.setSessionData("voucherCode", voucherCode);

      if (voucher.dropAmount) {
        const overrideMaxDropAmount = BigInt(voucher.dropAmount);
        await session.setDropAmount(overrideMaxDropAmount);
        session.setMaxDropAmountOverride(overrideMaxDropAmount);
        ServiceManager.GetService(FaucetProcess).emitLog(
          FaucetLogLevel.INFO,
          `Voucher overrides max drop amount to ${ServiceManager.GetService(EthWalletManager).readableAmount(BigInt(voucher.dropAmount))} for session ${session.getSessionId()}`
        );
      }
    } catch(error) {
      try {
        await voucherDb.releaseVoucher(voucher.code, sessionId);
      } catch(releaseError) {
        throw new AggregateError(
          [error, releaseError],
          "Voucher reservation failed and could not be released.",
        );
      }
      throw error;
    }
  }

  private async processSessionComplete(session: FaucetSession): Promise<void> {
    let voucherCode = session.getSessionData<string>("voucherCode");
    if (!voucherCode) {
      return;
    }

    if(!await this.voucherDb.consumeVoucher(voucherCode, session.getSessionId(), session.getTargetAddr()))
      throw new Error("Voucher reservation ownership changed before session completion.");
  }
}
