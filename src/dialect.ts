import {
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type QueryCompiler,
} from "kysely";

import { BunDriver } from "./driver.ts";
import type { BunDialectConfig } from "./types.ts";
import { freeze } from "./utils.ts";

export class BunDialect implements Dialect {
  readonly #config: BunDialectConfig;

  constructor(config: BunDialectConfig) {
    this.#config = freeze({ ...config });
  }

  createAdapter(): DialectAdapter {
    return new PostgresAdapter();
  }

  createDriver(): Driver {
    return new BunDriver(this.#config);
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new PostgresIntrospector(db);
  }

  createQueryCompiler(): QueryCompiler {
    return new PostgresQueryCompiler();
  }
}
