import { expect, test } from "bun:test";
import { Kysely, sql } from "kysely";
import { BunDialect } from "../src/index";

interface ProbeDB {
  merge_probe: { id: number; payload: number[] };
  merge_input: { id: number; payload: number[] };
}

function database() {
  const url = process.env["DATABASE_URL"];
  if (!url)
    throw new Error("Set DATABASE_URL to a disposable PostgreSQL database");
  return new Kysely<ProbeDB>({ dialect: new BunDialect({ url, max: 1 }) });
}

test("two SET LOCAL statements in one parameterless transaction query", async () => {
  const db = database();
  try {
    await db.transaction().execute(async (trx) => {
      await sql`set local lock_timeout = '3s'; set local statement_timeout = '11s'`.execute(
        trx,
      );
      const { rows } =
        await sql`select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement`.execute(
          trx,
        );
      expect(rows).toEqual([{ lock: "3s", statement: "11s" }]);
    });
  } finally {
    await db.destroy();
  }
});

test("Kysely MERGE exposes numChangedRows and RETURNING normalizes integer[]", async () => {
  const db = database();
  try {
    await db.transaction().execute(async (trx) => {
      await sql`create temporary table merge_probe (id integer primary key, payload integer[])`.execute(
        trx,
      );
      await sql`create temporary table merge_input (id integer primary key, payload integer[])`.execute(
        trx,
      );
      await sql`insert into merge_input values (1, array[1, 2])`.execute(trx);
      const merge = trx
        .mergeInto("merge_probe")
        .using("merge_input", "merge_input.id", "merge_probe.id");
      const inserted = await merge
        .whenNotMatched()
        .thenInsertValues((eb) => ({
          id: eb.ref("merge_input.id"),
          payload: eb.ref("merge_input.payload"),
        }))
        .executeTakeFirstOrThrow();
      expect(inserted.numChangedRows).toBe(1n);
      const rows = await merge
        .whenMatched()
        .thenDelete()
        .returning(["merge_probe.id", "merge_probe.payload"])
        .execute();
      expect(Array.isArray(rows[0]?.payload)).toBe(true);
      expect(rows).toEqual([{ id: 1, payload: [1, 2] }]);
    });
  } finally {
    await db.destroy();
  }
});

test("cancel query stops an autocommit UPDATE before it persists", async () => {
  const db = database();
  const observer = database();
  const controller = new AbortController();
  try {
    await sql`create temporary table cancel_update_probe (value integer)`.execute(
      db,
    );
    await sql`insert into cancel_update_probe values (1)`.execute(db);
    const {
      rows: [session],
    } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
    const outcome =
      sql`update cancel_update_probe set value = 2 from pg_sleep(3)`
        .execute(db, {
          signal: controller.signal,
          inflightQueryAbortStrategy: "cancel query",
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
    const deadline = Date.now() + 2500;
    while (true) {
      const { rows } =
        await sql`select 1 from pg_stat_activity where pid = ${session!.pid} and state = 'active' and wait_event = 'PgSleep' and query like '%update cancel_update_probe%'`.execute(
          observer,
        );
      if (rows.length) break;
      if (Date.now() >= deadline)
        throw new Error("UPDATE did not enter pg_sleep");
      await Bun.sleep(10);
    }
    const reason = new Error("cancel UPDATE");
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    // max: 1 means this read waits for the cancelled SQL to release its reservation.
    expect(
      (await sql`select value from cancel_update_probe`.execute(db)).rows,
    ).toEqual([{ value: 1 }]);
  } finally {
    controller.abort();
    await Promise.all([observer.destroy(), db.destroy()]);
  }
});
