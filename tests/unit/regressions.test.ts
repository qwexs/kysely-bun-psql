import { describe, expect, test } from "bun:test";
import { CompiledQuery } from "kysely";
import { BunConnection, jsonb } from "../../src/index";

import { createFakeReservedSQL } from "./fake-reserved-sql";

describe("runtime regressions", () => {
  test("preserves native array parameters and their dimensions", async () => {
    const input = [
      [1, 2],
      [3, 4],
    ];
    const fake = createFakeReservedSQL();
    const connection = new BunConnection(fake.reserved);
    await connection.executeQuery(
      CompiledQuery.raw("select $1::int[][]", [input]),
    );
    expect(fake.calls[0]?.parameters[0]).toBe(input);
    expect(input).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  test("reports MERGE affected rows from the protocol count", async () => {
    const fake = createFakeReservedSQL({ command: "MERGE", count: 7 });
    const connection = new BunConnection(fake.reserved);
    const result = await connection.executeQuery(CompiledQuery.raw("merge"));
    expect(result).toStrictEqual({ rows: [], numAffectedRows: 7n });
  });

  test("honors read-only transaction access mode", async () => {
    const fake = createFakeReservedSQL();
    const connection = new BunConnection(fake.reserved);
    await connection.beginTransaction({ accessMode: "read only" });
    const sql = fake.calls.map((call) => call.sql).join("; ");
    expect(sql).toMatch(/\bread\s+only\b/i);
  });

  test("jsonb accepts frozen arrays without changing their JSON representation", () => {
    const input = Object.freeze([1, 2]);
    const expression = jsonb(input);
    const node = expression.toOperationNode();
    expect(node.kind).toBe("RawNode");
    expect(node.parameters).toHaveLength(1);
    expect(JSON.stringify(input)).toBe("[1,2]");
    expect(input).toEqual([1, 2]);
  });
});
