"use strict";

// Load the official SQLite3 WASM vanilla JS wrapper.
importScripts("sqlite3.js");

let sqlite3 = null;
let db = null;

const sqlite3Promise = sqlite3InitModule().then((loaded) => {
    sqlite3 = loaded;
});

// Open a fresh in-memory database, optionally seeded from a serialized buffer.
function openDatabase(buffer) {
    if (db) db.close();
    db = new sqlite3.oo1.DB();
    if (!buffer) return;

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
}

// Run one or more SQL statements, returning the first statement's result set.
function runSql(sql) {
    if (!db) db = new sqlite3.oo1.DB();
    if (!sql) throw new Error("exec: Missing query string");

    const columns = [];
    const values = [];
    db.exec({ sql, rowMode: "array", columnNames: columns, resultRows: values });
    return columns.length ? [{ columns, values }] : [];
}

function handleMessage(data) {
    switch (data.action) {
        case "open":
            openDatabase(data.buffer);
            postMessage({ id: data.id, ready: true });
            break;

        case "exec":
            postMessage({ id: data.id, results: runSql(data.sql) });
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
        .then(() => {
            try {
                handleMessage(data);
            } catch (err) {
                postMessage({ id: data.id, error: err.message });
            }
        })
        .catch((err) => {
            postMessage({
                id: data.id,
                error: "Failed to initialize SQLite3 WASM backend: " + err.message
            });
        });
};
