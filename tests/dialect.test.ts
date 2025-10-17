import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Kysely, sql, type Generated } from "kysely";
import { BunDialect } from "../src/index";

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
    metadata?: TestItem;
    items?: TestItem[];
  };
}

// Define a simple object structure for testing
interface TestItem {
  type: string;
  value: number;
  active: boolean;
  label?: string;
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
    await db.destroy();
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
        metadata: testMetadata,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(insertResult.metadata).toEqual(testMetadata);

    const person = await db
      .selectFrom("person")
      .selectAll()
      .where("id", "=", insertResult.id)
      .executeTakeFirst();

    expect(person).toBeDefined();
    expect(person!.metadata).toEqual(testMetadata);
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
        metadata: testMetadata,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(insertResult.metadata).toEqual(testMetadata);

    const person = await db
      .selectFrom("person")
      .selectAll()
      .where("id", "=", insertResult.id)
      .executeTakeFirst();

    expect(person).toBeDefined();
    expect(person!.metadata).toEqual(testMetadata);
  });

  test("should insert and select array of objects", async () => {
    const testItems: TestItem[] = [
      {
        type: "alpha",
        value: 1,
        active: true,
        label: "first item",
      },
      {
        type: "beta",
        value: 2,
        active: false,
      },
      {
        type: "gamma",
        value: 3,
        active: true,
        label: "third item",
      },
    ];

    const insertResult = await db
      .insertInto("person")
      .values({
        first_name: "Array",
        last_name: "Objects",
        items: testItems,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(insertResult.items).toEqual(testItems);
    expect(Array.isArray(insertResult.items)).toBe(true);
    expect(insertResult.items!.length).toBe(3);

    const person = await db
      .selectFrom("person")
      .selectAll()
      .where("id", "=", insertResult.id)
      .executeTakeFirst();

    expect(person).toBeDefined();
    expect(person!.items).toEqual(testItems);
    expect(person!.items![0].type).toBe("alpha");
    expect(person!.items![1].active).toBe(false);
    expect(person!.items![2].value).toBe(3);
  });

  test("should insert and select empty array of objects", async () => {
    const testItems: TestItem[] = [];

    const insertResult = await db
      .insertInto("person")
      .values({
        first_name: "Empty",
        last_name: "Objects",
        items: testItems,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(insertResult.items).toEqual(testItems);
    expect(Array.isArray(insertResult.items)).toBe(true);
    expect(insertResult.items!.length).toBe(0);

    const person = await db
      .selectFrom("person")
      .selectAll()
      .where("id", "=", insertResult.id)
      .executeTakeFirst();

    expect(person).toBeDefined();
    expect(person!.items).toEqual(testItems);
  });

  test("should insert and select mixed array with objects and primitives", async () => {
    const testArray = [
      "string_value",
      42,
      true,
      { type: "nested", value: 99 },
      null,
    ] as const;

    const insertResult = await db
      .insertInto("person")
      .values({
        first_name: "Mixed",
        last_name: "Array",
        tags: testArray as unknown as string[],
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Mixed arrays should be handled correctly
    expect(insertResult.tags).toBeDefined();
    expect(Array.isArray(insertResult.tags)).toBe(true);

    const person = await db
      .selectFrom("person")
      .selectAll()
      .where("id", "=", insertResult.id)
      .executeTakeFirst();

    expect(person).toBeDefined();
    expect(person!.tags).toBeDefined();
  });
});
