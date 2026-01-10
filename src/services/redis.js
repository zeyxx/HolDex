const Redis = require('ioredis');
const config = require('../config/env');
const logger = require('./logger');

let client = null;
let subscriber = null;
let initPromise = null;

async function connectRedis() {
    if (client) return client;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        try {
            // Initialize Redis Client
            // Force lazyConnect to ensure we catch connection errors in the Promise
            // keyPrefix isolates HolDex keys from other apps sharing the same Redis
            const tempClient = new Redis(config.REDIS_URL, {
                lazyConnect: true,
                keyPrefix: 'holdex:',
                maxRetriesPerRequest: null,
                retryStrategy: (times) => Math.min(times * 50, 2000),
                reconnectOnError: (err) => {
                    const targetError = 'READONLY';
                    return err.message.slice(0, targetError.length) === targetError;
                }
            });

            tempClient.on('error', (err) => {
                if (!err.message.includes('ECONNREFUSED')) {
                    logger.error(`Redis Error: ${err.message}`);
                }
            });

            await tempClient.connect();
            logger.info('✅ Redis Connected');
            
            client = tempClient;
            subscriber = client.duplicate();
            
            return client;
        } catch (e) {
            logger.error(`Redis Connection Failed: ${e.message}`);
            initPromise = null;
            return null; // Return null so app can run in "degraded" mode without crashing
        }
    })();

    return initPromise;
}

function getClient() {
    return client;
}

function getSubscriber() {
    return subscriber;
}

/**
 * Get Redis memory usage info
 * @returns {Promise<{usedMemory: number, maxMemory: number, usagePercent: number, warning: boolean}>}
 */
async function getMemoryInfo() {
    if (!client) return null;

    try {
        const info = await client.info('memory');
        const lines = info.split('\r\n');

        let usedMemory = 0;
        let maxMemory = 0;

        for (const line of lines) {
            if (line.startsWith('used_memory:')) {
                usedMemory = parseInt(line.split(':')[1]);
            } else if (line.startsWith('maxmemory:')) {
                maxMemory = parseInt(line.split(':')[1]);
            }
        }

        // If maxmemory is 0, use 25MB (Render free tier default)
        if (maxMemory === 0) maxMemory = 25 * 1024 * 1024;

        const usagePercent = Math.round((usedMemory / maxMemory) * 100);
        const warning = usagePercent > 80;

        return {
            usedMemory,
            usedMemoryMB: Math.round(usedMemory / (1024 * 1024) * 10) / 10,
            maxMemory,
            maxMemoryMB: Math.round(maxMemory / (1024 * 1024) * 10) / 10,
            usagePercent,
            warning
        };
    } catch (err) {
        logger.error(`Redis memory check failed: ${err.message}`);
        return null;
    }
}

/**
 * Log Redis memory status - call periodically for monitoring
 */
async function logMemoryStatus() {
    const info = await getMemoryInfo();
    if (!info) return;

    const emoji = info.warning ? '⚠️' : '✅';
    const level = info.warning ? 'warn' : 'debug';

    logger[level](`${emoji} Redis Memory: ${info.usedMemoryMB}MB / ${info.maxMemoryMB}MB (${info.usagePercent}%)`);

    if (info.usagePercent > 90) {
        logger.error(`🚨 Redis memory critical: ${info.usagePercent}% - evictions likely!`);
    }

    return info;
}

module.exports = {
    connectRedis,
    initRedis: connectRedis, // ALIAS for backwards compatibility
    getClient,
    getRedis: getClient, // ALIAS for backwards compatibility
    getSubscriber,
    getMemoryInfo,
    logMemoryStatus
};
