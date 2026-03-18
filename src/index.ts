export * from "./connection";
export * from "./dialect";
export * from "./driver";
export * from "./errors";
export type * from "./types";
import { JSONB_SYMBOL as _JSONB_SYMBOL } from "./utils";
export { jsonbArray } from "./utils";
export const JSONB_SYMBOL = _JSONB_SYMBOL;

/**
 * Helper for JSONB columns with primitive arrays.
 * Marks the value so transformValue passes it through to Bun SQL
 * for native JSON serialization instead of converting to PostgreSQL ARRAY syntax.
 *
 * Usage:
 * ```typescript
 * import { jsonb } from '@qwexs/kysely-bun-psql';
 *
 * await db.insertInto('table')
 *   .values({ tags: jsonb(["tag1", "tag2"]) })  // ← JSONB column, not TEXT[]
 *   .execute();
 * ```
 */
export function jsonb<T extends object>(value: T): T {
  Object.defineProperty(value, _JSONB_SYMBOL, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return value;
}
