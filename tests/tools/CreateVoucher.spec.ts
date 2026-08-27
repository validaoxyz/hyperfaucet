import "mocha";
import { expect } from "chai";
import { createDB } from "mysql-memory-server";
import {
  createUniqueVoucher,
  MAX_VOUCHER_INSERT_ATTEMPTS,
  parseVoucherAmount,
} from "../../src/tools/createVoucher.js";
import {
  VoucherCodeCollisionError,
  VoucherDB,
} from "../../src/modules/voucher/VoucherDB.js";
import { BaseDriver, BindValues, QueryResult, RunResult } from "../../src/db/driver/BaseDriver.js";
import { FaucetDbDriver } from "../../src/db/FaucetDatabase.js";
import { MySQLDriver } from "../../src/db/driver/MySQLDriver.js";
import { SQLiteDriver } from "../../src/db/driver/SQLiteDriver.js";

class StubDriver extends BaseDriver {
  public runError: unknown;
  public lookupError: unknown;
  public existingCode: string | null = null;

  public async open(): Promise<void> {}
  public async close(): Promise<void> {}
  public async exec(): Promise<void> {}

  public async run(_sql: string, _values?: BindValues): Promise<RunResult> {
    if(this.runError !== undefined)
      throw this.runError;
    return {changes: 1, lastInsertRowid: 0};
  }

  public async all(): Promise<QueryResult[]> {
    return [];
  }

  public async get(_sql: string, _values?: BindValues): Promise<QueryResult | null> {
    if(this.lookupError !== undefined)
      throw this.lookupError;
    return this.existingCode === null ? null : {Code: this.existingCode};
  }
}

async function expectDuplicateCollision(driver: BaseDriver): Promise<void> {
  await VoucherDB.insertVoucher(driver, "DUPLICATE", "1");
  try {
    await VoucherDB.insertVoucher(driver, "DUPLICATE", "1");
    expect.fail("expected duplicate insert to fail");
  } catch(error) {
    expect(error).to.be.instanceOf(VoucherCodeCollisionError);
  }
}

describe("Create voucher CLI", () => {
  describe("parseVoucherAmount", () => {
    it("preserves wei values above Number.MAX_SAFE_INTEGER", () => {
      expect(parseVoucherAmount("9007199254740993")).to.equal("9007199254740993");
    });

    it("converts ETH fractions without floating-point rounding", () => {
      expect(parseVoucherAmount("0.000000000000000001ETH")).to.equal("1");
      expect(parseVoucherAmount("1.234567890123456789eth")).to.equal("1234567890123456789");
      expect(parseVoucherAmount("9007199254740993ETH")).to.equal("9007199254740993000000000000000000");
    });

    it("rejects negative, zero, malformed, overprecise, and oversized values", () => {
      const invalidAmounts = [
        "-1",
        "0",
        "0ETH",
        "1e18",
        "1 ETH",
        "1.ETH",
        ".1ETH",
        "1.0000000000000000001ETH",
        "100000000000000000000000000000000000000000000000000",
      ];

      for(const amount of invalidAmounts)
        expect(() => parseVoucherAmount(amount), amount).to.throw(Error);
    });
  });

  describe("VoucherDB.insertVoucher", () => {
    it("classifies a duplicate from the SQLite driver", async () => {
      const driver = new SQLiteDriver();
      await driver.open({driver: FaucetDbDriver.SQLITE, file: ":memory:"});
      try {
        await driver.exec(`
          CREATE TABLE Vouchers (
            Code TEXT NOT NULL PRIMARY KEY,
            DropAmount TEXT NOT NULL,
            SessionId TEXT NULL,
            TargetAddr TEXT NULL,
            StartTime INTEGER NULL
          )
        `);
        await expectDuplicateCollision(driver);
      } finally {
        await driver.close();
      }
    });

    it("classifies a duplicate from the MySQL driver", async function() {
      this.timeout(120000);
      const database = await createDB({
        version: "8.4.8",
        downloadBinaryOnce: true,
      });
      const driver = new MySQLDriver();
      let driverOpen = false;
      try {
        await driver.open({
          driver: FaucetDbDriver.MYSQL,
          host: "localhost",
          port: database.port,
          username: database.username,
          password: "",
          database: database.dbName,
        });
        driverOpen = true;
        await driver.exec(`
          CREATE TABLE Vouchers (
            Code VARCHAR(50) NOT NULL PRIMARY KEY,
            DropAmount VARCHAR(50) NOT NULL,
            SessionId CHAR(36) NULL,
            TargetAddr CHAR(42) NULL,
            StartTime INT(11) NULL
          )
        `);
        await expectDuplicateCollision(driver);
      } finally {
        if(driverOpen)
          await driver.close();
        await database.stop();
      }
    });

    it("classifies an exact candidate found after an insert error as a collision", async () => {
      const driver = new StubDriver();
      const insertError = new Error("sqlite duplicate signal");
      driver.runError = insertError;
      driver.existingCode = "DUPLICATE";

      try {
        await VoucherDB.insertVoucher(driver, "DUPLICATE", "1");
        expect.fail("expected insert to fail");
      } catch(error) {
        expect(error).to.be.instanceOf(VoucherCodeCollisionError);
        expect((error as Error).cause).to.equal(insertError);
      }
    });

    it("propagates a nonduplicate insert error unchanged", async () => {
      const driver = new StubDriver();
      const insertError = new Error("mysql connection failed");
      driver.runError = insertError;

      try {
        await VoucherDB.insertVoucher(driver, "NEWCODE", "1");
        expect.fail("expected insert to fail");
      } catch(error) {
        expect(error).to.equal(insertError);
      }
    });

    it("preserves insert and lookup failures when collision classification is unavailable", async () => {
      const driver = new StubDriver();
      const insertError = new Error("insert failed");
      const lookupError = new Error("lookup failed");
      driver.runError = insertError;
      driver.lookupError = lookupError;

      try {
        await VoucherDB.insertVoucher(driver, "UNKNOWN", "1");
        expect.fail("expected insert to fail");
      } catch(error) {
        expect(error).to.be.instanceOf(AggregateError);
        expect((error as AggregateError).errors).to.deep.equal([insertError, lookupError]);
      }
    });
  });

  describe("createUniqueVoucher", () => {
    it("retries a classified collision and returns the inserted code", async () => {
      const candidates = ["COLLISION", "UNIQUE"];
      const attempted: string[] = [];

      const code = await createUniqueVoucher({
        generateCode: () => candidates.shift() as string,
        insertVoucher: async (candidate) => {
          attempted.push(candidate);
          if(candidate === "COLLISION")
            throw new VoucherCodeCollisionError();
        },
      });

      expect(code).to.equal("UNIQUE");
      expect(attempted).to.deep.equal(["COLLISION", "UNIQUE"]);
    });

    it("does not retry nonduplicate errors", async () => {
      const insertError = new Error("write failed");
      let attempts = 0;

      try {
        await createUniqueVoucher({
          generateCode: () => "CODE",
          insertVoucher: async () => {
            attempts++;
            throw insertError;
          },
        });
        expect.fail("expected insert to fail");
      } catch(error) {
        expect(error).to.equal(insertError);
      }

      expect(attempts).to.equal(1);
    });

    it("stops after the configured collision bound", async () => {
      let attempts = 0;

      try {
        await createUniqueVoucher({
          generateCode: () => "COLLISION",
          insertVoucher: async () => {
            attempts++;
            throw new VoucherCodeCollisionError();
          },
        });
        expect.fail("expected collision retries to be exhausted");
      } catch(error) {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.contain("unique voucher code");
      }

      expect(attempts).to.equal(MAX_VOUCHER_INSERT_ATTEMPTS);
    });
  });
});
