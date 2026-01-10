/**
 * P4: Global Helius Rate Limiter
 *
 * Redis-based sliding window rate limiter for ALL Helius API calls
 * Shared across all workers (API, calculator, listener, background)
 *
 * LIMIT: 50 requests per second (hard cap)
 * BEHAVIOR: Waits up to 5s for slot, then fails open
 */

const { getRedis } = require('./redis');
const logger = require('./logger');

// Configuration
const GLOBAL_RATE_LIMIT = 50; // requests per second
const GLOBAL_RATE_LIMIT_WINDOW_MS = 1000; // 1 second window
const GLOBAL_RATE_LIMIT_KEY = 'helius:rate:global';
const GLOBAL_RATE_LIMIT_MAX_WAIT_MS = 5000; // Max 5s wait before failing

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Check and enforce global rate limit using Redis sliding window
 * Returns true if request is allowed, false if should wait
 *
 * Uses Redis INCR + EXPIRE for atomic sliding window
 * @returns {Promise<{allowed: boolean, waitMs: number, current: number}>}
 */
async function checkGlobalRateLimit() {
    const redis = getRedis();
    if (!redis) {
        // No Redis = no global limit, fall back to in-memory
        return { allowed: true, waitMs: 0, current: 0 };
    }

    try {
        const now = Date.now();
        const windowKey = `${GLOBAL_RATE_LIMIT_KEY}:${Math.floor(now / GLOBAL_RATE_LIMIT_WINDOW_MS)}`;

        // Atomic increment + get count
        const pipeline = redis.pipeline();
        pipeline.incr(windowKey);
        pipeline.pexpire(windowKey, GLOBAL_RATE_LIMIT_WINDOW_MS * 2); // TTL = 2 windows
        const results = await pipeline.exec();

        const currentCount = results[0][1]; // [[null, count], [null, 1]]

        if (currentCount <= GLOBAL_RATE_LIMIT) {
            return { allowed: true, waitMs: 0, current: currentCount };
        }

        // Over limit - calculate wait time until next window
        const windowStart = Math.floor(now / GLOBAL_RATE_LIMIT_WINDOW_MS) * GLOBAL_RATE_LIMIT_WINDOW_MS;
        const windowEnd = windowStart + GLOBAL_RATE_LIMIT_WINDOW_MS;
        const waitMs = Math.max(10, windowEnd - now + 10); // +10ms buffer

        // Decrement since we're not using this slot
        await redis.decr(windowKey);

        return { allowed: false, waitMs, current: currentCount };
    } catch (e) {
        logger.debug(`[GlobalRateLimit] Redis error: ${e.message}`);
        return { allowed: true, waitMs: 0, current: 0 }; // Fail open
    }
}

/**
 * Wait for global rate limit with backoff
 * Call this before any Helius API call
 * @returns {Promise<void>}
 */
async function waitForRateLimit() {
    let totalWait = 0;

    while (totalWait < GLOBAL_RATE_LIMIT_MAX_WAIT_MS) {
        const check = await checkGlobalRateLimit();

        if (check.allowed) {
            if (totalWait > 0) {
                logger.debug(`[GlobalRateLimit] Resumed after ${totalWait}ms wait`);
            }
            return;
        }

        // Log only first wait per request
        if (totalWait === 0) {
            logger.warn(`[GlobalRateLimit] At limit (${check.current}/${GLOBAL_RATE_LIMIT} req/s), waiting ${check.waitMs}ms`);
        }

        await sleep(check.waitMs);
        totalWait += check.waitMs;
    }

    // Exceeded max wait - log and proceed anyway (fail open)
    logger.error(`[GlobalRateLimit] Max wait ${GLOBAL_RATE_LIMIT_MAX_WAIT_MS}ms exceeded, proceeding anyway`);
}

/**
 * Get current rate limit stats
 * @returns {Promise<{current: number, limit: number, percentUsed: number}>}
 */
async function getRateLimitStats() {
    const redis = getRedis();
    if (!redis) {
        return { current: 0, limit: GLOBAL_RATE_LIMIT, percentUsed: 0 };
    }

    try {
        const now = Date.now();
        const windowKey = `${GLOBAL_RATE_LIMIT_KEY}:${Math.floor(now / GLOBAL_RATE_LIMIT_WINDOW_MS)}`;
        const current = parseInt(await redis.get(windowKey) || '0');

        return {
            current,
            limit: GLOBAL_RATE_LIMIT,
            percentUsed: Math.round((current / GLOBAL_RATE_LIMIT) * 100)
        };
    } catch (_e) {
        return { current: 0, limit: GLOBAL_RATE_LIMIT, percentUsed: 0 };
    }
}

module.exports = {
    waitForRateLimit,
    checkGlobalRateLimit,
    getRateLimitStats,
    GLOBAL_RATE_LIMIT
};
