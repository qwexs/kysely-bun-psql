import { sql as bunSql } from "bun";
import { describe, expect, test } from "bun:test";
import { CompiledQuery } from "kysely";
import { BunConnection, jsonb } from "../../src/index";
import { transformValue } from "../../src/utils";
import { createFakeReservedSQL } from "./fake-reserved-sql";

describe("runtime regressions", () => {
  test("preserves dimensions of native SQL arrays", () => {
    const input = [
      [1, 2],
      [3, 4],
    ];
    expect(transformValue(input)).toEqual(bunSql.array(input));
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
