interface Value {
    type: 'null' | 'integer' | 'float' | 'text' | 'blob';
    value?: string | number;
    base64?: string;
}
interface Column {
    name: string;
    decltype: string;
}
interface DescribeResult {
    params: Array<{
        name?: string;
    }>;
    cols: Column[];
    is_explain: boolean;
    is_readonly: boolean;
}
declare function encodeValue(value: any): Value;
declare function decodeValue(value: Value, safeIntegers?: boolean): any;
interface CursorResponse {
    baton: string | null;
    base_url: string | null;
}
interface CursorEntry {
    type: 'step_begin' | 'step_end' | 'step_error' | 'row' | 'error';
    step?: number;
    cols?: Column[];
    row?: Value[];
    affected_row_count?: number;
    last_insert_rowid?: string | number;
    error?: {
        message: string;
        code: string;
    };
}
/** HTTP header key for the encryption key */
declare const ENCRYPTION_KEY_HEADER = "x-turso-encryption-key";
/** Per-query options. Override the session-level defaults for a single call. */
interface QueryOptions {
    /** Per-query timeout in milliseconds. Overrides defaultQueryTimeout for this call. */
    queryTimeout?: number;
    /**
     * Extra HTTP headers attached to this request only. Applied after the
     * standard headers and any session-level `requestHeaders`, so they can
     * override both. Passing the `Host` key (case-insensitive) throws —
     * fetch forbids setting it.
     */
    requestHeaders?: Record<string, string>;
}

/**
 * Locking mode for atomic `batch()` execution. Accepts the same values
 * as the variants of `Connection.transaction(...)`.
 */
type BatchMode = 'write' | 'read' | 'deferred' | 'immediate' | 'exclusive' | 'concurrent' | string;
/**
 * Configuration options for a session.
 */
interface SessionConfig {
    /** Database URL */
    url: string;
    /** Authentication token (optional for local development with turso dev) */
    authToken?: string;
    /**
     * Encryption key for the remote database (base64 encoded)
     * to enable access to encrypted Turso Cloud databases.
     */
    remoteEncryptionKey?: string;
    /** Default maximum query execution time in milliseconds before interruption. */
    defaultQueryTimeout?: number;
    /**
     * Extra HTTP headers attached to every request sent to the server.
     * Applied after the standard headers, so they can override e.g.
     * `Authorization`. Passing the `Host` key (case-insensitive) throws —
     * fetch forbids setting it.
     */
    requestHeaders?: Record<string, string>;
}
/**
 * A database session that manages the connection state and baton.
 *
 * Each session maintains its own connection state and can execute SQL statements
 * independently without interfering with other sessions.
 */
declare class Session {
    private config;
    private baton;
    private baseUrl;
    private autocommit;
    constructor(config: SessionConfig);
    private httpContext;
    /**
     * Whether the connection is currently inside a transaction.
     *
     * Derived from the server's authoritative `get_autocommit` answer (the same
     * value as `sqlite3_get_autocommit()`), which we refresh on every pipeline
     * request. This is the only reliable signal: a non-null baton does NOT imply
     * a transaction — the server also keeps the stream open for stored SQL or
     * pragma side effects.
     */
    get inTransaction(): boolean;
    /**
     * Refresh the cached autocommit status from a pipeline response, reading the
     * answer to the `get_autocommit` request we append to every pipeline call.
     */
    private updateAutocommit;
    private createAbortSignal;
    /**
     * Describe a SQL statement to get its column metadata.
     *
     * @param sql - The SQL statement to describe
     * @returns Promise resolving to the statement description
     */
    describe(sql: string, queryOptions?: QueryOptions): Promise<DescribeResult>;
    /**
     * Execute a SQL statement and return all results.
     *
     * @param sql - The SQL statement to execute
     * @param args - Optional array of parameter values or object with named parameters
     * @param safeIntegers - Whether to return integers as BigInt
     * @returns Promise resolving to the complete result set
     */
    execute(sql: string, args?: any[] | Record<string, any>, safeIntegers?: boolean, queryOptions?: QueryOptions): Promise<any>;
    /**
     * A trailing batch step gated on `is_autocommit`, appended to every cursor
     * request. The cursor endpoint cannot carry a `get_autocommit` probe, so
     * whether this step executed tells us the connection's transaction state
     * without an extra round trip.
     */
    private static autocommitProbeStep;
    /**
     * Filter the probe step's entries out of a cursor stream and update the
     * cached transaction state from whether the probe executed. The probe is
     * always the last step, so everything after its step_begin belongs to it.
     *
     * If the stream ends abnormally (fatal error entry, a probe error, or the
     * consumer stops iterating early) the probe answer is unreliable, so the
     * state is refreshed with a fallback pipeline request instead.
     */
    private trackAutocommit;
    /**
     * Execute a SQL statement and return the raw response and entries.
     *
     * @param sql - The SQL statement to execute
     * @param args - Optional array of parameter values or object with named parameters
     * @returns Promise resolving to the raw response and cursor entries
     */
    executeRaw(sql: string, args?: any[] | Record<string, any>, queryOptions?: QueryOptions): Promise<{
        response: CursorResponse;
        entries: AsyncGenerator<CursorEntry>;
    }>;
    /**
     * Refresh the cached transaction state with a standalone `get_autocommit`
     * pipeline request. Errors are not rethrown — this runs from generator
     * cleanup where an exception would mask the original failure; a dead stream
     * means the server rolled back, so the state resets to autocommit instead.
     */
    private refreshAutocommit;
    /**
     * Process cursor entries into a structured result.
     *
     * @param entries - Async generator of cursor entries
     * @returns Promise resolving to the processed result
     */
    processCursorEntries(entries: AsyncGenerator<CursorEntry>, safeIntegers?: boolean): Promise<any>;
    /**
     * Create a row object with both array and named property access.
     *
     * @param values - Array of column values
     * @param columns - Array of column names
     * @returns Row object with dual access patterns
     */
    createRowObject(values: any[], columns: string[]): any;
    createObjectRow(values: any[], columns: string[]): any;
    /**
     * Execute multiple SQL statements in a batch.
     *
     * When `mode` is set, the batch is sent as a single Hrana request that
     * also carries `BEGIN <mode>` / `COMMIT` / `ROLLBACK` steps using the
     * server-side condition chain, giving atomic execution in one round-trip.
     * When `mode` is omitted, the user statements are sent as-is and run
     * under autocommit (or whatever transaction is already active on this
     * stream).
     *
     * @param statements - Array of SQL statements to execute.
     * @param mode - Optional locking mode; when set, the batch executes
     *   atomically. Accepts the same values as `Database.transaction(...)`
     *   variants: `"deferred"`, `"immediate"`, `"exclusive"`, `"concurrent"`.
     * @param safeIntegers - When true, integer column values are decoded as
     *   BigInt rather than Number.
     * @returns Promise resolving to an array of per-statement results — one
     *   per input statement, in order — each carrying that statement's
     *   `columns`, `columnTypes`, `rows`, and `rowsAffected`.
     */
    batch(statements: Array<string | {
        sql: string;
        args?: any[] | Record<string, any>;
    }>, mode?: BatchMode, queryOptions?: QueryOptions, safeIntegers?: boolean, raw?: boolean): Promise<any>;
    /**
     * Execute a sequence of SQL statements separated by semicolons.
     *
     * @param sql - SQL string containing multiple statements separated by semicolons
     * @returns Promise resolving when all statements are executed
     */
    sequence(sql: string, queryOptions?: QueryOptions): Promise<void>;
    /**
     * Close the session.
     *
     * This sends a close request to the server to properly clean up the stream
     * before resetting the local state.
     */
    close(): Promise<void>;
}

declare class AsyncLock {
    private locked;
    private queue;
    acquire(): Promise<void>;
    release(): void;
}

/**
 * A prepared SQL statement that can be executed in multiple ways.
 *
 * Statements may either own a dedicated session or share a connection session to preserve transaction boundaries.
 * Provides three execution modes:
 * - `get(args?)`: Returns the first row or null
 * - `all(args?)`: Returns all rows as an array
 * - `iterate(args?)`: Returns an async iterator for streaming results
 */
declare class Statement {
    private session;
    private sql;
    private presentationMode;
    private safeIntegerMode;
    private columnMetadata;
    private execLock?;
    constructor(sessionConfig: SessionConfig, sql: string, columns?: Column[]);
    /**
     * Create a Statement that shares an existing session and serializes execution
     * through the given lock. Used by Connection.prepare() so prepared statements
     * participate in the connection's transaction scope.
     */
    static fromSession(session: Session, sql: string, columns: Column[] | undefined, execLock: AsyncLock): Statement;
    /**
     * Whether the prepared statement returns data.
     *
     * This is `true` for SELECT queries and statements with RETURNING clause,
     * and `false` for INSERT, UPDATE, DELETE statements without RETURNING.
     *
     * @example
     * ```typescript
     * const stmt = await conn.prepare(sql);
     * if (stmt.reader) {
     *   return stmt.all(args);  // SELECT-like query
     * } else {
     *   return stmt.run(args);  // INSERT/UPDATE/DELETE
     * }
     * ```
     */
    get reader(): boolean;
    /**
     * Enable raw mode to return arrays instead of objects.
     *
     * @param raw Enable or disable raw mode. If you don't pass the parameter, raw mode is enabled.
     * @returns This statement instance for chaining
     *
     * @example
     * ```typescript
     * const stmt = client.prepare("SELECT * FROM users WHERE id = ?");
     * const row = await stmt.raw().get([1]);
     * console.log(row); // [1, "Alice", "alice@example.org"]
     * ```
     */
    raw(raw?: boolean): Statement;
    /**
     * Enable pluck mode to return only the first column value from each row.
     *
     * @param pluck Enable or disable pluck mode. If you don't pass the parameter, pluck mode is enabled.
     * @returns This statement instance for chaining
     *
     * @example
     * ```typescript
     * const stmt = client.prepare("SELECT id FROM users");
     * const ids = await stmt.pluck().all();
     * console.log(ids); // [1, 2, 3, ...]
     * ```
     */
    pluck(pluck?: boolean): Statement;
    /**
     * Sets safe integers mode for this statement.
     *
     * @param toggle Whether to use safe integers. If you don't pass the parameter, safe integers mode is enabled.
     * @returns This statement instance for chaining
     */
    safeIntegers(toggle?: boolean): Statement;
    /**
     * Get column information for this statement.
     *
     * @returns Array of column metadata objects matching the native bindings format
     *
     * @example
     * ```typescript
     * const stmt = await client.prepare("SELECT id, name, email FROM users");
     * const columns = stmt.columns();
     * console.log(columns); // [{ name: 'id', type: 'INTEGER', column: null, database: null, table: null }, ...]
     * ```
     */
    columns(): any[];
    private withLock;
    /**
     * Executes the prepared statement.
     *
     * @param args - Optional array of parameter values or object with named parameters
     * @returns Promise resolving to the result of the statement
     *
     * @example
     * ```typescript
     * const stmt = client.prepare("INSERT INTO users (name, email) VALUES (?, ?)");
     * const result = await stmt.run(['John Doe', 'john.doe@example.com']);
     * console.log(`Inserted user with ID ${result.lastInsertRowid}`);
     * ```
     */
    run(args?: any, queryOptions?: QueryOptions): Promise<any>;
    /**
     * Execute the statement and return the first row.
     *
     * @param args - Optional array of parameter values or object with named parameters
     * @returns Promise resolving to the first row or undefined if no results
     *
     * @example
     * ```typescript
     * const stmt = client.prepare("SELECT * FROM users WHERE id = ?");
     * const user = await stmt.get([123]);
     * if (user) {
     *   console.log(user.name);
     * }
     * ```
     */
    get(args?: any, queryOptions?: QueryOptions): Promise<any>;
    /**
     * Execute the statement and return all rows.
     *
     * @param args - Optional array of parameter values or object with named parameters
     * @returns Promise resolving to an array of all result rows
     *
     * @example
     * ```typescript
     * const stmt = client.prepare("SELECT * FROM users WHERE active = ?");
     * const activeUsers = await stmt.all([true]);
     * console.log(`Found ${activeUsers.length} active users`);
     * ```
     */
    all(args?: any, queryOptions?: QueryOptions): Promise<any[]>;
    /**
     * Execute the statement and return an async iterator for streaming results.
     *
     * This method provides memory-efficient processing of large result sets
     * by streaming rows one at a time instead of loading everything into memory.
     *
     * @param args - Optional array of parameter values or object with named parameters
     * @returns AsyncGenerator that yields individual rows
     *
     * @example
     * ```typescript
     * const stmt = client.prepare("SELECT * FROM large_table WHERE category = ?");
     * for await (const row of stmt.iterate(['electronics'])) {
     *   // Process each row individually
     *   console.log(row.id, row.name);
     * }
     * ```
     */
    iterate(args?: any, queryOptions?: QueryOptions): AsyncGenerator<any>;
}

/**
 * Configuration options for connecting to a Turso database.
 */
interface Config extends SessionConfig {
}
type BatchStatement = string | {
    sql: string;
    args?: any[] | Record<string, any>;
};
interface BatchOptions {
    mode?: BatchMode;
    raw?: boolean;
}
/**
 * A connection to a Turso database.
 *
 * Provides methods for executing SQL statements and managing prepared statements.
 * Uses the SQL over HTTP protocol with streaming cursor support.
 *
 * ## Concurrency model
 *
 * A Connection is **single-stream**: it can only run one statement at a time.
 * This is not an implementation quirk — it follows from the SQL over HTTP protocol,
 * where each request carries a baton from the previous response to sequence operations
 * on the server. Concurrent calls on the same connection would race on that baton
 * and corrupt the stream. This is the same model as SQLite itself (one execution
 * at a time per connection).
 *
 * If you call `execute()` while another is in flight, the call automatically
 * waits for the previous one to finish — just like the native
 * `@tursodatabase/database` binding.
 *
 * ## Parallel queries
 *
 * For parallelism, create multiple connections. `connect()` is cheap — it just
 * allocates a config object. No TCP connection is opened until the first `execute()`,
 * and the underlying `fetch()` runtime automatically pools and reuses TCP/TLS
 * connections to the same origin.
 *
 * ```typescript
 * import { connect } from "@tursodatabase/serverless";
 *
 * const config = { url: process.env.TURSO_URL, authToken: process.env.TURSO_TOKEN };
 *
 * // Option 1: one connection per parallel query
 * const [users, orders] = await Promise.all([
 *   connect(config).execute("SELECT * FROM users WHERE active = 1"),
 *   connect(config).execute("SELECT * FROM orders WHERE status = 'pending'"),
 * ]);
 *
 * // Option 2: reusable pool for repeated parallel work
 * const pool = Array.from({ length: 4 }, () => connect(config));
 * const results = await Promise.all(
 *   queries.map((sql, i) => pool[i % pool.length].execute(sql))
 * );
 * ```
 */
declare class Connection {
    private config;
    private session;
    private isOpen;
    private defaultSafeIntegerMode;
    private execLock;
    constructor(config: Config);
    /**
     * Whether the database is currently in a transaction.
     *
     * Derived from the server's `get_autocommit` status (refreshed on every
     * request), so it reflects the connection's real transaction state — the
     * same as `sqlite3_get_autocommit()` on the native bindings — including
     * transactions opened with a raw `BEGIN`, not just via `transaction()`.
     */
    get inTransaction(): boolean;
    /**
     * Prepare a SQL statement for execution.
     *
     * Prepared statements created from a Connection use the same underlying session so transaction boundaries are preserved.
     * This method fetches column metadata using the describe functionality.
     *
     * @param sql - The SQL statement to prepare
     * @returns A Promise that resolves to a Statement object with column metadata
     *
     * @example
     * ```typescript
     * const stmt = await client.prepare("SELECT * FROM users WHERE id = ?");
     * const columns = stmt.columns();
     * const user = await stmt.get([123]);
     * ```
     */
    prepare(sql: string): Promise<Statement>;
    /**
     * Like `prepare(sql).run(args)` but in a single round trip — skips `describe`
     * since run() does not need column metadata.
     */
    run(sql: string, ...bindParameters: any[]): Promise<any>;
    /**
     * Like `prepare(sql).get(args)` but in a single round trip.
     */
    get(sql: string, ...bindParameters: any[]): Promise<any>;
    /**
     * Like `prepare(sql).all(args)` but in a single round trip.
     */
    all(sql: string, ...bindParameters: any[]): Promise<any[]>;
    /**
     * Like `prepare(sql).iterate(args)` but in a single round trip. Buffers the
     * result set — the connection lock cannot be held across `yield` points
     * without risking deadlock on nested calls.
     */
    iterate(sql: string, ...bindParameters: any[]): AsyncGenerator<any>;
    /**
     * Execute a SQL statement and return all results.
     *
     * @param sql - The SQL statement to execute
     * @param args - Optional array of parameter values
     * @returns Promise resolving to the complete result set
     *
     * @example
     * ```typescript
     * const result = await client.execute("SELECT * FROM users WHERE id = ?", [123]);
     * console.log(result.rows);
     * ```
     */
    execute(sql: string, args?: any[], queryOptions?: QueryOptions): Promise<any>;
    /**
     * Execute a SQL statement and return all results.
     *
     * @param sql - The SQL statement to execute
     * @returns Promise resolving to the complete result set
     *
     * @example
     * ```typescript
     * const result = await client.exec("SELECT * FROM users");
     * console.log(result.rows);
     * ```
     */
    exec(sql: string, queryOptions?: QueryOptions): Promise<any>;
    /**
     * Executes a batch of SQL statements over this connection.
     *
     * By default, batch() is not transactional: each statement runs in its
     * own autocommit step, so a failure mid-batch leaves earlier successful
     * statements committed. Pass a `mode` to make the batch atomic — the
     * statements are wrapped in `BEGIN <mode>` / `COMMIT` (with `ROLLBACK`
     * on failure) and dispatched as a single Hrana request, so the whole
     * batch completes in one round-trip. When called from inside a
     * `connection.transaction(...)` callback the `mode` argument is ignored
     * and the surrounding transaction is reused.
     *
     * When `mode` is set, `batch()` owns the surrounding
     * `BEGIN`/`COMMIT`/`ROLLBACK`, so the `statements` array must not
     * contain its own transaction-control SQL (`BEGIN`, `COMMIT`,
     * `ROLLBACK`, `SAVEPOINT`, `RELEASE`). The input is not validated
     * for that — a user-supplied `COMMIT` will close the wrapper
     * transaction mid-batch and leave earlier statements committed,
     * defeating the all-or-nothing contract.
     *
     * @param statements - An array of SQL strings or `{ sql, args }` objects.
     * @param mode - When set, makes the batch atomic. Accepts the same
     *   values as `connection.transaction(...)` variants: `"deferred"`,
     *   `"immediate"`, `"exclusive"`, `"concurrent"`. Ignored when already
     *   inside a transaction.
     * @returns An array of `ResultSet`s — one per input statement, in order —
     *   matching the libsql-js batch contract. Each `ResultSet` carries that
     *   statement's `columns`, `columnTypes`, `rows`, and `rowsAffected`.
     *
     * @example
     * // Plain SQL strings (non-atomic).
     * await db.batch([
     *   "INSERT INTO users(name) VALUES ('Alice')",
     *   "INSERT INTO users(name) VALUES ('Bob')",
     * ]);
     *
     * @example
     * // Positional and named bind parameters.
     * await db.batch([
     *   { sql: "INSERT INTO users(name, email) VALUES (?, ?)", args: ["Carol", "carol@example.net"] },
     *   { sql: "INSERT INTO users(name, email) VALUES (:name, :email)", args: { name: "Dave", email: "dave@example.net" } },
     * ]);
     *
     * @example
     * // Atomic via the mode parameter.
     * await db.batch([
     *   { sql: "INSERT INTO users(name) VALUES (?)", args: ["Eve"] },
     *   { sql: "INSERT INTO users(name) VALUES (?)", args: ["Frank"] },
     * ], "immediate");
     *
     * @example
     * // Atomic via the transaction() API for mixed workloads.
     * const txn = db.transaction(async () => {
     *   await db.batch([{ sql: "INSERT INTO users(name) VALUES (?)", args: ["Eve"] }]);
     *   await db.execute("UPDATE counters SET n = n + 1");
     * });
     * await txn.immediate();
     */
    batch(statements: BatchStatement[], options?: BatchMode | BatchOptions, queryOptions?: QueryOptions): Promise<any>;
    /**
     * Execute a pragma.
     *
     * @param pragma - The pragma to execute
     * @returns Promise resolving to the result of the pragma
     */
    pragma(pragma: string, queryOptions?: QueryOptions): Promise<any>;
    /**
     * Sets the default safe integers mode for all statements from this connection.
     *
     * @param toggle - Whether to use safe integers by default.
     */
    defaultSafeIntegers(toggle?: boolean): void;
    /**
     * Returns a function that executes the given function in a transaction.
     *
     * @param fn - The function to wrap in a transaction
     * @returns A function that will execute fn within a transaction
     *
     * @example
     * ```typescript
     * const insert = await client.prepare("INSERT INTO users (name) VALUES (?)");
     * const insertMany = client.transaction((users) => {
     *   for (const user of users) {
     *     insert.run([user]);
     *   }
     * });
     *
     * await insertMany(['Alice', 'Bob', 'Charlie']);
     * ```
     */
    transaction(fn: (...args: any[]) => any): any;
    /**
     * Close the connection.
     *
     * This sends a close request to the server to properly clean up the stream.
     */
    close(): Promise<void>;
    reconnect(): Promise<void>;
}
/**
 * Create a new connection to a Turso database.
 *
 * This is a lightweight operation — it only allocates a config object. No network
 * I/O happens until the first query. The underlying `fetch()` implementation
 * automatically pools TCP/TLS connections to the same origin, so creating many
 * connections is cheap.
 *
 * Each connection is single-stream: concurrent calls on the same connection are
 * automatically serialized. For true parallelism, create multiple connections:
 *
 * ```typescript
 * import { connect } from "@tursodatabase/serverless";
 *
 * const config = { url: process.env.TURSO_URL, authToken: process.env.TURSO_TOKEN };
 *
 * // Sequential (single connection is fine)
 * const conn = connect(config);
 * const a = await conn.execute("SELECT 1");
 * const b = await conn.execute("SELECT 2");
 *
 * // Parallel (use separate connections)
 * const [x, y] = await Promise.all([
 *   connect(config).execute("SELECT 1"),
 *   connect(config).execute("SELECT 2"),
 * ]);
 * ```
 *
 * @param config - Configuration object with database URL and auth token
 * @returns A new Connection instance
 */
declare function connect(config: Config): Connection;

declare class DatabaseError extends Error {
    /** Machine-readable error code (e.g., "SQLITE_CONSTRAINT") */
    code?: string;
    /** Raw numeric error code */
    rawCode?: number;
    /** Original error that caused this error */
    cause?: Error;
    constructor(message: string, code?: string, rawCode?: number, cause?: Error);
}
/**
 * Error thrown when a query exceeds the configured timeout.
 *
 * This is a subclass of `DatabaseError` with `code` set to `"TIMEOUT"`.
 * Catch this type to distinguish timeouts from other database errors
 * and decide whether to retry or fail gracefully.
 */
declare class TimeoutError extends DatabaseError {
    constructor(message?: string, cause?: Error);
}

export { type BatchOptions, type BatchStatement, type Column, type Config, Connection, DatabaseError, ENCRYPTION_KEY_HEADER, type QueryOptions, Session, type SessionConfig, Statement, TimeoutError, connect, decodeValue, encodeValue };
