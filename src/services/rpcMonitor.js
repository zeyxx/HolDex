/**
 * RPC Credit Monitoring and Budgeting System
 *
 * Tracks Helius RPC usage to prevent runaway credit consumption
 * Features:
 * - Per-hour credit tracking
 * - Per-node credit tracking (API, Calculator, Listener, Worker)
 * - Budget alerts at 80% threshold
 * - Daily/weekly aggregation
 * - Per-operation breakdown
 * - 24h historical breakdown
 */

const { getRedis } = require('./redis');
const logger = require('./logger');
const os = require('os');

// Credit budgets (customize based on your Helius plan)
// Docs: https://www.helius.dev/docs/billing/plans#credit-system
const BUDGET = {
    DAILY: parseInt(process.env.HELIUS_DAILY_BUDGET) || 500000,   // Free: 500k/month ≈ 16k/day
    HOURLY: parseInt(process.env.HELIUS_HOURLY_BUDGET) || 1000,   // ~40 credits/min avg
    ALERT_THRESHOLD: 0.80,                                         // Alert at 80% usage
    CRITICAL_THRESHOLD: 0.95                                       // Critical at 95% usage
};

// Helius credit costs per method type
// https://www.helius.dev/docs/billing/plans#credit-system
const CREDIT_COSTS = {
    // Standard RPC (1 credit each)
    getAccountInfo: 1,
    getBalance: 1,
    getBlock: 1,
    getBlockHeight: 1,
    getSlot: 1,
    getTokenAccountBalance: 1,
    getTokenLargestAccounts: 1,
    getSignaturesForAddress: 1,
    getTransaction: 1,
    getProgramAccounts: 1,
    getMultipleAccounts: 1,

    // DAS API (5-10 credits)
    getAsset: 5,
    getAssetsByOwner: 10,
    getAssetsByGroup: 10,
    getTokenAccounts: 10,
    searchAssets: 10,

    // Enhanced APIs (10-100 credits)
    getTransactionsForAddress: 100,
    parseTransaction: 10,
    getEnhancedTransactions: 100,

    // Default for unknown methods
    default: 1
};

// Node identification
const NODE_ID = process.env.NODE_ID || `${process.env.SERVICE_TYPE || 'api'}-${os.hostname().slice(-8)}`;

/**
 * Get credit cost for a method
 */
function getCreditCost(method) {
    return CREDIT_COSTS[method] || CREDIT_COSTS.default;
}

/**
 * Track an RPC call with per-node attribution
 * @param {string} method - RPC method name (e.g., 'getTokenSupply', 'getAccountInfo')
 * @param {number} credits - Credits consumed (default: 1)
 * @param {Object} metadata - Optional metadata (mint, address, etc.)
 */
async function trackRpcCall(method, credits = 1, _metadata = {}) {
    try {
        const redis = await getRedis();
        if (!redis) return;

        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
        const hourStr = `${dateStr}-${String(now.getHours()).padStart(2, '0')}`;

        const hourKey = `rpc:credits:hour:${hourStr}`;
        const dayKey = `rpc:credits:day:${dateStr}`;
        const methodKey = `rpc:method:${method}:${hourStr}`;
        const nodeKey = `rpc:node:${NODE_ID}:${hourStr}`;
        const nodeMethodKey = `rpc:node:${NODE_ID}:method:${method}:${dateStr}`;

        // Increment all counters atomically
        const pipeline = redis.pipeline();
        pipeline.incrby(hourKey, credits);
        pipeline.incrby(dayKey, credits);
        pipeline.incrby(methodKey, credits);
        pipeline.incrby(nodeKey, credits);
        pipeline.incrby(nodeMethodKey, credits);
        pipeline.expire(hourKey, 7200);      // 2h TTL
        pipeline.expire(dayKey, 172800);     // 2d TTL
        pipeline.expire(methodKey, 7200);
        pipeline.expire(nodeKey, 86400);     // 24h TTL
        pipeline.expire(nodeMethodKey, 172800);

        await pipeline.exec();

        // Check if we should alert
        const hourlyUsage = parseInt(await redis.get(hourKey) || '0');
        const dailyUsage = parseInt(await redis.get(dayKey) || '0');

        const hourlyPercent = hourlyUsage / BUDGET.HOURLY;
        const dailyPercent = dailyUsage / BUDGET.DAILY;

        // Alert on threshold breach
        if (hourlyPercent >= BUDGET.CRITICAL_THRESHOLD) {
            logger.error(`🚨 CRITICAL: Helius credits at ${Math.round(hourlyPercent * 100)}% of hourly budget (${hourlyUsage}/${BUDGET.HOURLY})`);
        } else if (hourlyPercent >= BUDGET.ALERT_THRESHOLD) {
            logger.warn(`⚠️  WARNING: Helius credits at ${Math.round(hourlyPercent * 100)}% of hourly budget (${hourlyUsage}/${BUDGET.HOURLY})`);
        }

        if (dailyPercent >= BUDGET.CRITICAL_THRESHOLD) {
            logger.error(`🚨 CRITICAL: Helius credits at ${Math.round(dailyPercent * 100)}% of daily budget (${dailyUsage}/${BUDGET.DAILY})`);
        } else if (dailyPercent >= BUDGET.ALERT_THRESHOLD && dailyPercent % 0.05 < 0.01) { // Alert every 5%
            logger.warn(`⚠️  WARNING: Helius credits at ${Math.round(dailyPercent * 100)}% of daily budget (${dailyUsage}/${BUDGET.DAILY})`);
        }

        // Log debug info
        logger.debug(`[RPC] ${method}: +${credits} credits (Hour: ${hourlyUsage}, Day: ${dailyUsage})`);

    } catch (e) {
        // Don't fail the operation if monitoring fails
        logger.debug(`[RPC Monitor] Failed to track call: ${e.message}`);
    }
}

/**
 * Get current credit usage stats with per-node breakdown
 * @returns {Promise<Object>} Usage statistics
 */
async function getUsageStats() {
    try {
        const redis = await getRedis();
        if (!redis) return null;

        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const hourStr = `${dateStr}-${String(now.getHours()).padStart(2, '0')}`;

        const hourKey = `rpc:credits:hour:${hourStr}`;
        const dayKey = `rpc:credits:day:${dateStr}`;

        const hourlyUsage = parseInt(await redis.get(hourKey) || '0');
        const dailyUsage = parseInt(await redis.get(dayKey) || '0');

        // Get top methods for current hour
        const methodPattern = `rpc:method:*:${hourStr}`;
        const methodKeys = await redis.keys(methodPattern);
        const methods = {};

        for (const key of methodKeys) {
            const count = parseInt(await redis.get(key) || '0');
            const methodName = key.split(':')[2];
            methods[methodName] = count;
        }

        // Get per-node usage for current hour
        const nodePattern = `rpc:node:*:${hourStr}`;
        const nodeKeys = await redis.keys(nodePattern);
        const nodes = {};

        for (const key of nodeKeys) {
            const count = parseInt(await redis.get(key) || '0');
            const nodeId = key.split(':')[2];
            nodes[nodeId] = count;
        }

        return {
            nodeId: NODE_ID,
            hourly: {
                usage: hourlyUsage,
                budget: BUDGET.HOURLY,
                percent: Math.round((hourlyUsage / BUDGET.HOURLY) * 100),
                remaining: Math.max(0, BUDGET.HOURLY - hourlyUsage)
            },
            daily: {
                usage: dailyUsage,
                budget: BUDGET.DAILY,
                percent: Math.round((dailyUsage / BUDGET.DAILY) * 100),
                remaining: Math.max(0, BUDGET.DAILY - dailyUsage)
            },
            methods,
            nodes,
            timestamp: Date.now()
        };
    } catch (e) {
        logger.debug(`[RPC Monitor] Failed to get stats: ${e.message}`);
        return null;
    }
}

/**
 * Get 24-hour historical breakdown
 * @returns {Promise<Object>} Historical usage data
 */
async function getHistoricalStats() {
    try {
        const redis = await getRedis();
        if (!redis) return null;

        const now = new Date();
        const hourly = [];

        // Get last 24 hours
        for (let i = 0; i < 24; i++) {
            const time = new Date(now.getTime() - (i * 60 * 60 * 1000));
            const dateStr = time.toISOString().slice(0, 10);
            const hourStr = `${dateStr}-${String(time.getHours()).padStart(2, '0')}`;
            const hourKey = `rpc:credits:hour:${hourStr}`;

            const usage = parseInt(await redis.get(hourKey) || '0');
            hourly.unshift({
                hour: hourStr,
                usage,
                percent: Math.round((usage / BUDGET.HOURLY) * 100)
            });
        }

        // Get last 7 days
        const daily = [];
        for (let i = 0; i < 7; i++) {
            const time = new Date(now.getTime() - (i * 24 * 60 * 60 * 1000));
            const dateStr = time.toISOString().slice(0, 10);
            const dayKey = `rpc:credits:day:${dateStr}`;

            const usage = parseInt(await redis.get(dayKey) || '0');
            daily.unshift({
                date: dateStr,
                usage,
                percent: Math.round((usage / BUDGET.DAILY) * 100)
            });
        }

        // Get all nodes' daily usage
        const nodePattern = `rpc:node:*:method:*:${now.toISOString().slice(0, 10)}`;
        const nodeMethodKeys = await redis.keys(nodePattern);
        const nodeBreakdown = {};

        for (const key of nodeMethodKeys) {
            const parts = key.split(':');
            const nodeId = parts[2];
            const method = parts[4];
            const count = parseInt(await redis.get(key) || '0');

            if (!nodeBreakdown[nodeId]) {
                nodeBreakdown[nodeId] = { total: 0, methods: {} };
            }
            nodeBreakdown[nodeId].total += count;
            nodeBreakdown[nodeId].methods[method] = count;
        }

        return {
            hourly,
            daily,
            nodeBreakdown,
            budget: BUDGET,
            timestamp: Date.now()
        };
    } catch (e) {
        logger.debug(`[RPC Monitor] Failed to get historical stats: ${e.message}`);
        return null;
    }
}

/**
 * Check if we should throttle RPC calls based on budget
 * @returns {Promise<boolean>} True if we should throttle
 */
async function shouldThrottle() {
    try {
        const stats = await getUsageStats();
        if (!stats) return false;

        // Throttle if we're above critical threshold
        return stats.hourly.percent >= (BUDGET.CRITICAL_THRESHOLD * 100);
    } catch (_e) {
        return false;
    }
}

/**
 * Reset counters (admin use only)
 */
async function resetCounters() {
    try {
        const redis = await getRedis();
        if (!redis) return;

        const keys = await redis.keys('rpc:*');
        if (keys.length > 0) {
            await redis.del(...keys);
            logger.info(`✅ Reset ${keys.length} RPC monitoring keys`);
        }
    } catch (e) {
        logger.error(`[RPC Monitor] Failed to reset: ${e.message}`);
    }
}

module.exports = {
    trackRpcCall,
    getUsageStats,
    getHistoricalStats,
    shouldThrottle,
    resetCounters,
    getCreditCost,
    BUDGET,
    CREDIT_COSTS,
    NODE_ID
};
