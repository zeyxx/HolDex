/**
 * RPC Credit Monitoring and Budgeting System
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Multi-node Redis-based credit tracking for Helius RPC usage.
 *
 * φ-INTEGRATION:
 *   - BUDGET, CREDIT_COSTS imported from rpcHarmony.js (φ-based formulas)
 *   - Redis keys enable distributed tracking across all nodes
 *   - Per-node attribution for debugging and optimization
 *
 * Features:
 *   - Per-hour/day credit tracking
 *   - Per-node credit tracking (API, Calculator, Listener, Worker)
 *   - φ-based alert thresholds (61.8%, 76.4%, 76.4%)
 *   - 24h historical breakdown
 */

const { getRedis } = require('./redis');
const logger = require('./logger');
const os = require('os');

// Import φ-based constants from harmony module (SINGLE SOURCE OF TRUTH)
const {
    BUDGET,
    CREDIT_COSTS,
    getCreditCost: getHarmonyCreditCost,
    getHealthFromPercent
} = require('./rpcHarmony');

// Node identification for multi-node tracking
const NODE_ID = process.env.NODE_ID || `${process.env.SERVICE_TYPE || 'api'}-${os.hostname().slice(-8)}`;

/**
 * Get credit cost for a method (proxy to rpcHarmony)
 */
function getCreditCost(method) {
    return getHarmonyCreditCost(method);
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

        // Alert on threshold breach (φ-based 3-tier system)
        // 61.8% → alert, 76.4% → warning, 76.4% → critical
        const healthStatus = getHealthFromPercent(hourlyPercent, dailyPercent);

        if (healthStatus === 'critical') {
            logger.error(`🚨 CRITICAL: Helius credits at ${Math.round(hourlyPercent * 100)}% hourly, ${Math.round(dailyPercent * 100)}% daily`);
        } else if (healthStatus === 'warning') {
            logger.warn(`⚠️  WARNING: Helius credits at ${Math.round(hourlyPercent * 100)}% hourly, ${Math.round(dailyPercent * 100)}% daily`);
        } else if (healthStatus === 'alert' && Math.floor(hourlyPercent * 20) !== Math.floor((hourlyPercent - 0.05) * 20)) {
            // Alert once per 5% increment
            logger.info(`📊 ALERT: Helius credits at ${Math.round(hourlyPercent * 100)}% hourly (φ⁻¹ threshold)`);
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
