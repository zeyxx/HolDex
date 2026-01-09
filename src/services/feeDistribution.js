/**
 * FEE DISTRIBUTION SERVICE
 *
 * Bridge between GASdf fee collection and HolDex reward distribution.
 *
 * "Don't Trust, Verify" - Every fee is tracked, split, and distributed.
 *
 * Architecture:
 * 1. GASdf collects fees → sends webhook to HolDex
 * 2. HolDex tracks fee pool accumulation
 * 3. Periodic distribution to nodes/users based on E-Score
 *
 * φ Distribution (must match shared/harmony.js):
 *   38.2% (φ⁻²) → BURN (handled by GASdf)
 *   38.2% (φ⁻²) → REWARDS (distributed here)
 *   23.6% (φ⁻³) → TREASURY (handled by GASdf)
 *
 * Current State (GASdf v1):
 *   GASdf burns 76.4% + 23.6% treasury = 100% retained
 *   NO rewards distribution exists yet
 *
 * Target State (K-E-I-Φ aligned):
 *   GASdf notifies HolDex of fees → HolDex accumulates rewards pool
 *   Periodic distribution to E-Score participants
 *
 * Sefirot: Yesod (GASdf) → Hod (HolDex) flow
 */

'use strict';

const logger = require('./logger');
const _harmony = require('../shared/harmony');
const { getNodeRewardsManager } = require('./nodeRewards');
const { getHarmonyEngine } = require('./harmonyEngine');
const { getClient: getRedis } = require('./redis');

// φ Constants (must match harmony.js)
const PHI = 1.618033988749895;
const PHI_INV = 1 / PHI;                      // 0.618... (61.8%)
const PHI_INV_SQ = 1 / (PHI * PHI);           // 0.382... (38.2%)
const PHI_INV_CUBED = 1 / (PHI * PHI * PHI);  // 0.236... (23.6%)

// Distribution configuration
const DISTRIBUTION_CONFIG = Object.freeze({
    // Minimum pool size before distribution (in $ASDF base units)
    MIN_POOL_SIZE: 1000000000,  // 1000 $ASDF (9 decimals)

    // Distribution interval (milliseconds)
    DISTRIBUTION_INTERVAL_MS: 24 * 60 * 60 * 1000,  // 24 hours

    // Split of rewards pool (φ-based)
    SPLITS: Object.freeze({
        NODES: PHI_INV,           // 61.8% to node operators
        USERS: PHI_INV_CUBED,     // 23.6% to E-Score participants
        DEVS: 1 - PHI_INV - PHI_INV_CUBED  // ~14.6% to developers
    })
});

// In-memory pool tracking (backed by Redis)
let rewardsPool = {
    totalCollected: 0,
    totalDistributed: 0,
    currentPool: 0,
    lastDistribution: 0,
    feeEvents: []
};

class FeeDistributionService {
    constructor(db) {
        this.db = db;
        this.harmonyEngine = null;
        this.nodeRewardsManager = null;
        this.isRunning = false;
    }

    /**
     * Initialize the service
     */
    async initialize() {
        // Get dependent services
        this.harmonyEngine = getHarmonyEngine(this.db);
        this.nodeRewardsManager = getNodeRewardsManager(this.db);

        // Load pool state from Redis
        await this._loadPoolState();

        logger.info('[FeeDistribution] Service initialized', {
            currentPool: rewardsPool.currentPool,
            totalCollected: rewardsPool.totalCollected,
            totalDistributed: rewardsPool.totalDistributed
        });
    }

    /**
     * Load pool state from Redis
     */
    async _loadPoolState() {
        const redis = getRedis();
        if (!redis) return;

        try {
            const state = await redis.get('fee_distribution:pool_state');
            if (state) {
                rewardsPool = JSON.parse(state);
            }
        } catch (error) {
            logger.warn('[FeeDistribution] Failed to load pool state:', error.message);
        }
    }

    /**
     * Save pool state to Redis
     */
    async _savePoolState() {
        const redis = getRedis();
        if (!redis) return;

        try {
            await redis.set('fee_distribution:pool_state', JSON.stringify(rewardsPool));
        } catch (error) {
            logger.warn('[FeeDistribution] Failed to save pool state:', error.message);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // FEE COLLECTION (Called by webhook from GASdf)
    // ═══════════════════════════════════════════════════════════════

    /**
     * Record a fee collection event from GASdf
     *
     * GASdf sends this via webhook when fees are collected.
     * Only the REWARDS portion (38.2%) should be sent here.
     *
     * @param {Object} feeEvent - Fee event data
     * @param {string} feeEvent.txSignature - Transaction signature
     * @param {number} feeEvent.totalFee - Total fee collected (raw)
     * @param {number} feeEvent.rewardsShare - Share for rewards (should be 38.2%)
     * @param {string} feeEvent.userWallet - User who paid the fee
     * @param {string} feeEvent.paymentToken - Token used to pay
     * @param {number} feeEvent.timestamp - Event timestamp
     */
    async recordFeeCollection(feeEvent) {
        const {
            txSignature,
            totalFee,
            rewardsShare,
            userWallet,
            paymentToken,
            timestamp = Date.now()
        } = feeEvent;

        // Calculate rewards amount (38.2% of total)
        const rewardsAmount = rewardsShare || Math.floor(totalFee * PHI_INV_SQ);

        // Add to pool
        rewardsPool.currentPool += rewardsAmount;
        rewardsPool.totalCollected += rewardsAmount;

        // Track event
        rewardsPool.feeEvents.push({
            txSignature,
            amount: rewardsAmount,
            userWallet,
            paymentToken,
            timestamp
        });

        // Limit event history
        if (rewardsPool.feeEvents.length > 1000) {
            rewardsPool.feeEvents = rewardsPool.feeEvents.slice(-500);
        }

        // Persist state
        await this._savePoolState();

        // Record to database
        await this.db.query(`
            INSERT INTO fee_collections (
                tx_signature, total_fee, rewards_amount,
                user_wallet, payment_token, collected_at
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (tx_signature) DO NOTHING
        `, [txSignature, totalFee, rewardsAmount, userWallet, paymentToken, timestamp]);

        logger.info('[FeeDistribution] Fee recorded', {
            txSignature: txSignature?.slice(0, 16),
            totalFee,
            rewardsAmount,
            poolSize: rewardsPool.currentPool
        });

        // Check if we should trigger distribution
        if (this._shouldDistribute()) {
            // Run distribution in background
            this.distributeRewards().catch(err => {
                logger.error('[FeeDistribution] Background distribution failed:', err.message);
            });
        }

        return {
            recorded: true,
            rewardsAmount,
            currentPool: rewardsPool.currentPool
        };
    }

    /**
     * Check if distribution should be triggered
     */
    _shouldDistribute() {
        const timeSinceLastDistribution = Date.now() - rewardsPool.lastDistribution;
        const hasMinimumPool = rewardsPool.currentPool >= DISTRIBUTION_CONFIG.MIN_POOL_SIZE;
        const intervalPassed = timeSinceLastDistribution >= DISTRIBUTION_CONFIG.DISTRIBUTION_INTERVAL_MS;

        return hasMinimumPool && intervalPassed;
    }

    // ═══════════════════════════════════════════════════════════════
    // REWARD DISTRIBUTION
    // ═══════════════════════════════════════════════════════════════

    /**
     * Distribute accumulated rewards to participants
     *
     * Split by φ ratios:
     * - 61.8% to node operators (via nodeRewards)
     * - 23.6% to E-Score participants (via harmonyEngine)
     * - 14.6% to developers
     */
    async distributeRewards() {
        const poolToDistribute = rewardsPool.currentPool;

        if (poolToDistribute < DISTRIBUTION_CONFIG.MIN_POOL_SIZE) {
            logger.info('[FeeDistribution] Pool too small for distribution', {
                currentPool: poolToDistribute,
                minimum: DISTRIBUTION_CONFIG.MIN_POOL_SIZE
            });
            return null;
        }

        const periodStart = rewardsPool.lastDistribution || Date.now() - DISTRIBUTION_CONFIG.DISTRIBUTION_INTERVAL_MS;
        const periodEnd = Date.now();

        logger.info('[FeeDistribution] Starting reward distribution', {
            poolToDistribute,
            periodStart: new Date(periodStart).toISOString(),
            periodEnd: new Date(periodEnd).toISOString()
        });

        // Calculate splits
        const splits = {
            nodes: Math.floor(poolToDistribute * DISTRIBUTION_CONFIG.SPLITS.NODES),
            users: Math.floor(poolToDistribute * DISTRIBUTION_CONFIG.SPLITS.USERS),
            devs: Math.floor(poolToDistribute * DISTRIBUTION_CONFIG.SPLITS.DEVS)
        };

        const results = {
            total: poolToDistribute,
            splits,
            nodes: null,
            users: null,
            devs: null
        };

        // 1. Distribute to nodes (61.8%)
        if (splits.nodes > 0 && this.nodeRewardsManager) {
            try {
                results.nodes = await this.nodeRewardsManager.distributeNodeRewards(
                    splits.nodes,
                    periodStart,
                    periodEnd
                );
                logger.info('[FeeDistribution] Node rewards distributed', {
                    amount: splits.nodes,
                    recipients: results.nodes?.recipientCount || 0
                });
            } catch (error) {
                logger.error('[FeeDistribution] Node distribution failed:', error.message);
                results.nodes = { error: error.message };
            }
        }

        // 2. Distribute to users (23.6%)
        if (splits.users > 0 && this.harmonyEngine) {
            try {
                results.users = await this.harmonyEngine.distributeRewards(
                    splits.users,
                    periodStart,
                    periodEnd
                );
                logger.info('[FeeDistribution] User rewards distributed', {
                    amount: splits.users,
                    recipients: results.users?.recipients || 0
                });
            } catch (error) {
                logger.error('[FeeDistribution] User distribution failed:', error.message);
                results.users = { error: error.message };
            }
        }

        // 3. Record dev rewards (14.6%)
        if (splits.devs > 0) {
            try {
                await this._recordDevRewards(splits.devs, periodStart, periodEnd);
                results.devs = { amount: splits.devs, recorded: true };
                logger.info('[FeeDistribution] Dev rewards recorded', { amount: splits.devs });
            } catch (error) {
                logger.error('[FeeDistribution] Dev rewards recording failed:', error.message);
                results.devs = { error: error.message };
            }
        }

        // Update pool state
        rewardsPool.currentPool = 0;
        rewardsPool.totalDistributed += poolToDistribute;
        rewardsPool.lastDistribution = periodEnd;
        rewardsPool.feeEvents = [];

        await this._savePoolState();

        // Record distribution
        await this.db.query(`
            INSERT INTO fee_distributions (
                period_start, period_end, total_pool,
                nodes_amount, users_amount, devs_amount,
                nodes_recipients, users_recipients,
                distributed_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        `, [
            periodStart,
            periodEnd,
            poolToDistribute,
            splits.nodes,
            splits.users,
            splits.devs,
            results.nodes?.recipientCount || 0,
            results.users?.recipients || 0
        ]);

        logger.info('[FeeDistribution] Distribution complete', {
            total: poolToDistribute,
            nodesShare: splits.nodes,
            usersShare: splits.users,
            devsShare: splits.devs,
            nodesRecipients: results.nodes?.recipientCount || 0,
            usersRecipients: results.users?.recipients || 0
        });

        return results;
    }

    /**
     * Record dev rewards (accumulated for later claiming)
     */
    async _recordDevRewards(amount, periodStart, periodEnd) {
        // Dev rewards are accumulated in a special pool
        // They can be claimed by verified developers
        await this.db.query(`
            INSERT INTO dev_rewards_pool (
                amount, period_start, period_end, status
            )
            VALUES ($1, $2, $3, 'pending')
        `, [amount, periodStart, periodEnd]);
    }

    // ═══════════════════════════════════════════════════════════════
    // WORKER
    // ═══════════════════════════════════════════════════════════════

    /**
     * Start distribution worker
     */
    startWorker(intervalMs = 60 * 60 * 1000) {  // Default: hourly check
        if (this.isRunning) {
            logger.warn('[FeeDistribution] Worker already running');
            return;
        }

        this.isRunning = true;

        // Initial check after 30 seconds
        setTimeout(async () => {
            try {
                if (this._shouldDistribute()) {
                    await this.distributeRewards();
                }
            } catch (error) {
                logger.error('[FeeDistribution] Initial check failed:', error.message);
            }
        }, 30000);

        // Periodic checks
        this.workerInterval = setInterval(async () => {
            try {
                if (this._shouldDistribute()) {
                    await this.distributeRewards();
                }
            } catch (error) {
                logger.error('[FeeDistribution] Worker check failed:', error.message);
            }
        }, intervalMs);

        logger.info('[FeeDistribution] Worker started', {
            intervalMs,
            minPoolSize: DISTRIBUTION_CONFIG.MIN_POOL_SIZE,
            distributionInterval: DISTRIBUTION_CONFIG.DISTRIBUTION_INTERVAL_MS
        });
    }

    /**
     * Stop distribution worker
     */
    stopWorker() {
        if (this.workerInterval) {
            clearInterval(this.workerInterval);
            this.workerInterval = null;
        }
        this.isRunning = false;
        logger.info('[FeeDistribution] Worker stopped');
    }

    // ═══════════════════════════════════════════════════════════════
    // STATISTICS
    // ═══════════════════════════════════════════════════════════════

    /**
     * Get current pool status
     */
    getPoolStatus() {
        return {
            currentPool: rewardsPool.currentPool,
            totalCollected: rewardsPool.totalCollected,
            totalDistributed: rewardsPool.totalDistributed,
            lastDistribution: rewardsPool.lastDistribution,
            recentEvents: rewardsPool.feeEvents.slice(-10),
            nextDistribution: {
                eligible: this._shouldDistribute(),
                minimumMet: rewardsPool.currentPool >= DISTRIBUTION_CONFIG.MIN_POOL_SIZE,
                intervalPassed: Date.now() - rewardsPool.lastDistribution >= DISTRIBUTION_CONFIG.DISTRIBUTION_INTERVAL_MS,
                timeRemaining: Math.max(0,
                    DISTRIBUTION_CONFIG.DISTRIBUTION_INTERVAL_MS - (Date.now() - rewardsPool.lastDistribution)
                )
            },
            config: DISTRIBUTION_CONFIG
        };
    }

    /**
     * Get distribution history
     */
    async getDistributionHistory(limit = 10) {
        const result = await this.db.query(`
            SELECT *
            FROM fee_distributions
            ORDER BY distributed_at DESC
            LIMIT $1
        `, [limit]);

        return result.rows;
    }

    /**
     * Get fee collection history
     */
    async getFeeCollectionHistory(limit = 50) {
        const result = await this.db.query(`
            SELECT *
            FROM fee_collections
            ORDER BY collected_at DESC
            LIMIT $1
        `, [limit]);

        return result.rows;
    }

    /**
     * Get comprehensive stats
     */
    async getStats() {
        const [poolStatus, distributions, collections] = await Promise.all([
            this.getPoolStatus(),
            this.getDistributionHistory(5),
            this.db.query(`
                SELECT
                    COUNT(*) as total_collections,
                    SUM(rewards_amount) as total_rewards_collected,
                    AVG(rewards_amount) as avg_reward_per_tx,
                    MAX(collected_at) as last_collection
                FROM fee_collections
            `)
        ]);

        return {
            pool: poolStatus,
            recentDistributions: distributions,
            collectionStats: collections.rows[0],
            phi: {
                PHI,
                PHI_INV,
                PHI_INV_SQ,
                PHI_INV_CUBED,
                splits: DISTRIBUTION_CONFIG.SPLITS
            }
        };
    }
}

// Singleton pattern
let instance = null;

function getFeeDistributionService(db) {
    if (!instance && db) {
        instance = new FeeDistributionService(db);
    }
    return instance;
}

module.exports = {
    FeeDistributionService,
    getFeeDistributionService,
    DISTRIBUTION_CONFIG,
    // Export φ constants for consistency
    PHI,
    PHI_INV,
    PHI_INV_SQ,
    PHI_INV_CUBED
};
