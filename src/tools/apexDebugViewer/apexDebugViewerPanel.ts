import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { scanApexSources } from './apexSourceScan';
import { commandId, extensionIds, getConfiguration } from '../../core/extensionIdentity';
import { logger } from '../../core/logger';

const DEFAULT_SOURCE_PATH = 'force-app/main/default/classes';

let panel: vscode.WebviewPanel | null = null;
let webviewReady = false;
let pendingLogs: { name: string; text: string }[] = [];
let activationContext: vscode.ExtensionContext | null = null;

const OUTPUT_CHANNEL_NAME = 'Apex Debug Log Viewer';

let output: vscode.OutputChannel | null = null;

function getWebviewHtml(context: vscode.ExtensionContext, panel: vscode.WebviewPanel): string {
    const htmlPath = path.join(context.extensionPath, 'src', 'tools', 'apexDebugViewer', 'webview', 'sf-debug-viewer.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    const nonce = require('crypto').randomBytes(16).toString('base64');
    html = html.split('${cspSource}').join(panel.webview.cspSource);
    html = html.split('${nonce}').join(nonce);
    return html;
}

function getDefaultWorkspaceRoot(): { path: string; name: string } | null {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length) {
        return { path: folders[0].uri.fsPath, name: folders[0].name };
    }
    return null;
}

function getSourcePath(): string {
    const configured = getConfiguration().get<string>('apexDebugLogViewer.sourcePath');
    if (configured && configured.trim()) return configured.trim();
    const root = getDefaultWorkspaceRoot();
    return root ? path.join(root.path, DEFAULT_SOURCE_PATH) : '';
}

async function autoScanSource(): Promise<void> {
    const sourcePath = getSourcePath();
    if (!sourcePath) return;
    try {
        const res = await scanApexSources(sourcePath);
        if (panel && webviewReady) {
            panel.webview.postMessage({
                type: 'sourceScanComplete',
                files: res.files,
                scope: res.scope,
                count: res.files.length,
                path: sourcePath,
            });
        }
        output?.appendLine(
            `[${new Date().toLocaleTimeString()}] Auto-scanned ${res.files.length} Apex files under "${sourcePath}"`
        );
    } catch (e: any) {
        output?.appendLine(`[ApexDebug] Auto-scan failed: ${e.message || e}`);
    }
}

export function activateApexDebugViewer(context: vscode.ExtensionContext): void {
    activationContext = context;
    output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    context.subscriptions.push(output);

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => { /* no CLI config to reset */ })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(commandId('openApexDebugLogViewer'), () => ensurePanel())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(commandId('openLogInApexDebugLogViewer'), async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
            let targets = Array.isArray(uris) && uris.length ? uris : (uri ? [uri] : []);
            if (!targets.length && vscode.window.activeTextEditor) {
                targets = [vscode.window.activeTextEditor.document.uri];
            }
            targets = targets.filter(u => u instanceof vscode.Uri);
            if (!targets.length) {
                vscode.window.showWarningMessage('Apex Debug Log Viewer: open or right-click a .log file first.');
                return;
            }
            for (const target of targets) await openLogUri(target);
        })
    );
}

async function handleMessage(msg: any): Promise<void> {
        if (!panel) return;
        const reply = (result: any) => panel?.webview.postMessage({ reqId: msg.reqId, result });
        const replyError = (err: any) => panel?.webview.postMessage({ reqId: msg.reqId, error: String((err && err.message) || err) });

        try {
            switch (msg.type) {
                case 'ready': {
                    webviewReady = true;
                    const root = getDefaultWorkspaceRoot();
                    panel?.webview.postMessage({
                        type: 'init',
                        path: root ? root.path : null,
                        name: root ? root.name : null,
                        sourcePath: getSourcePath(),
                        theme: getConfiguration().get<'system' | 'light' | 'dark'>('apexDebugLogViewer.theme') || 'system',
                        editorFontSize: getConfiguration().get<number>('editor.fontSize') || 14,
                        editorFontFamily: getConfiguration().get<string>('editor.fontFamily') || '',
                    });
                    const queued = pendingLogs;
                    pendingLogs = [];
                    for (const log of queued) {
                        panel?.webview.postMessage({ type: 'openLog', name: log.name, text: log.text });
                    }
                    // Auto-scan source folder (async, non-blocking for log render)
                    autoScanSource();
                    break;
                }
                case 'scanSource': {
                    const start = Date.now();
                    const res = await scanApexSources(msg.path);
                    output?.appendLine(
                        `[${new Date().toLocaleTimeString()}] Found ${res.files.length} Apex files (${res.scope}) under "${msg.path}" in ${Date.now() - start}ms`
                    );
                    reply(res);
                    break;
                }
                case 'pickSourceFolder': {
                    const picked = await vscode.window.showOpenDialog({
                        canSelectFolders: true,
                        canSelectFiles: false,
                        canSelectMany: false,
                        openLabel: 'Use as Apex source folder',
                    });
                    if (!picked || !picked.length) { reply(null); break; }
                    reply(await scanApexSources(picked[0].fsPath));
                    break;
                }
                case 'readFile': {
                    reply(await fsp.readFile(msg.path, 'utf8'));
                    break;
                }
                case 'openFile': {
                    const doc = await vscode.workspace.openTextDocument(msg.path);
                    const editor = await vscode.window.showTextDocument(doc, {
                        viewColumn: vscode.ViewColumn.Beside,
                        preview: true,
                    });
                    if (typeof msg.line === 'number' && msg.line >= 0) {
                        const pos = new vscode.Position(msg.line, 0);
                        editor.selection = new vscode.Selection(pos, pos);
                        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                    }
                    reply(true);
                    break;
                }
                case 'showRawLog': {
                    try {
                        const name = msg.name || 'raw.log';
                        const text = typeof msg.text === 'string' ? msg.text : '';
                        const tmpPath = path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir(), `${name.replace(/[\\/:*?"<>|]/g, '_')}.log`);
                        await fsp.writeFile(tmpPath, text, 'utf8');
                        const doc = await vscode.workspace.openTextDocument(tmpPath);
                        const editor = await vscode.window.showTextDocument(doc, {
                            viewColumn: vscode.ViewColumn.Beside,
                            preview: true,
                        });
                        reply(true);
                    } catch (e: any) {
                        replyError(e);
                    }
                    break;
                }
                case 'openSettings': {
                    try {
                        await vscode.commands.executeCommand('workbench.action.openSettings', msg.query || '');
                        reply(true);
                    } catch (e: any) {
                        replyError(e);
                    }
                    break;
                }
                case 'themeChanged': {
                    try {
                        await getConfiguration().update('apexDebugLogViewer.theme', msg.theme, true);
                        reply(true);
                    } catch (e: any) {
                        replyError(e);
                    }
                    break;
                }
                default:
                    reply(null);
            }
    } catch (e: any) {
        replyError(e);
    }
}

function ensurePanel(): void {
    if (!activationContext) return;
    webviewReady = false;
    panel = vscode.window.createWebviewPanel(
        'apexDebugLogViewer',
        'Apex Debug Log Viewer',
        vscode.ViewColumn.Active,
        { enableScripts: true, enableFindWidget: true, retainContextWhenHidden: true }
    );
    panel.webview.html = getWebviewHtml(activationContext, panel);
    panel.webview.onDidReceiveMessage(handleMessage);
    panel.onDidDispose(() => { panel = null; webviewReady = false; pendingLogs = []; });
}

export async function openLogContent(uri: vscode.Uri): Promise<void> {
    await openLogUri(uri);
}

async function openLogUri(uri: vscode.Uri): Promise<void> {
    let text: string;
    const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    if (openDoc) {
        text = openDoc.getText();
    } else {
        try {
            text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        } catch (e: any) {
            vscode.window.showErrorMessage(`Apex Debug Log Viewer: could not read ${uri.fsPath}: ${e.message || e}`);
            return;
        }
    }
    const log = { name: path.basename(uri.fsPath), text };
    ensurePanel();
    if (webviewReady) {
        panel?.webview.postMessage({ type: 'openLog', name: log.name, text: log.text });
    } else {
        pendingLogs.push(log);
    }
}

export function deactivateApexDebugViewer(): void {
    panel = null;
    webviewReady = false;
    pendingLogs = [];
    activationContext = null;
}
