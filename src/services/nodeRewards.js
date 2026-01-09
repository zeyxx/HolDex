/**
 * NODE REWARDS SERVICE
 *
 * "Those who verify, shall be rewarded."
 *
 * Distributes 38.2% of collected fees to nodes based on their E-Score.
 * Nodes earn E-Score through the RUN dimension (weight = phi^2 = 2.618).
 *
 * Architecture aligned with $asdfasdfa philosophy:
 * - Nodes are Hod (Splendeur) - analytical intellect
 * - Their work (K-Score verification, consensus) deserves phi^2 multiplier
 * - Distribution follows phi ratios (38.2% of total fees)
 *
 * @version 1.0.0
 * @license MIT
 */

'use strict';

const logger = require('./logger');
const harmony = require('../shared/harmony');
const _genesis = require('../config/genesis');

// Constants
const PHI = 1.618033988749895;
const _PHI_SQ = PHI * PHI;                    // 2.618 - node work weight
const PHI_INV = 1 / PHI;                     // 0.618 - nodes share of rewards
const PHI_INV_CUBED = 1 / (PHI * PHI * PHI); // 0.236 - users share

// Reward distribution within the 38.2% rewards pool
const NODE_REWARDS_DISTRIBUTION = Object.freeze({
    NODES: PHI_INV,              // 61.8% of rewards pool -> nodes
    USERS: PHI_INV_CUBED,        // 23.6% of rewards pool -> users (E-Score based)
    DEVS: 1 - PHI_INV - PHI_INV_CUBED  // ~14.6% of rewards pool -> devs
});

// Minimum thresholds
const MIN_VERIFICATIONS_FOR_REWARD = 10;   // Minimum verifications per epoch
const MIN_UPTIME_FOR_REWARD = 0.618;       // Minimum uptime (phi^-1)
const REWARD_EPOCH_HOURS = 24;             // Distribution frequency

/**
 * Node Rewards Manager
 */
class NodeRewardsManager {
    constructor(db) {
        this.db = db;
    }

    // ═══════════════════════════════════════════════════════════════
    // NODE REGISTRATION AS PARTICIPANTS
    // ═══════════════════════════════════════════════════════════════

    /**
     * Register a node as a participant in the E-Score system
     * This enables nodes to receive rewards based on their work
     *
     * @param {string} nodeId - Node ID
     * @param {Object} nodeData - Node metadata
     * @returns {Object} Registration result
     */
    async registerNodeAsParticipant(nodeId, _nodeData = {}) {
        try {
            // Check if node exists in nodes table
            const nodeResult = await this.db.query(
                'SELECT * FROM nodes WHERE node_id = $1',
                [nodeId]
            );

            if (nodeResult.rows.length === 0) {
                return { success: false, error: 'Node not found in nodes table' };
            }

            const node = nodeResult.rows[0];

            // Check if already a participant
            const existingParticipant = await this.db.query(
                'SELECT wallet FROM participants WHERE wallet = $1',
                [nodeId]
            );

            const now = Date.now();

            if (existingParticipant.rows.length > 0) {
                // Update existing participant with node data
                await this.db.query(`
                    UPDATE participants SET
                        type = 'infra',
                        nodes_active = 1,
                        last_activity_at = NOW()
                    WHERE wallet = $1
                `, [nodeId]);

                logger.info(`[NodeRewards] Updated node ${nodeId} as participant`);
            } else {
                // Create new participant for node
                await this.db.query(`
                    INSERT INTO participants (
                        wallet, type, nodes_active,
                        first_activity_at, last_activity_at
                    )
                    VALUES ($1, 'infra', 1, NOW(), NOW())
                `, [nodeId]);

                logger.info(`[NodeRewards] Registered node ${nodeId} as new participant`);
            }

            return {
                success: true,
                nodeId,
                isGenesis: node.is_genesis,
                registeredAt: now
            };
        } catch (error) {
            logger.error(`[NodeRewards] Registration failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    /**
     * Sync all approved nodes to participants table
     * Should be called on startup and periodically
     */
    async syncAllNodesToParticipants() {
        try {
            // Get all approved nodes
            const nodesResult = await this.db.query(`
                SELECT node_id, name, is_genesis, approval_status
                FROM nodes
                WHERE (approval_status = 'approved' OR is_genesis = TRUE)
                  AND status IN ('active', 'degraded')
            `);

            let synced = 0;
            let errors = 0;

            for (const node of nodesResult.rows) {
                const result = await this.registerNodeAsParticipant(node.node_id, node);
                if (result.success) {
                    synced++;
                } else {
                    errors++;
                }
            }

            logger.info(`[NodeRewards] Synced ${synced} nodes to participants (${errors} errors)`);
            return { synced, errors, total: nodesResult.rows.length };
        } catch (error) {
            logger.error(`[NodeRewards] Sync failed: ${error.message}`);
            return { synced: 0, errors: 1, error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // WORK TRACKING
    // ═══════════════════════════════════════════════════════════════

    /**
     * Record node work as E-Score contribution
     * Called after each verification
     *
     * @param {string} nodeId - Node ID
     * @param {string} workType - Type of work (verification, consensus, heartbeat)
     * @param {Object} metadata - Work metadata
     */
    async recordNodeWork(nodeId, workType, metadata = {}) {
        try {
            // Map work type to contribution
            const workWeights = {
                'verification': 1.0,          // Standard verification
                'consensus': PHI,              // Participating in consensus (higher value)
                'heartbeat': 0.01,             // Small credit for uptime
                'k_score_calculation': 1.5     // Calculating K-Score
            };

            const weight = workWeights[workType] || 1.0;

            // Record as contribution
            await this.db.query(`
                INSERT INTO contributions (wallet, type, amount, source, details)
                VALUES ($1, 'run', $2, 'node_work', $3)
            `, [
                nodeId,
                weight,
                JSON.stringify({ workType, ...metadata })
            ]);

            // Update participant's nodes_active counter
            // (keeps track of cumulative work, not just active nodes)
            await this.db.query(`
                UPDATE participants SET
                    last_activity_at = NOW()
                WHERE wallet = $1
            `, [nodeId]);

        } catch (error) {
            // Non-critical, just log
            logger.debug(`[NodeRewards] Work recording failed: ${error.message}`);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // REWARD CALCULATION
    // ═══════════════════════════════════════════════════════════════

    /**
     * Calculate node E-Score based on their work
     * Focuses on RUN dimension (phi^2 multiplier)
     *
     * @param {string} nodeId - Node ID
     * @returns {Object} Node E-Score details
     */
    async calculateNodeEScore(nodeId) {
        try {
            // Get node stats from nodes table
            const nodeResult = await this.db.query(`
                SELECT
                    n.node_id,
                    n.tokens_verified,
                    n.verifications_24h,
                    n.consensus_rate,
                    n.is_genesis,
                    n.joined_at,
                    n.last_heartbeat,
                    n.status,
                    p.total_burned,
                    p.api_calls_30d,
                    p.holdings
                FROM nodes n
                LEFT JOIN participants p ON n.node_id = p.wallet
                WHERE n.node_id = $1
            `, [nodeId]);

            if (nodeResult.rows.length === 0) {
                return { score: 0, error: 'Node not found' };
            }

            const node = nodeResult.rows[0];

            // Calculate uptime (last_heartbeat to now)
            const now = Date.now();
            const uptimeHours = node.last_heartbeat
                ? Math.max(0, (now - node.last_heartbeat) / (60 * 60 * 1000))
                : 24;
            const uptime = Math.max(0, 1 - (uptimeHours / 24)); // 1.0 = online, 0 = offline 24h

            // Days active since joining
            const daysActive = node.joined_at
                ? Math.floor((now - node.joined_at) / (24 * 60 * 60 * 1000))
                : 0;

            // Calculate E-Score using harmony module
            const eScoreResult = harmony.calculateEScore({
                holdings: Number(node.holdings) || 0,
                burned: Number(node.total_burned) || 0,
                apiCalls30d: Number(node.api_calls_30d) || 0,
                appsLive: 0,                                    // Nodes don't have apps
                nodesActive: node.status === 'active' ? 1 : 0,  // RUN dimension!
                referralsActive: 0,
                daysActive
            });

            // Add work bonus based on verifications
            const workBonus = Math.log(1 + (node.tokens_verified || 0)) * 0.5;
            const consensusBonus = (node.consensus_rate || 0) * PHI;
            const uptimeBonus = uptime * PHI;

            // Genesis nodes get a small bonus (they bootstrap the network)
            const genesisBonus = node.is_genesis ? 5 : 0;

            const totalScore = eScoreResult.score + workBonus + consensusBonus + uptimeBonus + genesisBonus;

            return {
                nodeId,
                baseScore: eScoreResult.score,
                workBonus: Math.round(workBonus * 100) / 100,
                consensusBonus: Math.round(consensusBonus * 100) / 100,
                uptimeBonus: Math.round(uptimeBonus * 100) / 100,
                genesisBonus,
                totalScore: Math.round(totalScore * 100) / 100,
                breakdown: eScoreResult.breakdown,
                tier: harmony.getTier(totalScore),
                stats: {
                    tokensVerified: node.tokens_verified,
                    verifications24h: node.verifications_24h,
                    consensusRate: node.consensus_rate,
                    uptime: Math.round(uptime * 100) / 100,
                    daysActive,
                    isGenesis: node.is_genesis
                }
            };
        } catch (error) {
            logger.error(`[NodeRewards] E-Score calculation failed: ${error.message}`);
            return { score: 0, error: error.message };
        }
    }

    /**
     * Calculate rewards for all active nodes
     * @param {number} totalRewardPool - Total $ASDF to distribute to nodes
     * @returns {Array} Reward allocations per node
     */
    async calculateNodeRewards(totalRewardPool) {
        if (totalRewardPool <= 0) {
            return [];
        }

        try {
            // Get all active/approved nodes
            const nodesResult = await this.db.query(`
                SELECT node_id
                FROM nodes
                WHERE (approval_status = 'approved' OR is_genesis = TRUE)
                  AND status IN ('active', 'degraded')
            `);

            if (nodesResult.rows.length === 0) {
                return [];
            }

            // Calculate E-Score for each node
            const nodeScores = [];
            let totalEScore = 0;

            for (const { node_id } of nodesResult.rows) {
                const scoreResult = await this.calculateNodeEScore(node_id);
                if (scoreResult.totalScore > 0) {
                    nodeScores.push({
                        nodeId: node_id,
                        ...scoreResult
                    });
                    totalEScore += scoreResult.totalScore;
                }
            }

            if (totalEScore <= 0) {
                return [];
            }

            // Calculate pro-rata rewards
            const rewards = nodeScores.map(node => {
                const share = node.totalScore / totalEScore;
                const reward = totalRewardPool * share;

                return {
                    nodeId: node.nodeId,
                    eScore: node.totalScore,
                    share: Math.round(share * 10000) / 100, // Percentage
                    reward: Math.round(reward * 100000000) / 100000000, // 8 decimals
                    tier: node.tier,
                    isGenesis: node.stats.isGenesis
                };
            });

            // Sort by reward descending
            rewards.sort((a, b) => b.reward - a.reward);

            return rewards;
        } catch (error) {
            logger.error(`[NodeRewards] Reward calculation failed: ${error.message}`);
            return [];
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // REWARD DISTRIBUTION
    // ═══════════════════════════════════════════════════════════════

    /**
     * Distribute rewards to nodes
     * Called periodically (default: every 24 hours)
     *
     * @param {number} totalFeesCollected - Total fees collected this epoch
     * @returns {Object} Distribution result
     */
    async distributeNodeRewards(totalFeesCollected) {
        if (totalFeesCollected <= 0) {
            return { distributed: 0, recipients: 0, error: 'No fees to distribute' };
        }

        const epochStart = Date.now() - (REWARD_EPOCH_HOURS * 60 * 60 * 1000);
        const epochEnd = Date.now();

        try {
            // Calculate pools using phi ratios
            const feeDistribution = harmony.distributeFee(totalFeesCollected);
            const rewardsPool = feeDistribution.rewards; // 38.2% of total

            // Split rewards pool: 61.8% to nodes, 23.6% to users, 14.6% to devs
            const nodePool = rewardsPool * NODE_REWARDS_DISTRIBUTION.NODES;
            const userPool = rewardsPool * NODE_REWARDS_DISTRIBUTION.USERS;
            const devPool = rewardsPool * NODE_REWARDS_DISTRIBUTION.DEVS;

            logger.info(`[NodeRewards] Distributing: ${nodePool.toFixed(4)} $ASDF to nodes (from ${rewardsPool.toFixed(4)} total rewards)`);

            // Calculate node rewards
            const nodeRewards = await this.calculateNodeRewards(nodePool);

            if (nodeRewards.length === 0) {
                logger.warn('[NodeRewards] No eligible nodes for rewards');
                return { distributed: 0, recipients: 0 };
            }

            // Credit rewards to nodes (as participants)
            let totalDistributed = 0;

            for (const reward of nodeRewards) {
                if (reward.reward < 0.00000001) continue; // Skip dust

                // Update participant rewards
                await this.db.query(`
                    UPDATE participants SET
                        rewards_pending = rewards_pending + $1,
                        rewards_lifetime = rewards_lifetime + $1
                    WHERE wallet = $2
                `, [reward.reward, reward.nodeId]);

                totalDistributed += reward.reward;
            }

            // Record distribution
            await this.db.query(`
                INSERT INTO reward_distributions (
                    period_start, period_end, total_fees_collected, total_pool,
                    burn_amount, rewards_amount, treasury_amount,
                    recipients_count, total_e_score, distribution_type
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'node_rewards')
            `, [
                epochStart,
                epochEnd,
                totalFeesCollected,
                feeDistribution.total,
                feeDistribution.burn,
                nodePool,
                feeDistribution.treasury,
                nodeRewards.length,
                nodeRewards.reduce((sum, n) => sum + n.eScore, 0)
            ]);

            logger.info(`[NodeRewards] Distributed ${totalDistributed.toFixed(8)} $ASDF to ${nodeRewards.length} nodes`);

            return {
                totalFees: totalFeesCollected,
                burn: feeDistribution.burn,
                nodePool,
                userPool,
                devPool,
                treasury: feeDistribution.treasury,
                distributed: totalDistributed,
                recipients: nodeRewards.length,
                topRecipients: nodeRewards.slice(0, 5),
                epochStart,
                epochEnd
            };
        } catch (error) {
            logger.error(`[NodeRewards] Distribution failed: ${error.message}`);
            return { distributed: 0, recipients: 0, error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // CLAIM MECHANISM
    // ═══════════════════════════════════════════════════════════════

    /**
     * Get pending rewards for a node
     * @param {string} nodeId - Node ID
     * @returns {Object} Pending rewards info
     */
    async getPendingRewards(nodeId) {
        try {
            const result = await this.db.query(`
                SELECT
                    wallet,
                    rewards_pending,
                    rewards_lifetime,
                    rewards_claimed
                FROM participants
                WHERE wallet = $1
            `, [nodeId]);

            if (result.rows.length === 0) {
                return { pending: 0, lifetime: 0, claimed: 0 };
            }

            const p = result.rows[0];
            return {
                nodeId,
                pending: Number(p.rewards_pending) || 0,
                lifetime: Number(p.rewards_lifetime) || 0,
                claimed: Number(p.rewards_claimed) || 0
            };
        } catch (error) {
            logger.error(`[NodeRewards] Get pending failed: ${error.message}`);
            return { pending: 0, error: error.message };
        }
    }

    /**
     * Mark rewards as claimed (after on-chain transfer)
     * @param {string} nodeId - Node ID
     * @param {number} amount - Amount claimed
     * @param {string} txSignature - Solana transaction signature
     * @returns {Object} Claim result
     */
    async markRewardsClaimed(nodeId, amount, txSignature) {
        try {
            // Verify pending amount
            const pending = await this.getPendingRewards(nodeId);
            if (pending.pending < amount) {
                return { success: false, error: 'Insufficient pending rewards' };
            }

            // Update participant
            await this.db.query(`
                UPDATE participants SET
                    rewards_pending = rewards_pending - $1,
                    rewards_claimed = rewards_claimed + $1,
                    last_claim_at = NOW()
                WHERE wallet = $2
            `, [amount, nodeId]);

            // Record claim
            await this.db.query(`
                INSERT INTO reward_claims (
                    wallet, amount, tx_signature, claimed_at
                )
                VALUES ($1, $2, $3, NOW())
            `, [nodeId, amount, txSignature]);

            logger.info(`[NodeRewards] Claimed ${amount} $ASDF by ${nodeId}: ${txSignature}`);

            return {
                success: true,
                nodeId,
                amount,
                txSignature,
                remainingPending: pending.pending - amount
            };
        } catch (error) {
            logger.error(`[NodeRewards] Claim failed: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // LEADERBOARD & STATS
    // ═══════════════════════════════════════════════════════════════

    /**
     * Get node rewards leaderboard
     * @param {number} limit - Max results
     * @returns {Array} Ranked nodes by rewards
     */
    async getNodeLeaderboard(limit = 20) {
        try {
            const result = await this.db.query(`
                SELECT
                    n.node_id,
                    n.name,
                    n.is_genesis,
                    n.tokens_verified,
                    n.verifications_24h,
                    n.consensus_rate,
                    n.status,
                    p.rewards_lifetime,
                    p.rewards_pending,
                    p.e_score,
                    p.tier
                FROM nodes n
                LEFT JOIN participants p ON n.node_id = p.wallet
                WHERE (n.approval_status = 'approved' OR n.is_genesis = TRUE)
                ORDER BY COALESCE(p.rewards_lifetime, 0) DESC
                LIMIT $1
            `, [limit]);

            return result.rows.map((row, index) => ({
                rank: index + 1,
                nodeId: row.node_id,
                name: row.name,
                isGenesis: row.is_genesis,
                tokensVerified: row.tokens_verified,
                consensusRate: row.consensus_rate,
                status: row.status,
                rewardsLifetime: Number(row.rewards_lifetime) || 0,
                rewardsPending: Number(row.rewards_pending) || 0,
                eScore: Number(row.e_score) || 0,
                tier: row.tier
            }));
        } catch (error) {
            logger.error(`[NodeRewards] Leaderboard failed: ${error.message}`);
            return [];
        }
    }

    /**
     * Get overall node rewards stats
     * @returns {Object} Aggregate statistics
     */
    async getNodeRewardsStats() {
        try {
            const stats = await this.db.query(`
                SELECT
                    COUNT(*) FILTER (WHERE n.status = 'active') as active_nodes,
                    COUNT(*) FILTER (WHERE n.is_genesis = TRUE) as genesis_nodes,
                    SUM(n.tokens_verified) as total_verifications,
                    SUM(p.rewards_lifetime) as total_rewards_distributed,
                    SUM(p.rewards_pending) as total_rewards_pending,
                    AVG(p.e_score) FILTER (WHERE p.e_score > 0) as avg_e_score
                FROM nodes n
                LEFT JOIN participants p ON n.node_id = p.wallet
                WHERE (n.approval_status = 'approved' OR n.is_genesis = TRUE)
            `);

            const distributions = await this.db.query(`
                SELECT COUNT(*) as count, SUM(rewards_amount) as total
                FROM reward_distributions
                WHERE distribution_type = 'node_rewards'
            `);

            const row = stats.rows[0];
            const dist = distributions.rows[0];

            return {
                activeNodes: parseInt(row.active_nodes) || 0,
                genesisNodes: parseInt(row.genesis_nodes) || 0,
                totalVerifications: parseInt(row.total_verifications) || 0,
                totalRewardsDistributed: Number(row.total_rewards_distributed) || 0,
                totalRewardsPending: Number(row.total_rewards_pending) || 0,
                avgEScore: Number(row.avg_e_score) || 0,
                distributionCount: parseInt(dist.count) || 0,
                distributionTotal: Number(dist.total) || 0
            };
        } catch (error) {
            logger.error(`[NodeRewards] Stats failed: ${error.message}`);
            return { error: error.message };
        }
    }
}

// Singleton
let instance = null;

function getNodeRewardsManager(db) {
    if (!instance && db) {
        instance = new NodeRewardsManager(db);
    }
    return instance;
}

module.exports = {
    NodeRewardsManager,
    getNodeRewardsManager,
    NODE_REWARDS_DISTRIBUTION,
    MIN_VERIFICATIONS_FOR_REWARD,
    MIN_UPTIME_FOR_REWARD,
    REWARD_EPOCH_HOURS
};
