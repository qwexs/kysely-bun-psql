import { expect, test } from "bun:test";
import { BunConnection, BunDriver } from "../../src/index";
import { createFakeReservedSQL } from "./fake-reserved-sql";

test.each(["BunConnection", "BunDriver"] as const)(
  "%s waits for the reserved client's deferred release",
  async (target) => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const fake = createFakeReservedSQL({
      release: async () => {
        entered.resolve();
        await finish.promise;
      },
    });
    const connection = new BunConnection(fake.reserved);
    // Bun opens no connection until a query or reserve() starts.
    // https://bun.com/docs/runtime/sql#connection-pooling
    const driver =
      target === "BunDriver"
        ? new BunDriver({ url: "postgres://unused:unused@127.0.0.1:1/unused" })
        : undefined;
    let completed = false;
    const releasing = (
      driver
        ? driver.releaseConnection(connection)
        : connection.releaseConnection()
    ).then(() => {
      completed = true;
    });

    try {
      await entered.promise;
      expect(fake.releases).toBe(1);
      expect(completed).toBe(false);

      finish.resolve();
      await releasing;
      expect(completed).toBe(true);
    } finally {
      finish.resolve();
      try {
        await releasing;
      } finally {
        await driver?.destroy();
      }
    }
  },
);
