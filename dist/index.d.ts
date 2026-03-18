export * from "./connection";
export * from "./dialect";
export * from "./driver";
export * from "./errors";
export type * from "./types";
export { jsonbArray } from "./utils";
export declare const JSONB_SYMBOL: symbol;
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
export declare function jsonb<T extends object>(value: T): T;
