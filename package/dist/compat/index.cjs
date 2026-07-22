'use strict';

// src/error.ts
var DatabaseError = class _DatabaseError extends Error {
  constructor(message, code, rawCode, cause) {
    super(message);
    this.name = "DatabaseError";
    this.code = code;
    this.rawCode = rawCode;
    this.cause = cause;
    Object.setPrototypeOf(this, _DatabaseError.prototype);
  }
};
var TimeoutError = class _TimeoutError extends DatabaseError {
  constructor(message = "Query timed out", cause) {
    super(message, "TIMEOUT", void 0, cause);
    this.name = "TimeoutError";
    Object.setPrototypeOf(this, _TimeoutError.prototype);
  }
};

// src/protocol.ts
function toBase64(uint8) {
  return Buffer.from(uint8.buffer, uint8.byteOffset, uint8.byteLength).toString("base64");
}
function encodeValue(value) {
  if (value === null || value === void 0) {
    return { type: "null" };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Only finite numbers (not Infinity or NaN) can be passed as arguments");
    }
    if (Number.isSafeInteger(value)) {
      return { type: "integer", value: value.toString() };
    }
    return { type: "float", value };
  }
  if (typeof value === "bigint") {
    return { type: "integer", value: value.toString() };
  }
  if (typeof value === "boolean") {
    return { type: "integer", value: value ? "1" : "0" };
  }
  if (typeof value === "string") {
    return { type: "text", value };
  }
  if (value instanceof ArrayBuffer) {
    return { type: "blob", base64: toBase64(new Uint8Array(value)) };
  }
  if (value instanceof Uint8Array) {
    return { type: "blob", base64: toBase64(value) };
  }
  return { type: "text", value: String(value) };
}
function decodeValue(value, safeIntegers = false) {
  switch (value.type) {
    case "null":
      return null;
    case "integer":
      if (safeIntegers) {
        return BigInt(value.value);
      }
      return parseInt(value.value, 10);
    case "float":
      return value.value;
    case "text":
      return value.value;
    case "blob":
      if (value.base64 !== void 0 && value.base64 !== null) {
        let b64 = value.base64;
        while (b64.length % 4 !== 0) {
          b64 += "=";
        }
        const binaryString = atob(b64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        return Buffer.from(bytes);
      }
      return Buffer.alloc(0);
    default:
      return null;
  }
}
var ENCRYPTION_KEY_HEADER = "x-turso-encryption-key";
function buildHeaders(ctx) {
  const headers = {
    "Content-Type": "application/json"
  };
  if (ctx.authToken) {
    headers["Authorization"] = `Bearer ${ctx.authToken}`;
  }
  if (ctx.remoteEncryptionKey) {
    headers[ENCRYPTION_KEY_HEADER] = ctx.remoteEncryptionKey;
  }
  for (const [name, value] of Object.entries(ctx.requestHeaders ?? {})) {
    if (name.toLowerCase() === "host") {
      throw new DatabaseError("overwriting the 'Host' header is not supported");
    }
    headers[name] = value;
  }
  return headers;
}
function buildFetchOptions(ctx, body, signal) {
  return {
    method: "POST",
    headers: buildHeaders(ctx),
    body,
    signal
  };
}
function wrapAbortError(error) {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    throw new TimeoutError("Query timed out");
  }
  throw error;
}
async function executeCursor(ctx, request, signal) {
  let response;
  try {
    response = await fetch(`${ctx.url}/v3/cursor`, buildFetchOptions(ctx, JSON.stringify(request), signal));
  } catch (error) {
    wrapAbortError(error);
  }
  if (!response.ok) {
    let errorMessage = `HTTP error! status: ${response.status}`;
    try {
      const errorBody = await response.text();
      const errorData = JSON.parse(errorBody);
      if (errorData.message) {
        errorMessage = errorData.message;
      }
    } catch {
    }
    throw new DatabaseError(errorMessage);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new DatabaseError("No response body");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let cursorResponse;
  try {
    while (!cursorResponse) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          cursorResponse = JSON.parse(line);
          break;
        }
      }
    }
  } catch (error) {
    reader.releaseLock();
    wrapAbortError(error);
  }
  if (!cursorResponse) {
    reader.releaseLock();
    throw new DatabaseError("No cursor response received");
  }
  async function* parseEntries() {
    try {
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          yield JSON.parse(line);
        }
      }
      while (true) {
        let readResult;
        try {
          readResult = await reader.read();
        } catch (error) {
          wrapAbortError(error);
        }
        if (readResult.done) break;
        buffer += decoder.decode(readResult.value, { stream: true });
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) {
            yield JSON.parse(line);
          }
        }
      }
      if (buffer.trim()) {
        yield JSON.parse(buffer.trim());
      }
    } finally {
      reader.releaseLock();
    }
  }
  return { response: cursorResponse, entries: parseEntries() };
}
async function executePipeline(ctx, request, signal) {
  let response;
  try {
    response = await fetch(`${ctx.url}/v3/pipeline`, buildFetchOptions(ctx, JSON.stringify(request), signal));
  } catch (error) {
    wrapAbortError(error);
  }
  if (!response.ok) {
    throw new DatabaseError(`HTTP error! status: ${response.status}`);
  }
  return response.json();
}

// src/args.ts
function encodeSqlArgs(args = []) {
  let positionalArgs = [];
  let namedArgs = [];
  if (Array.isArray(args)) {
    positionalArgs = args.map(encodeValue);
  } else {
    const keys = Object.keys(args);
    const isNumericKeys = keys.length > 0 && keys.every((key) => /^\d+$/.test(key));
    if (isNumericKeys) {
      const sortedKeys = keys.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
      const maxIndex = parseInt(sortedKeys[sortedKeys.length - 1], 10);
      positionalArgs = new Array(maxIndex);
      for (const key of sortedKeys) {
        const index = parseInt(key, 10) - 1;
        positionalArgs[index] = encodeValue(args[key]);
      }
      for (let i = 0; i < positionalArgs.length; i++) {
        if (positionalArgs[i] === void 0) {
          positionalArgs[i] = { type: "null" };
        }
      }
    } else {
      namedArgs = Object.entries(args).map(([name, value]) => ({
        name,
        value: encodeValue(value)
      }));
    }
  }
  return { args: positionalArgs, namedArgs };
}

// src/session.ts
function normalizeBatchMode(mode) {
  switch (String(mode).toLowerCase()) {
    case "write":
      return "IMMEDIATE";
    case "read":
    case "deferred":
      return "DEFERRED";
    case "immediate":
      return "IMMEDIATE";
    case "exclusive":
      return "EXCLUSIVE";
    case "concurrent":
      return "CONCURRENT";
    default:
      return String(mode).toUpperCase();
  }
}
function normalizeUrl(url) {
  return url.replace(/^libsql:\/\//, "https://");
}
function isValidIdentifier(str) {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(str);
}
var Session = class _Session {
  constructor(config) {
    this.baton = null;
    // Cached autocommit status from the server's last `get_autocommit` answer.
    // A fresh connection is in autocommit (not in a transaction).
    this.autocommit = true;
    for (const name of Object.keys(config.requestHeaders ?? {})) {
      if (name.toLowerCase() === "host") {
        throw new DatabaseError("overwriting the 'Host' header is not supported");
      }
    }
    this.config = config;
    this.baseUrl = normalizeUrl(config.url);
  }
  httpContext(queryOptions) {
    let requestHeaders = this.config.requestHeaders;
    if (queryOptions?.requestHeaders) {
      requestHeaders = { ...requestHeaders, ...queryOptions.requestHeaders };
    }
    return {
      url: this.baseUrl,
      authToken: this.config.authToken,
      remoteEncryptionKey: this.config.remoteEncryptionKey,
      requestHeaders
    };
  }
  /**
   * Whether the connection is currently inside a transaction.
   *
   * Derived from the server's authoritative `get_autocommit` answer (the same
   * value as `sqlite3_get_autocommit()`), which we refresh on every pipeline
   * request. This is the only reliable signal: a non-null baton does NOT imply
   * a transaction — the server also keeps the stream open for stored SQL or
   * pragma side effects.
   */
  get inTransaction() {
    return !this.autocommit;
  }
  /**
   * Refresh the cached autocommit status from a pipeline response, reading the
   * answer to the `get_autocommit` request we append to every pipeline call.
   */
  updateAutocommit(response) {
    if (!response.results) {
      return;
    }
    for (const result of response.results) {
      if (result.type === "ok" && result.response?.type === "get_autocommit" && typeof result.response.is_autocommit === "boolean") {
        this.autocommit = result.response.is_autocommit;
        return;
      }
    }
  }
  createAbortSignal(queryOptions) {
    const timeout = queryOptions?.queryTimeout ?? this.config.defaultQueryTimeout;
    if (timeout != null && timeout > 0) {
      return AbortSignal.timeout(timeout);
    }
    return void 0;
  }
  /**
   * Describe a SQL statement to get its column metadata.
   * 
   * @param sql - The SQL statement to describe
   * @returns Promise resolving to the statement description
   */
  async describe(sql, queryOptions) {
    const request = {
      baton: this.baton,
      requests: [
        { type: "describe", sql },
        { type: "get_autocommit" }
      ]
    };
    let response;
    try {
      response = await executePipeline(this.httpContext(queryOptions), request, this.createAbortSignal(queryOptions));
    } catch (e) {
      this.baton = null;
      this.autocommit = true;
      throw e;
    }
    this.baton = response.baton;
    if (response.base_url) {
      this.baseUrl = response.base_url;
    }
    this.updateAutocommit(response);
    if (response.results && response.results[0]) {
      const result = response.results[0];
      if (result.type === "error") {
        throw new DatabaseError(result.error?.message || "Describe execution failed", result.error?.code);
      }
      if (result.response?.type === "describe" && result.response.result) {
        return result.response.result;
      }
    }
    throw new DatabaseError("Unexpected describe response");
  }
  /**
   * Execute a SQL statement and return all results.
   *
   * @param sql - The SQL statement to execute
   * @param args - Optional array of parameter values or object with named parameters
   * @param safeIntegers - Whether to return integers as BigInt
   * @returns Promise resolving to the complete result set
   */
  async execute(sql, args = [], safeIntegers = false, queryOptions) {
    const { response, entries } = await this.executeRaw(sql, args, queryOptions);
    const result = await this.processCursorEntries(entries, safeIntegers);
    return result;
  }
  /**
   * A trailing batch step gated on `is_autocommit`, appended to every cursor
   * request. The cursor endpoint cannot carry a `get_autocommit` probe, so
   * whether this step executed tells us the connection's transaction state
   * without an extra round trip.
   */
  static autocommitProbeStep() {
    return {
      stmt: { sql: "SELECT 1", args: [], named_args: [], want_rows: false },
      condition: { type: "is_autocommit" }
    };
  }
  /**
   * Filter the probe step's entries out of a cursor stream and update the
   * cached transaction state from whether the probe executed. The probe is
   * always the last step, so everything after its step_begin belongs to it.
   *
   * If the stream ends abnormally (fatal error entry, a probe error, or the
   * consumer stops iterating early) the probe answer is unreliable, so the
   * state is refreshed with a fallback pipeline request instead.
   */
  async *trackAutocommit(entries, probeIdx, queryOptions) {
    let sawProbe = false;
    let unreliable = false;
    let completed = false;
    try {
      for await (const entry of entries) {
        if (entry.type === "step_begin" && entry.step === probeIdx) {
          sawProbe = true;
          continue;
        }
        if (sawProbe && (entry.type === "row" || entry.type === "step_end")) {
          continue;
        }
        if (entry.type === "error" || entry.type === "step_error" && entry.step === probeIdx) {
          unreliable = true;
          if (entry.type === "step_error") {
            continue;
          }
        }
        yield entry;
      }
      completed = true;
    } finally {
      if (completed && !unreliable) {
        this.autocommit = sawProbe;
      } else {
        await this.refreshAutocommit(queryOptions);
      }
    }
  }
  /**
   * Execute a SQL statement and return the raw response and entries.
   *
   * @param sql - The SQL statement to execute
   * @param args - Optional array of parameter values or object with named parameters
   * @returns Promise resolving to the raw response and cursor entries
   */
  async executeRaw(sql, args = [], queryOptions) {
    const encodedArgs = encodeSqlArgs(args);
    const request = {
      baton: this.baton,
      batch: {
        steps: [{
          stmt: {
            sql,
            args: encodedArgs.args,
            named_args: encodedArgs.namedArgs,
            want_rows: true
          }
        }, _Session.autocommitProbeStep()]
      }
    };
    let result;
    try {
      result = await executeCursor(this.httpContext(queryOptions), request, this.createAbortSignal(queryOptions));
    } catch (e) {
      this.baton = null;
      this.autocommit = true;
      throw e;
    }
    const { response, entries } = result;
    this.baton = response.baton;
    if (response.base_url) {
      this.baseUrl = response.base_url;
    }
    return { response, entries: this.trackAutocommit(entries, 1, queryOptions) };
  }
  /**
   * Refresh the cached transaction state with a standalone `get_autocommit`
   * pipeline request. Errors are not rethrown — this runs from generator
   * cleanup where an exception would mask the original failure; a dead stream
   * means the server rolled back, so the state resets to autocommit instead.
   */
  async refreshAutocommit(queryOptions) {
    const request = {
      baton: this.baton,
      requests: [{ type: "get_autocommit" }]
    };
    let response;
    try {
      response = await executePipeline(this.httpContext(), request, this.createAbortSignal(queryOptions));
    } catch {
      this.baton = null;
      this.autocommit = true;
      return;
    }
    this.baton = response.baton;
    if (response.base_url) {
      this.baseUrl = response.base_url;
    }
    this.updateAutocommit(response);
  }
  /**
   * Process cursor entries into a structured result.
   *
   * @param entries - Async generator of cursor entries
   * @returns Promise resolving to the processed result
   */
  async processCursorEntries(entries, safeIntegers = false) {
    let columns = [];
    let columnTypes = [];
    let rows = [];
    let rowsAffected = 0;
    let lastInsertRowid;
    for await (const entry of entries) {
      switch (entry.type) {
        case "step_begin":
          if (entry.cols) {
            columns = entry.cols.map((col) => col.name);
            columnTypes = entry.cols.map((col) => col.decltype || "");
          }
          break;
        case "row":
          if (entry.row) {
            const decodedRow = entry.row.map((value) => decodeValue(value, safeIntegers));
            const rowObject = this.createRowObject(decodedRow, columns);
            rows.push(rowObject);
          }
          break;
        case "step_end":
          if (entry.affected_row_count !== void 0) {
            rowsAffected = entry.affected_row_count;
          }
          if (entry.last_insert_rowid !== void 0 && entry.last_insert_rowid !== null) {
            lastInsertRowid = typeof entry.last_insert_rowid === "number" ? entry.last_insert_rowid : parseInt(entry.last_insert_rowid, 10);
          }
          break;
        case "step_error":
        case "error":
          throw new DatabaseError(entry.error?.message || "SQL execution failed", entry.error?.code);
      }
    }
    return {
      columns,
      columnTypes,
      rows,
      rowsAffected,
      lastInsertRowid
    };
  }
  /**
   * Create a row object with both array and named property access.
   * 
   * @param values - Array of column values
   * @param columns - Array of column names
   * @returns Row object with dual access patterns
   */
  createRowObject(values, columns) {
    const row = [...values];
    columns.forEach((column, index) => {
      if (column && isValidIdentifier(column)) {
        Object.defineProperty(row, column, {
          value: values[index],
          enumerable: false,
          writable: false,
          configurable: true
        });
      }
    });
    return row;
  }
  createObjectRow(values, columns) {
    const row = {};
    columns.forEach((column, index) => {
      row[column] = values[index];
    });
    return row;
  }
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
  async batch(statements, mode, queryOptions, safeIntegers = false, raw = false) {
    const userSteps = statements.map((statement) => {
      if (typeof statement === "string") {
        return {
          stmt: { sql: statement, args: [], named_args: [], want_rows: true }
        };
      }
      const encodedArgs = encodeSqlArgs(statement.args ?? []);
      return {
        stmt: {
          sql: statement.sql,
          args: encodedArgs.args,
          named_args: encodedArgs.namedArgs,
          want_rows: true
        }
      };
    });
    let steps;
    let firstUserStepIdx = 0;
    let lastUserStepIdx = userSteps.length - 1;
    let beginIdx = -1;
    let commitIdx = -1;
    let rollbackIdx = -1;
    if (mode === void 0) {
      steps = userSteps;
    } else {
      beginIdx = 0;
      firstUserStepIdx = 1;
      lastUserStepIdx = userSteps.length;
      commitIdx = lastUserStepIdx + 1;
      rollbackIdx = commitIdx + 1;
      steps = [
        { stmt: { sql: `BEGIN ${normalizeBatchMode(mode)}`, args: [], named_args: [], want_rows: false } },
        ...userSteps.map((step, i) => ({
          ...step,
          condition: { type: "ok", step: i === 0 ? beginIdx : firstUserStepIdx + i - 1 }
        })),
        {
          stmt: { sql: "COMMIT", args: [], named_args: [], want_rows: false },
          condition: { type: "ok", step: lastUserStepIdx }
        },
        {
          stmt: { sql: "ROLLBACK", args: [], named_args: [], want_rows: false },
          condition: {
            type: "and",
            conds: [
              { type: "ok", step: beginIdx },
              { type: "not", cond: { type: "ok", step: commitIdx } }
            ]
          }
        }
      ];
    }
    const probeIdx = steps.length;
    const request = {
      baton: this.baton,
      batch: { steps: [...steps, _Session.autocommitProbeStep()] }
    };
    let batchResult;
    try {
      batchResult = await executeCursor(this.httpContext(queryOptions), request, this.createAbortSignal(queryOptions));
    } catch (e) {
      this.baton = null;
      this.autocommit = true;
      throw e;
    }
    const { response, entries } = batchResult;
    this.baton = response.baton;
    if (response.base_url) {
      this.baseUrl = response.base_url;
    }
    const results = userSteps.map(() => ({
      columns: [],
      columnTypes: [],
      rows: [],
      rowsAffected: 0
    }));
    let deferredError = null;
    let currentResultIdx;
    let nextNonAtomicIdx = 0;
    const stepToResultIdx = (step) => {
      if (mode === void 0) {
        return step ?? nextNonAtomicIdx;
      }
      if (step !== void 0 && step >= firstUserStepIdx && step <= lastUserStepIdx) {
        return step - firstUserStepIdx;
      }
      return void 0;
    };
    for await (const entry of this.trackAutocommit(entries, probeIdx, queryOptions)) {
      if (deferredError !== null && entry.type !== "error") {
        continue;
      }
      switch (entry.type) {
        case "step_begin":
          currentResultIdx = stepToResultIdx(entry.step);
          if (currentResultIdx !== void 0 && currentResultIdx < results.length && entry.cols) {
            results[currentResultIdx].columns = entry.cols.map((col) => col.name);
            results[currentResultIdx].columnTypes = entry.cols.map((col) => col.decltype || "");
          }
          break;
        case "row":
          if (currentResultIdx !== void 0 && currentResultIdx < results.length && entry.row) {
            const decodedRow = entry.row.map((value) => decodeValue(value, safeIntegers));
            const row = raw ? decodedRow : this.createObjectRow(decodedRow, results[currentResultIdx].columns);
            results[currentResultIdx].rows.push(row);
          }
          break;
        case "step_end": {
          let idx = currentResultIdx;
          if (idx === void 0 && mode === void 0) {
            idx = nextNonAtomicIdx;
          }
          if (idx !== void 0 && idx < results.length) {
            if (entry.affected_row_count !== void 0) {
              results[idx].rowsAffected = results[idx].columns.length > 0 ? 0 : entry.affected_row_count;
            }
          }
          if (mode === void 0 && idx !== void 0) {
            nextNonAtomicIdx = idx + 1;
          }
          currentResultIdx = void 0;
          break;
        }
        case "step_error":
          if (deferredError === null && entry.step !== rollbackIdx) {
            deferredError = new DatabaseError(entry.error?.message || "Batch execution failed", entry.error?.code);
          }
          currentResultIdx = void 0;
          break;
        case "error":
          throw new DatabaseError(entry.error?.message || "Batch execution failed", entry.error?.code);
      }
    }
    if (deferredError !== null) {
      throw deferredError;
    }
    return results;
  }
  /**
   * Execute a sequence of SQL statements separated by semicolons.
   * 
   * @param sql - SQL string containing multiple statements separated by semicolons
   * @returns Promise resolving when all statements are executed
   */
  async sequence(sql, queryOptions) {
    const request = {
      baton: this.baton,
      requests: [
        { type: "sequence", sql },
        { type: "get_autocommit" }
      ]
    };
    let seqResponse;
    try {
      seqResponse = await executePipeline(this.httpContext(queryOptions), request, this.createAbortSignal(queryOptions));
    } catch (e) {
      this.baton = null;
      this.autocommit = true;
      throw e;
    }
    this.baton = seqResponse.baton;
    if (seqResponse.base_url) {
      this.baseUrl = seqResponse.base_url;
    }
    this.updateAutocommit(seqResponse);
    if (seqResponse.results && seqResponse.results[0]) {
      const result = seqResponse.results[0];
      if (result.type === "error") {
        throw new DatabaseError(result.error?.message || "Sequence execution failed", result.error?.code);
      }
    }
  }
  /**
   * Close the session.
   *
   * This sends a close request to the server to properly clean up the stream
   * before resetting the local state.
   */
  async close() {
    if (this.baton) {
      try {
        const request = {
          baton: this.baton,
          requests: [{
            type: "close"
          }]
        };
        await executePipeline(this.httpContext(), request);
      } catch {
      }
    }
    this.baton = null;
    this.baseUrl = "";
    this.autocommit = true;
  }
};

// src/async-lock.ts
var AsyncLock = class {
  constructor() {
    this.locked = false;
    this.queue = [];
  }
  async acquire() {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }
  release() {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
};

// src/compat.ts
var LibsqlError = class extends Error {
  constructor(message, code, extendedCode, rawCode, cause) {
    super(message);
    this.name = "LibsqlError";
    this.code = code;
    this.extendedCode = extendedCode;
    this.rawCode = rawCode;
    this.cause = cause;
  }
};
var LibSQLClient = class {
  constructor(config) {
    this.execLock = new AsyncLock();
    this._closed = false;
    this._defaultSafeIntegers = false;
    this.validateConfig(config);
    const sessionConfig = {
      url: config.url,
      authToken: config.authToken || "",
      remoteEncryptionKey: config.remoteEncryptionKey
    };
    this.sessionConfig = sessionConfig;
    this.session = new Session(sessionConfig);
  }
  validateConfig(config) {
    const unsupportedOptions = [];
    if (config.encryptionKey !== void 0) {
      unsupportedOptions.push({ key: "encryptionKey", value: config.encryptionKey });
    }
    if (config.syncUrl !== void 0) {
      unsupportedOptions.push({ key: "syncUrl", value: config.syncUrl });
    }
    if (config.syncInterval !== void 0) {
      unsupportedOptions.push({ key: "syncInterval", value: config.syncInterval });
    }
    if (config.readYourWrites !== void 0) {
      unsupportedOptions.push({ key: "readYourWrites", value: config.readYourWrites });
    }
    if (config.offline !== void 0) {
      unsupportedOptions.push({ key: "offline", value: config.offline });
    }
    if (config.tls !== void 0) {
      unsupportedOptions.push({ key: "tls", value: config.tls });
    }
    if (config.intMode !== void 0) {
      unsupportedOptions.push({ key: "intMode", value: config.intMode });
    }
    if (config.fetch !== void 0) {
      unsupportedOptions.push({ key: "fetch", value: config.fetch });
    }
    if (config.concurrency !== void 0) {
      unsupportedOptions.push({ key: "concurrency", value: config.concurrency });
    }
    if (unsupportedOptions.length > 0) {
      const optionsList = unsupportedOptions.map((opt) => `'${opt.key}'`).join(", ");
      throw new LibsqlError(
        `Unsupported configuration options: ${optionsList}. Only 'url', 'authToken', and 'remoteEncryptionKey' are supported in the serverless compatibility layer.`,
        "UNSUPPORTED_CONFIG"
      );
    }
    if (!config.url) {
      throw new LibsqlError("Missing required 'url' configuration option", "MISSING_URL");
    }
  }
  get closed() {
    return this._closed;
  }
  get protocol() {
    return "http";
  }
  normalizeStatement(stmt) {
    if (typeof stmt === "string") {
      return { sql: stmt, args: [] };
    }
    const args = stmt.args || [];
    if (Array.isArray(args)) {
      return { sql: stmt.sql, args };
    }
    return { sql: stmt.sql, args: Object.values(args) };
  }
  convertResult(result) {
    const resultSet = {
      columns: result.columns || [],
      columnTypes: result.columnTypes || [],
      rows: result.rows || [],
      rowsAffected: result.rowsAffected || 0,
      lastInsertRowid: result.lastInsertRowid != null ? BigInt(result.lastInsertRowid) : void 0,
      toJSON() {
        return {
          columns: this.columns,
          columnTypes: this.columnTypes,
          rows: this.rows,
          rowsAffected: this.rowsAffected,
          lastInsertRowid: this.lastInsertRowid?.toString()
        };
      }
    };
    return resultSet;
  }
  convertBatchResult(result) {
    return {
      columns: result.columns || [],
      columnTypes: result.columnTypes || [],
      rows: result.rows || [],
      rowsAffected: result.rowsAffected || 0
    };
  }
  normalizeBatchOptions(options) {
    if (options != null && typeof options === "object") {
      return {
        mode: options.mode,
        raw: options.raw === true
      };
    }
    return {
      mode: options,
      raw: false
    };
  }
  async execute(stmtOrSql, args) {
    await this.execLock.acquire();
    try {
      if (this._closed) {
        throw new LibsqlError("Client is closed", "CLIENT_CLOSED");
      }
      let normalizedStmt;
      if (typeof stmtOrSql === "string") {
        const normalizedArgs = args ? Array.isArray(args) ? args : Object.values(args) : [];
        normalizedStmt = { sql: stmtOrSql, args: normalizedArgs };
      } else {
        normalizedStmt = this.normalizeStatement(stmtOrSql);
      }
      const result = await this.session.execute(normalizedStmt.sql, normalizedStmt.args, this._defaultSafeIntegers);
      return this.convertResult(result);
    } catch (error) {
      if (error instanceof LibsqlError) {
        throw error;
      }
      throw mapDatabaseError(error, "EXECUTE_ERROR");
    } finally {
      this.execLock.release();
    }
  }
  async batch(stmts, options) {
    await this.execLock.acquire();
    try {
      if (this._closed) {
        throw new LibsqlError("Client is closed", "CLIENT_CLOSED");
      }
      if (!Array.isArray(stmts)) {
        throw new TypeError("Expected first argument to be an array of statements");
      }
      const { mode, raw } = this.normalizeBatchOptions(options);
      const batchMode = mode ?? "deferred";
      const results = await this.session.batch(
        stmts,
        batchMode,
        void 0,
        this._defaultSafeIntegers,
        raw
      );
      return results.map((result) => this.convertBatchResult(result));
    } catch (error) {
      if (error instanceof LibsqlError) {
        throw error;
      }
      throw mapDatabaseError(error, "BATCH_ERROR");
    } finally {
      this.execLock.release();
    }
  }
  async migrate(stmts) {
    return this.batch(stmts, "write");
  }
  modeToBeginSql(mode) {
    switch (mode) {
      case "write":
        return "BEGIN IMMEDIATE";
      case "deferred":
        return "BEGIN DEFERRED";
      case "read":
      default:
        return "BEGIN";
    }
  }
  async transaction(mode) {
    await this.execLock.acquire();
    if (this._closed) {
      this.execLock.release();
      throw new LibsqlError("Client is closed", "CLIENT_CLOSED");
    }
    const txSession = new Session(this.sessionConfig);
    let txClosed = false;
    let cleanupStarted = false;
    const ensureOpen = () => {
      if (txClosed) {
        throw new LibsqlError("Transaction is closed", "TRANSACTION_CLOSED");
      }
    };
    const closeTx = async () => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      txClosed = true;
      try {
        await txSession.close();
      } finally {
        this.execLock.release();
      }
    };
    const executeInTx = async (stmt) => {
      ensureOpen();
      const normalized = this.normalizeStatement(stmt);
      try {
        const result = await txSession.execute(normalized.sql, normalized.args, this._defaultSafeIntegers);
        return this.convertResult(result);
      } catch (error) {
        throw mapDatabaseError(error, "EXECUTE_ERROR");
      }
    };
    try {
      await txSession.sequence(this.modeToBeginSql(mode));
    } catch (error) {
      await closeTx();
      throw mapDatabaseError(error, "BEGIN_ERROR");
    }
    return {
      execute: async (stmtOrSql, args) => {
        if (typeof stmtOrSql === "string") {
          const normalizedArgs = args ? Array.isArray(args) ? args : Object.values(args) : [];
          return executeInTx({ sql: stmtOrSql, args: normalizedArgs });
        }
        return executeInTx(stmtOrSql);
      },
      batch: async (stmts) => {
        ensureOpen();
        if (!Array.isArray(stmts)) {
          throw new TypeError("Expected first argument to be an array of statements");
        }
        try {
          const results = await txSession.batch(
            stmts,
            void 0,
            void 0,
            this._defaultSafeIntegers
          );
          return results.map((result) => this.convertBatchResult(result));
        } catch (error) {
          throw mapDatabaseError(error, "BATCH_ERROR");
        }
      },
      executeMultiple: async (sql) => {
        ensureOpen();
        try {
          await txSession.sequence(sql);
        } catch (error) {
          throw mapDatabaseError(error, "EXECUTE_MULTIPLE_ERROR");
        }
      },
      commit: async () => {
        ensureOpen();
        try {
          await txSession.sequence("COMMIT");
        } catch (error) {
          throw mapDatabaseError(error, "COMMIT_ERROR");
        } finally {
          await closeTx();
        }
      },
      rollback: async () => {
        ensureOpen();
        try {
          await txSession.sequence("ROLLBACK");
        } catch (error) {
          throw mapDatabaseError(error, "ROLLBACK_ERROR");
        } finally {
          await closeTx();
        }
      },
      close: () => {
        if (txClosed) return;
        txClosed = true;
        void txSession.sequence("ROLLBACK").catch(() => void 0).finally(() => {
          void closeTx();
        });
      },
      get closed() {
        return txClosed;
      }
    };
  }
  async executeMultiple(sql) {
    await this.execLock.acquire();
    try {
      if (this._closed) {
        throw new LibsqlError("Client is closed", "CLIENT_CLOSED");
      }
      await this.session.sequence(sql);
    } catch (error) {
      if (error instanceof LibsqlError) {
        throw error;
      }
      throw mapDatabaseError(error, "EXECUTE_MULTIPLE_ERROR");
    } finally {
      this.execLock.release();
    }
  }
  async sync() {
    throw new LibsqlError("Sync not supported for remote databases", "NOT_SUPPORTED");
  }
  close() {
    this._closed = true;
    this.session.close().catch((error) => {
      console.error("Error closing session:", error);
    });
  }
};
function createClient(config) {
  return new LibSQLClient(config);
}
var sqliteBaseErrorCodes = /* @__PURE__ */ new Set([
  "SQLITE_ERROR",
  "SQLITE_INTERNAL",
  "SQLITE_PERM",
  "SQLITE_ABORT",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_NOMEM",
  "SQLITE_READONLY",
  "SQLITE_INTERRUPT",
  "SQLITE_IOERR",
  "SQLITE_CORRUPT",
  "SQLITE_NOTFOUND",
  "SQLITE_FULL",
  "SQLITE_CANTOPEN",
  "SQLITE_PROTOCOL",
  "SQLITE_EMPTY",
  "SQLITE_SCHEMA",
  "SQLITE_TOOBIG",
  "SQLITE_CONSTRAINT",
  "SQLITE_MISMATCH",
  "SQLITE_MISUSE",
  "SQLITE_NOLFS",
  "SQLITE_AUTH",
  "SQLITE_FORMAT",
  "SQLITE_RANGE",
  "SQLITE_NOTADB",
  "SQLITE_NOTICE",
  "SQLITE_WARNING"
]);
function parseErrorCode(serverCode) {
  if (sqliteBaseErrorCodes.has(serverCode)) {
    return { code: serverCode };
  }
  for (const base of sqliteBaseErrorCodes) {
    if (serverCode.startsWith(base + "_")) {
      return { code: base, extendedCode: serverCode };
    }
  }
  return { code: serverCode };
}
function mapDatabaseError(error, fallbackCode) {
  if (error instanceof DatabaseError && error.code) {
    const { code, extendedCode } = parseErrorCode(error.code);
    return new LibsqlError(error.message, code, extendedCode, error.rawCode, error);
  }
  const cause = error instanceof Error ? error : void 0;
  return new LibsqlError(error.message ?? String(error), fallbackCode, void 0, void 0, cause);
}

exports.LibsqlError = LibsqlError;
exports.createClient = createClient;
