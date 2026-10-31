import * as vscode from 'vscode';
import * as path from 'path';
import { getConnection } from './core/connection';
import { setLogVisibility, deleteAllLogs, toggleAutoRefresh, showOptions, showSearchBox, clearSearch, clearDownloadedLogs, setTraceFlagForUser, setTraceFlagBySearch, deleteAllTraceFlagsExceptCurrent } from './tools/logViewer/commands';
import { ApexLogPanelProvider } from './tools/logViewer/panel/ApexLogPanelProvider';
import { stopTraceFlagKeepAlive } from './tools/logViewer/TraceFlagManager';
import { ApexLogDetails } from './tools/logViewer/details/ApexLogDetails';
import { logger, outputChannel, startLogRetention } from './core/logger';
import { commandId, extensionIds, getConfiguration } from './core/extensionIdentity';
import { configureLogViewer, disposeLogViewer, getExistingLogDataProvider, getLogDataProvider, openLog } from './tools/logViewer/service';
import { QueryRunnerPanel } from './tools/soqlRunner/QueryRunnerPanel';
import { ExperienceLoginPanel } from './tools/experienceLogin/ExperienceLoginPanel';
import { ToolId } from './tools/registry';

export { outputChannel } from './core/logger';

let activeProvider: ApexLogPanelProvider | undefined;

export async function activate(context: vscode.ExtensionContext) {
    configureLogViewer(context);
    const config = getConfiguration();
    const showOutputOnStart = config.get<boolean>('showOutputOnStart') ?? true;
    context.subscriptions.push(outputChannel, startLogRetention(context.logUri));
    if (showOutputOnStart) {
        outputChannel.show(true); // Make output visible
    }
    logger.info('Activation', 'Starting Salesforce Assist Buddy');

    // Register the ApexLogDetails command
    ApexLogDetails.registerCommand(context);

    try {
        // Create file watchers to detect org changes in the configuration file.
        setupConfigFileWatchers(context);

        // Use getLogDataProvider to ensure provider is initialized
        const provider = new ApexLogPanelProvider(context.extensionUri, await getLogDataProvider(), (toolId: ToolId) => {
            if (toolId === 'soql-runner') {
                        context.subscriptions.push(new QueryRunnerPanel(context));
            } else if (toolId === 'experience-login') {
                context.subscriptions.push(new ExperienceLoginPanel(context));
            }
        });
        activeProvider = provider;

        // Set the active provider on the LogDataProvider
        (await getLogDataProvider()).setActiveProvider(provider);

        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider(extensionIds.logView, provider)
        );

        // Register the extension commands.
        registerCommands(context, provider);

        // Subscribe to LogDataProvider data-change events.
        (await getLogDataProvider()).onDidChangeData(({ data, isAutoRefresh }) => {
            provider.updateView(data, isAutoRefresh);
        });

        logger.info('Activation', 'Extension ready');

        // TODO: Add a setting to control whether the log panel opens on activation.
        setTimeout(() => {
            void vscode.commands.executeCommand(`${extensionIds.logView}.focus`).then(undefined, error => {
                logger.error('Activation.focusPanel', 'Could not focus the log panel', error);
            });
        }, 500); // Delay before closing the output panel.

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Activation', 'Initialization stopped', error);
        vscode.window.showErrorMessage(`Failed to initialize Salesforce Assist Buddy: ${errorMessage}`);
    }
}

function setupConfigFileWatchers(context: vscode.ExtensionContext) {
    // Watch workspace config
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (workspaceRoot) {
        const workspaceWatcher = createConfigWatcher(path.join(workspaceRoot, '.sf', 'config.json'));
        context.subscriptions.push(workspaceWatcher);
    }

    // Watch user home config
    const homeDir = process.env.USERPROFILE ?? process.env.HOME;
    if (homeDir) {
        const homeWatcher = createConfigWatcher(path.join(homeDir, '.sf', 'config.json'));
        context.subscriptions.push(homeWatcher);
    }
}

// Create a watcher for changes to the .sf/config.json configuration file.
function createConfigWatcher(configPath: string): vscode.FileSystemWatcher {
    const watcher = vscode.workspace.createFileSystemWatcher(configPath);

    watcher.onDidChange(async () => {
        logger.debug('OrgChange', `Configuration changed: ${configPath}`);
        try {
            const logDataProvider = getExistingLogDataProvider();
            if (logDataProvider && activeProvider) {
                // Always stop all trace flag keep-alive timers before switching orgs
                stopTraceFlagKeepAlive();
                // Show an org-change notification if the panel is visible.
                if (logDataProvider.isVisible) {
                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: 'Switching org and retrieving logs',
                        cancellable: false
                    }, async (progress) => {
                        progress.report({ message: 'Updating connection...' });
                        const newConnection = await getConnection();
                        await logDataProvider!.updateConnection(newConnection);
                        progress.report({ message: 'Refreshing logs...' });
                        await new Promise(res => setTimeout(res, 300));
                    });
                    logger.info('OrgChange', 'Connection updated and logs refreshed');
                    // Send orgChanged message to webview to close search bar
                    activeProvider.postMessage({ type: 'orgChanged' });
                } else {
                    // If not visible, just update connection and logs silently
                    const newConnection = await getConnection();
                    await logDataProvider.updateConnection(newConnection);
                    logger.info('OrgChange', 'Connection updated and logs refreshed (panel hidden)');

                }
            }
        } catch (error) {
            logger.error('OrgChange', 'Connection update or refresh stopped', error);
        }
    });
    return watcher;
}

// Register the extension commands and associate them with their handlers.
function registerCommands(context: vscode.ExtensionContext, provider: ApexLogPanelProvider) {
    type CommandHandler = (...args: any[]) => any;
    const commands: [string, CommandHandler][] = [
        ['refreshLogs', async () => await provider.refresh()],
        ['openLog', openLog],
        ['toggleCurrentUserOnly', setLogVisibility],
        ['toggleAutoRefresh', toggleAutoRefresh],
        ['deleteAllLogs', deleteAllLogs],
        ['showOptions', showOptions],
        ['showSearchBox', showSearchBox],
        ['clearSearch', clearSearch],
        ['clearDownloadedLogs', clearDownloadedLogs],
        ['setTraceFlagForUser', setTraceFlagForUser],
        ['setTraceFlagBySearch', setTraceFlagBySearch],
        ['deleteAllTraceFlagsExceptCurrent', deleteAllTraceFlagsExceptCurrent]
    ];

    const disposables = commands.map(([name, handler]) => {
        const id = commandId(name);
        return vscode.commands.registerCommand(id, async (...args: any[]) => {
            logger.debug(id, 'Command invoked');
            try {
                return await handler(...args);
            } catch (error) {
                logger.error(id, 'Command stopped unexpectedly', error);
                throw error;
            }
        });
    });

    context.subscriptions.push(...disposables);
}

// Called when the extension is deactivated (standard lifecycle hook).
export function deactivate() {
    logger.info('Lifecycle', 'Stopping timers and disposing the log provider');
    stopTraceFlagKeepAlive();
    disposeLogViewer();
    activeProvider = undefined;
}

export { getLogDataProvider, openLog };