import { SQL, sql as bunSql, type ReservedSQL } from "bun";
import { describe, expect, test } from "bun:test";
import {
  createQueryId,
  Kysely,
  PostgresQueryCompiler,
  sql,
  type ColumnType,
  type Generated,
  type RawBuilder,
} from "kysely";
import { BunDialect, jsonb, jsonbArray, pgArray } from "../src/index";

async function withSession(
  prepare: boolean,
  run: (session: ReservedSQL) => Promise<void>,
): Promise<void> {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("Set DATABASE_URL and preload tests/setup.ts");
  // Keep setup's search_path and isolate all temporary objects to this session.
  const pool = new SQL(url, { prepare, max: 1 });
  try {
    using session = await pool.reserve();
    await run(session);
  } finally {
    await pool.close();
  }
}

function execute<T>(session: ReservedSQL, expression: RawBuilder<T>) {
  const compiled = new PostgresQueryCompiler().compileQuery(
    expression.toOperationNode(),
    createQueryId(),
  );
  return session.unsafe<T[]>(compiled.sql, compiled.parameters);
}

describe.each([true, false])(
  "native unsafe parameters (prepare: %s)",
  (prepare) => {
    test("Kysely binds ordinary arrays as SQL arrays and explicit JSON as JSON", async () => {
      interface Database {
        array_contract: {
          id: Generated<number>;
          moods: (string | null)[];
          tags: (string | null)[];
          data: unknown;
          objects: unknown;
          payloads: unknown[];
        };
      }

      const url = process.env["DATABASE_URL"];
      if (!url) throw new Error("Set DATABASE_URL and preload tests/setup.ts");
      const pool = new SQL(url, { prepare, max: 1 });
      const db = new Kysely<Database>({
        dialect: new BunDialect({ sql: pool }),
      });
      try {
        await pool.unsafe(`
          CREATE TEMP TABLE array_contract (
            id serial PRIMARY KEY,
            tags text[],
            data jsonb,
            objects jsonb,
            payloads jsonb[]
          )
        `);
        await pool.unsafe(`
          CREATE TYPE pg_temp.array_contract_mood AS ENUM
          ('ok', 'happy', 'a,b', 'a"b\\c', 'NULL')
        `);
        await pool.unsafe(`
          ALTER TABLE array_contract ADD COLUMN moods pg_temp.array_contract_mood[]
        `);

        const moods = ["ok", "a,b", 'a"b\\c', "NULL", null];
        const tags = ["a,b", 'a"b\\c', "NULL", null];
        const inserted = await db
          .insertInto("array_contract")
          .values({
            moods: pgArray(moods),
            tags,
            data: jsonb([1, null, "two"]),
            objects: jsonb([{ id: 1 }, { id: 2 }]),
            payloads: jsonbArray([{ id: 1 }, null]),
          })
          .returning([
            "id",
            "tags",
            "data",
            "objects",
            "payloads",
            sql<(string | null)[]>`moods::text[]`.as("moods"),
            sql<boolean>`payloads[2] IS NULL`.as("payload_is_sql_null"),
          ])
          .executeTakeFirstOrThrow();
        expect(inserted.moods).toEqual(moods);
        expect(inserted.tags).toEqual(tags);
        expect(inserted.data).toEqual([1, null, "two"]);
        expect(inserted.objects).toEqual([{ id: 1 }, { id: 2 }]);
        expect(inserted.payloads).toEqual([{ id: 1 }, null]);
        expect(inserted.payload_is_sql_null).toBe(false);

        const updated = await db
          .updateTable("array_contract")
          .set({ moods: pgArray([]), tags: [], data: jsonb([]) })
          .where("id", "=", inserted.id)
          .returning([
            "tags",
            "data",
            sql<(string | null)[]>`moods::text[]`.as("moods"),
          ])
          .executeTakeFirstOrThrow();
        expect(updated.moods).toEqual([]);
        expect(updated.tags).toEqual([]);
        expect(updated.data).toEqual([]);
      } finally {
        await db.destroy();
        await pool.close();
      }
    });

    test("Kysely writes bare JSON arrays and objects without storing JSON strings", async () => {
      type JsonValue =
        | string
        | number
        | boolean
        | null
        | readonly JsonValue[]
        | { readonly [key: string]: JsonValue };
      interface Database {
        native_json_contract: {
          id: Generated<number>;
          document: ColumnType<JsonValue, JsonValue, JsonValue>;
          data: ColumnType<JsonValue, JsonValue, JsonValue>;
        };
      }
      const payloads: JsonValue[] = [
        [],
        {},
        [1, 2, 3],
        [true, false, null],
        ["NULL", 'a"b\\c', "a,b", "{x}", ""],
        [{ id: 1 }, { id: 2, tags: ["nested"] }],
        [1, "two", false, null, { nested: [3, null] }],
        [
          [1, 2],
          [3, 4],
        ],
        { schedule: [{ day: "MONDAY", slots: [1, null, 3] }] },
        Object.freeze([Object.freeze({ id: 1 }), Object.freeze([true, null])]),
        Object.freeze({ tags: Object.freeze(["frozen", "array"]) }),
      ];
      const before = structuredClone(payloads);
      const url = process.env["DATABASE_URL"];
      if (!url) throw new Error("Set DATABASE_URL and preload tests/setup.ts");
      const pool = new SQL(url, { prepare, max: 1 });
      const db = new Kysely<Database>({
        dialect: new BunDialect({ sql: pool }),
      });
      try {
        await db.connection().execute(async (connection) => {
          await sql`create temporary table native_json_contract (
            id serial primary key, document json not null, data jsonb not null
          )`.execute(connection);
          const types = [
            sql<string>`json_typeof(document)`.as("document_type"),
            sql<string>`jsonb_typeof(data)`.as("data_type"),
          ];
          for (const value of payloads) {
            const kind = Array.isArray(value) ? "array" : "object";
            const inserted = await connection
              .insertInto("native_json_contract")
              .values({ document: value, data: value })
              .returningAll()
              .returning(types)
              .executeTakeFirstOrThrow();
            expect(inserted).toEqual({
              id: inserted.id,
              document: value,
              data: value,
              document_type: kind,
              data_type: kind,
            });

            if (Array.isArray(value)) {
              // A predicate array is normally a Kysely list; sql.val binds one JSON value.
              const matched = await connection
                .selectFrom("native_json_contract")
                .select("id")
                .where("id", "=", inserted.id)
                .where("data", "=", sql.val(value))
                .execute();
              expect(matched).toEqual([{ id: inserted.id }]);
            }

            const replacement = { previous: value };
            const updated = await connection
              .updateTable("native_json_contract")
              .set({ document: replacement, data: replacement })
              .where("id", "=", inserted.id)
              .returningAll()
              .returning(types)
              .executeTakeFirstOrThrow();
            expect(updated).toEqual({
              id: inserted.id,
              document: replacement,
              data: replacement,
              document_type: "object",
              data_type: "object",
            });
            const restored = await connection
              .updateTable("native_json_contract")
              .set({ document: value, data: value })
              .where("id", "=", inserted.id)
              .returningAll()
              .returning(types)
              .executeTakeFirstOrThrow();
            expect(restored).toEqual(inserted);
          }

          // Scalars still use an explicit helper for consistent prepared/unprepared binding.
          for (const value of [42, false, 'a"b\\c']) {
            const inserted = await connection
              .insertInto("native_json_contract")
              .values({ document: jsonb(value), data: jsonb(value) })
              .returningAll()
              .returning(types)
              .executeTakeFirstOrThrow();
            expect(inserted.document).toEqual(value);
            expect(inserted.data).toEqual(value);
            expect(inserted.document_type).toBe(typeof value);
            expect(inserted.data_type).toBe(typeof value);
          }
          expect(payloads).toEqual(before);
        });
      } finally {
        await db.destroy();
        await pool.close();
      }
    });

    test("Kysely writes native int[] and text[] without wrappers or mutation", async () => {
      interface Database {
        native_array_contract: {
          id: Generated<number>;
          ints: readonly (number | null)[];
          texts: readonly (string | null)[];
          matrix: readonly (readonly (number | null)[])[];
          text_matrix: readonly (readonly (string | null)[])[];
        };
      }
      const values = {
        ints: Object.freeze([1, null, -3]),
        texts: Object.freeze([
          "",
          "null",
          "NULL",
          null,
          'a"b\\c',
          "a,b",
          "{x}",
          "line\nbreak",
        ]),
        matrix: Object.freeze([
          Object.freeze([1, null]),
          Object.freeze([-2, 3]),
        ]),
        text_matrix: Object.freeze([
          Object.freeze(["a,b", null]),
          Object.freeze(['a"b\\c', "NULL"]),
        ]),
      };
      const before = structuredClone(values);
      const url = process.env["DATABASE_URL"];
      if (!url) throw new Error("Set DATABASE_URL and preload tests/setup.ts");
      const pool = new SQL(url, { prepare, max: 1 });
      const db = new Kysely<Database>({
        dialect: new BunDialect({ sql: pool }),
      });
      try {
        await db.connection().execute(async (connection) => {
          await sql`create temporary table native_array_contract (
            id serial primary key, ints int[], texts text[],
            matrix int[][], text_matrix text[][]
          )`.execute(connection);
          const dimensions = [
            sql<string | null>`array_dims(ints)`.as("int_dims"),
            sql<string | null>`array_dims(texts)`.as("text_dims"),
            sql<string | null>`array_dims(matrix)`.as("matrix_dims"),
            sql<string | null>`array_dims(text_matrix)`.as("text_matrix_dims"),
          ];
          const inserted = await connection
            .insertInto("native_array_contract")
            .values(values)
            .returningAll()
            .returning(dimensions)
            .executeTakeFirstOrThrow();
          expect(inserted).toEqual({
            id: inserted.id,
            ...values,
            int_dims: "[1:3]",
            text_dims: "[1:8]",
            matrix_dims: "[1:2][1:2]",
            text_matrix_dims: "[1:2][1:2]",
          });
          const empty = await connection
            .updateTable("native_array_contract")
            .set({ ints: [], texts: [], matrix: [], text_matrix: [] })
            .where("id", "=", inserted.id)
            .returningAll()
            .returning(dimensions)
            .executeTakeFirstOrThrow();
          expect(Array.from(empty.ints)).toEqual([]);
          expect(empty.texts).toEqual([]);
          expect(empty.matrix).toEqual([]);
          expect(empty.text_matrix).toEqual([]);
          expect(empty.int_dims).toBeNull();
          expect(empty.text_dims).toBeNull();
          expect(empty.matrix_dims).toBeNull();
          expect(empty.text_matrix_dims).toBeNull();
          const restored = await connection
            .updateTable("native_array_contract")
            .set(values)
            .where("id", "=", inserted.id)
            .returningAll()
            .returning(dimensions)
            .executeTakeFirstOrThrow();
          expect(restored).toEqual(inserted);
          expect(values).toEqual(before);
        });
      } finally {
        await db.destroy();
        await pool.close();
      }
    });

    test.each([false, true])(
      "Kysely preserves defaults, omission and SQL NULL (jsonb helper: %s)",
      async (useHelper) => {
        type Schedule = { day: string; slots: (number | null)[] }[];
        interface Database {
          jsonb_contract: {
            id: Generated<number>;
            label: string;
            schedule: ColumnType<
              Schedule | null,
              Schedule | null | undefined,
              Schedule | null | undefined
            >;
          };
        }
        const url = process.env["DATABASE_URL"];
        if (!url)
          throw new Error(
            "Set DATABASE_URL to a disposable PostgreSQL database",
          );
        const pool = new SQL(url, { prepare, max: 1 });
        const db = new Kysely<Database>({
          dialect: new BunDialect({ sql: pool }),
        });
        try {
          await db.connection().execute(async (connection) => {
            await sql`create temporary table jsonb_contract (
            id serial primary key, label text not null,
            schedule jsonb default '[{"day":"default","slots":[]}]'::jsonb
          )`.execute(connection);
            const defaults: Schedule = [{ day: "default", slots: [] }];
            const payload: Schedule = [{ day: "MONDAY", slots: [1, null, 3] }];
            const insert = async (
              label: string,
              schedule: Schedule | null | undefined,
            ) =>
              connection
                .insertInto("jsonb_contract")
                .values({
                  label,
                  schedule: useHelper ? jsonb(schedule) : schedule,
                })
                .returningAll()
                .returning(sql<boolean>`schedule is null`.as("is_sql_null"))
                .executeTakeFirstOrThrow();

            const missing = await connection
              .insertInto("jsonb_contract")
              .values({ label: "missing" })
              .returningAll()
              .executeTakeFirstOrThrow();
            expect(missing.schedule).toEqual(defaults);
            const omitted = await insert("omitted", undefined);
            expect(omitted.schedule).toEqual(defaults);
            const cleared = await insert("null", null);
            expect(cleared.schedule).toBeNull();
            expect(cleared.is_sql_null).toBe(true);
            const populated = await insert("array", payload);
            expect(populated.schedule).toEqual(payload);
            expect(populated.is_sql_null).toBe(false);
            const empty = await insert("empty", []);
            expect(empty.schedule).toEqual([]);
            expect(empty.is_sql_null).toBe(false);

            const update = async (schedule: Schedule | null | undefined) =>
              connection
                .updateTable("jsonb_contract")
                .set({
                  label: "updated",
                  schedule: useHelper ? jsonb(schedule) : schedule,
                })
                .where("id", "=", populated.id)
                .returningAll()
                .returning(sql<boolean>`schedule is null`.as("is_sql_null"))
                .executeTakeFirstOrThrow();
            expect((await update(undefined)).schedule).toEqual(payload);
            const updatedNull = await update(null);
            expect(updatedNull.schedule).toBeNull();
            expect(updatedNull.is_sql_null).toBe(true);
            expect((await update(payload)).schedule).toEqual(payload);
            expect((await update([])).schedule).toEqual([]);

            // Only object-form writes omit undefined; set(column, value) binds it.
            const explicitUndefined = await connection
              .updateTable("jsonb_contract")
              .set("schedule", useHelper ? jsonb(undefined) : undefined)
              .where("id", "=", populated.id)
              .returning(sql<boolean>`schedule is null`.as("is_sql_null"))
              .executeTakeFirstOrThrow();
            expect(explicitUndefined.is_sql_null).toBe(true);

            const jsonNull = await connection
              .updateTable("jsonb_contract")
              .set({ schedule: sql<null>`'null'::jsonb` })
              .where("id", "=", populated.id)
              .returning(sql<boolean>`schedule is null`.as("is_sql_null"))
              .returning(sql<string>`jsonb_typeof(schedule)`.as("json_type"))
              .executeTakeFirstOrThrow();
            expect(jsonNull.is_sql_null).toBe(false);
            expect(jsonNull.json_type).toBe("null");
          });
        } finally {
          await db.destroy();
          await pool.close();
        }
      },
    );

    test("SQL arrays, explicit JSON, objects and Int32Array", async () => {
      await withSession(prepare, async (session) => {
        const matrix = [
          [1, 2],
          [3, 4],
        ];
        const texts = ["null", "NULL", null, 'a"b\\c', "a,b", "{x}"];
        const rows = await execute(
          session,
          sql<{
            ints: (number | null)[];
            matrix: number[][];
            texts: (string | null)[];
            json: (number | string | null)[];
            object: { tags: number[] };
            typed: Int32Array | number[];
          }>`
        SELECT ${[1, null, 3]}::int[] AS ints,
               ${matrix}::int[][] AS matrix,
               ${texts}::text[] AS texts,
               ${jsonb([1, null, "two"])}::jsonb AS json,
               ${{ tags: [1, 2] }}::jsonb AS object,
               ${new Int32Array([1, 2, 3])}::int[] AS typed
      `,
        );
        expect(rows[0]!.ints).toEqual([1, null, 3]);
        expect(rows[0]!.matrix).toEqual(matrix);
        expect(rows[0]!.texts).toEqual(texts);
        expect(rows[0]!.json).toEqual([1, null, "two"]);
        expect(rows[0]!.object).toEqual({ tags: [1, 2] });
        expect(Array.from(rows[0]!.typed)).toEqual([1, 2, 3]);
      });
    });

    test("Bun's native JSON and array helpers survive unsafe binding", async () => {
      await withSession(prepare, async (session) => {
        const [row] = await session.unsafe<
          {
            value: (number | null)[];
            items: (string | null)[];
            is_sql_null: boolean;
          }[]
        >(
          "SELECT $1::jsonb AS value, $2::text[] AS items, $3::jsonb IS NULL AS is_sql_null",
          [
            bunSql.json(Object.freeze([1, null])),
            bunSql.array(["red", null], "TEXT"),
            bunSql.json(null),
          ],
        );
        expect(row!.value).toEqual([1, null]);
        expect(row!.items).toEqual(["red", null]);
        expect(row!.is_sql_null).toBe(false);
      });
    });

    test("jsonb supports frozen JSON, scalars and SQL NULL versus explicit JSON null", async () => {
      await withSession(prepare, async (session) => {
        const frozen = Object.freeze([1, null, "two"]);
        const object = Object.freeze({ active: true });
        const [row] = await execute(
          session,
          sql<{
            frozen: readonly (number | string | null)[];
            object: { active: boolean };
            number: number;
            boolean: boolean;
            string: string;
            json_null: null;
            json_is_sql_null: boolean;
            sql_is_null: boolean;
          }>`
        SELECT ${jsonb(frozen)}::jsonb AS frozen,
               ${jsonb(object)}::jsonb AS object,
               ${jsonb(42)}::jsonb AS number,
               ${jsonb(false)}::jsonb AS boolean,
               ${jsonb('a"b\\c')}::jsonb AS string,
               'null'::jsonb AS json_null,
               'null'::jsonb IS NULL AS json_is_sql_null,
               ${jsonb(null)}::jsonb IS NULL AS sql_is_null
      `,
        );
        expect(row).toEqual({
          frozen: [1, null, "two"],
          object: { active: true },
          number: 42,
          boolean: false,
          string: 'a"b\\c',
          json_null: null,
          json_is_sql_null: false,
          sql_is_null: true,
        });
        expect(Reflect.ownKeys(frozen)).toEqual(["0", "1", "2", "length"]);
        expect(Reflect.ownKeys(object)).toEqual(["active"]);
      });
    });

    test("jsonbArray preserves JSON values, JSON null and SQL NULL elements", async () => {
      await withSession(prepare, async (session) => {
        const input = Object.freeze([
          { text: 'a"b\\c' },
          null,
          undefined,
          Object.freeze([1, null]),
          "null",
          true,
          42,
        ]);
        const before = JSON.stringify(input);
        const [row] = await execute(
          session,
          sql<{
            payloads: unknown[];
            json_is_sql_null: boolean;
            undefined_is_sql_null: boolean;
            dimensions: number;
            empty: unknown[];
          }>`
        WITH bound AS (SELECT ${jsonbArray(input)}::jsonb[] AS payloads)
        SELECT payloads,
               payloads[2] IS NULL AS json_is_sql_null,
               payloads[3] IS NULL AS undefined_is_sql_null,
               array_ndims(payloads) AS dimensions,
               ${jsonbArray([])}::jsonb[] AS empty
        FROM bound
      `,
        );
        expect(row!.payloads).toEqual([
          { text: 'a"b\\c' },
          null,
          null,
          [1, null],
          "null",
          true,
          42,
        ]);
        expect(row!.json_is_sql_null).toBe(false);
        expect(row!.undefined_is_sql_null).toBe(true);
        expect(row!.dimensions).toBe(1);
        expect(row!.empty).toEqual([]);
        expect(JSON.stringify(input)).toBe(before);
      });
    });

    test("pgArray binds typed arrays and multidimensional SQL arrays", async () => {
      await withSession(prepare, async (session) => {
        const floats = new Float32Array([1.5, 2.5]);
        const bigints = new BigInt64Array([1n, 9007199254740993n]);
        const [row] = await execute(
          session,
          sql<{
            floats: Float32Array | number[];
            inferred: number[];
            bigints: string[];
            matrix: (number | null)[][];
          }>`
        SELECT ${pgArray(floats, "REAL")}::real[] AS floats,
               ${pgArray(new Float64Array([1.5, 2.5]))}::float8[] AS inferred,
               ${pgArray(bigints, "BIGINT")}::bigint[] AS bigints,
               ${pgArray(
                 [
                   [1, null],
                   [2, 3],
                 ],
                 "INT",
               )}::int[][] AS matrix
      `,
        );
        expect(Array.from(row!.floats)).toEqual([1.5, 2.5]);
        expect(row!.inferred).toEqual([1.5, 2.5]);
        expect(row!.bigints).toEqual(["1", "9007199254740993"]);
        expect(row!.matrix).toEqual([
          [1, null],
          [2, 3],
        ]);
      });
    });

    test("pgArray binds a custom enum using only session-local objects", async () => {
      await withSession(prepare, async (session) => {
        // Creating a temporary table initializes pg_temp before creating the type.
        await session.unsafe(
          "CREATE TEMP TABLE native_parameter_enum (id int)",
        );
        await session.unsafe(
          "CREATE TYPE pg_temp.native_parameter_mood AS ENUM ('ok', 'happy')",
        );
        await session.unsafe(
          "ALTER TABLE native_parameter_enum ADD COLUMN moods pg_temp.native_parameter_mood[]",
        );
        const moods = Object.freeze(["ok", "happy", null]);
        const [row] = await execute(
          session,
          sql<{ moods: (string | null)[] }>`
        INSERT INTO native_parameter_enum (moods)
        VALUES (${pgArray(moods, "pg_temp.native_parameter_mood")})
        RETURNING moods::text[] AS moods
      `,
        );
        expect(row!.moods).toEqual([...moods]);
      });
    });
  },
);
