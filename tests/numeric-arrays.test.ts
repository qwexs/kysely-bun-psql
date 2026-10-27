import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunDialect, jsonb } from "../src/index";

interface Database {
  numeric_array_read: { id: number; ints: number[]; reals: number[] };
}

type NumericRow = { ints: number[]; reals: number[] };

function database(prepare: boolean) {
  const url = process.env["DATABASE_URL"];
  if (!url)
    throw new Error("Set DATABASE_URL to a disposable PostgreSQL database");
  return new Kysely<Database>({
    dialect: new BunDialect({
      url,
      prepare,
      max: 1,
      connectionTimeout: 5,
      closeTimeout: 1,
    }),
  });
}

function expectArrays(row: NumericRow, reals: number[] = [1.5, 2.5]) {
  expect(Array.isArray(row.ints)).toBe(true);
  expect(Array.isArray(row.reals)).toBe(true);
  expect(row.ints).toEqual([1, 2, 3]);
  expect(row.reals).toEqual(reals);
  expect(JSON.stringify(row.ints)).toBe("[1,2,3]");
  expect(row.ints.map((id) => ({ id }))).toEqual([
    { id: 1 },
    { id: 2 },
    { id: 3 },
  ]);
}

describe.each([true, false])("numeric array reads (prepare: %s)", (prepare) => {
  test("normalizes parameterized SELECT results without configuration or changed numbers", async () => {
    const db = database(prepare);
    try {
      for (let run = 0; run < 2; run++) {
        const result = await sql<NumericRow>`
          select ARRAY[1,2,3]::integer[] as ints,
                 ARRAY[0.1,2.5]::real[] as reals
          where ${true}::boolean
        `.execute(db);
        expectArrays(result.rows[0]!, [prepare ? Math.fround(0.1) : 0.1, 2.5]);
      }
    } finally {
      await db.destroy();
    }
  });

  test("normalizes SELECT results without parameters on repeated execution", async () => {
    const db = database(prepare);
    try {
      for (let run = 0; run < 2; run++) {
        const result = await sql<NumericRow>`
          select ARRAY[1,2,3]::integer[] as ints, ARRAY[1.5,2.5]::real[] as reals
        `.execute(db);
        expectArrays(result.rows[0]!);
      }
    } finally {
      await db.destroy();
    }
  });

  test("handles empty, SQL NULL, nullable and multidimensional arrays", async () => {
    const db = database(prepare);
    try {
      const { rows } = await sql<{
        ints: number[];
        reals: number[];
        nil: null;
        nullable: (number | null)[];
        nullable_reals: (number | null)[];
        matrix: number[][];
        real_matrix: number[][];
      }>`
        select ARRAY[]::integer[] as ints, ARRAY[]::real[] as reals,
               NULL::integer[] as nil, ARRAY[1,NULL,3]::integer[] as nullable,
               ARRAY[1.5,NULL,2.5]::real[] as nullable_reals,
               ARRAY[[1,2],[3,4]]::integer[] as matrix,
               ARRAY[[1.5,2.5],[3.5,4.5]]::real[] as real_matrix
        where ${true}::boolean
      `.execute(db);
      const row = rows[0]!;
      expect(Array.isArray(row.ints)).toBe(true);
      expect(Array.isArray(row.reals)).toBe(true);
      expect(row.ints).toEqual([]);
      expect(row.reals).toEqual([]);
      expect(row.nil).toBeNull();
      expect(row.nullable).toEqual([1, null, 3]);
      expect(row.nullable_reals).toEqual([1.5, null, 2.5]);
      expect(row.matrix).toEqual([
        [1, 2],
        [3, 4],
      ]);
      expect(row.real_matrix).toEqual([
        [1.5, 2.5],
        [3.5, 4.5],
      ]);
    } finally {
      await db.destroy();
    }
  });

  test("normalizes INSERT, UPDATE and DELETE RETURNING and preserves affected counts", async () => {
    const db = database(prepare);
    try {
      await db.connection().execute(async (connection) => {
        await sql`create temporary table numeric_array_read (id integer, ints integer[], reals real[])`.execute(
          connection,
        );
        const inserted = await connection
          .insertInto("numeric_array_read")
          .values({ id: 1, ints: [1, 2, 3], reals: [1.5, 2.5] })
          .returningAll()
          .executeTakeFirstOrThrow();
        expectArrays(inserted);
        const updated = await connection.executeQuery(
          connection
            .updateTable("numeric_array_read")
            .set({ ints: [1, 2, 3] })
            .where("id", "=", 1)
            .returningAll()
            .compile(),
        );
        expect(updated.numAffectedRows).toBe(1n);
        expectArrays(updated.rows[0]!);
        const deleted = await connection.executeQuery(
          connection
            .deleteFrom("numeric_array_read")
            .where("id", "=", 1)
            .returningAll()
            .compile(),
        );
        expect(deleted.numAffectedRows).toBe(1n);
        expectArrays(deleted.rows[0]!);
      });
    } finally {
      await db.destroy();
    }
  });

  test("supports shared clients, native column transforms and duplicate aliases", async () => {
    const pool = new SQL({
      url: process.env["DATABASE_URL"],
      prepare,
      max: 1,
      transform: SQL.toCamel,
    });
    const db = new Kysely<Database>({
      dialect: new BunDialect({ sql: pool }),
    });
    try {
      const bytes = Buffer.from([1, 2, 3]);
      const { rows } = await sql<{
        audienceGrades: number[];
        duplicate: number[];
        lastBytes: Buffer;
      }>`
        select ARRAY[1,2,3]::integer[] as audience_grades,
               ${bytes}::bytea as duplicate, ARRAY[1,2]::integer[] as duplicate,
               ARRAY[1,2]::integer[] as last_bytes, ${bytes}::bytea as last_bytes
      `.execute(db);
      expect(Array.isArray(rows[0]!.audienceGrades)).toBe(true);
      expect(rows[0]!.audienceGrades).toEqual([1, 2, 3]);
      expect(Array.isArray(rows[0]!.duplicate)).toBe(true);
      expect(rows[0]!.duplicate).toEqual([1, 2]);
      expect(Buffer.isBuffer(rows[0]!.lastBytes)).toBe(true);
      expect(rows[0]!.lastBytes).toEqual(bytes);
      // The dialect must not change direct reads on the caller's native client.
      const direct = await pool.unsafe(
        "select ARRAY[1,2]::integer[] as ints where $1::boolean",
        [true],
      );
      expect(direct[0].ints).toBeInstanceOf(prepare ? Int32Array : Array);
    } finally {
      await db.destroy();
      await pool.close();
    }
  });

  test.each([false, true])(
    "leaves JSON, bytea, bigint and raw enum arrays native (bigint: %s)",
    async (bigint) => {
      const db = new Kysely<Database>({
        dialect: new BunDialect({
          url: process.env["DATABASE_URL"],
          prepare,
          bigint,
          max: 1,
        }),
      });
      try {
        await db.connection().execute(async (connection) => {
          await sql`create type pg_temp.numeric_array_mood as enum ('ok', 'a,b', 'a"b\\c', 'NULL')`.execute(
            connection,
          );
          const moods = ["ok", "a,b", 'a"b\\c', "NULL", null];
          const moodExpression = sql`${moods}::pg_temp.numeric_array_mood[]`;
          const bytes = Buffer.from([0, 1, 255]);
          const { rows } = await sql<{
            moods: string;
            mood_text: string;
            mood_json: (string | null)[];
            json_array: unknown[];
            json_object: { nested: number[] };
            bytes: Buffer;
            bigints: (string | bigint)[];
            scalar_bigint: string | bigint;
            tags: string[];
            stamp: Date;
          }>`
          select ${moodExpression} as moods, (${moodExpression})::text as mood_text,
                 to_jsonb(${moodExpression}) as mood_json,
                 ${jsonb([1, { nested: [2, 3] }])}::jsonb as json_array,
                 ${jsonb({ nested: [1, 2] })}::jsonb as json_object,
                 ${bytes}::bytea as bytes,
                 ARRAY[1,9223372036854775807]::bigint[] as bigints,
                 42::bigint as scalar_bigint, ARRAY['a','b']::text[] as tags,
                 '2026-01-01T00:00:00Z'::timestamptz as stamp
        `.execute(connection);
          const row = rows[0]!;
          expect(typeof row.moods).toBe("string");
          expect(row.moods).toBe(row.mood_text);
          expect(row.mood_json).toEqual(moods);
          expect(row.json_array).toEqual([1, { nested: [2, 3] }]);
          expect(row.json_object).toEqual({ nested: [1, 2] });
          expect(Buffer.isBuffer(row.bytes)).toBe(true);
          expect(row.bytes).toEqual(bytes);
          expect(row.bigints).toEqual(
            bigint ? [1n, 9223372036854775807n] : ["1", "9223372036854775807"],
          );
          expect(row.scalar_bigint).toBe(bigint ? 42n : "42");
          expect(row.tags).toEqual(["a", "b"]);
          expect(row.stamp).toBeInstanceOf(Date);
          expect(row.stamp.toISOString()).toBe("2026-01-01T00:00:00.000Z");
        });
      } finally {
        await db.destroy();
      }
    },
  );
});
