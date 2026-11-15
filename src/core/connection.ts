import { Connection } from 'jsforce';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { logger } from './logger';

// Minimum required sf CLI version that supports all commands used by this extension
const MIN_SF_VERSION = '2.87.0';

let currentOrgUsername: string | undefined;
let currentConnection: Connection | undefined;

// Check sf CLI version and ensure it meets minimum requirements
async function checkSfVersion(): Promise<string> {
    const { stdout } = await executeCommand('sf version');
    const versionMatch = stdout.match(/@salesforce\/cli\/(\d+\.\d+\.\d+)/);
    if (!versionMatch) {
        throw new Error('Could not determine sf CLI version. Output: ' + stdout);
    }
    const version = versionMatch[1];
    
    if (!versionSatisfies(version, MIN_SF_VERSION)) {
        const errorMsg = `Salesforce CLI version ${version} is installed, but version ${MIN_SF_VERSION} or higher is required. ` +
            `Please update sf CLI by running: sf update`;
        logger.error('Connection', errorMsg);
        vscode.window.showErrorMessage(errorMsg, { modal: true });
        throw new Error(errorMsg);
    }
    
    logger.info('Connection', `sf CLI version ${version} satisfies minimum requirement ${MIN_SF_VERSION}`);
    return version;
}

// Simple semver comparison (major.minor.patch)
function versionSatisfies(current: string, required: string): boolean {
    const currentParts = current.split('.').map(Number);
    const requiredParts = required.split('.').map(Number);
    
    for (let i = 0; i < 3; i++) {
        if (currentParts[i] > requiredParts[i]) return true;
        if (currentParts[i] < requiredParts[i]) return false;
    }
    return true; // versions are equal
}

// Get the connection to the Salesforce org.
export async function getConnection(forceRefresh = false): Promise<Connection> {
    // Check sf CLI version on first connection attempt
    if (!currentConnection) {
        try {
            await checkSfVersion();
        } catch (error: any) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error('Connection', 'Salesforce connection initialization stopped', error);
            vscode.window.showErrorMessage(`Failed to connect to Salesforce: ${errorMessage}`);
            throw error;
        }
    }

    const newOrgUsername = await getCurrentOrgFromConfig();
    if (!newOrgUsername) {
        logger.warn('Connection', 'No target org configured; connection cannot be initialized');
        throw new Error('No target org found in .sf/config.json');
    }

    // Create a new connection if the org has changed.
    if (forceRefresh || !currentConnection || currentOrgUsername !== newOrgUsername) {
        try {
            await createConnection(newOrgUsername);
        } catch (error: any) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error('Connection', 'Salesforce connection initialization stopped', error);
            vscode.window.showErrorMessage(`Failed to connect to Salesforce: ${errorMessage}`);
            throw error;
        }
    }

    return currentConnection!;
}

// Create a new connection to the Salesforce org.
async function createConnection(newOrgUsername: string): Promise<void> {

    logger.info('Connection', 'Creating connection for the selected target org');

    // Get org details using the target org
    const { stdout: orgDetailsOutputSF } = await logger.run('Connection.orgDisplay', () => executeCommand(`sf org display --json -o "${newOrgUsername}"`));
    const orgDetails = JSON.parse(orgDetailsOutputSF);

    if (!orgDetails.result) {
        throw new Error(`Failed to get org details for ${newOrgUsername}`);
    }

    const { stdout: tokenOutput } = await logger.run('Connection.accessToken', () => executeCommand(`sf org auth show-access-token --target-org "${newOrgUsername}" --json`));
    const accessToken = JSON.parse(tokenOutput).result?.accessToken;

    if (!accessToken) {
        throw new Error(`Failed to get access token for ${newOrgUsername}`);
    }

    currentConnection = new Connection({
        instanceUrl: orgDetails.result.instanceUrl,
        accessToken
    });
    currentOrgUsername = newOrgUsername;
    logger.info('Connection', 'Salesforce connection initialized');
}

// Get the current org from the .sf/config.json configuration file.
export async function getCurrentOrgFromConfig(): Promise<string | undefined> {

    // Read the current workspace (project) configuration.
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
        const org = await readTargetOrg(path.join(workspaceRoot, '.sf', 'config.json'), 'workspace');
        if (org) return org;
    }

    // Read the user's global configuration.
    // Check for .sf/config.json in the user directory.
    const homeDir = process.env.USERPROFILE ?? process.env.HOME;
    if (homeDir) {
        const org = await readTargetOrg(path.join(homeDir, '.sf', 'config.json'), 'user');
        if (org) return org;
    } else {
        logger.warn('Connection.config', 'Home directory unavailable; global config cannot be checked');
    }

    logger.debug('Connection.config', 'No target-org found in workspace or user config');
    return undefined;
}

// Read the org from the configuration file.
async function readTargetOrg(configPath: string, location: string): Promise<string | undefined> {
    try {
        const configContent = await fs.promises.readFile(configPath, 'utf8');
        const config = JSON.parse(configContent);
        if (config['target-org']) {
            logger.debug('Connection.config', `Using target org from ${location} config`);
            return config['target-org'];
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            logger.debug('Connection.config', `No ${location} config; trying fallback`);
        } else {
            logger.warn('Connection.config', `Cannot read or parse ${location} config; trying fallback`, error);
        }
    }
    return undefined;
}

function executeCommand(command: string): Promise<{ stdout: string, stderr: string }> {
    return new Promise((resolve, reject) => {
        exec(command, (error: Error | null, stdout: string, stderr: string) => {
            if (error) {
                reject(error);
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}

/**
 * Runs a Salesforce API call and automatically retries once if the session is expired.
 * @param fn The function to execute, which should use the current connection.
 * @param provider Optional LogDataProvider to update connection if needed.
 */
export async function retryOnSessionExpire<T>(fn: (connection: Connection) => Promise<T>, provider?: any): Promise<T> {
    let connection = provider?.connection ?? await getConnection();
    try {
        return await fn(connection);
    } catch (error: any) {
        const msg = error instanceof Error ? error.message : String(error);
        const code = error?.errorCode || error?.code || error?.name || '';
        if (/INVALID_SESSION_ID|INVALID_AUTH_HEADER|session expired|expired access token/i.test(`${code} ${msg}`)) {
            logger.warn('Connection.session', 'Authentication rejected; obtaining fresh credentials and retrying once');
            try {
                const newConnection = await getConnection(true);
                if (provider && typeof provider.updateConnection === 'function') {
                    await provider.updateConnection(newConnection);
                }
                const result = await fn(newConnection);
                logger.info('Connection.session', 'Session retry succeeded');
                return result;
            } catch (retryError) {
                logger.error('Connection.session', 'Reconnect or retry failed; no further retry will be attempted', retryError);
                throw retryError;
            }
        }
        throw error;
    }
}