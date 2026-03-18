import type { Driver, TransactionSettings } from "kysely";
import { BunConnection } from "./connection";
import type { BunDialectConfig } from "./types";
export declare class BunDriver implements Driver {
    #private;
    constructor(config: BunDialectConfig);
    init(): Promise<void>;
    acquireConnection(): Promise<BunConnection>;
    beginTransaction(connection: BunConnection, settings: TransactionSettings): Promise<void>;
    commitTransaction(connection: BunConnection): Promise<void>;
    rollbackTransaction(connection: BunConnection): Promise<void>;
    releaseConnection(connection: BunConnection): Promise<void>;
    destroy(): Promise<void>;
}
