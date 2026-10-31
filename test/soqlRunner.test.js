const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const orgSource = ts.transpileModule(readFileSync(path.join(__dirname, '../src/core/authenticatedOrgs.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;

function loadOrgModule(dependencies) {
    const orgContext = { exports: {}, Buffer, process: { platform: 'linux' }, require(name) { return dependencies[name] || {}; } };
    vm.runInNewContext(orgSource, orgContext);
    return orgContext.exports;
}

const source = ts.transpileModule(readFileSync(path.join(__dirname, '../src/tools/soqlRunner/queryData.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const serviceSource = ts.transpileModule(readFileSync(path.join(__dirname, '../src/tools/soqlRunner/service.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const context = { exports: {}, Date, Map, Set, Number, String, RegExp, Object, JSON,
    require: () => loadOrgModule({}) };
vm.runInNewContext(source, context);
const queryData = context.exports;
const plain = value => JSON.parse(JSON.stringify(value));

function loadService(workspaceFolders = []) {
    const cliCalls = [];
    const orgSelections = [];
    const queryCalls = [];
    const connection = {
        async query(soql, options) {
            queryCalls.push({ soql, options, username: this.username });
            return { records: [{ Id: '001' }], done: true, totalSize: 1 };
        }
    };
    const dependencies = {
        'child_process': { execFile(command, args, options, callback) {
            cliCalls.push({ command, args });
            callback(null, JSON.stringify({ result: { nonScratchOrgs: [
                { username: 'qa@example.test', isDefaultUsername: true, connectedStatus: 'Connected' },
                { username: 'other@example.test', connectedStatus: 'Connected' }
            ] } }), '');
        } },
        'fs': fs,
        'fs/promises': fsPromises,
        'path': path,
        'vscode': { workspace: { workspaceFolders } },
        '@salesforce/core': { Org: { async create(options) {
            orgSelections.push(options.aliasOrUsername);
            return { getConnection() { return { ...connection, username: options.aliasOrUsername }; } };
        } } },
        '../../core/connection': { async getCurrentOrgFromConfig() { return undefined; } },
        '../../core/logger': { logger: {
            debug() {}, info() {}, warn() {}, error() {},
            async run(_scope, action) { return action(); }
        } },
        './queryData': queryData
    };
    const serviceContext = {
        exports: {},
        Buffer,
        process: { platform: 'linux', pid: 1 },
        require(name) {
            assert.ok(dependencies[name], `Unexpected dependency ${name}`);
            return dependencies[name];
        }
    };
    dependencies['../../core/authenticatedOrgs'] = loadOrgModule({
        child_process: dependencies.child_process,
        '@salesforce/core': dependencies['@salesforce/core'],
        './connection': dependencies['../../core/connection'],
        './logger': dependencies['../../core/logger']
    });
    vm.runInNewContext(serviceSource, serviceContext);
    return { service: serviceContext.exports, cliCalls, orgSelections, queryCalls };
}

test('creates the saved-query library in the Salesforce Assist Buddy directory', async () => {
    const workspaceRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'assist-buddy-workspace-'));
    await fsPromises.mkdir(path.join(workspaceRoot, '.sf'));

    try {
        const { service: serviceModule } = loadService([{ uri: { fsPath: workspaceRoot } }]);
        const service = new serviceModule.SoqlRunnerService({ globalStorageUri: { fsPath: '/storage' } });
        const queries = await service.loadSavedQueries();
        assert.equal(service.savedQueriesFilePath, path.join(workspaceRoot, '.sf', 'salesforce-assist-buddy', 'queries.json'));
        assert.equal(queries[0].name, 'Accounts by name');
        const saved = JSON.parse(await fsPromises.readFile(service.savedQueriesFilePath, 'utf8'));
        assert.deepEqual(plain(saved.queries), plain(queries));
    } finally {
        await fsPromises.rm(workspaceRoot, { recursive: true, force: true });
    }
});

test('lists authenticated orgs and retains the CLI default username', () => {
    const parsed = queryData.parseOrgList({ result: {
        nonScratchOrgs: [
            { username: 'dev@example.test', alias: 'Dev', connectedStatus: 'Connected' },
            { username: 'default@example.test', isDefaultUsername: true, connectedStatus: 'Connected' },
            { username: 'expired@example.test', connectedStatus: 'Expired' }
        ],
        scratchOrgs: [{ username: 'dev@example.test', alias: 'Duplicate' }]
    } });
    assert.deepEqual(plain(parsed), {
        orgs: [
            { username: 'dev@example.test', alias: 'Dev', isDefaultUsername: false },
            { username: 'default@example.test', isDefaultUsername: true }
        ],
        defaultUsername: 'default@example.test'
    });
});

test('resolves a configured default org alias to its authenticated username', () => {
    const orgs = [{ username: 'admin@example.test', alias: 'production' }];
    assert.equal(queryData.resolveDefaultUsername(orgs, undefined, 'production'), 'admin@example.test');
});

test('prefers .sfdx and falls back to .sf', () => {
    assert.equal(queryData.resolveSalesforceDirectory('workspace/.sfdx', 'workspace/.sf'), 'workspace/.sfdx');
    assert.equal(queryData.resolveSalesforceDirectory(undefined, 'workspace/.sf'), 'workspace/.sf');
    assert.equal(queryData.resolveSalesforceDirectory(undefined, undefined), undefined);
});

test('substitutes typed parameters and escapes SOQL string literals', () => {
    const query = {
        id: 'query-1',
        name: 'Test',
        query: 'SELECT Id FROM Account WHERE Name LIKE {{name}} AND CreatedDate >= {{startDate}} LIMIT {{rowLimit}}',
        queryType: 'soql',
        parameters: [
            { name: 'name', label: 'Name', type: 'text' },
            { name: 'startDate', label: 'Start date', type: 'date' },
            { name: 'rowLimit', label: 'Row limit', type: 'number' }
        ]
    };
    const soql = queryData.buildSoql(query, { name: "O'Neil\\_%", startDate: '2026-10-01', rowLimit: '25' });
    assert.equal(soql, "SELECT Id FROM Account WHERE Name LIKE 'O\\'Neil\\\\_%' AND CreatedDate >= 2026-10-01 LIMIT 25");
});

test('substitutes text placeholders inside quoted LIKE patterns without adding quotes', () => {
    const query = {
        id: 'brand-query',
        name: 'Cases by insurer',
        query: "SELECT Claim_Number__c, eFNOL_policy_number__r.CompanyName__c, LastModifiedDate FROM Case WHERE eFNOL_policy_number__r.CompanyName__c LIKE '%{{brandName}}%' ORDER BY LastModifiedDate DESC LIMIT 200",
        queryType: 'soql',
        parameters: [{ name: 'brandName', label: 'Brand name', type: 'text' }]
    };
    assert.equal(
        queryData.buildSoql(query, { brandName: 'foremost' }),
        "SELECT Claim_Number__c, eFNOL_policy_number__r.CompanyName__c, LastModifiedDate FROM Case WHERE eFNOL_policy_number__r.CompanyName__c LIKE '%foremost%' ORDER BY LastModifiedDate DESC LIMIT 200"
    );
});

test('rejects undefined, missing, invalid numeric, and invalid calendar parameters', () => {
    const base = { id: 'query', name: 'Test', query: 'SELECT Id FROM Account WHERE Name = {{name}}', queryType: 'soql', parameters: [] };
    assert.throws(() => queryData.buildSoql(base, {}), /Define a parameter/);
    const query = { ...base, parameters: [{ name: 'name', label: 'Name', type: 'text' }] };
    assert.throws(() => queryData.buildSoql(query, {}), /Enter a value/);
    const numeric = { ...base, query: 'SELECT Id FROM Account LIMIT {{count}}', parameters: [{ name: 'count', label: 'Count', type: 'number' }] };
    assert.throws(() => queryData.buildSoql(numeric, { count: 'many' }), /must be a number/);
    const date = { ...base, query: 'SELECT Id FROM Account WHERE CreatedDate >= {{date}}', parameters: [{ name: 'date', label: 'Date', type: 'date' }] };
    assert.throws(() => queryData.buildSoql(date, { date: '2026-02-31' }), /valid date/);
});

test('caches org discovery and a connection for the explicitly selected username', async () => {
    const { service: serviceModule, cliCalls, orgSelections, queryCalls } = loadService();
    const extensionContext = { globalStorageUri: { fsPath: path.join(os.tmpdir(), 'soql-runner-test-storage') } };
    const service = new serviceModule.SoqlRunnerService(extensionContext);
    const query = { id: 'accounts', name: 'Accounts', query: 'SELECT Id FROM Account LIMIT 10', queryType: 'soql', parameters: [] };

    await service.listOrgs();
    await service.listOrgs();
    assert.equal(cliCalls.length, 1);

    await service.runQuery('qa@example.test', query, {});
    await service.runQuery('qa@example.test', query, {});
    assert.equal(cliCalls.length, 1);
    assert.deepEqual(orgSelections, ['qa@example.test']);
    assert.equal(queryCalls.length, 2);
    assert.ok(queryCalls.every(call => call.options.autoFetch === true && call.options.maxFetch === 50000));

    await service.listOrgs(true);
    assert.equal(cliCalls.length, 2);
});

test('shared org connections stay isolated when switching between authenticated users', async () => {
    const { service: serviceModule, cliCalls, orgSelections, queryCalls } = loadService();
    const service = new serviceModule.SoqlRunnerService({ globalStorageUri: { fsPath: '/storage' } });
    const query = { id: 'accounts', name: 'Accounts', query: 'SELECT Id FROM Account LIMIT 1', queryType: 'soql', parameters: [] };
    await service.runQuery('qa@example.test', query, {});
    await service.runQuery('other@example.test', query, {});
    await service.runQuery('qa@example.test', query, {});
    assert.equal(cliCalls.length, 1);
    assert.deepEqual(orgSelections, ['qa@example.test', 'other@example.test']);
    assert.deepEqual(queryCalls.map(call => call.username), ['qa@example.test', 'other@example.test', 'qa@example.test']);
    await assert.rejects(service.runQuery('unknown@example.test', query, {}), /authenticated Salesforce org/);
    assert.equal(queryCalls.length, 3);
});

test('formats full JSON and text from separate CLI error streams', () => {
    const details = queryData.formatCliErrorOutput(
        '{\n  "name": "INVALID_FIELD",\n  "message": "No such column"\n}',
        'Additional CLI context'
    );
    assert.match(details, /INVALID_FIELD/);
    assert.match(details, /No such column/);
    assert.match(details, /Additional CLI context/);
    assert.notEqual(details, '{');
});

test('flattens relationship fields and creates escaped CSV', () => {
    const result = plain(queryData.toQueryTableData([
        { Id: '001', Name: 'A, "B"', Account: { Name: 'Acme', attributes: { type: 'Account' } }, attributes: { type: 'Contact' } },
        { Id: '002', Name: 'Second', Account: null, Extra: true }
    ]));
    assert.deepEqual(result.columns, ['Id', 'Name', 'Account.Name', 'Extra']);
    assert.deepEqual(result.rows[0], { Id: '001', Name: 'A, "B"', 'Account.Name': 'Acme', Extra: '' });
    assert.equal(result.csv, '\uFEFF"Id","Name","Account.Name","Extra"\r\n"001","A, ""B""","Acme",""\r\n"002","Second","","true"');
});
