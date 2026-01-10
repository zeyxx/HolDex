/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * RPC HARDCAP MODULE - φ-Based Per-Node Credit Limits
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * "API first, users can't wait"
 *
 * This module enforces HARD LIMITS on RPC credit consumption per node type.
 * Uses φ (Golden Ratio) distribution with API as priority #1.
 *
 * DISTRIBUTION (φ-based, API-first):
 *   API:        φ⁻¹ = 61.8% → Users can't wait
 *   CALCULATOR: φ⁻² = 23.6% → K-Score can wait
 *   LISTENER:   φ⁻³ =  9.0% → Light, constant
 *   WORKER:     φ⁻⁴ =  5.6% → Background, lowest
 *
 * ENFORCEMENT:
 *   - Each node tracks credits via Redis
 *   - HARDCAP reached → node throttles automatically
 *   - API: never blocked, alert at 80%
 *   - Others: pause and retry after hourly reset
 *
 * @version 1.0.0
 * @requires rpcHarmony.js
 */

'use strict';

const { getRedis } = require('./redis');
const logger = require('./logger');
const os = require('os');

// Import φ constants from harmony module
const {
    PHI,
    PHI_POWERS,
    BUDGET: GLOBAL_BUDGET,
    getCreditCost
} = require('./rpcHarmony');

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: NODE TYPE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Node Types and their φ-based budget shares
 *
 * Priority order: API > CALCULATOR > LISTENER > WORKER
 * Distribution uses φ powers for natural harmony
 */
const NODE_TYPES = Object.freeze({
    API: 'api',
    CALCULATOR: 'calculator',
    LISTENER: 'listener',
    WORKER: 'worker'
});

/**
 * φ-Based Budget Allocation
 *
 * Total daily budget split using golden ratio:
 *   API:        φ⁻¹ (61.8%) - Users can't wait
 *   CALCULATOR: φ⁻² (23.6%) - K-Score updates can be delayed
 *   LISTENER:   φ⁻³ (9.0%)  - Light real-time monitoring
 *   WORKER:     φ⁻⁴ (5.6%)  - Background processing, lowest priority
 *
 * Note: Shares sum to ~100% (slight φ rounding)
 */
const NODE_ALLOCATIONS = Object.freeze({
    [NODE_TYPES.API]: {
        share: PHI_POWERS.PHI_INV,           // 61.8%
        priority: 1,
        canBlock: false,                      // Never block API
        description: 'User-facing API - highest priority'
    },
    [NODE_TYPES.CALCULATOR]: {
        share: PHI_POWERS.PHI_INV_SQ,        // 23.6%
        priority: 2,
        canBlock: true,                       // Can throttle
        description: 'K-Score calculation - can be delayed'
    },
    [NODE_TYPES.LISTENER]: {
        share: PHI_POWERS.PHI_INV_CUBED,     // 9.0%
        priority: 3,
        canBlock: true,
        description: 'Real-time listener - light usage'
    },
    [NODE_TYPES.WORKER]: {
        share: Math.pow(PHI_POWERS.PHI_INV, 4), // 5.6%
        priority: 4,
        canBlock: true,
        description: 'Background worker - lowest priority'
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: BUDGET CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate per-node budgets based on φ allocations
 */
function calculateNodeBudgets() {
    const budgets = {};

    for (const [nodeType, allocation] of Object.entries(NODE_ALLOCATIONS)) {
        const dailyBudget = Math.floor(GLOBAL_BUDGET.DAILY * allocation.share);
        const hourlyBudget = Math.floor(GLOBAL_BUDGET.HOURLY * allocation.share);
        const minuteBudget = Math.floor(hourlyBudget / 60);

        budgets[nodeType] = Object.freeze({
            daily: dailyBudget,
            hourly: hourlyBudget,
            minute: minuteBudget,
            share: allocation.share,
            sharePercent: Math.round(allocation.share * 100 * 10) / 10,
            priority: allocation.priority,
            canBlock: allocation.canBlock,
            description: allocation.description,
            // φ-based thresholds for this node
            alertThreshold: GLOBAL_BUDGET.ALERT_THRESHOLD,
            warningThreshold: GLOBAL_BUDGET.WARNING_THRESHOLD,
            criticalThreshold: GLOBAL_BUDGET.CRITICAL_THRESHOLD
        });
    }

    return Object.freeze(budgets);
}

const NODE_BUDGETS = calculateNodeBudgets();

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: NODE IDENTIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect current node type from environment
 */
function detectNodeType() {
    const serviceType = (process.env.SERVICE_TYPE || '').toLowerCase();

    if (serviceType.includes('calc')) return NODE_TYPES.CALCULATOR;
    if (serviceType.includes('listen')) return NODE_TYPES.LISTENER;
    if (serviceType.includes('work')) return NODE_TYPES.WORKER;

    // Default to API
    return NODE_TYPES.API;
}

/**
 * Get unique node identifier
 */
function getNodeId() {
    const nodeType = detectNodeType();
    const hostname = os.hostname().slice(-8);
    return process.env.NODE_ID || `${nodeType}-${hostname}`;
}

// Current node context
const CURRENT_NODE_TYPE = detectNodeType();
const CURRENT_NODE_ID = getNodeId();
const CURRENT_NODE_BUDGET = NODE_BUDGETS[CURRENT_NODE_TYPE];

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: REDIS KEY MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate Redis keys for hardcap tracking
 */
function getRedisKeys(nodeType = CURRENT_NODE_TYPE) {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const hourStr = `${dateStr}-${String(now.getHours()).padStart(2, '0')}`;

    return {
        hourly: `hardcap:${nodeType}:hour:${hourStr}`,
        daily: `hardcap:${nodeType}:day:${dateStr}`,
        blocked: `hardcap:${nodeType}:blocked`,
        nodeInstance: `hardcap:${nodeType}:${CURRENT_NODE_ID}:hour:${hourStr}`
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: HARDCAP ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if a node type has reached its HARDCAP
 *
 * @param {string} nodeType - Node type to check
 * @returns {Promise<Object>} Status object with allowed, remaining, throttleMs
 */
async function checkHardcap(nodeType = CURRENT_NODE_TYPE) {
    const budget = NODE_BUDGETS[nodeType];
    if (!budget) {
        return { allowed: true, remaining: Infinity, throttleMs: 0, error: 'Unknown node type' };
    }

    try {
        const redis = await getRedis();
        if (!redis) {
            // No Redis = no enforcement, allow with warning
            return { allowed: true, remaining: budget.hourly, throttleMs: 0, noRedis: true };
        }

        const keys = getRedisKeys(nodeType);
        const [hourlyUsage, dailyUsage] = await Promise.all([
            redis.get(keys.hourly),
            redis.get(keys.daily)
        ]);

        const hourly = parseInt(hourlyUsage || '0');
        const daily = parseInt(dailyUsage || '0');

        const hourlyPercent = hourly / budget.hourly;
        const dailyPercent = daily / budget.daily;
        const maxPercent = Math.max(hourlyPercent, dailyPercent);

        // Calculate remaining credits
        const hourlyRemaining = Math.max(0, budget.hourly - hourly);
        const dailyRemaining = Math.max(0, budget.daily - daily);
        const remaining = Math.min(hourlyRemaining, dailyRemaining);

        // Determine status
        let status = 'healthy';
        let throttleMs = 0;
        let allowed = true;

        if (maxPercent >= 1.0) {
            // HARDCAP REACHED
            status = 'blocked';
            allowed = !budget.canBlock; // API still allowed

            // Calculate time until next hour reset
            const now = new Date();
            const nextHour = new Date(now);
            nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
            throttleMs = nextHour.getTime() - now.getTime();

            if (budget.canBlock) {
                logger.warn(`[HARDCAP] ${nodeType} BLOCKED - limit reached (${hourly}/${budget.hourly}). Retry in ${Math.round(throttleMs / 1000)}s`);
            } else {
                logger.error(`[HARDCAP] ${nodeType} at LIMIT but cannot block (${hourly}/${budget.hourly})`);
            }
        } else if (maxPercent >= budget.criticalThreshold) {
            status = 'critical';
            // Exponential backoff using φ
            throttleMs = Math.round(1000 * Math.pow(PHI, 3)); // ~4.2s
        } else if (maxPercent >= budget.warningThreshold) {
            status = 'warning';
            throttleMs = Math.round(1000 * PHI); // ~1.6s
        } else if (maxPercent >= budget.alertThreshold) {
            status = 'alert';
            throttleMs = Math.round(1000 * PHI_POWERS.PHI_INV); // ~0.6s
        }

        return {
            allowed,
            remaining,
            throttleMs,
            status,
            usage: {
                hourly: { used: hourly, budget: budget.hourly, percent: Math.round(hourlyPercent * 100) },
                daily: { used: daily, budget: budget.daily, percent: Math.round(dailyPercent * 100) }
            },
            nodeType,
            canBlock: budget.canBlock
        };

    } catch (e) {
        logger.debug(`[HARDCAP] Check failed: ${e.message}`);
        return { allowed: true, remaining: budget.hourly, throttleMs: 0, error: e.message };
    }
}

/**
 * Consume credits and enforce HARDCAP
 *
 * @param {string} method - RPC method name
 * @param {number} credits - Credits to consume (auto-detected if not provided)
 * @param {string} nodeType - Node type (default: current node)
 * @returns {Promise<Object>} Result with allowed status and tracking info
 */
async function consumeCredits(method, credits = null, nodeType = CURRENT_NODE_TYPE) {
    const cost = credits ?? getCreditCost(method);
    const budget = NODE_BUDGETS[nodeType];

    if (!budget) {
        return { allowed: true, cost, error: 'Unknown node type' };
    }

    try {
        const redis = await getRedis();
        if (!redis) {
            return { allowed: true, cost, noRedis: true };
        }

        const keys = getRedisKeys(nodeType);

        // Atomic increment and check
        const pipeline = redis.pipeline();
        pipeline.incrby(keys.hourly, cost);
        pipeline.incrby(keys.daily, cost);
        pipeline.incrby(keys.nodeInstance, cost);
        pipeline.expire(keys.hourly, 7200);      // 2h TTL
        pipeline.expire(keys.daily, 172800);     // 2d TTL
        pipeline.expire(keys.nodeInstance, 7200);

        const results = await pipeline.exec();

        const hourlyUsage = results[0][1];
        const dailyUsage = results[1][1];

        const hourlyPercent = hourlyUsage / budget.hourly;
        const dailyPercent = dailyUsage / budget.daily;
        const maxPercent = Math.max(hourlyPercent, dailyPercent);

        // Check if we just crossed HARDCAP
        const wasUnderLimit = (hourlyUsage - cost) < budget.hourly;
        const nowOverLimit = hourlyUsage >= budget.hourly;

        if (wasUnderLimit && nowOverLimit && budget.canBlock) {
            logger.warn(`[HARDCAP] ${nodeType} just hit HARDCAP: ${hourlyUsage}/${budget.hourly}`);

            // Set blocked flag
            await redis.set(keys.blocked, '1', 'EX', 3600);
        }

        // Log at thresholds
        if (maxPercent >= budget.criticalThreshold) {
            logger.warn(`[HARDCAP] ${nodeType} CRITICAL: ${Math.round(maxPercent * 100)}% of budget`);
        } else if (maxPercent >= budget.alertThreshold && hourlyUsage % 1000 < cost) {
            logger.info(`[HARDCAP] ${nodeType}: ${Math.round(hourlyPercent * 100)}% hourly, ${Math.round(dailyPercent * 100)}% daily`);
        }

        return {
            allowed: !nowOverLimit || !budget.canBlock,
            cost,
            method,
            nodeType,
            usage: {
                hourly: { used: hourlyUsage, budget: budget.hourly, percent: Math.round(hourlyPercent * 100) },
                daily: { used: dailyUsage, budget: budget.daily, percent: Math.round(dailyPercent * 100) }
            },
            hardcapReached: nowOverLimit
        };

    } catch (e) {
        logger.debug(`[HARDCAP] Consume failed: ${e.message}`);
        return { allowed: true, cost, error: e.message };
    }
}

/**
 * Gate function - check HARDCAP before making RPC call
 *
 * Usage:
 *   const gate = await rpcGate('getTokenAccounts');
 *   if (!gate.allowed) {
 *     await sleep(gate.throttleMs);
 *     return cached_or_fallback_response;
 *   }
 *   // proceed with RPC call
 *
 * @param {string} method - RPC method to call
 * @param {string} nodeType - Node type (default: current)
 * @returns {Promise<Object>} Gate result with allowed, throttleMs, etc.
 */
async function rpcGate(method, nodeType = CURRENT_NODE_TYPE) {
    const cost = getCreditCost(method);
    const status = await checkHardcap(nodeType);

    if (!status.allowed) {
        return {
            allowed: false,
            reason: 'HARDCAP_REACHED',
            throttleMs: status.throttleMs,
            cost,
            method,
            ...status
        };
    }

    if (status.remaining < cost) {
        return {
            allowed: false,
            reason: 'INSUFFICIENT_CREDITS',
            throttleMs: status.throttleMs || 1000,
            cost,
            method,
            remaining: status.remaining,
            ...status
        };
    }

    // Apply throttle if approaching limits
    if (status.throttleMs > 0) {
        return {
            allowed: true,
            throttle: true,
            throttleMs: status.throttleMs,
            cost,
            method,
            ...status
        };
    }

    return {
        allowed: true,
        throttle: false,
        throttleMs: 0,
        cost,
        method,
        ...status
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6: STATUS AND MONITORING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get comprehensive status for all node types
 */
async function getAllNodeStatus() {
    const status = {};

    for (const nodeType of Object.values(NODE_TYPES)) {
        status[nodeType] = await checkHardcap(nodeType);
        status[nodeType].budget = NODE_BUDGETS[nodeType];
    }

    return {
        nodes: status,
        currentNode: {
            type: CURRENT_NODE_TYPE,
            id: CURRENT_NODE_ID,
            budget: CURRENT_NODE_BUDGET
        },
        globalBudget: {
            daily: GLOBAL_BUDGET.DAILY,
            hourly: GLOBAL_BUDGET.HOURLY
        },
        timestamp: Date.now()
    };
}

/**
 * Get status for current node
 */
async function getCurrentNodeStatus() {
    const status = await checkHardcap(CURRENT_NODE_TYPE);
    return {
        ...status,
        nodeId: CURRENT_NODE_ID,
        budget: CURRENT_NODE_BUDGET
    };
}

/**
 * Reset hardcap counters for a node type (admin only)
 */
async function resetNodeCounters(nodeType) {
    try {
        const redis = await getRedis();
        if (!redis) return { success: false, error: 'No Redis' };

        const pattern = `hardcap:${nodeType}:*`;
        const keys = await redis.keys(pattern);

        if (keys.length > 0) {
            await redis.del(...keys);
            logger.info(`[HARDCAP] Reset ${keys.length} counters for ${nodeType}`);
        }

        return { success: true, keysDeleted: keys.length };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7: INITIALIZATION LOGGING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Log HARDCAP configuration on startup
 */
function logHardcapConfig() {
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('RPC HARDCAP Configuration (φ-based, API-first)');
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info(`   Current Node: ${CURRENT_NODE_TYPE} (${CURRENT_NODE_ID})`);
    logger.info(`   Global Budget: ${GLOBAL_BUDGET.DAILY.toLocaleString()}/day, ${GLOBAL_BUDGET.HOURLY.toLocaleString()}/hour`);
    logger.info('');
    logger.info('   Per-Node HARDCAPS:');

    for (const [nodeType, budget] of Object.entries(NODE_BUDGETS)) {
        const marker = nodeType === CURRENT_NODE_TYPE ? ' <- YOU' : '';
        const blockable = budget.canBlock ? '[throttle]' : '[never-block]';
        logger.info(`   ${blockable} ${nodeType.padEnd(12)} ${budget.sharePercent.toString().padStart(5)}% -> ${budget.daily.toLocaleString().padStart(8)}/day, ${budget.hourly.toLocaleString().padStart(6)}/hour${marker}`);
    }

    logger.info('');
    logger.info('   [never-block] = API priority  [throttle] = Can be delayed');
    logger.info('═══════════════════════════════════════════════════════════════');
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
    // Node types
    NODE_TYPES,
    NODE_ALLOCATIONS,
    NODE_BUDGETS,

    // Current node context
    CURRENT_NODE_TYPE,
    CURRENT_NODE_ID,
    CURRENT_NODE_BUDGET,

    // Detection
    detectNodeType,
    getNodeId,

    // Core HARDCAP functions
    checkHardcap,
    consumeCredits,
    rpcGate,

    // Status and monitoring
    getAllNodeStatus,
    getCurrentNodeStatus,
    resetNodeCounters,

    // Initialization
    logHardcapConfig,

    // Re-export for convenience
    getCreditCost,
    PHI,
    PHI_POWERS
};
