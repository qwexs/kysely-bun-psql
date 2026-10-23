import { sql as bunSql } from "bun";
import { describe, expect, expectTypeOf, test } from "bun:test";
import {
  createQueryId,
  PostgresQueryCompiler,
  type InsertType,
  type JSONColumnType,
  type RawBuilder,
  type ValueExpression,
} from "kysely";
import { JSONB_SYMBOL, jsonb, jsonbArray, pgArray } from "../../src/index";
import { createPostgresArray, transformValue } from "../../src/utils";

function parameter(expression: RawBuilder<unknown>): unknown {
  const compiled = new PostgresQueryCompiler().compileQuery(
    expression.toOperationNode(),
    createQueryId(),
  );
  expect(compiled.sql).toBe("$1");
  expect(compiled.parameters).toHaveLength(1);
  const value = compiled.parameters[0];
  expect(transformValue(value)).toBe(value);
  return value;
}

describe("legacy PostgreSQL array literals (not the native path)", () => {
  test.each([
    { name: "empty array", input: [], expected: "{}" },
    {
      name: "numbers and booleans",
      input: [0, -2, 1.5, true, false],
      expected: "{0,-2,1.5,true,false}",
    },
    {
      name: "SQL null versus strings",
      input: [null, undefined, "null", "NULL", ""],
      expected: '{NULL,NULL,"null","NULL",""}',
    },
    {
      name: "quotes and backslashes",
      input: ['a"b', "c\\d"],
      expected: '{"a\\"b","c\\\\d"}',
    },
    {
      name: "delimiters and whitespace",
      input: ["a,b", "{x}", " a ", "a\nb", "Привет"],
      expected: '{"a,b","{x}"," a ","a\nb","Привет"}',
    },
    {
      name: "recursive dimensions",
      input: [
        [1, null],
        [2, 3],
      ],
      expected: "{{1,NULL},{2,3}}",
    },
  ])("serializes $name", ({ input, expected }) => {
    expect(createPostgresArray(input)).toBe(expected);
    expect(transformValue(input)).toBe(input);
  });
});

describe("native Bun serialization pass-through", () => {
  test.each([
    { name: "null", value: null },
    { name: "undefined", value: undefined },
    { name: "string", value: "text" },
    { name: "number", value: 42 },
    { name: "boolean", value: false },
    { name: "bigint", value: 9007199254740993n },
    { name: "empty array", value: [] },
    { name: "primitive array", value: [1, "two", null] },
    { name: "frozen array", value: Object.freeze([1, "two", null]) },
    {
      name: "2D array",
      value: [
        [1, null],
        [2, 3],
      ],
    },
    { name: "plain object", value: { tags: [1, 2] } },
    { name: "frozen object", value: Object.freeze({ id: 1 }) },
    { name: "date", value: new Date("2026-01-01T00:00:00Z") },
    { name: "binary buffer", value: new Uint8Array([0, 1, 255]) },
    { name: "integer typed array", value: new Int32Array([1, 2]) },
    { name: "float typed array", value: new Float32Array([1.5, 2.5]) },
    { name: "object array", value: [{ id: 1 }, { id: 2 }] },
    { name: "mixed object array", value: [null, "text", { id: 1 }] },
    { name: "Bun JSON helper", value: bunSql.json([1, null]) },
    { name: "Bun array helper", value: bunSql.array([1, null], "INT") },
  ])("preserves $name by identity", ({ value }) => {
    expect(transformValue(value)).toBe(value);
  });

  test("retains the deprecated marker export without requiring it", () => {
    expect<symbol>(JSONB_SYMBOL).toBe(Symbol.for("kysely-bun-psql:jsonb"));
    const value = Object.assign([1, 2], { [JSONB_SYMBOL]: true });
    expect(transformValue(value)).toBe(value);
  });
});

describe("public JSON helpers", () => {
  test.each([
    { name: "primitive array", value: [1, "two", false, null] },
    { name: "empty array", value: [] },
    { name: "object", value: { tags: [1, 2] } },
    { name: "frozen array", value: Object.freeze([1, 2]) },
    { name: "frozen object", value: Object.freeze({ tags: [1, 2] }) },
    { name: "number", value: 42 },
    { name: "boolean", value: false },
    { name: "string", value: 'a"b\\c' },
    { name: "JSON null", value: null },
  ])("jsonb binds $name without mutation", ({ value }) => {
    const before = JSON.stringify(value);
    const keys =
      value !== null && typeof value === "object"
        ? Reflect.ownKeys(value)
        : undefined;
    const expression = jsonb(value);

    expect(expression).not.toBe(value);
    expect(parameter(expression)).toEqual(bunSql.json(value));
    expect(JSON.stringify(value)).toBe(before);
    if (keys) expect(Reflect.ownKeys(value as object)).toEqual(keys);
  });

  test("jsonbArray binds an empty native JSONB array", () => {
    expect(parameter(jsonbArray([]))).toEqual(bunSql.array([], "JSONB"));
  });

  test("jsonbArray distinguishes JSON null, SQL NULL and JSON strings", () => {
    const input = Object.freeze([null, undefined, "null", { id: 1 }, true, 2]);
    const native = parameter(jsonbArray(input));
    expect(native).toEqual(bunSql.array([...input], "JSONB"));
    expect(native).toMatchObject({
      arrayType: "JSONB",
      serializedValues: '{"null",NULL,"\\"null\\"","{\\"id\\":1}","true","2"}',
    });
  });

  test("jsonbArray treats nested arrays as individual JSON values", () => {
    const nested = Object.freeze([1, null, "two"]);
    const input = Object.freeze([nested, Object.freeze({ text: 'a"b\\c' })]);
    const before = JSON.stringify(input);
    expect(parameter(jsonbArray(input))).toEqual(
      bunSql.array([bunSql.json(nested), input[1]], "JSONB"),
    );
    expect(JSON.stringify(input)).toBe(before);
  });

  test("jsonbArray normalizes SQL NULL types without changing JSON null", () => {
    type Json = { id: number };
    type NullableArray = (Json | null)[];
    type Column = JSONColumnType<NullableArray, NullableArray, NullableArray>;
    const expression = jsonbArray(Object.freeze([{ id: 1 }, undefined]));
    expectTypeOf(expression).toEqualTypeOf<RawBuilder<NullableArray>>();
    expectTypeOf(expression).toExtend<
      ValueExpression<Record<never, never>, never, InsertType<Column>>
    >();
    expectTypeOf(jsonbArray([undefined])).toEqualTypeOf<RawBuilder<null[]>>();
    expectTypeOf(jsonbArray([null])).toEqualTypeOf<RawBuilder<null[]>>();
    expectTypeOf(jsonbArray([null, undefined])).toEqualTypeOf<
      RawBuilder<null[]>
    >();
    expectTypeOf(jsonbArray([])).toEqualTypeOf<RawBuilder<never[]>>();
    expect(parameter(expression)).toMatchObject({
      arrayType: "JSONB",
      serializedValues: '{"{\\"id\\":1}",NULL}',
    });
    expect(parameter(jsonbArray([null, undefined]))).toMatchObject({
      arrayType: "JSONB",
      serializedValues: '{"null",NULL}',
    });
  });

  test("JSON helpers expose honest Kysely expression types", () => {
    expectTypeOf(jsonb({ id: 1 })).toEqualTypeOf<RawBuilder<{ id: number }>>();
    expectTypeOf(jsonb(null)).toEqualTypeOf<RawBuilder<null>>();
    type Json = { id: number };
    type Column = JSONColumnType<Json, Json, Json>;
    expectTypeOf(jsonb({ id: 1 })).toExtend<
      ValueExpression<Record<never, never>, never, InsertType<Column>>
    >();
    expectTypeOf(jsonbArray([{ id: 1 }])).toEqualTypeOf<
      RawBuilder<{ id: number }[]>
    >();
  });
});

describe("PostgreSQL helper adapter isolation", () => {
  test.each([
    { url: "mysql://unused:unused@127.0.0.1:1/unused", adapter: "mysql" },
    { url: "sqlite://:memory:", adapter: "sqlite" },
  ])(
    "ignores ambient $adapter for an explicit PostgreSQL dialect",
    async ({ url, adapter }) => {
      const script = `
      import { SQL, sql as ambient } from "bun";
      import { expect, spyOn } from "bun:test";
      import { Kysely } from "kysely";
      import { BunDialect, jsonb, jsonbArray, pgArray } from "../../src/index.ts";

      // Neither the helper-only client nor the dialect may execute SQL here.
      const reserve = spyOn(SQL.prototype, "reserve").mockImplementation(() => {
        throw new Error("Unexpected connection reservation");
      });
      const unsafe = spyOn(SQL.prototype, "unsafe").mockImplementation(() => {
        throw new Error("Unexpected SQL execution");
      });
      const client = new SQL({ adapter: "postgres" });
      const db = new Kysely({ dialect: new BunDialect({ sql: client }) });
      try {
        expect(ambient.options.adapter).toBe(${JSON.stringify(adapter)});
        const compiled = db.selectNoFrom([
          jsonb({ id: 1 }).as("object"),
          jsonb(null).as("json_null"),
          jsonbArray([{ id: 1 }, undefined, [1, 2]]).as("payloads"),
          pgArray([1, undefined], "INT").as("ids"),
          pgArray(new Float32Array([1.5, 2.5]), "REAL").as("floats"),
          pgArray(["ok", "happy"], "mood").as("moods"),
        ]).compile();
        expect(compiled.sql).toContain("$1");
        expect(compiled.parameters).toHaveLength(6);
        const [object, jsonNull, payloads, ids, floats, moods] = compiled.parameters;
        expect(object.constructor.name).toBe("SQLJSONParameter");
        expect(jsonNull.constructor.name).toBe("SQLJSONParameter");
        expect(object).toEqual(client.json({ id: 1 }));
        expect(jsonNull).toEqual(client.json(null));
        for (const parameter of [payloads, ids, floats, moods]) {
          expect(parameter.constructor.name).toBe("SQLArrayParameter");
        }
        expect(payloads).toEqual(client.array([{ id: 1 }, undefined, client.json([1, 2])], "JSONB"));
        expect(ids).toEqual(client.array([1, undefined], "INT"));
        expect(floats).toEqual(client.array(new Float32Array([1.5, 2.5]), "REAL"));
        expect(moods).toEqual(client.array(["ok", "happy"], "mood"));
        expect(reserve).not.toHaveBeenCalled();
        expect(unsafe).not.toHaveBeenCalled();
        console.log("postgres helpers compiled without connections");
      } finally {
        reserve.mockRestore();
        unsafe.mockRestore();
        await db.destroy();
        await client.close({ timeout: 0 });
      }
    `;
      const child = Bun.spawn([process.execPath, "--eval", script], {
        cwd: import.meta.dir,
        env: { ...process.env, DATABASE_URL: url },
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
        expect(stdout.trim()).toBe(
          "postgres helpers compiled without connections",
        );
      } finally {
        child.kill();
      }
    },
    10000,
  );
});

describe("public PostgreSQL array helper", () => {
  test("lets the server infer a type without mutating frozen input", () => {
    const input = Object.freeze(["red", "blue"]);
    expect(parameter(pgArray(input))).toEqual(bunSql.array([...input]));
    expect(input).toEqual(["red", "blue"]);
  });

  test.each(["mood", "INT", 1007])(
    "accepts type name or array OID %s",
    (type) => {
      expect(parameter(pgArray([1, null], type))).toEqual(
        bunSql.array([1, null], type),
      );
    },
  );

  test("normalizes top-level undefined elements to SQL NULL in the type", () => {
    const expression = pgArray([1, undefined], "INT");
    expectTypeOf(expression).toEqualTypeOf<RawBuilder<(number | null)[]>>();
    expectTypeOf(pgArray([undefined])).toEqualTypeOf<RawBuilder<null[]>>();
    expectTypeOf(pgArray([null])).toEqualTypeOf<RawBuilder<null[]>>();
    expect(parameter(expression)).toMatchObject({
      arrayType: "INT",
      serializedValues: '{"1",NULL}',
    });
  });

  test("preserves SQL dimensions", () => {
    const input = [
      [1, null],
      [2, 3],
    ];
    expect(parameter(pgArray(input, "INT"))).toEqual(
      bunSql.array(input, "INT"),
    );
  });

  test("supports floating-point and bigint typed arrays", () => {
    const floats = new Float32Array([1.5, 2.5]);
    const bigints = new BigInt64Array([1n, 9007199254740993n]);
    expect(parameter(pgArray(floats, "REAL"))).toEqual(
      bunSql.array(floats, "REAL"),
    );
    expect(parameter(pgArray(bigints, "BIGINT"))).toEqual(
      bunSql.array(bigints, "BIGINT"),
    );
    expectTypeOf(pgArray(floats)).toEqualTypeOf<RawBuilder<number[]>>();
    expectTypeOf(pgArray(bigints)).toEqualTypeOf<RawBuilder<bigint[]>>();
    expectTypeOf(pgArray(["red"])).toEqualTypeOf<RawBuilder<string[]>>();
  });
});
