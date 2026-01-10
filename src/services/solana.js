const { Connection, PublicKey } = require('@solana/web3.js');
const config = require('../config/env');
const logger = require('./logger');
const { getRedis } = require('./redis');
const { getRPCProvider, getConnection } = require('./rpcProvider');

// φ-based sampling and cache TTLs (SINGLE SOURCE OF TRUTH)
const { CACHE_TTL, SAMPLING, getCreditCost } = require('./rpcHarmony');
const { consumeCredits } = require('./rpcHardcap');

let connection = null;
let trackedConnection = null;

// ═══════════════════════════════════════════════════════════════════════════════
// TRACKED CONNECTION - Automatic RPC Credit Tracking
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * RPC methods that consume Helius credits and should be tracked
 * These are the @solana/web3.js Connection methods that make actual RPC calls
 */
const TRACKED_RPC_METHODS = new Set([
    // Account queries
    'getAccountInfo',
    'getAccountInfoAndContext',
    'getMultipleAccountsInfo',
    'getMultipleAccountsInfoAndContext',
    'getParsedAccountInfo',

    // Token methods
    'getTokenAccountBalance',
    'getTokenAccountsByOwner',
    'getParsedTokenAccountsByOwner',
    'getTokenLargestAccounts',
    'getTokenSupply',

    // Transaction methods
    'getTransaction',
    'getParsedTransaction',
    'getTransactions',
    'getParsedTransactions',
    'getSignaturesForAddress',
    'getSignatureStatuses',

    // Program methods
    'getProgramAccounts',
    'getParsedProgramAccounts',

    // Block/slot methods
    'getBlock',
    'getBlockHeight',
    'getSlot',
    'getLatestBlockhash',
    'getBalance',
    'getMinimumBalanceForRentExemption',

    // Send methods (less common but still RPC)
    'sendTransaction',
    'sendRawTransaction',
    'confirmTransaction',
]);

/**
 * Calculate dynamic credit cost based on method and result
 *
 * Some methods have variable costs (e.g., getMultipleAccountsInfo scales with batch size)
 *
 * @param {string} method - RPC method name
 * @param {Array} args - Method arguments
 * @param {any} result - Method result (for post-call cost calculation)
 * @returns {number} Credit cost
 */
function calculateDynamicCost(method, args, result) {
    const baseCost = getCreditCost(method);

    // Scale getMultipleAccountsInfo by batch size (1 credit per 100 accounts)
    if (method === 'getMultipleAccountsInfo' || method === 'getMultipleAccountsInfoAndContext') {
        const batchSize = args[0]?.length || 1;
        return Math.max(1, Math.ceil(batchSize / 100));
    }

    // getParsedTokenAccountsByOwner can be expensive for wallets with many tokens
    if (method === 'getParsedTokenAccountsByOwner') {
        const resultCount = result?.value?.length || 1;
        return Math.max(baseCost, Math.ceil(resultCount / 10));
    }

    return baseCost;
}

/**
 * Create a tracked connection wrapper using Proxy
 *
 * This wraps the Solana Connection object and automatically tracks
 * all RPC calls through the HARDCAP system.
 *
 * Philosophy: "Don't trust, verify" - every RPC call is tracked
 *
 * @param {Connection} conn - The underlying Solana Connection
 * @returns {Proxy} Tracked connection that auto-tracks credits
 */
function createTrackedConnection(conn) {
    return new Proxy(conn, {
        get(target, prop) {
            const value = target[prop];

            // Non-functions pass through unchanged
            if (typeof value !== 'function') {
                return value;
            }

            // Non-tracked methods pass through unchanged (bind to preserve 'this')
            if (!TRACKED_RPC_METHODS.has(prop)) {
                return value.bind(target);
            }

            // Wrap tracked RPC methods
            return async (...args) => {
                const startTime = Date.now();
                let result;
                let error;

                try {
                    result = await value.apply(target, args);
                    return result;
                } catch (e) {
                    error = e;
                    throw e;
                } finally {
                    // Track credits even on error (RPC was still called)
                    const cost = calculateDynamicCost(prop, args, result);
                    const duration = Date.now() - startTime;

                    // Fire-and-forget credit tracking (don't slow down the call)
                    consumeCredits(prop, cost).catch(e => {
                        logger.debug(`[TrackedConnection] Credit tracking failed: ${e.message}`);
                    });

                    // Debug logging for expensive calls
                    if (cost >= 5 || duration > 1000) {
                        logger.debug(`[TrackedConnection] ${prop}: ${cost} credits, ${duration}ms${error ? ' (ERROR)' : ''}`);
                    }
                }
            };
        }
    });
}

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

/**
 * Creates a NEW Connection instance.
 *
 * SECURITY NOTE: WebSocket connections require API key in URL (protocol limitation).
 * Most WS clients don't support custom headers during handshake.
 * HTTP RPC calls should use Authorization headers where possible.
 */
function createConnection() {
    const rpcUrl = config.SOLANA_RPC_URL || config.RPC_URL || 'https://api.mainnet-beta.solana.com';

    // PRIORITY 1: Explicit Env Var
    let wsUrl = config.SOLANA_WSS_URL;

    // PRIORITY 2: Helius API Key (Most Robust)
    // NOTE: WSS requires API key in URL - this is a WebSocket protocol limitation
    // The key is only sent during handshake, not visible in subsequent frames
    if (!wsUrl && config.HELIUS_API_KEY) {
        wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;
    }

    // PRIORITY 3: Auto-Derive from RPC URL
    if (!wsUrl) {
        if (rpcUrl.includes('helius') || rpcUrl.includes('quicknode') || rpcUrl.includes('alchemy') || rpcUrl.includes('devnet')) {
             wsUrl = rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');
        }
    }

    // --- CRITICAL CHECK ---
    if (!wsUrl && process.env.SERVICE_TYPE === 'listener') {
        logger.warn("⚠️  WARNING: No explicit WSS URL found. Listeners might fail on Public RPC.");
    }

    const confirmTimeout = 60000;

    const conn = new Connection(rpcUrl, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: confirmTimeout,
        wsEndpoint: wsUrl,
        disableRetryOnRateLimit: false,
    });
    
    // Logging (Masked)
    const logUrl = rpcUrl.replace(/\?api-key=[^&]+/, '?api-key=***');
    const logWs = wsUrl ? wsUrl.replace(/\?api-key=[^&]+/, '?api-key=***') : 'Standard (Auto)';
    
    // Log at INFO level so we can see it in production logs
    logger.info(`🔌 Solana Connection Init: ${logUrl}`);
    logger.info(`🔌 WSS Endpoint: ${logWs}`);

    return conn;
}

/**
 * Singleton connection provider with automatic credit tracking.
 *
 * Returns a TrackedConnection that automatically tracks all RPC calls
 * through the HARDCAP system. This ensures accurate credit accounting
 * across all services using getSolanaConnection().
 *
 * @param {boolean} forceNew - If true, creates a fresh connection instance
 * @returns {Proxy<Connection>} Tracked connection with auto credit tracking
 */
function getSolanaConnection(forceNew = false) {
    if (!connection || forceNew) {
        connection = createConnection();
        trackedConnection = createTrackedConnection(connection);
        logger.info('[TrackedConnection] Created new tracked connection');
    }
    return trackedConnection;
}

/**
 * Get raw (untracked) connection for special cases
 *
 * SECURITY WARNING: This connection bypasses credit tracking!
 * Only use for WebSocket subscriptions where tracking is impossible.
 * All other code MUST use getSolanaConnection() for HARDCAP tracking.
 *
 * @returns {Connection} Raw untracked connection
 * @deprecated Prefer getSolanaConnection() for all RPC calls
 */
function getRawConnection() {
    // SECURITY: Log warning when raw connection is accessed (for audit trail)
    const caller = new Error().stack?.split('\n')[2]?.trim() || 'unknown';
    logger.warn(`⚠️  [SECURITY] getRawConnection() called - bypasses credit tracking! Caller: ${caller.slice(0, 100)}`);

    if (!connection) {
        connection = createConnection();
        trackedConnection = createTrackedConnection(connection);
    }
    return connection;
}

/**
 * Retry RPC calls with exponential backoff and jitter
 * @param {Function} fn - Async function to retry
 * @param {number} retries - Max retry attempts (default: 5)
 * @param {number} baseDelay - Base delay in ms (default: 1000)
 */
async function retryRPC(fn, retries = 5, baseDelay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (e) {
            // Don't retry client errors (invalid params, etc.)
            if (e.message && (e.message.includes('400') || e.message.includes('Invalid param'))) throw e;

            const isRateLimit = e.message && (e.message.includes('429') || e.message.includes('Too Many Requests'));
            if (i === retries - 1) throw e;

            // Exponential backoff with jitter to avoid thundering herd
            const exponentialDelay = baseDelay * Math.pow(2, i);
            const jitter = Math.random() * baseDelay * 0.5; // 0-50% of baseDelay
            const waitTime = isRateLimit
                ? exponentialDelay * 3 + jitter  // Extra delay for rate limits
                : exponentialDelay + jitter;

            logger.debug(`[RPC] Retry ${i + 1}/${retries} in ${Math.round(waitTime)}ms: ${e.message?.slice(0, 50)}`);
            await new Promise(r => setTimeout(r, waitTime));
        }
    }
}

async function fetchAccountsForProgram(conn, programId, mintAddress) {
    try {
        const filters = [
            programId.equals(TOKEN_PROGRAM_ID) ? { dataSize: 165 } : null,
            { memcmp: { offset: 0, bytes: mintAddress } }
        ].filter(Boolean);

        let accounts = await retryRPC(() => conn.getProgramAccounts(programId, {
            filters: filters,
            dataSlice: { offset: 64, length: 8 }
        }), 2, 500); 

        let activeHolders = 0;
        if (accounts) {
            for (const acc of accounts) {
                if (acc.account.data && acc.account.data.length === 8) {
                    const balance = acc.account.data.readBigUInt64LE(0);
                    if (balance > 0n) activeHolders++;
                }
            }
        }
        return activeHolders;
    } catch (_e) {
        return 0;
    }
}

/**
 * Get holder count using RPC Provider (Helius DAS with public fallback)
 *
 * Uses L2 Multi-RPC abstraction:
 * - Helius DAS API for accurate paginated holder counts
 * - Public RPC fallback for standard getProgramAccounts
 *
 * OPTIMIZATION: 5-minute Redis cache to reduce RPC calls
 * Saves ~50-100 calls/hour from website traffic
 */
async function getHolderCountFromRPC(mintAddress) {
    if (!mintAddress) return 0;
    const cleanMint = mintAddress.trim();

    // Check Redis cache first (φ-based TTL from rpcHarmony)
    try {
        const redis = getRedis();
        if (redis) {
            const cacheKey = `holders:count:${cleanMint}`;
            const cached = await redis.get(cacheKey);
            if (cached) {
                logger.debug(`[Holders] Cache hit for ${cleanMint.slice(0, 8)}`);
                return parseInt(cached);
            }
        }
    } catch (e) {
        logger.debug(`[Holders] Cache check failed: ${e.message}`);
    }

    let finalCount = 0;
    const provider = getRPCProvider();

    // Try Helius DAS API first (paginated, works for millions of holders)
    if (provider.hasHelius()) {
        try {
            let count = 0;
            let cursor = null;

            // Fibonacci-based pagination (SAMPLING.DAS_MAX_PAGES = 5)
            // Most tokens have <5k holders; early exit saves credits
            let page = 0;

            while (page < SAMPLING.DAS_MAX_PAGES) {
                // Provider handles rate limiting internally
                const result = await provider.getTokenAccounts(cleanMint, {
                    limit: SAMPLING.DAS_PAGE_SIZE,
                    cursor
                });

                // Note: RPC tracking is now handled in helius.js provider (10 credits per call)

                if (!result?.token_accounts) break;

                const pageCount = result.token_accounts.length;

                // Count accounts with balance > 0
                for (const acc of result.token_accounts) {
                    if (acc.amount > 0) count++;
                }

                // Early exit: if page has <PAGE_SIZE results, we've reached the end
                if (pageCount < SAMPLING.DAS_PAGE_SIZE) {
                    logger.debug(`[Holders] Early exit at page ${page + 1} (${pageCount} accounts)`);
                    break;
                }

                cursor = result.cursor;
                page++;
                if (!cursor) break;
            }

            if (count > 0) {
                finalCount = count;
            }
        } catch (e) {
            logger.warn(`[Holders] Helius DAS failed for ${cleanMint.slice(0,8)}: ${e.message}`);
        }
    }

    // Fallback to standard RPC via provider (may fail for large tokens)
    if (finalCount === 0) {
        try {
            // Use provider's connection with automatic fallback
            const conn = provider.getConnection();
            let count = await fetchAccountsForProgram(conn, TOKEN_PROGRAM_ID, cleanMint);
            if (count === 0) {
                const count2022 = await fetchAccountsForProgram(conn, TOKEN_2022_PROGRAM_ID, cleanMint);
                count += count2022;
            }
            finalCount = count;
        } catch (e) {
            logger.warn(`[Holders] Standard RPC failed for ${cleanMint.slice(0,8)}: ${e.message}`);
        }
    }

    // Cache the result (φ-based TTL from CACHE_TTL.HOLDER_COUNT)
    try {
        const redis = getRedis();
        if (redis && finalCount > 0) {
            const cacheKey = `holders:count:${cleanMint}`;
            await redis.set(cacheKey, finalCount.toString(), 'EX', CACHE_TTL.HOLDER_COUNT);
            logger.debug(`[Holders] Cached count for ${cleanMint.slice(0, 8)}: ${finalCount} (TTL: ${CACHE_TTL.HOLDER_COUNT}s)`);
        }
    } catch (e) {
        logger.debug(`[Holders] Cache write failed: ${e.message}`);
    }

    return finalCount;
}

/**
 * Analyze token holder behavior for conviction metrics
 * Uses L2 Multi-RPC with automatic failover
 *
 * NOTE: Uses getSignaturesForAddress (faster for timestamp-only queries)
 * For full parsed transaction data, use provider.getTransactionsForAddress()
 *
 * OPTIMIZATION: Cached for 1 hour (saves ~16 RPC credits per call)
 */
async function analyzeTokenHolders(mintAddress, excludeAddresses = []) {
    const provider = getRPCProvider();
    const cleanMint = mintAddress?.toString().trim();
    if (!cleanMint) return { avgHoldHours: 0 };

    // Check cache first (1 hour TTL - conviction metrics are stable)
    try {
        const redis = getRedis();
        if (redis) {
            const cacheKey = `conviction:${cleanMint}`;
            const cached = await redis.get(cacheKey);
            if (cached) {
                logger.debug(`[Conviction] Cache hit for ${cleanMint.slice(0, 8)}`);
                return JSON.parse(cached);
            }
        }
    } catch (_e) { /* ignore cache errors */ }

    try {
        // Use provider's getTokenLargestAccounts with fallback
        const largest = await provider.getTokenLargestAccounts(mintAddress);

        // Note: RPC tracking is now handled in helius.js provider

        if (!largest || !largest.value || largest.value.length === 0) return { avgHoldHours: 0 };

        const topAccounts = largest.value;
        const nowSec = Math.floor(Date.now() / 1000);
        let totalDuration = 0;
        let validSamples = 0;
        const excludeSet = new Set(excludeAddresses.map(a => a ? a.toString() : ''));

        // Fibonacci-based sampling (SAMPLING.CONVICTION_SAMPLES = 5, statistically sufficient)
        for (const acc of topAccounts) {
            if (validSamples >= SAMPLING.CONVICTION_SAMPLES) break;
            if (excludeSet.has(acc.address.toString())) continue;

            try {
                // getSignaturesForAddress is optimal for timestamp-only queries (168ms vs 1000ms+)
                const signatures = await provider.getSignaturesForAddress(acc.address, { limit: SAMPLING.CONVICTION_DEPTH });

                // Note: RPC tracking handled in helius.js provider

                if (signatures && signatures.length > 0) {
                    const oldestTx = signatures[signatures.length - 1];
                    const txTime = oldestTx.blockTime || nowSec;
                    totalDuration += (nowSec - txTime);
                    validSamples++;
                } else {
                    totalDuration += (24 * 3600);
                    validSamples++;
                }
            } catch (_err) { /* ignore */ }
        }
        if (validSamples === 0) return { avgHoldHours: 0 };

        const result = { avgHoldHours: (totalDuration / validSamples) / 3600 };

        // Cache result (φ-based TTL from CACHE_TTL.CONVICTION)
        try {
            const redis = getRedis();
            if (redis) {
                const cacheKey = `conviction:${cleanMint}`;
                await redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL.CONVICTION);
                logger.debug(`[Conviction] Cached for ${cleanMint.slice(0, 8)}: ${result.avgHoldHours.toFixed(1)}h (TTL: ${CACHE_TTL.CONVICTION}s)`);
            }
        } catch (_e) { /* ignore cache errors */ }

        return result;
    } catch (_e) {
        return { avgHoldHours: 0 };
    }
}

module.exports = {
    getSolanaConnection,  // Tracked connection with auto credit tracking
    getRawConnection,     // Raw connection for WebSocket subscriptions only
    getConnection,        // L2: provider-managed connection with fallback
    getRPCProvider,       // L2: full provider access
    analyzeTokenHolders,
    retryRPC,
    getHolderCountFromRPC
};
