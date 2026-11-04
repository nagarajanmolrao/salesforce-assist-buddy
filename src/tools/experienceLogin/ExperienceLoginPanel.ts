import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { logger } from '../../core/logger';
import { ExperienceLoginService, buildExperienceLoginUrl } from './service';

export class ExperienceLoginPanel implements vscode.Disposable {
    private static readonly editors = new Set<ExperienceLoginPanel>();
    private readonly panel: vscode.WebviewPanel;
    private readonly service = new ExperienceLoginService();
    private loginUrl?: string;
    private loginUrlWithoutSession?: string;
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
            this.loginUrlWithoutSession = undefined;
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
            console.log('[panel] handleMessage called', { command: message?.command, hasLoginUrl: !!this.loginUrl, hasLoginUrlWithoutSession: !!this.loginUrlWithoutSession });
            let operationRevision = this.revision;
        try {
            if (message?.command === 'ready' || message?.command === 'refreshOrgs') {
                this.loginUrl = undefined;
                this.loginUrlWithoutSession = undefined;
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
                this.loginUrlWithoutSession = undefined;
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
                this.loginUrlWithoutSession = undefined;
                this.revision++;
            } else if (message?.command === 'findContacts') {
                this.loginUrl = undefined;
                this.loginUrlWithoutSession = undefined;
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
                this.loginUrlWithoutSession = undefined;
                const revision = ++this.revision;
                operationRevision = revision;
                const username = this.requireSelectedOrg(message);
                if (typeof message.email !== 'string' || typeof message.networkId !== 'string' ||
                    typeof message.contactId !== 'string' || typeof message.userId !== 'string') {
                    throw new Error('Find contacts, select an active Experience user, and select a network.');
                }
                logger.info('Experience Login.generate', 'Generating a login URL for the selected network');
                const { url, urlWithoutSession } = await this.service.generate(username, message.email, message.networkId, message.contactId, message.userId);
                if (!this.disposed && revision === this.revision) {
                    this.loginUrl = url;
                    this.loginUrlWithoutSession = urlWithoutSession;
                    await this.panel.webview.postMessage({ type: 'generated' });
                    logger.info('Experience Login.generate', 'Login URL ready; session credentials are not logged or persisted');
                }
            } else if (message?.command === 'copy') {
                            const loginUrl = this.loginUrl;
                            const loginUrlWithoutSession = this.loginUrlWithoutSession;
                            if (!loginUrl && !loginUrlWithoutSession) throw new Error('Generate a login URL first.');
                            const url = loginUrlWithoutSession ?? loginUrl!;
                            await vscode.env.clipboard.writeText(url);
                            await this.panel.webview.postMessage({ type: 'copied' });
            } else if (message?.command === 'open') {
                            console.log('[panel] open command received', { browser: message.browser, incognito: message.incognito, loginUrl: this.loginUrl, loginUrlWithoutSession: this.loginUrlWithoutSession });
                                        const browser: string = typeof message.browser === 'string' ? message.browser : 'default';
                            const incognito = message.incognito === true;
                            console.log('[panel] after defaults', { browser, incognito });
                            if (!this.loginUrl && !this.loginUrlWithoutSession) {
                                console.log('[panel] ERROR: no URL available');
                                throw new Error('Generate a login URL first.');
                            }
                
                if (incognito) {
                    // Incognito mode: use session-bearing URL
                    const url = this.loginUrl;
                    if (!url) throw new Error('Generate a login URL first.');
                    const answer = await vscode.window.showWarningMessage(
                        'Open this session-bearing Experience login URL in an incognito/private browser window? It will use the authenticated Salesforce session.',
                        { modal: true }, 'Open in Incognito'
                    );
                    if (answer === 'Open in Incognito' && this.loginUrl === url && !this.disposed) {
                                    console.log('[panel] calling openInBrowser incognito', { browser, url });
                                    await this.openInBrowser(browser, url, true);
                                }
                            } else {
                                // Normal mode: use URL without session
                                const url = this.loginUrlWithoutSession;
                                if (!url) throw new Error('Generate a login URL first.');
                                if (!this.disposed) {
                                    console.log('[panel] calling openInBrowser normal', { browser, url });
                                    await this.openInBrowser(browser, url, false);
                                }
                            }
                            console.log('[panel] open command completed successfully');
            }
        } catch (error) {
            if (this.disposed || operationRevision !== this.revision) return;
            this.loginUrl = undefined;
            this.loginUrlWithoutSession = undefined;
            const code = (error as { errorCode?: string; code?: string })?.errorCode ||
                (error as { code?: string })?.code || 'OPERATION_FAILED';
            logger.error('Experience Login', `Operation failed (${String(code).replace(/[^A-Za-z0-9_]/g, '')}); no session URL or email logged`);
            const messageText = message?.command === 'open' || message?.command === 'copy'
                ? 'The URL action failed. Generate a fresh URL and try again.'
                : error instanceof Error ? error.message : 'The operation failed. Check org access and try again.';
            if (!this.disposed) await this.panel.webview.postMessage({ type: 'error', message: messageText });
        }
    }

    private async openInBrowser(browser: string, url: string, incognito: boolean): Promise<void> {
        const platform = process.platform;
        let command: string | undefined;
        let args: string[] = [];

        // Map browser names to executable commands
        const browserCommands: Record<string, { darwin: string; win32: string; linux: string }> = {
            chrome: { darwin: 'open', win32: 'chrome', linux: 'google-chrome' },
            firefox: { darwin: 'open', win32: 'firefox', linux: 'firefox' },
            safari: { darwin: 'open', win32: '', linux: '' }, // Safari only on macOS
            edge: { darwin: 'open', win32: 'msedge', linux: 'microsoft-edge' },
            brave: { darwin: 'open', win32: 'brave', linux: 'brave-browser' },
            opera: { darwin: 'open', win32: 'opera', linux: 'opera' },
            vivaldi: { darwin: 'open', win32: 'vivaldi', linux: 'vivaldi' },
            arc: { darwin: 'open', win32: '', linux: '' }, // Arc only on macOS
        };

        if (browser === 'default') {
            // Use VS Code's default external URI handler
            const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
            if (!opened) throw new Error('Could not open the browser. Copy the URL and open it manually.');
            return;
        }

        const browserInfo = browserCommands[browser];
        if (!browserInfo) {
            // Fallback to default browser
            const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
            if (!opened) throw new Error('Could not open the browser. Copy the URL and open it manually.');
            return;
        }

        if (platform === 'darwin') {
            // macOS: use 'open -a "Browser Name"'
            const appNames: Record<string, string> = {
                chrome: 'Google Chrome',
                firefox: 'Firefox',
                safari: 'Safari',
                edge: 'Microsoft Edge',
                brave: 'Brave Browser',
                opera: 'Opera',
                vivaldi: 'Vivaldi',
                arc: 'Arc',
            };
            const appName = appNames[browser];
            if (!appName) throw new Error(`Browser "${browser}" is not supported on macOS.`);
            
            if (incognito) {
                const incognitoFlags: Record<string, string> = {
                    chrome: '--incognito',
                    firefox: '-private-window',
                    safari: '', // Safari doesn't support CLI incognito flag
                    edge: '--inprivate',
                    brave: '--incognito',
                    opera: '--private',
                    vivaldi: '--incognito',
                    arc: '', // Arc doesn't have CLI incognito flag
                };
                const flag = incognitoFlags[browser];
                if (!flag) throw new Error(`Incognito mode is not supported for "${browser}" on macOS.`);
                command = 'open';
                args = ['-a', appName, '--args', flag, url];
            } else {
                command = 'open';
                args = ['-a', appName, url];
            }
        } else if (platform === 'win32') {
            // Windows: use the executable directly
            const exe = browserInfo.win32;
            if (!exe) throw new Error(`Browser "${browser}" is not supported on Windows.`);
            
            if (incognito) {
                const incognitoFlags: Record<string, string> = {
                    chrome: '--incognito',
                    firefox: '-private-window',
                    edge: '--inprivate',
                    brave: '--incognito',
                    opera: '--private',
                    vivaldi: '--incognito',
                };
                const flag = incognitoFlags[browser];
                if (!flag) throw new Error(`Incognito mode is not supported for "${browser}" on Windows.`);
                command = exe;
                args = [flag, url];
            } else {
                command = exe;
                args = [url];
            }
        } else {
            // Linux
            const exe = browserInfo.linux;
            if (!exe) throw new Error(`Browser "${browser}" is not supported on Linux.`);
            
            if (incognito) {
                const incognitoFlags: Record<string, string> = {
                    chrome: '--incognito',
                    firefox: '-private-window',
                    edge: '--inprivate',
                    brave: '--incognito',
                    opera: '--private',
                    vivaldi: '--incognito',
                };
                const flag = incognitoFlags[browser];
                if (!flag) throw new Error(`Incognito mode is not supported for "${browser}" on Linux.`);
                command = exe;
                args = [flag, url];
            } else {
                command = exe;
                args = [url];
            }
        }

        return new Promise((resolve, reject) => {
            const { spawn } = require('child_process');
            const child = spawn(command, args, { detached: true, stdio: 'ignore' });
            child.unref();
            child.on('error', (err: Error) => {
                reject(new Error(`Failed to open ${browser}: ${err.message}. Make sure it's installed.`));
            });
            // Give it a moment to start
            setTimeout(() => resolve(), 500);
        });
    }

    private requireSelectedOrg(message: any): string {
        if (typeof message.username !== 'string' || message.username !== this.selectedUsername) {
            throw new Error('The selected org changed. Refresh networks and find contacts again.');
        }
        return message.username;
    }
}