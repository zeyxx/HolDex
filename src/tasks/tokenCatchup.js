/**
 * Token Catchup Service
 *
 * $asdfasdfa Philosophy: "Don't trust, verify"
 *
 * Webhooks can fail, miss events, or have downtime.
 * This service periodically polls external sources to catch
 * any tokens we might have missed.
 *
 * Sources:
 *   - GeckoTerminal trending pools (Solana)
 *   - DexScreener new pairs (fallback)
 *
 * Interval: Every 5 minutes (φ² ≈ 2.618 * 2 minutes)
 */

'use strict';

const axios = require('axios');
const { getDB } = require('../services/database');
const { queueNewToken } = require('../services/tokenQueue');
const logger = require('../services/logger');

// φ-aligned constants
const CATCHUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const REQUEST_TIMEOUT_MS = 10000;
const MAX_TOKENS_PER_RUN = 20;

// Tokens to always skip
const IGNORED_MINTS = new Set([
    'So11111111111111111111111111111111111111112',  // wSOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  // bSOL
    'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v', // jupSOL
]);

let catchupInterval = null;
let isRunning = false;

/**
 * Fetch trending Solana tokens from GeckoTerminal
 */
async function fetchTrendingGecko() {
    try {
        // GeckoTerminal trending pools API
        const url = 'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1';
        const res = await axios.get(url, { timeout: REQUEST_TIMEOUT_MS });

        const mints = new Set();

        if (res.data?.data && Array.isArray(res.data.data)) {
            for (const pool of res.data.data) {
                // Extract base token mint
                const baseTokenId = pool.relationships?.base_token?.data?.id;
                if (baseTokenId) {
                    const mint = baseTokenId.replace('solana_', '');
                    if (mint.length >= 32 && mint.length <= 44 && !IGNORED_MINTS.has(mint)) {
                        mints.add(mint);
                    }
                }
            }
        }

        return Array.from(mints);
    } catch (e) {
        logger.warn(`[Catchup] GeckoTerminal fetch failed: ${e.message}`);
        return [];
    }
}

/**
 * Fetch new Solana pairs from DexScreener
 */
async function fetchNewDexScreener() {
    try {
        // DexScreener latest pairs on Solana
        const url = 'https://api.dexscreener.com/token-profiles/latest/v1?chainId=solana';
        const res = await axios.get(url, { timeout: REQUEST_TIMEOUT_MS });

        const mints = new Set();

        if (Array.isArray(res.data)) {
            for (const token of res.data.slice(0, 50)) {
                const mint = token.tokenAddress;
                if (mint && mint.length >= 32 && mint.length <= 44 && !IGNORED_MINTS.has(mint)) {
                    mints.add(mint);
                }
            }
        }

        return Array.from(mints);
    } catch (e) {
        logger.debug(`[Catchup] DexScreener fetch failed: ${e.message}`);
        return [];
    }
}

/**
 * Run catchup check - find tokens we might have missed
 */
async function runCatchup() {
    if (isRunning) {
        logger.debug('[Catchup] Already running, skipping');
        return;
    }

    isRunning = true;
    const startTime = Date.now();

    try {
        const db = getDB();
        if (!db) {
            logger.warn('[Catchup] Database not ready');
            return;
        }

        // Gather tokens from multiple sources
        const [geckoTokens, dexTokens] = await Promise.all([
            fetchTrendingGecko(),
            fetchNewDexScreener()
        ]);

        // Merge and dedupe
        const allTokens = [...new Set([...geckoTokens, ...dexTokens])];

        if (allTokens.length === 0) {
            logger.debug('[Catchup] No external tokens found');
            return;
        }

        logger.info(`🔄 [Catchup] Checking ${allTokens.length} tokens from external sources`);

        let discovered = 0;
        let skipped = 0;

        for (const mint of allTokens.slice(0, MAX_TOKENS_PER_RUN)) {
            // Check if we already have this token
            const exists = await db.get('SELECT mint FROM tokens WHERE mint = $1', [mint]);

            if (exists) {
                skipped++;
                continue;
            }

            // New token found! Queue it for processing
            const queued = await queueNewToken(mint, 'catchup');
            if (queued) {
                discovered++;
                logger.info(`🔄 [Catchup] Discovered missed token: ${mint.slice(0, 12)}...`);
            }
        }

        const duration = Date.now() - startTime;

        if (discovered > 0) {
            logger.info(`✅ [Catchup] Found ${discovered} missed token(s) in ${duration}ms`);
        } else {
            logger.debug(`[Catchup] No missed tokens (checked ${skipped} existing) in ${duration}ms`);
        }

    } catch (error) {
        logger.error(`[Catchup] Error: ${error.message}`);
    } finally {
        isRunning = false;
    }
}

/**
 * Start the catchup service
 */
function startCatchup() {
    if (catchupInterval) {
        logger.warn('[Catchup] Already running');
        return;
    }

    logger.info('🔄 [Catchup] Starting token catchup service (every 5 min)');
    logger.info('   → Sources: GeckoTerminal trending, DexScreener latest');
    logger.info('   → Philosophy: "Don\'t trust, verify"');

    // Run immediately on start
    runCatchup();

    // Then run every CATCHUP_INTERVAL_MS
    catchupInterval = setInterval(runCatchup, CATCHUP_INTERVAL_MS);
}

/**
 * Stop the catchup service
 */
function stopCatchup() {
    if (catchupInterval) {
        clearInterval(catchupInterval);
        catchupInterval = null;
        logger.info('🛑 [Catchup] Token catchup service stopped');
    }
}

/**
 * Get service status
 */
function getCatchupStatus() {
    return {
        running: !!catchupInterval,
        busy: isRunning,
        interval: CATCHUP_INTERVAL_MS
    };
}

module.exports = {
    startCatchup,
    stopCatchup,
    runCatchup,
    getCatchupStatus
};
