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
  };
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
    // Insert test data
    const inserted = await db
      .insertInto("person")
      .values({
        first_name: "Bob",
        last_name: "Wilson",
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Delete the person
    const deleted = await db
      .deleteFrom("person")
      .where("id", "=", inserted.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    expect(deleted).toEqual(inserted);

    // Verify person is deleted
    const person = await db
      .selectFrom("person")
      .selectAll()
      .where("id", "=", inserted.id)
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
});
