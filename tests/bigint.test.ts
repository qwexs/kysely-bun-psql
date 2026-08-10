import { describe, expect, test } from "bun:test";
import { CompiledQuery, Kysely } from "kysely";
import { BunDialect } from "../src/index";

type Int8Values = {
  small_int8: number | string | bigint;
  above_i32: number | string | bigint;
  max_int8: number | string | bigint;
};

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://localhost:5432/test";

async function selectInt8Values(bigint?: boolean): Promise<Int8Values> {
  const db = new Kysely<Record<never, never>>({
    dialect: new BunDialect({
      url: DATABASE_URL,
      bigint,
    }),
  });

  try {
    const result = await db.executeQuery<Int8Values>(
      CompiledQuery.raw(`
        SELECT
          42::bigint AS small_int8,
          2147483648::bigint AS above_i32,
          9223372036854775807::bigint AS max_int8
      `),
    );

    return result.rows[0]!;
  } finally {
    await db.destroy();
  }
}

describe("BunDialect PostgreSQL BIGINT runtime contract", () => {
  test("preserves Bun SQL's default string representation above int32", async () => {
    const values = await selectInt8Values();

    expect(values.above_i32).toBe("2147483648");
    expect(values.max_int8).toBe("9223372036854775807");
  });

  test("forwards bigint: true and returns exact large values as bigint", async () => {
    const values = await selectInt8Values(true);

    expect(values.above_i32).toBe(2_147_483_648n);
    expect(values.max_int8).toBe(9_223_372_036_854_775_807n);

    const smallInt8Type = typeof values.small_int8;
    expect(["number", "bigint"]).toContain(smallInt8Type);
  });
});
