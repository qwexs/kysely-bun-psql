export function freeze<T>(obj: T): Readonly<T> {
  return Object.freeze(obj);
}

export function transformValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const serialized = value
      .map((item) => {
        if (item === null) {
          return "NULL";
        }
        if (typeof item === "string") {
          // Escape backslashes and double quotes
          const escaped = item.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          return `"${escaped}"`;
        }
        if (Array.isArray(item)) {
          // Nested array support
          return transformValue(item);
        }
        return String(item);
      })
      .join(",");
    return `{${serialized}}`;
  }
  return value;
}
