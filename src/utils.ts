import { SQL } from "bun";
import { sql, type RawBuilder } from "kysely";

// Only parameter factories are used: no queries or reservations, so this client
// never opens connections. Its adapter must not depend on the ambient Bun.sql.
const helperSql = new SQL({ adapter: "postgres" });

/**
 * @deprecated Legacy JSONB marker, retained for source compatibility only.
 * Native Bun serialization and the JSON helpers no longer use this symbol.
 */
export const JSONB_SYMBOL = Symbol.for("kysely-bun-psql:jsonb");

/** Leave parameter serialization, including arrays and JSON, to Bun SQL. */
export function transformValue(value: unknown): unknown {
  return value;
}

/**
 * @deprecated Use native array parameters or pgArray() instead.
 * This legacy literal serializer is not used by the connection's native path.
 */
export function createPostgresArray(arr: readonly unknown[]): string {
  const elements = Array.from(arr, (item): string => {
    if (Array.isArray(item)) {
      return createPostgresArray(item);
    }
    if (item === null || item === undefined) {
      return "NULL";
    }
    if (typeof item === "string") {
      const escaped = item.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `"${escaped}"`;
    }
    return String(item);
  });
  return `{${elements.join(",")}}`;
}

export function freeze<T>(obj: T): Readonly<T> {
  return Object.freeze(obj);
}

/**
 * Bind a value as JSON using Bun's native JSON parameter helper.
 * Supports objects, arrays (including frozen arrays), scalars and JSON null,
 * without mutating the input. Works with prepare: true and prepare: false.
 * Returns a Kysely expression, not the original value or serialized JSON text.
 *
 * @example
 * db.insertInto('table').values({ tags: jsonb(["tag1", "tag2"]) }).execute();
 */
export function jsonb<T>(value: T): RawBuilder<T> {
  return sql.val(helperSql.json(value)).$castTo<T>();
}

/**
 * Bind a JSONB[] parameter without mutating the input.
 * null elements are JSON null; undefined elements are SQL NULL.
 * Nested JS arrays are single JSON values, not SQL array dimensions.
 * SQL NULL elements read back as null, so undefined becomes null in the result type.
 */
export function jsonbArray<T>(
  arr: readonly T[],
): RawBuilder<(T extends undefined ? null : T)[]> {
  const values = Array.from(arr, (item) =>
    Array.isArray(item) ? helperSql.json(item) : item,
  );
  return sql
    .val(helperSql.array(values, "JSONB"))
    .$castTo<(T extends undefined ? null : T)[]>();
}

/**
 * Bind a PostgreSQL array, optionally specifying its element type name or array
 * type OID. Use this for custom enums and typed arrays. Nested JS arrays retain
 * their SQL dimensions; null elements are SQL NULL (except with JSON/JSONB).
 * Undefined elements read back as null. The result type describes the column
 * value, not Bun's binary decoding format.
 */
export function pgArray<T>(
  values: readonly T[],
  type?: Parameters<SQL["array"]>[1],
): RawBuilder<(T extends undefined ? null : T)[]>;
export function pgArray<T extends NodeJS.TypedArray>(
  values: T,
  type?: Parameters<SQL["array"]>[1],
): RawBuilder<T[number][]>;
export function pgArray(
  values: readonly unknown[] | NodeJS.TypedArray,
  type?: Parameters<SQL["array"]>[1],
): RawBuilder<unknown[]> {
  // Bun's declaration takes mutable arrays, so copy readonly arrays at the edge.
  const input = Array.isArray(values)
    ? [...values]
    : (values as NodeJS.TypedArray);
  return sql.val(helperSql.array(input, type)).$castTo<unknown[]>();
}
