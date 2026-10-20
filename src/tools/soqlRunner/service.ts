import { statSync } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { AuthenticatedOrgService, OrgSelection } from '../../core/authenticatedOrgs';
import { logger } from '../../core/logger';
import { AuthenticatedOrg, buildSoql, formatCliErrorOutput, QueryTableData, resolveSalesforceDirectory, SavedQuery, toQueryTableData } from './queryData';

const maximumQueryRows = 50000;

const starterQueries: SavedQuery[] = [{
    id: 'accounts-by-name',
    name: 'Accounts by name',
    soql: 'SELECT Id, Name, Type FROM Account WHERE Name LIKE {{namePattern}} ORDER BY Name LIMIT {{rowLimit}}',
    parameters: [
        { name: 'namePattern', label: 'Name pattern', type: 'text', defaultValue: '%' },
        { name: 'rowLimit', label: 'Maximum rows', type: 'number', defaultValue: '100' }
    ]
}];

interface CliError extends Error {
    stdout?: string;
    stderr?: string;
}

export { OrgSelection } from '../../core/authenticatedOrgs';

export class SoqlRunnerService {
    private readonly queryFilePath: string;
    private readonly orgService = new AuthenticatedOrgService('SOQL Query Runner');

    constructor(context: vscode.ExtensionContext) {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const sfDirectory = workspaceRoot && path.join(workspaceRoot, '.sf');
        const sfdxDirectory = workspaceRoot && path.join(workspaceRoot, '.sfdx');
        const salesforceDirectory = resolveSalesforceDirectory(
            sfdxDirectory && isDirectory(sfdxDirectory) ? sfdxDirectory : undefined,
            sfDirectory && isDirectory(sfDirectory) ? sfDirectory : undefined
        );
        const storageRoot = workspaceRoot
            ? path.join(salesforceDirectory || sfdxDirectory!, 'salesforce-assist-buddy')
            : context.globalStorageUri.fsPath;
        this.queryFilePath = path.join(storageRoot, 'queries.json');
    }

    public get savedQueriesFilePath(): string {
        return this.queryFilePath;
    }

    public async getInitialState(): Promise<{ orgs: AuthenticatedOrg[]; defaultUsername: string; queries: SavedQuery[]; orgError?: string }> {
        const queries = await this.loadSavedQueries();
        try {
            return { ...await this.listOrgs(), queries };
        } catch (error) {
            return {
                orgs: [],
                defaultUsername: '',
                queries,
                orgError: error instanceof Error ? error.message : 'Could not list authenticated Salesforce orgs.'
            };
        }
    }

    public async listOrgs(forceRefresh = false): Promise<OrgSelection> {
        return this.orgService.listOrgs(forceRefresh);
    }

    public async loadSavedQueries(): Promise<SavedQuery[]> {
        await this.ensureSavedQueriesFile();
        const content = await fs.readFile(this.queryFilePath, 'utf8');
        const parsed = JSON.parse(content);
        if (!Array.isArray(parsed.queries)) throw new Error('The saved query file must contain a queries array.');
        return parsed.queries.map(validateSavedQuery);
    }

    public async ensureSavedQueriesFile(): Promise<void> {
        await fs.mkdir(path.dirname(this.queryFilePath), { recursive: true });
        try {
            await fs.access(this.queryFilePath);
            return;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }

        await this.writeSavedQueries(starterQueries);
    }

    public async saveQuery(query: SavedQuery): Promise<SavedQuery[]> {
        const validQuery = validateSavedQuery(query);
        const queries = await this.loadSavedQueries();
        const index = queries.findIndex(saved => saved.id === validQuery.id);
        if (index < 0) queries.push(validQuery);
        else queries[index] = validQuery;
        await this.writeSavedQueries(queries);
        return queries;
    }

    public async deleteQuery(id: string): Promise<SavedQuery[]> {
        const queries = (await this.loadSavedQueries()).filter(query => query.id !== id);
        await this.writeSavedQueries(queries);
        return queries;
    }

    public async runQuery(username: string, query: SavedQuery, values: Record<string, unknown>): Promise<QueryTableData> {
        try {
            const { orgs } = await this.listOrgs();
            if (!orgs.some(org => org.username === username)) {
                throw new Error('Select an authenticated Salesforce org before running the query.');
            }

            const soql = buildSoql(validateSavedQuery(query), values);
            logger.info('SOQL Query Runner.query', 'Query started for the selected org');
            const response = await logger.run('SOQL Query Runner.query', () => this.executeQuery(username, soql));
            const records = response.records;
            if (!Array.isArray(records)) throw new Error('Salesforce CLI returned an unexpected query response.');
            if (!response.done) {
                logger.warn('SOQL Query Runner.query', `Results reached the ${maximumQueryRows}-row fetch limit`);
            }
            const result = toQueryTableData(records);
            logger.info('SOQL Query Runner.query', `Query completed with ${records.length} rows`);
            return result;
        } catch (error) {
            const details = readableCliError(error, 'SOQL query failed. Check the query and org access, then try again.');
            logger.error('SOQL Query Runner.query', 'SOQL query failed', new Error(details));
            throw new Error(details);
        }
    }

    private async executeQuery(username: string, soql: string) {
        return this.orgService.run(username, async connection =>
            await connection.query(soql, { autoFetch: true, maxFetch: maximumQueryRows }));
    }

    private async writeSavedQueries(queries: SavedQuery[]) {
        await fs.mkdir(path.dirname(this.queryFilePath), { recursive: true });
        const temporaryPath = `${this.queryFilePath}.tmp-${process.pid}-${Date.now()}`;
        await fs.writeFile(temporaryPath, `${JSON.stringify({ version: 1, queries }, null, 2)}\n`, 'utf8');
        await fs.rename(temporaryPath, this.queryFilePath);
    }
}

function validateSavedQuery(value: any): SavedQuery {
    if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.name.trim() ||
        typeof value.soql !== 'string' || !value.soql.trim() || typeof value.id !== 'string' || !value.id.trim()) {
        throw new Error('Each saved query needs an ID, name, and SOQL statement.');
    }
    if (!Array.isArray(value.parameters)) throw new Error(`Saved query "${value.name}" has an invalid parameter list.`);
    return {
        id: value.id,
        name: value.name.trim(),
        soql: value.soql.trim(),
        parameters: value.parameters.map((parameter: any) => {
            if (!parameter || typeof parameter.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter.name) ||
                !['text', 'number', 'boolean', 'date', 'datetime'].includes(parameter.type)) {
                throw new Error(`Saved query "${value.name}" has an invalid parameter definition.`);
            }
            return {
                name: parameter.name,
                label: typeof parameter.label === 'string' && parameter.label.trim() ? parameter.label.trim() : parameter.name,
                type: parameter.type,
                defaultValue: typeof parameter.defaultValue === 'string' ? parameter.defaultValue : ''
            };
        })
    };
}

function readableCliError(error: unknown, fallback: string): string {
    const cliError = error as CliError;
    const output = formatCliErrorOutput(cliError?.stdout, cliError?.stderr);
    if (output) return output;
    return cliError?.message || fallback;
}

function isDirectory(directoryPath: string): boolean {
    try {
        return statSync(directoryPath).isDirectory();
    } catch {
        return false;
    }
}
