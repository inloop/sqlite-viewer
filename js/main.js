"use strict";

// Rows fetched and rendered per page. The query's SQL is never rewritten to
// paginate; the worker steps a prepared statement and skips rows instead.
const PAGE_SIZE = 50;

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

let loadedTableNames = [];
// Which query/page the pager is currently showing, so Next/Prev can step it.
let viewState = { query: "", page: 1 };
let currentDbKey = "default";
let currentDbName = "Default";
let databaseAltered = false;
let editor = null;
let tableSelect = null;
const errorBox = $("#error");
const infoBox = $("#info");
let hashParams = new URLSearchParams(window.location.hash.substring(1));
const appConfig = window.APP_CONFIG || {};

// minimize encoding for nicer URLs
function encodeHashComponent(text) {
    return encodeURIComponent(text)
        .replace(/%20/g, "+")
        .replace(/%(2F|3A|2C|3B|40|24|3F|3D|23)/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Set (or, with a null value, remove) a hash parameter and sync the URL.
// replaceState (rather than assigning location.hash) keeps this from firing a
// hashchange we would otherwise have to ignore.
function setHashParam(key, value) {
    if (value == null) {
        if (!hashParams.has(key)) return;
        hashParams.delete(key);
    } else {
        hashParams.set(key, value);
    }
    const hash = Array.from(hashParams)
        .map(([name, val]) => `${encodeHashComponent(name)}=${encodeHashComponent(val)}`)
        .join("&");
    history.replaceState(null, null, `#${hash}`);
}

// Resolve a #url value to an absolute URL and its database/history key.
function resolveDbUrl(urlStr) {
    const resolvedUrl = new URL(decodeURIComponent(urlStr), window.location.href);
    return { resolvedUrl, key: "url:" + encodeURIComponent(resolvedUrl.href) };
}

// React to the user editing the hash or using back/forward: load a newly
// referenced database, otherwise render a newly referenced query.
function onHashChange() {
    hashParams = new URLSearchParams(window.location.hash.substring(1));

    const url = hashParams.get("url");
    if (url != null) {
        let isCurrent = false;
        try {
            isCurrent = resolveDbUrl(url).key === currentDbKey;
        } catch (_) {
            // Malformed URL: let loadRemoteDB report it.
        }
        if (!isCurrent) {
            loadRemoteDB(url);
            return;
        }
    }

    if (!editor) return;
    const sql = hashParams.get("sql");
    if (sql != null && sql !== editor.toString()) {
        editor.updateCode(sql);
        renderQuery(sql);
    }
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
    $('[data-action="export-db"]').on("click", (event) => {
        event.preventDefault();
        if (databaseAltered) exportDatabase(false);
    });
    $('[data-action="export-db-zip"]').on("click", (event) => {
        event.preventDefault();
        if (databaseAltered) exportDatabase(true);
    });
    updateDatabaseExportItems();

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

    window.addEventListener("hashchange", onHashChange);
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
        const { resolvedUrl, key } = resolveDbUrl(urlStr);
        currentDbKey = key;
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
    resetDatabaseAltered();

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

// Constraint text (NOT NULL / PRIMARY KEY) per column of a source table, from
// PRAGMA table_info. The declared type comes from the statement metadata, so
// aliases and expressions are handled consistently; this only adds constraints.
async function getTableConstraints(tableName) {
    const result = new Map();
    try {
        const res = await execSql(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
        if (res) {
            // PRAGMA table_info returns columns: cid, name, type, notnull, dflt_value, pk
            for (const row of res.values) {
                const [, name, , notnull, , pk] = row;
                const constraints = [];
                if (notnull === 1) constraints.push("NOT NULL");
                if (pk === 1) constraints.push("PRIMARY KEY");
                if (constraints.length) result.set(name, constraints.join(" "));
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

const DATABASE_EXTENSIONS = [".sqlite", ".db", ".db3", ".sqlite3"];

async function handleZipFile(file) {
    setIsLoading(true);
    try {
        const buffer = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
        // Inflate only entries that look like a database, then take the first
        // one so the choice is deterministic.
        const entries = fflate.unzipSync(new Uint8Array(buffer), {
            filter: (entry) => !entry.name.endsWith("/") &&
                DATABASE_EXTENSIONS.some(ext => entry.name.endsWith(ext))
        });

        const dbName = Object.keys(entries)[0];
        if (dbName === undefined) {
            throw new Error("No SQLite database (.sqlite, .db, .db3, .sqlite3) found inside the ZIP file.");
        }

        const dbBytes = entries[dbName];
        if (file && typeof file.name === "string") {
            currentDbKey = `zip:${file.name}:${dbName}-${dbBytes.byteLength}`;
            currentDbName = dbName;
        }
        await loadDB(dbBytes.slice().buffer);

    } catch (err) {
        setIsLoading(false);
        showErrorMessage(err.message || err);
    }
}

async function doDefaultSelect(name) {
    const defaultSelect = `SELECT * FROM ${quoteIdentifier(name)}`;
    editor.updateCode(defaultSelect);
    await renderQuery(defaultSelect);
}

async function executeSql() {
    const query = editor.toString();
    saveQueryToHistory(query);
    const result = await renderQuery(query);

    // If the query modified the database, refresh the dropdown to keep
    // names/counts in sync; otherwise highlight the table it reads from.
    if (result && result.modified) {
        await populateTableList();
    } else {
        const tableName = result && result.columns.find(column => column.table)?.table;
        if (tableName && loadedTableNames.includes(tableName)) {
            tableSelect.setValue(tableName, true);
        } else {
            tableSelect.clear(true);
        }
    }

    setHashParam("sql", query);
}

async function setPage(el, next) {
    if ($(el).hasClass("disabled")) return;

    let page;
    if (typeof next !== "undefined") {
        page = next ? viewState.page + 1 : viewState.page - 1;
        if (page < 1) return;
    } else {
        const entered = Number(await showDialog("Go to page", String(viewState.page)));
        if (!Number.isInteger(entered) || entered < 1) return;
        page = entered;
    }

    await renderQuery(editor.toString(), page);
}

// Bumped on every render so a late background count can't overwrite a newer page.
let paginationRequest = 0;

function updatePager(currentPage, { hasNext, totalPages = null, rowCount = 0 }) {
    const pager = $("#pager");
    const pagerTitle = totalPages !== null ? `Row count: ${rowCount}` : `Page ${currentPage}`;

    // A live tooltip keeps its original title, so drop the instance and re-seed
    // the title; recreation happens here or in renderQuery's tooltip loop.
    const pagerEl = document.getElementById("pager");
    bootstrap.Tooltip.getInstance(pagerEl)?.dispose();
    pagerEl.removeAttribute("data-bs-original-title");
    pager.attr("title", pagerTitle);
    bootstrap.Tooltip.getOrCreateInstance(pagerEl);

    pager.text(totalPages !== null ? `${currentPage} / ${totalPages}` : String(currentPage));
    $("#page-prev").toggleClass("disabled", currentPage <= 1);
    $("#page-next").toggleClass("disabled", !hasNext);
    setPagerVisible(true);
}

function refreshPagination(query, page, hasMore) {
    const requestId = ++paginationRequest;
    // Show the page number right away; assume a next page while this one is full.
    updatePager(page, { hasNext: hasMore });

    // Fill in the exact page total in the background.
    sendWorkerMessage("count", { sql: query }).then(({ count }) => {
        if (requestId !== paginationRequest || typeof count !== "number") return;
        const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
        updatePager(page, { hasNext: page < totalPages, totalPages, rowCount: count });
    }).catch(() => { /* keep the provisional pager */ });
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
    const th = document.createElement("th");
    const label = document.createElement("span");
    label.dataset.bsToggle = "tooltip";
    label.title = type;
    label.textContent = name;
    th.append(label);
    return th;
}

function dataCell(value) {
    const td = document.createElement("td");
    td.title = String(value);
    td.textContent = String(value);
    return td;
}

function nullBlobCell() {
    const td = document.createElement("td");
    td.title = "Blob";
    td.textContent = "null";
    return td;
}

function blobCell(bytes) {
    const td = document.createElement("td");
    td.title = "Blob";
    const downloadLink = document.createElement("a");
    downloadLink.href = "#";
    downloadLink.textContent = `Download (${formatBytes(bytes.length)})`;
    downloadLink.addEventListener("click", (event) => {
        event.preventDefault();
        saveAs(new Blob([bytes]), "blob");
    });
    td.append(downloadLink);
    return td;
}

async function renderQuery(query, page = 1) {
    const theadRow = document.querySelector("#data thead tr");
    const tbody = document.querySelector("#data tbody");

    errorBox.hide();
    infoBox.hide();
    $("#data").show();

    let result;
    try {
        result = await sendWorkerMessage("query", { sql: query, page, pageSize: PAGE_SIZE });
    } catch (ex) {
        theadRow.replaceChildren();
        tbody.replaceChildren();
        setPagerVisible(false);
        showError(ex.message || ex);
        return null;
    }

    const { columns, values } = result;

    if (columns.length) {
        // Constraints come from PRAGMA table_info, looked up once per source
        // table; the declared type comes from the statement metadata.
        const tables = [...new Set(columns.map(column => column.table).filter(Boolean))];
        const constraints = new Map();
        await Promise.all(tables.map(async (table) => {
            constraints.set(table, await getTableConstraints(table));
        }));

        // Build everything off-DOM and insert in one pass: appending each row
        // to a live <tbody> would invalidate layout once per row.
        const headerFragment = document.createDocumentFragment();
        for (const column of columns) {
            const perTable = column.table ? constraints.get(column.table) : null;
            const constraint = perTable && column.origin ? perTable.get(column.origin) : "";
            const headerType = [column.decltype, constraint].filter(Boolean).join(" ");
            headerFragment.append(headerCell(column.name, headerType));
        }
        theadRow.replaceChildren(headerFragment);

        const bodyFragment = document.createDocumentFragment();
        for (const rowValues of values) {
            const tr = document.createElement("tr");
            for (let i = 0; i < rowValues.length; i++) {
                const columnType = (columns[i].decltype || "").toLowerCase();
                const value = rowValues[i];
                if (columnType === "blob" || columnType === "blob sub_type binary") {
                    tr.append(value === null ? nullBlobCell() : blobCell(value));
                } else {
                    tr.append(dataCell(value));
                }
            }
            bodyFragment.append(tr);
        }
        tbody.replaceChildren(bodyFragment);
    } else {
        theadRow.replaceChildren();
        tbody.replaceChildren();
        infoBox.text("No data returned for the given query.");
        infoBox.show();
    }

    if (result.paginated) {
        viewState = { query, page };
        refreshPagination(query, page, result.hasMore);
    } else {
        viewState = { query: "", page: 1 };
        setPagerVisible(false);
    }

    document.querySelectorAll('[data-bs-toggle="tooltip"]')
        .forEach(el => bootstrap.Tooltip.getOrCreateInstance(el));

    if (result.modified) markDatabaseAltered();
    return result;
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

// fflate's async API is callback-based; wrap it in a promise.
function zipFiles(files) {
    return new Promise((resolve, reject) => {
        // level 6 = DEFLATE: much smaller CSV exports for a little CPU.
        fflate.zip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
    });
}

// Base name for downloaded database files, derived from the loaded DB name.
function databaseFileName(extension) {
    const base = currentDbName.replace(/\.(sqlite3?|db3?|zip)$/i, "") || "database";
    return base + extension;
}

// The database-download items stay disabled until the in-memory database has
// actually been changed (exporting an untouched copy is pointless).
function updateDatabaseExportItems() {
    const disabled = !databaseAltered;
    $('[data-action="export-db"], [data-action="export-db-zip"]').each(function () {
        this.classList.toggle("disabled", disabled);
        this.setAttribute("aria-disabled", String(disabled));
        if (disabled) this.setAttribute("tabindex", "-1");
        else this.removeAttribute("tabindex");
    });
}

function markDatabaseAltered() {
    if (databaseAltered) return;
    databaseAltered = true;
    updateDatabaseExportItems();
}

function resetDatabaseAltered() {
    databaseAltered = false;
    updateDatabaseExportItems();
}

// Download the in-memory database, as a .sqlite file or zipped.
async function exportDatabase(zipped) {
    setIsLoading(true);
    try {
        const { buffer } = await sendWorkerMessage("export");
        const sqliteName = databaseFileName(".sqlite");
        if (zipped) {
            const zip = await zipFiles({ [sqliteName]: new Uint8Array(buffer) });
            saveAs(new Blob([zip], { type: "application/zip" }), databaseFileName(".zip"));
        } else {
            saveAs(new Blob([buffer], { type: "application/vnd.sqlite3" }), sqliteName);
        }
    } catch (e) {
        showError(e.message || e);
    }
    setIsLoading(false);
}

async function exportAllToCsv() {
    setIsLoading(true);
    try {
        const files = {};
        for (const tableName of loadedTableNames) {
            const exportedRows = await exportCsvTable(tableName);
            if (exportedRows == null) {
                setIsLoading(false);
                return;
            }
            files[tableName + ".csv"] = fflate.strToU8(arrayToCsv(exportedRows));
        }

        saveAs(new Blob([await zipFiles(files)]), "exported_all_db.zip");
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
        // The query need not target a single table, so name the file after the DB.
        saveAs(blob, databaseFileName(".csv"));
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
