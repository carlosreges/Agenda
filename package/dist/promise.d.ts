import { DatabasePromise, SqliteError, DatabaseOpts, Transaction } from "@tursodatabase/database-common";
declare class Database extends DatabasePromise {
    constructor(path: string, opts?: DatabaseOpts);
}
/**
 * Creates a new database connection asynchronously.
 *
 * @param {string} path - Path to the database file.
 * @param {Object} opts - Options for database behavior.
 * @returns {Promise<Database>} - A promise that resolves to a Database instance.
 */
declare function connect(path: string, opts?: DatabaseOpts): Promise<Database>;
export { connect, Database, SqliteError, Transaction };
//# sourceMappingURL=promise.d.ts.map