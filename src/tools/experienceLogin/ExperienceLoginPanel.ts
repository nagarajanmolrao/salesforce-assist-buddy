import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { logger } from '../../core/logger';
import { ExperienceLoginService } from './service';

export class ExperienceLoginPanel implements vscode.Disposable {
    private static readonly editors = new Set<ExperienceLoginPanel>();
    private readonly panel: vscode.WebviewPanel;
    private readonly service = new ExperienceLoginService();
    private loginUrl?: string;
    private selectedUsername?: string;
    private revision = 0;
    private disposed = false;

    constructor(context: vscode.ExtensionContext, private readonly onActivityChanged: () => void = () => {}) {
        const root = vscode.Uri.joinPath(context.extensionUri, 'src', 'tools', 'experienceLogin');
        this.panel = vscode.window.createWebviewPanel(
            'salesforceAssistBuddy.experienceLogin', 'Experience Login URL', vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [root] }
        );
        ExperienceLoginPanel.editors.add(this);
        this.panel.onDidChangeViewState(() => this.onActivityChanged());
        this.panel.onDidDispose(() => {
            this.disposed = true;
            this.loginUrl = undefined;
            this.revision++;
            ExperienceLoginPanel.editors.delete(this);
            this.onActivityChanged();
        });
        this.panel.webview.onDidReceiveMessage(message => { void this.handleMessage(message); });
        const nonce = randomBytes(16).toString('hex');
        this.panel.webview.html = fs.readFileSync(vscode.Uri.joinPath(root, 'ExperienceLogin.html').fsPath, 'utf8')
            .split('${cspSource}').join(this.panel.webview.cspSource)
            .split('${nonce}').join(nonce)
            .replace('${styleUri}', this.panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'ExperienceLogin.css')).toString())
            .replace('${scriptUri}', this.panel.webview.asWebviewUri(vscode.Uri.joinPath(root, 'ExperienceLogin.js')).toString());
        logger.info('Experience Login.panel', 'Experience login editor opened');
    }

    public static hasActiveEditor(): boolean {
        return [...this.editors].some(editor => editor.panel.active);
    }

    public dispose() {
        this.panel.dispose();
    }

    private async handleMessage(message: any) {
        let operationRevision = this.revision;
        try {
            if (message?.command === 'ready' || message?.command === 'refreshOrgs') {
                this.loginUrl = undefined;
                this.selectedUsername = undefined;
                const revision = ++this.revision;
                operationRevision = revision;
                const selection = await this.service.listOrgs(message.command === 'refreshOrgs');
                if (this.disposed || revision !== this.revision) return;
                const username = selection.orgs.some(org => org.username === message.username)
                    ? message.username as string : selection.defaultUsername;
                this.selectedUsername = username;
                await this.panel.webview.postMessage({ type: 'orgs', ...selection, selectedUsername: username });
                const result = await this.service.listNetworks(username);
                if (!this.disposed && revision === this.revision) {
                    await this.panel.webview.postMessage({ type: 'networks', ...result });
                }
            } else if (message?.command === 'selectOrg' || message?.command === 'refreshNetworks') {
                this.loginUrl = undefined;
                const revision = ++this.revision;
                operationRevision = revision;
                if (typeof message.username !== 'string' || !message.username) throw new Error('Select an authenticated org.');
                this.selectedUsername = message.username;
                logger.debug('Experience Login.networks', 'Loading networks for the selected org');
                const result = await this.service.listNetworks(message.username);
                if (!this.disposed && revision === this.revision) {
                    await this.panel.webview.postMessage({ type: 'networks', ...result });
                }
            } else if (message?.command === 'invalidate') {
                this.loginUrl = undefined;
                this.revision++;
            } else if (message?.command === 'findContacts') {
                this.loginUrl = undefined;
                const revision = ++this.revision;
                operationRevision = revision;
                const username = this.requireSelectedOrg(message);
                if (typeof message.email !== 'string') throw new Error('Enter a contact email address.');
                logger.debug('Experience Login.contacts', 'Finding contacts and active Experience users');
                const contacts = await this.service.findContacts(username, message.email);
                if (!this.disposed && revision === this.revision) {
                    await this.panel.webview.postMessage({ type: 'contacts', contacts });
                }
            } else if (message?.command === 'generate') {
                this.loginUrl = undefined;
                const revision = ++this.revision;
                operationRevision = revision;
                const username = this.requireSelectedOrg(message);
                if (typeof message.email !== 'string' || typeof message.networkId !== 'string' ||
                    typeof message.contactId !== 'string' || typeof message.userId !== 'string') {
                    throw new Error('Find contacts, select an active Experience user, and select a network.');
                }
                logger.info('Experience Login.generate', 'Generating a login URL for the selected network');
                const url = await this.service.generate(username, message.email, message.networkId, message.contactId, message.userId);
                if (!this.disposed && revision === this.revision) {
                    this.loginUrl = url;
                    await this.panel.webview.postMessage({ type: 'generated' });
                    logger.info('Experience Login.generate', 'Login URL ready; session credentials are not logged or persisted');
                }
            } else if (message?.command === 'copy') {
                if (!this.loginUrl) throw new Error('Generate a login URL first.');
                await vscode.env.clipboard.writeText(this.loginUrl);
                await this.panel.webview.postMessage({ type: 'copied' });
            } else if (message?.command === 'open') {
                const url = this.loginUrl;
                if (!url) throw new Error('Generate a login URL first.');
                const answer = await vscode.window.showWarningMessage(
                    'Open this session-bearing Experience login URL in your browser? It will use the authenticated Salesforce session.',
                    { modal: true }, 'Open Login URL'
                );
                if (answer === 'Open Login URL' && this.loginUrl === url && !this.disposed) {
                    const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
                    if (!opened) throw new Error('Could not open the browser. Copy the URL and open it manually.');
                }
            }
        } catch (error) {
            if (this.disposed || operationRevision !== this.revision) return;
            this.loginUrl = undefined;
            const code = (error as { errorCode?: string; code?: string })?.errorCode ||
                (error as { code?: string })?.code || 'OPERATION_FAILED';
            logger.error('Experience Login', `Operation failed (${String(code).replace(/[^A-Za-z0-9_]/g, '')}); no session URL or email logged`);
            const messageText = message?.command === 'open' || message?.command === 'copy'
                ? 'The URL action failed. Generate a fresh URL and try again.'
                : error instanceof Error ? error.message : 'The operation failed. Check org access and try again.';
            if (!this.disposed) await this.panel.webview.postMessage({ type: 'error', message: messageText });
        }
    }

    private requireSelectedOrg(message: any): string {
        if (typeof message.username !== 'string' || message.username !== this.selectedUsername) {
            throw new Error('The selected org changed. Refresh networks and find contacts again.');
        }
        return message.username;
    }
}