import { execFile } from 'child_process';
import { Connection, Org } from '@salesforce/core';
import { getCurrentOrgFromConfig } from './connection';
import { logger } from './logger';

export interface AuthenticatedOrg {
    username: string;
    alias?: string;
    orgId?: string;
    isDefaultUsername?: boolean;
}

export interface OrgSelection {
    orgs: AuthenticatedOrg[];
    defaultUsername: string;
}

export function parseOrgList(payload: any): { orgs: AuthenticatedOrg[]; defaultUsername?: string } {
    const result = payload?.result ?? payload;
    const candidates = [result?.nonScratchOrgs, result?.scratchOrgs, result?.other].filter(Array.isArray).flat();
    const orgs = new Map<string, AuthenticatedOrg>();
    for (const candidate of candidates) {
        if (typeof candidate?.username !== 'string' || !candidate.username) continue;
        if (candidate.connectedStatus && candidate.connectedStatus !== 'Connected') continue;
        if (!orgs.has(candidate.username)) {
            orgs.set(candidate.username, {
                username: candidate.username,
                alias: typeof candidate.alias === 'string' ? candidate.alias : undefined,
                orgId: typeof candidate.orgId === 'string' ? candidate.orgId : undefined,
                isDefaultUsername: candidate.isDefaultUsername === true
            });
        }
    }
    const authenticatedOrgs = [...orgs.values()];
    return { orgs: authenticatedOrgs, defaultUsername: authenticatedOrgs.find(org => org.isDefaultUsername)?.username };
}

export function resolveDefaultUsername(orgs: AuthenticatedOrg[], cliDefault?: string, configuredDefault?: string): string | undefined {
    return orgs.find(org => org.username === cliDefault)?.username ||
        orgs.find(org => org.username === configuredDefault || org.alias === configuredDefault)?.username ||
        orgs[0]?.username;
}

export class AuthenticatedOrgService {
    private cachedSelection?: OrgSelection;
    private listRequest?: Promise<OrgSelection>;
    private readonly connections = new Map<string, Promise<Connection>>();

    constructor(private readonly scope: string) {}

    public async listOrgs(forceRefresh = false): Promise<OrgSelection> {
        if (!forceRefresh && this.cachedSelection) return this.cachedSelection;
        if (!forceRefresh && this.listRequest) return this.listRequest;
        const request = this.discoverOrgs();
        this.listRequest = request;
        try {
            const selection = await request;
            if (this.listRequest === request) {
                this.cachedSelection = selection;
                if (forceRefresh) this.connections.clear();
            }
            return selection;
        } finally {
            if (this.listRequest === request) this.listRequest = undefined;
        }
    }

    public async run<T>(username: string, action: (connection: Connection) => Promise<T>): Promise<T> {
        const { orgs } = await this.listOrgs();
        if (!orgs.some(org => org.username === username)) throw new Error('Select an authenticated Salesforce org.');
        const connection = await this.getConnection(username);
        try {
            return await action(connection);
        } catch (error) {
            const value = error as { errorCode?: string; code?: string; message?: string };
            if (!/INVALID_SESSION_ID|INVALID_AUTH_HEADER|session expired|expired access token/i.test(
                `${value?.errorCode || value?.code || ''} ${value?.message || ''}`
            )) throw error;
            logger.warn(`${this.scope}.connection`, 'Selected org authentication expired; reconnecting once');
            this.connections.delete(username);
            return action(await this.getConnection(username));
        }
    }

    private async getConnection(username: string): Promise<Connection> {
        let request = this.connections.get(username);
        if (!request) {
            request = Org.create({ aliasOrUsername: username }).then(org => org.getConnection());
            this.connections.set(username, request);
        }
        try {
            return await request;
        } catch (error) {
            if (this.connections.get(username) === request) this.connections.delete(username);
            throw error;
        }
    }

    private async discoverOrgs(): Promise<OrgSelection> {
        const stdout = await runOrgList();
        const { orgs, defaultUsername } = parseOrgList(JSON.parse(stdout));
        if (!orgs.length) throw new Error('No authenticated Salesforce orgs found. Authenticate with Salesforce CLI and refresh orgs.');
        const configured = defaultUsername ? undefined : await getCurrentOrgFromConfig();
        logger.debug(`${this.scope}.orgList`, `Found ${orgs.length} authenticated orgs`);
        return { orgs, defaultUsername: resolveDefaultUsername(orgs, defaultUsername, configured)! };
    }
}

function runOrgList(): Promise<string> {
    let command = 'sf';
    let args = ['org', 'list', '--json'];
    if (process.platform === 'win32') {
        const script = '& sf org list --json; exit $LASTEXITCODE';
        command = 'powershell.exe';
        args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
    }
    return new Promise((resolve, reject) => {
        execFile(command, args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
            if (error) reject(new Error('Could not list authenticated orgs. Check Salesforce CLI authentication and refresh orgs.'));
            else resolve(stdout);
        });
    });
}