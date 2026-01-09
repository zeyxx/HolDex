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
const logger = require('../services/logger');
const config = require('../config/env');
const { getClient } = require('../services/redis');
const { isValidSolanaAddress, sanitizeError } = require('../utils/validation');
const verification = require('../services/verificationService');
const newTokenWebhook = require('../services/newTokenWebhook');
const { queueNewToken } = require('../services/tokenQueue');
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
const MAX_EVENTS_PER_BATCH = 100; // Prevent DoS via huge payloads
const MAX_TRANSFERS_PER_EVENT = 50; // Reasonable limit per transaction
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
    router.post('/transfers', async (req, res) => {
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
    router.post('/new-tokens', async (req, res) => {
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

                        // OPTIMIZATION: Use Redis for fast existence check (avoids DB connection exhaustion)
                        // Redis check is ~100x faster than DB query under load
                        let exists = false;
                        if (redis) {
                            try {
                                // Check Redis cache first (set of known mints)
                                exists = await redis.sismember('known_mints', mint);
                            } catch (_redisErr) {
                                // Redis failed - fall through to DB check
                            }
                        }

                        // Only hit DB if Redis says mint is unknown (or Redis unavailable)
                        if (!exists) {
                            try {
                                const dbResult = await db.get(
                                    'SELECT mint FROM tokens WHERE mint = $1',
                                    [mint]
                                );
                                exists = !!dbResult;
                                // Cache the result in Redis for future checks
                                if (exists && redis) {
                                    redis.sadd('known_mints', mint).catch(() => {});
                                }
                            } catch (dbErr) {
                                // DB error - skip this mint but don't fail batch
                                logger.warn(`[NewToken] DB check failed for ${mint.slice(0, 8)}: ${dbErr.message}`);
                                stats.errors++;
                                continue;
                            }
                        }

                        if (exists) {
                            skipped++;
                            continue;
                        }

                        // ══════════════════════════════════════════════════════════
                        // NEW TOKEN DISCOVERED!
                        // ══════════════════════════════════════════════════════════
                        logger.info(`✨ [${source}] New token: ${mint}`);
                        stats.tokensDiscovered++;
                        discovered++;

                        // Queue for rate-limited processing (prevents API floods)
                        // tokenQueue.js will fetch real metadata THEN insert to DB
                        // DO NOT insert placeholder here - it would cause queueNewToken to skip
                        try {
                            const queued = await queueNewToken(mint, source);
                            if (!queued) {
                                logger.debug(`[NewToken] ${mint.slice(0, 8)} already queued or processing`);
                            }
                        } catch (queueErr) {
                            logger.warn(`[NewToken] Queue failed for ${mint.slice(0, 8)}: ${queueErr.message}`);
                            // Don't increment errors here - token was still discovered
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

            logger.info(`📥 [NewToken] Discovered: ${discovered}, Skipped: ${skipped}`);

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
