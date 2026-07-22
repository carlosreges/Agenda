import { DatabasePromise, SqliteError, Transaction } from "@tursodatabase/database-common";
import { Database as NativeDB, EncryptionCipher as NativeEncryptionCipher } from "#index";
// Map string cipher names to native enum values (lazy to avoid errors if native module lacks encryption)
function getCipherValue(cipher) {
    if (!NativeEncryptionCipher) {
        throw new Error('Encryption is not supported in this build');
    }
    const cipherMap = {
        'aes128gcm': NativeEncryptionCipher.Aes128Gcm,
        'aes256gcm': NativeEncryptionCipher.Aes256Gcm,
        'aegis256': NativeEncryptionCipher.Aegis256,
        'aegis256x2': NativeEncryptionCipher.Aegis256x2,
        'aegis128l': NativeEncryptionCipher.Aegis128l,
        'aegis128x2': NativeEncryptionCipher.Aegis128x2,
        'aegis128x4': NativeEncryptionCipher.Aegis128x4,
    };
    return cipherMap[cipher];
}
class Database extends DatabasePromise {
    constructor(path, opts = {}) {
        const nativeOpts = { ...opts };
        if (opts.encryption) {
            nativeOpts.encryption = {
                cipher: getCipherValue(opts.encryption.cipher),
                hexkey: opts.encryption.hexkey,
            };
        }
        super(new NativeDB(path, nativeOpts));
    }
}
/**
 * Creates a new database connection asynchronously.
 *
 * @param {string} path - Path to the database file.
 * @param {Object} opts - Options for database behavior.
 * @returns {Promise<Database>} - A promise that resolves to a Database instance.
 */
async function connect(path, opts = {}) {
    const db = new Database(path, opts);
    await db.connect();
    return db;
}
export { connect, Database, SqliteError, Transaction };
