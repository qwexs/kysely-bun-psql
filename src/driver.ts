import type { Driver, TransactionSettings } from "kysely";
import { SQL } from "bun";
import { BunConnection } from "./connection";
import type { BunDialectConfig } from "./types";
import { freeze } from "./utils";

export class BunDriver implements Driver {
  readonly #config: BunDialectConfig;
  readonly #sql: SQL;

  constructor(config: BunDialectConfig) {
    this.#config = freeze({ ...config });
    this.#sql = new SQL({
      url: this.#config.url,
      hostname: this.#config.hostname,
      port: this.#config.port,
      database: this.#config.database,
      username: this.#config.username,
      password: this.#config.password,
      max: this.#config.max,
      idleTimeout: this.#config.idleTimeout,
      maxLifetime: this.#config.maxLifetime,
      connectionTimeout: this.#config.connectionTimeout,
      tls: this.#config.tls,
      onconnect: this.#config.onconnect,
      onclose: this.#config.onclose,
    });
  }

  async init(): Promise<void> {
    // noop
  }

  async acquireConnection(): Promise<BunConnection> {
    // For transaction safety, always use a reserved connection
    const reserved = await this.#sql.reserve();
    return new BunConnection(reserved);
  }

  async beginTransaction(
    connection: BunConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    await connection.beginTransaction(settings);
  }

  async commitTransaction(connection: BunConnection): Promise<void> {
    await connection.commitTransaction();
  }

  async rollbackTransaction(connection: BunConnection): Promise<void> {
    await connection.rollbackTransaction();
  }

  async releaseConnection(connection: BunConnection): Promise<void> {
    connection.releaseConnection();
  }

  async destroy(): Promise<void> {
    await this.#sql.close();
  }
}
