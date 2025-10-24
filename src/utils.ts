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
 * Converts ["a", "b", 1] to {"a","b","1"}
 * Handles nested arrays, objects, and mixed types with proper quoting
 */
function createPostgresArray(arr: unknown[]): string {
  const serialized = arr
    .map((item) => {
      if (item === null) {
        return "NULL";
      }
      if (typeof item === "string") {
        // Экранируем обратные слэши и кавычки для PostgreSQL
        const escaped = item.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        return `"${escaped}"`;
      }
      if (typeof item === "object" && !Array.isArray(item)) {
        // Объекты в массивах - сериализуем в JSON и экранируем правильно
        const jsonString = JSON.stringify(item);
        // Сначала экранируем обратные слэши, затем двойные кавычки для PostgreSQL
        const escaped = jsonString.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        return `"${escaped}"`;
      }
      if (Array.isArray(item)) {
        // Вложенные массивы - рекурсивная обработка
        return createPostgresArray(item);
      }
      // Числа, булевы значения и т.д. - передаем как есть для PostgreSQL
      return String(item);
    })
    .join(",");
  return `{${serialized}}`;
}
