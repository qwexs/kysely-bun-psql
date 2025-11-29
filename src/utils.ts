/**
 * Transform values for PostgreSQL compatibility
 *
 * Strategy:
 * - Arrays of primitives (string, number, boolean, null): convert to PostgreSQL ARRAY syntax
 * - Arrays containing objects: convert to PostgreSQL array syntax for JSONB[] fields
 * - Objects: pass through as-is (Bun SQL handles JSONB serialization)
 * - Empty arrays: convert to empty PostgreSQL array syntax
 * - Primitive values: pass through
 *
 * This approach supports:
 * - TEXT[], INTEGER[] columns with primitive values using PostgreSQL ARRAY syntax
 * - JSONB[] fields with arrays of objects
 * - JSONB fields with single objects (handled natively by Bun SQL)
 * - Proper handling of Bun's limitations with array serialization
 */
export function transformValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    // Check if array contains any objects (excluding null and arrays)
    const containsObjects = value.some((item) => {
      return item !== null && typeof item === "object" && !Array.isArray(item);
    });

    // If array contains objects or is empty, convert to JSON string for JSONB[]
    // Otherwise, convert to PostgreSQL ARRAY syntax for primitive array columns
    if (containsObjects || value.length === 0) {
      return createJsonArrayString(value);
    } else {
      return createPostgresArray(value);
    }
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

/**
 * Create PostgreSQL array syntax for JSONB[] fields
 * Converts arrays/objects to PostgreSQL array literal format: '{"json1","json2"}'
 */
function createJsonArrayString(arr: unknown[]): string {
  if (arr.length === 0) {
    return "{}";
  }

  // Convert each item to JSON string and escape for PostgreSQL array
  const elements = arr.map((item) => {
    if (item === null) {
      return "null";
    } else {
      const jsonStr = JSON.stringify(item);
      // Escape quotes and backslashes for PostgreSQL array syntax
      const escaped = jsonStr.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `"${escaped}"`;
    }
  });

  // Return as PostgreSQL array literal
  return `{${elements.join(",")}}`;
}

export function freeze<T>(obj: T): Readonly<T> {
  return Object.freeze(obj);
}
