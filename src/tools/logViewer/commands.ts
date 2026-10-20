import * as vscode from 'vscode';
import { getLogDataProvider } from './service';
import { enableTraceFlagForUser, disableTraceFlagForUser } from './TraceFlagManager';
import { retryOnSessionExpire } from '../../core/connection';
import { logger } from '../../core/logger';
import { getConfiguration } from '../../core/extensionIdentity';

// Change which logs are shown in the panel.
export async function setLogVisibility() {
    const provider = await getLogDataProvider();
    const currentSetting = provider.getCurrentUserOnlySetting();

    const items: vscode.QuickPickItem[] = [
        {
            label: `${currentSetting ? '✓' : '  '} Current user only`,
            description: "Display only the Salesforce developer logs for the currently connected user",
            picked: currentSetting
        },
        {
            label: `${!currentSetting ? '✓' : '  '} All users`,
            description: "Display Salesforce developer logs from all users with active trace flags on the target org",
            picked: !currentSetting
        }
    ];

    const selection = await vscode.window.showQuickPick(items, {
        placeHolder: "Select log visibility setting"
    });

    if (!selection) {
        return; // User cancelled
    }

    const wantsCurrentUserOnly = selection.label.includes("Current user only");

    if (wantsCurrentUserOnly !== currentSetting) {
        try {
            await provider.setCurrentUserOnly(wantsCurrentUserOnly);
            const status = wantsCurrentUserOnly ? 'Current User Only' : 'All Users';
            vscode.window.showInformationMessage(`Log visibility set to: ${status}`);
        } catch (error: any) {
            const errorMessage = error?.message || 'Unknown error occurred';
            logger.error('Command.logVisibility', 'Could not update log visibility', error);
            vscode.window.showErrorMessage(`Failed to set log visibility: ${errorMessage}`);
        }
    }
}

// Delete all Apex logs from the Salesforce org.
export async function deleteAllLogs() {
    const confirmation = await vscode.window.showWarningMessage(
        'Are you sure you want to delete ALL Apex logs from your Salesforce org? This action cannot be undone.',
        { modal: true },
        'Delete All Logs'
    );

    if (confirmation !== 'Delete All Logs') {
        logger.debug('Command.deleteLogs', 'Cancelled by user; no logs deleted');
        vscode.window.showInformationMessage('Delete logs operation cancelled.');
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Deleting Salesforce logs...",
        cancellable: false
    }, async (progress) => {
        try {
            const provider = await getLogDataProvider();
            const connection = provider.connection;

            progress.report({ message: "Querying log IDs..." });
            const result = await logger.run('Command.deleteLogs.queryIds', () => retryOnSessionExpire(
                async (conn) => await conn.tooling.query('SELECT Id FROM ApexLog LIMIT 10000'),
                provider
            )) as { records: { Id: string }[] };

            if (!result.records || result.records.length === 0) {
                logger.debug('Command.deleteLogs', 'No remote logs found; nothing to delete');
                vscode.window.showInformationMessage('No logs found to delete.');
                provider.notifyDataChange();
                return;
            }

            const logIds = result.records.map(record => record.Id);
            const chunkSize = 200;
            let deletedCount = 0;

            for (let i = 0; i < logIds.length; i += chunkSize) {
                const chunk = logIds.slice(i, i + chunkSize);
                progress.report({
                    message: `Deleting logs ${i + 1}-${Math.min(i + chunkSize, logIds.length)} of ${logIds.length}...`
                });

                try {
                    await logger.run(`Command.deleteLogs.batch:${i + 1}-${Math.min(i + chunkSize, logIds.length)}`, () => Promise.all(chunk.map(id =>
                        connection.request({
                            method: 'DELETE',
                            url: `/services/data/v58.0/sobjects/ApexLog/${id}`
                        }).then(() => {
                            deletedCount++;
                        }).catch(err => {
                            if (!/entity is deleted|not found|resource does not exist/i.test(err?.message || '')) {
                                throw err;
                            }
                        })
                    )));
                } catch (err: any) {
                    throw new Error(`Error deleting logs ${i + 1}-${Math.min(i + chunkSize, logIds.length)} of ${logIds.length}; ${deletedCount} confirmed deleted so far; other in-flight deletes may still finish: ${err.message || err}`);
                }
            }

            vscode.window.showInformationMessage(`Successfully deleted ${deletedCount} logs.`);
            await provider.refreshLogs();
            provider.notifyDataChange();

        } catch (error: any) {
            const errorMessage = error?.message || 'Unknown error occurred';
            logger.error('Command.deleteLogs', 'Delete-all workflow stopped', error);
            vscode.window.showErrorMessage(`Failed to delete logs: ${errorMessage}`);
        }
    });
}


// Toggle log auto-refresh in the panel.
export async function toggleAutoRefresh() {
    const provider = await getLogDataProvider();
    const currentSetting = provider.getAutoRefreshSetting();

    const items: vscode.QuickPickItem[] = [
        {
            label: `${currentSetting ? '✓' : '  '} Auto-refresh enabled`,
            description: "Automatically refresh logs at the configured interval",
            picked: currentSetting
        },
        {
            label: `${!currentSetting ? '✓' : '  '} Auto-refresh disabled`,
            description: "Manually refresh logs using the refresh button",
            picked: !currentSetting
        }
    ];

    const selection = await vscode.window.showQuickPick(items, {
        placeHolder: "Select auto-refresh setting"
    });

    if (!selection) {
        return;
    }

    const wantsAutoRefresh = selection.label.includes("enabled");

    if (wantsAutoRefresh !== currentSetting) {
        try {
            await provider.setAutoRefresh(wantsAutoRefresh);
            const status = wantsAutoRefresh ? 'Enabled' : 'Disabled';
            vscode.window.showInformationMessage(`Auto-refresh ${status}`);
        } catch (error: any) {
            const errorMessage = error?.message || 'Unknown error occurred';
            logger.error('Command.autoRefresh', 'Could not change auto-refresh setting', error);
            vscode.window.showErrorMessage(`Failed to set auto-refresh: ${errorMessage}`);
        }
    }
}

// Show the general settings menu.
export async function showOptions() {
    const provider = await getLogDataProvider();
    const currentAutoRefresh = provider.getAutoRefreshSetting();
    const config = getConfiguration();
    const traceFlagExpiration = config.get<number>('traceFlagExpirationInterval') ?? 15;
    const showOutputOnStart = config.get<boolean>('showOutputOnStart') ?? true;

    const items: vscode.QuickPickItem[] = [
        {
            label: "Auto-refresh",
            description: currentAutoRefresh ? "✓ Enabled" : "✗ Disabled",
            detail: "Automatically refresh logs at the configured interval",
            picked: currentAutoRefresh
        },
        {
            label: "Refresh Interval",
            description: `${config.get('refreshInterval')}ms`,
            detail: "Set the interval between automatic refreshes"
        },
        {
            label: "Trace Flag update expiration time interval",
            description: `${traceFlagExpiration} min` + (traceFlagExpiration < 5 ? ' (minimum 5)' : ''),
            detail: "Set the update interval (in minutes) for Salesforce trace flags expiration time. Minimum: 5, Default: 15."
        },
        {
            label: "Show Output on Start",
            description: showOutputOnStart ? "✓ Enabled" : "✗ Disabled",
            detail: "Show the Salesforce Assist Buddy output channel when the extension starts",
            picked: showOutputOnStart
        }
    ];

    const selection = await vscode.window.showQuickPick(items, {
        placeHolder: "Select an option to configure"
    });

    if (!selection) {
        return;
    }

    // Handle the selected menu option.
    switch (selection.label) {
        case "Auto-refresh":
            await toggleAutoRefresh();
            break;
        case "Refresh Interval":
            await setRefreshInterval(config);
            break;
        case "Trace Flag update expiration time interval":
            await setTraceFlagExpirationInterval(config, traceFlagExpiration);
            break;
        case "Show Output on Start":
            await setShowOutputOnStart(config, showOutputOnStart);
            break;
    }
}

//Set trace flag expiration interval in minutes + validation input
async function setTraceFlagExpirationInterval(config: vscode.WorkspaceConfiguration, current: number) {
    const interval = await vscode.window.showInputBox({
        prompt: "Enter trace flag expiration interval in minutes (minimum 5)",
        value: current.toString(),
        validateInput: (value) => {
            const num = parseInt(value);
            if (isNaN(num) || num < 5) {
                return "Please enter a valid number greater than or equal to 5";
            }
            return null;
        }
    });
    if (interval) {
        await config.update('traceFlagExpirationInterval', parseInt(interval), vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Trace flag expiration interval set to ${interval} minutes`);
    }
}

// Set the log refresh interval.
async function setRefreshInterval(config: vscode.WorkspaceConfiguration) {
    const interval = await vscode.window.showInputBox({
        prompt: "Enter refresh interval in milliseconds",
        value: config.get('refreshInterval')?.toString(),
        validateInput: (value) => {
            const num = parseInt(value);
            if (isNaN(num) || num < 1000) {
                return "Please enter a valid number greater than 1000";
            }
            return null;
        }
    });
    if (interval) {
        await config.update('refreshInterval', parseInt(interval), vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Refresh interval set to ${interval}ms`);
    }
}

// Show the log search box.
export async function showSearchBox() {
    try {
        const provider = await getLogDataProvider();
        // Use the panel's search box.
        const activeProvider = (provider as any).activeProvider;
        if (activeProvider && typeof activeProvider.showSearchBoxInWebview === 'function') {
            activeProvider.showSearchBoxInWebview();
        } else {
            logger.warn('Command.search', 'Search unavailable: the log panel provider is not ready');
        }
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        logger.error('Command.search', 'Could not show log search', error);
        vscode.window.showErrorMessage(`Failed to filter logs: ${errorMessage}`);
    }
}

// Clear the log search filter. TODO: Currently unused.
export async function clearSearch() {
    try {
        const provider = await getLogDataProvider();
        provider.clearSearch();
        vscode.window.showInformationMessage('Search filter cleared');
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        logger.error('Command.clearSearch', 'Could not clear the search filter', error);
        vscode.window.showErrorMessage(`Failed to clear search: ${errorMessage}`);
    }
}

// Clear locally downloaded logs.
export async function clearDownloadedLogs() {
    const confirmation = await vscode.window.showWarningMessage(
        'Are you sure you want to clear all downloaded log files? This action cannot be undone.',
        { modal: true },
        'Clear Downloaded Logs'
    );

    if (confirmation !== 'Clear Downloaded Logs') {
        vscode.window.showInformationMessage('Clear downloaded logs operation cancelled.');
        return;
    }

    try {
        const provider = await getLogDataProvider();
        await provider.logFileManager.clearDownloadedLogs();
        vscode.window.showInformationMessage('Downloaded logs cleared successfully.');
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        logger.error('Command.clearDownloads', 'Could not clear downloaded logs', error);
        vscode.window.showErrorMessage(`Failed to clear downloaded logs: ${errorMessage}`);
    }
}

// Command to set trace flag for a selected user
export async function setTraceFlagForUser() {
    await manageTraceFlagForUser();
}

export async function setTraceFlagBySearch() {
    try {
        const keyword = await vscode.window.showInputBox({
            title: 'Set TraceFlag by Username or Email',
            prompt: 'Search keyword',
            placeHolder: 'Username or email',
            ignoreFocusOut: true,
            validateInput: value => value.trim() ? undefined : 'Enter a search keyword'
        });
        if (!keyword?.trim()) return;
        await manageTraceFlagForUser(keyword.trim());
    } catch (error) {
        logger.error('Command.userTraceFlagSearch', 'Could not start the username/email search', error);
        vscode.window.showErrorMessage('Failed to search users. See the Salesforce Assist Buddy output for details.');
    }
}

async function manageTraceFlagForUser(searchKeyword?: string) {
    try {
        const provider = await getLogDataProvider();
        const currentUserId = await provider.getCurrentUserId();
        const picked = await pickTraceFlagUser(provider, currentUserId, searchKeyword);
        if (!picked) return;
        if (picked.hasTraceFlag) {
            await disableTraceFlagForUser(provider.connection, picked.userId);
            vscode.window.showInformationMessage(`Trace flag disabled for user: ${picked.displayName}`);
            return;
        } else {
            await enableTraceFlagForUser(provider.connection, picked.userId);
            vscode.window.showInformationMessage(`Trace flag enabled and will be auto-updated for user: ${picked.displayName}`);
        }
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        logger.error('Command.userTraceFlag', 'Could not change the selected user trace flag', error);
        vscode.window.showErrorMessage(`Failed to manage trace flag for user: ${errorMessage}`);
    }
}

interface TraceFlagUserItem extends vscode.QuickPickItem {
    userId: string;
    displayName: string;
    hasTraceFlag: boolean;
}

async function pickTraceFlagUser(
    provider: Awaited<ReturnType<typeof getLogDataProvider>>,
    currentUserId: string,
    searchKeyword?: string
): Promise<TraceFlagUserItem | undefined> {
    const picker = vscode.window.createQuickPick<TraceFlagUserItem>();
    picker.title = searchKeyword === undefined ? 'Set TraceFlag for User' : 'Set TraceFlag by Username or Email';
    const placeholder = searchKeyword === undefined
        ? 'Search by any part of a name or by username prefix (up to 100 users shown)'
        : 'Select a matching user (up to 100 users shown)';
    picker.placeholder = placeholder;
    picker.ignoreFocusOut = true;
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    let version = 0;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const subscriptions: vscode.Disposable[] = [];

    async function loadUsers(search: string, requestVersion: number) {
        try {
            await logger.run('Command.users.search', async () => {
                const value = search.trim().replace(/[\\'%_]/g, '\\$&').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
                const filter = searchKeyword !== undefined
                    ? ` AND (Username LIKE '%${value}%' OR Email LIKE '%${value}%')`
                    : value ? ` AND (Name LIKE '%${value}%' OR Username LIKE '${value}%')` : '';
                const users = await retryOnSessionExpire(async conn => await conn.query(
                    `SELECT Id, Name, Username, Email FROM User WHERE IsActive = true AND Id != '${currentUserId}'${filter} ORDER BY Name, Id LIMIT 100`
                ), provider) as { records: { Id: string; Name: string; Username: string; Email?: string | null }[] };
                if (closed || requestVersion !== version) return;
                if (!users.records.length && searchKeyword !== undefined) {
                    vscode.window.showInformationMessage('No active users matched the username or email search.');
                    picker.hide();
                    return;
                }

                let activeUserIds = new Set<string>();
                if (users.records.length) {
                    const ids = users.records.map(user => `'${user.Id}'`).join(',');
                    const flags = await retryOnSessionExpire(async conn => await conn.tooling.query(
                        `SELECT TracedEntityId FROM TraceFlag WHERE TracedEntityId IN (${ids}) AND LogType = 'DEVELOPER_LOG' AND ExpirationDate > ${new Date().toISOString()}`
                    ), provider) as { records: { TracedEntityId: string }[] };
                    activeUserIds = new Set(flags.records.map(flag => flag.TracedEntityId));
                }
                if (closed || requestVersion !== version) return;

                picker.items = users.records.map(user => {
                    const hasTraceFlag = activeUserIds.has(user.Id);
                    return {
                        label: `${hasTraceFlag ? '$(check)' : '$(circle-outline)'} ${user.Name} - (${user.Username})`,
                        displayName: `${user.Name} - (${user.Username})`,
                        description: "",
                        detail: user.Email ?? undefined,
                        alwaysShow: searchKeyword === undefined,
                        userId: user.Id,
                        hasTraceFlag
                    };
                });
                picker.placeholder = users.records.length ? placeholder : 'No matching active users. Search by another part of a name or username prefix.';
            });
        } catch (error) {
            if (!closed && requestVersion === version) {
                logger.error('Command.users.search', 'Could not load users or trace flag status', error);
                picker.items = [];
                picker.placeholder = searchKeyword === undefined
                    ? 'Could not load users. Type to retry; see the output channel for details.'
                    : 'Could not load users. Run the command again; see the output channel for details.';
            }
        } finally {
            if (!closed && requestVersion === version) picker.busy = false;
        }
    }

    try {
        return await new Promise<TraceFlagUserItem | undefined>(resolve => {
            let selected: TraceFlagUserItem | undefined;
            subscriptions.push(
                picker.onDidChangeValue(value => {
                    if (searchKeyword !== undefined) return;
                    const requestVersion = ++version;
                    if (timer) clearTimeout(timer);
                    picker.items = [];
                    picker.busy = true;
                    timer = setTimeout(() => { void loadUsers(value, requestVersion); }, 300);
                }),
                picker.onDidAccept(() => {
                    if (picker.busy || !picker.selectedItems[0]) return;
                    selected = picker.selectedItems[0];
                    picker.hide();
                }),
                picker.onDidHide(() => {
                    closed = true;
                    resolve(selected);
                })
            );
            picker.busy = true;
            picker.show();
            void loadUsers(searchKeyword ?? '', version);
        });
    } finally {
        closed = true;
        if (timer) clearTimeout(timer);
        subscriptions.forEach(subscription => subscription.dispose());
        picker.dispose();
    }
}

// Command to delete all trace flags except the current user's
export async function deleteAllTraceFlagsExceptCurrent() {
    try {
        const provider = await getLogDataProvider();
        const connection = provider.connection;
        const currentUserId = await provider.getCurrentUserId();
        // Query all trace flags except the current user's and the active ones
        const nowIso = new Date().toISOString();
        const traceFlagResult = await logger.run('Command.deleteTraceFlags.query', () => retryOnSessionExpire(async (conn) => await conn.tooling.query(`SELECT Id, TracedEntityId FROM TraceFlag WHERE TracedEntityId != '${currentUserId}' AND ExpirationDate < ${nowIso}`), provider)) as { records: any[] };
        if (!traceFlagResult.records || traceFlagResult.records.length === 0) {
            vscode.window.showInformationMessage('No trace flags found to delete');
            return;
        }
        for (const tf of traceFlagResult.records) {
            await logger.run(`Command.deleteTraceFlags:${tf.Id}`, () => retryOnSessionExpire(async (conn) => await conn.tooling.delete('TraceFlag', tf.Id), provider));
        }
        vscode.window.showInformationMessage('All trace flags deleted except the current user.');
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        logger.error('Command.deleteTraceFlags', 'Trace flag deletion stopped; some flags may already have been deleted', error);
        vscode.window.showErrorMessage(`Failed to delete trace flags: ${errorMessage}`);
    }
}

// Set whether to show the output channel when the extension starts.
async function setShowOutputOnStart(config: vscode.WorkspaceConfiguration, current: boolean) {
    const newValue = !current;
    await config.update('showOutputOnStart', newValue, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Show Output on Start set to ${newValue ? 'Enabled' : 'Disabled'}`);
}