/**
 * SYSTEM STATUS ROUTES
 *
 * Endpoints for monitoring system health and poller status.
 * Used by operators to verify the manual index paradigm is working.
 *
 * @module routes/system
 */

'use strict';

const express = require('express');
const router = express.Router();
const logger = require('../services/logger');
const { getClient: getRedis } = require('../services/redis');
const harmony = require('../shared/harmony');

let db = null;

/**
 * GET /system/health
 * Basic health check
 */
router.get('/health', async (_req, res) => {
    try {
        const redis = getRedis();
        const redisOk = redis ? await redis.ping() === 'PONG' : false;
        const dbOk = db ? await db.get('SELECT 1') : false;

        res.json({
            status: 'ok',
            timestamp: Date.now(),
            services: {
                database: !!dbOk,
                redis: redisOk
            }
        });
    } catch (err) {
        logger.error('[System] Health check failed:', err.message);
        res.status(500).json({
            status: 'error',
            error: err.message
        });
    }
});

/**
 * GET /system/poller
 * Get poller status from Redis (written by listener_worker)
 */
router.get('/poller', async (_req, res) => {
    try {
        const redis = getRedis();
        if (!redis) {
            return res.json({
                status: 'unknown',
                message: 'Redis not available',
                tip: 'Poller runs in separate worker process'
            });
        }

        // Read poller stats from Redis (written by tokenPoller)
        const statsRaw = await redis.get('poller:stats');
        const lastSignatures = await redis.mget(
            'poller:last_sig:RAYDIUM',
            'poller:last_sig:PUMP_FUN'
        );

        const stats = statsRaw ? JSON.parse(statsRaw) : null;

        res.json({
            mode: process.env.USE_WEBSOCKET_LISTENER === 'true' ? 'websocket' : 'polling',
            stats: stats || {
                message: 'No stats available yet',
                tip: 'Poller may still be starting'
            },
            lastSignatures: {
                RAYDIUM: lastSignatures[0] || null,
                PUMP_FUN: lastSignatures[1] || null
            },
            phi: {
                pollIntervalMs: Math.round(harmony.PHI_POWERS.PHI_INV_CUBED * 100 * 1000),
                batchSize: Math.round(harmony.PHI_POWERS.PHI_INV_SQ * 100)
            }
        });
    } catch (err) {
        logger.error('[System] Poller status check failed:', err.message);
        res.status(500).json({
            status: 'error',
            error: err.message
        });
    }
});

/**
 * GET /system/harmony
 * Get φ constants and ratios (verify alignment)
 */
router.get('/harmony', (_req, res) => {
    res.json({
        PHI: harmony.PHI,
        PHI_POWERS: harmony.PHI_POWERS,
        FEE_RATIOS: harmony.FEE_RATIOS,
        REWARD_SPLITS: harmony.REWARD_SPLITS,
        verification: {
            sumFeeRatios: harmony.FEE_RATIOS.BURN + harmony.FEE_RATIOS.REWARDS + harmony.FEE_RATIOS.TREASURY,
            sumRewardSplits: harmony.REWARD_SPLITS.NODES + harmony.REWARD_SPLITS.USERS + harmony.REWARD_SPLITS.DEVS,
            phiSquaredCheck: Math.abs(harmony.PHI * harmony.PHI - harmony.PHI_POWERS.PHI_SQ) < 1e-10
        }
    });
});

/**
 * GET /system/stats
 * Get comprehensive system statistics
 */
router.get('/stats', async (_req, res) => {
    try {
        const redis = getRedis();

        // Database stats
        const tokenCount = db ? await db.get('SELECT COUNT(*) as count FROM tokens') : null;
        const nodeCount = db ? await db.get('SELECT COUNT(*) as count FROM nodes WHERE status = $1', ['online']) : null;

        // Redis queue stats
        let pendingGrowers = 0;
        if (redis) {
            try {
                pendingGrowers = await redis.scard('pending_growers');
            } catch (_e) { /* ignore */ }
        }

        res.json({
            database: {
                tokens: tokenCount?.count || 0,
                onlineNodes: nodeCount?.count || 0
            },
            queues: {
                pendingGrowers
            },
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            timestamp: Date.now()
        });
    } catch (err) {
        logger.error('[System] Stats check failed:', err.message);
        res.status(500).json({
            status: 'error',
            error: err.message
        });
    }
});

/**
 * Initialize the router with dependencies
 */
function init({ db: database }) {
    db = database;
    return router;
}

module.exports = { init, router };
