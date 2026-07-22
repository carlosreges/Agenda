import { DatabaseCompat, SqliteError, DatabaseOpts } from "@tursodatabase/database-common";
declare class Database extends DatabaseCompat {
    constructor(path: string, opts?: DatabaseOpts);
}
export { Database, SqliteError };
//# sourceMappingURL=compat.d.ts.map