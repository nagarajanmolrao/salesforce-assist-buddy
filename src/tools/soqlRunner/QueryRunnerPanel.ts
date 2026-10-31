import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from '../../core/logger';
import { SavedQuery } from './queryData';
import { SoqlRunnerService } from './service';

export class QueryRunnerPanel implements vscode.Disposable {
    private static readonly editors = new Set<QueryRunnerPanel>();
    private readonly panel: vscode.WebviewPanel;
    private readonly service: SoqlRunnerService;

    constructor(context: vscode.ExtensionContext, private readonly onActivityChanged: () => void = () => {}) {
        this.service = new SoqlRunnerService(context);
        this.panel = vscode.window.createWebviewPanel(
            'salesforceAssistBuddy.queryRunner',
            'Query Runner',
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'src', 'tools', 'soqlRunner')]
            }
        );
        QueryRunnerPanel.editors.add(this);
        this.panel.onDidChangeViewState(() => this.onActivityChanged());

        const scriptUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(context.extensionUri, 'src', 'tools', 'soqlRunner', 'QueryRunner.js')
        );
        const styleUri = this.panel.webview.asWebviewUri(
            vscode.Uri.joinPath(context.extensionUri, 'src', 'tools', 'soqlRunner', 'QueryRunner.css')
        );
        this.panel.webview.html = this.getHtml(context.extensionUri, scriptUri, styleUri);
        this.panel.webview.onDidReceiveMessage(message => this.handleMessage(message));
        logger.info('Query Runner.panel', 'Query editor opened');
        this.panel.onDidDispose(() => {
            QueryRunnerPanel.editors.delete(this);
            this.onActivityChanged();
            logger.info('Query Runner.panel', 'Query editor closed');
        });
    }

    public static hasActiveEditor(): boolean {
        return [...this.editors].some(editor => editor.panel.active);
    }

    public dispose() {
        this.panel.dispose();
    }

    private getHtml(extensionUri: vscode.Uri, scriptUri: vscode.Uri, styleUri: vscode.Uri): string {
        const htmlPath = path.join(extensionUri.fsPath, 'src', 'tools', 'soqlRunner', 'QueryRunner.html');
        let html = fs.readFileSync(htmlPath, 'utf8');
        const nonce = randomBytes(16).toString('base64');
        html = html.split('${cspSource}').join(this.panel.webview.cspSource);
        html = html.split('${nonce}').join(nonce);
        html = html.replace('${scriptUri}', scriptUri.toString());
        html = html.replace('${styleUri}', styleUri.toString());
        return html;
    }

    private async handleMessage(message: any): Promise<void> {
        if (message?.command === 'ready') {
            await this.sendInitialState();
        } else if (message?.command === 'refreshOrgs') {
            await this.refreshOrgs();
        } else if (message?.command === 'runQuery') {
            await this.runQuery(message);
        } else if (message?.command === 'saveQuery') {
            await this.saveQuery(message.query);
        } else if (message?.command === 'deleteQuery') {
            await this.deleteQuery(message.id);
        } else if (message?.command === 'openLibrary') {
            await this.openLibrary();
        } else if (message?.command === 'reloadLibrary') {
            await this.reloadLibrary();
        } else if (message?.command === 'diagnostic' && typeof message.message === 'string') {
            logger.error('Query Runner.webview', message.message.slice(0, 4000));
        }
    }

    private async sendInitialState() {
        try {
            const state = await this.service.getInitialState();
            if (state.orgs.length) {
                logger.info('Query Runner.orgList', `Loaded ${state.orgs.length} authenticated orgs`);
            }
            await this.panel.webview.postMessage({ type: 'initialize', ...state, queryFile: this.service.savedQueriesFilePath });
        } catch (error) {
            this.sendError('initialize', error);
        }
    }

    private async refreshOrgs() {
        try {
            const state = await this.service.listOrgs(true);
            logger.info('Query Runner.orgList', `Refreshed ${state.orgs.length} authenticated orgs`);
            await this.panel.webview.postMessage({ type: 'orgs', ...state });
        } catch (error) {
            this.sendError('orgs', error);
        }
    }

    private async runQuery(message: any) {
        try {
            if (typeof message.username !== 'string' || !message.query || typeof message.query !== 'object') {
                throw new Error('Select an authenticated org and saved query before running.');
            }
            const result = await this.service.runQuery(
                message.username,
                message.query as SavedQuery,
                message.values && typeof message.values === 'object' ? message.values : {}
            );
            await this.panel.webview.postMessage({ type: 'queryResults', ...result });
        } catch (error) {
            this.sendError('query', error);
        }
    }

    private async saveQuery(query: SavedQuery) {
        try {
            const queries = await this.service.saveQuery(query);
            await this.panel.webview.postMessage({ type: 'queryLibrary', queries, queryFile: this.service.savedQueriesFilePath });
        } catch (error) {
            this.sendError('save', error);
        }
    }

    private async deleteQuery(id: string) {
        try {
            const answer = await vscode.window.showWarningMessage(
                'Delete this saved query?',
                { modal: true },
                'Delete Query'
            );
            if (answer !== 'Delete Query') return;
            const queries = await this.service.deleteQuery(id);
            await this.panel.webview.postMessage({ type: 'queryLibrary', queries, queryFile: this.service.savedQueriesFilePath });
        } catch (error) {
            this.sendError('delete', error);
        }
    }

    private async openLibrary() {
        try {
            await this.service.ensureSavedQueriesFile();
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(this.service.savedQueriesFilePath));
            await vscode.window.showTextDocument(document, { preview: false });
        } catch (error) {
            this.sendError('library', error);
        }
    }

    private async reloadLibrary() {
        try {
            const queries = await this.service.loadSavedQueries();
            await this.panel.webview.postMessage({ type: 'queryLibrary', queries, queryFile: this.service.savedQueriesFilePath });
        } catch (error) {
            this.sendError('library', error);
        }
    }

    private sendError(operation: string, error: unknown) {
        const details = error instanceof Error ? error.message : 'Unexpected query editor error.';
        const message = operation === 'query'
            ? 'Query failed. See View > Output > Salesforce Assist Buddy for the full error details.'
            : details;
        if (operation === 'query') {
            logger.debug('Query Runner.query', 'Query failure summary shown in editor; full details were logged.');
        } else {
            logger.warn(`Query Runner.${operation}`, 'Operation failed; details shown in the editor.');
        }
        void this.panel.webview.postMessage({ type: 'error', operation, message });
    }
}
