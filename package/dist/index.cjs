'use strict';

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
function normalizeArgs(args) {
  if (args === void 0) return [];
  if (Array.isArray(args)) return args;
  if (args !== null && typeof args === "object" && args.constructor === Object) {
    return args;
  }
  return [args];
}
function isQueryOptions(value) {
  return value != null && typeof value === "object" && !Array.isArray(value) && (Object.prototype.hasOwnProperty.call(value, "queryTimeout") || Object.prototype.hasOwnProperty.call(value, "requestHeaders"));
}
function splitBindParameters(bindParameters) {
  if (bindParameters.length === 0) {
    return { params: void 0, queryOptions: void 0 };
  }
  if (isQueryOptions(bindParameters[bindParameters.length - 1])) {
    if (bindParameters.length === 1) {
      return { params: void 0, queryOptions: bindParameters[0] };
    }
    return {
      params: bindParameters.length === 2 ? bindParameters[0] : bindParameters.slice(0, -1),
      queryOptions: bindParameters[bindParameters.length - 1]
    };
  }
  return {
    params: bindParameters.length === 1 ? bindParameters[0] : bindParameters,
    queryOptions: void 0
  };
}
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

// src/row.ts
function createExpandedRow(row, columns) {
  const expanded = {};
  columns.forEach((column, index) => {
    expanded[column] = row[index];
    Object.defineProperty(expanded, String(index), {
      value: row[index],
      enumerable: false,
      writable: true,
      configurable: true
    });
  });
  return expanded;
}

// src/statement.ts
var Statement = class _Statement {
  constructor(sessionConfig, sql, columns) {
    this.presentationMode = "expanded";
    this.safeIntegerMode = false;
    this.session = new Session(sessionConfig);
    this.sql = sql;
    this.columnMetadata = columns || [];
  }
  /**
   * Create a Statement that shares an existing session and serializes execution
   * through the given lock. Used by Connection.prepare() so prepared statements
   * participate in the connection's transaction scope.
   */
  static fromSession(session, sql, columns, execLock) {
    const stmt = Object.create(_Statement.prototype);
    stmt.session = session;
    stmt.sql = sql;
    stmt.columnMetadata = columns || [];
    stmt.presentationMode = "expanded";
    stmt.safeIntegerMode = false;
    stmt.execLock = execLock;
    return stmt;
  }
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
  get reader() {
    return this.columnMetadata.length > 0;
  }
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
  raw(raw) {
    this.presentationMode = raw === false ? "expanded" : "raw";
    return this;
  }
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
  pluck(pluck) {
    this.presentationMode = pluck === false ? "expanded" : "pluck";
    return this;
  }
  /**
   * Sets safe integers mode for this statement.
   * 
   * @param toggle Whether to use safe integers. If you don't pass the parameter, safe integers mode is enabled.
   * @returns This statement instance for chaining
   */
  safeIntegers(toggle) {
    this.safeIntegerMode = toggle === false ? false : true;
    return this;
  }
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
  columns() {
    return this.columnMetadata.map((col) => ({
      name: col.name,
      type: col.decltype
    }));
  }
  async withLock(fn) {
    if (!this.execLock) {
      return await fn();
    }
    await this.execLock.acquire();
    try {
      return await fn();
    } finally {
      this.execLock.release();
    }
  }
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
  async run(args, queryOptions) {
    return await this.withLock(async () => {
      const normalizedArgs = normalizeArgs(args);
      const result = await this.session.execute(this.sql, normalizedArgs, this.safeIntegerMode, queryOptions);
      return { changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
    });
  }
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
  async get(args, queryOptions) {
    return await this.withLock(async () => {
      const normalizedArgs = normalizeArgs(args);
      const result = await this.session.execute(this.sql, normalizedArgs, this.safeIntegerMode, queryOptions);
      const row = result.rows[0];
      if (!row) {
        return void 0;
      }
      if (this.presentationMode === "pluck") {
        return row[0];
      }
      if (this.presentationMode === "raw") {
        return [...row];
      }
      return createExpandedRow(row, result.columns);
    });
  }
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
  async all(args, queryOptions) {
    return await this.withLock(async () => {
      const normalizedArgs = normalizeArgs(args);
      const result = await this.session.execute(this.sql, normalizedArgs, this.safeIntegerMode, queryOptions);
      if (this.presentationMode === "pluck") {
        return result.rows.map((row) => row[0]);
      }
      if (this.presentationMode === "raw") {
        return result.rows.map((row) => [...row]);
      }
      return result.rows.map((row) => createExpandedRow(row, result.columns));
    });
  }
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
  async *iterate(args, queryOptions) {
    if (this.execLock) {
      const rows = await this.all(args, queryOptions);
      for (const row of rows) {
        yield row;
      }
      return;
    }
    const normalizedArgs = normalizeArgs(args);
    const { entries } = await this.session.executeRaw(this.sql, normalizedArgs, queryOptions);
    let columns = [];
    for await (const entry of entries) {
      switch (entry.type) {
        case "step_begin":
          if (entry.cols) {
            columns = entry.cols.map((col) => col.name);
          }
          break;
        case "row":
          if (entry.row) {
            const decodedRow = entry.row.map((value) => decodeValue(value, this.safeIntegerMode));
            if (this.presentationMode === "pluck") {
              yield decodedRow[0];
            } else if (this.presentationMode === "raw") {
              yield decodedRow;
            } else {
              yield createExpandedRow(decodedRow, columns);
            }
          }
          break;
        case "step_error":
        case "error":
          throw new DatabaseError(entry.error?.message || "SQL execution failed");
      }
    }
  }
};

// src/connection.ts
function normalizeBatchOptions(options) {
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
function toResultSet(result) {
  return {
    columns: result.columns ?? [],
    columnTypes: result.columnTypes ?? [],
    rows: result.rows ?? [],
    rowsAffected: result.rowsAffected ?? 0
  };
}
var Connection = class {
  constructor(config) {
    this.isOpen = true;
    this.defaultSafeIntegerMode = false;
    this.execLock = new AsyncLock();
    if (!config.url) {
      throw new Error("invalid config: url is required");
    }
    this.config = config;
    this.session = new Session(config);
    Object.defineProperty(this, "inTransaction", {
      get: () => this.session.inTransaction,
      enumerable: true
    });
  }
  /**
   * Whether the database is currently in a transaction.
   *
   * Derived from the server's `get_autocommit` status (refreshed on every
   * request), so it reflects the connection's real transaction state — the
   * same as `sqlite3_get_autocommit()` on the native bindings — including
   * transactions opened with a raw `BEGIN`, not just via `transaction()`.
   */
  get inTransaction() {
    return this.session.inTransaction;
  }
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
  async prepare(sql) {
    if (!this.isOpen) {
      throw new TypeError("The database connection is not open");
    }
    await this.execLock.acquire();
    let description;
    try {
      description = await this.session.describe(sql);
    } finally {
      this.execLock.release();
    }
    const stmt = Statement.fromSession(this.session, sql, description.cols, this.execLock);
    if (this.defaultSafeIntegerMode) {
      stmt.safeIntegers(true);
    }
    return stmt;
  }
  /**
   * Like `prepare(sql).run(args)` but in a single round trip — skips `describe`
   * since run() does not need column metadata.
   */
  async run(sql, ...bindParameters) {
    if (!this.isOpen) throw new TypeError("The database connection is not open");
    const { params, queryOptions } = splitBindParameters(bindParameters);
    await this.execLock.acquire();
    try {
      const result = await this.session.execute(sql, normalizeArgs(params), this.defaultSafeIntegerMode, queryOptions);
      return { changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
    } finally {
      this.execLock.release();
    }
  }
  /**
   * Like `prepare(sql).get(args)` but in a single round trip.
   */
  async get(sql, ...bindParameters) {
    if (!this.isOpen) throw new TypeError("The database connection is not open");
    const { params, queryOptions } = splitBindParameters(bindParameters);
    await this.execLock.acquire();
    try {
      const result = await this.session.execute(sql, normalizeArgs(params), this.defaultSafeIntegerMode, queryOptions);
      const row = result.rows[0];
      if (!row) return void 0;
      return createExpandedRow(row, result.columns);
    } finally {
      this.execLock.release();
    }
  }
  /**
   * Like `prepare(sql).all(args)` but in a single round trip.
   */
  async all(sql, ...bindParameters) {
    if (!this.isOpen) throw new TypeError("The database connection is not open");
    const { params, queryOptions } = splitBindParameters(bindParameters);
    await this.execLock.acquire();
    try {
      const result = await this.session.execute(sql, normalizeArgs(params), this.defaultSafeIntegerMode, queryOptions);
      return result.rows.map((row) => createExpandedRow(row, result.columns));
    } finally {
      this.execLock.release();
    }
  }
  /**
   * Like `prepare(sql).iterate(args)` but in a single round trip. Buffers the
   * result set — the connection lock cannot be held across `yield` points
   * without risking deadlock on nested calls.
   */
  async *iterate(sql, ...bindParameters) {
    for (const row of await this.all(sql, ...bindParameters)) yield row;
  }
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
  async execute(sql, args, queryOptions) {
    if (!this.isOpen) {
      throw new TypeError("The database connection is not open");
    }
    await this.execLock.acquire();
    try {
      return await this.session.execute(sql, args || [], this.defaultSafeIntegerMode, queryOptions);
    } finally {
      this.execLock.release();
    }
  }
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
  async exec(sql, queryOptions) {
    if (!this.isOpen) {
      throw new TypeError("The database connection is not open");
    }
    await this.execLock.acquire();
    try {
      return await this.session.sequence(sql, queryOptions);
    } finally {
      this.execLock.release();
    }
  }
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
  async batch(statements, options, queryOptions) {
    if (!Array.isArray(statements)) {
      throw new TypeError("Expected first argument to be an array of statements");
    }
    if (!this.isOpen) {
      throw new TypeError("The database connection is not open");
    }
    await this.execLock.acquire();
    try {
      const { mode, raw } = normalizeBatchOptions(options);
      const effectiveMode = this.session.inTransaction ? void 0 : mode;
      const results = await this.session.batch(
        statements,
        effectiveMode,
        queryOptions,
        this.defaultSafeIntegerMode,
        raw
      );
      return results.map((result) => toResultSet(result));
    } finally {
      this.execLock.release();
    }
  }
  /**
   * Execute a pragma.
   * 
   * @param pragma - The pragma to execute
   * @returns Promise resolving to the result of the pragma
   */
  async pragma(pragma, queryOptions) {
    if (!this.isOpen) {
      throw new TypeError("The database connection is not open");
    }
    await this.execLock.acquire();
    try {
      const sql = `PRAGMA ${pragma}`;
      return await this.session.execute(sql, [], false, queryOptions);
    } finally {
      this.execLock.release();
    }
  }
  /**
   * Sets the default safe integers mode for all statements from this connection.
   * 
   * @param toggle - Whether to use safe integers by default.
   */
  defaultSafeIntegers(toggle) {
    this.defaultSafeIntegerMode = toggle === false ? false : true;
  }
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
  transaction(fn) {
    if (typeof fn !== "function") {
      throw new TypeError("Expected first argument to be a function");
    }
    const db = this;
    const wrapTxn = (mode) => {
      return async (...bindParameters) => {
        await db.exec("BEGIN " + mode);
        try {
          const result = await fn(...bindParameters);
          await db.exec("COMMIT");
          return result;
        } catch (err) {
          await db.exec("ROLLBACK");
          throw err;
        }
      };
    };
    const properties = {
      default: { value: wrapTxn("") },
      deferred: { value: wrapTxn("DEFERRED") },
      concurrent: { value: wrapTxn("CONCURRENT") },
      immediate: { value: wrapTxn("IMMEDIATE") },
      exclusive: { value: wrapTxn("EXCLUSIVE") },
      database: { value: this, enumerable: true }
    };
    Object.defineProperties(properties.default.value, properties);
    Object.defineProperties(properties.deferred.value, properties);
    Object.defineProperties(properties.concurrent.value, properties);
    Object.defineProperties(properties.immediate.value, properties);
    Object.defineProperties(properties.exclusive.value, properties);
    return properties.default.value;
  }
  /**
   * Close the connection.
   * 
   * This sends a close request to the server to properly clean up the stream.
   */
  async close() {
    this.isOpen = false;
    await this.session.close();
  }
  async reconnect() {
    try {
      if (this.isOpen) {
        await this.close();
      }
    } finally {
      this.session = new Session(this.config);
      this.isOpen = true;
    }
  }
};
function connect(config) {
  return new Connection(config);
}

exports.Connection = Connection;
exports.DatabaseError = DatabaseError;
exports.ENCRYPTION_KEY_HEADER = ENCRYPTION_KEY_HEADER;
exports.Session = Session;
exports.Statement = Statement;
exports.TimeoutError = TimeoutError;
exports.connect = connect;
exports.decodeValue = decodeValue;
exports.encodeValue = encodeValue;
