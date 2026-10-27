import { expect, test } from "bun:test";
import { CompiledQuery } from "kysely";
import { BunConnection } from "../../src/connection";
import { createFakeReservedSQL } from "./fake-reserved-sql";

const columns = [
  { name: "ints", type: 1007, table: 0 },
  { name: "reals", type: 1021, table: 0 },
];

test("numeric arrays are ordinary arrays without configuration", async () => {
  const row = Object.freeze({
    ints: new Int32Array([1, 2]),
    reals: new Float32Array([1.5, 2.5]),
  });
  const fake = createFakeReservedSQL({ rows: [row], columns });
  const connection = new BunConnection(fake.reserved);
  const result = await connection.executeQuery<{
    ints: number[];
    reals: number[];
  }>(CompiledQuery.raw("select"));
  expect(Array.isArray(result.rows[0]!.ints)).toBe(true);
  expect(Array.isArray(result.rows[0]!.reals)).toBe(true);
  expect(result.rows[0]!.ints).toEqual([1, 2]);
  expect(result.rows[0]!.reals).toEqual([1.5, 2.5]);
  expect(result.rows[0]).not.toBe(row);
  expect(row.ints).toBeInstanceOf(Int32Array);
  expect(row.reals).toBeInstanceOf(Float32Array);
});

test("numeric normalization copies only changed rows and preserves other values", async () => {
  const json = { nested: [1, 2], typed: new Int32Array([3, 4]) };
  const bytes = Buffer.from([1, 2]);
  const bigints = [1n, 2n];
  const row = Object.freeze({
    ints: new Int32Array([1, 2]),
    reals: new Float32Array([0.1, 2.5]),
    json,
    bytes,
    bigints,
    moods: "{ok,happy}",
  });
  const unchanged = Object.freeze({
    ints: [1, null],
    reals: null,
    json,
    bytes,
    bigints,
    moods: "{}",
  });
  const fake = createFakeReservedSQL({
    rows: [row, unchanged],
    columns: [
      ...columns,
      { name: "json", type: 3802, table: 0 },
      { name: "bytes", type: 17, table: 0 },
      { name: "bigints", type: 1016, table: 0 },
      { name: "moods", type: 99999, table: 0 },
    ],
  });
  const result = await new BunConnection(fake.reserved).executeQuery<
    Record<string, unknown>
  >(CompiledQuery.raw("select"));
  const normalized = result.rows[0]!;
  expect(normalized).not.toBe(row);
  expect(Array.isArray(normalized["ints"])).toBe(true);
  expect(normalized["ints"]).toEqual([1, 2]);
  expect(normalized["reals"]).toEqual([Math.fround(0.1), 2.5]);
  expect(Array.isArray(normalized["reals"])).toBe(true);
  expect(normalized["json"]).toBe(json);
  expect(normalized["bytes"]).toBe(bytes);
  expect(normalized["bigints"]).toBe(bigints);
  expect(normalized["moods"]).toBe(row.moods);
  expect(row.ints).toBeInstanceOf(Int32Array);
  expect(row.reals).toBeInstanceOf(Float32Array);
  expect(result.rows[1]).toBe(unchanged);
});

test.each([{ metadata: undefined }, { metadata: null }, { metadata: [] }])(
  "numeric normalization preserves values when metadata is absent (%j)",
  async ({ metadata }) => {
    const row = { ints: new Int32Array([1, 2]) };
    const fake = createFakeReservedSQL({ rows: [row], columns: metadata });
    const result = await new BunConnection(fake.reserved).executeQuery(
      CompiledQuery.raw("select"),
    );
    expect(result.rows[0]).toBe(row);
  },
);

test("numeric normalization requires matching column OIDs and actual value types", async () => {
  const row = {
    bytes: new Int32Array([1, 2]),
    json: new Float32Array([1.5]),
    wrong_ints: new Float32Array([1.5]),
    wrong_reals: new Int32Array([1]),
    ints: [1, null, 3],
    reals: [[1.5], [2.5]],
    text: "{1,2}",
    nil: null,
    unknown: new Int32Array([3]),
  };
  const fake = createFakeReservedSQL({
    rows: [row],
    columns: [
      { name: "bytes", type: 17, table: 0 },
      { name: "json", type: 3802, table: 0 },
      { name: "wrong_ints", type: 1007, table: 0 },
      { name: "wrong_reals", type: 1021, table: 0 },
      ...columns,
      { name: "text", type: 25, table: 0 },
      { name: "nil", type: 1007, table: 0 },
      { name: "unknown", type: 99999, table: 0 },
    ],
  });
  const result = await new BunConnection(fake.reserved).executeQuery(
    CompiledQuery.raw("select"),
  );
  expect(result.rows[0]).toBe(row);
});

test.each([17, 1021, 1007])(
  "duplicate names use the last column OID (%i)",
  async (type) => {
    const row = { ints: new Int32Array([1, 2]) };
    const metadata = [columns[0]!, { name: "ints", type, table: 0 }];
    const fake = createFakeReservedSQL({ rows: [row], columns: metadata });
    const result = await new BunConnection(fake.reserved).executeQuery<
      typeof row
    >(CompiledQuery.raw("select"));
    expect(Array.isArray(result.rows[0]!.ints)).toBe(type === 1007);
    if (type !== 1007) expect(result.rows[0]).toBe(row);
    expect(metadata[1]!.type).toBe(type);
  },
);

test("numeric normalization does not read inherited or absent row properties", async () => {
  const row = Object.create({ ints: new Int32Array([1, 2]) });
  const fake = createFakeReservedSQL({ rows: [row], columns });
  const result = await new BunConnection(fake.reserved).executeQuery(
    CompiledQuery.raw("select"),
  );
  expect(result.rows[0]).toBe(row);
  expect(Object.hasOwn(row, "ints")).toBe(false);
});

test("numeric normalization accepts empty results with column metadata", async () => {
  const fake = createFakeReservedSQL({ columns });
  expect(
    await new BunConnection(fake.reserved).executeQuery(
      CompiledQuery.raw("select"),
    ),
  ).toEqual({ rows: [] });
});
