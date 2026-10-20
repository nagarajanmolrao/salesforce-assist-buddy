import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

export const outputChannel = vscode.window.createOutputChannel('Salesforce Assist Buddy', { log: true });

const recentProblems = new Map<string, { time: number; suppressed: number }>();
const LOG_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
const LOG_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
let operationId = 0;

export function startLogRetention(logUri: vscode.Uri): vscode.Disposable {
    const cleanup = async () => {
        try {
            const cutoff = Date.now() - LOG_RETENTION_MS + LOG_CLEANUP_INTERVAL_MS;
            const removed = await removeExpiredLogFiles(logUri.fsPath, cutoff);
            if (removed > 0) logger.info('LogRetention', `Removed ${removed} expired log files`);
        } catch (error) {
            logger.warn('LogRetention', 'Could not remove expired extension log files', error);
        }
    };

    void cleanup();
    const timer = setInterval(() => void cleanup(), LOG_CLEANUP_INTERVAL_MS);
    return { dispose: () => clearInterval(timer) };
}

export async function removeExpiredLogFiles(directory: string, cutoff: number): Promise<number> {
    let entries: import('fs').Dirent[];
    try {
        entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
    }

    let removed = 0;
    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            removed += await removeExpiredLogFiles(entryPath, cutoff);
        } else if (entry.isFile()) {
            const file = await fs.lstat(entryPath);
            if (file.mtimeMs < cutoff) {
                await fs.unlink(entryPath);
                removed++;
            }
        }
    }
    return removed;
}

function redact(value: string): string {
    return value
        .replace(/(["']?authorization["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:Bearer|Basic)\s+[^\s,"'}]+|[^\s,}]+)/gi, '$1[REDACTED]')
        .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
        .replace(/(["']?(?:access_?token|refresh_?token|password|client_?secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1[REDACTED]')
        .replace(/\b00D[A-Za-z0-9]+![A-Za-z0-9._-]+/g, '[REDACTED]');
}

function problem(level: 'warn' | 'error', scope: string, message: string, error?: unknown): void {
    const details = error === undefined ? '' : `: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
    const text = redact(`[${scope}] ${message}${details}`);
    const key = `${level}:${text}`;
    const previous = recentProblems.get(key);
    const now = Date.now();
    if (previous && now - previous.time < 60000) {
        previous.suppressed++;
        return;
    }
    if (recentProblems.size >= 200) {
        recentProblems.delete(recentProblems.keys().next().value!);
    }
    recentProblems.set(key, { time: now, suppressed: 0 });
    outputChannel[level](`${text}${previous?.suppressed ? ` (${previous.suppressed} repeats suppressed)` : ''}`);
}

export const logger = {
    debug(scope: string, message: string): void {
        outputChannel.debug(redact(`[${scope}] ${message}`));
    },
    info(scope: string, message: string): void {
        outputChannel.info(redact(`[${scope}] ${message}`));
    },
    warn(scope: string, message: string, error?: unknown): void {
        problem('warn', scope, message, error);
    },
    error(scope: string, message: string, error?: unknown): void {
        problem('error', scope, message, error);
    },
    async run<T>(scope: string, action: () => PromiseLike<T>): Promise<T> {
        const id = ++operationId;
        const started = Date.now();
        let slow = false;
        logger.debug(scope, `Started (operation ${id})`);
        const timer = setTimeout(() => {
            slow = true;
            logger.warn(scope, `Still pending after 15s (operation ${id}); waiting for completion`);
        }, 15000);
        try {
            const result = await action();
            const message = `Completed in ${Date.now() - started}ms (operation ${id})`;
            if (slow) {
                logger.info(scope, message);
            } else {
                logger.debug(scope, message);
            }
            return result;
        } catch (error) {
            logger.debug(scope, `Stopped after ${Date.now() - started}ms (operation ${id}); propagating failure to caller`);
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
};