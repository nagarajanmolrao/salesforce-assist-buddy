const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.transpileModule(readFileSync(path.join(__dirname, '../src/tools/logViewer/commands.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
const identitySource = ts.transpileModule(readFileSync(path.join(__dirname, '../src/core/extensionIdentity.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;

function loadIdentity(configurations = {}) {
    const context = {
        exports: {},
        require(name) {
            assert.equal(name, 'vscode');
            return { workspace: { getConfiguration: section => configurations[section] } };
        }
    };
    vm.runInNewContext(identitySource, context);
    return context.exports;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const alice = { Id: '005alice', Name: 'Alice', Username: 'alice@example.test', Email: 'alice@company.test' };
const bob = { Id: '005bob', Name: 'Bob', Username: 'bob@example.test' };

function createCommand(options = {}) {
    const handlers = {};
    const timers = new Map();
    const queries = [];
    const flagQueries = [];
    const enabled = [];
    const disabled = [];
    const errors = [];
    const scopes = [];
    const inputRequests = [];
    const notifications = [];
    let timerId = 0;
    const picker = {
        items: [], selectedItems: [], visible: false, disposed: false,
        show() { this.visible = true; },
        hide() { this.visible = false; handlers.hide(); },
        dispose() { this.disposed = true; }
    };
    for (const [method, event] of [['onDidChangeValue', 'change'], ['onDidAccept', 'accept'], ['onDidHide', 'hide']]) {
        picker[method] = callback => {
            handlers[event] = callback;
            return { dispose() { delete handlers[event]; } };
        };
    }
    const connection = {
        async query(query) {
            queries.push(query);
            return options.users ? options.users(query) : { records: [alice, bob], done: false, nextRecordsUrl: '/must-not-fetch' };
        },
        queryMore() { assert.fail('Must not paginate through the org'); },
        tooling: {
            async query(query) {
                flagQueries.push(query);
                return options.flags ? options.flags(query) : { records: [{ TracedEntityId: bob.Id }] };
            }
        }
    };
    const provider = { connection, async getCurrentUserId() { return '005current'; } };
    const dependencies = {
        vscode: { window: {
            createQuickPick: () => picker,
            async showInputBox(settings) {
                inputRequests.push(settings);
                return options.input ? options.input() : options.keyword;
            },
            showInformationMessage(message) { notifications.push(message); },
            showErrorMessage(message) { errors.push(message); }
        } },
        './service': { getLogDataProvider: async () => provider },
        '../../core/extensionIdentity': loadIdentity(),
        '../../core/connection': { retryOnSessionExpire: async (action, target) => action(target.connection) },
        './TraceFlagManager': {
            enableTraceFlagForUser: async (target, id) => enabled.push(id),
            disableTraceFlagForUser: async (target, id) => disabled.push(id)
        },
        '../../core/logger': { logger: {
            async run(scope, action) { scopes.push(scope); return action(); },
            error(scope, message, error) { errors.push({ scope, message, error }); }
        } }
    };
    const context = {
        exports: {},
        require(name) { assert.ok(dependencies[name], `Unexpected dependency ${name}`); return dependencies[name]; },
        setTimeout(callback, delay) { assert.equal(delay, 300); timers.set(++timerId, callback); return timerId; },
        clearTimeout(id) { timers.delete(id); }
    };
    vm.runInNewContext(source, context);
    const running = options.searchCommand ? context.exports.setTraceFlagBySearch() : context.exports.setTraceFlagForUser();
    return {
        picker, queries, flagQueries, enabled, disabled, errors, scopes, running, timers, inputRequests, notifications,
        change(value) { handlers.change(value); },
        accept(item) { picker.selectedItems = [item]; handlers.accept(); },
        debounce() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); }
    };
}

test('opens before users arrive and never fetches additional pages', async () => {
    let complete;
    const command = createCommand({ users: () => new Promise(resolve => { complete = resolve; }) });
    await flush();
    assert.equal(command.picker.visible, true);
    assert.equal(command.picker.busy, true);
    assert.match(command.queries[0], /IsActive = true AND Id != '005current'.*ORDER BY Name, Id LIMIT 100$/);
    complete({ records: [alice], done: false, nextRecordsUrl: '/must-not-fetch' });
    await flush();
    assert.equal(command.picker.items.length, 1);
    assert.equal(command.picker.busy, false);
    assert.equal(command.queries.length, 1);
    command.picker.hide();
    await command.running;
    assert.equal(command.picker.disposed, true);
});

test('queries flags only for visible users and preserves enable/disable behavior', async () => {
    for (const [index, expected] of [[0, 'enable'], [1, 'disable']]) {
        const command = createCommand();
        await flush();
        assert.match(command.flagQueries[0], /TracedEntityId IN \('005alice','005bob'\) AND LogType = 'DEVELOPER_LOG'/);
        assert.equal(command.picker.items[1].hasTraceFlag, true);
        command.accept(command.picker.items[index]);
        await command.running;
        assert.deepEqual(command.enabled, expected === 'enable' ? [alice.Id] : []);
        assert.deepEqual(command.disabled, expected === 'disable' ? [bob.Id] : []);
        const selected = index === 0 ? alice : bob;
        assert.ok(command.notifications[0].endsWith(`${selected.Name} - (${selected.Username})`));
        assert.doesNotMatch(command.notifications[0], /\$\(/);
    }
});

test('debounces typing, escapes SOQL literals and wildcards, and avoids page logs', async () => {
    const command = createCommand();
    await flush();
    command.change('O');
    command.change("O'Neil");
    command.change("O'Neil_%\\");
    assert.equal(command.timers.size, 1);
    assert.equal(command.queries.length, 1);
    command.debounce();
    await flush();
    assert.equal(command.queries.length, 2);
    assert.ok(command.queries[1].includes("Name LIKE '%O\\'Neil\\_\\%\\\\%'"));
    assert.ok(command.queries[1].includes("OR Username LIKE 'O\\'Neil\\_\\%\\\\%'"));
    assert.deepEqual(command.scopes, ['Command.users.search', 'Command.users.search']);
    command.picker.hide();
    await command.running;
});

test('name picker searches any part of a multiword user name', async () => {
    const guest = {
        Id: '005guest',
        Name: 'Claims Management Agent Portal Site Guest User',
        Username: 'guest@example.test'
    };
    const command = createCommand({ users: () => ({ records: [guest] }) });
    await flush();
    for (const search of ['Claims Management', 'Agent', 'Portal Site Guest User']) {
        command.change(search);
        command.debounce();
        await flush();
        assert.ok(command.queries.at(-1).includes(`Name LIKE '%${search}%'`));
        assert.match(command.queries.at(-1), /LIMIT 100$/);
        assert.equal(command.picker.items[0].userId, guest.Id);
    }
    command.picker.hide();
    await command.running;
});

test('ignores older responses when a newer search has completed', async () => {
    let completeOldSearch;
    let call = 0;
    const command = createCommand({ users: () => ++call === 1
        ? new Promise(resolve => { completeOldSearch = resolve; })
        : { records: [bob] } });
    await flush();
    command.change('Bob');
    command.debounce();
    await flush();
    completeOldSearch({ records: [alice] });
    await flush();
    assert.equal(command.picker.items[0].userId, bob.Id);
    assert.equal(command.flagQueries.length, 1);
    command.picker.hide();
    await command.running;
});

test('empty results skip flag lookup and leave search available', async () => {
    const command = createCommand({ users: () => ({ records: [] }) });
    await flush();
    assert.equal(command.flagQueries.length, 0);
    assert.equal(command.picker.items.length, 0);
    assert.equal(command.picker.visible, true);
    assert.match(command.picker.placeholder, /No matching active users/);
    command.picker.hide();
    await command.running;
});

test('query failures are logged and a subsequent search can recover', async () => {
    let call = 0;
    const command = createCommand({ users: () => {
        if (++call === 1) throw new Error('API unavailable');
        return { records: [alice] };
    } });
    await flush();
    assert.equal(command.errors.length, 1);
    assert.equal(command.picker.busy, false);
    command.change('Alice');
    command.debounce();
    await flush();
    assert.equal(command.picker.items[0].userId, alice.Id);
    command.picker.hide();
    await command.running;
});

test('closing cancels debounce and ignores an in-flight response', async () => {
    let complete;
    const command = createCommand({ users: () => new Promise(resolve => { complete = resolve; }) });
    await flush();
    command.accept({ userId: alice.Id, hasTraceFlag: false });
    assert.equal(command.picker.visible, true);
    command.change('Alice');
    command.picker.hide();
    await command.running;
    assert.equal(command.timers.size, 0);
    complete({ records: [alice] });
    await flush();
    assert.equal(command.flagQueries.length, 0);
    assert.equal(command.picker.items.length, 0);
    assert.equal(command.enabled.length, 0);
    assert.equal(command.disabled.length, 0);
});

test('keyword command waits for submission then searches Username or Email with contains matching', async () => {
    let submit;
    const command = createCommand({ searchCommand: true, input: () => new Promise(resolve => { submit = resolve; }) });
    await flush();
    assert.equal(command.inputRequests.length, 1);
    assert.equal(command.queries.length, 0);
    assert.equal(command.picker.visible, false);
    assert.ok(command.inputRequests[0].validateInput('   '));
    assert.equal(command.inputRequests[0].validateInput('company'), undefined);
    submit(' company ');
    await flush();
    assert.match(command.queries[0], /AND \(Username LIKE '%company%' OR Email LIKE '%company%'\) ORDER BY Name, Id LIMIT 100$/);
    assert.doesNotMatch(command.queries[0], /Name LIKE/);
    assert.equal(command.picker.items[0].detail, alice.Email);
    command.change('Alice');
    assert.equal(command.timers.size, 0);
    assert.equal(command.queries.length, 1);
    command.accept(command.picker.items[0]);
    await command.running;
    assert.deepEqual(command.enabled, [alice.Id]);
});

test('keyword command preserves disabling an active trace flag', async () => {
    const command = createCommand({ searchCommand: true, keyword: 'example' });
    await flush();
    command.accept(command.picker.items[1]);
    await command.running;
    assert.deepEqual(command.disabled, [bob.Id]);
    assert.deepEqual(command.enabled, []);
});

test('keyword cancellation or blank input performs no user query', async () => {
    for (const keyword of [undefined, '', '   ']) {
        const command = createCommand({ searchCommand: true, keyword });
        await command.running;
        assert.equal(command.queries.length, 0);
        assert.equal(command.picker.visible, false);
    }
});

test('keyword command escapes quotes and wildcards inside its contains pattern', async () => {
    const command = createCommand({ searchCommand: true, keyword: "O'Neil_%\\" });
    await flush();
    assert.ok(command.queries[0].includes("Username LIKE '%O\\'Neil\\_\\%\\\\%'"));
    assert.ok(command.queries[0].includes("OR Email LIKE '%O\\'Neil\\_\\%\\\\%'"));
    command.picker.hide();
    await command.running;
});

test('keyword command reports empty results without fetching trace flags', async () => {
    const command = createCommand({ searchCommand: true, keyword: 'missing', users: () => ({ records: [] }) });
    await command.running;
    assert.equal(command.flagQueries.length, 0);
    assert.equal(command.picker.disposed, true);
    assert.match(command.notifications[0], /No active users matched/);
});

test('keyword search failure shows retry guidance and cannot select a user', async () => {
    const command = createCommand({ searchCommand: true, keyword: 'example', users: () => { throw new Error('Query failed'); } });
    await flush();
    assert.equal(command.errors.length, 1);
    assert.equal(command.picker.busy, false);
    assert.match(command.picker.placeholder, /Run the command again/);
    assert.equal(command.picker.items.length, 0);
    command.picker.hide();
    await command.running;
});

test('keyword command is contributed with a distinct toolbar icon and registered handler', () => {
    const manifest = JSON.parse(readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    const commandId = 'salesforce-assist-buddy.setTraceFlagBySearch';
    const command = manifest.contributes.commands.find(entry => entry.command === commandId);
    const original = manifest.contributes.commands.find(entry => entry.command === 'salesforce-assist-buddy.setTraceFlagForUser');
    assert.ok(command);
    assert.notEqual(command.icon, original.icon);
    assert.ok(manifest.contributes.menus['view/title'].some(entry => entry.command === commandId &&
        entry.when === 'view == salesforceAssistBuddy.logs && salesforceAssistBuddy.logViewerActive'));
    const extension = readFileSync(path.join(__dirname, '../src/extension.ts'), 'utf8');
    assert.ok(extension.includes("['setTraceFlagBySearch', setTraceFlagBySearch]"));
    assert.ok(extension.includes('const id = commandId(name)'));
});

test('runtime identity matches all manifest commands, menus, views, and configuration keys', () => {
    const { extensionIds, commandId } = loadIdentity();
    const manifest = JSON.parse(readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    assert.equal(manifest.name, extensionIds.name);
    assert.equal(manifest.version, '1.1.0');
    assert.equal(manifest.license, 'GPL-3.0-only');
    assert.equal(manifest.contributes.viewsContainers.panel[0].id, extensionIds.name);
    assert.equal(manifest.contributes.views[extensionIds.name][0].id, extensionIds.logView);
    assert.ok(manifest.activationEvents.includes(`onView:${extensionIds.logView}`));
    const commands = new Set(manifest.contributes.commands.map(entry => entry.command));
    for (const id of commands) assert.equal(id, commandId(id.split('.').pop()));
    for (const menu of Object.values(manifest.contributes.menus).flat()) assert.ok(commands.has(menu.command));
    assert.ok(manifest.contributes.menus['view/title'].every(menu =>
        menu.when.includes('salesforceAssistBuddy.logViewerActive')));
    assert.ok(Object.keys(manifest.contributes.configuration.properties).every(key => key.startsWith(`${extensionIds.configuration}.`)));
});

function createConfiguration(values = {}, defaults = {}) {
    const writes = [];
    return {
        writes,
        get(key, fallback) {
            const value = values[key];
            return value?.workspaceFolderValue ?? value?.workspaceValue ?? value?.globalValue ?? defaults[key] ?? fallback;
        },
        inspect(key) { return values[key] ?? (key in defaults ? { defaultValue: defaults[key] } : undefined); },
        has(key) { return key in values || key in defaults; },
        update(key, value, target) { writes.push({ key, value, target }); return Promise.resolve(); }
    };
}

test('settings use the Salesforce Assist Buddy configuration namespace', () => {
    const current = createConfiguration({ autoRefresh: { globalValue: false } }, { refreshInterval: 5000 });
    const { extensionIds, getConfiguration } = loadIdentity({ salesforceAssistBuddy: current });
    const settings = getConfiguration();
    assert.equal(extensionIds.configuration, 'salesforceAssistBuddy');
    assert.equal(settings.get('autoRefresh'), false);
    assert.equal(settings.get('refreshInterval'), 5000);
    assert.equal(settings.has('autoRefresh'), true);
    assert.equal(settings.get('unknown', 42), 42);
});

test('settings updates write only to the Salesforce Assist Buddy namespace', async () => {
    const current = createConfiguration({}, { refreshInterval: 5000 });
    const { getConfiguration } = loadIdentity({ salesforceAssistBuddy: current });
    await getConfiguration().update('refreshInterval', 15000, 1);
    assert.equal(current.writes.length, 1);
    assert.deepEqual(current.writes[0], { key: 'refreshInterval', value: 15000, target: 1 });
});