/**
    This module manages the creation and deletion of trace flags in Salesforce.
    It ensures that a debug level exists in the org and creates a trace flag for the user if it doesn't exist.

    TODO:
    - Add support for creation of custom debug levels with the parameters specified by the user
    - Add support for trace flags for other entities (e.g. Apex classes, triggers)
*/

import { Connection } from 'jsforce';
import * as vscode from 'vscode';
import { logger } from '../../core/logger';
import { retryOnSessionExpire } from '../../core/connection';
import { getConfiguration } from '../../core/extensionIdentity';

export interface DebugLevel {
    Id: string;
    DeveloperName: string;
    MasterLabel: string;
    ApexCode: string;
    Visualforce: string;
    Database: string;
    System: string;
}

export interface TraceFlag {
    Id: string;
    DebugLevelId: string;
    LogType: string;
    StartDate: string;
    ExpirationDate: string;
    TracedEntityId: string;
}

// Use the same debug level name and log type as the Developer Console.
const LEVEL_NAME = getConfiguration().get<string>('debugLevel') ?? 'InternalAll';
const LOG_TYPE = 'DEVELOPER_LOG';

// Store timers and trace flag ids for keep-alive per user
const traceFlagKeepAliveTimers: Map<string, NodeJS.Timeout> = new Map();
const userTraceFlagIds: Map<string, string> = new Map();

// Start the keep-alive loop for the trace flag
export async function startTraceFlagKeepAlive(connection: Connection, userId: string) {
    // Get expiration interval from config, default 15, min 5
    const config = getConfiguration();
    let minutes = config.get<number>('traceFlagExpirationInterval') ?? 15;
    if (minutes < 5) minutes = 5;
    await ensureTraceFlag(connection, userId, minutes); // Pass interval
}

// Stop the keep-alive loop for all users or a specific user
export function stopTraceFlagKeepAlive(userId?: string) {
    logger.debug('TraceFlag.keepAlive', userId ? `Stopping renewal for user ${userId}` : `Stopping ${traceFlagKeepAliveTimers.size} renewal timers`);
    if (userId) {
        if (traceFlagKeepAliveTimers.has(userId)) {
            clearTimeout(traceFlagKeepAliveTimers.get(userId)!);
            traceFlagKeepAliveTimers.delete(userId);
            userTraceFlagIds.delete(userId);
        }
    } else {
        for (const [uid, timer] of traceFlagKeepAliveTimers.entries()) {
            clearTimeout(timer);
        }
        traceFlagKeepAliveTimers.clear();
        userTraceFlagIds.clear();
    }
}

//Function to ensure the trace flag is set for the user
//This function will check if a trace flag already exists for the user and create one if it doesn't
export async function ensureTraceFlag(connection: Connection, userId: string, expirationMinutes?: number, keepAlive: boolean = true): Promise<void> {
    try {
        logger.debug('TraceFlag.ensure', `Checking trace flag for user ${userId}`);
        // Set the debug level for the trace flag.
        const debugLevelId = await logger.run('TraceFlag.debugLevel', () => ensureDebugLevel(connection));
        // Check for existing trace flag
        const existingFlags = await logger.run('TraceFlag.queryExisting', () => retryOnSessionExpire(async (conn) => await conn.tooling.query(`SELECT Id, DebugLevelId, LogType, StartDate, ExpirationDate FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = '${LOG_TYPE}'`), null)) as { records: TraceFlag[] };
        logger.debug('TraceFlag.ensure', `Replacing ${existingFlags.records?.length || 0} existing flags`);
        // Delete the user's existing trace flags.
        if (existingFlags.records && existingFlags.records.length > 0) {
            for (const flag of existingFlags.records) {
                await logger.run(`TraceFlag.delete:${flag.Id}`, () => retryOnSessionExpire(async (conn) => await conn.tooling.delete('TraceFlag', flag.Id), null));
            }
        }
        // Use config or default for expiration interval
        let minutes = expirationMinutes;
        if (!minutes) {
            const config = getConfiguration();
            minutes = config.get<number>('traceFlagExpirationInterval') ?? 15;
        }

        // Create a new trace flag with a custom expiration.
        const traceFlagId = await logger.run('TraceFlag.create', () => createTraceFlag(connection, userId, debugLevelId, minutes));
        logger.debug('TraceFlag.ensure', `Activated trace flag ${traceFlagId} for user ${userId}; keepAlive=${keepAlive}`);
        userTraceFlagIds.set(userId, traceFlagId);
        if (keepAlive) {
            scheduleTraceFlagExtension(connection, userId, traceFlagId, minutes);
        }
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        logger.error('TraceFlag.ensure', `Trace flag setup stopped for user ${userId}`, error);
        vscode.window.showErrorMessage(`Failed to manage trace flag: ${errorMessage}`);
        throw error;
    }
}

// Schedule the timer to extend the trace flag expiration for a user
function scheduleTraceFlagExtension(connection: Connection, userId: string, traceFlagId: string, minutes: number) {
    // Clear any existing timer for this user
    if (traceFlagKeepAliveTimers.has(userId)) {
        clearTimeout(traceFlagKeepAliveTimers.get(userId)!);
    }
    // Set timer to fire at (minutes - 1) minutes
    const interval = Math.max(minutes - 1, 1) * 60 * 1000;
    const timer = setTimeout(async () => {
        try {
            await logger.run(`TraceFlag.renew:${traceFlagId}`, () => extendTraceFlagExpiration(connection, traceFlagId, minutes));
            logger.debug('TraceFlag.keepAlive', `Renewed ${traceFlagId} for user ${userId}; expiration=${minutes} minutes`);
            scheduleTraceFlagExtension(connection, userId, traceFlagId, minutes); // Reschedule
        } catch (err) {
            logger.error('TraceFlag.keepAlive', `Renewal stopped for user ${userId}, flag ${traceFlagId}; no further renewal is scheduled and the flag may expire`, err);
        }
    }, interval);
    traceFlagKeepAliveTimers.set(userId, timer);
}

// Extend the expiration of the trace flag by N minutes from now
async function extendTraceFlagExpiration(connection: Connection, traceFlagId: string, minutes: number) {
    const now = new Date();
    const newExpiration = new Date(now.getTime() + minutes * 60 * 1000);
    const result = await retryOnSessionExpire(async (conn) => await conn.tooling.update('TraceFlag', {
        Id: traceFlagId,
        ExpirationDate: newExpiration.toISOString()
    }), null) as { success: boolean; errors?: any };
    if (!result.success) {
        throw new Error(`Failed to update trace flag expiration: ${JSON.stringify(result.errors)}`);
    }
    logger.debug('TraceFlag.expiration', `Extended to ${newExpiration.toISOString()}`);
}

//Function to create a new trace flag for the user
async function createTraceFlag(connection: Connection, userId: string, debugLevelId: string, minutes: number = 10): Promise<string> {
    const now = new Date();
    const future = new Date(now.getTime() + minutes * 60 * 1000); // Set expiration to N minutes from now

    // Create new trace flag
    const result = await retryOnSessionExpire(async (conn) => await conn.tooling.create('TraceFlag', {
        TracedEntityId: userId,
        DebugLevelId: debugLevelId,
        LogType: LOG_TYPE,
        StartDate: now.toISOString(),
        ExpirationDate: future.toISOString()
    }), null) as { id: string };

    // The result of tooling.create is { id: string } on success, but may have errors if failed
    if (!('id' in result)) {
        throw new Error(`Failed to create new trace flag: ${JSON.stringify(result)}`);
    }
    logger.debug('TraceFlag.create', `Created flag ${result.id}`);
    return result.id;
}

//Function to ensure the debug level exists in the org
async function ensureDebugLevel(connection: Connection): Promise<string> {
    try {
        logger.debug('TraceFlag.debugLevel', `Checking debug level ${LEVEL_NAME}`);
        
        // Check for existing debug level in the org
        const existingLevels = await retryOnSessionExpire(async (conn) => await conn.tooling.query(`SELECT Id, ApexCode, Visualforce, Database, System FROM DebugLevel WHERE DeveloperName = '${LEVEL_NAME}'`), null) as { records: DebugLevel[] };

        if (existingLevels.records && existingLevels.records.length > 0) {
            logger.debug('TraceFlag.debugLevel', `Using existing level ${existingLevels.records[0].Id}`);
            return existingLevels.records[0].Id;
        }else{
            // Create new debug level if there are none
            logger.debug('TraceFlag.debugLevel', 'No existing level; creating one');
            return await createDebugLevel(connection);
        }
            
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        logger.debug('TraceFlag.debugLevel', 'Debug level setup failed; propagating to trace flag setup');
        vscode.window.showErrorMessage(`Failed to manage debug level: ${errorMessage}`);
        throw error;
    }
}

//Function to create a new debug level in the org
async function createDebugLevel(connection: Connection): Promise<string> {

    const result = await retryOnSessionExpire(async (conn) => await conn.tooling.create('DebugLevel', {
        DeveloperName: LEVEL_NAME,
        MasterLabel: LEVEL_NAME,
        ApexCode: 'FINEST',
        Visualforce: 'FINER',
        Database: 'INFO',
        System: 'DEBUG',
        Callout: 'INFO',
        Workflow: 'INFO',
        Validation: 'INFO'
    }), null) as { id: string }; 
    
    // The result of tooling.create is { id: string } on success, but may have errors if failed
    if (!('id' in result)) {
        throw new Error(`Failed to create debug level: ${JSON.stringify(result)}`);
    }
    logger.debug('TraceFlag.debugLevel', `Created level ${result.id}`);
    return result.id;
}

// Enable trace flag for a specific user, with keep-alive
export async function enableTraceFlagForUser(connection: Connection, userId: string, expirationMinutes?: number): Promise<void> {
    await ensureTraceFlag(connection, userId, expirationMinutes, true);
}

// Disable (delete) all trace flags for a specific user and stop their keep-alive
export async function disableTraceFlagForUser(connection: Connection, userId: string): Promise<void> {
    stopTraceFlagKeepAlive(userId);
    try {
        logger.debug('TraceFlag.disable', `Disabling flags for user ${userId}`);
        // Only get expired trace flags
        const nowIso = new Date().toISOString();
        const existingFlags = await logger.run('TraceFlag.queryForDisable', () => retryOnSessionExpire(async (conn) => await conn.tooling.query(
            `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = '${LOG_TYPE}'`
        ), null)) as { records: TraceFlag[] };
        if (existingFlags.records && existingFlags.records.length > 0) {
            for (const flag of existingFlags.records) {
                await logger.run(`TraceFlag.disable:${flag.Id}`, () => retryOnSessionExpire(async (conn) => await conn.tooling.delete('TraceFlag', flag.Id), null));
            }
        } else {
            logger.debug('TraceFlag.disable', 'No flags found; nothing to disable');
        }
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        logger.error('TraceFlag.disable', `Could not disable flags for user ${userId}; renewal has already been stopped`, error);
        vscode.window.showErrorMessage(`Failed to disable trace flag: ${errorMessage}`);
        throw error;
    }
}