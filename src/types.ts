import type { SQL } from "bun";

type PostgresOptions = Omit<
  SQL.PostgresOrMySQLOptions,
  "adapter" | "allowPublicKeyRetrieval" | "foundRows"
> & {
  adapter?: "postgres";
};

type DialectOptions = {
  /**
   * Maximum seconds to wait for running queries when closing an owned pool.
   * Zero closes immediately. If omitted, Bun waits without a deadline.
   * Has no effect for an external client unless `ownsSql` is true.
   */
  closeTimeout?: number;
};

/**
 * Native Bun PostgreSQL constructor options, or an existing PostgreSQL client.
 * Connection options are passed through to Bun, including native environment
 * defaults when `url` is omitted. MySQL and SQLite clients are not supported.
 *
 * WARNING: `transform` is opt-in and is not a Kysely naming plugin. Bun can
 * rename result keys, but cannot rewrite the SQL identifiers compiled by Kysely.
 * Keep database types and aliases consistent with the returned keys; do not
 * combine native naming transforms with CamelCasePlugin unless intentional.
 * The same warning applies to transforms on an externally supplied client.
 *
 * @see https://bun.com/docs/runtime/sql
 */
export type BunDialectConfig = DialectOptions &
  (
    | (PostgresOptions & {
        sql?: never;
        /** Internally created clients are always owned by the dialect. */
        ownsSql?: true;
      })
    | ({
        /** An existing native PostgreSQL client, used without reconstructing it. */
        sql: SQL;
        /** Close this client on destroy. Defaults to false for external clients. */
        ownsSql?: boolean;
      } & {
        [Key in keyof PostgresOptions]?: never;
      })
  );
