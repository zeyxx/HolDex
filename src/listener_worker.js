/**
 * HolDex Listener Worker - Queue-Based K-Score Processor
 *
 * ARCHITECTURE FIX: Replaced continuous runKScoreLoop() with queue-based processing
 * - Old: Loop ALL tokens continuously = MASSIVE RPC burn
 * - New: Process ONLY queued tokens with 5min cooldown = 90%+ savings
 *
 * Queue sources:
 * - Helius webhooks (significant trading activity)
 * - Manual admin refresh requests
 * - Token verification status changes
 *
 * Philosophy: "Pay for work, not for loops"
 */

console.log("🎧 LISTENER WORKER LAUNCHING...");

require('dotenv').config();

// Force SERVICE_TYPE for proper HARDCAP tracking
process.env.SERVICE_TYPE = 'listener';

const { initDB, getDB } = require('./services/database');
const { initRedis, getClient } = require('./services/redis');
const logger = require('./services/logger');

// Try to load rpcHardcap (our φ-based system)
let logHardcapConfig = () => {};
try {
    const rpcHardcap = require('./services/rpcHardcap');
    logHardcapConfig = rpcHardcap.logHardcapConfig || (() => {});
} catch (_e) {
    // rpcHardcap not available
}

// Log HARDCAP config on startup
logger.info(`   SERVICE_TYPE: ${process.env.SERVICE_TYPE}`);
logHardcapConfig();

// Queue keys
const KSCORE_RECALC_QUEUE = 'kscore:recalc_queue';

// Processing settings - φ-optimized
const RECALC_BATCH_SIZE = 5;           // Process 5 tokens per batch
const RECALC_INTERVAL_MS = 30000;      // 30 seconds between batches
const RECALC_COOLDOWN_MS = 300000;     // 5 min cooldown per token (prevents spam)

// Track processing state
let isRunning = false;
let recalcInterval = null;

// GLOBAL ERROR HANDLERS
process.on('uncaughtException', (err) => {
    logger.error(`UNCAUGHT EXCEPTION: ${err.message}`);
    logger.error(err.stack);
});

process.on('unhandledRejection', (reason, _promise) => {
    logger.error(`UNHANDLED REJECTION: ${reason}`);
});

// Attempt to load Indexer
let indexerService = null;
try {
    indexerService = require('./indexer');
} catch (_e) {
    logger.warn("ℹ️ Listener Worker: Could not load './indexer' module. Skipping indexer start.");
}

/**
 * Queue a token for K-Score recalculation
 * Called by webhook handler when significant activity is detected
 * @param {string} mint - Token mint address
 * @param {Object} options - Options
 * @param {boolean} options.priority - If true, bypasses cooldown
 * @param {string} options.reason - Reason for recalc (for logging)
 * @returns {Promise<boolean>} - True if queued successfully
 */
async function queueKScoreRecalc(mint, options = {}) {
    const redis = getClient();
    if (!redis) {
        logger.debug('[KScoreQueue] Redis unavailable, skipping queue');
        return false;
    }

    const { priority = false, reason = 'activity' } = options;

    try {
        // Validate mint
        if (!mint || typeof mint !== 'string' || mint.length < 32) {
            return false;
        }

        // Check cooldown unless priority
        if (!priority) {
            const lastRecalc = await redis.get(`kscore:last_recalc:${mint}`);
            if (lastRecalc && Date.now() - parseInt(lastRecalc, 10) < RECALC_COOLDOWN_MS) {
                logger.debug(`[KScoreQueue] ${mint.slice(0, 8)} in cooldown, skipping`);
                return false;
            }
        }

        // Check if already in queue
        const score = await redis.zscore(KSCORE_RECALC_QUEUE, mint);
        if (score !== null) {
            logger.debug(`[KScoreQueue] ${mint.slice(0, 8)} already in queue`);
            return false;
        }

        // Add to queue with timestamp score (lower = older = processed first)
        // Priority items get score 0 to be processed first
        const queueScore = priority ? 0 : Date.now();
        await redis.zadd(KSCORE_RECALC_QUEUE, queueScore, mint);

        logger.debug(`[KScoreQueue] Queued ${mint.slice(0, 8)} (${reason}${priority ? ', priority' : ''})`);
        return true;
    } catch (e) {
        logger.error(`[KScoreQueue] Failed to queue ${mint}: ${e.message}`);
        return false;
    }
}

/**
 * Process K-Score recalculation queue
 * Runs on interval, processes batch of tokens
 */
async function processKScoreQueue() {
    const redis = getClient();
    const db = getDB();
    if (!redis || !db) return;

    try {
        // Get oldest items from queue (ZPOPMIN for atomic pop)
        const items = await redis.zpopmin(KSCORE_RECALC_QUEUE, RECALC_BATCH_SIZE);
        if (!items || items.length === 0) return;

        // Items come as [member, score, member, score, ...]
        const mints = [];
        for (let i = 0; i < items.length; i += 2) {
            mints.push(items[i]);
        }

        if (mints.length === 0) return;

        logger.info(`[KScoreQueue] Processing ${mints.length} tokens for K-Score recalc`);

        // Load kScoreUpdater lazily to avoid circular deps
        const { updateSingleToken } = require('./tasks/kScoreUpdater');

        // Process sequentially to respect RPC limits
        let successful = 0;
        let failed = 0;

        for (const mint of mints) {
            try {
                // Mark as processing
                await redis.set(`kscore:processing:${mint}`, Date.now(), 'EX', 300);

                // Get token data
                const token = await db.get('SELECT * FROM tokens WHERE mint = $1', [mint]);
                if (!token) {
                    logger.debug(`[KScoreQueue] Token not found: ${mint.slice(0, 8)}`);
                    failed++;
                    continue;
                }

                // Only recalc verified tokens
                if (!token.hasCommunityUpdate) {
                    logger.debug(`[KScoreQueue] Skipping unverified token: ${mint.slice(0, 8)}`);
                    continue;
                }

                // Recalculate K-Score using our φ-optimized function
                await updateSingleToken({ db, broadcast: () => {} }, mint);

                // Update cooldown timestamp
                await redis.set(`kscore:last_recalc:${mint}`, Date.now(), 'EX', Math.floor(RECALC_COOLDOWN_MS / 1000));

                logger.info(`[KScoreQueue] ✅ Recalculated K-Score for ${token.symbol || mint.slice(0, 8)}`);
                successful++;

                // Small delay between tokens to prevent RPC burst
                await new Promise(r => setTimeout(r, 1000));

            } catch (e) {
                logger.error(`[KScoreQueue] Failed to recalc ${mint.slice(0, 8)}: ${e.message}`);
                failed++;
            } finally {
                // Clear processing flag
                await redis.del(`kscore:processing:${mint}`);
            }
        }

        // Log results
        if (failed > 0) {
            logger.warn(`[KScoreQueue] Batch complete: ${successful} success, ${failed} failed`);
        } else if (successful > 0) {
            logger.info(`[KScoreQueue] Batch complete: ${successful} tokens updated`);
        }

    } catch (e) {
        logger.error(`[KScoreQueue] Queue processing error: ${e.message}`);
    }
}

/**
 * Get queue stats for health checks
 */
async function getQueueStats() {
    const redis = getClient();
    if (!redis) return { available: false };

    try {
        const queueSize = await redis.zcard(KSCORE_RECALC_QUEUE);
        return {
            available: true,
            recalcQueueSize: queueSize,
            isRunning,
            config: {
                batchSize: RECALC_BATCH_SIZE,
                intervalMs: RECALC_INTERVAL_MS,
                cooldownMs: RECALC_COOLDOWN_MS
            }
        };
    } catch (_e) {
        return { available: false };
    }
}

/**
 * Main startup function
 */
async function startListenerWorker() {
    logger.info("🎧 LISTENER WORKER: Initializing...");

    try {
        // 1. Init Database
        await initDB();
        const db = getDB();
        logger.info("✅ Database Ready");

        // 2. Init Redis
        await initRedis();
        const redis = getClient();
        if (!redis) {
            logger.error("❌ Redis required for listener worker");
            process.exit(1);
        }
        logger.info("✅ Redis Ready");

        // 3. Start Indexer (Optional)
        if (indexerService && typeof indexerService.start === 'function') {
            logger.info("📊 LISTENER: Starting Token Indexer...");
            indexerService.start();
        }

        // 4. Token Discovery - HANDLED BY HELIUS WEBHOOKS
        logger.info("📡 LISTENER: Token discovery via Helius webhooks (passive mode)");
        logger.info("   → Endpoint: POST /webhook/new-tokens");
        logger.info("   → Events: CREATE_POOL, TOKEN_MINT, SWAP");

        // 5. Start K-Score recalc queue processor (QUEUE-BASED, NOT CONTINUOUS LOOP)
        isRunning = true;
        recalcInterval = setInterval(processKScoreQueue, RECALC_INTERVAL_MS);
        logger.info(`✅ K-Score Queue Processor Started`);

        // Run initial processing
        await processKScoreQueue();

        // 6. Memory monitoring
        setInterval(() => {
            const mem = process.memoryUsage();
            logger.debug(`💓 Listener | RSS: ${Math.round(mem.rss / 1024 / 1024)}MB | Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}MB`);
        }, 60000);

        logger.info("=".repeat(50));
        logger.info("🎧 LISTENER WORKER ACTIVE (Queue-Based)");
        logger.info("   Mode: Queue-based processing (NOT continuous loop)");
        logger.info(`   Batch Size: ${RECALC_BATCH_SIZE} tokens`);
        logger.info(`   Interval: ${RECALC_INTERVAL_MS / 1000}s`);
        logger.info(`   Cooldown: ${RECALC_COOLDOWN_MS / 1000}s per token`);
        logger.info("   RPC Savings: ~90% vs continuous loop");
        logger.info("=".repeat(50));

    } catch (err) {
        logger.error(`LISTENER STARTUP FAILED: ${err.message}`);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    logger.info("🎧 LISTENER WORKER: Shutting down...");
    isRunning = false;
    if (recalcInterval) clearInterval(recalcInterval);
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info("🎧 LISTENER WORKER: Shutting down...");
    isRunning = false;
    if (recalcInterval) clearInterval(recalcInterval);
    process.exit(0);
});

// Start
startListenerWorker();

// Export for use by webhooks and other modules
module.exports = {
    queueKScoreRecalc,
    getQueueStats,
    KSCORE_RECALC_QUEUE,
    RECALC_COOLDOWN_MS
};
