import mysql, { ResultSetHeader } from "mysql2";
import { FaucetDbDriver } from "../FaucetDatabase.js";
import { BaseDriver, BindValues, QueryResult, RunResult } from "./BaseDriver.js";

export interface IMySQLOptions {
  driver: FaucetDbDriver.MYSQL;
  host: string;
  port?: number;
  username: string;
  password: string;
  database: string;
  poolLimit?: number;
}

type MySQLOperation = "exec" | "run" | "all" | "get";

function errorField(error: unknown, field: string): unknown {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>)[field]
    : undefined;
}

class MySQLDriverError extends Error {
  public declare readonly code: string | undefined;
  public declare readonly errno: number | undefined;
  public declare readonly sqlState: string | undefined;

  public constructor(
    operation: MySQLOperation,
    sql: string | null,
    cause: unknown,
  ) {
    const context = sql === null
      ? ": could not acquire connection"
      : ` [${sql}]`;
    super(`mysql ${operation}() error${context}: ${String(cause)}`, {cause});
    this.name = "MySQLDriverError";

    const code = errorField(cause, "code");
    const errno = errorField(cause, "errno");
    const sqlState = errorField(cause, "sqlState");
    Object.defineProperties(this, {
      code: {
        value: typeof code === "string" && code.length > 0 ? code : undefined,
        enumerable: true,
      },
      errno: {
        value: typeof errno === "number" && Number.isSafeInteger(errno) ? errno : undefined,
        enumerable: true,
      },
      sqlState: {
        value: typeof sqlState === "string" && sqlState.length > 0 ? sqlState : undefined,
        enumerable: true,
      },
    });
  }
}

export class MySQLDriver extends BaseDriver<IMySQLOptions> {
  private pool: mysql.Pool;
  private db: any;

  public override async open(options: IMySQLOptions): Promise<void> {
    this.pool = mysql.createPool({
      connectionLimit: options.poolLimit || 5,
      host: options.host,
      port: options.port || 3306,
      user: options.username,
      password: options.password,
      database: options.database,
    });
  }
  public override async close(): Promise<void> {
    await new Promise<void>((resolve) => this.pool.end(() => resolve()));
  }

  public override async exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pool.getConnection((err, connection) => {
        if(err)
          return reject(new MySQLDriverError("exec", null, err));
        
        connection.query(sql, (error, results) => {
          if(error)
            reject(new MySQLDriverError("exec", sql, error));
          else
            resolve();
          connection.release();
        })
      });
    });
  }

  public override async run(sql: string, values?: BindValues): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      this.pool.getConnection((err, connection) => {
        if(err)
          return reject(new MySQLDriverError("run", null, err));
        
        connection.query(sql, values, (error, results) => {
          if(error)
            reject(new MySQLDriverError("run", sql, error));
          else {
            resolve({
              changes: (results as ResultSetHeader).affectedRows,
              lastInsertRowid: (results as ResultSetHeader).insertId,
            });
          }
          connection.release();
        })
      });
    });
  }
  
  public override async all(sql: string, values?: BindValues): Promise<QueryResult[]> {
    return new Promise((resolve, reject) => {
      this.pool.getConnection((err, connection) => {
        if(err)
          return reject(new MySQLDriverError("all", null, err));
        
        connection.query(sql, values, (error, results) => {
          if(error)
            reject(new MySQLDriverError("all", sql, error));
          else {
            resolve(results as QueryResult[]);
          }
          connection.release();
        })
      });
    });
  }

  public override async get(sql: string, values?: BindValues): Promise<QueryResult | null> {
    return new Promise((resolve, reject) => {
      this.pool.getConnection((err, connection) => {
        if(err)
          return reject(new MySQLDriverError("get", null, err));
        
        connection.query(sql, values, (error, results) => {
          if(error)
            reject(new MySQLDriverError("get", sql, error));
          else {
            resolve((results as QueryResult[]).length > 0 ? results[0] : null);
          }
          connection.release();
        })
      });
    });
  }

}
