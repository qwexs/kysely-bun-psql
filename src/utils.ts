export function freeze<T>(obj: T): Readonly<T> {
  return Object.freeze(obj);
}

/**
 * Transform values for PostgreSQL compatibility
 *
 * Strategy:
 * - Arrays: convert to PostgreSQL ARRAY syntax for proper array handling
 * - Objects: pass through (Bun handles JSON serialization natively)
 * - Primitive values: pass through
 */
export function transformValue(value: unknown): unknown {
  // Arrays need special handling for PostgreSQL ARRAY syntax
  if (Array.isArray(value)) {
    return createPostgresArray(value);
  }

  // Objects and primitives - let Bun handle natively
  return value;
}

/**
 * Create PostgreSQL ARRAY literal from any array
 * Converts ["a", "b", 1] to ARRAY['a','b',1]
 * Handles nested arrays and mixed types
 */
function createPostgresArray(arr: unknown[]): string {
  const serialized = arr
    .map((item) => {
      if (item === null) {
        return "NULL";
      }
      if (typeof item === "string") {
        // Escape single quotes for PostgreSQL
        const escaped = item.replace(/'/g, "''");
        return `'${escaped}'`;
      }
      if (typeof item === "object") {
        // Objects in arrays - serialize as JSON string
        return `'${JSON.stringify(item).replace(/'/g, "''")}'`;
      }
      if (Array.isArray(item)) {
        // Nested arrays - recursively handle
        return createPostgresArray(item);
      }
      // Numbers, booleans, etc.
      return String(item);
    })
    .join(",");
  return `ARRAY[${serialized}]`;
}
