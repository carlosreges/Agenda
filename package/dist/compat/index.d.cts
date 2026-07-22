/**
 * Configuration options for creating a libSQL-compatible client.
 *
 * @remarks
 * This interface matches the libSQL client configuration. The `url`, `authToken`, and
 * `remoteEncryptionKey` options are supported in the serverless compatibility layer.
 * Other options will throw validation errors.
 */
interface Config {
    /** Database URL (required) */
    url: string;
    /** Authentication token for the database */
    authToken?: string;
    /** @deprecated Local database encryption key - not supported in serverless mode */
    encryptionKey?: string;
    /**
     * Encryption key for the remote database (base64 encoded)
     * to enable access to encrypted Turso Cloud databases.
     */
    remoteEncryptionKey?: string;
    /** @deprecated Sync server URL - not supported in serverless mode */
    syncUrl?: string;
    /** @deprecated Sync frequency in seconds - not supported in serverless mode */
    syncInterval?: number;
    /** @deprecated Consistency mode - not supported in serverless mode */
    readYourWrites?: boolean;
    /** @deprecated Offline mode support - not supported in serverless mode */
    offline?: boolean;
    /** @deprecated TLS settings - not supported in serverless mode */
    tls?: boolean;
    /** @deprecated Integer handling mode - not supported in serverless mode */
    intMode?: "number" | "bigint" | "string";
    /** @deprecated Custom fetch implementation - not supported in serverless mode */
    fetch?: Function;
    /** @deprecated Concurrent request limit - not supported in serverless mode */
    concurrency?: number;
}
/** Input value types accepted by libSQL statements */
type InValue = null | string | number | bigint | ArrayBuffer | boolean | Uint8Array | Date;
/** Input arguments - either positional array or named object */
type InArgs = Array<InValue> | Record<string, InValue>;
/** Input statement - either SQL string or object with sql and args */
type InStatement = {
    sql: string;
    args?: InArgs;
} | string;
/** Transaction execution modes */
type TransactionMode = "write" | "read" | "deferred" | "immediate" | "exclusive" | "concurrent" | string;
interface BatchOptions {
    mode?: TransactionMode;
    raw?: boolean;
}
type BatchRow = Record<string, InValue> | Array<InValue>;
/**
 * A result row that can be accessed both as an array and as an object.
 * Supports both numeric indexing (row[0]) and column name access (row.column_name).
 */
interface Row {
    length: number;
    [index: number]: InValue;
    [name: string]: InValue;
}
/**
 * Result set returned from SQL statement execution.
 */
interface ResultSet {
    /** Column names in the result set */
    columns: Array<string>;
    /** Column type information */
    columnTypes: Array<string>;
    /** Result rows */
    rows: Array<Row>;
    /** Number of rows affected by the statement */
    rowsAffected: number;
    /** ID of the last inserted row (for INSERT statements) */
    lastInsertRowid: bigint | undefined;
    /** Convert result set to JSON */
    toJSON(): any;
}
/**
 * Result set returned by batch().
 */
interface BatchResultSet {
    /** Column names in the result set */
    columns: Array<string>;
    /** Column type information */
    columnTypes: Array<string>;
    /** Result rows */
    rows: Array<BatchRow>;
    /** Number of rows affected by the statement */
    rowsAffected: number;
}
/**
 * libSQL-compatible error class with error codes.
 */
declare class LibsqlError extends Error {
    /** Machine-readable error code (e.g., "SQLITE_CONSTRAINT") */
    code: string;
    /** Extended error code with more specific information (e.g., "SQLITE_CONSTRAINT_PRIMARYKEY") */
    extendedCode?: string;
    /** Raw numeric error code (if available) */
    rawCode?: number;
    /** Original error that caused this error */
    cause?: Error;
    constructor(message: string, code: string, extendedCode?: string, rawCode?: number, cause?: Error);
}
/**
 * Interactive transaction interface.
 *
 * @remarks
 * A transaction keeps a dedicated session open until commit/rollback/close.
 */
interface Transaction {
    execute(stmt: InStatement): Promise<ResultSet>;
    batch(stmts: Array<InStatement>): Promise<Array<BatchResultSet>>;
    executeMultiple(sql: string): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    close(): void;
    closed: boolean;
}
/**
 * libSQL-compatible client interface.
 *
 * This interface matches the standard libSQL client API for drop-in compatibility.
 * Some methods are not implemented in the serverless compatibility layer.
 */
interface Client {
    execute(stmt: InStatement): Promise<ResultSet>;
    execute(sql: string, args?: InArgs): Promise<ResultSet>;
    batch(stmts: Array<InStatement>, options?: TransactionMode | BatchOptions): Promise<Array<BatchResultSet>>;
    migrate(stmts: Array<InStatement>): Promise<Array<BatchResultSet>>;
    transaction(mode?: TransactionMode): Promise<Transaction>;
    executeMultiple(sql: string): Promise<void>;
    sync(): Promise<any>;
    close(): void;
    closed: boolean;
    protocol: string;
}
/**
 * Create a libSQL-compatible client for Turso database access.
 *
 * This function provides compatibility with the standard libSQL client API
 * while using the Turso serverless driver under the hood.
 *
 * @param config - Configuration object (only url and authToken are supported)
 * @returns A Client instance compatible with libSQL API
 * @throws LibsqlError if unsupported configuration options are provided
 *
 * @example
 * ```typescript
 * import { createClient } from "@tursodatabase/serverless/compat";
 *
 * const client = createClient({
 *   url: process.env.TURSO_DATABASE_URL,
 *   authToken: process.env.TURSO_AUTH_TOKEN
 * });
 *
 * const result = await client.execute("SELECT * FROM users");
 * console.log(result.rows);
 * ```
 */
declare function createClient(config: Config): Client;

export { type BatchOptions, type BatchResultSet, type BatchRow, type Client, type Config, type InArgs, type InStatement, type InValue, LibsqlError, type ResultSet, type Row, type Transaction, type TransactionMode, createClient };
