export type BunDialectConfig = {
  // Required
  url: string;

  // Optional configuration
  hostname?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;

  // Connection pool settings
  max?: number; // Maximum connections in pool
  idleTimeout?: number; // Close idle connections after 30s
  maxLifetime?: number; // Connection lifetime in seconds (0 = forever)
  connectionTimeout?: number; // Timeout when establishing new connections

  // SSL/TLS options
  tls?: boolean;

  // Callbacks
  onconnect?: (err: Error | null) => void;
  onclose?: (err: Error | null) => void;
};
