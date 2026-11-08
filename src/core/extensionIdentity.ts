import * as vscode from 'vscode';

export const extensionIds = {
    name: 'salesforce-assist-buddy',
    configuration: 'salesforceAssistBuddy',
    logView: 'salesforceAssistBuddy.logs'
} as const;

export function commandId(command: string): string {
    return `${extensionIds.name}.${command}`;
}

export function getConfiguration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(extensionIds.configuration);
}