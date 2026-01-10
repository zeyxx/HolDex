/**
 * SIGNAL ACCUMULATOR - φ-aligned Pre-Judgment System
 *
 * Accumulates webhook signals (FREE) to decide if token deserves RPC credit.
 *
 * Architecture:
 *   Redis (hot)  ←→  PostgreSQL (cold)
 *   Fast lookups     Persistence + Recovery
 *
 * Privacy: All wallet addresses are SHA256 hashed before storage.
 *
 * "Don't trust, verify" - but efficiently.
 */

'use strict';

const crypto = require('crypto');
const { getClient } = require('./redis');
const { getDB } = require('./database');
const logger = require('./logger');

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS - φ aligned
// ═══════════════════════════════════════════════════════════════════════════

const PHI = 1.618033988749895;
const PHI_SQ = PHI * PHI;      // 2.618
const PHI_CUBE = PHI * PHI * PHI; // 4.236

// Redis keys
const SIGNAL_PREFIX = 'holdex:signals:';
const SIGNAL_SET = 'holdex:signal_mints';

// Thresholds
const ACCEPT_THRESHOLD = 80;
const PENDING_THRESHOLD = 50;
const MIN_SIGNALS_FOR_JUDGMENT = 3;
const MIN_TIME_SPREAD_MS = 60000; // 1 minute minimum

// Sync intervals
const PERSIST_INTERVAL_MS = 30000; // Sync to PostgreSQL every 30s
const CLEANUP_INTERVAL_MS = 300000; // Cleanup expired every 5min
const NODE_SYNC_INTERVAL_MS = 10000; // Sync signals between nodes every 10s

// Multi-node configuration
const NODE_ID = process.env.HOLDEX_NODE_ID || `node-${crypto.randomBytes(4).toString('hex')}`;
const REGISTERED_NODES_KEY = 'holdex:registered_nodes';
const NODE_SIGNALS_PREFIX = 'holdex:node_signals:'; // Per-node signal contributions

// ═══════════════════════════════════════════════════════════════════════════
// PRIVACY - Hash all wallet addresses
// ═══════════════════════════════════════════════════════════════════════════

function hashWallet(address) {
    if (!address) return null;
    return crypto.createHash('sha256').update(address).digest('hex').slice(0, 16);
}

// ═══════════════════════════════════════════════════════════════════════════
// DIMENSION WEIGHTS - φ aligned
// ═══════════════════════════════════════════════════════════════════════════

const DIMENSIONS = {
    // PRIMARY (φ² weight) - Core judgment
    truth:      { weight: PHI_SQ, threshold: 70, category: 'primary' },
    relevance:  { weight: PHI_SQ, threshold: 60, category: 'primary' },
    quality:    { weight: PHI_SQ, threshold: 70, category: 'primary' },
    coherence:  { weight: PHI_SQ, threshold: 75, category: 'primary' },
    progress:   { weight: PHI_SQ, threshold: 50, category: 'primary' },
    ethics:     { weight: PHI_CUBE, threshold: 80, category: 'critical' }, // Critical override
    harmony:    { weight: PHI_SQ, threshold: 60, category: 'primary' },

    // SECONDARY (φ weight) - Supporting judgment
    security:    { weight: PHI, threshold: 85, category: 'secondary' },
    privacy:     { weight: PHI_CUBE, threshold: 90, category: 'critical' }, // Critical override
    scalability: { weight: PHI, threshold: 50, category: 'secondary' },
    simplicity:  { weight: PHI, threshold: 60, category: 'secondary' },
    autonomy:    { weight: PHI, threshold: 40, category: 'secondary' },

    // META (1.0 weight) - Self-awareness
    selfAwareness: { weight: 1.0, threshold: 50, category: 'meta' },
    learningRate:  { weight: 1.0, threshold: 50, category: 'meta' },
    singularity:   { weight: 1.0, threshold: 30, category: 'meta' },

    // DISTRIBUTED (φ weight) - Multi-node consensus
    nodeConsensus: { weight: PHI, threshold: 60, category: 'distributed' },  // Agreement between nodes
    signalCoverage: { weight: PHI, threshold: 50, category: 'distributed' }  // % of nodes that saw this token
};

// ═══════════════════════════════════════════════════════════════════════════
// SIGNAL ACCUMULATOR CLASS
// ═══════════════════════════════════════════════════════════════════════════

class SignalAccumulator {
    constructor() {
        this.persistInterval = null;
        this.cleanupInterval = null;
        this.thresholds = null; // Loaded from PostgreSQL
        this.globalSignalRate = 0; // Signals per minute (for harmony)
        this.signalRateWindow = []; // Last 60 signal timestamps
        this.stats = {
            signalsReceived: 0,
            judgmentsMade: 0,
            accepted: 0,
            rejected: 0,
            pending: 0
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LIFECYCLE
    // ─────────────────────────────────────────────────────────────────────────

    async start() {
        // Load thresholds from PostgreSQL (φ-aligned, self-tuning)
        await this.loadThresholds();

        // Register this node in the network
        await this.registerNode();

        // Periodic sync to PostgreSQL
        this.persistInterval = setInterval(() => this.persistToPostgres(), PERSIST_INTERVAL_MS);

        // Periodic cleanup of expired signals
        this.cleanupInterval = setInterval(() => this.cleanupExpired(), CLEANUP_INTERVAL_MS);

        // Periodic cross-node signal sync
        this.nodeSyncInterval = setInterval(() => this.syncWithNodes(), NODE_SYNC_INTERVAL_MS);

        // Heartbeat to maintain node registration
        this.heartbeatInterval = setInterval(() => this.registerNode(), 60000);

        // Periodic threshold refresh (self-tuning)
        this.thresholdInterval = setInterval(() => this.loadThresholds(), 300000); // Every 5min

        logger.info(`📊 [SignalAccumulator] Started node ${NODE_ID} with 17-dimension judgment (15 + 2 distributed)`);
    }

    /**
     * Load thresholds from PostgreSQL (allows self-tuning based on feedback)
     */
    async loadThresholds() {
        const db = getDB();
        if (!db) {
            logger.debug('[SignalAccumulator] DB not ready, using default thresholds');
            return;
        }

        try {
            const rows = await db.all('SELECT dimension, threshold, weight FROM judgment_thresholds');
            if (rows && rows.length > 0) {
                this.thresholds = {};
                for (const row of rows) {
                    // Convert snake_case to camelCase
                    const dimName = row.dimension.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
                    this.thresholds[dimName] = {
                        threshold: row.threshold,
                        weight: row.weight
                    };
                }
                logger.debug(`[SignalAccumulator] Loaded ${rows.length} thresholds from DB`);
            }
        } catch (err) {
            // Table might not exist yet
            logger.debug(`[SignalAccumulator] Could not load thresholds: ${err.message}`);
        }
    }

    /**
     * Get threshold for a dimension (DB value or default)
     */
    getThreshold(dimension) {
        if (this.thresholds && this.thresholds[dimension]) {
            return this.thresholds[dimension].threshold;
        }
        return DIMENSIONS[dimension]?.threshold || 50;
    }

    /**
     * Get weight for a dimension (DB value or default)
     */
    getWeight(dimension) {
        if (this.thresholds && this.thresholds[dimension]) {
            return this.thresholds[dimension].weight;
        }
        return DIMENSIONS[dimension]?.weight || 1.0;
    }

    async stop() {
        if (this.persistInterval) clearInterval(this.persistInterval);
        if (this.cleanupInterval) clearInterval(this.cleanupInterval);
        if (this.nodeSyncInterval) clearInterval(this.nodeSyncInterval);
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.thresholdInterval) clearInterval(this.thresholdInterval);

        // Unregister node
        await this.unregisterNode();

        logger.info(`📊 [SignalAccumulator] Stopped node ${NODE_ID}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MULTI-NODE NETWORK
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Register this node in the distributed network
     */
    async registerNode() {
        const redis = getClient();
        if (!redis) return;

        try {
            await redis.sadd(REGISTERED_NODES_KEY, NODE_ID);
            await redis.hset('holdex:node_heartbeats', NODE_ID, Date.now());
            // Set TTL on heartbeats hash (5 min) - prevents orphaned entries if all nodes die
            // TTL refreshed every heartbeat (60s), so hash survives as long as any node is alive
            await redis.expire('holdex:node_heartbeats', 300);
            // Also expire registered nodes set
            await redis.expire(REGISTERED_NODES_KEY, 300);
            logger.debug(`🔗 [Node] Registered ${NODE_ID}`);
        } catch (err) {
            logger.error(`[Node] Registration failed: ${err.message}`);
        }
    }

    /**
     * Unregister this node from the network
     */
    async unregisterNode() {
        const redis = getClient();
        if (!redis) return;

        try {
            await redis.srem(REGISTERED_NODES_KEY, NODE_ID);
            await redis.hdel('holdex:node_heartbeats', NODE_ID);
            logger.debug(`🔗 [Node] Unregistered ${NODE_ID}`);
        } catch (err) {
            logger.error(`[Node] Unregistration failed: ${err.message}`);
        }
    }

    /**
     * Sync signals with other nodes in the network
     * Merges signals from other nodes into local view
     */
    async syncWithNodes() {
        const redis = getClient();
        if (!redis) return;

        try {
            // Get all registered nodes
            const nodes = await redis.smembers(REGISTERED_NODES_KEY);
            if (nodes.length <= 1) return; // No other nodes

            // Check for dead nodes (no heartbeat in 2 minutes)
            const heartbeats = await redis.hgetall('holdex:node_heartbeats');
            const now = Date.now();
            for (const [nodeId, lastHeartbeat] of Object.entries(heartbeats)) {
                if (now - parseInt(lastHeartbeat) > 120000) {
                    // Node is dead, remove it
                    await redis.srem(REGISTERED_NODES_KEY, nodeId);
                    await redis.hdel('holdex:node_heartbeats', nodeId);
                    logger.info(`💀 [Node] Removed dead node ${nodeId}`);
                }
            }

            // Merge signals from other nodes
            // Each node publishes its signals to NODE_SIGNALS_PREFIX + nodeId
            // We read from other nodes and merge
            for (const nodeId of nodes) {
                if (nodeId === NODE_ID) continue; // Skip self

                const nodeSignalsKey = `${NODE_SIGNALS_PREFIX}${nodeId}`;
                const nodeMints = await redis.smembers(nodeSignalsKey);

                for (const mint of nodeMints) {
                    // Get other node's signal data
                    const otherData = await redis.hget(`${SIGNAL_PREFIX}${mint}:${nodeId}`, 'data');
                    if (!otherData) continue;

                    const other = JSON.parse(otherData);

                    // Merge into our local data
                    let local = await this.getSignalData(mint);
                    if (!local) {
                        // We don't have this token, adopt it
                        local = other;
                    } else {
                        // Merge: take max counts, union wallets, merge node_signals
                        local.swap_count = Math.max(local.swap_count, other.swap_count || 0);
                        local.transfer_count = Math.max(local.transfer_count, other.transfer_count || 0);

                        // Union unique wallets
                        const walletSet = new Set([...local.unique_wallets, ...(other.unique_wallets || [])]);
                        local.unique_wallets = Array.from(walletSet);

                        // Merge node signals
                        for (const [nid, nsig] of Object.entries(other.node_signals || {})) {
                            if (!local.node_signals[nid]) {
                                local.node_signals[nid] = nsig;
                                if (!local.nodes_seen.includes(nid)) {
                                    local.nodes_seen.push(nid);
                                }
                            }
                        }

                        // Update timestamps
                        local.first_seen = Math.min(local.first_seen, other.first_seen || local.first_seen);
                        local.last_seen = Math.max(local.last_seen, other.last_seen || local.last_seen);
                    }

                    // Store merged data
                    const key = `${SIGNAL_PREFIX}${mint}`;
                    await redis.hset(key, 'data', JSON.stringify(local));
                }
            }

        } catch (err) {
            logger.error(`[Node] Sync error: ${err.message}`);
        }
    }

    /**
     * Publish our signals for other nodes to see
     */
    async publishSignals() {
        const redis = getClient();
        if (!redis) return;

        try {
            const mints = await redis.smembers(SIGNAL_SET);
            const nodeSignalsKey = `${NODE_SIGNALS_PREFIX}${NODE_ID}`;

            for (const mint of mints) {
                await redis.sadd(nodeSignalsKey, mint);
                // Copy our view of this mint to node-specific key
                const data = await this.getSignalData(mint);
                if (data) {
                    await redis.hset(`${SIGNAL_PREFIX}${mint}:${NODE_ID}`, 'data', JSON.stringify(data));
                }
            }
        } catch (err) {
            logger.error(`[Node] Publish error: ${err.message}`);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SIGNAL INGESTION (from webhooks)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Add a signal for a token (SWAP, TRANSFER, etc.)
     * Called from webhook handlers - NO RPC COST
     */
    async addSignal(mint, signal) {
        const redis = getClient();
        if (!redis) {
            logger.warn('[SignalAccumulator] Redis not available');
            return null;
        }

        const now = Date.now();
        const key = `${SIGNAL_PREFIX}${mint}`;

        try {
            // Get or create signal data
            let data = await this.getSignalData(mint);

            if (!data) {
                data = {
                    mint,
                    swap_count: 0,
                    transfer_count: 0,
                    unique_wallets: [],
                    first_seen: now,
                    last_seen: now,
                    amounts: [],
                    sources: [],
                    wallet_e_scores: [],
                    // Multi-node tracking
                    node_signals: {},  // { node_id: { count, last_seen } }
                    nodes_seen: [],    // List of node IDs that contributed signals
                    created_at: now,
                    updated_at: now
                };
            }

            // Track which node contributed this signal
            if (!data.node_signals[NODE_ID]) {
                data.node_signals[NODE_ID] = { count: 0, first_seen: now, last_seen: now };
                data.nodes_seen.push(NODE_ID);
            }
            data.node_signals[NODE_ID].count++;
            data.node_signals[NODE_ID].last_seen = now;

            // Update based on signal type
            if (signal.type === 'SWAP') {
                data.swap_count++;
            } else if (signal.type === 'TRANSFER') {
                data.transfer_count++;
            }

            // Track unique wallets (hashed for privacy)
            // Cap at 200 to prevent memory bloat - sufficient for signal analysis
            if (signal.wallets && data.unique_wallets.length < 200) {
                for (const wallet of signal.wallets) {
                    const hashed = hashWallet(wallet);
                    if (hashed && !data.unique_wallets.includes(hashed)) {
                        data.unique_wallets.push(hashed);
                        if (data.unique_wallets.length >= 200) break;
                    }
                }
            }

            // Track amounts for variance analysis
            if (signal.amount && signal.amount > 0) {
                data.amounts.push(signal.amount);
                // Keep last 100 amounts
                if (data.amounts.length > 100) {
                    data.amounts = data.amounts.slice(-100);
                }
            }

            // Track sources (cap at 20 - most tokens have 1-3 sources)
            if (signal.source && !data.sources.includes(signal.source) && data.sources.length < 20) {
                data.sources.push(signal.source);
            }

            // Track wallet E-Scores if provided (from GASdf integration)
            if (signal.walletEScore) {
                data.wallet_e_scores.push(signal.walletEScore);
                // Keep last 50 E-scores
                if (data.wallet_e_scores.length > 50) {
                    data.wallet_e_scores = data.wallet_e_scores.slice(-50);
                }
            }

            // Update timestamps
            data.last_seen = now;
            data.updated_at = now;

            // Store in Redis
            await redis.hset(key, 'data', JSON.stringify(data));
            await redis.sadd(SIGNAL_SET, mint);

            this.stats.signalsReceived++;

            // Track signal rate for harmony calculation (sliding window of 60s)
            this.signalRateWindow.push(now);
            const windowStart = now - 60000;
            this.signalRateWindow = this.signalRateWindow.filter(t => t > windowStart);
            this.globalSignalRate = this.signalRateWindow.length; // Signals per minute

            // Skip judgment if already finalized (ACCEPT/REJECT are final)
            // This prevents log spam from re-judging the same token on every swap
            if (data.judgment_status === 'accepted' || data.judgment_status === 'rejected') {
                return { data, judgment: null }; // Already judged, just accumulate signals
            }

            // ATOMIC LOCK: Prevent concurrent judgments using Redis SETNX
            // This fixes the race condition where multiple webhook events try to judge simultaneously
            const judgmentLockKey = `holdex:judgment:lock:${mint}`;
            const acquired = await redis.set(judgmentLockKey, '1', 'EX', 60, 'NX'); // 60s TTL

            if (!acquired) {
                // Another process is judging this token right now - skip to prevent duplicates
                return { data, judgment: null };
            }

            // Check if ready for judgment
            let judgment = null;
            try {
                judgment = await this.tryJudge(mint, data);
            } finally {
                // If not a final judgment (ACCEPT/REJECT), release lock for future attempts
                // If final, keep lock to prevent re-processing (will expire in 60s anyway)
                if (!judgment || (judgment.status !== 'accepted' && judgment.status !== 'rejected')) {
                    await redis.del(judgmentLockKey);
                }
            }

            return { data, judgment };

        } catch (err) {
            logger.error(`[SignalAccumulator] Error adding signal: ${err.message}`);
            return null;
        }
    }

    /**
     * Get accumulated signal data for a mint
     */
    async getSignalData(mint) {
        const redis = getClient();
        if (!redis) return null;

        const key = `${SIGNAL_PREFIX}${mint}`;
        const raw = await redis.hget(key, 'data');

        if (!raw) {
            // Try PostgreSQL fallback (cold storage)
            return this.loadFromPostgres(mint);
        }

        return JSON.parse(raw);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 15-DIMENSION JUDGMENT
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Attempt to judge a token based on accumulated signals
     */
    async tryJudge(mint, data) {
        // Check if we have enough signals for judgment
        const totalSignals = data.swap_count + data.transfer_count;
        const timeSpread = data.last_seen - data.first_seen;

        if (totalSignals < MIN_SIGNALS_FOR_JUDGMENT) {
            return { status: 'insufficient_signals', needed: MIN_SIGNALS_FOR_JUDGMENT - totalSignals };
        }

        if (timeSpread < MIN_TIME_SPREAD_MS) {
            return { status: 'insufficient_time_spread', needed: MIN_TIME_SPREAD_MS - timeSpread };
        }

        // Calculate all 17 dimensions (15 + 2 distributed)
        const scores = await this.calculateDimensionScores(data);

        // Calculate weighted geometric mean
        const preScore = this.calculatePreScore(scores);

        // Check critical overrides
        const criticalFail = this.checkCriticalOverrides(scores);
        if (criticalFail) {
            return this.makeJudgment(mint, data, scores, preScore, 'REJECT', criticalFail);
        }

        // Determine action based on score
        if (preScore >= ACCEPT_THRESHOLD) {
            return this.makeJudgment(mint, data, scores, preScore, 'ACCEPT', 'score above threshold');
        } else if (preScore >= PENDING_THRESHOLD) {
            return this.makeJudgment(mint, data, scores, preScore, 'PENDING', 'needs more signals');
        } else {
            return this.makeJudgment(mint, data, scores, preScore, 'REJECT', 'score below threshold');
        }
    }

    /**
     * Calculate individual dimension scores from signals
     */
    async calculateDimensionScores(data) {
        const scores = {};

        // ─────────────────────────────────────────────────────────────────────
        // PRIMARY DIMENSIONS
        // ─────────────────────────────────────────────────────────────────────

        // TRUTH: Are the signals from real, unique actors?
        // Combines: unique wallet ratio + E-Score reputation
        const uniqueRatio = data.unique_wallets.length / Math.max(1, data.swap_count);
        const uniqueScore = Math.min(100, Math.round(uniqueRatio * 100));

        // E-Score boost: known wallets with good reputation increase truth
        const avgEScore = await this.getAverageWalletEScore(data);
        // Weight: 70% unique ratio, 30% E-Score (if available)
        scores.truth = avgEScore > 0
            ? Math.round(uniqueScore * 0.7 + avgEScore * 0.3)
            : uniqueScore;

        // RELEVANCE: Is this token from a known launchpad/DEX?
        const knownSources = [
            'Pump.fun', 'PumpSwap', 'Raydium', 'Orca', 'Meteora',
            'Jupiter', 'Moonshot', 'Phoenix', 'OpenBook', 'Lifinity',
            'GooseFX', 'Aldrin', 'Saber', 'Marinade'
        ];
        const hasKnownSource = data.sources.some(s => knownSources.includes(s));
        scores.relevance = hasKnownSource ? 100 : 30;

        // QUALITY: Time spread and amount variance (anti-bot)
        const timeSpread = data.last_seen - data.first_seen;
        const timeScore = Math.min(100, Math.round(timeSpread / 600000 * 100)); // 10min = 100

        const amountVariance = this.calculateVariance(data.amounts);
        const varianceScore = amountVariance > 0.5 ? 100 : Math.round(amountVariance * 200);

        scores.quality = Math.round((timeScore + varianceScore) / 2);

        // COHERENCE: Does the pattern match organic growth?
        // Organic = gradual increase in wallets over time
        const growthRate = data.unique_wallets.length / Math.max(1, timeSpread / 60000);
        scores.coherence = growthRate > 0.1 && growthRate < 10 ? 100 : 50;

        // PROGRESS: Does indexing advance the K-Score mission?
        // All tokens potentially advance the mission
        scores.progress = 70;

        // ETHICS: Not a known scam pattern
        // TODO: Integrate with scam database
        const isSuspiciousPattern = this.detectSuspiciousPattern(data);
        scores.ethics = isSuspiciousPattern ? 0 : 100;

        // HARMONY: Fits ecosystem balance, not spam flood
        // φ-aligned rate: 100 signals/min = healthy, >500 = flood
        const maxHealthyRate = 100;
        const floodRate = 500;
        if (this.globalSignalRate <= maxHealthyRate) {
            scores.harmony = 100;
        } else if (this.globalSignalRate >= floodRate) {
            scores.harmony = 20; // Severe flood
        } else {
            // Linear degradation
            scores.harmony = Math.round(100 - ((this.globalSignalRate - maxHealthyRate) / (floodRate - maxHealthyRate)) * 80);
        }

        // ─────────────────────────────────────────────────────────────────────
        // SECONDARY DIMENSIONS
        // ─────────────────────────────────────────────────────────────────────

        // SECURITY: No malicious patterns detected
        scores.security = scores.ethics; // Linked to ethics for now

        // PRIVACY: We hash all wallets, so always 100
        scores.privacy = 100;

        // SCALABILITY: Can we handle the current rate?
        // Based on pending signals count in Redis
        const pendingCount = await this.getPendingSignalsCount();
        const maxPending = 1000; // φ-aligned: healthy capacity
        const criticalPending = 5000;
        if (pendingCount <= maxPending) {
            scores.scalability = 100;
        } else if (pendingCount >= criticalPending) {
            scores.scalability = 20; // At capacity
        } else {
            scores.scalability = Math.round(100 - ((pendingCount - maxPending) / (criticalPending - maxPending)) * 80);
        }

        // SIMPLICITY: Simple judgment path?
        const hasEnoughData = data.swap_count >= 3 && data.unique_wallets.length >= 2;
        scores.simplicity = hasEnoughData ? 100 : 50;

        // AUTONOMY: Can decide without human?
        scores.autonomy = hasEnoughData ? 100 : 30;

        // ─────────────────────────────────────────────────────────────────────
        // META DIMENSIONS
        // ─────────────────────────────────────────────────────────────────────

        // SELF_AWARENESS: Confidence in our judgment
        const dataPoints = data.swap_count + data.transfer_count + data.unique_wallets.length;
        scores.selfAwareness = Math.min(100, dataPoints * 10);

        // LEARNING_RATE: Are we improving? (from feedback loop)
        scores.learningRate = await this.calculateLearningRate();

        // SINGULARITY: How close to perfect auto-judgment?
        scores.singularity = scores.autonomy;

        // ─────────────────────────────────────────────────────────────────────
        // DISTRIBUTED DIMENSIONS - Multi-node consensus
        // ─────────────────────────────────────────────────────────────────────

        // NODE_CONSENSUS: Do multiple nodes agree on this token?
        // More nodes seeing same signals = higher consensus
        const nodesCount = (data.nodes_seen || []).length;
        const totalRegisteredNodes = await this.getRegisteredNodesCount();
        if (totalRegisteredNodes <= 1) {
            // Single node network - full consensus by default
            scores.nodeConsensus = 100;
        } else {
            // Multi-node: consensus = % of nodes that saw this token
            scores.nodeConsensus = Math.round((nodesCount / totalRegisteredNodes) * 100);
        }

        // SIGNAL_COVERAGE: How distributed are the signals across nodes?
        // Balanced distribution = better (not all from one node)
        if (nodesCount <= 1 || !data.node_signals) {
            scores.signalCoverage = 100; // Single node = full coverage
        } else {
            // Calculate distribution entropy
            const totalSignals = Object.values(data.node_signals).reduce((sum, n) => sum + n.count, 0);
            const shares = Object.values(data.node_signals).map(n => n.count / totalSignals);
            // Normalized entropy: 0 = all from one node, 100 = perfectly distributed
            const entropy = -shares.reduce((sum, p) => sum + (p > 0 ? p * Math.log2(p) : 0), 0);
            const maxEntropy = Math.log2(nodesCount);
            scores.signalCoverage = maxEntropy > 0 ? Math.round((entropy / maxEntropy) * 100) : 100;
        }

        return scores;
    }

    /**
     * Get count of registered nodes in the network
     */
    async getRegisteredNodesCount() {
        const redis = getClient();
        if (!redis) return 1;

        try {
            const count = await redis.scard(REGISTERED_NODES_KEY);
            return Math.max(1, count);
        } catch {
            return 1;
        }
    }

    /**
     * Get count of pending signals (for scalability scoring)
     */
    async getPendingSignalsCount() {
        const redis = getClient();
        if (!redis) return 0;

        try {
            return await redis.scard(SIGNAL_SET);
        } catch {
            return 0;
        }
    }

    /**
     * Calculate φ-weighted geometric mean of all dimensions
     * Uses dynamic weights from PostgreSQL if available
     */
    calculatePreScore(scores) {
        let product = 1;
        let totalWeight = 0;

        for (const [name] of Object.entries(DIMENSIONS)) {
            const score = scores[name] || 50;
            // Use dynamic weight from DB or default
            const weight = this.getWeight(name);
            // Avoid log(0) by using minimum of 1
            const safeScore = Math.max(1, score);
            product *= Math.pow(safeScore, weight);
            totalWeight += weight;
        }

        return Math.round(Math.pow(product, 1 / totalWeight));
    }

    /**
     * Check critical dimension overrides (privacy, ethics)
     * Uses dynamic thresholds from PostgreSQL if available
     */
    checkCriticalOverrides(scores) {
        for (const [name, config] of Object.entries(DIMENSIONS)) {
            if (config.category === 'critical') {
                const threshold = this.getThreshold(name);
                if (scores[name] < threshold) {
                    return `Critical dimension ${name} = ${scores[name]} < ${threshold}`;
                }
            }
        }
        return null;
    }

    /**
     * Make and record a judgment
     */
    async makeJudgment(mint, data, scores, preScore, action, reason) {
        const db = getDB();
        const now = Date.now();

        // Update signal data with judgment
        data.pre_score = preScore;
        data.judgment_status = action.toLowerCase();
        data.judgment_reason = reason;
        data.judgment_at = now;
        data.dimension_scores = scores;

        // Store updated data in Redis
        const redis = getClient();
        if (redis) {
            const key = `${SIGNAL_PREFIX}${mint}`;
            await redis.hset(key, 'data', JSON.stringify(data));
        }

        // Record in judgment history (provenance)
        try {
            await db.run(`
                INSERT INTO judgment_history (mint, action, pre_score, dimension_scores, signal_snapshot, created_at)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [
                mint,
                action,
                preScore,
                JSON.stringify(scores),
                JSON.stringify({
                    swap_count: data.swap_count,
                    transfer_count: data.transfer_count,
                    unique_wallets: data.unique_wallets.length,
                    time_spread: data.last_seen - data.first_seen,
                    sources: data.sources
                }),
                now
            ]);
        } catch (err) {
            // Table might not exist yet
            logger.debug(`[SignalAccumulator] Could not record judgment: ${err.message}`);
        }

        // Update stats
        this.stats.judgmentsMade++;
        if (action === 'ACCEPT') this.stats.accepted++;
        else if (action === 'REJECT') this.stats.rejected++;
        else this.stats.pending++;

        logger.info(`⚖️ [Judge] ${mint.slice(0, 8)}: ${action} (score: ${preScore}, reason: ${reason})`);

        return { action, preScore, scores, reason };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    calculateVariance(arr) {
        if (!arr || arr.length < 2) return 0;
        const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
        const squaredDiffs = arr.map(x => Math.pow(x - mean, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / arr.length;
        // Normalize to 0-1 range based on mean
        return Math.min(1, Math.sqrt(variance) / (mean || 1));
    }

    detectSuspiciousPattern(data) {
        // ═══════════════════════════════════════════════════════════════════
        // ENHANCED SCAM DETECTION - Multi-pattern analysis
        // ═══════════════════════════════════════════════════════════════════

        // 1. Sybil Attack: Same wallet more than 70% of swaps
        if (data.unique_wallets.length < data.swap_count * 0.3) {
            return true;
        }

        // 2. Wash Trading: All amounts identical
        if (data.amounts.length > 5) {
            const uniqueAmounts = new Set(data.amounts);
            if (uniqueAmounts.size === 1) {
                return true;
            }
        }

        // 3. Bot Pattern: Too many swaps in short time (>10 per minute)
        const timeSpread = data.last_seen - data.first_seen;
        const swapsPerMinute = data.swap_count / Math.max(1, timeSpread / 60000);
        if (swapsPerMinute > 10 && data.swap_count > 5) {
            return true;
        }

        // 4. Honeypot Pattern: Many buys, zero sells (need transfer analysis)
        // Only transfers from pool = one-way trap
        if (data.transfer_count > 0 && data.swap_count === 0) {
            // All activity is transfers, no swaps = suspicious airdrop scam
            if (data.transfer_count > 10) {
                return true;
            }
        }

        // 5. Coordinated Attack: All activity within 10 seconds
        if (timeSpread < 10000 && data.swap_count > 3) {
            return true;
        }

        // 6. Round Number Pattern: All amounts are round numbers (bot signature)
        if (data.amounts.length > 3) {
            const roundCount = data.amounts.filter(a => a % 1000 === 0 || a % 100 === 0).length;
            if (roundCount / data.amounts.length > 0.8) {
                return true;
            }
        }

        return false;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // E-SCORE INTEGRATION - Wallet reputation from participants table
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Fetch E-Score for a wallet from HolDex participants table
     * @param {string} walletHash - SHA256 hash of wallet address
     * @returns {Promise<number>} E-Score (0-100) or 0 if unknown
     */
    async getWalletEScore(walletHash) {
        const db = getDB();
        if (!db) return 0;

        try {
            // Query participants table for this wallet's E-Score
            // Note: We search by hash prefix since we only store first 16 chars
            const row = await db.get(`
                SELECT e_score FROM participants
                WHERE wallet LIKE $1 || '%'
                LIMIT 1
            `, [walletHash]);

            return row?.e_score || 0;
        } catch {
            return 0;
        }
    }

    /**
     * Get average E-Score for all wallets in signal data
     * @param {Object} data - Signal data with unique_wallets array
     * @returns {Promise<number>} Average E-Score
     */
    async getAverageWalletEScore(data) {
        if (!data.unique_wallets || data.unique_wallets.length === 0) {
            return 0;
        }

        const scores = [];
        for (const walletHash of data.unique_wallets.slice(0, 10)) { // Limit to 10 for performance
            const score = await this.getWalletEScore(walletHash);
            if (score > 0) {
                scores.push(score);
            }
        }

        if (scores.length === 0) return 0;
        return scores.reduce((a, b) => a + b, 0) / scores.length;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FEEDBACK LOOP - Learning from K-Score outcomes
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Record judgment outcome for learning (called when K-Score is calculated)
     * @param {string} mint - Token mint address
     * @param {number} kScore - Final K-Score from HolDex
     * @param {boolean} wasRug - Did the token rug (K-Score dropped to 0)?
     */
    async recordJudgmentOutcome(mint, kScore, wasRug) {
        const db = getDB();
        if (!db) return;

        try {
            // Find the original judgment for this mint
            const judgment = await db.get(`
                SELECT id, action, pre_score FROM judgment_history
                WHERE mint = $1
                ORDER BY created_at DESC
                LIMIT 1
            `, [mint]);

            if (!judgment) return;

            // Determine if judgment was correct
            // ACCEPT was correct if K-Score > 50 and didn't rug
            // REJECT was correct if K-Score < 50 or rugged
            let wasCorrect;
            if (judgment.action === 'ACCEPT') {
                wasCorrect = kScore >= 50 && !wasRug;
            } else if (judgment.action === 'REJECT') {
                wasCorrect = kScore < 50 || wasRug;
            } else {
                wasCorrect = null; // PENDING - no outcome yet
            }

            // Update judgment_history with outcome
            await db.run(`
                UPDATE judgment_history
                SET was_correct = $1, k_score_outcome = $2, feedback_at = $3
                WHERE id = $4
            `, [wasCorrect, kScore, Date.now(), judgment.id]);

            // Update threshold performance metrics
            if (wasCorrect !== null) {
                await this.updateThresholdMetrics(judgment.action, wasCorrect);
            }

            logger.info(`📚 [Feedback] ${mint.slice(0, 8)}: ${judgment.action} was ${wasCorrect ? 'CORRECT' : 'WRONG'} (K=${kScore})`);

        } catch (err) {
            logger.debug(`[Feedback] Error recording outcome: ${err.message}`);
        }
    }

    /**
     * Update threshold metrics for self-tuning
     */
    async updateThresholdMetrics(action, wasCorrect) {
        const db = getDB();
        if (!db) return;

        try {
            // Update all dimensions with this outcome
            // True positive = ACCEPT that was correct
            // False positive = ACCEPT that was wrong
            // True negative = REJECT that was correct
            // False negative = REJECT that was wrong
            const column = action === 'ACCEPT'
                ? (wasCorrect ? 'true_positives' : 'false_positives')
                : (wasCorrect ? 'true_negatives' : 'false_negatives');

            await db.run(`
                UPDATE judgment_thresholds
                SET ${column} = ${column} + 1
            `);
        } catch {
            // Ignore errors - metrics are optional
        }
    }

    /**
     * Calculate learning rate based on recent judgment accuracy
     * @returns {Promise<number>} Learning rate score (0-100)
     */
    async calculateLearningRate() {
        const db = getDB();
        if (!db) return 50; // Default

        try {
            // Get last 100 judgments with feedback
            const stats = await db.get(`
                SELECT
                    COUNT(*) as total,
                    SUM(CASE WHEN was_correct = true THEN 1 ELSE 0 END) as correct
                FROM judgment_history
                WHERE was_correct IS NOT NULL
                ORDER BY created_at DESC
                LIMIT 100
            `);

            if (!stats || stats.total < 10) {
                return 50; // Not enough data
            }

            // Accuracy as score (0-100)
            const accuracy = (stats.correct / stats.total) * 100;

            // Learning rate = improvement over baseline (50% random)
            // If accuracy > 80% = excellent learning
            // If accuracy < 50% = worse than random, need tuning
            return Math.round(accuracy);

        } catch {
            return 50;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PERSISTENCE
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Sync Redis data to PostgreSQL (cold storage)
     */
    async persistToPostgres() {
        const redis = getClient();
        const db = getDB();
        if (!redis || !db) return;

        try {
            const mints = await redis.smembers(SIGNAL_SET);
            let synced = 0;

            for (const mint of mints) {
                const data = await this.getSignalData(mint);
                if (!data) continue;

                await db.run(`
                    INSERT INTO token_signals (
                        mint, swap_count, transfer_count, unique_wallets, unique_wallet_count,
                        first_seen, last_seen, amounts, amount_variance, sources,
                        wallet_e_scores, avg_wallet_e_score, pre_score, judgment_status,
                        judgment_reason, judgment_at, dimension_scores, node_signals, nodes_seen,
                        created_at, updated_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
                    ON CONFLICT (mint) DO UPDATE SET
                        swap_count = EXCLUDED.swap_count,
                        transfer_count = EXCLUDED.transfer_count,
                        unique_wallets = EXCLUDED.unique_wallets,
                        unique_wallet_count = EXCLUDED.unique_wallet_count,
                        last_seen = EXCLUDED.last_seen,
                        amounts = EXCLUDED.amounts,
                        amount_variance = EXCLUDED.amount_variance,
                        sources = EXCLUDED.sources,
                        wallet_e_scores = EXCLUDED.wallet_e_scores,
                        avg_wallet_e_score = EXCLUDED.avg_wallet_e_score,
                        pre_score = EXCLUDED.pre_score,
                        judgment_status = EXCLUDED.judgment_status,
                        judgment_reason = EXCLUDED.judgment_reason,
                        judgment_at = EXCLUDED.judgment_at,
                        dimension_scores = EXCLUDED.dimension_scores,
                        node_signals = EXCLUDED.node_signals,
                        nodes_seen = EXCLUDED.nodes_seen,
                        updated_at = EXCLUDED.updated_at
                `, [
                    mint,
                    data.swap_count || 0,
                    data.transfer_count || 0,
                    JSON.stringify(data.unique_wallets || []),
                    (data.unique_wallets || []).length,
                    data.first_seen,
                    data.last_seen,
                    JSON.stringify(data.amounts || []),
                    this.calculateVariance(data.amounts || []),
                    JSON.stringify(data.sources || []),
                    JSON.stringify(data.wallet_e_scores || []),
                    this.calculateAverage(data.wallet_e_scores || []),
                    data.pre_score || 0,
                    data.judgment_status || 'pending',
                    data.judgment_reason || null,
                    data.judgment_at || null,
                    JSON.stringify(data.dimension_scores || {}),
                    JSON.stringify(data.node_signals || {}),
                    JSON.stringify(data.nodes_seen || []),
                    data.created_at,
                    data.updated_at
                ]);

                synced++;
            }

            if (synced > 0) {
                logger.debug(`💾 [SignalAccumulator] Synced ${synced} signals to PostgreSQL`);
            }

        } catch (err) {
            logger.error(`[SignalAccumulator] Persist error: ${err.message}`);
        }
    }

    /**
     * Load signal data from PostgreSQL (cold storage recovery)
     */
    async loadFromPostgres(mint) {
        const db = getDB();
        if (!db) return null;

        try {
            const row = await db.get('SELECT * FROM token_signals WHERE mint = $1', [mint]);
            if (!row) return null;

            return {
                mint: row.mint,
                swap_count: row.swap_count,
                transfer_count: row.transfer_count,
                unique_wallets: JSON.parse(row.unique_wallets || '[]'),
                first_seen: row.first_seen,
                last_seen: row.last_seen,
                amounts: JSON.parse(row.amounts || '[]'),
                sources: JSON.parse(row.sources || '[]'),
                wallet_e_scores: JSON.parse(row.wallet_e_scores || '[]'),
                pre_score: row.pre_score,
                judgment_status: row.judgment_status,
                judgment_reason: row.judgment_reason,
                judgment_at: row.judgment_at,
                dimension_scores: JSON.parse(row.dimension_scores || '{}'),
                node_signals: JSON.parse(row.node_signals || '{}'),
                nodes_seen: JSON.parse(row.nodes_seen || '[]'),
                created_at: row.created_at,
                updated_at: row.updated_at
            };

        } catch (err) {
            logger.debug(`[SignalAccumulator] Load error: ${err.message}`);
            return null;
        }
    }

    /**
     * Cleanup expired signals
     */
    async cleanupExpired() {
        const redis = getClient();
        if (!redis) return;

        const now = Date.now();
        const TTL_MS = 30 * 60 * 1000; // 30 min

        try {
            const mints = await redis.smembers(SIGNAL_SET);
            let cleaned = 0;

            for (const mint of mints) {
                const data = await this.getSignalData(mint);
                if (!data) continue;

                // Expire if: rejected OR (pending AND too old with low score)
                const isRejected = data.judgment_status === 'rejected';
                const isStale = (now - data.last_seen) > TTL_MS && data.pre_score < PENDING_THRESHOLD;

                if (isRejected || isStale) {
                    await redis.del(`${SIGNAL_PREFIX}${mint}`);
                    await redis.srem(SIGNAL_SET, mint);
                    cleaned++;
                }
            }

            if (cleaned > 0) {
                logger.info(`🧹 [SignalAccumulator] Cleaned ${cleaned} expired signals`);
            }

        } catch (err) {
            logger.error(`[SignalAccumulator] Cleanup error: ${err.message}`);
        }
    }

    calculateAverage(arr) {
        if (!arr || arr.length === 0) return 0;
        return arr.reduce((a, b) => a + b, 0) / arr.length;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC API
    // ─────────────────────────────────────────────────────────────────────────

    getStats() {
        return { ...this.stats };
    }

    /**
     * Get tokens that passed judgment (ready for indexing)
     */
    async getAcceptedTokens(limit = 10) {
        const redis = getClient();
        if (!redis) return [];

        const mints = await redis.smembers(SIGNAL_SET);
        const accepted = [];

        for (const mint of mints) {
            if (accepted.length >= limit) break;

            const data = await this.getSignalData(mint);
            if (data && data.judgment_status === 'accepted') {
                accepted.push({
                    mint,
                    preScore: data.pre_score,
                    sources: data.sources,
                    uniqueWallets: data.unique_wallets.length,
                    swapCount: data.swap_count
                });
            }
        }

        return accepted;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════

const accumulator = new SignalAccumulator();

module.exports = {
    SignalAccumulator,
    accumulator,
    addSignal: (mint, signal) => accumulator.addSignal(mint, signal),
    getSignalData: (mint) => accumulator.getSignalData(mint),
    getAcceptedTokens: (limit) => accumulator.getAcceptedTokens(limit),
    getStats: () => accumulator.getStats(),
    start: () => accumulator.start(),
    stop: () => accumulator.stop(),
    // Feedback loop integration - call when K-Score is calculated
    recordJudgmentOutcome: (mint, kScore, wasRug) => accumulator.recordJudgmentOutcome(mint, kScore, wasRug),
    // E-Score helper for external analysis
    getAverageWalletEScore: (data) => accumulator.getAverageWalletEScore(data),
    hashWallet,
    DIMENSIONS,
    ACCEPT_THRESHOLD,
    PENDING_THRESHOLD,
    NODE_ID  // Export for external node identification
};
