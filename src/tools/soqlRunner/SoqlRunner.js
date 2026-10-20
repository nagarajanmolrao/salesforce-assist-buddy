(function () {
    const vscode = acquireVsCodeApi();
    const byId = id => document.getElementById(id);
    const orgSelect = byId('org-select');
    const querySelect = byId('query-select');
    const queryNameInput = byId('query-name');
    const soqlEditor = byId('soql-editor');
    const parameterFields = byId('parameter-fields');
    const queryStatus = byId('query-status');
    const runButton = byId('run-query');
    const tableContainer = byId('table-container');
    const resultsMessage = byId('results-message');
    const globalSearch = byId('global-search');
    const resultCount = byId('result-count');
    let orgs = [];
    let queries = [];
    let activeQuery = null;
    let columns = [];
    let rows = [];
    let csv = '';
    let sort = { column: '', ascending: true };
    let columnFilters = {};
    let initialized = false;
    let pendingSelectionId;
    let pendingLibraryAction = '';
    const previousState = vscode.getState() || {};
    let selectedUsername = previousState.selectedUsername || '';

    function reportError(stage, error) {
        const details = error instanceof Error ? error.stack || error.message : String(error);
        vscode.postMessage({ command: 'diagnostic', message: `${stage}: ${details}` });
    }

    window.addEventListener('error', event => reportError('Uncaught script error', event.error || event.message));
    window.addEventListener('unhandledrejection', event => reportError('Unhandled promise rejection', event.reason));

    function setStatus(message, kind = '') {
        queryStatus.textContent = message;
        queryStatus.dataset.kind = kind;
    }

    function saveState() {
        vscode.setState({
            selectedUsername,
            selectedQueryId: activeQuery?.id || ''
        });
    }

    function renderOrgs(defaultUsername = '') {
        orgSelect.replaceChildren();
        for (const org of orgs) {
            const option = document.createElement('option');
            option.value = org.username;
            option.textContent = org.alias ? `${org.alias} (${org.username})` : org.username;
            orgSelect.appendChild(option);
        }
        const available = orgs.some(org => org.username === selectedUsername);
        if (!available) {
            selectedUsername = orgs.some(org => org.username === defaultUsername)
                ? defaultUsername
                : orgs[0]?.username || '';
        }
        orgSelect.value = selectedUsername;
        saveState();
    }

    function renderQueryOptions(selectedId = '') {
        querySelect.replaceChildren();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Select a saved query';
        querySelect.appendChild(placeholder);
        for (const query of queries) {
            const option = document.createElement('option');
            option.value = query.id;
            option.textContent = query.name;
            querySelect.appendChild(option);
        }
        querySelect.value = selectedId;
    }

    function extractParameterNames(soql) {
        const names = new Set();
        const pattern = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
        for (const match of soql.matchAll(pattern)) names.add(match[1]);
        return [...names];
    }

    function readParameterDefinitions() {
        return Array.from(parameterFields.querySelectorAll('.parameter')).map(field => ({
            name: field.dataset.name,
            label: field.querySelector('.parameter-label').textContent,
            type: field.querySelector('.parameter-type').value,
            defaultValue: field.querySelector('.parameter-value').value
        }));
    }

    function renderParameters() {
        const existing = new Map(readParameterDefinitions().map(parameter => [parameter.name, parameter]));
        const saved = new Map((activeQuery?.parameters || []).map(parameter => [parameter.name, parameter]));
        parameterFields.replaceChildren();

        for (const name of extractParameterNames(soqlEditor.value)) {
            const previous = existing.get(name) || saved.get(name) || {};
            const field = document.createElement('div');
            field.className = 'parameter';
            field.dataset.name = name;

            const label = document.createElement('label');
            label.className = 'parameter-label';
            label.htmlFor = `parameter-${name}`;
            label.textContent = previous.label || name;

            const type = document.createElement('select');
            type.className = 'parameter-type';
            type.setAttribute('aria-label', `${name} type`);
            for (const [value, text] of [['text', 'Text'], ['number', 'Number'], ['boolean', 'Boolean'], ['date', 'Date'], ['datetime', 'Date/time']]) {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = text;
                type.appendChild(option);
            }
            type.value = previous.type || 'text';

            let input = createParameterControl(name, type.value, previous.defaultValue || '');
            input.setAttribute('aria-label', label.textContent);
            type.addEventListener('change', () => {
                const nextInput = createParameterControl(name, type.value, '');
                nextInput.setAttribute('aria-label', label.textContent);
                field.replaceChild(nextInput, input);
                input = nextInput;
            });

            field.append(label, type, input);
            parameterFields.appendChild(field);
        }
    }

    function inputType(type) {
        if (type === 'number') return 'number';
        if (type === 'date') return 'date';
        if (type === 'datetime') return 'datetime-local';
        return 'text';
    }

    function createParameterControl(name, type, value) {
        if (type === 'boolean') {
            const select = document.createElement('select');
            select.className = 'parameter-value';
            select.id = `parameter-${name}`;
            for (const [optionValue, text] of [['', 'Select'], ['true', 'True'], ['false', 'False']]) {
                const option = document.createElement('option');
                option.value = optionValue;
                option.textContent = text;
                select.appendChild(option);
            }
            select.value = value;
            return select;
        }
        const input = document.createElement('input');
        input.className = 'parameter-value';
        input.id = `parameter-${name}`;
        input.type = inputType(type);
        input.value = value;
        return input;
    }

    function createQuery() {
        const parameters = readParameterDefinitions();
        return {
            id: activeQuery?.id || 'unsaved-query',
            name: queryNameInput.value.trim() || 'Unsaved query',
            soql: soqlEditor.value.trim(),
            parameters
        };
    }

    function selectQuery(query) {
        activeQuery = query || null;
        querySelect.value = query?.id || '';
        queryNameInput.value = query?.name || '';
        soqlEditor.value = query?.soql || '';
        parameterFields.replaceChildren();
        renderParameters();
        byId('delete-query').disabled = !query;
        saveState();
    }

    function updateQueryLibrary(nextQueries, selectedId) {
        queries = nextQueries;
        renderQueryOptions(selectedId);
        const selected = queries.find(query => query.id === selectedId);
        if (selected) selectQuery(selected);
        else if (activeQuery && queries.some(query => query.id === activeQuery.id)) {
            renderQueryOptions(activeQuery.id);
        } else {
            selectQuery(queries[0] || null);
        }
    }

    function visibleRows() {
        const search = globalSearch.value.trim().toLocaleLowerCase();
        return rows.filter(row => {
            if (search && !columns.some(column => String(row[column] ?? '').toLocaleLowerCase().includes(search))) return false;
            return columns.every(column => {
                const filter = (columnFilters[column] || '').trim().toLocaleLowerCase();
                return !filter || String(row[column] ?? '').toLocaleLowerCase().includes(filter);
            });
        }).sort((left, right) => {
            if (!sort.column) return 0;
            const a = String(left[sort.column] ?? '').toLocaleLowerCase();
            const b = String(right[sort.column] ?? '').toLocaleLowerCase();
            const comparison = a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
            return sort.ascending ? comparison : -comparison;
        });
    }

    function renderResults() {
        tableContainer.replaceChildren();
        const filtered = visibleRows();
        resultCount.textContent = `${filtered.length} of ${rows.length} rows`;
        byId('download-csv').disabled = !csv;
        globalSearch.disabled = rows.length === 0;

        if (!columns.length) {
            tableContainer.hidden = true;
            resultsMessage.hidden = false;
            resultsMessage.textContent = rows.length ? 'No columns were returned.' : 'The query returned no records.';
            return;
        }

        resultsMessage.hidden = true;
        tableContainer.hidden = false;
        const table = document.createElement('table');
        const head = document.createElement('thead');
        const headingRow = document.createElement('tr');
        for (const column of columns) {
            const heading = document.createElement('th');
            const sortButton = document.createElement('button');
            sortButton.type = 'button';
            sortButton.className = 'sort-button';
            sortButton.textContent = `${column}${sort.column === column ? (sort.ascending ? ' ▲' : ' ▼') : ''}`;
            sortButton.addEventListener('click', () => {
                sort = { column, ascending: sort.column === column ? !sort.ascending : true };
                renderResults();
            });
            const filter = document.createElement('input');
            filter.className = 'column-filter';
            filter.type = 'search';
            filter.dataset.column = column;
            filter.value = columnFilters[column] || '';
            filter.placeholder = `Filter ${column}`;
            filter.setAttribute('aria-label', `Filter ${column}`);
            filter.addEventListener('input', () => {
                const cursor = filter.selectionStart ?? filter.value.length;
                columnFilters[column] = filter.value;
                renderResults();
                const refreshedFilter = Array.from(tableContainer.querySelectorAll('.column-filter'))
                    .find(input => input.dataset.column === column);
                refreshedFilter?.focus();
                refreshedFilter?.setSelectionRange(cursor, cursor);
            });
            heading.append(sortButton, filter);
            headingRow.appendChild(heading);
        }
        head.appendChild(headingRow);

        const body = document.createElement('tbody');
        for (const row of filtered) {
            const tableRow = document.createElement('tr');
            for (const column of columns) {
                const cell = document.createElement('td');
                cell.textContent = row[column] ?? '';
                cell.title = cell.textContent;
                tableRow.appendChild(cell);
            }
            body.appendChild(tableRow);
        }
        table.append(head, body);
        tableContainer.appendChild(table);
    }

    function downloadCsv() {
        if (!csv) return;
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `soql-results-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    byId('refresh-orgs').addEventListener('click', () => {
        setStatus('Refreshing authenticated orgs...');
        vscode.postMessage({ command: 'refreshOrgs' });
    });

    orgSelect.addEventListener('change', () => {
        selectedUsername = orgSelect.value;
        saveState();
    });

    querySelect.addEventListener('change', () => {
        selectQuery(queries.find(query => query.id === querySelect.value));
    });

    soqlEditor.addEventListener('input', renderParameters);

    byId('new-query').addEventListener('click', () => {
        querySelect.value = '';
        selectQuery(null);
        setStatus('');
    });

    byId('save-query').addEventListener('click', () => {
        const query = createQuery();
        if (!query.name || query.name === 'Unsaved query' || !query.soql) {
            setStatus('Enter a query name and SOQL before saving.', 'error');
            return;
        }
        if (!query.id || query.id === 'unsaved-query') {
            query.id = `query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        }
        pendingSelectionId = query.id;
        pendingLibraryAction = 'save';
        vscode.postMessage({ command: 'saveQuery', query });
        setStatus('Saving query...');
    });

    byId('delete-query').addEventListener('click', () => {
        if (activeQuery) {
            pendingLibraryAction = 'delete';
            vscode.postMessage({ command: 'deleteQuery', id: activeQuery.id });
        }
    });

    byId('open-library').addEventListener('click', () => vscode.postMessage({ command: 'openLibrary' }));
    byId('reload-library').addEventListener('click', () => {
        pendingLibraryAction = 'reload';
        vscode.postMessage({ command: 'reloadLibrary' });
    });
    byId('run-query').addEventListener('click', () => {
        runButton.disabled = true;
        setStatus(`Running query in ${selectedUsername}...`);
        vscode.postMessage({
            command: 'runQuery',
            username: selectedUsername,
            query: createQuery(),
            values: Object.fromEntries(readParameterDefinitions().map(parameter => [parameter.name, parameter.defaultValue]))
        });
    });
    byId('download-csv').addEventListener('click', downloadCsv);
    globalSearch.addEventListener('input', renderResults);

    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'initialize') {
            initialized = true;
            orgs = message.orgs || [];
            queries = message.queries || [];
            selectedUsername = previousState.selectedUsername || message.defaultUsername || '';
            renderOrgs(message.defaultUsername);
            renderQueryOptions(previousState.selectedQueryId || '');
            const selected = queries.find(query => query.id === querySelect.value) || queries[0];
            selectQuery(selected);
            setStatus(message.orgError || (message.queryFile ? `Query library: ${message.queryFile}` : 'Ready'), message.orgError ? 'error' : '');
        } else if (message.type === 'orgs') {
            orgs = message.orgs || [];
            renderOrgs(message.defaultUsername);
            setStatus('Authenticated org list refreshed.');
        } else if (message.type === 'queryLibrary') {
            const action = pendingLibraryAction;
            const selectedId = pendingSelectionId || activeQuery?.id;
            pendingSelectionId = undefined;
            pendingLibraryAction = '';
            if (action === 'reload') {
                queries = message.queries || [];
                renderQueryOptions(activeQuery && queries.some(query => query.id === activeQuery.id) ? activeQuery.id : '');
            } else {
                updateQueryLibrary(message.queries || [], selectedId);
            }
            setStatus(`Saved queries updated: ${message.queryFile}`);
        } else if (message.type === 'queryResults') {
            runButton.disabled = false;
            columns = message.columns || [];
            rows = message.rows || [];
            csv = message.csv || '';
            columnFilters = {};
            sort = { column: '', ascending: true };
            globalSearch.value = '';
            renderResults();
            resultsMessage.hidden = columns.length > 0;
            if (!rows.length && columns.length) resultsMessage.textContent = 'The query returned no records.';
            setStatus(`Query completed in ${selectedUsername}.`);
        } else if (message.type === 'error') {
            runButton.disabled = false;
            setStatus(message.message || 'The operation failed.', 'error');
            if (message.operation === 'query') {
                rows = [];
                columns = [];
                csv = '';
                renderResults();
                resultsMessage.textContent = message.message || 'The query failed.';
            }
        }
    });

    if (!initialized) vscode.postMessage({ command: 'ready' });
})();
