class ApexLogDetails {
    constructor() {
        this.vscode = acquireVsCodeApi();
        const reportError = (stage, error) => {
            const details = error instanceof Error ? error.stack || error.message : String(error);
            this.vscode.postMessage({ type: 'diagnostic', message: `${stage}: ${details}` });
        };
        window.addEventListener('error', event => reportError('Uncaught script error', event.error || event.message));
        window.addEventListener('unhandledrejection', event => reportError('Unhandled promise rejection', event.reason));
        this.logLines = [];
        this.BUFFER_SIZE = 100;
        this.ROW_HEIGHT = 22;
        this.COLUMN_WIDTHS = ['17px', '60px', '150px', '30px', 'auto'];
        this.virtualState = {
            allRows: [],
            collapsedBlocks: new Set(),
            lastScrollTop: 0
        };
        this.searchText = '';
        this.init();
    }

    parseLogLines(logLines, hideHeapAllocate, onlyUserDebug) {
        let methodBlockId = 0;
        let methodStack = [];
        const rows = [];

        for (let idx = 0; idx < logLines.length; idx++) {
            const line = logLines[idx];
            if (/Execute Anonymous:/i.test(line)) continue;

            const parts = line.split('|');
            let timestamp = '', eventType = '', details = '', lineNumber = '';

            if (parts.length === 1) {
                details = parts[0];
            } else if (parts.length === 2) {
                [timestamp, eventType] = parts;
            } else {
                [timestamp, eventType, ...details] = parts;
                details = details.join(' | ');
            }

            timestamp = timestamp.trim()
                .replace(/\.\d+/, '')
                .replace(/\s*\(\d+\)$/, '');

            details = details.replace(/\s*\|\s*DEBUG\s*\|\s*/g, ' | ');
            const lineMatch = details.match(/^\s*\[(\d+)\]/);
            if (lineMatch) {
                lineNumber = `[${lineMatch[1]}]`;
                details = details.replace(/^\s*\[\d+\]\s*\|?\s*/, '');
            }

            // Apply filters.
            if (hideHeapAllocate && eventType === 'HEAP_ALLOCATE') continue;
            if (onlyUserDebug && eventType !== 'USER_DEBUG') continue;

            // Add rows without tracking method blocks in debug-only mode.
            if (onlyUserDebug) {
                rows.push({
                    idx,
                    timestamp,
                    eventType,
                    details,
                    blockId: null,
                    type: 'normal',
                    lineNumber
                });
                continue;
            }

            // Handle method blocks only outside debug-only mode.
            if (eventType === 'METHOD_ENTRY') {
                const depth = methodStack.length;
                methodBlockId++;
                methodStack.push({ id: methodBlockId, start: idx });
                rows.push({ idx, timestamp, eventType, details, blockId: methodBlockId, type: 'entry', lineNumber, depth });
            } else if (eventType === 'METHOD_EXIT' && methodStack.length > 0) {
                const block = methodStack.pop();
                const depth = methodStack.length;
                if (block) {
                    rows.push({ idx, timestamp, eventType, details, blockId: block.id, type: 'exit', lineNumber, depth });
                }
            } else {
                const parentBlock = methodStack.length > 0 ? methodStack[methodStack.length - 1].id : null;
                const depth = methodStack.length;
                rows.push({ idx, timestamp, eventType, details, blockId: parentBlock, type: parentBlock ? 'inner' : 'normal', lineNumber, depth });
            }
        }

        return { rows };
    }

    renderTable(hideHeapAllocate, onlyUserDebug) {
        const container = document.getElementById('log-table-container');
        const viewport = document.getElementById('virtual-viewport');
        if (!container || !viewport) return;

        // Parse the data.
        const { rows } = this.parseLogLines(this.logLines, hideHeapAllocate, onlyUserDebug);
        this.virtualState.allRows = rows;

        // Set header widths.
        const headers = document.querySelectorAll('#log-table-header th');
        headers.forEach((header, i) => {
            header.style.width = this.COLUMN_WIDTHS[i];
            header.style.minWidth = this.COLUMN_WIDTHS[i];
        });

        // Clear the content.
        const contentContainer = document.getElementById('content-container');
        contentContainer.innerHTML = '';

        // Set the container height.
        contentContainer.style.height = `${rows.length * this.ROW_HEIGHT}px`;

        // Render the initial rows.
        this.renderVisibleRows();

        // Configure scrolling only if it has not already been set up.
        viewport.removeEventListener('scroll', this.handleScrollBound);
        this.handleScrollBound = this.handleScroll.bind(this);
        viewport.addEventListener('scroll', this.handleScrollBound, { passive: true });

        // Update searchText if an input exists.
        const searchInput = document.getElementById('log-search-input');
        if (searchInput) this.searchText = searchInput.value.trim().toLowerCase();
    }

    renderVisibleRows() {
        const viewport = document.getElementById('virtual-viewport');
        const container = document.getElementById('content-container');
        if (!viewport || !container) return;

        const scrollTop = viewport.scrollTop;
        const viewportHeight = viewport.clientHeight;

        // Filter to visible rows only, without gaps.
        let filteredRows = this.virtualState.allRows;
        if (this.searchText) {
            filteredRows = filteredRows.filter(row => {
                return (
                    (row.timestamp && row.timestamp.toLowerCase().includes(this.searchText)) ||
                    (row.eventType && row.eventType.toLowerCase().includes(this.searchText)) ||
                    (row.lineNumber && row.lineNumber.toLowerCase().includes(this.searchText)) ||
                    (row.details && row.details.toLowerCase().includes(this.searchText))
                );
            });
        }
        const visibleRows = [];
        let collapseDepth = 0;
        let collapsedBlockId = null;
        for (const row of filteredRows) {
            if (collapseDepth > 0) {
                // Handle rows inside a collapsed block.
                if (row.type === 'entry' && row.blockId === collapsedBlockId) {
                    // Show only the ENTRY row of the outermost collapsed block.
                    visibleRows.push(row);
                    collapseDepth++;
                    continue;
                }
                if (row.type === 'exit' && row.blockId === collapsedBlockId) {
                    // Show only the EXIT row of the outermost collapsed block.
                    visibleRows.push(row);
                    collapseDepth--;
                    if (collapseDepth === 0) collapsedBlockId = null;
                    continue;
                }
                if (row.type === 'entry') {
                    // Enter a nested child and increase the depth.
                    collapseDepth++;
                    continue;
                }
                if (row.type === 'exit') {
                    // Exit a nested child and decrease the depth.
                    collapseDepth--;
                    continue;
                }
                // Hide all other rows inside the collapsed block.
                continue;
            }
            if (row.type === 'entry' && this.virtualState.collapsedBlocks.has(row.blockId)) {
                // Start collapsing this block.
                visibleRows.push(row);
                collapseDepth = 1;
                collapsedBlockId = row.blockId;
                continue;
            }
            visibleRows.push(row);
        }
        const totalRows = visibleRows.length;

        // Calculate the visible range for virtual scrolling.
        const startIndex = Math.max(0, Math.floor(scrollTop / this.ROW_HEIGHT) - this.BUFFER_SIZE);
        const endIndex = Math.min(
            totalRows,
            Math.ceil((scrollTop + viewportHeight) / this.ROW_HEIGHT) + this.BUFFER_SIZE
        );

        // Clear the content.
        container.innerHTML = '';
        // Set the container height to the actual number of visible rows.
        container.style.height = `${totalRows * this.ROW_HEIGHT}px`;

        // Create a document fragment for better performance.
        const fragment = document.createDocumentFragment();

        // Render only the visible rows.
        for (let i = startIndex; i < endIndex; i++) {
            const row = visibleRows[i];
            if (!row) continue;

            const rowElement = document.createElement('div');
            // Add eventType to classList for color coding
            rowElement.className = `log-row ${row.type} ${row.eventType}`;
            rowElement.style.top = `${i * this.ROW_HEIGHT}px`;

            // Collapse button cell.
            const collapseCell = document.createElement('div');
            collapseCell.className = 'log-cell';
            collapseCell.style.width = this.COLUMN_WIDTHS[0];
            if (row.type === 'entry') {
                const button = document.createElement('button');
                button.className = 'collapse-btn';
                // Use icons or characters
                button.textContent = this.virtualState.collapsedBlocks.has(row.blockId) ? '▶' : '▼';
                button.onclick = (e) => {
                    e.stopPropagation();
                    this.toggleCollapse(row.blockId);
                };
                collapseCell.appendChild(button);
            }
            rowElement.appendChild(collapseCell);

            // Data cells.
            [row.timestamp, row.eventType, row.lineNumber, row.details].forEach((text, colIndex) => {
                const cell = document.createElement('div');
                cell.className = 'log-cell';
                cell.textContent = text || '';
                cell.style.width = this.COLUMN_WIDTHS[colIndex + 1];

                // Details column (index 3) gets indentation
                if (colIndex === 3) {
                    cell.style.flex = '1';
                    if (row.depth > 0) {
                        cell.style.paddingLeft = `${row.depth * 12 + 8}px`; // 8px base padding + 12px per level
                        // Optional: Add border-left for tree guide
                        // cell.style.borderLeft = '1px solid var(--vscode-tree-indentGuidesStroke)'; 
                    }
                }

                rowElement.appendChild(cell);
            });

            fragment.appendChild(rowElement);
        }

        container.appendChild(fragment);
    }

    toggleCollapse(blockId) {
        if (this.virtualState.collapsedBlocks.has(blockId)) {
            this.virtualState.collapsedBlocks.delete(blockId);
        } else {
            this.virtualState.collapsedBlocks.add(blockId);
        }
        this.renderVisibleRows();
    }

    handleScroll() {
        requestAnimationFrame(() => this.renderVisibleRows());
    }

    handleMessage(event) {
        const data = event.data;
        if (!data.logContent) return;
        this.logLines = data.logContent.split(/\r?\n/).filter(l => l.trim().length > 0);
        this.renderTable(
            document.getElementById('hide-heap-allocate').checked,
            document.getElementById('only-user-debug').checked
        );
    }

    handleDOMContentLoaded() {
        this.vscode.postMessage({ type: 'ready' });
        ['hide-heap-allocate', 'only-user-debug'].forEach(id => {
            document.getElementById(id).addEventListener('change', () => {
                this.renderTable(
                    document.getElementById('hide-heap-allocate').checked,
                    document.getElementById('only-user-debug').checked
                );
            });
        });
        const searchInput = document.getElementById('log-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                this.searchText = searchInput.value.trim().toLowerCase();
                this.renderVisibleRows();
            });
        }
    }

    init() {
        window.addEventListener('message', this.handleMessage.bind(this));
        document.addEventListener('DOMContentLoaded', this.handleDOMContentLoaded.bind(this));
    }
}

// Initialize the viewer.
new ApexLogDetails();
