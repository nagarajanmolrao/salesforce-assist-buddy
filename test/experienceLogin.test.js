const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.transpileModule(readFileSync(path.join(__dirname, '../src/tools/experienceLogin/service.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const ids = { org: '00D000000000001', network: '0DB000000000001', user: '005000000000001', contact: '003000000000001' };

function loadService(options = {}) {
    let currentOrg = 'admin@example.test';
    const queries = [];
    const orgRuns = [];
    const connection = {
        instanceUrl: 'https://sample.my.salesforce.com',
        accessToken: 'synthetic-session-not-a-real-token',
        query(soql) {
            queries.push(soql);
            if (soql.includes('FROM Contact') && /ORDER BY Name\b/i.test(soql)) {
                throw new Error("field 'Name' can not be sorted in a query call");
            }
            let records;
            if (soql.includes('FROM Network')) records = [{ Id: ids.network, Name: 'Sample Customer Portal' }];
            else if (soql.includes('FROM Contact')) records = options.contacts || [{ Id: ids.contact, Name: 'Alex Morgan', Account: { Name: 'Sample Account' } }];
            else if (soql.includes('FROM User')) records = options.users || [{ Id: ids.user, ContactId: ids.contact, Username: 'experience@example.test' }];
            else if (soql.includes('FROM Organization')) records = [{ Id: ids.org }];
            else assert.fail(`Unexpected query ${soql}`);
            const response = Promise.resolve({ records, done: true });
            response.autoFetch = () => response;
            response.maxFetch = () => response;
            return response;
        }
    };
    const otherConnection = { ...connection, instanceUrl: 'https://other.my.salesforce.com', accessToken: 'synthetic-other-session' };
    const context = {
        exports: {}, URL,
        require(name) {
            assert.equal(name, '../../core/authenticatedOrgs');
            return {
                AuthenticatedOrgService: class {
                    async listOrgs() {
                        return { orgs: [{ username: 'admin@example.test' }, { username: 'qa@example.test' }], defaultUsername: currentOrg };
                    }
                    async run(username, action) {
                        if (!['admin@example.test', 'qa@example.test'].includes(username)) throw new Error('Select an authenticated Salesforce org.');
                        orgRuns.push(username);
                        return action(username === 'admin@example.test' ? connection : otherConnection);
                    }
                }
            };
        }
    };
    vm.runInNewContext(source, context);
    return { ...context.exports, queries, connection, orgRuns, changeOrg(value) { currentOrg = value; } };
}

test('constructs a properly encoded frontdoor URL and nested Experience login target', () => {
    const { buildExperienceLoginUrl } = loadService();
    const url = new URL(buildExperienceLoginUrl(
        'https://sample.my.salesforce.com', 'synthetic+session/with=characters',
        ids.org, ids.network, ids.user, ids.contact
    ));
    assert.equal(url.origin, 'https://sample.my.salesforce.com');
    assert.equal(url.pathname, '/secur/frontdoor.jsp');
    assert.equal(url.searchParams.get('sid'), 'synthetic+session/with=characters');
    const target = new URL(url.searchParams.get('retURL'));
    assert.equal(target.pathname, '/servlet/servlet.su');
    assert.equal(target.searchParams.get('oid'), ids.org);
    assert.equal(target.searchParams.get('sunetworkid'), ids.network);
    assert.equal(target.searchParams.get('sunetworkuserid'), ids.user);
    assert.equal(target.searchParams.get('retURL'), `/${ids.contact}`);
});

test('rejects insecure domains, missing sessions, and invalid record IDs', () => {
    const { buildExperienceLoginUrl } = loadService();
    assert.throws(() => buildExperienceLoginUrl('http://example.test', 'session', ids.org, ids.network, ids.user, ids.contact), /HTTPS/);
    assert.throws(() => buildExperienceLoginUrl('https://example.test', '', ids.org, ids.network, ids.user, ids.contact), /session/);
    assert.throws(() => buildExperienceLoginUrl('https://example.test', 'session', ids.org, 'bad-id', ids.user, ids.contact), /record ID/);
});

test('loads network names and uses the runtime contact email with safe SOQL escaping', async () => {
    const module = loadService();
    const service = new module.ExperienceLoginService();
    const state = await service.listNetworks('admin@example.test');
    assert.equal(state.org, 'admin@example.test');
    assert.equal(state.networks[0].name, 'Sample Customer Portal');
    await service.generate('admin@example.test', "o'neil@example.test", ids.network, ids.contact, ids.user);
    const userQuery = module.queries.find(query => query.includes('FROM User'));
    assert.ok(userQuery.includes("Contact.Email = 'o\\'neil@example.test'"));
    assert.match(userQuery, /IsActive = true LIMIT 2$/);
    assert.ok(module.queries.some(query => query.includes(`Network WHERE Id = '${ids.network}'`)));
});

test('finds contacts by email and returns full names with active linked users', async () => {
    const otherContact = '003000000000002';
    const otherUser = '005000000000002';
    const module = loadService({
        contacts: [
            { Id: '003000000000003', Name: 'Jordan Lee', Account: { Name: 'Another Account' } },
            { Id: otherContact, Name: 'Jamie Taylor', Account: null },
            { Id: ids.contact, Name: 'Alex Morgan', Account: { Name: 'Sample Account' } }
        ],
        users: [
            { Id: ids.user, ContactId: ids.contact, Username: 'alex@example.test' },
            { Id: otherUser, ContactId: otherContact, Username: 'jamie@example.test' }
        ]
    });
    const service = new module.ExperienceLoginService();
    await service.listNetworks('admin@example.test');
    const matches = await service.findContacts('admin@example.test', " o'neil@example.test ");
    assert.equal(matches.length, 3);
    assert.equal(matches[0].contactName, 'Alex Morgan');
    assert.equal(matches[0].accountName, 'Sample Account');
    assert.equal(matches[0].userId, ids.user);
    assert.equal(matches[1].contactName, 'Jamie Taylor');
    assert.equal(matches[1].username, 'jamie@example.test');
    assert.equal(matches[2].contactName, 'Jordan Lee');
    assert.equal(matches[2].userId, undefined);
    const contactQuery = module.queries.find(query => query.includes('FROM Contact'));
    assert.doesNotMatch(contactQuery, /ORDER BY Name\b/i);
    assert.match(contactQuery, /ORDER BY Id LIMIT 101$/);
    assert.ok(module.queries.some(query => query.includes("FROM Contact WHERE Email = 'o\\'neil@example.test'")));
    assert.ok(module.queries.some(query => query.includes('ContactId IN (') && query.includes('IsActive = true')));
});

test('empty contact lookup skips the user query and remains independent of default-org changes', async () => {
    const module = loadService({ contacts: [] });
    const service = new module.ExperienceLoginService();
    await service.listNetworks('admin@example.test');
    const matches = await service.findContacts('admin@example.test', 'nobody@example.test');
    assert.equal(matches.length, 0);
    assert.ok(!module.queries.some(query => query.includes('FROM User')));
    module.changeOrg('another@example.test');
    assert.equal((await service.findContacts('admin@example.test', 'person@example.test')).length, 0);
    assert.ok(module.orgRuns.every(username => username === 'admin@example.test'));
});

test('contact lookup is bounded and does not silently truncate ambiguous results', async () => {
    const module = loadService({ contacts: Array.from({ length: 101 }, (_, index) => ({
        Id: `003${String(index).padStart(12, '0')}`, Name: `Contact ${index}`
    })) });
    const service = new module.ExperienceLoginService();
    await service.listNetworks('admin@example.test');
    await assert.rejects(service.findContacts('admin@example.test', 'shared@example.test'), /More than 100 contacts/);
    assert.ok(module.queries.some(query => query.includes('FROM Contact') && query.endsWith('LIMIT 101')));
    assert.ok(!module.queries.some(query => query.includes('FROM User')));
});

test('revalidates the selected active Experience user and contact', async () => {
    for (const users of [[], [{ Id: ids.user }], [{ Id: '005000000000002', ContactId: ids.contact }],
        [{ Id: ids.user, ContactId: '003000000000002' }],
        [{ Id: ids.user, ContactId: ids.contact }, { Id: ids.user, ContactId: ids.contact }]]) {
        const module = loadService({ users });
        const service = new module.ExperienceLoginService();
        await service.listNetworks('admin@example.test');
        await assert.rejects(service.generate('admin@example.test', 'person@example.test', ids.network, ids.contact, ids.user), /selected contact no longer/);
    }
});

test('rejects invalid inputs and unauthenticated orgs', async () => {
    const module = loadService();
    const service = new module.ExperienceLoginService();
    await service.listNetworks('admin@example.test');
    await assert.rejects(service.generate('admin@example.test', 'not-an-email', ids.network, ids.contact, ids.user), /valid contact email/);
    await assert.rejects(service.generate('admin@example.test', 'person@example.test', 'bad-id', ids.contact, ids.user), /Select an Experience/);
    await assert.rejects(service.generate('unknown@example.test', 'person@example.test', ids.network, ids.contact, ids.user), /authenticated Salesforce org/);
});

test('networks, contacts, and generated URLs use the explicitly selected org connection', async () => {
    const module = loadService();
    const service = new module.ExperienceLoginService();
    const selection = await service.listOrgs();
    assert.equal(selection.defaultUsername, 'admin@example.test');
    const networks = await service.listNetworks('qa@example.test');
    assert.equal(networks.org, 'qa@example.test');
    await service.findContacts('qa@example.test', 'person@example.test');
    const url = new URL(await service.generate('qa@example.test', 'person@example.test', ids.network, ids.contact, ids.user));
    assert.equal(url.origin, 'https://other.my.salesforce.com');
    assert.equal(url.searchParams.get('sid'), 'synthetic-other-session');
    assert.deepEqual(module.orgRuns, ['qa@example.test', 'qa@example.test', 'qa@example.test']);
    assert.equal((await service.listOrgs()).defaultUsername, 'admin@example.test');
});

test('panel keeps session URLs out of messages and logs and invalidates them on input changes', async () => {
    const panelSource = ts.transpileModule(readFileSync(path.join(__dirname, '../src/tools/experienceLogin/ExperienceLoginPanel.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText;
    const messages = [];
    const diagnostics = [];
    const copied = [];
    const opened = [];
    const generatedFor = [];
    let deferGeneration = false;
    let finishGeneration;
    const url = 'https://sample.my.salesforce.com/secur/frontdoor.jsp?sid=synthetic-sensitive-session';
    const panel = {
        active: true,
        onDidChangeViewState() {}, onDidDispose() {}, dispose() {},
        webview: {
            cspSource: 'preview',
            onDidReceiveMessage() {},
            asWebviewUri: uri => ({ toString: () => uri.fsPath }),
            async postMessage(message) { messages.push(message); }
        }
    };
    const dependencies = {
        crypto: { randomBytes: () => ({ toString: () => 'nonce' }) },
        fs: { readFileSync: () => '<html></html>' },
        vscode: {
            ViewColumn: { Active: 1 },
            Uri: { joinPath: () => ({ fsPath: 'asset' }), parse: value => value },
            window: {
                createWebviewPanel: () => panel,
                async showWarningMessage() { return 'Open Login URL'; }
            },
            env: {
                clipboard: { async writeText(value) { copied.push(value); } },
                async openExternal(value) { opened.push(value); return true; }
            }
        },
        '../../core/logger': { logger: Object.fromEntries(['debug', 'info', 'error'].map(level => [level, (...values) => diagnostics.push(values)])) },
        './service': { ExperienceLoginService: class {
            async listOrgs() { return { orgs: [{ username: 'admin@example.test' }, { username: 'qa@example.test' }], defaultUsername: 'admin@example.test' }; }
            async listNetworks(username) { return { org: username, networks: [{ id: ids.network, name: 'Sample Portal' }] }; }
            async findContacts() { return [{ contactId: ids.contact, contactName: 'Alex Morgan', userId: ids.user, username: 'alex@example.test' }]; }
            async generate(...args) {
                generatedFor.push(args);
                return deferGeneration ? new Promise(resolve => { finishGeneration = resolve; }) : url;
            }
        } }
    };
    const context = { exports: {}, require(name) { assert.ok(dependencies[name], name); return dependencies[name]; } };
    vm.runInNewContext(panelSource, context);
    const instance = new context.exports.ExperienceLoginPanel({ extensionUri: { fsPath: '/extension' } });
    await instance.handleMessage({ command: 'ready' });
    await instance.handleMessage({ command: 'findContacts', username: 'admin@example.test', email: 'person@example.test' });
    assert.equal(messages.at(-1).type, 'contacts');
    assert.equal(messages.at(-1).contacts[0].contactName, 'Alex Morgan');
    await instance.handleMessage({ command: 'generate', username: 'admin@example.test', email: 'person@example.test', networkId: ids.network,
        contactId: ids.contact, userId: ids.user });
    assert.deepEqual(generatedFor[0], ['admin@example.test', 'person@example.test', ids.network, ids.contact, ids.user]);
    assert.equal(messages.at(-1).type, 'generated');
    assert.ok(!JSON.stringify(messages).includes('synthetic-sensitive-session'));
    assert.ok(!JSON.stringify(diagnostics).includes('synthetic-sensitive-session'));
    await instance.handleMessage({ command: 'copy' });
    await instance.handleMessage({ command: 'open' });
    assert.deepEqual(copied, [url]);
    assert.deepEqual(opened, [url]);
    await instance.handleMessage({ command: 'invalidate' });
    await instance.handleMessage({ command: 'copy' });
    assert.equal(copied.length, 1);
    assert.equal(messages.at(-1).type, 'error');
    await instance.handleMessage({ command: 'selectOrg', username: 'qa@example.test' });
    await instance.handleMessage({ command: 'generate', username: 'admin@example.test', email: 'person@example.test', networkId: ids.network,
        contactId: ids.contact, userId: ids.user });
    assert.equal(messages.at(-1).type, 'error');
    assert.equal(generatedFor.length, 1);
    deferGeneration = true;
    const generatedCount = messages.filter(message => message.type === 'generated').length;
    const pending = instance.handleMessage({ command: 'generate', username: 'qa@example.test', email: 'person@example.test',
        networkId: ids.network, contactId: ids.contact, userId: ids.user });
    await instance.handleMessage({ command: 'selectOrg', username: 'admin@example.test' });
    finishGeneration(url);
    await pending;
    assert.equal(messages.filter(message => message.type === 'generated').length, generatedCount);
    await instance.handleMessage({ command: 'copy' });
    assert.equal(copied.length, 1);
    assert.equal(messages.at(-1).type, 'error');
});