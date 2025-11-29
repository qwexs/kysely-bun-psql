/**
 * Transform values for PostgreSQL compatibility
 *
 * Strategy:
 * - Arrays of primitives (string, number, boolean): convert to PostgreSQL ARRAY syntax for TEXT[], INTEGER[] etc.
 * - Arrays containing objects: pass through as-is (Bun SQL handles JSONB serialization)
 * - Objects: pass through as-is (Bun SQL handles JSONB serialization)
 * - Primitive values: pass through
 *
 * This approach supports:
 * - TEXT[], INTEGER[] columns with primitive values using PostgreSQL ARRAY syntax
 * - JSONB fields with objects or arrays (handled natively by Bun SQL)
 *
 * Note: For JSONB[] columns, use the jsonbArray() helper function.
 */
export function transformValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    // Check if array contains any objects (excluding null)
    const containsObjects = value.some((item) => {
      return item !== null && typeof item === "object" && !Array.isArray(item);
    });

    // Arrays with objects - let Bun handle natively for JSONB columns
    // For JSONB[] columns, user should use jsonbArray() helper
    if (containsObjects) {
      return value;
    }

    // Arrays of primitives - convert to PostgreSQL ARRAY syntax
    return createPostgresArray(value);
  }

  // Objects and primitives - let Bun handle natively
  return value;
}

/**
 * Create PostgreSQL ARRAY literal from array of primitives
 * Converts ["a", "b", 1] to {"a","b","1"}
 * Handles null values and primitive types with proper quoting
 */
export function createPostgresArray(arr: unknown[]): string {
  const serialized = arr
    .map((item) => {
      if (typeof item === "string") {
        // Экранируем обратные слэши и кавычки для PostgreSQL
        const escaped = item.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        return `"${escaped}"`;
      }
      // Numbers, booleans, and other primitives - pass through as strings
      return String(item);
    })
    .join(",");
  return `{${serialized}}`;
}

export function freeze<T>(obj: T): Readonly<T> {
  return Object.freeze(obj);
}

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
export function jsonbArray<T>(arr: T[]): T[] & string {
  if (arr.length === 0) {
    return "{}" as T[] & string;
  }

  const elements = arr.map((item) => {
    if (item === null) {
      return "null";
    }
    const jsonStr = JSON.stringify(item);
    const escaped = jsonStr.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  });

  return `{${elements.join(",")}}` as T[] & string;
}
