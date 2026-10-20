import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../../../core/logger';
import { commandId, extensionIds } from '../../../core/extensionIdentity';

export class ApexLogDetails {
    public static registerCommand(context: vscode.ExtensionContext) {
        const disposable = vscode.commands.registerCommand(commandId('showLogDetails'), async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !editor.document.fileName.endsWith('.log')) {
                vscode.window.showInformationMessage('No Salesforce .log file is active.');
                logger.debug('LogDetails', 'Skipped: no active .log file');
                return;
            }
            const logContent = editor.document.getText();
            try {
                await logger.run('LogDetails.open', () => ApexLogDetails.showLogDetailsWebview(logContent, editor.document.fileName, context.extensionUri));
            } catch (error) {
                logger.error('LogDetails.open', 'Could not create the log details view', error);
                vscode.window.showErrorMessage('Failed to open log details. See Salesforce Assist Buddy output for details.');
            }
        });
        context.subscriptions.push(disposable);
    }

    public static async showLogDetailsWebview(logContent: string, fileName: string, extensionUri: vscode.Uri) {
        logger.debug('LogDetails', 'Creating details webview');
        const panel = vscode.window.createWebviewPanel(
            extensionIds.detailsView,
            `Log Details: ${fileName.split('\\').pop()}`,
            vscode.ViewColumn.Active,
            { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src', 'tools', 'logViewer', 'details')] }
        );
        const htmlPath = path.join(extensionUri.fsPath, 'src', 'tools', 'logViewer', 'details', 'ApexLogDetails.html');
        let html = fs.readFileSync(htmlPath, 'utf8');
        const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'tools', 'logViewer', 'details', 'ApexLogDetails.js'));
        const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'tools', 'logViewer', 'details', 'ApexLogDetails.css'));
        html = html.replace('${scriptUri}', scriptUri.toString());
        html = html.replace('${styleUri}', styleUri.toString());
        panel.webview.html = html;
        // Send logContent immediately after setting the HTML.
        panel.webview.postMessage({ logContent, fileName: fileName.split('\\').pop() });
        // Support reloads by resending the log when requested by the webview.
        panel.webview.onDidReceiveMessage((msg) => {
            if (msg?.type === 'diagnostic' && typeof msg.message === 'string') {
                logger.error('Webview.details.script', msg.message.slice(0, 4000));
            } else if (msg && msg.type === 'ready') {
                logger.debug('LogDetails', 'Client ready; sending log to renderer');
                panel.webview.postMessage({ logContent, fileName: fileName.split('\\').pop() });
            }
        });
    }
}
