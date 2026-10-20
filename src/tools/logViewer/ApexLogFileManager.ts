import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { ApexLog } from './ApexLogWrapper';
import { logger } from '../../core/logger';
import { IApexLogPanelProvider } from './panel/IApexLogPanelProvider';

export class ApexLogFileManager {

    constructor(
        private readonly storagePath?: string,
        private activeProvider?: IApexLogPanelProvider
    ) { }

    public setProvider(provider: IApexLogPanelProvider) {
        this.activeProvider = provider;
    }

    public get logsPath(): string | undefined {
        return this.storagePath ? path.resolve(this.storagePath, '.logs') : undefined;
    }

    // Get the log file name.
    private getLogFileName(log: ApexLog): string {
        // Build the name from the log start time and ID to ensure it is unique.
        const d = log.startTime;
        const pad = (n: number) => n.toString().padStart(2, '0');
        // Format the date as 05-22-2025_15-30-00.
        const formatted =
            `${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${d.getFullYear()}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

        return `${formatted}_${log.id}.log`;
    }

    // Get the full log file path.
    private getLogPath(log: ApexLog): string | undefined {
        if (!this.logsPath) return undefined;
        return path.join(this.logsPath, this.getLogFileName(log));
    }

    // Open the log in the editor.
    public async showLog(log: ApexLog): Promise<void> {
        const logPath = this.getLogPath(log);
        let fileExists = false;
        let errorInfo: { hasError: boolean, message?: string } | undefined = undefined;

        if (logPath) {
            try {
                fileExists = await fs.pathExists(logPath);
            } catch (fsErr) {
                logger.error('LogFile.cacheCheck', `Cannot inspect cached log ${log.id}; opening stopped`, fsErr);
                const errorMessage = fsErr instanceof Error ? fsErr.message : String(fsErr);
                errorInfo = { hasError: true, message: 'File system error: ' + errorMessage };
                if (this.activeProvider?.updateView) {
                    this.activeProvider.updateView([], false, errorInfo);
                }
                return;
            }
            if (fileExists) {
                // Open the file in the editor if it exists locally.
                try {
                    logger.debug('LogFile.cache', `Opening cached log ${log.id}`);
                    const document = await logger.run('LogFile.openCachedDocument', () => vscode.workspace.openTextDocument(logPath));
                    await vscode.languages.setTextDocumentLanguage(document, 'log');
                    await vscode.window.showTextDocument(document, { preview: false });
                    this.notifyLogDownloaded(log.id);
                    return;
                } catch (openErr) {
                    logger.error('LogFile.openCache', `Cannot open cached log ${log.id}; opening stopped`, openErr);
                    const errorMessage = openErr instanceof Error ? openErr.message : String(openErr);
                    errorInfo = { hasError: true, message: 'Error opening cached log: ' + errorMessage };
                    if (this.activeProvider?.updateView) {
                        this.activeProvider.updateView([], false, errorInfo);
                    }
                    return;
                }
            }

            // If the file was deleted using the clear-local-logs button and is still open,
            // close the editor before recreating it so it is not shown as deleted.
            for (const editor of vscode.window.visibleTextEditors) {
                if (editor.document.uri.fsPath === logPath) {
                    await vscode.window.showTextDocument(editor.document, { preview: false });
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                    await new Promise(res => setTimeout(res, 300));
                }
            }
        }

        // Download the log from the org if the file does not exist locally.
        try {
            logger.debug('LogFile.download', `Downloading log ${log.id}; size=${log.size} bytes`);
            const logBody = await logger.run(`LogFile.download:${log.id}`, () => log.getBody());
            const fileName = this.getLogFileName(log);
            await logger.run(`LogFile.saveAndOpen:${log.id}`, () => this.openLog(logBody, fileName));

            // Refresh the VS Code file explorer so the new log appears.
            await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
            logger.debug('LogFile.download', `Log ${log.id} downloaded and opened`);

            // Notify the webview that the log has been downloaded.
            this.notifyLogDownloaded(log.id);
        } catch (error) {
            logger.error('LogFile.download', `Download, save, or editor open stopped for log ${log.id}`, error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            errorInfo = { hasError: true, message: 'Error downloading log: ' + errorMessage };
            if (this.activeProvider?.updateView) {
                this.activeProvider.updateView([], false, errorInfo);
            }
        }
    }

    // Notify the webview that the log has been downloaded.
    private notifyLogDownloaded(logId: string) {
        if (this.activeProvider?.postMessage) {
            this.activeProvider.postMessage({
                type: 'logDownloaded',
                logId: logId
            });
        }
    }

    // Open the log file in the editor.
    private async openLog(logBody: string, logFileName: string): Promise<void> {
        //log.replace(/(^[0-9:.() ]+\|ENTERING_MANAGED_PKG\|.*\n)+/gm, '$1');
        let document: vscode.TextDocument;
        if (this.logsPath) {
            // Create the log file in the log directory and open it in the editor.
            const fullLogPath = path.join(this.logsPath, logFileName);
            await fs.ensureDir(this.logsPath);
            await fs.writeFile(fullLogPath, logBody);
            await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
            document = await vscode.workspace.openTextDocument(fullLogPath);
        } else {
            logger.debug('LogFile.open', 'No workspace storage; opening a temporary document');
            // Create a temporary document and open it if no log directory is configured.
            document = await vscode.workspace.openTextDocument({ content: logBody });
        }
        await vscode.languages.setTextDocumentLanguage(document, 'log');
        await vscode.window.showTextDocument(document, { preview: false });
    }

    // Delete locally downloaded logs.
    public async clearDownloadedLogs(): Promise<void> {
        if (this.logsPath && await fs.pathExists(this.logsPath)) {
            await logger.run('LogFile.clear', () => fs.emptyDir(this.logsPath!));

            // Close all tabs associated with the deleted local logs.
            // TODO: Make this behavior optional through a setting.
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    if (
                        tab.input && typeof tab.input === 'object' && tab.input !== null && 'uri' in tab.input &&
                        (tab.input as any).uri.fsPath.startsWith(this.logsPath)
                    ) {
                        await vscode.window.tabGroups.close(tab);
                    }
                }
            }

        } else {
            logger.debug('LogFile.clear', 'Skipped: no local log directory exists');
        }
    }
}