const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function loadModule(relativePath, dependencies) {
    const source = ts.transpileModule(readFileSync(path.join(__dirname, relativePath), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText;
    const context = {
        exports: {}, setTimeout, clearTimeout,
        require(name) {
            assert.ok(name in dependencies, `Unexpected dependency ${name}`);
            return dependencies[name];
        }
    };
    vm.runInNewContext(source, context);
    return context.exports;
}

const logger = { debug() {}, info() {}, warn() {}, error() {}, async run(_scope, action) { return action(); } };
const plain = value => JSON.parse(JSON.stringify(value));

function createProvider(options = {}) {
    let records = [];
    const queries = [];
    const state = options.state || new Map();
    const connection = {
        async identity() { return { user_id: '005current' }; },
        tooling: { async query(query) { queries.push(query); return { records }; } }
    };
    const wrapper = loadModule('../src/tools/logViewer/ApexLogWrapper.ts', {});
    const module = loadModule('../src/tools/logViewer/ApexLogDataProvider.ts', {
        vscode: {
            EventEmitter: class { event() {} fire() {} dispose() {} },
            workspace: { workspaceFolders: [] },
            window: { showErrorMessage() {} }
        },
        './ApexLogWrapper': wrapper,
        './ApexLogFileManager': { ApexLogFileManager: class { setProvider() {} } },
        './TraceFlagManager': { ensureTraceFlag: options.ensureTraceFlag || (async () => {}) },
        '../../core/logger': { logger },
        '../../core/connection': { retryOnSessionExpire: async (action, provider) => action(provider.connection) },
        '../../core/extensionIdentity': { getConfiguration: () => ({ async update() {} }) }
    });
    const extensionContext = { workspaceState: {
        get(key, fallback) { return state.has(key) ? state.get(key) : fallback; },
        async update(key, value) { state.set(key, value); }
    } };
    const config = { autoRefresh: false, refreshInterval: 5000, currentUserOnly: true };
    return {
        module, extensionContext, connection, config, state, queries,
        setRecords(operations) {
            records = operations.map((operation, index) => ({
                Id: `07L${index}`, Operation: operation, LogUser: { Name: index === 0 ? 'Alice' : 'Bob' },
                StartTime: '2026-10-19T12:00:00Z', DurationMilliseconds: 1, LogLength: 100, Status: 'Success'
            }));
        },
        create() { return module.LogDataProvider.create(extensionContext, connection, config); }
    };
}

test('initial provider creation does not wait for trace flag setup and retains current-user filtering', async () => {
    let finishSetup;
    const setup = new Promise(resolve => { finishSetup = resolve; });
    const harness = createProvider({ ensureTraceFlag: () => setup });
    let provider;
    const creation = harness.create().then(value => { provider = value; });
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(provider, 'Trace flag setup must not block provider creation');
        await provider.refreshLogs(true);
        assert.match(harness.queries[0], /WHERE LogUserId = '005current'/);
    } finally {
        finishSetup();
        await creation;
        provider?.dispose();
    }
});

test('operation filters support multiple types, search intersection, none, and all', async () => {
    const harness = createProvider();
    const provider = await harness.create();
    try {
        harness.setRecords(['UniversalPerfLogger', '/webruntime/api/execute', 'CustomOperation']);
        await provider.refreshLogs(true);
        await provider.setOperationFilter(['UniversalPerfLogger', '/webruntime/api/execute']);
        assert.equal(provider.getGridData().length, 2);
        provider.setSearchFilter('alice');
        assert.equal(provider.getGridData().length, 1);
        provider.clearSearch();
        await provider.setOperationFilter([]);
        assert.equal(provider.getGridData().length, 0);
        await provider.setOperationFilter(null);
        assert.equal(provider.getGridData().length, 3);
    } finally { provider.dispose(); }
});

test('new Operation types are remembered and selections survive initial refreshes and provider recreation', async () => {
    const harness = createProvider();
    const provider = await harness.create();
    let restored;
    try {
        await provider.setOperationFilter(['CustomOperation']);
        harness.setRecords(['CustomOperation', 'AnotherNewOperation']);
        await provider.refreshLogs(true);
        assert.equal(provider.getGridData().length, 1);
        assert.ok(provider.getOperationFilter().available.includes('AnotherNewOperation'));
        harness.setRecords(['DifferentOperation']);
        await provider.refreshLogs();
        assert.equal(provider.getGridData().length, 0);
        assert.ok(provider.getOperationFilter().available.includes('CustomOperation'));
        restored = await harness.create();
        assert.deepEqual(plain(restored.getOperationFilter().selected), ['CustomOperation']);
        assert.ok(restored.getOperationFilter().available.includes('AnotherNewOperation'));
    } finally { provider.dispose(); restored?.dispose(); }
});

test('panel waits for client readiness before its single initial query', async () => {
    let receiveMessage;
    let changeVisibility;
    const contexts = [];
    const messages = [];
    const selectedTools = [];
    let refreshes = 0;
    const provider = {
        setPanelVisibility() {},
        getGridData() { return []; },
        getOperationFilter() { return { available: [], selected: null }; },
        async refreshLogs() { refreshes++; }
    };
    const panelModule = loadModule('../src/tools/logViewer/panel/ApexLogPanelProvider.ts', {
        vscode: {
            Uri: { joinPath: () => ({ toString: () => 'asset' }) },
            commands: { executeCommand: async (...args) => { contexts.push(args); } }
        },
        fs: {}, path,
        '../service': {},
        '../../../core/logger': { logger },
        '../../registry': { toolRegistry: [], isToolId: value => ['log-viewer', 'soql-runner', 'experience-login'].includes(value), defaultToolId: 'log-viewer' }
    });
    const panel = new panelModule.ApexLogPanelProvider({}, provider, toolId => selectedTools.push(toolId));
    panel.getHtmlForWebview = () => '';
    const view = {
        visible: true,
        onDidChangeVisibility(handler) { changeVisibility = handler; },
        webview: {
            asWebviewUri: uri => uri,
            postMessage: async message => { messages.push(message); return true; },
            onDidReceiveMessage(handler) { receiveMessage = handler; }
        }
    };
    panel.resolveWebviewView(view, {}, {});
    assert.equal(refreshes, 0);
    await receiveMessage({ command: 'ready' });
    assert.equal(refreshes, 1);
    panel.setToolActive(false);
    assert.equal(contexts.at(-1)[2], false);
    assert.equal(messages.at(-1).type, 'toolActivity');
    assert.equal(messages.at(-1).active, false);
    panel.setToolActive(true);
    assert.equal(contexts.at(-1)[2], true);
    for (const toolId of ['soql-runner', 'experience-login']) {
        await receiveMessage({ command: 'selectTool', toolId });
        assert.equal(contexts.at(-1)[2], true, 'Opening an editor must preserve the Log Viewer toolbar');
        assert.equal(messages.at(-1).active, true);
    }
    assert.deepEqual(selectedTools, ['soql-runner', 'experience-login']);
    view.visible = false;
    await changeVisibility();
    assert.equal(contexts.at(-1)[2], false);
});

test('connection always uses the explicit access-token command instead of org display credentials', async () => {
    for (const tokenInDisplay of [true, false]) {
        const commands = [];
        const module = loadModule('../src/core/connection.ts', {
            jsforce: { Connection: class { constructor(options) { this.options = options; } } },
            vscode: { workspace: { workspaceFolders: [{ uri: { fsPath: '/workspace' } }] }, window: { showErrorMessage() {} } },
            fs: { promises: { async readFile() { return JSON.stringify({ 'target-org': 'default@example.test' }); } } },
            path,
            child_process: { exec(command, callback) {
                commands.push(command);
                callback(null, JSON.stringify({ result: command.includes('org display')
                    ? { instanceUrl: 'https://example.test', accessToken: tokenInDisplay ? 'invalid-display-token' : undefined }
                    : { accessToken: 'test-token' } }), '');
            } },
            './logger': { logger }
        });
        const connection = await module.getConnection();
        assert.equal(connection.options.accessToken, 'test-token');
        assert.equal(commands.length, 2);
        await module.getConnection();
        assert.equal(commands.length, 2);
        let attempts = 0;
        const provider = { connection, async updateConnection(updated) { this.connection = updated; } };
        const result = await module.retryOnSessionExpire(async activeConnection => {
            attempts++;
            if (attempts === 1) {
                const error = new Error('INVALID_AUTH_HEADER');
                error.errorCode = 'INVALID_AUTH_HEADER';
                throw error;
            }
            assert.notEqual(activeConnection, connection);
            assert.equal(activeConnection.options.accessToken, 'test-token');
            return 'recovered';
        }, provider);
        assert.equal(result, 'recovered');
        assert.equal(attempts, 2);
        assert.equal(commands.length, 4);
        assert.notEqual(provider.connection, connection);
    }
});