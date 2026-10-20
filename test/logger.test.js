const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.transpileModule(readFileSync(path.join(__dirname, '../src/core/logger.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;

function createLogger() {
    const entries = [];
    const timers = new Map();
    let now = 0;
    let timerId = 0;
    const channel = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [
        level, message => entries.push({ level, message })
    ]));
    const context = {
        exports: {},
        Error,
        Date: class extends Date { static now() { return now; } },
        require(name) {
            if (name === 'vscode') {
                return { window: { createOutputChannel(name, options) {
                    assert.equal(name, 'Salesforce Assist Buddy');
                    assert.equal(options.log, true);
                    return channel;
                } } };
            }
            if (name === 'fs/promises') return fs;
            if (name === 'path') return path;
            assert.fail(`Unexpected dependency ${name}`);
        },
        setTimeout(callback, delay) {
            const id = ++timerId;
            timers.set(id, { callback, deadline: now + delay });
            return id;
        },
        clearTimeout(id) { timers.delete(id); }
    };
    vm.runInNewContext(source, context);
    return {
        logger: context.exports.logger,
        removeExpiredLogFiles: context.exports.removeExpiredLogFiles,
        entries,
        timers,
        advance(milliseconds) {
            now += milliseconds;
            for (const [id, timer] of timers) {
                if (timer.deadline <= now) {
                    timers.delete(id);
                    timer.callback();
                }
            }
        }
    };
}

test('routine diagnostics use Debug; problems retain scope and severity', () => {
    const { logger, entries } = createLogger();
    logger.debug('Refresh', 'Started');
    logger.warn('Refresh', 'Unavailable');
    logger.error('Download', 'Stopped', new Error('disk full'));
    assert.deepEqual(entries.map(entry => entry.level), ['debug', 'warn', 'error']);
    assert.match(entries[2].message, /\[Download\] Stopped: Error: disk full/);
});

test('identical problems are suppressed for 60s without hiding distinct failures', () => {
    const { logger, entries, advance } = createLogger();
    logger.error('Refresh', 'Offline');
    logger.error('Refresh', 'Offline');
    logger.error('Refresh', 'Offline');
    logger.error('Refresh', 'Permission denied');
    assert.equal(entries.length, 2);
    advance(60000);
    logger.error('Refresh', 'Offline');
    assert.match(entries[2].message, /2 repeats suppressed/);
});

test('redacts credentials in messages and error stacks at every level', () => {
    const { logger, entries } = createLogger();
    for (const level of ['debug', 'info', 'warn', 'error']) {
        logger[level]('Auth', 'Authorization: Bearer header-secret accessToken="json-secret" refresh_token=refresh-secret password=pass-secret client_secret=client-secret 00D123456!session-secret');
    }
    logger.error('Auth', 'CLI failed', new Error('{"access_token":"stack-secret"}'));
    logger.warn('Auth', 'Authorization: Basic basic-secret');
    for (const entry of entries) {
        assert.doesNotMatch(entry.message, /header-secret|json-secret|refresh-secret|pass-secret|client-secret|session-secret|stack-secret|basic-secret/);
        assert.match(entry.message, /\[REDACTED\]/);
    }
});

test('fast operations preserve results, log only Debug, and clear their timer', async () => {
    const { logger, entries, timers } = createLogger();
    assert.equal(await logger.run('Query', async () => 42), 42);
    assert.equal(timers.size, 0);
    assert.ok(entries.every(entry => entry.level === 'debug'));
});

test('slow operations warn once and report eventual completion', async () => {
    const { logger, entries, advance, timers } = createLogger();
    let finish;
    const operation = logger.run('Query', () => new Promise(resolve => { finish = resolve; }));
    advance(14999);
    assert.equal(entries.filter(entry => entry.level === 'warn').length, 0);
    advance(1);
    advance(30000);
    assert.equal(entries.filter(entry => entry.level === 'warn').length, 1);
    assert.match(entries.find(entry => entry.level === 'warn').message, /Query.*Still pending.*operation 1/);
    finish('done');
    assert.equal(await operation, 'done');
    assert.equal(timers.size, 0);
    assert.match(entries.find(entry => entry.level === 'info').message, /Completed in 45000ms/);
});

test('failed operations rethrow unchanged and clear timers; caller owns error logging', async () => {
    const { logger, entries, timers } = createLogger();
    const failure = new Error('API unavailable');
    await assert.rejects(logger.run('Query', async () => { throw failure; }), error => error === failure);
    assert.equal(timers.size, 0);
    assert.ok(entries.every(entry => entry.level === 'debug'));
});

test('log retention removes files older than the cutoff and preserves recent files', async () => {
    const { removeExpiredLogFiles } = createLogger();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'salesforce-assist-buddy-logs-'));
    const oldFile = path.join(directory, 'old.log');
    const recentFile = path.join(directory, 'recent.log');
    const nestedDirectory = path.join(directory, 'nested');
    const nestedOldFile = path.join(nestedDirectory, 'old.log');
    try {
        await fs.mkdir(nestedDirectory);
        await fs.writeFile(oldFile, 'expired');
        await fs.writeFile(recentFile, 'recent');
        await fs.writeFile(nestedOldFile, 'expired');
        const cutoff = Date.now() - 48 * 60 * 60 * 1000;
        const oldTime = new Date(cutoff - 1000);
        await fs.utimes(oldFile, oldTime, oldTime);
        await fs.utimes(nestedOldFile, oldTime, oldTime);

        assert.equal(await removeExpiredLogFiles(directory, cutoff), 2);
        await assert.rejects(fs.stat(oldFile), { code: 'ENOENT' });
        await assert.rejects(fs.stat(nestedOldFile), { code: 'ENOENT' });
        await fs.stat(recentFile);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});