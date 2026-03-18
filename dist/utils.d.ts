/**
 * Symbol-маркер для значений, предназначенных для JSONB колонок.
 * transformValue пропускает такие значения без преобразования,
 * позволяя Bun SQL сериализовать их нативно как JSON.
 */
export declare const JSONB_SYMBOL: unique symbol;
/**
 * Transform values for PostgreSQL compatibility
 *
 * Strategy:
 * - Values marked with jsonb(): pass through as-is (Bun SQL handles JSONB serialization)
 * - Arrays of primitives (string, number, boolean): convert to PostgreSQL ARRAY syntax for TEXT[], INTEGER[] etc.
 * - Arrays containing objects: pass through as-is (Bun SQL handles JSONB serialization)
 * - Objects: pass through as-is (Bun SQL handles JSONB serialization)
 * - Primitive values: pass through
 *
 * This approach supports:
 * - TEXT[], INTEGER[] columns with primitive values using PostgreSQL ARRAY syntax
 * - JSONB fields with objects or arrays (handled natively by Bun SQL)
 * - JSONB fields with primitive arrays via jsonb() helper
 *
 * Note: For JSONB[] columns, use the jsonbArray() helper function.
 * Note: For JSONB columns with primitive arrays, use the jsonb() helper function.
 */
export declare function transformValue(value: unknown): unknown;
/**
 * Create PostgreSQL ARRAY literal from array of primitives
 * Converts ["a", "b", 1] to {"a","b","1"}
 * Handles null values and primitive types with proper quoting
 */
export declare function createPostgresArray(arr: unknown[]): string;
export declare function freeze<T>(obj: T): Readonly<T>;
/**
 * Helper for JSONB[] columns.
 * Converts an array of objects to PostgreSQL array literal format.
 *
 * Usage:
 * ```typescript
 * import { jsonbArray } from '@ratiu5/kysely-bun-psql';
 *
 * await db.insertInto('table')
 *   .values({ items: jsonbArray([{ a: 1 }, { b: 2 }]) })
 *   .execute();
 * ```
 */
export declare function jsonbArray<T>(arr: T[]): T[] & string;
