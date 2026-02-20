/**
 * Helius Webhook Receiver
 * Receives real-time token transfer events and updates holder_snapshots
 *
 * SECURITY: Webhooks are verified using HMAC-SHA256 signatures
 * from Helius (X-Helius-Signature header)
 *
 * CRITICAL: In production, WEBHOOK_SECRET is REQUIRED.
 * Requests will be rejected if signature verification fails.
 */
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const logger = require('../services/logger');
const config = require('../config/env');
const { getClient } = require('../services/redis');
const { isValidSolanaAddress, sanitizeError } = require('../utils/validation');
const verification = require('../services/verificationService');
const newTokenWebhook = require('../services/newTokenWebhook');
const { queueNewToken, promoteToQueue } = require('../services/tokenQueue');
const signalAccumulator = require('../services/signalAccumulator');
const { tokenExists } = require('../services/database');

// ============================================
// RATE LIMITING - Prevent webhook amplification attacks
// ============================================

/**
 * Webhook Rate Limiter
 *
 * Limits: 100 requests per minute per IP
 * Purpose: Prevent amplification attacks (1 webhook → N RPC calls)
 *
 * IMPORTANT: This is the FIRST line of defense against credit drain.
 * Even legitimate Helius webhooks can flood if misconfigured.
 */
// Normalize IP addresses (including IPv6) for express-rate-limit compatibility
const normalizeIp = (ip) => {
    if (!ip) return 'unknown';
    // Map IPv6 localhost to IPv4 for consistency
    if (ip === '::1' || ip === '::ffff:127.0.0.1') return '127.0.0.1';
    // Remove IPv6 zone ID (e.g., %eth0)
    if (ip.includes('%')) return ip.split('%')[0];
    // Map IPv6-mapped IPv4 addresses (::ffff:x.x.x.x) to IPv4
    if (ip.startsWith('::ffff:')) return ip.slice(7);
    return ip;
};

const webhookRateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute window
    max: 100,            // 100 requests per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false, // Count ALL requests
    keyGenerator: (req) => {
        // Trust X-Forwarded-For from Helius (behind their load balancer)
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                   req.ip ||
                   'unknown';
        return normalizeIp(ip);
    },
    handler: (req, res) => {
        logger.warn(`⚠️  Webhook rate limit exceeded: ${req.ip}`);
        res.status(429).json({
            error: 'Too many webhook requests',
            retryAfter: 60
        });
    }
});
// DISABLED: Direct indexing causes rate limit floods
// const { indexTokenOnChain } = require('../services/indexer');

// Security: Replay attack prevention via Redis (cluster-safe, persistent)
const REPLAY_WINDOW_SECONDS = 300; // 5 minutes TTL

// Verification settings
const VERIFY_CRITICAL_TX = config.VERIFY_WEBHOOK_TX !== 'false'; // Default: true
const CRITICAL_AMOUNT_THRESHOLD = 1000000000; // 1B tokens = verify on-chain

// Known DEX/AMM pool programs to exclude from holder tracking
const POOL_PROGRAMS = new Set([
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
    '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca Legacy
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',  // Meteora DLMM
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // Pump.fun bonding
    'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM', // Pump.fun AMM
]);

// DEX detection from program IDs (for signal accumulator relevance scoring)
// Complete list of Solana DEX/AMM programs
const DEX_PROGRAMS = {
    // Raydium
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium',     // AMM v4
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium',     // CLMM
    'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'Raydium',     // CPMM
    'routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS': 'Raydium',      // Router

    // Orca
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca',         // Whirlpool
    '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP': 'Orca',        // Legacy

    // Meteora
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'Meteora',      // DLMM
    'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB': 'Meteora',    // Pools

    // Pump.fun ecosystem
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump.fun',     // Bonding curve
    'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM': 'PumpSwap',     // AMM migration

    // Jupiter
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter',      // Aggregator v6
    'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB': 'Jupiter',      // Aggregator v4

    // Moonshot
    'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG': 'Moonshot',

    // Phoenix
    'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY': 'Phoenix',

    // OpenBook (ex-Serum)
    'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb': 'OpenBook',
    'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX': 'OpenBook',     // Legacy Serum

    // Lifinity
    'EewxydAPCCVuNEyrVN68PuSYdQ7wKn27V9Gjeoi8dy3S': 'Lifinity',

    // GooseFX
    'GFXsSL5sSaDfNFQUYsHekbWBW1TsFdjDYzACh62tEHxn': 'GooseFX',

    // Aldrin
    'AMM55ShdkoGRB5jVYPjWziwk8m5MpwyDgsMWHaMSQWH6': 'Aldrin',

    // Saber
    'SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ': 'Saber',

    // Marinade
    'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD': 'Marinade',
};

/**
 * Detect DEX source from event data
 * @param {Object} event - Helius webhook event
 * @returns {string|null} DEX name or null
 */
function detectDexSource(event) {
    // Check account keys in the transaction
    if (event.accountData) {
        for (const acc of event.accountData) {
            if (acc.account && DEX_PROGRAMS[acc.account]) {
                return DEX_PROGRAMS[acc.account];
            }
        }
    }

    // Check instructions
    if (event.instructions) {
        for (const ix of event.instructions) {
            if (ix.programId && DEX_PROGRAMS[ix.programId]) {
                return DEX_PROGRAMS[ix.programId];
            }
        }
    }

    // Check source field from Helius
    if (event.source) {
        const sourceMap = {
            'RAYDIUM': 'Raydium',
            'ORCA': 'Orca',
            'METEORA': 'Meteora',
            'PUMP_FUN': 'Pump.fun',
            'JUPITER': 'Jupiter',
        };
        return sourceMap[event.source] || event.source;
    }

    // Check if mint ends with 'pump' (Pump.fun token)
    if (event.tokenTransfers) {
        for (const transfer of event.tokenTransfers) {
            if (transfer.mint && transfer.mint.endsWith('pump')) {
                return 'Pump.fun';
            }
        }
    }

    return null;
}

// Additional known pool/program addresses
const isPoolAddress = (address) => {
    if (!address) return false;
    if (POOL_PROGRAMS.has(address)) return true;
    // Raydium pools often start with specific patterns
    if (address.length === 44 && address.endsWith('pump')) return false; // Token addresses
    return false;
};

// ============================================
// INPUT VALIDATION - Validate webhook payload BEFORE processing
// ============================================
const MAX_EVENTS_PER_BATCH = 50;    // Reduced from 100 - prevent DoS
const MAX_TRANSFERS_PER_EVENT = 20; // Reduced from 50 - reasonable limit
const MAX_TOTAL_TRANSFERS = 200;    // SECURITY: Hard cap on total transfers per batch
                                    // Prevents 50×20=1000 → max 200 DB operations
const MAX_TOKEN_AMOUNT = BigInt('18446744073709551615'); // Max uint64
const MIN_TIMESTAMP = 1600000000; // Sept 2020 (before Solana mainnet)
const MAX_TIMESTAMP = Math.floor(Date.now() / 1000) + 86400; // Now + 1 day buffer

/**
 * Validate a single webhook event structure
 * @param {Object} event - Raw event from webhook
 * @returns {{valid: boolean, reason?: string}}
 */
function validateEvent(event) {
    if (!event || typeof event !== 'object') {
        return { valid: false, reason: 'Invalid event structure' };
    }

    // Validate type
    if (event.type && typeof event.type !== 'string') {
        return { valid: false, reason: 'Invalid event type' };
    }

    // Validate signature format
    if (event.signature) {
        if (typeof event.signature !== 'string' || event.signature.length < 32 || event.signature.length > 100) {
            return { valid: false, reason: 'Invalid signature format' };
        }
    }

    // Validate timestamp (if present)
    if (event.timestamp !== undefined) {
        const ts = parseInt(event.timestamp);
        if (!Number.isFinite(ts) || ts < MIN_TIMESTAMP || ts > MAX_TIMESTAMP) {
            return { valid: false, reason: 'Invalid timestamp' };
        }
    }

    // Validate tokenTransfers array
    if (event.tokenTransfers) {
        if (!Array.isArray(event.tokenTransfers)) {
            return { valid: false, reason: 'tokenTransfers must be array' };
        }
        if (event.tokenTransfers.length > MAX_TRANSFERS_PER_EVENT) {
            return { valid: false, reason: 'Too many transfers per event' };
        }
    }

    return { valid: true };
}

/**
 * Validate a single transfer within an event
 * @param {Object} transfer - Transfer object
 * @returns {{valid: boolean, amount?: bigint, reason?: string}}
 */
function validateTransfer(transfer) {
    if (!transfer || typeof transfer !== 'object') {
        return { valid: false, reason: 'Invalid transfer structure' };
    }

    // Validate tokenAmount with BigInt to prevent overflow
    if (transfer.tokenAmount !== undefined) {
        try {
            const amount = BigInt(transfer.tokenAmount);
            if (amount < 0n || amount > MAX_TOKEN_AMOUNT) {
                return { valid: false, reason: 'Token amount out of bounds' };
            }
            // Convert to safe integer for DB storage (cap at Number.MAX_SAFE_INTEGER)
            const safeAmount = amount > BigInt(Number.MAX_SAFE_INTEGER)
                ? Number.MAX_SAFE_INTEGER
                : Number(amount);
            return { valid: true, amount: safeAmount };
        } catch (_e) {
            return { valid: false, reason: 'Invalid token amount format' };
        }
    }

    return { valid: true, amount: 0 };
}

/**
 * Check if signature was already processed (Redis-backed, cluster-safe)
 * Returns true if duplicate, false if new
 */
async function checkAndMarkProcessed(signature) {
    const redis = getClient();
    if (!redis) return false; // Allow if Redis down (degrade gracefully)

    const key = `webhook:sig:${signature}`;
    // SETNX returns 1 if key was set (new), 0 if already exists (duplicate)
    const isNew = await redis.set(key, '1', 'EX', REPLAY_WINDOW_SECONDS, 'NX');
    return !isNew; // Return true if duplicate
}

let db = null;

function init(deps) {
    db = deps.db;

    /**
     * POST /webhook/transfers
     * Receives transfer events from Helius webhook
     *
     * SECURITY: Signature verification is REQUIRED in production
     * Set WEBHOOK_SECRET env var to enable verification
     *
     * Event structure (Enhanced):
     * [{
     *   type: 'TRANSFER',
     *   tokenTransfers: [{
     *     mint: 'TokenMint',
     *     fromUserAccount: 'Seller',
     *     toUserAccount: 'Buyer',
     *     tokenAmount: 1000000
     *   }],
     *   signature: 'txSig',
     *   timestamp: 1234567890
     * }]
     */
    router.post('/transfers', webhookRateLimiter, async (req, res) => {
        try {
            // ============================================
            // SECURITY: Auth Header Verification
            // Helius sends authHeader in Authorization header
            // Accept requests if auth matches OR if no secret configured
            // ============================================
            if (config.WEBHOOK_SECRET) {
                const authHeader = req.headers['authorization'];

                if (!authHeader) {
                    // SECURITY: Reject requests without auth when secret is configured
                    logger.warn('⚠️  Webhook request rejected - no auth header');
                    return res.status(401).json({ error: 'Authorization required' });
                }

                // Constant-time comparison to prevent timing attacks
                const expected = Buffer.from(config.WEBHOOK_SECRET);
                const received = Buffer.from(authHeader);

                if (expected.length !== received.length ||
                    !require('crypto').timingSafeEqual(expected, received)) {
                    logger.warn('⚠️  Webhook auth mismatch');
                    return res.status(401).json({ error: 'Unauthorized' });
                }
                // Auth verified - continue processing
            } else if (process.env.NODE_ENV === 'production') {
                // SECURITY: Reject in production if no secret configured
                logger.error('❌ WEBHOOK_SECRET not configured in production');
                return res.status(503).json({ error: 'Webhook not configured' });
            }

            const events = Array.isArray(req.body) ? req.body : [req.body];
            let processed = 0;
            let skipped = 0;
            const affectedMints = new Set(); // FIX 2026-01-09: Track mints to update TTL

            // ============================================
            // VALIDATION: Check batch size BEFORE processing
            // ============================================
            if (events.length > MAX_EVENTS_PER_BATCH) {
                logger.warn(`[Webhook] Batch too large: ${events.length} events (max ${MAX_EVENTS_PER_BATCH})`);
                return res.status(400).json({
                    error: 'Batch size exceeded',
                    max: MAX_EVENTS_PER_BATCH,
                    received: events.length
                });
            }

            // ============================================
            // SECURITY: Count total transfers BEFORE processing (anti-amplification)
            // ============================================
            let totalTransfers = 0;
            for (const e of events) {
                totalTransfers += (e.tokenTransfers?.length || 0);
            }
            if (totalTransfers > MAX_TOTAL_TRANSFERS) {
                logger.warn(`[Webhook] Too many transfers: ${totalTransfers} (max ${MAX_TOTAL_TRANSFERS})`);
                return res.status(400).json({
                    error: 'Total transfers exceeded',
                    max: MAX_TOTAL_TRANSFERS,
                    received: totalTransfers
                });
            }

            for (const event of events) {
                // ============================================
                // VALIDATION: Validate event structure BEFORE processing
                // ============================================
                const eventValidation = validateEvent(event);
                if (!eventValidation.valid) {
                    logger.debug(`[Webhook] Invalid event: ${eventValidation.reason}`);
                    skipped++;
                    continue;
                }

                // Skip non-transfer events
                if (event.type !== 'TRANSFER') continue;

                // ============================================
                // SECURITY: Replay Attack Protection (Redis-backed)
                // ============================================
                const txSignature = event.signature;
                if (txSignature) {
                    // Check if already processed (atomic Redis SETNX)
                    if (await checkAndMarkProcessed(txSignature)) {
                        skipped++;
                        continue;
                    }
                }

                const transfers = event.tokenTransfers || [];

                // ============================================
                // VERIFICATION: On-chain transaction validation
                // For large transfers, verify the transaction exists on-chain
                // ============================================
                const hasLargeTransfer = transfers.some(t => parseInt(t.tokenAmount) > CRITICAL_AMOUNT_THRESHOLD);

                if (VERIFY_CRITICAL_TX && hasLargeTransfer && txSignature) {
                    const txVerification = await verification.verifyTransaction(txSignature, {
                        timestamp: event.timestamp,
                        transfers: transfers.map(t => ({ mint: t.mint }))
                    });

                    if (!txVerification.verified) {
                        logger.warn(`⚠️  [Webhook] TX verification failed: ${txSignature.slice(0, 8)}... - ${txVerification.error || 'mismatch'}`);
                        skipped++;
                        continue; // Skip unverified large transactions
                    }

                    logger.debug(`✅ [Webhook] TX verified on-chain: ${txSignature.slice(0, 8)}... via ${txVerification.provider}`);
                }

                for (const transfer of transfers) {
                    const { mint, fromUserAccount, toUserAccount } = transfer;

                    if (!mint) continue;

                    // ============================================
                    // VALIDATION: Validate transfer structure and amount
                    // ============================================
                    const transferValidation = validateTransfer(transfer);
                    if (!transferValidation.valid) {
                        logger.debug(`[Webhook] Invalid transfer: ${transferValidation.reason}`);
                        continue;
                    }
                    const amount = transferValidation.amount;

                    // ============================================
                    // SECURITY: Validate all addresses
                    // ============================================
                    if (!isValidSolanaAddress(mint)) {
                        logger.debug(`[Webhook] Invalid mint address: ${String(mint).slice(0, 8)}...`);
                        continue;
                    }

                    // Check if this token is tracked (verified)
                    const token = await db.get(
                        'SELECT mint FROM tokens WHERE mint = $1 AND hasCommunityUpdate = TRUE',
                        [mint]
                    );

                    if (!token) continue; // Not a tracked token

                    affectedMints.add(mint); // FIX 2026-01-09: Track for TTL update
                    const now = Date.now();
                    // K-Score v9: Use actual transaction timestamp for activity freshness
                    const txTimestamp = event.timestamp ? event.timestamp * 1000 : now;

                    // Update buyer (if not a pool and valid address)
                    // OPTIMIZED: Single atomic UPSERT with inline conviction calculation
                    if (toUserAccount && !isPoolAddress(toUserAccount) && isValidSolanaAddress(toUserAccount)) {
                        await db.run(`
                            INSERT INTO holder_snapshots (mint, holder, buy_count, sell_count, net_flow, balance, conviction_class, updated_at, last_tx_timestamp)
                            VALUES ($1, $2, 1, 0, $3, $3, 'accumulator', $4, $5)
                            ON CONFLICT (mint, holder) DO UPDATE SET
                                buy_count = holder_snapshots.buy_count + 1,
                                net_flow = holder_snapshots.net_flow + $3,
                                balance = holder_snapshots.balance + $3,
                                updated_at = $4,
                                last_tx_timestamp = $5,
                                conviction_class = CASE
                                    WHEN (holder_snapshots.buy_count + 1)::float / NULLIF(holder_snapshots.buy_count + 1 + holder_snapshots.sell_count, 0) >= 0.8 THEN 'accumulator'
                                    WHEN (holder_snapshots.buy_count + 1)::float / NULLIF(holder_snapshots.buy_count + 1 + holder_snapshots.sell_count, 0) >= 0.5 THEN 'holder'
                                    WHEN (holder_snapshots.buy_count + 1)::float / NULLIF(holder_snapshots.buy_count + 1 + holder_snapshots.sell_count, 0) >= 0.2 THEN 'reducer'
                                    ELSE 'extractor'
                                END
                        `, [mint, toUserAccount, amount, now, txTimestamp]);
                    }

                    // Update seller (if not a pool and valid address)
                    // OPTIMIZED: Single atomic UPSERT with inline conviction calculation
                    if (fromUserAccount && !isPoolAddress(fromUserAccount) && isValidSolanaAddress(fromUserAccount)) {
                        await db.run(`
                            INSERT INTO holder_snapshots (mint, holder, buy_count, sell_count, net_flow, balance, conviction_class, updated_at, last_tx_timestamp)
                            VALUES ($1, $2, 0, 1, $3, 0, 'extractor', $4, $5)
                            ON CONFLICT (mint, holder) DO UPDATE SET
                                sell_count = holder_snapshots.sell_count + 1,
                                net_flow = holder_snapshots.net_flow - $6,
                                balance = GREATEST(0, holder_snapshots.balance - $6),
                                updated_at = $4,
                                last_tx_timestamp = $5,
                                conviction_class = CASE
                                    WHEN holder_snapshots.buy_count::float / NULLIF(holder_snapshots.buy_count + holder_snapshots.sell_count + 1, 0) >= 0.8 THEN 'accumulator'
                                    WHEN holder_snapshots.buy_count::float / NULLIF(holder_snapshots.buy_count + holder_snapshots.sell_count + 1, 0) >= 0.5 THEN 'holder'
                                    WHEN holder_snapshots.buy_count::float / NULLIF(holder_snapshots.buy_count + holder_snapshots.sell_count + 1, 0) >= 0.2 THEN 'reducer'
                                    ELSE 'extractor'
                                END
                        `, [mint, fromUserAccount, -amount, now, txTimestamp, amount]);
                    }

                    // ============================================
                    // AUDIT: Log significant transfers (async, non-blocking)
                    // ============================================
                    if (amount > CRITICAL_AMOUNT_THRESHOLD) {
                        // Fire and forget - don't block webhook response
                        verification.logAudit(db, {
                            action: 'transfer',
                            entity: 'holder',
                            entityId: mint,
                            newValue: {
                                from: fromUserAccount,
                                to: toUserAccount,
                                amount,
                                signature: txSignature
                            },
                            source: 'helius_webhook',
                            metadata: { timestamp: event.timestamp }
                        }).catch(_e => {}); // Ignore audit failures
                    }

                    processed++;
                }
            }

            // ============================================
            // FIX 2026-01-09: Update holders_snapshot_check TTL for affected mints
            // This prevents K-Score from falling back to expensive polling mode
            // when webhook data is fresh but TTL has expired
            // ============================================
            if (affectedMints.size > 0) {
                const now = Date.now();
                const mintArray = [...affectedMints];
                // Batch update for efficiency (PostgreSQL ANY syntax)
                await db.run(
                    `UPDATE tokens SET holders_snapshot_check = $1 WHERE mint = ANY($2::text[])`,
                    [now, mintArray]
                );
                logger.debug(`🔄 Webhook: Updated TTL for ${mintArray.length} mints`);
            }

            if (processed > 0 || skipped > 0) {
                logger.debug(`📥 Webhook: Processed ${processed}, Skipped ${skipped} transfers`);
            }

            res.status(200).json({ received: true, processed, skipped, ttlUpdated: affectedMints.size });

        } catch (error) {
            // SECURITY: Log full error internally, return sanitized message externally
            logger.error(`❌ Webhook Error: ${error.message}`);
            res.status(500).json({ error: sanitizeError(error) });
        }
    });

    /**
     * GET /webhook/health
     * Health check for webhook endpoint
     */
    router.get('/health', (req, res) => {
        res.json({ status: 'ok', mode: 'webhook-receiver' });
    });

    // ════════════════════════════════════════════════════════════════════════
    // NEW TOKEN DISCOVERY WEBHOOK
    // Receives CREATE_POOL and TOKEN_MINT events from Helius
    // Cost: 1 credit per event (vs ~5000 credits/hour with WebSocket listener)
    // ════════════════════════════════════════════════════════════════════════

    /**
     * POST /webhook/new-tokens
     * Receives new token creation events from Helius
     *
     * Transaction types:
     *   - CREATE_POOL (Raydium pool initialization)
     *   - TOKEN_MINT (SPL token creation)
     *   - SWAP (First Pump.fun swap)
     */
    router.post('/new-tokens', webhookRateLimiter, async (req, res) => {
        const stats = newTokenWebhook.getStats();
        stats.eventsReceived++;
        stats.lastEventTime = Date.now();

        try {
            // ══════════════════════════════════════════════════════════════
            // SECURITY: Verify webhook signature
            // ══════════════════════════════════════════════════════════════
            if (config.WEBHOOK_SECRET) {
                const authHeader = req.headers['authorization'];
                if (!authHeader) {
                    logger.warn('[NewToken] Rejected - no auth header');
                    return res.status(401).json({ error: 'Authorization required' });
                }

                const expected = Buffer.from(config.WEBHOOK_SECRET);
                const received = Buffer.from(authHeader);
                if (expected.length !== received.length ||
                    !require('crypto').timingSafeEqual(expected, received)) {
                    logger.warn('[NewToken] Rejected - auth mismatch');
                    return res.status(401).json({ error: 'Unauthorized' });
                }
            } else if (process.env.NODE_ENV === 'production') {
                logger.error('[NewToken] WEBHOOK_SECRET not configured in production');
                return res.status(503).json({ error: 'Webhook not configured' });
            }

            const events = Array.isArray(req.body) ? req.body : [req.body];
            let discovered = 0;
            let skipped = 0;

            // Limit batch size
            if (events.length > 50) {
                logger.warn(`[NewToken] Batch too large: ${events.length}`);
                return res.status(400).json({ error: 'Batch too large', max: 50 });
            }

            const redis = getClient();

            for (const event of events) {
                // ══════════════════════════════════════════════════════════════
                // REPLAY PROTECTION (with error isolation)
                // ══════════════════════════════════════════════════════════════
                const signature = event.signature;
                try {
                    if (signature && await newTokenWebhook.isReplayAttack(signature)) {
                        stats.duplicatesSkipped++;
                        skipped++;
                        continue;
                    }
                } catch (replayErr) {
                    // Redis error - skip replay check, continue processing
                    logger.warn(`[NewToken] Replay check failed: ${replayErr.message}`);
                }

                // ══════════════════════════════════════════════════════════════
                // EXTRACT MINTS
                // ══════════════════════════════════════════════════════════════
                const source = newTokenWebhook.detectSource(event);
                const mints = newTokenWebhook.extractMintsFromEvent(event);

                if (mints.length === 0) {
                    skipped++;
                    continue;
                }

                // ══════════════════════════════════════════════════════════════
                // PROCESS EACH MINT (with error isolation)
                // ══════════════════════════════════════════════════════════════
                for (const mint of mints) {
                    try {
                        // Validate address
                        if (!isValidSolanaAddress(mint)) continue;

                        // OPTIMIZATION: Use centralized tokenExists with Redis-first caching
                        // Includes positive cache (known mints) and negative cache (unknown mints with TTL)
                        // This avoids DB connection exhaustion during high webhook volume
                        const exists = await tokenExists(mint);
                        if (exists) {
                            skipped++;
                            continue;
                        }

                        // ══════════════════════════════════════════════════════════
                        // 17-DIMENSION SIGNAL ACCUMULATOR PRE-JUDGMENT
                        // Collect FREE webhook signals → Judge → Queue only ACCEPTED
                        // ══════════════════════════════════════════════════════════
                        const eventType = event.type || 'UNKNOWN';

                        // Extract wallets from the event for signal tracking
                        const wallets = [];
                        if (event.tokenTransfers) {
                            for (const transfer of event.tokenTransfers) {
                                if (transfer.fromUserAccount) wallets.push(transfer.fromUserAccount);
                                if (transfer.toUserAccount) wallets.push(transfer.toUserAccount);
                            }
                        }

                        // Extract amount if available
                        let amount = 0;
                        if (event.tokenTransfers && event.tokenTransfers[0]) {
                            amount = parseFloat(event.tokenTransfers[0].tokenAmount) || 0;
                        }

                        // Detect actual DEX source from event (for relevance scoring)
                        const dexSource = detectDexSource(event);

                        // Feed signal to accumulator (FREE - no RPC cost)
                        try {
                            const result = await signalAccumulator.addSignal(mint, {
                                type: eventType,
                                wallets,
                                amount,
                                source: dexSource || source  // Use detected DEX, fallback to webhook source
                            });

                            if (result && result.judgment) {
                                const { action, preScore, reason } = result.judgment;

                                if (action === 'ACCEPT') {
                                    // Token passed 17-dimension judgment → Promote to queue
                                    // skipDbCheck: true because we already verified !exists at line 611-627
                                    const promoted = await promoteToQueue(mint, `judgment:${preScore}`, { skipDbCheck: true });
                                    if (promoted) {
                                        logger.info(`✅ [Judge] ${mint.slice(0, 8)} ACCEPTED (score: ${preScore}) → active queue`);
                                        stats.tokensDiscovered++;
                                        discovered++;
                                    }
                                } else if (action === 'REJECT') {
                                    // Token failed judgment → Don't queue
                                    logger.debug(`❌ [Judge] ${mint.slice(0, 8)} REJECTED: ${reason}`);
                                } else {
                                    // PENDING - needs more signals
                                    logger.debug(`⏳ [Judge] ${mint.slice(0, 8)} pending: ${reason}`);
                                }
                            }
                        } catch (_signalErr) {
                            // Fallback to simple SWAP-based logic if accumulator fails
                            if (eventType === 'SWAP') {
                                try {
                                    // skipDbCheck: true because we already verified !exists at line 611-627
                                    const promoted = await promoteToQueue(mint, 'swap_fallback', { skipDbCheck: true });
                                    if (promoted) {
                                        logger.info(`🚀 [${source}] SWAP fallback: ${mint.slice(0, 8)} → active queue`);
                                        stats.tokensDiscovered++;
                                        discovered++;
                                    }
                                } catch (promoteErr) {
                                    logger.warn(`[NewToken] Promote failed for ${mint.slice(0, 8)}: ${promoteErr.message}`);
                                }
                            } else {
                                // Fallback: queue for pending
                                try {
                                    await queueNewToken(mint, source);
                                } catch (queueErr) {
                                    logger.warn(`[NewToken] Queue failed for ${mint.slice(0, 8)}: ${queueErr.message}`);
                                }
                            }
                        }

                        // Add to grower scanner queue
                        if (redis) {
                            try {
                                await redis.sadd('pending_growers', JSON.stringify({
                                    mint,
                                    addedAt: Date.now(),
                                    source
                                }));
                            } catch (_e) { /* ignore */ }
                        }
                    } catch (mintErr) {
                        // Catch-all for any unexpected error processing this mint
                        logger.warn(`[NewToken] Mint processing error ${mint.slice(0, 8)}: ${mintErr.message}`);
                        stats.errors++;
                        // Continue processing other mints
                    }
                }
            }

            // Only log when we discover something (reduce noise)
            if (discovered > 0) {
                logger.info(`📥 [NewToken] Discovered: ${discovered}, Skipped: ${skipped}`);
            }

            res.status(200).json({
                received: true,
                discovered,
                skipped,
                stats: newTokenWebhook.getStats()
            });

        } catch (error) {
            // Only reaches here for catastrophic errors (parse failure, etc.)
            stats.errors++;
            logger.error(`[NewToken] Batch error: ${error.message}`);
            res.status(500).json({ error: sanitizeError(error) });
        }
    });

    /**
     * GET /webhook/new-tokens/stats
     * Get new token discovery statistics
     */
    router.get('/new-tokens/stats', (_req, res) => {
        res.json(newTokenWebhook.getStatsCopy());
    });

    /**
     * GET /webhook/queue/stats
     * Get token queue statistics for monitoring
     */
    router.get('/queue/stats', async (_req, res) => {
        try {
            const { getQueueStats } = require('../services/tokenQueue');
            const queueStats = await getQueueStats();

            if (!queueStats) {
                return res.json({
                    available: false,
                    message: 'Redis not connected'
                });
            }

            res.json({
                available: true,
                queue: queueStats,
                timestamp: Date.now()
            });
        } catch (err) {
            res.status(500).json({
                available: false,
                error: err.message
            });
        }
    });

    /**
     * GET /webhook/queue/debug
     * Debug endpoint to check Redis queue directly
     */
    router.get('/queue/debug', async (_req, res) => {
        try {
            const redis = getClient();
            if (!redis) {
                return res.json({ error: 'Redis not connected' });
            }

            // Get processor stats
            const { getProcessorStats } = require('../services/tokenQueue');
            const processorStats = getProcessorStats();

            // Check the actual data in Redis (Hybrid C+D design)
            const [
                pendingSize,        // Stage 1: Awaiting trade
                activeQueueSize,    // Stage 2: Promoted for processing
                processingSize,
                failedSize
            ] = await Promise.all([
                redis.scard('holdex:pending_mints'),
                redis.scard('holdex:new_token_queue'),
                redis.scard('holdex:processing_tokens'),
                redis.scard('holdex:failed_tokens')
            ]);

            // Sample pending mints (Stage 1)
            let pendingSample = [];
            try {
                pendingSample = await redis.srandmember('holdex:pending_mints', 3);
            } catch (e) {
                pendingSample = [`error: ${e.message}`];
            }

            // Sample active queue (Stage 2)
            let activeSample = [];
            try {
                activeSample = await redis.srandmember('holdex:new_token_queue', 3);
            } catch (e) {
                activeSample = [`error: ${e.message}`];
            }

            res.json({
                design: 'Hybrid C+D (Trade-Triggered + TTL)',
                processor: processorStats,
                redis: {
                    stage1_pending: pendingSize,     // Awaiting trade (TTL 30min)
                    stage2_active: activeQueueSize,  // Promoted for processing
                    processing: processingSize,
                    failed: failedSize,
                    samples: {
                        pending: pendingSample,
                        active: activeSample
                    }
                },
                timestamp: Date.now()
            });
        } catch (err) {
            res.status(500).json({ error: err.message, stack: err.stack });
        }
    });

    /**
     * POST /webhook/new-tokens/setup
     * Setup the new token discovery webhook with Helius
     * Requires admin authentication
     */
    router.post('/new-tokens/setup', async (req, res) => {
        try {
            // Simple admin check (should be more robust in production)
            const adminKey = req.headers['x-admin-password'];
            if (adminKey !== config.ADMIN_PASSWORD) {
                return res.status(401).json({ error: 'Admin access required' });
            }

            const callbackUrl = req.body.callbackUrl ||
                config.WEBHOOK_URL ||
                `${config.API_URL}/webhook/new-tokens`;

            const webhookId = await newTokenWebhook.getOrCreateNewTokenWebhook(db, callbackUrl);

            res.json({
                success: true,
                webhookId,
                callbackUrl,
                monitoring: ['Raydium V4', 'Pump.fun'],
                transactionTypes: newTokenWebhook.NEW_TOKEN_TX_TYPES
            });
        } catch (error) {
            logger.error(`[NewToken] Setup failed: ${error.message}`);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * PUT /webhook/new-tokens/update/:webhookId
     * Update existing webhook with new launchpad programs (Solana 2026)
     * Requires admin authentication
     *
     * Programs added:
     *   - Pump.fun, PumpSwap AMM
     *   - Raydium V4, LaunchLab, CLMM
     *   - Meteora DBC, DLMM
     *   - Moonshot, Orca Whirlpool
     */
    router.put('/new-tokens/update/:webhookId', async (req, res) => {
        try {
            const adminKey = req.headers['x-admin-password'];
            if (adminKey !== config.ADMIN_PASSWORD) {
                return res.status(401).json({ error: 'Admin access required' });
            }

            const { webhookId } = req.params;
            if (!webhookId) {
                return res.status(400).json({ error: 'webhookId required' });
            }

            await newTokenWebhook.updateWebhook(webhookId);

            res.json({
                success: true,
                webhookId,
                monitoring: Object.keys(newTokenWebhook.PROGRAMS),
                programCount: Object.keys(newTokenWebhook.PROGRAMS).length,
                transactionTypes: newTokenWebhook.NEW_TOKEN_TX_TYPES
            });
        } catch (error) {
            logger.error(`[NewToken] Update failed: ${error.message}`);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * GET /webhook/new-tokens/list
     * List all Helius webhooks (admin only)
     */
    router.get('/new-tokens/list', async (req, res) => {
        try {
            const adminKey = req.headers['x-admin-password'];
            if (adminKey !== config.ADMIN_PASSWORD) {
                return res.status(401).json({ error: 'Admin access required' });
            }

            const webhooks = await newTokenWebhook.listWebhooks();
            res.json({ success: true, webhooks });
        } catch (error) {
            logger.error(`[NewToken] List failed: ${error.message}`);
            res.status(500).json({ error: error.message });
        }
    });

    return router;
}

module.exports = { init };
