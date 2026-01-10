/**
 * Token Queue Service - Hybrid C+D Design
 *
 * φ-aligned self-sustaining token discovery:
 *
 * STAGE 1: PENDING SET (TTL 30min)
 *   - New mints detected via webhook → add to pending
 *   - No RPC calls, just track mint address
 *   - Auto-expire if no trade within TTL (noise filtering)
 *
 * STAGE 2: ACTIVE QUEUE (trade-triggered)
 *   - SWAP detected → promote from pending to active queue
 *   - Only tokens with real activity get processed
 *   - Fetch metadata + add to DB
 *
 * "Don't trust, verify" - but efficiently.
 */

const { getClient } = require('./redis');
const { getDB } = require('./database');
const { fetchTokenMetadata } = require('../utils/metaplex');
const { getSolanaConnection } = require('./solana');
const { PublicKey } = require('@solana/web3.js');
const logger = require('./logger');

// Redis keys
const PENDING_KEY = 'holdex:pending_mints';      // Stage 1: Waiting for trade
const PENDING_DATA_KEY = 'holdex:pending_data';  // Metadata for pending mints
const QUEUE_KEY = 'holdex:new_token_queue';      // Stage 2: Active queue (promoted)
const PROCESSING_KEY = 'holdex:processing_tokens';
const FAILED_KEY = 'holdex:failed_tokens';

// Configuration - φ aligned
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;
const PROCESS_INTERVAL_MS = 2000;
const BATCH_SIZE = 5;                    // Increased - only processing active tokens now
const PENDING_TTL_MS = 30 * 60 * 1000;   // 30 min TTL for pending (φ⁻¹ × 48 min ≈ 30 min)
const CLEANUP_INTERVAL_MS = 60000;       // Cleanup every 60s

let isProcessing = false;
let processorInterval = null;
let cleanupInterval = null;

// ============================================
// STAGE 1: PENDING SET (Discovery)
// ============================================

/**
 * Add a newly discovered token to the pending set
 * Called when TOKEN_MINT or CREATE_POOL webhook fires
 * NO metadata fetch - just track the mint address
 *
 * @param {string} mint - Token mint address
 * @param {string} source - Discovery source (e.g., 'Raydium', 'Pump.fun')
 */
async function addToPending(mint, source = 'unknown') {
    const redis = getClient();
    if (!redis) {
        logger.debug(`[TokenQueue] Redis not available, cannot add pending ${mint.slice(0, 8)}`);
        return false;
    }

    try {
        // Check if already pending, queued, or in database
        const [inPending, inQueue, inDb] = await Promise.all([
            redis.sismember(PENDING_KEY, mint),
            redis.sismember(QUEUE_KEY, mint),
            getDB().get('SELECT mint FROM tokens WHERE mint = $1', [mint])
        ]);

        if (inPending || inQueue || inDb) {
            return false; // Already tracked
        }

        // Add to pending set with timestamp
        const pendingData = JSON.stringify({
            mint,
            source,
            discoveredAt: Date.now(),
            promoted: false
        });

        await redis.sadd(PENDING_KEY, mint);
        await redis.hset(PENDING_DATA_KEY, mint, pendingData);

        logger.debug(`👁️ [Pending] Discovered ${mint.slice(0, 8)} from ${source}`);
        processorStats.discovered++;
        return true;
    } catch (err) {
        logger.error(`[TokenQueue] Failed to add pending ${mint.slice(0, 8)}: ${err.message}`);
        return false;
    }
}

/**
 * Promote a token from pending to active queue
 * Called when SWAP webhook fires for a pending token
 * This is the trade-triggered activation
 *
 * @param {string} mint - Token mint address
 * @param {string} trigger - What triggered promotion (e.g., 'swap', 'lp')
 */
async function promoteToQueue(mint, trigger = 'swap') {
    const redis = getClient();
    if (!redis) return false;

    try {
        // Check if in pending
        const inPending = await redis.sismember(PENDING_KEY, mint);

        // Also check if already in queue or DB
        const [inQueue, inDb] = await Promise.all([
            redis.sismember(QUEUE_KEY, mint),
            getDB().get('SELECT mint FROM tokens WHERE mint = $1', [mint])
        ]);

        if (inQueue || inDb) {
            // Already promoted or exists - clean up pending if present
            if (inPending) {
                await redis.srem(PENDING_KEY, mint);
                await redis.hdel(PENDING_DATA_KEY, mint);
            }
            return false;
        }

        // Get pending data for source info
        let source = 'unknown';
        const rawData = await redis.hget(PENDING_DATA_KEY, mint);
        if (rawData) {
            const data = JSON.parse(rawData);
            source = data.source || 'unknown';
        }

        // Move from pending to active queue
        if (inPending) {
            await redis.srem(PENDING_KEY, mint);
            await redis.hdel(PENDING_DATA_KEY, mint);
        }

        // Add to active queue
        const queueData = JSON.stringify({
            mint,
            source,
            trigger,
            queuedAt: Date.now(),
            retries: 0
        });

        await redis.sadd(QUEUE_KEY, mint);
        await redis.hset('holdex:queue_data', mint, queueData);

        logger.info(`🚀 [Promoted] ${mint.slice(0, 8)} from ${source} (trigger: ${trigger})`);
        processorStats.promoted++;
        return true;
    } catch (err) {
        logger.error(`[TokenQueue] Failed to promote ${mint.slice(0, 8)}: ${err.message}`);
        return false;
    }
}

/**
 * Legacy function - now routes to appropriate stage
 * Kept for backwards compatibility with existing webhook code
 */
async function queueNewToken(mint, source = 'unknown') {
    // For backwards compatibility, add to pending
    // Promotion happens on SWAP
    return addToPending(mint, source);
}

// ============================================
// STAGE 2: ACTIVE QUEUE PROCESSING
// ============================================

/**
 * Process a single token from the active queue
 */
async function processToken(mint) {
    const redis = getClient();
    if (!redis) {
        logger.warn(`[TokenQueue] Cannot process ${mint.slice(0, 8)} - Redis not available`);
        return false;
    }

    let db, connection;
    try {
        db = getDB();
        connection = getSolanaConnection();
    } catch (initErr) {
        logger.error(`[TokenQueue] Service init failed for ${mint.slice(0, 8)}: ${initErr.message}`);
        return false;
    }

    if (!db) {
        logger.warn(`[TokenQueue] Cannot process ${mint.slice(0, 8)} - DB not available`);
        return false;
    }

    try {
        // Get queue data
        const rawData = await redis.hget('holdex:queue_data', mint);
        const data = rawData ? JSON.parse(rawData) : { mint, retries: 0, source: 'unknown' };

        // Move to processing set
        await redis.smove(QUEUE_KEY, PROCESSING_KEY, mint);

        logger.info(`🔄 [Processing] ${mint.slice(0, 8)} (attempt ${data.retries + 1}/${MAX_RETRIES})`);
        processorStats.lastToken = mint.slice(0, 8);

        // Fetch metadata with timeout (10s max)
        const METADATA_TIMEOUT = 10000;
        let meta = null;
        try {
            const metaPromise = fetchTokenMetadata(mint);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Metadata fetch timeout')), METADATA_TIMEOUT)
            );
            meta = await Promise.race([metaPromise, timeoutPromise]);
        } catch (metaErr) {
            logger.warn(`[TokenQueue] Metadata error for ${mint.slice(0, 8)}: ${metaErr.message}`);
            processorStats.metadataErrors++;
            // Move back to queue for retry
            await redis.smove(PROCESSING_KEY, QUEUE_KEY, mint);
            data.retries++;
            await redis.hset('holdex:queue_data', mint, JSON.stringify(data));
            return false;
        }

        // Check if we got real metadata (not placeholder)
        const hasRealName = meta && meta.name && meta.name !== 'Unknown' && meta.name !== 'New Discovery' && meta.name.length > 0;
        const hasRealSymbol = meta && meta.symbol && meta.symbol !== 'UNK' && meta.symbol !== 'UNKNOWN' && meta.symbol !== 'NEW';

        if (!hasRealName || !hasRealSymbol) {
            // Metadata not ready - retry or fail
            data.retries++;

            if (data.retries >= MAX_RETRIES) {
                logger.warn(`⚠️ [TokenQueue] Max retries for ${mint.slice(0, 8)}, moving to failed`);
                await redis.smove(PROCESSING_KEY, FAILED_KEY, mint);
                await redis.hset('holdex:queue_data', mint, JSON.stringify({ ...data, failedAt: Date.now(), reason: 'metadata_unavailable' }));
                processorStats.failed++;
                return false;
            }

            logger.info(`⏳ [TokenQueue] Metadata not ready for ${mint.slice(0, 8)}, retry (${data.retries}/${MAX_RETRIES})`);
            await redis.smove(PROCESSING_KEY, QUEUE_KEY, mint);
            await redis.hset('holdex:queue_data', mint, JSON.stringify(data));
            return false;
        }

        // Fetch supply info
        let supply = '1000000000';
        let decimals = 9;
        try {
            const supplyInfo = await connection.getTokenSupply(new PublicKey(mint));
            supply = supplyInfo.value.amount;
            decimals = supplyInfo.value.decimals;
        } catch (e) {
            logger.warn(`[TokenQueue] Failed to fetch supply for ${mint.slice(0, 8)}: ${e.message}`);
        }

        // Insert into database with REAL metadata
        await db.run(`
            INSERT INTO tokens (mint, name, symbol, image, supply, decimals, timestamp, k_score, hasCommunityUpdate, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 0, FALSE, NOW())
            ON CONFLICT(mint) DO UPDATE SET
                name = CASE WHEN tokens.name IN ('Unknown', 'New Discovery', '') OR tokens.name IS NULL THEN EXCLUDED.name ELSE tokens.name END,
                symbol = CASE WHEN tokens.symbol IN ('UNKNOWN', 'UNK', 'NEW', '') OR tokens.symbol IS NULL THEN EXCLUDED.symbol ELSE tokens.symbol END,
                image = CASE WHEN tokens.image IS NULL OR tokens.image = '' THEN EXCLUDED.image ELSE tokens.image END,
                supply = COALESCE(EXCLUDED.supply, tokens.supply),
                decimals = COALESCE(EXCLUDED.decimals, tokens.decimals),
                updated_at = NOW()
        `, [mint, meta.name, meta.symbol, meta.image, supply, decimals, Date.now()]);

        // Cleanup queue data
        await redis.srem(PROCESSING_KEY, mint);
        await redis.hdel('holdex:queue_data', mint);

        logger.info(`✅ [TokenQueue] Added ${meta.name} (${meta.symbol}) - ${mint.slice(0, 8)}`);
        processorStats.tokensProcessed++;

        // Trigger full indexing (pools, market data) in background
        const { indexTokenOnChain } = require('./indexer');
        indexTokenOnChain(mint).catch(e => logger.warn(`[TokenQueue] Background indexing failed for ${mint.slice(0, 8)}: ${e.message}`));

        return true;
    } catch (err) {
        logger.error(`[TokenQueue] Error processing ${mint.slice(0, 8)}: ${err.message}`);
        await redis.smove(PROCESSING_KEY, QUEUE_KEY, mint).catch(() => {});
        return false;
    }
}

/**
 * Process tokens from the active queue
 */
async function processQueue() {
    if (isProcessing) {
        logger.debug('[TokenQueue] Skipping - already processing');
        return;
    }
    isProcessing = true;

    const redis = getClient();
    if (!redis) {
        isProcessing = false;
        return;
    }

    try {
        const tokens = await redis.srandmember(QUEUE_KEY, BATCH_SIZE);

        if (!tokens || tokens.length === 0) {
            isProcessing = false;
            return;
        }

        logger.info(`📋 [Queue] Processing ${tokens.length} active token(s)`);

        await Promise.all(tokens.map(async (mint) => {
            try {
                await processToken(mint);
            } catch (tokenErr) {
                logger.error(`[TokenQueue] Token error ${mint.slice(0, 8)}: ${tokenErr.message}`);
            }
        }));

        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    } catch (err) {
        logger.error(`[TokenQueue] Queue processing error: ${err.message}`);
    } finally {
        isProcessing = false;
    }
}

// ============================================
// TTL CLEANUP (Self-Sustaining)
// ============================================

/**
 * Cleanup expired pending tokens
 * Called automatically every CLEANUP_INTERVAL_MS
 * This is the self-sustaining noise filter
 */
async function cleanupExpiredPending() {
    const redis = getClient();
    if (!redis) return;

    try {
        const now = Date.now();
        const pendingMints = await redis.smembers(PENDING_KEY);
        let expired = 0;

        for (const mint of pendingMints) {
            const rawData = await redis.hget(PENDING_DATA_KEY, mint);
            if (!rawData) {
                // Orphan - remove
                await redis.srem(PENDING_KEY, mint);
                expired++;
                continue;
            }

            const data = JSON.parse(rawData);
            const age = now - (data.discoveredAt || 0);

            if (age > PENDING_TTL_MS) {
                // Expired - no trade within TTL = noise
                await redis.srem(PENDING_KEY, mint);
                await redis.hdel(PENDING_DATA_KEY, mint);
                expired++;
            }
        }

        if (expired > 0) {
            logger.info(`🧹 [Cleanup] Expired ${expired} pending tokens (no trade within ${PENDING_TTL_MS / 60000}min)`);
            processorStats.expired += expired;
        }
    } catch (err) {
        logger.error(`[Cleanup] Error: ${err.message}`);
    }
}

// ============================================
// PROCESSOR STATS
// ============================================

const processorStats = {
    started: false,
    lastRun: 0,
    runsCount: 0,
    discovered: 0,      // Added to pending
    promoted: 0,        // Promoted to queue (trade detected)
    tokensProcessed: 0, // Successfully added to DB
    metadataErrors: 0,
    failed: 0,
    expired: 0,         // TTL expired (noise filtered)
    lastToken: null,
    errors: []
};

function getProcessorStats() {
    return {
        ...processorStats,
        intervalActive: !!processorInterval,
        cleanupActive: !!cleanupInterval,
        isProcessing,
        efficiency: processorStats.discovered > 0
            ? ((processorStats.tokensProcessed / processorStats.discovered) * 100).toFixed(1) + '%'
            : 'N/A'
    };
}

// ============================================
// LIFECYCLE
// ============================================

function startQueueProcessor() {
    if (processorInterval) {
        logger.warn('[TokenQueue] Processor already running');
        return;
    }

    logger.info('🚀 [TokenQueue] Starting hybrid C+D processor (trade-triggered + TTL)');
    processorStats.started = true;

    // Queue processor
    processorInterval = setInterval(() => {
        processorStats.runsCount++;
        processorStats.lastRun = Date.now();
        processQueue().catch(err => {
            logger.error(`[TokenQueue] Interval error: ${err.message}`);
            processorStats.errors.push({ time: Date.now(), error: err.message });
            if (processorStats.errors.length > 10) processorStats.errors.shift();
        });
    }, PROCESS_INTERVAL_MS);

    // TTL cleanup processor (self-sustaining)
    cleanupInterval = setInterval(() => {
        cleanupExpiredPending().catch(err => {
            logger.error(`[Cleanup] Interval error: ${err.message}`);
        });
    }, CLEANUP_INTERVAL_MS);

    // Run immediately
    processQueue().catch(err => logger.error(`[TokenQueue] Initial run error: ${err.message}`));
    cleanupExpiredPending().catch(err => logger.error(`[Cleanup] Initial run error: ${err.message}`));
}

function stopQueueProcessor() {
    if (processorInterval) {
        clearInterval(processorInterval);
        processorInterval = null;
    }
    if (cleanupInterval) {
        clearInterval(cleanupInterval);
        cleanupInterval = null;
    }
    logger.info('🛑 [TokenQueue] Processor stopped');
}

async function getQueueStats() {
    const redis = getClient();
    if (!redis) return null;

    const [pending, queued, processing, failed] = await Promise.all([
        redis.scard(PENDING_KEY),
        redis.scard(QUEUE_KEY),
        redis.scard(PROCESSING_KEY),
        redis.scard(FAILED_KEY)
    ]);

    return {
        pending,    // Stage 1: Waiting for trade
        queued,     // Stage 2: Active (trade detected)
        processing,
        failed,
        total: pending + queued + processing
    };
}

async function retryFailedTokens() {
    const redis = getClient();
    if (!redis) return 0;

    const failed = await redis.smembers(FAILED_KEY);
    let retried = 0;

    for (const mint of failed) {
        const rawData = await redis.hget('holdex:queue_data', mint);
        if (rawData) {
            const data = JSON.parse(rawData);
            data.retries = 0;
            await redis.hset('holdex:queue_data', mint, JSON.stringify(data));
        }
        await redis.smove(FAILED_KEY, QUEUE_KEY, mint);
        retried++;
    }

    logger.info(`🔄 [TokenQueue] Retried ${retried} failed tokens`);
    return retried;
}

module.exports = {
    // Stage 1: Discovery
    addToPending,

    // Stage 2: Promotion (trade-triggered)
    promoteToQueue,

    // Legacy (backwards compatible)
    queueNewToken,

    // Processing
    processQueue,
    startQueueProcessor,
    stopQueueProcessor,

    // Stats
    getQueueStats,
    getProcessorStats,

    // Maintenance
    retryFailedTokens,
    cleanupExpiredPending
};
