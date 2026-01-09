/**
 * TOKEN POLLER SERVICE
 *
 * Manual index paradigm - replaces WebSocket listeners with polling.
 *
 * Why polling instead of WebSocket?
 * - WebSocket subscriptions (onLogs) consume credits continuously
 * - High-traffic programs (Raydium, Pump.fun) = massive credit burn
 * - Polling is cheaper: one REST call per interval vs continuous stream
 *
 * Architecture:
 * - Poll Raydium/Pump.fun programs every N seconds
 * - Fetch recent signatures via getSignaturesForAddress (REST)
 * - Track last processed signature per program
 * - Process only new transactions
 *
 * φ Configuration:
 * - Poll interval: 23.6 seconds (φ⁻³ × 100)
 * - Batch size: 38 signatures (≈ φ⁻² × 100)
 * - Retry delay: 6.18 seconds (φ⁻¹ × 10)
 *
 * @module tokenPoller
 */

'use strict';

const { PublicKey } = require('@solana/web3.js');
const { getSolanaConnection } = require('./solana');
const { getDB } = require('./database');
const { getClient: getRedis } = require('./redis');
const { indexTokenOnChain } = require('./indexer');
const logger = require('./logger');

// φ Constants for timing
const PHI = 1.618033988749895;
const PHI_INV = 1 / PHI;                      // 0.618...
const PHI_INV_SQ = 1 / (PHI * PHI);           // 0.382...
const PHI_INV_CUBED = 1 / (PHI * PHI * PHI);  // 0.236...

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const CONFIG = Object.freeze({
    // Programs to poll
    PROGRAMS: {
        RAYDIUM: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
        PUMP_FUN: new PublicKey('6EF8rrecthR5DkzonjNwu78hRvfCKubJ14M5uBEwF6P')
    },

    // φ-based timing (milliseconds)
    POLL_INTERVAL_MS: Math.round(PHI_INV_CUBED * 100 * 1000),  // ~23.6 seconds
    RETRY_DELAY_MS: Math.round(PHI_INV * 10 * 1000),           // ~6.18 seconds
    TX_WAIT_MS: 2000,                                           // Wait for TX indexing

    // Batch size per poll (φ⁻² × 100)
    BATCH_SIZE: Math.round(PHI_INV_SQ * 100),  // ~38 signatures

    // LRU cache size
    PROCESSED_CACHE_SIZE: 10000,
    CACHE_EVICT_COUNT: 2000
});

// System addresses to ignore
const IGNORED_MINTS = new Set([
    'So11111111111111111111111111111111111111112', // Wrapped SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // Raydium Authority
    '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium Authority
    'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1', // Pump Authority
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
    '11111111111111111111111111111111',             // System Program
    'SysvarRent111111111111111111111111111111111',  // Rent
]);

// Log patterns that indicate new pool creation
const INIT_PATTERNS = {
    RAYDIUM: ['InitializeInstruction2', 'initialize2', 'InitializeMint'],
    PUMP_FUN: ['Instruction: Create', 'Program log: Create', 'MintTo']
};

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════

const state = {
    // Last processed signature per program
    lastSignatures: {
        RAYDIUM: null,
        PUMP_FUN: null
    },
    // Processed signatures cache (LRU)
    processedSigs: new Set(),
    // Poller intervals
    pollIntervals: {},
    // Stats
    stats: {
        pollCount: 0,
        tokensFound: 0,
        lastPollTime: 0,
        errors: 0
    },
    // Running state
    isRunning: false
};

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Check if a mint should be ignored
 */
function isIgnored(mint) {
    if (!mint) return 'Null mint';
    const m = mint.toString().trim();
    if (IGNORED_MINTS.has(m)) return 'System address';
    if (m.length < 30 || m.length > 45) return 'Invalid length';
    return false;
}

/**
 * LRU-style cache eviction
 */
function evictProcessedCache() {
    if (state.processedSigs.size > CONFIG.PROCESSED_CACHE_SIZE) {
        let deleted = 0;
        for (const sig of state.processedSigs) {
            if (deleted >= CONFIG.CACHE_EVICT_COUNT) break;
            state.processedSigs.delete(sig);
            deleted++;
        }
        logger.debug(`[Poller] Cache evicted ${deleted} entries`);
    }
}

/**
 * Load last signatures from Redis
 */
async function loadLastSignatures() {
    const redis = getRedis();
    if (!redis) return;

    try {
        const raydiumSig = await redis.get('poller:last_sig:RAYDIUM');
        const pumpSig = await redis.get('poller:last_sig:PUMP_FUN');

        if (raydiumSig) state.lastSignatures.RAYDIUM = raydiumSig;
        if (pumpSig) state.lastSignatures.PUMP_FUN = pumpSig;

        logger.info('[Poller] Loaded last signatures from Redis');
    } catch (err) {
        logger.warn('[Poller] Failed to load last signatures:', err.message);
    }
}

/**
 * Save last signature to Redis
 */
async function saveLastSignature(program, signature) {
    const redis = getRedis();
    if (!redis) return;

    try {
        await redis.set(`poller:last_sig:${program}`, signature);
    } catch (err) {
        logger.warn('[Poller] Failed to save last signature:', err.message);
    }
}

// ═══════════════════════════════════════════════════════════════
// TRANSACTION PROCESSING
// ═══════════════════════════════════════════════════════════════

/**
 * Extract candidate mints from a transaction
 */
function extractMints(tx, source) {
    const candidateMints = new Set();

    // Strategy A: Post Token Balances (most reliable)
    if (tx.meta?.postTokenBalances?.length > 0) {
        tx.meta.postTokenBalances.forEach(bal => {
            if (bal.mint && !isIgnored(bal.mint)) {
                candidateMints.add(bal.mint);
            }
        });
    }

    // Strategy B: Inner Instructions (MintTo / InitializeMint)
    if (tx.meta?.innerInstructions) {
        tx.meta.innerInstructions.forEach(inner => {
            inner.instructions?.forEach(inst => {
                if (inst.program === 'spl-token' ||
                    inst.programId?.toString() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
                    if (inst.parsed?.type === 'initializeMint' || inst.parsed?.type === 'mintTo') {
                        const mint = inst.parsed.info.mint;
                        if (mint && !isIgnored(mint)) candidateMints.add(mint);
                    }
                }
            });
        });
    }

    // Strategy C: Account Keys (Pump.fun fallback only)
    if (candidateMints.size === 0 && source === 'PUMP_FUN') {
        const message = tx.transaction?.message;
        const keyList = message?.accountKeys?.staticAccountKeys || message?.accountKeys;
        if (Array.isArray(keyList)) {
            keyList.forEach((keyObj, index) => {
                if (index === 0) return; // Skip fee payer
                const pubkey = keyObj.pubkey?.toString() || keyObj.toString();
                if (pubkey && !isIgnored(pubkey)) {
                    candidateMints.add(pubkey);
                }
            });
        }
    }

    return candidateMints;
}

/**
 * Process a single transaction
 */
async function processTransaction(signature, connection, db, source) {
    if (state.processedSigs.has(signature)) return;
    state.processedSigs.add(signature);
    evictProcessedCache();

    try {
        // Wait for TX indexing
        await new Promise(r => setTimeout(r, CONFIG.TX_WAIT_MS));

        // Fetch transaction with retries
        let tx = null;
        for (let i = 0; i < 5; i++) {
            try {
                tx = await connection.getParsedTransaction(signature, {
                    maxSupportedTransactionVersion: 0,
                    commitment: 'confirmed'
                });
                if (tx && tx.meta && !tx.meta.err) break;
            } catch (_err) { /* retry */ }
            await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }

        if (!tx || !tx.meta || tx.meta.err) return;

        // Check if this is a pool initialization
        const logs = tx.meta.logMessages || [];
        const patterns = INIT_PATTERNS[source] || [];
        const isInit = patterns.some(p => logs.some(l => l.includes(p)));

        if (!isInit) return;

        // Extract candidate mints
        const candidateMints = extractMints(tx, source);
        if (candidateMints.size === 0) return;

        const redis = getRedis();

        for (const mint of candidateMints) {
            const ignoreReason = isIgnored(mint);
            if (ignoreReason) continue;

            // Check if already tracked
            const exists = await db.get('SELECT mint FROM tokens WHERE mint = $1', [mint]);
            if (exists) continue;

            logger.info(`✨ [${source}] New token discovered: ${mint}`);
            state.stats.tokensFound++;

            // Insert into database
            try {
                await db.run(`
                    INSERT INTO tokens (mint, name, symbol, timestamp, k_score, marketCap, hasCommunityUpdate, updated_at)
                    VALUES ($1, 'New Discovery', 'NEW', $2, 10, 0, FALSE, NOW())
                    ON CONFLICT (mint) DO NOTHING
                `, [mint, Date.now()]);
            } catch (dbErr) {
                logger.error(`[Poller] DB insert error for ${mint}: ${dbErr.message}`);
            }

            // Trigger indexer
            indexTokenOnChain(mint).catch(e =>
                logger.error(`[Poller] Indexer failed for ${mint}: ${e.message}`)
            );

            // Add to grower scanner queue
            if (redis) {
                try {
                    const data = JSON.stringify({ mint, addedAt: Date.now(), source });
                    await redis.sadd('pending_growers', data);
                } catch (redisErr) {
                    logger.warn(`[Poller] Redis queue error: ${redisErr.message}`);
                }
            }
        }
    } catch (err) {
        state.stats.errors++;
        if (!err.message.includes('429')) {
            logger.error(`[Poller] TX processing error: ${err.message}`);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// POLLING LOGIC
// ═══════════════════════════════════════════════════════════════

/**
 * Poll a single program for new transactions
 */
async function pollProgram(programName, programId, connection, db) {
    try {
        const options = {
            limit: CONFIG.BATCH_SIZE,
            commitment: 'confirmed'
        };

        // If we have a last signature, fetch signatures after it
        if (state.lastSignatures[programName]) {
            options.until = state.lastSignatures[programName];
        }

        // Fetch recent signatures (REST API - cheaper than WebSocket)
        const signatures = await connection.getSignaturesForAddress(programId, options);

        if (signatures.length === 0) return;

        // Update last signature (most recent first)
        const newestSig = signatures[0].signature;
        if (newestSig !== state.lastSignatures[programName]) {
            state.lastSignatures[programName] = newestSig;
            await saveLastSignature(programName, newestSig);
        }

        // Process new transactions (oldest first for proper ordering)
        const newSigs = signatures.reverse().filter(s => !state.processedSigs.has(s.signature));

        if (newSigs.length > 0) {
            logger.info(`[Poller] ${programName}: Processing ${newSigs.length} new transactions`);

            for (const sigInfo of newSigs) {
                if (sigInfo.err) continue; // Skip failed transactions
                await processTransaction(sigInfo.signature, connection, db, programName);
            }
        }
    } catch (err) {
        state.stats.errors++;
        if (err.message.includes('429')) {
            logger.warn(`[Poller] ${programName}: Rate limited, backing off...`);
            await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY_MS));
        } else {
            logger.error(`[Poller] ${programName} poll error: ${err.message}`);
        }
    }
}

/**
 * Run a single poll cycle
 */
async function pollCycle(connection, db) {
    state.stats.pollCount++;
    state.stats.lastPollTime = Date.now();

    // Poll Raydium
    await pollProgram('RAYDIUM', CONFIG.PROGRAMS.RAYDIUM, connection, db);

    // Small delay between programs to avoid rate limits
    await new Promise(r => setTimeout(r, 1000));

    // Poll Pump.fun
    await pollProgram('PUMP_FUN', CONFIG.PROGRAMS.PUMP_FUN, connection, db);

    // Write stats to Redis for API access
    const redis = getRedis();
    if (redis) {
        try {
            await redis.set('poller:stats', JSON.stringify({
                pollCount: state.stats.pollCount,
                tokensFound: state.stats.tokensFound,
                lastPollTime: state.stats.lastPollTime,
                errors: state.stats.errors,
                isRunning: state.isRunning,
                processedCount: state.processedSigs.size
            }));
        } catch (_err) { /* ignore redis errors */ }
    }
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

/**
 * Start the token poller
 *
 * Replaces WebSocket listeners with efficient polling.
 * Uses φ-based intervals for optimal timing.
 */
async function startTokenPoller() {
    if (state.isRunning) {
        logger.warn('[Poller] Already running');
        return;
    }

    const connection = getSolanaConnection();
    const db = getDB();
    const redis = getRedis();

    if (!redis) {
        logger.warn('[Poller] Redis not ready, retrying...');
        setTimeout(startTokenPoller, CONFIG.RETRY_DELAY_MS);
        return;
    }

    state.isRunning = true;
    logger.info('═══════════════════════════════════════════════════════════════');
    logger.info('[Poller] Starting Token Poller (Manual Index Paradigm)');
    logger.info(`[Poller] Poll interval: ${CONFIG.POLL_INTERVAL_MS}ms (φ⁻³ × 100)`);
    logger.info(`[Poller] Batch size: ${CONFIG.BATCH_SIZE} signatures`);
    logger.info(`[Poller] Endpoint: ${connection.rpcEndpoint}`);
    logger.info('═══════════════════════════════════════════════════════════════');

    // Load last processed signatures
    await loadLastSignatures();

    // Initial poll
    try {
        await pollCycle(connection, db);
    } catch (err) {
        logger.error('[Poller] Initial poll failed:', err.message);
    }

    // Start polling loop
    state.pollIntervals.main = setInterval(async () => {
        try {
            await pollCycle(connection, db);
        } catch (err) {
            state.stats.errors++;
            logger.error('[Poller] Poll cycle error:', err.message);
        }
    }, CONFIG.POLL_INTERVAL_MS);

    // Status logger (every 5 minutes)
    state.pollIntervals.status = setInterval(() => {
        const timeSincePoll = Math.round((Date.now() - state.stats.lastPollTime) / 1000);
        logger.info(`💓 [Poller] Status: ${state.stats.pollCount} polls, ${state.stats.tokensFound} tokens found, ${state.stats.errors} errors. Last poll: ${timeSincePoll}s ago`);
    }, 5 * 60 * 1000);
}

/**
 * Stop the token poller
 */
function stopTokenPoller() {
    if (!state.isRunning) return;

    Object.values(state.pollIntervals).forEach(interval => {
        if (interval) clearInterval(interval);
    });
    state.pollIntervals = {};
    state.isRunning = false;

    logger.info('[Poller] Stopped');
}

/**
 * Get poller statistics
 */
function getPollerStats() {
    return {
        ...state.stats,
        isRunning: state.isRunning,
        lastSignatures: state.lastSignatures,
        processedCount: state.processedSigs.size,
        config: {
            pollIntervalMs: CONFIG.POLL_INTERVAL_MS,
            batchSize: CONFIG.BATCH_SIZE,
            phi: PHI
        }
    };
}

/**
 * Force a poll cycle (for manual triggering)
 */
async function forcePoll() {
    if (!state.isRunning) {
        throw new Error('Poller not running');
    }

    const connection = getSolanaConnection();
    const db = getDB();

    logger.info('[Poller] Force poll triggered');
    await pollCycle(connection, db);
}

module.exports = {
    startTokenPoller,
    stopTokenPoller,
    getPollerStats,
    forcePoll,
    CONFIG
};
