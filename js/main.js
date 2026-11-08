"use strict";

const SQL_FROM_REGEX = /FROM\s+((?=['"])((["'])(?<g1>[^'"]+))|(?<g2>\w+))/mi;
const SQL_LIMIT_REGEX = /\bLIMIT\s+(\d+)(?:\s*,\s*(\d+)|\s+OFFSET\s+(\d+))?(\s*;?\s*)$/i;

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

let lastCachedQueryCount = { select: "", count: 0 };
let loadedTableNames = [];
let currentDbKey = "default";
let editor = null;
const errorBox = $("#error");
const infoBox = $("#info");
const hashParams = new URLSearchParams(window.location.hash.substring(1));

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

const selectFormatter = function (item) {
    const index = item.text.indexOf("(");
    if (index > -1) {
        const name = item.text.substring(0, index);
        const tableName = item.text.substring(index - 1);
        const span = $("<span>");
        span.append(document.createTextNode(name));
        span.append($("<span>").css("color", "#ccc").text(tableName));
        return span;
    } else {
        return item.text;
    }
};

initialize();

function initialize() {
    let toggleFullScreen = function () {
        const container = $("#main-container");
        const resizerExpandIcon = $("#resizer-expand");
        const resizerCollapseIcon = $("#resizer-collapse");

        container.toggleClass("container container-fluid");
        resizerExpandIcon.toggle();
        resizerCollapseIcon.toggle();
    };
    $("#resizer").click(toggleFullScreen);
    $("#sql-editor").keydown(onKeyDown);

    if (typeof FileReader === "undefined" || typeof WebAssembly === "undefined") {
        $("#dropzone, #dropzone-dialog").hide();
        $("#compat-error").toggleClass("d-none", false);
    } else {
        initWorker();
        setupDragAndDrop();
    }

    //Initialize editor
    const editorElement = document.getElementById("sql-editor");
    editorElement.classList.add("language-sql");
    editor = CodeJar(editorElement, (el) => {
        Prism.highlightElement(el);
    });

    $(".no-propagate").on("click", function (el) {
        el.stopPropagation();
    });

    const loadUrlDB = hashParams.get("url");
    if (loadUrlDB != null) {
        loadRemoteDB(loadUrlDB);
    } else if (window.APP_CONFIG && window.APP_CONFIG.defaultUrl) {
        loadRemoteDB(window.APP_CONFIG.defaultUrl);
    }
}

async function loadRemoteDB(urlStr) {
    try {
        const resolvedUrl = new URL(decodeURIComponent(urlStr), window.location.href);
        currentDbKey = "url:" + encodeURIComponent(resolvedUrl.href);
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
        window.alert("Error loading remote database: " + err.message);
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
        const defaultSql = (window.APP_CONFIG && window.APP_CONFIG.defaultSql) ? window.APP_CONFIG.defaultSql : null;

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
        setIsLoading(false);
        window.alert(ex.message || ex);
    } finally {
        setIsLoading(false);
    }
}

async function populateTableList(selectFirst = false) {
    const tableList = $("#tables");
    const currentSelected = tableList.val();

    // Reset table name cache
    loadedTableNames = [];
    tableList.empty();
    tableList.append("<option></option>");

    try {
        const res = await execSql("SELECT name, type FROM sqlite_master WHERE type='table' OR type='view' ORDER BY name");

        let firstTableName = null;

        if (res) {
            for (const [name, type] of res.values) {
                if (firstTableName === null) {
                    firstTableName = name;
                }

                const rowCount = await getTableRowsCount(name);
                loadedTableNames.push(name);
                const tableType = type !== "table" ? `, ${type}` : "";
                const option = $("<option>").val(name).text(`${name} (${rowCount} rows${tableType})`);
                tableList.append(option);
            }
        }

        if (selectFirst && firstTableName !== null) {
            tableList.val(firstTableName).trigger("change.select2");
            return firstTableName;
        } else if (currentSelected && loadedTableNames.includes(currentSelected)) {
            tableList.val(currentSelected).trigger("change.select2");
            return currentSelected;
        } else {
            tableList.val(null).trigger("change.select2");
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
    if (query === lastCachedQueryCount.select) {
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
                lastCachedQueryCount.select = query;
                lastCachedQueryCount.count = count;
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

async function getTableColumnTypes(tableName) {
    let result = new Map();
    try {
        const res = await execSql(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
        if (res) {
            const rows = res.values;
            // PRAGMA table_info returns columns: cid, name, type, notnull, dflt_value, pk
            for (let i = 0; i < rows.length; i++) {
                const name = rows[i][1];
                let type = rows[i][2];
                const notnull = rows[i][3];
                const pk = rows[i][5];

                if (notnull === 1) {
                    type += " NOT NULL";
                }
                if (pk === 1) {
                    type += " PRIMARY KEY";
                }
                result.set(name, type);
            }
        }
    } catch (e) {
        console.error(e);
    }
    return result;
}

function resetTableList() {
    const tables = $("#tables");
    loadedTableNames = [];
    tables.empty();
    tables.append("<option></option>");
    tables.select2({
        placeholder: "Select a table",
        theme: "bootstrap-5",
        templateSelection: selectFormatter,
        templateResult: selectFormatter
    });
    tables.on("change", async function (e) {
        await doDefaultSelect(tables.val());
    });
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
            window.alert("Error reading file.");
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
            if (!zipEntry.dir && (
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
        }
        await loadDB(arrayBuffer);

    } catch (err) {
        setIsLoading(false);
        window.alert(err.message || err);
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

    // If query creates, drops, alters, or modifies data, refresh the dropdown to keep counts/names in sync
    const SCHEMA_MODIFY_REGEX = /\b(create|drop|alter|insert|delete|update|replace)\b/i;
    if (SCHEMA_MODIFY_REGEX.test(query)) {
        lastCachedQueryCount = { select: "", count: 0 };
        await populateTableList();
    } else {
        $("#tables").val(getTableNameFromQuery(query)).trigger("change.select2");
    }

    setHashParam("sql", query);
}

function getTableNameFromQuery(query) {
    const sqlRegex = SQL_FROM_REGEX.exec(query);
    if (sqlRegex != null) {
        return sqlRegex.groups.g1 ?? sqlRegex.groups.g2;
    } else {
        return null;
    }
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

    let pageToSet = 0;
    if (typeof next !== "undefined") {
        pageToSet = (next ? limit.currentPage : limit.currentPage - 2);
    } else {
        const page = window.prompt("Go to page");
        if (!isNaN(page) && page >= 1 && page <= limit.pages) {
            pageToSet = page - 1;
        } else {
            return;
        }
    }

    const offset = (pageToSet * limit.max);
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

function setPagerVisible(visible) {
    $("#bottom-bar").toggleClass("d-none", !visible);
    if (visible) {
        $("#footer").attr("style", "margin-top: -0.75rem !important");
    } else {
        $("#footer").css("margin-top", "");
    }
}

function htmlEncode(value) {
    return $("<div/>").text(value).html();
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
            const type = columnTypes.has(columnName) ? columnTypes.get(columnName) : "";
            thead.append(`<th><span data-bs-toggle="tooltip" title="${type}">${columnName}</span></th>`);
        }

        for (let r = 0; r < values.length; r++) {
            const tr = $('<tr>');
            const rowValues = values[r];
            for (let i = 0; i < rowValues.length; i++) {
                const columnName = columnNames[i];
                const type = columnTypes.has(columnName) ? columnTypes.get(columnName).toLowerCase() : "";
                if (type === "blob" || type === "blob sub_type binary") {
                    if (rowValues[i] === null) {
                        tr.append(`<td><span title="Blob">null</span></td>`);
                    } else {
                        renderBlobItem(tr, rowValues[i]);
                    }
                } else {
                    let value = htmlEncode(rowValues[i]);
                    tr.append(`<td><span title="${value}">${value}</span></td>`);
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
        .forEach(tooltipTriggerEl => new bootstrap.Tooltip(tooltipTriggerEl));
}

function renderBlobItem(tr, bytes) {
    const td = document.createElement("td");
    const span = document.createElement("span");
    span.title = "Blob";
    const downloadLink = document.createElement("a");
    downloadLink.href = "javascript:void(0)";
    downloadLink.innerText = `Download (${formatBytes(bytes.length)})`;
    downloadLink.onclick = function () {
        saveAs(new Blob([bytes]), "blob");
    };
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
        showError(e);
    }
    setIsLoading(false);
}

async function exportSelectedTableToCsv() {
    const tableName = $("#tables").val();
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

function clearQueryHistory() {
    if (confirm("Are you sure you want to clear history for this database?")) {
        localStorage.removeItem(getActiveStorageKey());
        renderQueryHistory();
    }
}

function clearAllDatabasesHistory() {
    if (confirm("This will permanently delete query histories for ALL databases. Proceed?")) {
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

function copyQueryToClipboard(sql) {
    const ta = document.createElement("textarea");
    ta.value = sql;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    // Append inside the offcanvas to stay within Bootstrap's focus trap
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

function renderQueryHistory() {
    const historyListContainer = $("#history-list");
    if (historyListContainer.length === 0) return;
    
    const historyList = getQueryHistory();
    
    $("#history-count").text(`${historyList.length} queries saved`);
    historyListContainer.empty();

    // Set a friendly name in the offcanvas header
    let friendlyName = "Default";
    if (currentDbKey !== "default") {
        if (currentDbKey.startsWith("url:")) {
            friendlyName = decodeURIComponent(currentDbKey.substring(4)).split("/").pop();
        } else if (currentDbKey.startsWith("file:")) {
            friendlyName = currentDbKey.substring(5).split("-")[0];
        } else if (currentDbKey.startsWith("zip:")) {
            const parts = currentDbKey.substring(4).split(":");
            friendlyName = parts.length > 1 ? parts[1].split("-")[0] : parts[0];
        }
    }
    $("#history-sidebar-label").text(`History: ${friendlyName}`);

    if (historyList.length === 0) {
        historyListContainer.append('<div class="text-center text-secondary py-5">No queries in history yet.</div>');
        return;
    }

    historyList.forEach((item, index) => {
        const dateStr = new Date(item.timestamp).toLocaleString();
        
        // Escape SQL for safe HTML rendering
        const escapedSql = item.sql
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

        const card = $(`
            <div class="card shadow-sm border-0 border-start border-3 border-primary query-card">
                <div class="card-body p-2 d-flex flex-column gap-1">
                    <div class="d-flex justify-content-between align-items-center">
                        <small class="text-secondary font-monospace" style="font-size: 0.75rem">${dateStr}</small>
                        <button class="btn btn-link p-0 text-danger text-decoration-none" style="font-size: 0.85rem" onclick="deleteHistoryItem(${index})">Delete</button>
                    </div>
                    <pre class="p-2 mb-1 overflow-x-auto" onclick="loadQueryFromHistory(decodeURIComponent('${encodeURIComponent(item.sql)}'))">${escapedSql}</pre>
                    <div class="d-flex gap-2 mt-1">
                        <button class="btn btn-sm btn-light py-0 px-2" onclick="loadQueryFromHistory(decodeURIComponent('${encodeURIComponent(item.sql)}'))">Run</button>
                        <button class="btn btn-sm btn-light py-0 px-2" onclick="copyQueryToClipboard(decodeURIComponent('${encodeURIComponent(item.sql)}'))">Copy</button>
                    </div>
                </div>
            </div>
        `);
        historyListContainer.append(card);
    });
}
