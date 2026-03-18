import { type DatabaseIntrospector, type Dialect, type DialectAdapter, type Driver, type Kysely, type QueryCompiler } from "kysely";
import type { BunDialectConfig } from "./types";
export declare class BunDialect implements Dialect {
    #private;
    constructor(config: BunDialectConfig);
    createAdapter(): DialectAdapter;
    createDriver(): Driver;
    createIntrospector(db: Kysely<unknown>): DatabaseIntrospector;
    createQueryCompiler(): QueryCompiler;
}
