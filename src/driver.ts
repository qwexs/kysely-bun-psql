import {
  createQueryId,
  IdentifierNode,
  RawNode,
  type AbortableOperationOptions,
  type Driver,
  type QueryCompiler,
  type TransactionSettings,
} from "kysely";
import { SQL } from "bun";
import { BunConnection } from "./connection";
import type { BunDialectConfig } from "./types";
import { freeze } from "./utils";

export class BunDriver implements Driver {
  readonly #sql: SQL;
  readonly #ownsSql: boolean;
  readonly #closeTimeout: number | undefined;
  readonly #normalizeNumericArrays: boolean;

  constructor(config: BunDialectConfig) {
    const {
      sql,
      ownsSql,
      closeTimeout,
      normalizeNumericArrays = false,
      ...options
    } = freeze({ ...config });

    if (
      closeTimeout !== undefined &&
      (!Number.isFinite(closeTimeout) || closeTimeout < 0)
    ) {
      throw new TypeError(
        "closeTimeout must be a finite non-negative number of seconds",
      );
    }
    if (sql !== undefined && Object.keys(options).length > 0) {
      throw new TypeError(
        "sql and native connection options are mutually exclusive",
      );
    }
    if (ownsSql === false && sql === undefined) {
      throw new TypeError(
        "Internally created SQL clients must be owned by the dialect",
      );
    }

    const client = sql ?? new SQL(options);
    if (client.options.adapter !== "postgres") {
      // A rejected internally constructed client must not leak resources. Never
      // close a caller's client when rejecting its adapter, even with ownsSql.
      if (sql === undefined) {
        void client.close({ timeout: 0 });
      }
      throw new TypeError("BunDialect only supports PostgreSQL SQL clients");
    }

    this.#sql = client;
    this.#ownsSql = sql === undefined || (ownsSql ?? false);
    this.#closeTimeout = closeTimeout;
    this.#normalizeNumericArrays = normalizeNumericArrays;
  }

  async init(): Promise<void> {
    // noop
  }

  async acquireConnection(
    options?: AbortableOperationOptions,
  ): Promise<BunConnection> {
    // For transaction safety, always use a reserved connection. The native
    // signal cancels pool waiting, not queries on an acquired connection.
    const reserved = await this.#sql.reserve(options);
    return new BunConnection(reserved, this.#normalizeNumericArrays);
  }

  async beginTransaction(
    connection: BunConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    await connection.beginTransaction(settings);
  }

  async commitTransaction(connection: BunConnection): Promise<void> {
    await connection.commitTransaction();
  }

  async rollbackTransaction(connection: BunConnection): Promise<void> {
    await connection.rollbackTransaction();
  }

  async savepoint(
    connection: BunConnection,
    savepointName: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    await connection.executeQuery(
      compileQuery(
        RawNode.create(
          ["savepoint ", ""],
          [IdentifierNode.create(savepointName)],
        ),
        createQueryId(),
      ),
    );
  }

  async rollbackToSavepoint(
    connection: BunConnection,
    savepointName: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    await connection.executeQuery(
      compileQuery(
        RawNode.create(
          ["rollback to ", ""],
          [IdentifierNode.create(savepointName)],
        ),
        createQueryId(),
      ),
    );
  }

  async releaseSavepoint(
    connection: BunConnection,
    savepointName: string,
    compileQuery: QueryCompiler["compileQuery"],
  ): Promise<void> {
    await connection.executeQuery(
      compileQuery(
        RawNode.create(
          ["release ", ""],
          [IdentifierNode.create(savepointName)],
        ),
        createQueryId(),
      ),
    );
  }

  async releaseConnection(connection: BunConnection): Promise<void> {
    await connection.releaseConnection();
  }

  async destroy(): Promise<void> {
    if (this.#ownsSql) {
      if (this.#closeTimeout === undefined) {
        await this.#sql.close();
      } else {
        await this.#sql.close({ timeout: this.#closeTimeout });
      }
    }
  }
}
