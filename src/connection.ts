import {
  CompiledQuery,
  type AbortableOperationOptions,
  type ControlConnectionProvider,
  type DatabaseConnection,
  type QueryResult,
  type TransactionSettings,
} from "kysely";
import { BunDialectError } from "./errors.js";
import type { ReservedSQL, SQL } from "bun";
import { transformValue } from "./utils.js";

type ActiveQuery = {
  query: SQL.Query<unknown>;
  settled: Promise<void>;
  cancelRequested: boolean;
};

const INT4_ARRAY_OID = 1007;
const FLOAT4_ARRAY_OID = 1021;

function normalizeNumericArrayRows<R>(
  rows: R[],
  columns: readonly SQL.ResultColumn[] | null | undefined,
): R[] {
  // Object rows keep the last duplicate name, even if its type is not numeric.
  const typesByName = new Map<string, number>();
  for (const column of columns ?? []) {
    typesByName.set(column.name, column.type);
  }
  const numericColumns = [...typesByName].filter(
    ([, type]) => type === INT4_ARRAY_OID || type === FLOAT4_ARRAY_OID,
  );
  if (!numericColumns.length || !rows.length) return rows;

  return rows.map((row) => {
    if (row === null || typeof row !== "object") return row;
    let normalized = row;
    for (const [name, type] of numericColumns) {
      if (!Object.hasOwn(row, name)) continue;
      const value = (row as Record<string, unknown>)[name];
      if (
        (type === INT4_ARRAY_OID && value instanceof Int32Array) ||
        (type === FLOAT4_ARRAY_OID && value instanceof Float32Array)
      ) {
        if (normalized === row) normalized = { ...row };
        (normalized as Record<string, unknown>)[name] = Array.from(value);
      }
    }
    return normalized;
  });
}

export class BunConnection implements DatabaseConnection {
  #reservedConnection: ReservedSQL;
  readonly #normalizeNumericArrays: boolean;
  #activeQuery?: ActiveQuery;
  #releasing = false;

  constructor(reservedConnection: ReservedSQL, normalizeNumericArrays = false) {
    this.#reservedConnection = reservedConnection;
    this.#normalizeNumericArrays = normalizeNumericArrays;
  }

  async beginTransaction(settings: TransactionSettings): Promise<void> {
    const { isolationLevel, accessMode } = settings;
    if (
      isolationLevel !== undefined &&
      ![
        "read uncommitted",
        "read committed",
        "repeatable read",
        "serializable",
      ].includes(isolationLevel)
    ) {
      throw new BunDialectError(
        `Unsupported PostgreSQL isolation level: ${isolationLevel}`,
      );
    }
    if (
      accessMode !== undefined &&
      accessMode !== "read only" &&
      accessMode !== "read write"
    ) {
      throw new BunDialectError(
        `Unsupported PostgreSQL access mode: ${accessMode}`,
      );
    }

    let sql = "begin";
    if (isolationLevel || accessMode) {
      sql = "start transaction";
      if (isolationLevel) sql += ` isolation level ${isolationLevel}`;
      if (accessMode) sql += ` ${accessMode}`;
    }
    await this.executeQuery(CompiledQuery.raw(sql));
  }

  async commitTransaction(): Promise<void> {
    await this.executeQuery(CompiledQuery.raw("commit"));
  }

  /** Bun opens its own cancellation socket; a pool control connection is unnecessary. */
  async cancelQuery(
    controlConnectionProvider: ControlConnectionProvider,
  ): Promise<void> {
    void controlConnectionProvider;
    const active = this.#activeQuery;
    if (!active) return;
    this.#cancel(active);
    // cancel() is only a request. Kysely must not release the reservation yet.
    await active.settled;
  }

  async executeQuery<R>(
    compiledQuery: CompiledQuery,
    options?: AbortableOperationOptions,
  ): Promise<QueryResult<R>> {
    // Kysely forwards only { signal }, not inflightQueryAbortStrategy. Check it
    // before SQL starts; only cancelQuery may request native cancellation.
    // Direct callers therefore cannot abort in-flight SQL using signal alone.
    const signal = options?.signal;
    signal?.throwIfAborted();
    // PostgreSQL cancellation targets a session, not a particular pipelined query.
    // Serialize even direct callers. Do not use the injected ReservedSQL elsewhere.
    while (this.#activeQuery) {
      await this.#activeQuery.settled;
      signal?.throwIfAborted();
    }
    if (this.#releasing) {
      throw new BunDialectError("Connection is being released");
    }
    const parameters = compiledQuery.parameters.map(transformValue);
    signal?.throwIfAborted();
    const query = this.#reservedConnection.unsafe(
      compiledQuery.sql,
      parameters,
    );
    let settle!: () => void;
    const active: ActiveQuery = {
      query,
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
      cancelRequested: false,
    };
    this.#activeQuery = active;

    try {
      // Do not race against the signal: native settlement owns the reservation.
      // Kysely itself races the public operation and preserves signal.reason.
      const result = await query;
      const nativeRows = Array.from(result.values()) as R[];
      const rows = this.#normalizeNumericArrays
        ? normalizeNumericArrayRows(nativeRows, result.columns)
        : nativeRows;
      if (
        result.command !== null &&
        ["INSERT", "UPDATE", "DELETE", "MERGE"].includes(result.command)
      ) {
        return {
          numAffectedRows: BigInt(
            result.affectedRows ?? result.count ?? rows.length,
          ),
          rows,
        };
      }
      return { rows };
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ERR_POSTGRES_QUERY_CANCELLED" &&
        "hint" in error &&
        error.hint
      ) {
        // Bun may reject locally if cancellation delivery fails or external SQL
        // was pipelined. A subsequent response (even 25P02 in a failed transaction)
        // drains server work before release/reuse. This is not a retry of the SQL.
        try {
          await this.#reservedConnection.unsafe("select 1");
        } catch {
          // A server error still acknowledges the barrier; a lost socket is not reusable.
        }
      }
      throw error;
    } finally {
      this.#activeQuery = undefined;
      settle();
    }
  }

  #cancel(active: ActiveQuery): void {
    if (!active.cancelRequested) {
      active.cancelRequested = true;
      active.query.cancel();
    }
  }

  async releaseConnection(): Promise<void> {
    this.#releasing = true;
    await this.#activeQuery?.settled;
    await this.#reservedConnection.release();
    this.#reservedConnection = null!;
  }

  async rollbackTransaction(): Promise<void> {
    await this.executeQuery(CompiledQuery.raw("rollback"));
  }

  async *streamQuery<R>(): AsyncGenerator<QueryResult<R>> {
    // Bun COPY streams carry bytes, not Kysely row batches.
    throw new BunDialectError("streamQuery is not supported");
  }
}
