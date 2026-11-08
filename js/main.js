"use strict";

// Matches the first table reference after a FROM, optionally schema-qualified
// and quoted with ", ', ` or [ ]. Groups 1-5 capture an optional schema
// qualifier, groups 6-10 the table name.
const SQL_FROM_REGEX = /\bFROM\s+(?:(?:"([^"]+)"|'([^']+)'|`([^`]+)`|\[([^\]]+)\]|(\w+))\s*\.\s*)?(?:"([^"]+)"|'([^']+)'|`([^`]+)`|\[([^\]]+)\]|(\w+))/i;
const SQL_LIMIT_REGEX = /\bLIMIT\s+(\d+)(?:\s*,\s*(\d+)|\s+OFFSET\s+(\d+))?(\s*;?\s*)$/i;

// Leading keyword of a statement that changes the schema or data.
const MODIFY_STATEMENT_REGEX = /^(?:create|drop|alter|insert|delete|update|replace|vacuum|reindex)\b/i;

// True when the query's first statement modifies the database, so the table
// list (names and row counts) needs refreshing. Only the leading keyword is
// inspected, after skipping whitespace and comments, so identifiers or string
// literals further into the query can't trigger a false positive.
function modifiesDatabase(query) {
    const start = query.replace(/^(?:(?:\s+)|(?:--[^\n]*\n?)|(?:\/\*[\s\S]*?\*\/))+/, "");
    return MODIFY_STATEMENT_REGEX.test(start);
}

function quoteIdentifier(name) {
    return '"' + name.replace(/"/g, '""') + '"';
}

let worker = null;
let nextMessageId = 0;
const pendingMessages = new Map();

function initWorker() {
    worker = new Worker("js/worker.sql-wasm.js");
    worker.onmessage = function (event) {
        const data = event.data;
        const id = data.id;

        if (pendingMessages.has(id)) {
            const { resolve, reject } = pendingMessages.get(id);
            pendingMessages.delete(id);

            if (data.error) {
                reject(new Error(data.error));
            } else {
                resolve(data);
            }
        }
    };
    worker.onerror = function (err) {
        console.error("Worker error:", err);
        for (const { reject } of pendingMessages.values()) {
            reject(new Error("Worker error: " + (err.message || "unknown error")));
        }
        pendingMessages.clear();
    };
}

function sendWorkerMessage(action, payload = {}, transferables = []) {
    return new Promise((resolve, reject) => {
        const id = nextMessageId++;
        pendingMessages.set(id, { resolve, reject });
        worker.postMessage({ id, action, ...payload }, transferables);
    });
}

// Run a query and return its first result set ({columns, values}), or null.
async function execSql(sql) {
    const { results } = await sendWorkerMessage("exec", { sql });
    return results && results.length ? results[0] : null;
}

let lastCachedQueryCount = { db: null, select: "", count: 0 };
let loadedTableNames = [];
let currentDbKey = "default";
let currentDbName = "Default";
let editor = null;
let tableSelect = null;
const errorBox = $("#error");
const infoBox = $("#info");
const hashParams = new URLSearchParams(window.location.hash.substring(1));
const appConfig = window.APP_CONFIG || {};

// Set (or, with a null value, remove) a hash parameter and sync the URL.
function setHashParam(key, value) {
    if (value == null) {
        if (!hashParams.has(key)) return;
        hashParams.delete(key);
    } else {
        hashParams.set(key, value);
    }
    history.replaceState(null, null, `#${hashParams.toString()}`);
}

initialize();

function initialize() {
    bindUiEvents();
    initTableSelect();
    initEditor();
    initDatabase();
}

function bindUiEvents() {
    $("#resizer").on("click", () => {
        $("#main-container").toggleClass("container container-fluid");
        $("#resizer-expand").toggle();
        $("#resizer-collapse").toggle();
    });
    $("#sql-editor").on("keydown", onKeyDown);

    $("#dropzone").on("click", dropzoneClick);
    $("#sql-run").on("click", executeSql);

    // The export links are <a href="#">; stop the default jump so it can't
    // clear the #url / #sql hash parameters.
    $('[data-action="export-all"]').on("click", (event) => {
        event.preventDefault();
        exportAllToCsv();
    });
    $('[data-action="export-selected"]').on("click", (event) => {
        event.preventDefault();
        exportSelectedTableToCsv();
    });
    $('[data-action="export-query"]').on("click", (event) => {
        event.preventDefault();
        exportQueryTableToCsv();
    });

    $("#page-prev").on("click", (event) => setPage(event.currentTarget, false));
    $("#page-next").on("click", (event) => setPage(event.currentTarget, true));
    $("#pager").on("click", (event) => {
        event.preventDefault();
        setPage(event.currentTarget);
    });

    $("#clear-active-history").on("click", clearQueryHistory);
    $("#clear-all-history").on("click", clearAllDatabasesHistory);

    // Links inside the dropzone must not trigger its click handler.
    $(".no-propagate").on("click", (event) => event.stopPropagation());
}

function initTableSelect() {
    tableSelect = new TomSelect("#tables", {
        placeholder: "Select a table",
        maxItems: 1,
        render: { option: renderTableLabel, item: renderTableLabel },
        onChange: (value) => {
            if (value) doDefaultSelect(value);
        }
    });
}

function initEditor() {
    const editorElement = document.getElementById("sql-editor");
    editorElement.classList.add("language-sql");
    editor = CodeJar(editorElement, (el) => Prism.highlightElement(el));
}

function initDatabase() {
    if (typeof FileReader === "undefined" || typeof WebAssembly === "undefined") {
        $("#dropzone, #dropzone-dialog").hide();
        $("#compat-error").toggleClass("d-none", false);
        return;
    }

    initWorker();
    setupDragAndDrop();

    const loadUrlDB = hashParams.get("url");
    if (loadUrlDB != null) {
        loadRemoteDB(loadUrlDB);
    } else if (appConfig.defaultUrl) {
        loadRemoteDB(appConfig.defaultUrl);
    }
}

async function loadRemoteDB(urlStr) {
    try {
        const resolvedUrl = new URL(decodeURIComponent(urlStr), window.location.href);
        currentDbKey = "url:" + encodeURIComponent(resolvedUrl.href);
        currentDbName = decodeURIComponent(resolvedUrl.pathname.split("/").pop()) || resolvedUrl.hostname;
        setIsLoading(true);
        const response = await fetch(resolvedUrl.href);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        const pathname = resolvedUrl.pathname.toLowerCase();
        if (pathname.endsWith(".zip")) {
            await handleZipFile(buffer);
        } else {
            await loadDB(buffer);
        }
        setHashParam("url", urlStr);
    } catch (err) {
        setIsLoading(false);
        showErrorMessage("Error loading remote database: " + err.message);
    }
}

async function loadDB(arrayBuffer) {
    setIsLoading(true);

    resetTableList();

    try {
        // Send ArrayBuffer to Worker using transferable array for 0-copy transfer
        await sendWorkerMessage("open", { buffer: arrayBuffer }, [arrayBuffer]);
        renderQueryHistory();

        const firstTableName = await populateTableList(true);
        const sqlParam = hashParams.get("sql");
        const defaultSql = appConfig.defaultSql || null;

        if (sqlParam != null) {
            editor.updateCode(sqlParam);
            await renderQuery(sqlParam);
        } else if (defaultSql != null) {
            editor.updateCode(defaultSql);
            await renderQuery(defaultSql);
        } else if (firstTableName !== null) {
            await doDefaultSelect(firstTableName);
        }

        $("#output-box").show();
        setTimeout(() => {
            $("#output-box").css("opacity", 1);
        }, 50);
        $(".nouploadinfo").hide();
        $("#sample-db-link").hide();
        $("#dropzone").css("height", "75px");

    } catch (ex) {
        showErrorMessage(ex.message || ex);
    } finally {
        setIsLoading(false);
    }
}

async function populateTableList(selectFirst = false) {
    const currentSelected = tableSelect.getValue();

    // Reset table name cache
    loadedTableNames = [];
    tableSelect.clear(true);
    tableSelect.clearOptions(() => false);

    try {
        const res = await execSql("SELECT name, type FROM sqlite_master WHERE type='table' OR type='view' ORDER BY name");

        let firstTableName = null;

        if (res) {
            const tables = res.values;
            if (tables.length > 0) {
                firstTableName = tables[0][0];
            }

            // Row counts are independent; fetch them concurrently.
            const rowCounts = await Promise.all(tables.map(([name]) => getTableRowsCount(name)));
            tables.forEach(([name, type], i) => {
                loadedTableNames.push(name);
                tableSelect.addOption({ value: name, text: tableLabel(name, rowCounts[i], type) });
            });
        }

        if (selectFirst && firstTableName !== null) {
            tableSelect.setValue(firstTableName, true);
            return firstTableName;
        } else if (currentSelected && loadedTableNames.includes(currentSelected)) {
            tableSelect.setValue(currentSelected, true);
            return currentSelected;
        } else {
            tableSelect.clear(true);
            return null;
        }
    } catch (e) {
        console.error("Error populating table list:", e);
        return null;
    }
}

async function getTableRowsCount(name) {
    try {
        const res = await execSql(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`);
        return res ? res.values[0][0] : -1;
    } catch (e) {
        console.error(e);
        return -1;
    }
}

async function getQueryRowCount(query) {
    if (query === lastCachedQueryCount.select && currentDbKey === lastCachedQueryCount.db) {
        return lastCachedQueryCount.count;
    }

    if (/^\s*SELECT\b/i.test(query)) {
        // Strip the outermost trailing LIMIT clause if it exists
        let cleanQuery = query.replace(SQL_LIMIT_REGEX, "$4");
        // Strip any trailing semicolons which are invalid inside subqueries
        cleanQuery = cleanQuery.trim().replace(/;+$/, "");

        const countQuery = `SELECT COUNT(*) AS count FROM (${cleanQuery})`;
        try {
            const res = await execSql(countQuery);
            if (res) {
                const count = res.values[0][0];
                lastCachedQueryCount = { db: currentDbKey, select: query, count };
                return count;
            }
            return -1;
        } catch (e) {
            console.error("Error executing count query:", e);
            return -1;
        }
    } else {
        return -1;
    }
}

// Map of column name -> { type, constraints }. The declared type is kept
// separate from the constraint text so callers can use them independently
// (the header tooltip shows both; blob detection needs the type alone).
async function getTableColumnTypes(tableName) {
    const result = new Map();
    try {
        const res = await execSql(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
        if (res) {
            // PRAGMA table_info returns columns: cid, name, type, notnull, dflt_value, pk
            for (const row of res.values) {
                const [, name, type, notnull, , pk] = row;
                const constraints = [];
                if (notnull === 1) constraints.push("NOT NULL");
                if (pk === 1) constraints.push("PRIMARY KEY");
                result.set(name, { type: type || "", constraints: constraints.join(" ") });
            }
        }
    } catch (e) {
        console.error(e);
    }
    return result;
}

function resetTableList() {
    loadedTableNames = [];
    tableSelect.clear(true);
    tableSelect.clearOptions(() => false);
}

function setIsLoading(isLoading) {
    const dropText = $("#drop-text");
    const loading = $("#drop-loading");
    if (isLoading) {
        dropText.hide();
        loading.toggleClass("d-none", false);
    } else {
        dropText.show();
        loading.toggleClass("d-none", true);
    }
}

function dropzoneClick() {
    $("#dropzone-dialog").click();
}

function setupDragAndDrop() {
    const dropzone = document.getElementById("dropzone");
    const fileInput = document.getElementById("dropzone-dialog");

    // Prevent default drag behaviors for window to avoid opening files dropped outside the dropzone
    window.addEventListener("dragover", function (e) {
        e.preventDefault();
    }, false);
    window.addEventListener("drop", function (e) {
        e.preventDefault();
    }, false);

    // Drag-and-drop event handlers for the dropzone area
    dropzone.addEventListener("dragenter", function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add("drag");
    }, false);

    dropzone.addEventListener("dragover", function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add("drag");
    }, false);

    dropzone.addEventListener("dragleave", function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove("drag");
    }, false);

    dropzone.addEventListener("drop", function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove("drag");

        const files = e.dataTransfer.files;
        if (files && files.length > 0) {
            handleFile(files[0]);
        }
    }, false);

    // Click file selector handling
    fileInput.addEventListener("change", function (e) {
        const files = e.target.files;
        if (files && files.length > 0) {
            handleFile(files[0]);
        }
    }, false);
}

function handleFile(file) {
    setHashParam("url", null);
    currentDbName = file.name;
    if (file.name.endsWith(".zip")) {
        handleZipFile(file);
    } else {
        currentDbKey = `file:${file.name}-${file.size}-${file.lastModified}`;
        setIsLoading(true);
        const reader = new FileReader();
        reader.onload = function (e) {
            loadDB(e.target.result);
        };
        reader.onerror = function () {
            setIsLoading(false);
            showErrorMessage("Error reading file.");
        };
        reader.readAsArrayBuffer(file);
    }
}

async function handleZipFile(file) {
    setIsLoading(true);
    try {
        const zip = await JSZip.loadAsync(file);

        let dbFile = null;
        zip.forEach((relativePath, zipEntry) => {
            // Take the first database entry so the choice is deterministic.
            if (!dbFile && !zipEntry.dir && (
                relativePath.endsWith(".sqlite") ||
                relativePath.endsWith(".db") ||
                relativePath.endsWith(".db3") ||
                relativePath.endsWith(".sqlite3")
            )) {
                dbFile = zipEntry;
            }
        });

        if (!dbFile) {
            throw new Error("No SQLite database (.sqlite, .db, .db3, .sqlite3) found inside the ZIP file.");
        }

        const arrayBuffer = await dbFile.async("arraybuffer");
        if (file && typeof file.name === "string") {
            currentDbKey = `zip:${file.name}:${dbFile.name}-${arrayBuffer.byteLength}`;
            currentDbName = dbFile.name;
        }
        await loadDB(arrayBuffer);

    } catch (err) {
        setIsLoading(false);
        showErrorMessage(err.message || err);
    }
}

async function doDefaultSelect(name) {
    const defaultSelect = `SELECT * FROM ${quoteIdentifier(name)} LIMIT 0,30`;
    editor.updateCode(defaultSelect);
    await renderQuery(defaultSelect);
}

async function executeSql() {
    const query = editor.toString();
    saveQueryToHistory(query);
    await renderQuery(query);

    // If the query modifies the database, refresh the dropdown to keep counts/names in sync
    if (modifiesDatabase(query)) {
        lastCachedQueryCount = { db: null, select: "", count: 0 };
        await populateTableList();
    } else {
        const tableName = getTableNameFromQuery(query);
        if (tableName && loadedTableNames.includes(tableName)) {
            tableSelect.setValue(tableName, true);
        } else {
            tableSelect.clear(true);
        }
    }

    setHashParam("sql", query);
}

function getTableNameFromQuery(query) {
    const match = SQL_FROM_REGEX.exec(query);
    if (!match) return null;
    // The table name is the first of the last five groups that participated.
    return match.slice(6, 11).find(group => group !== undefined) ?? null;
}

async function parseLimitFromQuery(query) {
    const sqlRegex = SQL_LIMIT_REGEX.exec(query);
    if (sqlRegex != null) {
        let result = { max: 0, offset: 0 };

        if (sqlRegex[3] !== undefined) {
            // LIMIT <max> OFFSET <offset>
            result.max = parseInt(sqlRegex[1]);
            result.offset = parseInt(sqlRegex[3]);
        } else if (sqlRegex[2] !== undefined) {
            // LIMIT <offset>, <max>
            result.offset = parseInt(sqlRegex[1]);
            result.max = parseInt(sqlRegex[2]);
        } else {
            // LIMIT <max>
            result.offset = 0;
            result.max = parseInt(sqlRegex[1]);
        }

        if (result.max === 0) {
            result.pages = 0;
            result.currentPage = 0;
            return result;
        }

        const queryRowsCount = await getQueryRowCount(query);
        if (queryRowsCount !== -1) {
            result.pages = Math.ceil(queryRowsCount / result.max);
        }
        result.currentPage = Math.floor(result.offset / result.max) + 1;
        result.rowCount = queryRowsCount;

        return result;
    } else {
        return null;
    }
}

async function setPage(el, next) {
    if ($(el).hasClass("disabled")) return;

    const query = editor.toString();
    const limit = await parseLimitFromQuery(query);

    // currentPage is 1-based; work in 0-based page indices when computing the offset.
    let pageIndex;
    if (typeof next !== "undefined") {
        pageIndex = next ? limit.currentPage : limit.currentPage - 2;
    } else {
        const page = Number(await showDialog("Go to page", String(limit.currentPage)));
        if (!Number.isInteger(page) || page < 1 || page > limit.pages) {
            return;
        }
        pageIndex = page - 1;
    }

    const offset = pageIndex * limit.max;
    editor.updateCode(query.replace(SQL_LIMIT_REGEX, `LIMIT ${offset},${limit.max}$4`));

    await executeSql();
}

async function refreshPagination(query) {
    const limit = await parseLimitFromQuery(query);
    if (limit !== null && limit.pages > 0) {
        const pager = $("#pager");
        const pagePrev = $("#page-prev");
        const pageNext = $("#page-next");

        pager.attr("title", `Row count: ${limit.rowCount}`);
        bootstrap.Tooltip.getOrCreateInstance("#pager").hide();
        pager.text(limit.currentPage + " / " + limit.pages);

        if (limit.currentPage <= 1) {
            pagePrev.addClass("disabled");
        } else {
            pagePrev.removeClass("disabled");
        }

        if ((limit.currentPage + 1) > limit.pages) {
            pageNext.addClass("disabled");
        } else {
            pageNext.removeClass("disabled");
        }

        setPagerVisible(true);
    } else {
        setPagerVisible(false);
    }
}

function showError(msg) {
    $("#data").hide();
    setPagerVisible(false);
    errorBox.show();
    errorBox.text(msg);
}

// Report a fatal error (e.g. a failed load) in the in-page error box.
function showErrorMessage(msg) {
    $("#output-box").show();
    showError(msg);
}

// Small modal used in place of window.confirm/window.prompt. Without a default
// value it resolves true/false; with one it resolves the entered string, or
// null when cancelled.
function showDialog(message, defaultValue) {
    return new Promise((resolve) => {
        const modalEl = document.getElementById("app-dialog");
        const input = document.getElementById("app-dialog-input");
        const okButton = document.getElementById("app-dialog-ok");
        const isPrompt = defaultValue !== undefined;

        document.getElementById("app-dialog-message").textContent = message;
        input.classList.toggle("d-none", !isPrompt);
        input.value = isPrompt ? defaultValue : "";

        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
        let result = isPrompt ? null : false;

        function onKeyDown(event) {
            if (event.key === "Enter") {
                result = isPrompt ? input.value : true;
                modal.hide();
            }
        }
        function onOk() {
            result = isPrompt ? input.value : true;
            modal.hide();
        }
        function onHidden() {
            okButton.removeEventListener("click", onOk);
            input.removeEventListener("keydown", onKeyDown);
            resolve(result);
        }

        okButton.addEventListener("click", onOk);
        input.addEventListener("keydown", onKeyDown);
        modalEl.addEventListener("hidden.bs.modal", onHidden, { once: true });

        modal.show();
        if (isPrompt) {
            modalEl.addEventListener("shown.bs.modal", () => {
                input.focus();
                input.select();
            }, { once: true });
        }
    });
}

function setPagerVisible(visible) {
    $("#bottom-bar").toggleClass("d-none", !visible);
    $("#footer").toggleClass("with-pager", visible);
}

// --- View builders ---
function tableLabel(name, rowCount, type) {
    const tableType = type !== "table" ? `, ${type}` : "";
    return `${name} (${rowCount} rows${tableType})`;
}

function renderTableLabel(data, escape) {
    const text = data.text ?? "";
    const index = text.indexOf("(");
    if (index > -1) {
        return `<div>${escape(text.substring(0, index))}<span style="color: #ccc">${escape(text.substring(index - 1))}</span></div>`;
    }
    return `<div>${escape(text)}</div>`;
}

function headerCell(name, type) {
    const label = $("<span>").attr("data-bs-toggle", "tooltip").attr("title", type).text(name);
    return $("<th>").append(label);
}

function dataCell(value) {
    const text = String(value);
    return $("<td>").append($("<span>").attr("title", text).text(text));
}

function nullBlobCell() {
    return $("<td>").append($("<span>").attr("title", "Blob").text("null"));
}

function tableRow() {
    return $("<tr>");
}

async function renderQuery(query) {
    const dataBox = $("#data");
    const thead = dataBox.find("thead").find("tr");
    const tbody = dataBox.find("tbody");

    thead.empty();
    tbody.empty();
    errorBox.hide();
    infoBox.hide();
    dataBox.show();

    let columnTypes = new Map();
    const tableName = getTableNameFromQuery(query);
    if (tableName != null) {
        columnTypes = await getTableColumnTypes(tableName);
    }

    let res;
    try {
        res = await execSql(query);
    } catch (ex) {
        showError(ex.message || ex);
        return;
    }

    let isEmptyTable = true;

    if (res) {
        isEmptyTable = false;
        const columnNames = res.columns;
        const values = res.values;

        for (let i = 0; i < columnNames.length; i++) {
            const columnName = columnNames[i];
            const info = columnTypes.get(columnName);
            const headerType = info ? [info.type, info.constraints].filter(Boolean).join(" ") : "";
            thead.append(headerCell(columnName, headerType));
        }

        for (let r = 0; r < values.length; r++) {
            const tr = tableRow();
            const rowValues = values[r];
            for (let i = 0; i < rowValues.length; i++) {
                const columnName = columnNames[i];
                const info = columnTypes.get(columnName);
                const columnType = info ? info.type.toLowerCase() : "";
                if (columnType === "blob" || columnType === "blob sub_type binary") {
                    if (rowValues[i] === null) {
                        tr.append(nullBlobCell());
                    } else {
                        renderBlobItem(tr, rowValues[i]);
                    }
                } else {
                    tr.append(dataCell(rowValues[i]));
                }
            }
            tbody.append(tr);
        }
    }

    if (isEmptyTable) {
        infoBox.text("No data returned for the given query.");
        infoBox.show();
    }

    await refreshPagination(query);

    document.querySelectorAll('[data-bs-toggle="tooltip"]')
        .forEach(el => bootstrap.Tooltip.getOrCreateInstance(el));
}

function renderBlobItem(tr, bytes) {
    const td = document.createElement("td");
    const span = document.createElement("span");
    span.title = "Blob";
    const downloadLink = document.createElement("a");
    downloadLink.href = "#";
    downloadLink.textContent = `Download (${formatBytes(bytes.length)})`;
    downloadLink.addEventListener("click", (event) => {
        event.preventDefault();
        saveAs(new Blob([bytes]), "blob");
    });
    span.append(downloadLink);
    td.append(span);
    tr.append(td);
}

function formatBytes(bytes,decimals) {
    if(bytes === 0) return '0 Bytes';
    const k = 1024,
        dm = decimals || 2,
        sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'],
        i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        executeSql();
    }
}

function arrayToCsv(data) {
    return data.map(row =>
        row.map(String)  // convert every value to String
            .map(v => v.replaceAll('"', '""'))  // escape double quotes
            .map(v => `"${v}"`)  // quote it
            .join(',')  // comma-separated
    ).join('\r\n');  // rows starting on new lines
}

async function exportCsvTableQuery(query) {
    let exportedRows = [];
    try {
        const res = await execSql(query);
        if (res) {
            exportedRows.push(res.columns);
            exportedRows.push(...res.values);
        }
        return exportedRows;
    } catch (ex) {
        showError(ex.message || ex);
        setIsLoading(false);
        return null;
    }
}

async function exportCsvTable(tableName) {
    return await exportCsvTableQuery(`SELECT * FROM ${quoteIdentifier(tableName)}`);
}

async function exportAllToCsv() {
    setIsLoading(true);
    const zip = new JSZip();
    try {
        for (const tableName of loadedTableNames) {
            const exportedRows = await exportCsvTable(tableName);
            if (exportedRows != null) {
                zip.file(tableName + ".csv", arrayToCsv(exportedRows));
            } else {
                setIsLoading(false);
                return;
            }
        }

        const content = await zip.generateAsync({type: "blob"});
        saveAs(content, "exported_all_db.zip");
    } catch (e) {
        showError(e.message || e);
    }
    setIsLoading(false);
}

async function exportSelectedTableToCsv() {
    const tableName = tableSelect.getValue();
    setIsLoading(true);

    const exportedRows = await exportCsvTable(tableName);
    if (exportedRows != null) {
        const blob = new Blob([arrayToCsv(exportedRows)], {type: "text/plain;charset=utf-8"});
        saveAs(blob, "exported_" + tableName.toLowerCase() + "_db.csv");
    }

    setIsLoading(false);
}

async function exportQueryTableToCsv() {
    setIsLoading(true);

    const query = editor.toString();
    const exportedRows = await exportCsvTableQuery(query);
    if (exportedRows != null) {
        const blob = new Blob([arrayToCsv(exportedRows)], {type: "text/plain;charset=utf-8"});
        saveAs(blob, "exported_" + getTableNameFromQuery(query).toLowerCase() + "_db.csv");
    }

    setIsLoading(false);
}

// --- Partitioned Query History API ---
const HISTORY_PREFIX = "sqlite_viewer_history_";
const MAX_HISTORY_ITEMS = 50;

function getActiveStorageKey() {
    return HISTORY_PREFIX + currentDbKey;
}

function getQueryHistory() {
    try {
        const key = getActiveStorageKey();
        const stored = localStorage.getItem(key);
        return stored ? JSON.parse(stored) : [];
    } catch (e) {
        console.error("Failed to read history from localStorage:", e);
        return [];
    }
}

function saveQueryToHistory(sql) {
    if (!sql || sql.trim() === "" || currentDbKey === "default") return;
    
    // Skip auto-generated pagination count queries
    if (/^\s*SELECT\s+COUNT\(\*\)\s+(AS\s+\w+\s+)?FROM/i.test(sql)) return;

    let historyList = getQueryHistory();
    
    // Move duplicate queries to the top
    historyList = historyList.filter(item => item.sql.trim() !== sql.trim());
    
    historyList.unshift({
        sql: sql.trim(),
        timestamp: Date.now()
    });

    if (historyList.length > MAX_HISTORY_ITEMS) {
        historyList = historyList.slice(0, MAX_HISTORY_ITEMS);
    }

    localStorage.setItem(getActiveStorageKey(), JSON.stringify(historyList));
    renderQueryHistory();
}

async function clearQueryHistory() {
    if (await showDialog("Are you sure you want to clear history for this database?")) {
        localStorage.removeItem(getActiveStorageKey());
        renderQueryHistory();
    }
}

async function clearAllDatabasesHistory() {
    if (await showDialog("This will permanently delete query histories for ALL databases. Proceed?")) {
        Object.keys(localStorage)
            .filter(key => key.startsWith(HISTORY_PREFIX))
            .forEach(key => localStorage.removeItem(key));
        renderQueryHistory();
    }
}

function deleteHistoryItem(index) {
    let historyList = getQueryHistory();
    historyList.splice(index, 1);
    localStorage.setItem(getActiveStorageKey(), JSON.stringify(historyList));
    renderQueryHistory();
}

async function copyQueryToClipboard(sql) {
    if (window.isSecureContext && navigator.clipboard) {
        try {
            await navigator.clipboard.writeText(sql);
            return;
        } catch (e) {
            console.error("Clipboard API copy failed, falling back:", e);
        }
    }

    // Fallback for insecure contexts: a temporary textarea inside the
    // offcanvas (to stay within Bootstrap's focus trap) plus execCommand.
    const ta = document.createElement("textarea");
    ta.value = sql;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    const container = document.getElementById("history-sidebar") || document.body;
    container.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    container.removeChild(ta);
}

function loadQueryFromHistory(sql) {
    editor.updateCode(sql);
    executeSql();
    
    // Close offcanvas sidebar
    const offcanvasEl = document.getElementById("history-sidebar");
    if (offcanvasEl && typeof bootstrap !== "undefined" && bootstrap.Offcanvas) {
        const offcanvas = bootstrap.Offcanvas.getInstance(offcanvasEl);
        if (offcanvas) offcanvas.hide();
    }
}

// Clone the first element of a <template> by id.
function cloneTemplate(id) {
    return document.getElementById(id).content.firstElementChild.cloneNode(true);
}

function renderQueryHistory() {
    const historyListContainer = $("#history-list");
    if (historyListContainer.length === 0) return;
    
    const historyList = getQueryHistory();
    
    $("#history-count").text(`${historyList.length} queries saved`);
    historyListContainer.empty();

    // Friendly database name shown in the offcanvas header
    $("#history-sidebar-label").text(`History: ${currentDbName}`);

    if (historyList.length === 0) {
        historyListContainer.append(cloneTemplate("tmpl-history-empty"));
        return;
    }

    historyList.forEach((item, index) => {
        const card = cloneTemplate("tmpl-history-card");
        card.querySelector("small").textContent = new Date(item.timestamp).toLocaleString();

        const sqlPreview = card.querySelector('[data-action="load"]');
        sqlPreview.textContent = item.sql;
        sqlPreview.addEventListener("click", () => loadQueryFromHistory(item.sql));

        card.querySelector('[data-action="delete"]').addEventListener("click", () => deleteHistoryItem(index));
        card.querySelector('[data-action="run"]').addEventListener("click", () => loadQueryFromHistory(item.sql));
        card.querySelector('[data-action="copy"]').addEventListener("click", () => copyQueryToClipboard(item.sql));

        historyListContainer.append(card);
    });
}
