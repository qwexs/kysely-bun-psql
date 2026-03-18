import { CompiledQuery, type DatabaseConnection, type QueryResult, type TransactionSettings } from "kysely";
import type { ReservedSQL } from "bun";
export declare class BunConnection implements DatabaseConnection {
    #private;
    constructor(reservedConnection: ReservedSQL);
    beginTransaction(settings: TransactionSettings): Promise<void>;
    commitTransaction(): Promise<void>;
    executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>>;
    releaseConnection(): void;
    rollbackTransaction(): Promise<void>;
    streamQuery<R>(): AsyncGenerator<QueryResult<R>>;
}
