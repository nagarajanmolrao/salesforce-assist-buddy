import * as vscode from 'vscode';
import { Connection } from 'jsforce';
import { ApexLog, ApexLogRecord } from './ApexLogWrapper';
import { ApexLogFileManager } from './ApexLogFileManager';
import { ensureTraceFlag } from './TraceFlagManager';
import { logger } from '../../core/logger';
import { retryOnSessionExpire } from '../../core/connection';
import { IApexLogPanelProvider } from './panel/IApexLogPanelProvider';
import { getConfiguration } from '../../core/extensionIdentity';

export interface LogDataChangeEvent {
    data: any[];
    isAutoRefresh: boolean;
}

export class LogDataProvider implements vscode.Disposable {
    private readonly _onDidChangeData = new vscode.EventEmitter<LogDataChangeEvent>();
    readonly onDidChangeData = this._onDidChangeData.event;

    private logs: ApexLog[] = [];
    private filteredLogs: ApexLog[] = [];
    private searchText: string = '';
    private autoRefreshScheduledId?: NodeJS.Timeout;
    private autoRefreshPaused: boolean = true;
    private isRefreshing: boolean = false;
    private currentUserId?: string;
    public readonly logFileManager: ApexLogFileManager;
    private readonly context: vscode.ExtensionContext;
    private _isVisible: boolean = false;
    private activeProvider?: IApexLogPanelProvider;
    private readonly operationTypes: Set<string>;
    private selectedOperationTypes: string[] | null;

    constructor(
        context: vscode.ExtensionContext,
        public connection: Connection,
        private readonly config: {
            autoRefresh: boolean;
            refreshInterval: number;
            currentUserOnly: boolean;
        },
        activeProvider?: IApexLogPanelProvider
    ) {
        this.context = context;
        this.operationTypes = new Set([
            'UniversalPerfLogger', '/webruntime/api/execute', '/aura',
            'execute_anonymous_apex', 'BatchApex', 'FutureHandler', 'Queueable', 'ScheduledApex',
            ...context.workspaceState.get<string[]>('logViewer.operationTypes', [])
        ]);
        this.selectedOperationTypes = context.workspaceState.get<string[] | null>('logViewer.selectedOperationTypes', null);
        this.activeProvider = activeProvider;
        this.logFileManager = new ApexLogFileManager(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, activeProvider);
        this.logs = [];
        this.filteredLogs = [];
        this.autoRefreshPaused = !this.config.autoRefresh;
        // Do NOT start auto-refresh here. Only start when panel is visible.
    }

    static async create(
        context: vscode.ExtensionContext,
        connection: Connection,
        config: {
            autoRefresh: boolean;
            refreshInterval: number;
            currentUserOnly: boolean;
        },
        activeProvider?: IApexLogPanelProvider
    ): Promise<LogDataProvider> {
        const provider = new LogDataProvider(context, connection, config, activeProvider);
        await provider.initialize();
        return provider;
    }

    public setActiveProvider(provider: IApexLogPanelProvider) {
        this.activeProvider = provider;
        this.logFileManager.setProvider(provider);
    }

    public get isVisible(): boolean {
        return this._isVisible;
    }

    // Initialize the LogDataProvider.
    // Ensure the trace flag is active for the current user.
    private async initialize() {
        let errorInfo;
        try {
            this.currentUserId ??= await this.getCurrentUserId();
            // Always create trace flag for the current user, regardless of mode
            if (this.currentUserId) {
                void logger.run('Provider.initializeTraceFlag', () => ensureTraceFlag(this.connection, this.currentUserId!))
                    .catch(error => logger.error('Provider.initializeTraceFlag', 'Trace flag setup failed; existing logs remain available', error));
            }
            // Do NOT call refreshLogs here or anywhere except when panel is visible.
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error('Provider.initialize', 'Initialization incomplete; trace flag may not be active', error);
            errorInfo = { hasError: true, message: errorMessage };
        }
        if (errorInfo && this.activeProvider?.updateView) {
            this.activeProvider.updateView(this.getGridData(), false, errorInfo);
        }
    }

    dispose() {
        this._onDidChangeData.dispose();
        this.stopAutoRefresh();
    }

    private _notifyDataChange(isAutoRefresh: boolean) {
        const gridData = this.getGridData();
        this._onDidChangeData.fire({ data: gridData, isAutoRefresh });
    }

    // Refresh the Apex logs from the Salesforce org.
    public async refreshLogs(isInitialLoad: boolean = false, isAutoRefresh: boolean = false): Promise<void> {
        if (this.isRefreshing) {
            logger.debug('Logs.refresh', 'Skipped: another refresh is still running');
            return;
        }
        this.isRefreshing = true;
        let errorInfo: { hasError: boolean, message?: string } | undefined = undefined;
        // Build the query to retrieve Apex logs.
        // If currentUserOnly is enabled, filter by the current user's ID.
        let query = 'SELECT Id, Application, DurationMilliseconds, LogLength, LogUser.Name, Operation, Request, StartTime, Status FROM ApexLog';
        if (this.config.currentUserOnly && this.currentUserId) {
            query += ` WHERE LogUserId = '${this.currentUserId}'`;
        }
        query += ' ORDER BY StartTime DESC LIMIT 100';

        try {
            const result = await logger.run('Logs.refresh.query', () => retryOnSessionExpire(async (conn) => await conn.tooling.query(query), this)) as { records: ApexLogRecord[] };
            logger.debug('Logs.refresh', `Received ${result.records?.length ?? 0} records; initial=${isInitialLoad}, auto=${isAutoRefresh}`);

            if (!result.records || result.records.length === 0) {
                // Clear the logs array so the user sees an empty state when the org has no records.
                this.logs = [];
                this.filteredLogs = [];
            } else {
                // Process the logs returned by the org.
                this.processLogs(result, isInitialLoad);
            }
        } catch (error: any) {
            logger.error('Logs.refresh', `Could not query or process logs; auto=${isAutoRefresh}`, error);
            vscode.window.showErrorMessage(`Failed to refresh logs: ${error.message}`);
            // Detect common error scenarios and propagate errorInfo
            errorInfo = { hasError: true, message: error instanceof Error ? error.message : String(error) };
        } finally {
            this.isRefreshing = false;
            // Always schedule the next refresh if auto-refresh is enabled, regardless of isInitialLoad
            if (!this.autoRefreshPaused) {
                this.scheduleRefresh();
            }
            // Always notify panel, with errorInfo if present
            if (this.activeProvider?.updateView) {
                this.activeProvider.updateView(this.getGridData(), isAutoRefresh, errorInfo);
            } else {
                this._notifyDataChange(isAutoRefresh);
            }
        }
    }

    // Process the logs returned by the Salesforce org.
    private processLogs(result: { records: ApexLogRecord[] }, isInitialLoad: boolean) {
        // Convert the returned records into ApexLog instances.
        const newLogs = result.records.map(record => new ApexLog(record, this.connection));

        this.logs = newLogs
            .filter(log => log.operation !== '<empty>') // TODO: Filter logs with an empty operation based on a setting.
            .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())

        let typesChanged = false;
        for (const log of this.logs) {
            if (!this.operationTypes.has(log.operation)) {
                this.operationTypes.add(log.operation);
                typesChanged = true;
            }
        }
        if (typesChanged) {
            void this.context.workspaceState.update('logViewer.operationTypes', [...this.operationTypes])
                .then(undefined, error => logger.warn('Log Viewer.filters', 'Could not save discovered operation types', error));
        }
        if (isInitialLoad) {
            this.searchText = '';
        }
        this._filterLogs();
    }

    // Track panel visibility to determine whether log auto-refresh should continue.
    public setPanelVisibility(visible: boolean) {
        if (visible !== this._isVisible) {
            logger.debug('Logs.visibility', `Panel ${visible ? 'visible' : 'hidden'}; auto-refresh configured=${this.config.autoRefresh}`);
        }
        this._isVisible = visible;
        if (visible && this.config.autoRefresh && this.autoRefreshPaused) {
            // Resume auto-refresh when the panel becomes visible and auto-refresh is enabled.
            this.startAutoRefresh();
        } else if (!visible && !this.autoRefreshPaused) {
            // Pause auto-refresh when the panel is hidden.
            this.stopAutoRefresh();
        }
    }

    // Start log auto-refresh.
    private startAutoRefresh() {
        logger.debug('Logs.autoRefresh', `Resume requested; panel visible=${this._isVisible}`);
        // Only start if panel is visible
        if (this._isVisible) {
            this.autoRefreshPaused = false;
            this.scheduleRefresh();
        }
    }

    // Stop log auto-refresh.
    private stopAutoRefresh() {
        logger.debug('Logs.autoRefresh', 'Paused; clearing scheduled refresh');
        this.autoRefreshPaused = true;
        if (this.autoRefreshScheduledId) {
            clearTimeout(this.autoRefreshScheduledId);
            this.autoRefreshScheduledId = undefined;
        }
    }

    // Schedule log auto-refresh using the configured interval.
    // Run only while the panel is visible and auto-refresh is not paused.
    private scheduleRefresh() {
        if (this.autoRefreshScheduledId) {
            clearTimeout(this.autoRefreshScheduledId);
        }

        if (this._isVisible && !this.autoRefreshPaused && !this.isRefreshing) {
            this.autoRefreshScheduledId = setTimeout(() => this.refreshLogs(false, true), this.config.refreshInterval);
        }
    }

    // Enable or disable log auto-refresh.
    public async setAutoRefresh(enabled: boolean): Promise<void> {
        if (this.config.autoRefresh === enabled) {
            return;
        }
        this.config.autoRefresh = enabled;
        const config = getConfiguration();
        await config.update('autoRefresh', this.config.autoRefresh, vscode.ConfigurationTarget.Global);

        if (enabled && this._isVisible) {
            // Start auto-refresh when it is enabled and the panel is visible.
            this.startAutoRefresh();
        } else {
            this.stopAutoRefresh();
        }
    }

    public getAutoRefreshSetting(): boolean {
        return this.config.autoRefresh;
    }

    // Return log data formatted for the panel grid.
    public getGridData(): any[] {
        return this.filteredLogs.map(log => ({
            id: log.id,
            user: log.user,
            time: (() => {
                const date = new Date(log.startTime);
                const timeStr = date.toLocaleTimeString('es-ES', {
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                });
                const dateStr = date.toLocaleDateString('es-ES', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit'
                });
                // Include the timestamp in milliseconds for sorting.
                return `${timeStr}|||${timeStr} ${dateStr}|||${date.getTime()}`;
            })(),
            status: log.status,
            uiStatus: log.uiStatus, // Indicates whether the log is unread, downloaded, or downloading.
            size: (() => {
                let value, unit;
                if (log.size >= 1024 * 1024) {
                    value = (log.size / 1024 / 1024).toFixed(1);
                    unit = 'MB';
                } else {
                    value = (log.size / 1024).toFixed(1);
                    unit = 'KB';
                }
                // Return a plain string with padding for alignment, without HTML or font changes.
                return value.padStart(6, ' ') + ' ' + unit;
            })(),
            operation: log.operation,
            duration: (() => {
                let value, unit;
                if (log.durationMilliseconds >= 1000) {
                    value = (log.durationMilliseconds / 1000).toFixed(2);
                    unit = 's';
                } else {
                    value = log.durationMilliseconds.toString();
                    unit = 'ms';
                }
                return value.padStart(6, ' ') + ' ' + unit;
            })(),
        }));
    }

    // Set the search text used to filter logs.
    public getOperationFilter() {
        return {
            available: [...this.operationTypes].sort((left, right) => left.localeCompare(right)),
            selected: this.selectedOperationTypes
        };
    }

    public async setOperationFilter(selected: string[] | null): Promise<void> {
        this.selectedOperationTypes = selected === null ? null : [...new Set(selected)];
        this._filterLogs();
        this.notifyDataChange();
        await this.context.workspaceState.update('logViewer.selectedOperationTypes', this.selectedOperationTypes);
    }

    public setSearchFilter(text: string) {
        this.searchText = text;
        this._filterLogs();
        this._notifyDataChange(false);
    }

    // Clear the log filter and notify the panel. TODO: Currently unused.
    public clearSearch() {
        this.searchText = '';
        this._filterLogs();
        this._notifyDataChange(false);
    }

    // Filter logs by the search text.
    private _filterLogs() {
        const searchLower = this.searchText.toLowerCase();
        this.filteredLogs = this.logs.filter(log => {
            if (this.selectedOperationTypes !== null && !this.selectedOperationTypes.includes(log.operation)) return false;
            const operation = log.operation.toLowerCase();
            const user = log.user.toLowerCase();
            return operation.includes(searchLower) || user.includes(searchLower);
        });
    }

    // Set whether to show only the current user's logs.
    public async setCurrentUserOnly(showCurrentUserOnly: boolean): Promise<void> {
        if (this.config.currentUserOnly === showCurrentUserOnly) {
            // Do nothing if this setting is already enabled.
            return;
        }
        this.config.currentUserOnly = showCurrentUserOnly;
        const config = getConfiguration();
        await config.update('currentUserOnly', this.config.currentUserOnly, vscode.ConfigurationTarget.Global);

        // Ensure the current user has an active trace flag.
        try {
            this.currentUserId = await this.getCurrentUserId();
            if (this.currentUserId) {
                await ensureTraceFlag(this.connection, this.currentUserId);
            }
        } catch (error: any) {
            logger.warn('Logs.visibilitySetting', 'Current-user initialization failed; falling back to all users', error);
            vscode.window.showErrorMessage(`Failed to get current user ID: ${error.message}. Showing all users.`);
            this.config.currentUserOnly = false;
            await config.update('currentUserOnly', this.config.currentUserOnly, vscode.ConfigurationTarget.Global);
        }
        // Refresh logs using the updated setting.
        await this.refreshLogs(true, false);
        this._notifyDataChange(false);
    }

    // Check whether the current-user-only setting is enabled.
    public getCurrentUserOnlySetting(): boolean {
        return this.config.currentUserOnly;
    }

    // Get the current user's ID from the Salesforce org connection.
    public async getCurrentUserId(): Promise<string> {
        const result = await logger.run('Connection.identity', () => this.connection.identity());
        return result.user_id;
    }

    // Update the Salesforce org connection.
    // Ensure the trace flag is active for the current user and refresh logs
    // using the new connection.
    public async updateConnection(newConnection: Connection) {
        this.connection = newConnection;

        try {
            this.currentUserId = await this.getCurrentUserId();
            if (this.currentUserId) {
                await ensureTraceFlag(this.connection, this.currentUserId);
            }
        } catch (error: any) {
            logger.warn('Logs.updateConnection', 'Current-user initialization failed; falling back to all users', error);
            vscode.window.showErrorMessage(`Failed to get current user ID: ${error.message}. Showing all users.`);
            this.config.currentUserOnly = false;
            const config = getConfiguration();
            await config.update('currentUserOnly', false, vscode.ConfigurationTarget.Global);
        }

        // Refresh logs using the new connection.
        await this.refreshLogs(true, false);
    }

    // Notify the panel that the data has changed.
    public notifyDataChange(isAutoRefresh: boolean = false) {
        this._notifyDataChange(isAutoRefresh);
    }

    // Mark a log opened in the panel as downloaded.
    public markLogAsOpened(logId: string) {
        // Find the log by ID and change its status to 'downloaded'.
        const log = this.logs.find(l => l.id === logId);
        if (log && log.uiStatus !== 'downloaded') {
            log.uiStatus = 'downloaded';
            this._filterLogs();
            this._notifyDataChange(false);
        }
    }
}