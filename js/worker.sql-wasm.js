"use strict";

// Load the official SQLite3 WASM vanilla JS wrapper.
importScripts("sqlite3.js");

let sqlite3 = null;
let db = null;

const sqlite3Promise = sqlite3InitModule().then((loaded) => {
    sqlite3 = loaded;
});

// The OPFS-backed VFS is only installed when the page is cross-origin
// isolated (COOP/COEP response headers); it needs SharedArrayBuffer. Without
// it we fall back to an in-memory database.
function opfsAvailable() {
    return typeof sqlite3.oo1.OpfsDb === "function";
}

// A stable, filesystem-safe name for a database key.
async function opfsFileName(key) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    return `sqlite-viewer-${hex.slice(0, 40)}.sqlite`;
}

async function opfsFileExists(name) {
    try {
        const root = await navigator.storage.getDirectory();
        await root.getFileHandle(name);
        return true;
    } catch (e) {
        return false;
    }
}

// Open the database identified by `key`. With OPFS it is stored in the browser
// and reused on the next load, so edits survive a reload; otherwise it is a
// throwaway in-memory database seeded from `buffer`.
async function openDatabase(buffer, key) {
    if (db) { db.close(); db = null; }

    if (opfsAvailable()) {
        const name = await opfsFileName(key || "default");
        if (await opfsFileExists(name)) {
            // Reuse the saved copy, which may hold earlier edits.
            db = new sqlite3.oo1.OpfsDb(name);
        } else {
            if (buffer) {
                await sqlite3.oo1.OpfsDb.importDb(name, new Uint8Array(buffer));
            }
            db = new sqlite3.oo1.OpfsDb(name);
        }
        return { persisted: true };
    }

    db = new sqlite3.oo1.DB();
    if (!buffer) return { persisted: false };

    const bytes = new Uint8Array(buffer);
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    // SQLITE_DESERIALIZE_FREEONCLOSE | SQLITE_DESERIALIZE_RESIZEABLE
    const rc = sqlite3.capi.sqlite3_deserialize(
        db.pointer, "main", p, bytes.length, bytes.length, 1 | 2
    );
    if (rc !== 0) {
        sqlite3.wasm.dealloc(p);
        throw new Error(`Failed to deserialize database (SQLite error code: ${rc})`);
    }
    return { persisted: false };
}

// Delete every database this app has stored in the browser.
async function forgetStoredDatabases() {
    if (db) { db.close(); db = null; }
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const handle of root.values()) {
        if (handle.kind === "file") names.push(handle.name);
    }
    await Promise.all(names.map((name) => root.removeEntry(name)));
}

// Run one or more SQL statements, returning the first statement's result set.
// Used for internal queries and CSV export, which need every row at once.
function runSql(sql) {
    if (!db) db = new sqlite3.oo1.DB();
    if (!sql) throw new Error("exec: Missing query string");

    const columns = [];
    const values = [];
    db.exec({ sql, rowMode: "array", columnNames: columns, resultRows: values });
    return columns.length ? [{ columns, values }] : [];
}

// Column names, declared types and source table/column, straight from SQLite's
// statement metadata. Works even for a query that returns no rows, and for
// expressions (which report no source table / declared type).
function describeColumns(stmt) {
    const capi = sqlite3.capi;
    const columns = [];
    for (let i = 0; i < stmt.columnCount; i++) {
        let decltype = "";
        let table = null;
        let origin = null;
        try { decltype = capi.sqlite3_column_decltype(stmt.pointer, i) || ""; } catch (e) { /* expression */ }
        try { table = capi.sqlite3_column_table_name(stmt.pointer, i); } catch (e) { /* expression */ }
        try { origin = capi.sqlite3_column_origin_name(stmt.pointer, i); } catch (e) { /* expression */ }
        columns.push({ name: stmt.getColumnName(i), decltype, table, origin });
    }
    return columns;
}

// Rows changed so far by this connection (monotonic) and the schema cookie.
// Comparing both around a statement tells us authoritatively whether it
// changed the database: DML bumps total changes, DDL bumps schema_version.
function databaseVersion() {
    return { changes: Number(db.changes(true)), schema: db.selectValue("PRAGMA schema_version") };
}

// Run one page of a query without ever rewriting the SQL: the statement is
// stepped and the first `offset` rows are skipped. A single, read-only
// statement that returns rows can therefore be paged safely (re-running it has
// no side effects); anything else runs once and reports no further pages.
function runPage(sql, page, pageSize) {
    if (!db) db = new sqlite3.oo1.DB();
    if (!sql || !sql.trim()) throw new Error("Empty query.");

    // Preparing the first statement gives the result columns even when it
    // yields no rows, and tells us whether paging it is safe.
    const metaStmt = db.prepare(sql);
    const columns = describeColumns(metaStmt);
    const readonly = metaStmt.isReadOnly();
    metaStmt.finalize();

    const offset = (Math.max(1, page) - 1) * pageSize;
    const saveSql = [];
    const values = [];
    let seen = 0;

    const before = databaseVersion();
    db.exec({
        sql,
        saveSql, // collects each prepared statement's text, so we can count them
        callback: (row) => {
            seen++;
            if (seen <= offset) return true;            // still skipping ahead
            if (seen > offset + pageSize) return false; // one past the page: stop
            values.push(row);
            return true;
        }
    });
    const after = databaseVersion();

    return {
        columns,
        values,
        hasMore: seen > offset + pageSize,
        statementCount: saveSql.length,
        paginated: saveSql.length === 1 && columns.length > 0 && readonly,
        readonly,
        modified: after.changes > before.changes || after.schema !== before.schema
    };
}

// Exact number of rows the query returns (re-runs it; only requested for a
// single read-only statement).
function countRows(sql) {
    if (!db) throw new Error("count: No database is open.");
    let count = 0;
    db.exec({ sql, callback: () => { count++; return true; } });
    return count;
}

async function handleMessage(data) {
    switch (data.action) {
        case "open":
            postMessage({ id: data.id, ...(await openDatabase(data.buffer, data.key)) });
            break;

        case "exec":
            postMessage({ id: data.id, results: runSql(data.sql) });
            break;

        case "query":
            postMessage({ id: data.id, ...runPage(data.sql, data.page, data.pageSize) });
            break;

        case "count":
            postMessage({ id: data.id, count: countRows(data.sql) });
            break;

        case "export": {
            if (!db) throw new Error("Export failed: No database is currently opened.");
            const byteArray = sqlite3.capi.sqlite3_js_db_export(db.pointer);
            const result = { id: data.id, buffer: byteArray.buffer };
            try {
                postMessage(result, [result.buffer]);
            } catch (e) {
                postMessage(result);
            }
            break;
        }

        case "forget":
            await forgetStoredDatabases();
            postMessage({ id: data.id, forgotten: true });
            break;

        case "close":
            if (db) {
                db.close();
                db = null;
            }
            postMessage({ id: data.id });
            break;

        default:
            throw new Error("Invalid action: " + data.action);
    }
}

onmessage = function (event) {
    const data = event.data;
    if (!data || !data.action) return;

    sqlite3Promise
        .catch((err) => {
            throw new Error("Failed to initialize SQLite3 WASM backend: " + err.message);
        })
        .then(() => handleMessage(data))
        .catch((err) => {
            postMessage({ id: data.id, error: err.message || String(err) });
        });
};
