export type BunDialectConfig = {
    url: string;
    hostname?: string;
    port?: number;
    database?: string;
    username?: string;
    password?: string;
    max?: number;
    idleTimeout?: number;
    maxLifetime?: number;
    connectionTimeout?: number;
    tls?: boolean;
    onconnect?: (err: Error | null) => void;
    onclose?: (err: Error | null) => void;
};
