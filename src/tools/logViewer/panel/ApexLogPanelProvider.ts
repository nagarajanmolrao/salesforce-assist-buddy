import * as vscode from 'vscode';
import { LogDataProvider } from '../ApexLogDataProvider';
import * as fs from 'fs';
import * as path from 'path';
import { openLog } from '../service';
import { logger } from '../../../core/logger';
import { defaultToolId, isToolId, toolRegistry, ToolId } from '../../registry';

import { IApexLogPanelProvider } from './IApexLogPanelProvider';

export class ApexLogPanelProvider implements vscode.WebviewViewProvider, IApexLogPanelProvider {
    private _view?: vscode.WebviewView;
    private _webviewReady = false;
    private _toolActive = true;
    private readonly _pendingMessages: any[] = [];
    private readonly _logDataProvider: LogDataProvider;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        logDataProvider: LogDataProvider,
        private readonly _onToolSelected: (toolId: ToolId) => void
    ) {
        this._logDataProvider = logDataProvider;
    } public async refresh(): Promise<void> {
        if (this._logDataProvider) {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Refreshing Salesforce logs...',
                cancellable: false
            }, async () => {
                await this._logDataProvider.refreshLogs(false, true);
            });
        }
    } public postMessage(message: any) {
        if (!this._view) {
            logger.debug('Webview.panel', 'Update skipped: webview has not been resolved');
            return;
        }
        if (!this._webviewReady) {
            if (message?.type === 'updateData') {
                const pendingUpdate = this._pendingMessages.findIndex(pending => pending?.type === 'updateData');
                if (pendingUpdate >= 0) {
                    this._pendingMessages[pendingUpdate] = message;
                } else {
                    this._pendingMessages.push(message);
                }
            } else if (this._pendingMessages.length < 50) {
                this._pendingMessages.push(message);
            }
            return;
        }

        const view = this._view;
        void view.webview.postMessage(message).then(delivered => {
            if (!delivered && this._view === view && view.visible) {
                logger.warn('Webview.panel', 'Message was not accepted by the ready, visible panel');
            }
        }, error => logger.error('Webview.panel', 'Could not send a panel update', error));
    }

    public showSearchBoxInWebview() {
        if (!this._toolActive) return;
        this.postMessage({ type: 'showSearchBox' });
    }

    public setToolActive(active: boolean) {
        this._toolActive = active;
        const visible = this._view?.visible === true;
        void vscode.commands.executeCommand('setContext', 'salesforceAssistBuddy.logViewerActive', active && visible)
            .then(undefined, error => logger.error('Log Viewer.activity', 'Could not update toolbar visibility', error));
        this.postMessage({ type: 'toolActivity', active });
    }

    /**
     * Update the panel view. If errorInfo is provided, send it to the webview for fallback UI.
     */
    public updateView(data?: any[], isAutoRefresh: boolean = false, errorInfo?: { hasError: boolean, message?: string }) {
        const gridData = data || this._logDataProvider?.getGridData();
        this.postMessage({
            type: 'updateData',
            data: gridData,
            operationFilter: this._logDataProvider.getOperationFilter(),
            toolActive: this._toolActive,
            isAutoRefresh: isAutoRefresh,
            errorInfo: errorInfo || null
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        logger.debug('Webview.panel', 'Resolving log panel');
        this._view = webviewView;
        this._webviewReady = false;
        this.setToolActive(this._toolActive);

        this._logDataProvider.setPanelVisibility(webviewView.visible);

        webviewView.onDidChangeVisibility(async () => {
            this.setToolActive(this._toolActive);
            this._logDataProvider.setPanelVisibility(webviewView.visible);
            if (webviewView.visible && this._webviewReady) {
                await this.refresh();
            }
        });

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        const scriptUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'src', 'tools', 'logViewer', 'panel', 'ApexLogPanel.js')
        );
        const styleUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'src', 'tools', 'logViewer', 'panel', 'ApexLogPanel.css')
        );

        webviewView.webview.html = this.getHtmlForWebview(scriptUri, styleUri);
        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'diagnostic' && typeof message.message === 'string') {
                logger.error('Webview.panel.script', message.message.slice(0, 4000));
            } else if (message.command === 'ready') {
                logger.debug('Webview.panel', 'Client ready');
                this._webviewReady = true;
                const pendingMessages = this._pendingMessages.splice(0);
                pendingMessages.forEach(pendingMessage => this.postMessage(pendingMessage));
                this.setToolActive(this._toolActive);
                let initialData: any[] = [];
                let errorInfo: { hasError: boolean, message?: string } | null = null;
                try {
                    initialData = this._logDataProvider?.getGridData();
                    // If no data available, force a refresh
                    if (!initialData || initialData.length === 0) {
                        await this._logDataProvider.refreshLogs(true, false);
                        initialData = this._logDataProvider?.getGridData();
                    }
                } catch (err: any) {
                    logger.error('Webview.panel.ready', 'Initial data loading stopped', err);
                    // Detect common error causes
                    errorInfo = { hasError: true, message: err?.message || 'Unknown error' };
                }
                // If gridData is empty and errorInfo is set, show fallback
                this.updateView(initialData, false, errorInfo || undefined);
            } else if (message.command === 'openLog') {
                try {
                    await openLog({ id: message.log.id });
                } catch (err: any) {
                    logger.error('Webview.panel.openLog', 'Log-open message could not be handled', err);
                    // If log open fails, show error fallback
                    this.updateView([], false, { hasError: true, message: err?.message || 'Failed to open log.' });
                }
            } else if (message.command === 'inlineSearch') {
                try {
                    this._logDataProvider?.setSearchFilter(message.text);
                    this.updateView();
                } catch (err: any) {
                    logger.error('Webview.panel.search', 'Search update failed', err);
                    this.updateView([], false, { hasError: true, message: err?.message || 'Search failed.' });
                }
            } else if (message.command === 'filterOperations') {
                if (!this._toolActive) return;
                if (message.selected !== null && (!Array.isArray(message.selected) ||
                    !message.selected.every((value: unknown) => typeof value === 'string'))) return;
                try {
                    await this._logDataProvider.setOperationFilter(message.selected);
                    this.updateView();
                } catch (error) {
                    logger.error('Log Viewer.filters', 'Could not save operation filter', error);
                }
            } else if (message.command === 'selectTool' && isToolId(message.toolId)) {
                logger.debug('Tools', `Selected ${message.toolId}`);
                this.setToolActive(true);
                this._onToolSelected(message.toolId);
            }
        });
    }

    private getHtmlForWebview(scriptUri: vscode.Uri, styleUri: vscode.Uri) {
        const templatePath = path.join(this._extensionUri.fsPath, 'src', 'tools', 'logViewer', 'panel', 'ApexLogPanel.html');
        let template: string;
        try {
            template = fs.readFileSync(templatePath, 'utf8');
        } catch (error) {
            logger.error('Webview.panel.template', 'Cannot load panel HTML; webview setup stopped', error);
            throw error;
        }
        template = template.replace('${scriptUri}', scriptUri.toString());
        template = template.replace('${styleUri}', styleUri.toString());
        const toolOptions = toolRegistry.map(tool =>
            `<option value="${tool.id}"${tool.id === defaultToolId ? ' selected' : ''}>${tool.label}</option>`
        ).join('');
        template = template.replace('${toolOptions}', toolOptions);
        return template;
    }
}
