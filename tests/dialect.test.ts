import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Kysely, sql, type Generated } from "kysely";
import { BunDialect, jsonbArray } from "../src/index";

// Define our test database schema
interface TestDatabase {
  person: {
    id: Generated<number>;
    first_name: string;
    last_name: string | null;
    created_at: Generated<Date>;
    tags?: string[];
    number_tags?: number[];
    nullable_string_tags?: (string | null)[];
    metadata?: TestItem[];
  };
}

// Define a simple object structure for testing
interface TestItem {
  type: string;
  value: number;
  active: boolean;
  label?: string;
  items?: SubItem[];
}

// Define sub-item structure for testing
interface SubItem {
  category: string;
  start_position: number;
  end_position: number;
  location: string;
  description: string;
}

describe("Bun PostgreSQL Dialect with Kysely", () => {
  let db: Kysely<TestDatabase>;

  beforeAll(async () => {
    db = new Kysely<TestDatabase>({
      dialect: new BunDialect({
        url:
          process.env["DATABASE_URL"] ?? "postgres://admin@localhost:5434/test",
      }),
    });
  });

  afterAll(async () => {
    // await db.destroy();
  });

  test("should insert and select a person", async () => {
    // Insert a person
    const insertResult = await db
      .insertInto("person")
      .values({
        first_name: "John",
        last_name: "Doe",
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(insertResult.first_name).toBe("John");
    expect(insertResult.last_name).toBe("Doe");
    expect(insertResult.id).toBeGreaterThan(0);
    expect(insertResult.created_at).toBeInstanceOf(Date);

    // Select the person
    const person = await db
      .selectFrom("person")
      .selectAll()
      .where("id", "=", insertResult.id)
      .executeTakeFirst();

    expect(person).toEqual(insertResult);
  });

  test("should update a person", async () => {
    // Insert test data
    const inserted = await db
      .insertInto("person")
      .values({
        first_name: "Jane",
        last_name: "Smith",
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Update the person
    const updated = await db
      .updateTable("person")
      .set({
        last_name: "Doe",
      })
      .where("id", "=", inserted.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(updated.first_name).toBe("Jane");
    expect(updated.last_name).toBe("Doe");
    expect(updated.id).toBe(inserted.id);
  });

  test("should delete a person", async () => {
    // Use a transaction to ensure all queries happen in the same connection
    await db.transaction().execute(async (trx) => {
      // Insert a person
      const inserted = await trx
        .insertInto("person")
        .values({
          first_name: "Bob",
          last_name: "Wilson",
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // Verify the person exists
      const verifyInsert = await trx
        .selectFrom("person")
        .selectAll()
        .where("id", "=", inserted.id)
        .executeTakeFirst();

      expect(verifyInsert).toBeDefined();

      // Delete the person
      const deleted = await trx
        .deleteFrom("person")
        .where("id", "=", inserted.id)
        .returningAll()
        .executeTakeFirstOrThrow();

      expect(deleted).toEqual(inserted);
    });

    // Verify person is deleted
    const person = await db
      .selectFrom("person")
      .selectAll()
      .where("first_name", "=", "Bob")
      .executeTakeFirst();

    expect(person).toBeUndefined();
  });

  test("should handle transactions", async () => {
    await db.transaction().execute(async (trx) => {
      // Insert within transaction
      const inserted = await trx
        .insertInto("person")
        .values({
          first_name: "Transaction",
          last_name: "Test",
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // Update within same transaction
      const updated = await trx
        .updateTable("person")
        .set({ last_name: "Success" })
        .where("id", "=", inserted.id)
        .returningAll()
        .executeTakeFirstOrThrow();

      expect(updated.last_name).toBe("Success");
    });
  });

  test("should rollback failed transactions", async () => {
    const firstName = "Rollback";

    try {
      await db.transaction().execute(async (trx) => {
        // Insert a person
        await trx
          .insertInto("person")
          .values({
            first_name: firstName,
            last_name: "Test",
          })
          .execute();

        // This will fail and cause a rollback
        await trx
          .selectFrom("person")
          .select(sql`error::text`.as("error"))
          .execute();
      });
    } catch (error: unknown) {
      // Expected to fail
      expect(error).toBeDefined();
    }

    // Verify the insert was rolled back
    const person = await db
      .selectFrom("person")
      .selectAll()
      .where("first_name", "=", firstName)
      .executeTakeFirst();

    expect(person).toBeUndefined();
  });

  test("should insert and select string array", async () => {
    // Test data for string array
    const testTags = ["javascript", "typescript", "database", "kysely"];

    // Insert a record with string array
    const insertResult = await db
      .insertInto("person")
      .values({
        first_name: "Array",
        last_name: "Test",
        tags: testTags,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Verify the array was inserted correctly
    expect(insertResult.first_name).toBe("Array");
    expect(insertResult.last_name).toBe("Test");
    expect(insertResult.tags).toEqual(testTags);
    expect(Array.isArray(insertResult.tags)).toBe(true);

    // Select the record and verify the array
    const person = await db
      .selectFrom("person")
      .selectAll()
      .where("id", "=", insertResult.id)
      .executeTakeFirst();

    expect(person).toBeDefined();
    expect(person!.tags).toEqual(testTags);
    expect(person!.tags!.length).toBe(testTags.length);
    expect(person!.tags![0]).toBe("javascript");
    expect(person!.tags![3]).toBe("kysely");
  });

  test("should insert and select number array", async () => {
    const testNumbers = [1, 2, 3, 100];

    const insertResult = await db
      .insertInto("person")
      .values({
        first_name: "NumberArray",
        last_name: "Test",
        number_tags: testNumbers,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(Array.from(insertResult.number_tags!)).toEqual(testNumbers);

    const person = await db
      .selectFrom("person")
      .selectAll()
      .where("id", "=", insertResult.id)
      .executeTakeFirst();

    expect(person).toBeDefined();
    expect(Array.from(person!.number_tags!)).toEqual(testNumbers);
  });

  test("should insert and select array with null values", async () => {
    const testTags = ["one", null, "three"];

    const insertResult = await db
      .insertInto("person")
      .values({
        first_name: "NullableArray",
        last_name: "Test",
        nullable_string_tags: testTags,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(insertResult.nullable_string_tags).toEqual(testTags);

    const person = await db
      .selectFrom("person")
      .selectAll()
      .where("id", "=", insertResult.id)
      .executeTakeFirst();

    expect(person).toBeDefined();
    expect(person!.nullable_string_tags).toEqual(testTags);
  });

  test("should insert and select an empty array", async () => {
    const testTags: string[] = [];

    const insertResult = await db
      .insertInto("person")
      .values({
        first_name: "EmptyArray",
        last_name: "Test",
        tags: testTags,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(insertResult.tags).toEqual(testTags);

    const person = await db
      .selectFrom("person")
      .selectAll()
      .where("id", "=", insertResult.id)
      .executeTakeFirst();

    expect(person).toBeDefined();
    expect(person!.tags).toEqual(testTags);
  });

  test("should insert and select a simple object", async () => {
    const testMetadata: TestItem = {
      type: "sample",
      value: 42,
      active: true,
      label: "test item",
    };

    const insertResult = await db
      .insertInto("person")
      .values({
        first_name: "Object",
        last_name: "Test",
        metadata: jsonbArray([testMetadata]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(insertResult.metadata).toEqual([testMetadata]);

    const person = await db
      .selectFrom("person")
      .selectAll()
      .where("id", "=", insertResult.id)
      .executeTakeFirst();

    expect(person).toBeDefined();
    expect(person!.metadata).toEqual([testMetadata]);
  });

  test("should insert and select object without optional fields", async () => {
    const testMetadata: Omit<TestItem, "label"> = {
      type: "minimal",
      value: 100,
      active: false,
    };

    const insertResult = await db
      .insertInto("person")
      .values({
        first_name: "Minimal",
        last_name: "Object",
        metadata: jsonbArray([testMetadata]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(insertResult.metadata).toEqual([testMetadata]);

    const person = await db
      .selectFrom("person")
      .selectAll()
      .where("id", "=", insertResult.id)
      .executeTakeFirst();

    expect(person).toBeDefined();
    expect(person!.metadata).toEqual([testMetadata]);
  });

  test("should insert and select object with nested array", async () => {
    // Create test object with nested array of items
    const testMetadata: TestItem = {
      type: "resource",
      value: 1,
      active: true,
      label: "Test resource",
      items: [
        {
          category: "PRIMARY",
          start_position: 32400,
          end_position: 36000,
          location: "Room A",
          description: "First group",
        },
        {
          category: "SECONDARY",
          start_position: 32400,
          end_position: 36000,
          location: "Room A",
          description: "Second group",
        },
        {
          category: "TERTIARY",
          start_position: 32400,
          end_position: 36000,
          location: "Room A",
          description: "Third group",
        },
      ],
    };

    // Save object with nested array in metadata field (JSONB[] type)
    const insertResult = await db
      .insertInto("person")
      .values({
        first_name: "JSONB",
        last_name: "NestedArray",
        metadata: jsonbArray([testMetadata]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Verify that this is an array of objects
    expect(Array.isArray(insertResult.metadata)).toBe(true);
    expect(insertResult.metadata).toEqual([testMetadata]);

    // Select the record and verify
    const person = await db
      .selectFrom("person")
      .selectAll()
      .where("id", "=", insertResult.id)
      .executeTakeFirst();

    // Verify that this is an array of objects with the correct structure
    expect(Array.isArray(person!.metadata)).toBe(true);
    expect(person!.metadata).toEqual([testMetadata]);
  });

  test("should insert and select empty array in JSONB column", async () => {
    const emptyArray: TestItem[] = [];

    const insertResult = await db
      .insertInto("person")
      .values({
        first_name: "EmptyJSONB",
        last_name: "Array",
        metadata: jsonbArray(emptyArray),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(Array.isArray(insertResult.metadata)).toBe(true);
    expect(insertResult.metadata).toEqual(emptyArray);

    const person = await db
      .selectFrom("person")
      .selectAll()
      .where("id", "=", insertResult.id)
      .executeTakeFirst();

    expect(person).toBeDefined();
    expect(Array.isArray(person!.metadata)).toBe(true);
    expect(person!.metadata).toEqual(emptyArray);
  });

  test("should handle empty nested array within object", async () => {
    const testMetadata: TestItem = {
      type: "resource",
      value: 2,
      active: false,
      items: [], // Empty array of items
    };

    const insertResult = await db
      .insertInto("person")
      .values({
        first_name: "EmptyNested",
        last_name: "Array",
        metadata: jsonbArray([testMetadata]),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(Array.isArray(insertResult.metadata)).toBe(true);
    expect(insertResult.metadata).toEqual([testMetadata]);
    expect(insertResult.metadata![0].items).toEqual([]);

    const person = await db
      .selectFrom("person")
      .selectAll()
      .where("id", "=", insertResult.id)
      .executeTakeFirst();

    expect(person).toBeDefined();
    expect(Array.isArray(person!.metadata)).toBe(true);
    expect(person!.metadata).toEqual([testMetadata]);
    expect(person!.metadata![0].items).toEqual([]);
  });
});
