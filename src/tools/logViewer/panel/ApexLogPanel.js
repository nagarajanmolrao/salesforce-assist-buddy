(function () {
    const vscode = acquireVsCodeApi();
    function reportError(stage, error) {
        const details = error instanceof Error ? error.stack || error.message : String(error);
        vscode.postMessage({ command: 'diagnostic', message: `${stage}: ${details}` });
    }
    window.addEventListener('error', event => reportError('Uncaught script error', event.error || event.message));
    window.addEventListener('unhandledrejection', event => reportError('Unhandled promise rejection', event.reason));
    let lastData = [];
    let columnWidths = new Map();
    let resizingColumn = null;
    let startX = 0;
    let startWidth = 0;
    let sortConfig = { field: null, ascending: true };
    let activeResizeHandle = null;
    let isInitialized = false;
    let readLogIds = new Set(); // Track which logs have been read
    const toolSelector = document.getElementById('tool-selector');
    let availableOperationTypes = [];
    let selectedOperationTypes = null;
    const operationFilter = document.getElementById('operation-filter');
    const operationFilterAll = document.getElementById('operation-filter-all');
    let logViewerActive = true;

    function setLogViewerActive(active) {
        logViewerActive = active;
        operationFilter.hidden = !active;
        if (!active) {
            operationFilter.open = false;
            document.getElementById('inline-search-bar').style.display = 'none';
        }
    }

    function renderOperationFilter(filter) {
        if (!filter) return;
        availableOperationTypes = filter.available;
        selectedOperationTypes = filter.selected;
        operationFilterAll.checked = selectedOperationTypes === null;
        operationFilterAll.indeterminate = selectedOperationTypes !== null && selectedOperationTypes.length > 0;
        document.getElementById('operation-filter-summary').textContent = selectedOperationTypes === null
            ? 'Log types: All' : `Log types: ${selectedOperationTypes.length} selected`;
        const options = document.getElementById('operation-filter-options');
        options.replaceChildren();
        for (const operation of availableOperationTypes) {
            const label = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = selectedOperationTypes === null || selectedOperationTypes.includes(operation);
            checkbox.addEventListener('change', () => {
                const selected = new Set(selectedOperationTypes === null ? availableOperationTypes : selectedOperationTypes);
                if (checkbox.checked) selected.add(operation);
                else selected.delete(operation);
                const nextSelection = [...selected];
                renderOperationFilter({ available: availableOperationTypes, selected: nextSelection });
                vscode.postMessage({ command: 'filterOperations', selected: nextSelection });
            });
            label.append(checkbox, document.createTextNode(operation));
            options.appendChild(label);
        }
    }

    operationFilterAll.addEventListener('change', () => {
        const selected = operationFilterAll.checked ? null : [];
        renderOperationFilter({ available: availableOperationTypes, selected });
        vscode.postMessage({ command: 'filterOperations', selected });
    });

    document.addEventListener('click', event => {
        if (!operationFilter.contains(event.target)) operationFilter.open = false;
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && operationFilter.open) {
            operationFilter.open = false;
            operationFilter.querySelector('summary').focus();
        }
    });
    const savedState = vscode.getState() || {};
    let activeToolId = toolSelector?.value || 'log-viewer';
    if (toolSelector && Array.from(toolSelector.options).some(option => option.value === savedState.activeToolId)) {
        activeToolId = savedState.activeToolId;
        toolSelector.value = activeToolId;
    }

    // On load, always clear any cached data to ensure only fresh logs are shown
    try {
        vscode.setState({
            data: [],
            columnWidths: Array.from(columnWidths.entries()),
            sortConfig,
            readLogIds: Array.from(readLogIds),
            activeToolId
        });
        lastData = [];
    } catch (e) {
        reportError('Failed to clear state on load', e);
    }

    // Initialize state
    try {
        const state = vscode.getState() || {};
        lastData = state.data || [];
        columnWidths = new Map(state.columnWidths || []);
        sortConfig = state.sortConfig || { field: null, ascending: true };
        readLogIds = new Set(state.readLogIds || []); // Restore read states
    } catch (e) {
        reportError('Failed to restore state', e);
    }

    function saveState() {
        try {
            vscode.setState({
                data: lastData,
                columnWidths: Array.from(columnWidths.entries()),
                sortConfig,
                readLogIds: Array.from(readLogIds), // Save read states
                activeToolId
            });
        } catch (e) {
            reportError('Failed to save state', e);
        }
    }

    // Initialize column widths from the header and store default values
    function initializeColumnWidths() {
        const defaultWidths = {
            'user': 150,
            'time': 80,
            'status': 80,
            'size': 70,
            'operation': 400,
            'duration': 80
        };

        const headerCells = document.querySelectorAll('#grid-header .grid-cell');
        headerCells.forEach(cell => {
            const field = cell.dataset.field;
            // Use stored width, default width, or actual width in that order
            const width = columnWidths.get(field) || defaultWidths[field] || cell.offsetWidth;
            columnWidths.set(field, width);
            cell.style.width = `${width}px`;
            cell.style.flex = `0 0 ${width}px`;
        });

        saveState();
    }

    function initializeResizeHandles() {
        const headerCells = document.querySelectorAll('#grid-header .grid-cell');
        headerCells.forEach(cell => {
            // Remove existing handlers and resize handles
            const existingHandle = cell.querySelector('.resize-handle');
            if (existingHandle) {
                existingHandle.remove();
            }

            // Create new resize handle
            const handle = document.createElement('div');
            handle.className = 'resize-handle';
            handle.addEventListener('mousedown', startResize);
            cell.appendChild(handle);

            // Remove existing click handlers
            cell.removeEventListener('click', cell.sortHandler);

            // Add new click handler for sorting
            cell.sortHandler = (e) => {
                if (e.target === cell) {
                    const field = cell.dataset.field;
                    sortByColumn(field);
                }
            };
            cell.addEventListener('click', cell.sortHandler);

            // Update sort indicator
            updateSortIndicator(cell);
        });
    }

    function timeToComparableValue(timeStr) {
        // New format: 'HH:mm:ss|||HH:mm:ss DD/MM/YYYY|||timestamp'.
        if (typeof timeStr === 'string' && timeStr.includes('|||')) {
            const parts = timeStr.split('|||');
            if (parts.length === 3) {
                return parseInt(parts[2], 10);
            }
        }
        // Fallback: try parsing the previous format.
        const [timePart, datePart] = timeStr.split(' ');
        if (!timePart || !datePart) return 0;
        const [hours, minutes, seconds] = timePart.split(':').map(Number);
        const [day, month, year] = datePart.split('/').map(Number);
        return new Date(year, month - 1, day, hours, minutes, seconds).getTime();
    }

    function sortData(data, field, ascending) {
        return [...data].sort((a, b) => {
            let aVal = a[field];
            let bVal = b[field];

            if (field === 'time') {
                aVal = timeToComparableValue(aVal);
                bVal = timeToComparableValue(bVal);

                return ascending ? aVal - bVal : bVal - aVal;
            }

            if (field === 'size') {
                // aVal y bVal son strings tipo '1.2MB' o '900.0KB'
                function parseSize(val) {
                    if (typeof val !== 'string') return 0;
                    if (val.endsWith('MB')) return parseFloat(val) * 1024 * 1024;
                    if (val.endsWith('KB')) return parseFloat(val) * 1024;
                    return parseFloat(val) || 0;
                }
                aVal = parseSize(aVal);
                bVal = parseSize(bVal);
                return ascending ? aVal - bVal : bVal - aVal;
            }

            if (field === 'duration') {
                // aVal y bVal son strings tipo '  1.23 s' o '   900 ms'
                function parseDuration(val) {
                    if (typeof val !== 'string') return 0;
                    val = val.trim();
                    // Extrae el número y la unidad correctamente
                    const match = val.match(/^([\d.,]+)\s*(ms|s)$/);
                    if (!match) return parseFloat(val) || 0;
                    const num = parseFloat(match[1].replace(',', '.'));
                    const unit = match[2];
                    if (unit === 's') return num * 1000;
                    if (unit === 'ms') return num;
                    return num;
                }
                aVal = parseDuration(aVal);
                bVal = parseDuration(bVal);
                return ascending ? aVal - bVal : bVal - aVal;
            }

            aVal = String(aVal || '').toLowerCase();
            bVal = String(bVal || '').toLowerCase();
            return ascending ?
                aVal.localeCompare(bVal) :
                bVal.localeCompare(aVal);
        });
    }

    function sortByColumn(field) {
        if (sortConfig.field === field) {
            sortConfig.ascending = !sortConfig.ascending;
        } else {
            sortConfig.field = field;
            sortConfig.ascending = true;
        }

        const sortedData = sortData(lastData, field, sortConfig.ascending);
        updateGrid(sortedData);

        document.querySelectorAll('#grid-header .grid-cell').forEach(cell => {
            updateSortIndicator(cell);
        });

        saveState();
    }

    function updateSortIndicator(cell) {
        const existingIndicator = cell.querySelector('.sort-indicator');
        if (existingIndicator) {
            existingIndicator.remove();
        }

        const field = cell.dataset.field;
        if (sortConfig.field === field) {
            const indicator = document.createElement('span');
            indicator.className = 'sort-indicator';
            indicator.textContent = sortConfig.ascending ? ' ↑' : ' ↓';
            cell.appendChild(indicator);
        }
    }

    function startResize(e) {
        e.preventDefault();
        const handle = e.target;
        const cell = handle.parentElement;
        resizingColumn = cell;
        startX = e.pageX;
        startWidth = cell.offsetWidth;
        activeResizeHandle = handle;

        document.body.classList.add('resizing');
        handle.style.backgroundColor = 'var(--vscode-focusBorder)';

        document.addEventListener('mousemove', resize);
        document.addEventListener('mouseup', stopResize);
    }

    function resize(e) {
        if (!resizingColumn) return;

        const width = Math.max(50, startWidth + (e.pageX - startX));
        const field = resizingColumn.dataset.field;

        resizingColumn.style.width = `${width}px`;
        resizingColumn.style.flex = `0 0 ${width}px`;

        const bodyCells = document.querySelectorAll(`#grid-body .grid-cell[data-field="${field}"]`);
        bodyCells.forEach(cell => {
            cell.style.width = `${width}px`;
            cell.style.flex = `0 0 ${width}px`;

            delete cell.dataset.truncated;
            cell.removeAttribute('title');

            const content = cell.textContent;
            const tempSpan = document.createElement('span');
            tempSpan.style.visibility = 'hidden';
            tempSpan.style.position = 'absolute';
            tempSpan.style.whiteSpace = 'nowrap';
            tempSpan.textContent = content;
            document.body.appendChild(tempSpan);

            const contentWidth = tempSpan.offsetWidth;
            document.body.removeChild(tempSpan);

            const availableWidth = width - 12;

            if (contentWidth > availableWidth) {
                cell.dataset.truncated = 'true';
                cell.title = content;
            }
        });

        columnWidths.set(field, width);
        saveState();
    }

    function stopResize() {
        if (!resizingColumn || !activeResizeHandle) return;

        saveState();
    }

    function resize(e) {
        if (!resizingColumn) return;

        const width = Math.max(50, startWidth + (e.pageX - startX));
        const field = resizingColumn.dataset.field;

        resizingColumn.style.width = `${width}px`;
        resizingColumn.style.flex = `0 0 ${width}px`;

        const bodyCells = document.querySelectorAll(`#grid-body .grid-cell[data-field="${field}"]`);
        bodyCells.forEach(cell => {
            cell.style.width = `${width}px`;
            cell.style.flex = `0 0 ${width}px`;

            delete cell.dataset.truncated;
            cell.removeAttribute('title');

            const content = cell.textContent;
            const tempSpan = document.createElement('span');
            tempSpan.style.visibility = 'hidden';
            tempSpan.style.position = 'absolute';
            tempSpan.style.whiteSpace = 'nowrap';
            tempSpan.textContent = content;
            document.body.appendChild(tempSpan);

            const contentWidth = tempSpan.offsetWidth;
            document.body.removeChild(tempSpan);

            const availableWidth = width - 12;

            if (contentWidth > availableWidth) {
                cell.dataset.truncated = 'true';
                cell.title = content;
            }
        });

        columnWidths.set(field, width);
        saveState();
    }

    function stopResize() {
        if (!resizingColumn || !activeResizeHandle) return;

        document.body.classList.remove('resizing');
        activeResizeHandle.style.backgroundColor = '';
        resizingColumn = null;
        activeResizeHandle = null;

        document.removeEventListener('mousemove', resize);
        document.removeEventListener('mouseup', stopResize);

        saveState();
    }

    function updateGrid(data, errorInfo) {
        const gridBody = document.getElementById('grid-body');
        if (!gridBody) {
            reportError('Grid update stopped', 'Grid body element not found');
            return;
        }

        // Capture scroll position before clearing
        const scrollTop = gridBody.scrollTop;
        gridBody.innerHTML = '';

        if (errorInfo && errorInfo.hasError) {
            // Show error fallback UI
            const errorMsg = document.createElement('div');
            errorMsg.className = 'empty-message';
            errorMsg.style.color = 'var(--vscode-editorError-foreground, #f14c4c)';
            errorMsg.style.fontSize = '1.3em';
            errorMsg.style.fontWeight = 'bold';
            errorMsg.style.background = 'var(--vscode-editor-background, #fff0f0)';
            errorMsg.style.border = '2px solid var(--vscode-editorError-foreground, #f14c4c)';
            errorMsg.style.borderRadius = '8px';
            errorMsg.style.margin = '32px auto';
            errorMsg.style.maxWidth = '500px';
            errorMsg.style.padding = '24px';
            errorMsg.innerHTML = `<b>Something went wrong.</b><br><span style='color:var(--vscode-descriptionForeground);font-size:1em;'>Check the output channel for details.<br>To retry, please click the <b>Refresh</b> button.</span>`;
            gridBody.appendChild(errorMsg);
            return;
        }

        if (!isInitialized) {
            initializeColumnWidths();
            initializeResizeHandles();
            isInitialized = true;
        }

        // Store current states before update
        const currentStates = new Map();
        document.querySelectorAll('.grid-row').forEach(row => {
            const logId = row.querySelector('[data-log-id]')?.dataset.logId;
            if (logId) {
                currentStates.set(logId, {
                    read: row.dataset.read === 'true',
                    downloading: row.dataset.downloading === 'true',
                    selected: row.classList.contains('selected')
                });
            }
        });

        lastData = data;

        // If no data, show empty message and clear cache
        if (!data || data.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.className = 'empty-message';
            emptyMsg.textContent = 'No logs match the current filters in the latest 100 records.';
            gridBody.appendChild(emptyMsg);
            lastData = [];
            // Clear cached state
            vscode.setState({
                data: [],
                columnWidths: Array.from(columnWidths.entries()),
                sortConfig,
                readLogIds: Array.from(readLogIds)
            });
            return;
        }

        if (sortConfig.field) {
            data = sortData(data, sortConfig.field, sortConfig.ascending);
        }

        const fragment = document.createDocumentFragment();

        data.forEach(row => {
            const previousState = currentStates.get(row.id);
            const rowDiv = createRow(row, previousState);
            if (previousState?.selected) {
                rowDiv.classList.add('selected');
            }
            fragment.appendChild(rowDiv);
        });

        gridBody.appendChild(fragment);

        // Restore scroll position
        if (scrollTop > 0) {
            gridBody.scrollTop = scrollTop;
        }

        saveState();
    }

    function createRow(rowData, previousState = null) {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'grid-row';

        // Set initial states based on previous state, readLogIds, or uiStatus
        let isRead = previousState ? previousState.read : (rowData.uiStatus === 'downloaded' || readLogIds.has(rowData.id));

        // If the log is downloaded, ensure downloading is false and remove any success/green state
        if (rowData.uiStatus === 'downloaded') {
            rowDiv.dataset.downloading = 'false';
            rowDiv.dataset.read = 'true';
            isRead = true;
        } else {
            rowDiv.dataset.downloading = previousState ? previousState.downloading.toString() : 'false';
            rowDiv.dataset.read = isRead.toString();
        }

        const idCell = document.createElement('div');
        idCell.style.display = 'none';
        idCell.dataset.logId = rowData.id;
        rowDiv.appendChild(idCell);

        rowDiv.onclick = () => {
            document.querySelectorAll('.grid-row.selected').forEach(row => {
                if (row !== rowDiv) {
                    row.classList.remove('selected');
                }
            });
            rowDiv.classList.add('selected');
            rowDiv.dataset.downloading = 'true';

            vscode.postMessage({
                command: 'openLog',
                log: { id: rowData.id }
            });
        };

        const fields = ['user', 'time', 'status', 'size', 'operation', 'duration'];
        fields.forEach(field => {
            const cell = document.createElement('div');
            cell.className = 'grid-cell';
            cell.dataset.field = field;
            let timeTooltip = undefined;
            let displayText = rowData[field];
            
            if (field === 'time' && typeof rowData[field] === 'string' && rowData[field].includes('|||')) {
                const [display, tooltip] = rowData[field].split('|||');
                displayText = display;
                cell.title = tooltip;
                timeTooltip = tooltip;
            }
            
            if (field === 'operation' && displayText.includes('UniversalPerfLogger')) {
                cell.innerHTML = displayText.replace(/UniversalPerfLogger/g, '<span style="color: #170CED;">UniversalPerfLogger</span>');
            } else {
                cell.textContent = displayText;
            }
            
            const width = columnWidths.get(field);
            if (width) {
                cell.style.width = `${width}px`;
                cell.style.flex = `0 0 ${width}px`;
                const tempSpan = document.createElement('span');
                tempSpan.style.visibility = 'hidden';
                tempSpan.style.position = 'absolute';
                tempSpan.style.whiteSpace = 'nowrap';
                tempSpan.textContent = (field === 'time' && typeof rowData[field] === 'string' && rowData[field].includes('|||'))
                    ? rowData[field].split('|||')[0]
                    : rowData[field];
                document.body.appendChild(tempSpan);
                const contentWidth = tempSpan.offsetWidth;
                document.body.removeChild(tempSpan);
                const availableWidth = width - 12;
                if (contentWidth > availableWidth) {
                    cell.dataset.truncated = 'true';
                    // For 'time', always use the friendly tooltip, not the raw value
                    if (field === 'time' && timeTooltip) {
                        cell.title = timeTooltip;
                    } else {
                        cell.title = rowData[field];
                    }
                }
            }

            rowDiv.appendChild(cell);
        });

        return rowDiv;
    }

    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'updateData') {
            setLogViewerActive(message.toolActive !== false);
            renderOperationFilter(message.operationFilter);
            // Support error fallback
            updateGrid(message.data, message.errorInfo || null);
        } else if (message.type === 'toolActivity') {
            setLogViewerActive(message.active === true);
        } else if (message.type === 'logDownloaded') {
            // When a log is downloaded, update its state
            const logId = message.logId;
            const row = document.querySelector(`[data-log-id="${logId}"]`)?.parentElement;
            if (row) {
                row.dataset.downloading = 'false';
                row.dataset.read = 'true';
                readLogIds.add(logId);
                saveState();
            }
        } else if (message.type === 'showSearchBox') {
            showInlineSearchBox();
        } else if (message.type === 'orgChanged') {
            // Hide search bar on org change only
            const searchBar = document.getElementById('inline-search-bar');
            if (searchBar && searchBar.style.display === 'flex') {
                searchBar.style.display = 'none';
            }
        }
    });

    // Debounce search so it is not triggered on every keystroke.
    function debounce(fn, delay) {
        let timer = null;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    }

    function showInlineSearchBox() {
        if (!logViewerActive) return;
        const searchBar = document.getElementById('inline-search-bar');
        const input = document.getElementById('inline-search-input');
        if (searchBar && input) {
            if (searchBar.style.display === 'flex') {
                searchBar.style.display = 'none';
                vscode.postMessage({ command: 'inlineSearch', text: '' });
            } else {
                searchBar.style.display = 'flex';
                input.value = '';
                input.focus();
                // Use debounce for search
                const debouncedSearch = debounce(() => {
                    vscode.postMessage({ command: 'inlineSearch', text: input.value });
                }, 200);
                input.oninput = debouncedSearch;
                input.onkeydown = (e) => {
                    if (e.key === 'Escape') {
                        searchBar.style.display = 'none';
                        vscode.postMessage({ command: 'inlineSearch', text: '' });
                    }
                };
            }
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        toolSelector?.addEventListener('change', () => {
            const requestedToolId = toolSelector.value;
            toolSelector.value = activeToolId;
            saveState();
            vscode.postMessage({ command: 'selectTool', toolId: requestedToolId });
        });
        vscode.postMessage({ command: 'ready' });
        const gridBody = document.getElementById('grid-body');
        const gridHeader = document.getElementById('grid-header');
        if (gridBody && gridHeader) {
            gridBody.addEventListener('scroll', () => {
                gridHeader.style.transform = `translateX(-${gridBody.scrollLeft}px)`;
            });
        }
        if (lastData.length > 0) {
            updateGrid(lastData);
        }
    });

    // Listen for Ctrl+F to open the search bar
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            showInlineSearchBox();
        }
    });
})();