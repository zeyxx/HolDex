/**
 * NEW TOKEN DISCOVERY WEBHOOK
 *
 * Helius webhook pour détecter les nouveaux tokens.
 * Remplace le listener WebSocket coûteux.
 *
 * Architecture:
 *   Helius filtre CREATE_POOL + TOKEN_MINT → POST /webhook/new-tokens
 *   Coût: 1 credit par VRAI nouveau token (pas par transaction)
 *
 * Programmes surveillés:
 *   - Raydium AMM V4: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
 *   - Pump.fun: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 *
 * φ Design: Module indépendant, drop-in ready
 *
 * @module newTokenWebhook
 */

'use strict';

const crypto = require('crypto');
const config = require('../config/env');
const logger = require('./logger');
const { getClient: getRedis } = require('./redis');

const HELIUS_API_URL = 'https://api.helius.xyz/v0';
const WEBHOOK_TIMEOUT = 15000;

// ═══════════════════════════════════════════════════════════════
// LAUNCHPAD PROGRAMS (Solana 2025-2026)
// Updated: 2026-01-09
// Sources: Raydium Docs, Solscan, Bitquery APIs
// ═══════════════════════════════════════════════════════════════
const PROGRAMS = {
    // === TIER 1: Major Launchpads (>90% market share combined) ===
    PUMP_FUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',           // Pump.fun bonding curve
    PUMP_AMM: 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',           // PumpSwap AMM (graduated tokens)
    RAYDIUM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',        // Raydium AMM V4
    RAYDIUM_LAUNCHLAB: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',  // LaunchLab (BonkFun uses this)

    // === TIER 2: Growing Launchpads ===
    METEORA_DBC: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',        // Meteora Dynamic Bonding Curve (Believe uses this)
    METEORA_DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',       // Meteora DLMM pools
    MOONSHOT: 'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG',           // DEXScreener's Moonshot

    // === TIER 3: Other DEXes (for pool detection) ===
    ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',     // Orca Whirlpool (Wavebreak uses this)
    RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',      // Raydium Concentrated Liquidity
};

// Types de transactions pour nouveaux tokens
const NEW_TOKEN_TX_TYPES = [
    'CREATE_POOL',      // Raydium pool creation
    'TOKEN_MINT',       // SPL token mint
    'SWAP',             // First swap (Pump.fun launch)
];

// Adresses système à ignorer
const IGNORED_MINTS = new Set([
    'So11111111111111111111111111111111111111112',  // wSOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
    '11111111111111111111111111111111',              // System Program
]);

// ═══════════════════════════════════════════════════════════════
// HELIUS API
// ═══════════════════════════════════════════════════════════════

function getWebhookApiUrl(path = '') {
    if (!config.HELIUS_API_KEY) {
        throw new Error('HELIUS_API_KEY not configured');
    }
    return `${HELIUS_API_URL}/webhooks${path}?api-key=${config.HELIUS_API_KEY}`;
}

async function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Créer le webhook pour nouveaux tokens
 *
 * @param {string} callbackUrl - URL de callback (ex: https://holdex.xyz/webhook/new-tokens)
 * @returns {Promise<{webhookID: string}>}
 */
async function createNewTokenWebhook(callbackUrl) {
    logger.info('[NewTokenWebhook] Creating webhook for new token discovery...');

    // All launchpad programs to monitor (Solana 2025-2026)
    const monitoredPrograms = [
        // TIER 1: Major launchpads
        PROGRAMS.PUMP_FUN,
        PROGRAMS.PUMP_AMM,
        PROGRAMS.RAYDIUM_V4,
        PROGRAMS.RAYDIUM_LAUNCHLAB,
        // TIER 2: Growing launchpads
        PROGRAMS.METEORA_DBC,
        PROGRAMS.METEORA_DLMM,
        PROGRAMS.MOONSHOT,
        // TIER 3: Other DEXes
        PROGRAMS.ORCA_WHIRLPOOL,
        PROGRAMS.RAYDIUM_CLMM,
    ];

    logger.info(`[NewTokenWebhook] Monitoring ${monitoredPrograms.length} programs`);

    const response = await fetchWithTimeout(getWebhookApiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            webhookURL: callbackUrl,
            transactionTypes: NEW_TOKEN_TX_TYPES,
            accountAddresses: monitoredPrograms,
            webhookType: 'enhanced',
            encoding: 'jsonParsed'
        })
    });

    if (!response.ok) {
        const error = await response.text();
        logger.error(`[NewTokenWebhook] Creation failed: ${error}`);
        throw new Error(`Webhook creation failed: ${error}`);
    }

    const data = await response.json();
    logger.info(`[NewTokenWebhook] Created: ${data.webhookID}`);
    logger.info(`[NewTokenWebhook] Monitoring: Raydium V4 + Pump.fun`);
    logger.info(`[NewTokenWebhook] Transaction types: ${NEW_TOKEN_TX_TYPES.join(', ')}`);

    return data;
}

/**
 * Lister les webhooks existants
 */
async function listWebhooks() {
    const response = await fetchWithTimeout(getWebhookApiUrl());
    if (!response.ok) {
        throw new Error(`List webhooks failed: ${await response.text()}`);
    }
    return await response.json();
}

/**
 * Mettre à jour un webhook existant avec les nouveaux programmes
 */
async function updateWebhook(webhookId) {
    logger.info(`[NewTokenWebhook] Updating webhook ${webhookId} with new programs...`);

    const monitoredPrograms = [
        PROGRAMS.PUMP_FUN,
        PROGRAMS.PUMP_AMM,
        PROGRAMS.RAYDIUM_V4,
        PROGRAMS.RAYDIUM_LAUNCHLAB,
        PROGRAMS.METEORA_DBC,
        PROGRAMS.METEORA_DLMM,
        PROGRAMS.MOONSHOT,
        PROGRAMS.ORCA_WHIRLPOOL,
        PROGRAMS.RAYDIUM_CLMM,
    ];

    const response = await fetchWithTimeout(getWebhookApiUrl(`/${webhookId}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            accountAddresses: monitoredPrograms,
            transactionTypes: NEW_TOKEN_TX_TYPES,
        })
    });

    if (!response.ok) {
        const error = await response.text();
        logger.error(`[NewTokenWebhook] Update failed: ${error}`);
        throw new Error(`Webhook update failed: ${error}`);
    }

    const data = await response.json();
    logger.info(`[NewTokenWebhook] Updated! Now monitoring ${monitoredPrograms.length} programs`);
    return data;
}

/**
 * Supprimer un webhook
 */
async function deleteWebhook(webhookId) {
    const response = await fetchWithTimeout(getWebhookApiUrl(`/${webhookId}`), {
        method: 'DELETE'
    });
    if (!response.ok) {
        throw new Error(`Delete webhook failed: ${await response.text()}`);
    }
    logger.info(`[NewTokenWebhook] Deleted: ${webhookId}`);
    return true;
}

/**
 * Trouver ou créer le webhook new-tokens
 */
async function getOrCreateNewTokenWebhook(db, callbackUrl) {
    // Vérifier si existe déjà
    const existing = await db.get(
        "SELECT webhook_id FROM webhooks WHERE mint = $1",
        ['_new_tokens']
    );

    if (existing) {
        logger.info(`[NewTokenWebhook] Using existing: ${existing.webhook_id}`);
        return existing.webhook_id;
    }

    // Créer nouveau
    const webhook = await createNewTokenWebhook(callbackUrl);

    // Sauvegarder référence
    await db.run(`
        INSERT INTO webhooks (id, mint, webhook_id, created_at)
        VALUES ($1, $2, $3, $4)
    `, ['_new_tokens', '_new_tokens', webhook.webhookID, Date.now()]);

    return webhook.webhookID;
}

// ═══════════════════════════════════════════════════════════════
// EVENT PROCESSING
// ═══════════════════════════════════════════════════════════════

/**
 * Extraire les mints candidats d'un événement Helius
 */
function extractMintsFromEvent(event) {
    const mints = new Set();

    // Token transfers contiennent les mints
    if (event.tokenTransfers) {
        event.tokenTransfers.forEach(t => {
            if (t.mint && !IGNORED_MINTS.has(t.mint)) {
                mints.add(t.mint);
            }
        });
    }

    // Account data peut contenir des mints
    if (event.accountData) {
        event.accountData.forEach(acc => {
            if (acc.tokenBalanceChanges) {
                acc.tokenBalanceChanges.forEach(change => {
                    if (change.mint && !IGNORED_MINTS.has(change.mint)) {
                        mints.add(change.mint);
                    }
                });
            }
        });
    }

    // Instructions peuvent contenir des mints
    // Check all monitored launchpad programs
    const LAUNCHPAD_PROGRAMS = new Set([
        PROGRAMS.PUMP_FUN,
        PROGRAMS.PUMP_AMM,
        PROGRAMS.RAYDIUM_V4,
        PROGRAMS.RAYDIUM_LAUNCHLAB,
        PROGRAMS.RAYDIUM_CLMM,
        PROGRAMS.METEORA_DBC,
        PROGRAMS.METEORA_DLMM,
        PROGRAMS.MOONSHOT,
        PROGRAMS.ORCA_WHIRLPOOL,
    ]);

    if (event.instructions) {
        event.instructions.forEach(ix => {
            // Extract accounts from any monitored launchpad program
            if (LAUNCHPAD_PROGRAMS.has(ix.programId)) {
                ix.accounts?.forEach(acc => {
                    if (acc && !IGNORED_MINTS.has(acc) && acc.length >= 32 && acc.length <= 44) {
                        mints.add(acc);
                    }
                });
            }
        });
    }

    return Array.from(mints);
}

/**
 * Déterminer la source du token (launchpad/DEX)
 * Updated 2026-01-09 for all major Solana launchpads
 */
function detectSource(event) {
    const programIds = new Set();

    if (event.instructions) {
        event.instructions.forEach(ix => {
            programIds.add(ix.programId);
        });
    }

    // Check in priority order (most specific first)
    if (programIds.has(PROGRAMS.PUMP_FUN)) return 'Pump.fun';
    if (programIds.has(PROGRAMS.PUMP_AMM)) return 'PumpSwap';
    if (programIds.has(PROGRAMS.RAYDIUM_LAUNCHLAB)) return 'LaunchLab';
    if (programIds.has(PROGRAMS.RAYDIUM_V4)) return 'Raydium';
    if (programIds.has(PROGRAMS.RAYDIUM_CLMM)) return 'Raydium-CLMM';
    if (programIds.has(PROGRAMS.METEORA_DBC)) return 'Meteora-DBC';
    if (programIds.has(PROGRAMS.METEORA_DLMM)) return 'Meteora';
    if (programIds.has(PROGRAMS.MOONSHOT)) return 'Moonshot';
    if (programIds.has(PROGRAMS.ORCA_WHIRLPOOL)) return 'Orca';

    return 'Unknown';
}

/**
 * Vérifier signature webhook (sécurité)
 */
function verifySignature(payload, signature, secret) {
    if (!signature || !secret) return false;

    try {
        const expected = crypto
            .createHmac('sha256', secret)
            .update(payload, 'utf8')
            .digest('hex');

        return crypto.timingSafeEqual(
            Buffer.from(signature, 'hex'),
            Buffer.from(expected, 'hex')
        );
    } catch (_e) {
        return false;
    }
}

/**
 * Check replay attack (Redis)
 */
async function isReplayAttack(signature) {
    const redis = getRedis();
    if (!redis) return false;

    const key = `newtoken:sig:${signature}`;
    const isNew = await redis.set(key, '1', 'EX', 300, 'NX');
    return !isNew; // true si déjà vu
}

// ═══════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════

const stats = {
    eventsReceived: 0,
    tokensDiscovered: 0,
    duplicatesSkipped: 0,
    errors: 0,
    lastEventTime: 0
};

function getStats() {
    // Return reference for direct mutation in route handlers
    return stats;
}

function getStatsCopy() {
    // Return copy for external reads (API responses)
    return { ...stats };
}

function resetStats() {
    stats.eventsReceived = 0;
    stats.tokensDiscovered = 0;
    stats.duplicatesSkipped = 0;
    stats.errors = 0;
}

// ═══════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════

module.exports = {
    // Webhook management
    createNewTokenWebhook,
    getOrCreateNewTokenWebhook,
    listWebhooks,
    updateWebhook,
    deleteWebhook,

    // Event processing
    extractMintsFromEvent,
    detectSource,
    verifySignature,
    isReplayAttack,

    // Stats
    getStats,
    getStatsCopy,
    resetStats,

    // Constants
    PROGRAMS,
    NEW_TOKEN_TX_TYPES,
    IGNORED_MINTS
};
