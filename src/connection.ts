/* eslint-disable require-yield */
import {
  CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
  type TransactionSettings,
} from "kysely";
import { BunDialectError } from "./errors.js";
import type { ReservedSQL } from "bun";
import { transformValue } from "./utils.js";

export class BunConnection implements DatabaseConnection {
  #reservedConnection: ReservedSQL;

  constructor(reservedConnection: ReservedSQL) {
    this.#reservedConnection = reservedConnection;
  }

  async beginTransaction(settings: TransactionSettings): Promise<void> {
    const { isolationLevel } = settings;

    const compiledQuery = CompiledQuery.raw(
      isolationLevel
        ? `start transaction isolation level ${isolationLevel}`
        : "begin",
    );

    await this.executeQuery(compiledQuery);
  }

  async commitTransaction(): Promise<void> {
    await this.executeQuery(CompiledQuery.raw("commit"));
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const parameters = compiledQuery.parameters.map(transformValue);

    const result = await this.#reservedConnection.unsafe(
      compiledQuery.sql,
      parameters,
    );

    const rows = Array.from(result.values()) as R[];

    if (["INSERT", "UPDATE", "DELETE"].includes(result.command)) {
      const numAffectedRows = BigInt(rows.length);

      return { numAffectedRows, rows };
    }

    return { rows };
  }

  releaseConnection(): void {
    this.#reservedConnection.release();
    this.#reservedConnection = null!;
  }

  async rollbackTransaction(): Promise<void> {
    await this.executeQuery(CompiledQuery.raw("rollback"));
  }

  async *streamQuery<R>(): AsyncGenerator<QueryResult<R>> {
    throw new BunDialectError("streamQuery is not supported");
  }
}
