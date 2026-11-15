import * as vscode from 'vscode';
import { LogDataProvider } from './ApexLogDataProvider';
import { ApexLog } from './ApexLogWrapper';
import { getConnection, retryOnSessionExpire } from '../../core/connection';
import { logger } from '../../core/logger';
import { getConfiguration } from '../../core/extensionIdentity';

let logDataProvider: LogDataProvider | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

export function configureLogViewer(context: vscode.ExtensionContext) {
    extensionContext = context;
}

export function getExistingLogDataProvider() {
    return logDataProvider;
}

export function disposeLogViewer() {
    logDataProvider?.dispose();
    logDataProvider = undefined;
    extensionContext = undefined;
}

export async function getLogDataProvider(): Promise<LogDataProvider> {
    if (!logDataProvider) {
        if (!extensionContext) {
            throw new Error('Log Viewer has not been initialized');
        }
        const config = getConfiguration();
        const connection = await getConnection();
        logDataProvider = await LogDataProvider.create(
            extensionContext,
            connection,
            {
                autoRefresh: config.get('autoRefresh') ?? true,
                refreshInterval: config.get('refreshInterval') ?? 5000,
                currentUserOnly: config.get('currentUserOnly') ?? true
            }
        );
        logger.debug('Provider', 'Log provider initialized');
    }
    return logDataProvider;
}

export async function openLog(data: { id: string }) {
    try {
        const provider = await getLogDataProvider();
        const result = await logger.run(`OpenLog.retrieve:${data.id}`, () => retryOnSessionExpire(
            (conn) => conn.tooling.retrieve('ApexLog', data.id) as Promise<any>,
            provider
        ));
        if (!result) {
            throw new Error(`Log with ID ${data.id} not found`);
        }

        const log = new ApexLog({
            Id: result.Id,
            LogUser: { Name: result.LogUser?.Name ?? 'Unknown' },
            Operation: result.Operation ?? '',
            StartTime: result.StartTime ?? new Date().toISOString(),
            Status: result.Status ?? '',
            LogLength: result.LogLength ?? 0,
            DurationMilliseconds: result.DurationMilliseconds ?? 0,
            Application: result.Application ?? '',
            Location: result.Location ?? '',
            Request: result.Request ?? ''
        }, provider.connection);

        await provider.logFileManager.showLog(log);
        getExistingLogDataProvider()?.markLogAsOpened(log.id);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('OpenLog', `Could not open log ${data.id}`, error);
        vscode.window.showErrorMessage(`Failed to open log: ${errorMessage}`);
    }
}