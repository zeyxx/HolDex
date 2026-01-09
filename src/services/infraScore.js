/**
 * INFRASTRUCTURE SCORE SERVICE (I_infra)
 *
 * "Don't Trust, Verify" - Even infrastructure must be measured.
 *
 * Part of the K-E-I-Φ unified scoring system.
 * Monitors the health of infrastructure tokens that enable the ecosystem.
 *
 * Formula: I_infra = 100 × ∛(D_liquidity × O_oracle × L_reliability)
 *   D_liquidity  = Depth of liquidity (normalized 0-1)
 *   O_oracle     = Oracle freshness/accuracy (normalized 0-1)
 *   L_reliability = Historical uptime/reliability (normalized 0-1)
 *
 * φ-Weighted Infrastructure:
 *   SOL    = φ² (2.618) - Foundation layer
 *   USDC   = φ  (1.618) - Primary stable
 *   USDT   = 1.0        - Secondary stable
 *   wSOL   = φ  (1.618) - Wrapped native
 *   JitoSOL = 1.0       - LST
 *   mSOL   = 1.0        - LST
 *   bSOL   = 1.0        - LST
 *
 * Sefirot: Part of Yesod (Foundation) - the infrastructure layer
 */

'use strict';

const logger = require('./logger');
const { getClient: getRedis } = require('./redis');

// φ Constants (matching unified-score-system.json)
const PHI = 1.618033988749895;
const PHI_SQ = PHI * PHI;                    // φ² = 2.618...
const PHI_INV = 1 / PHI;                     // φ⁻¹ = 0.618...
const PHI_INV_SQ = 1 / PHI_SQ;               // φ⁻² = 0.382...

// Infrastructure tokens with φ weights
const INFRA_TOKENS = Object.freeze({
    'SOL': {
        name: 'Solana',
        weight: PHI_SQ,          // φ² = 2.618 - Foundation
        mint: 'So11111111111111111111111111111111111111112',
        type: 'native',
        critical: true
    },
    'USDC': {
        name: 'USD Coin',
        weight: PHI,             // φ = 1.618 - Primary stable
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        type: 'stable',
        critical: true
    },
    'USDT': {
        name: 'Tether USD',
        weight: 1.0,             // 1.0 - Secondary stable
        mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        type: 'stable',
        critical: false
    },
    'wSOL': {
        name: 'Wrapped SOL',
        weight: PHI,             // φ = 1.618 - Wrapped native
        mint: 'So11111111111111111111111111111111111111112',
        type: 'wrapped',
        critical: true
    },
    'JitoSOL': {
        name: 'Jito Staked SOL',
        weight: 1.0,             // 1.0 - LST
        mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
        type: 'lst',
        critical: false
    },
    'mSOL': {
        name: 'Marinade Staked SOL',
        weight: 1.0,             // 1.0 - LST
        mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
        type: 'lst',
        critical: false
    },
    'bSOL': {
        name: 'BlazeStake Staked SOL',
        weight: 1.0,             // 1.0 - LST
        mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
        type: 'lst',
        critical: false
    }
});

// Health thresholds (φ-based)
const HEALTH_THRESHOLDS = Object.freeze({
    CRITICAL: PHI_INV_SQ * 100,    // < 38.2% = Critical
    WARNING: PHI_INV * 100,        // < 61.8% = Warning
    HEALTHY: PHI_INV * 100         // >= 61.8% = Healthy
});

// Alert levels
const ALERT_LEVEL = Object.freeze({
    HEALTHY: 'healthy',
    WARNING: 'warning',
    CRITICAL: 'critical',
    OFFLINE: 'offline'
});

// Cache settings
const CACHE_TTL = 60;  // 1 minute for infra (needs to be fresh)

class InfraScoreService {
    constructor(db) {
        this.db = db;
        this.cache = new Map();
        this.lastAlerts = new Map();
    }

    // ═══════════════════════════════════════════════════════════════
    // CORE I_infra CALCULATION
    // ═══════════════════════════════════════════════════════════════

    /**
     * Calculate I_infra for a specific token
     * I = 100 × ∛(D × O × L)
     */
    calculateInfraScore(metrics) {
        const { liquidity, oracle, reliability } = metrics;

        // Normalize inputs to 0-1
        const D = Math.min(1, Math.max(0, liquidity));
        const O = Math.min(1, Math.max(0, oracle));
        const L = Math.min(1, Math.max(0, reliability));

        // Geometric mean (cube root of product)
        const score = 100 * Math.cbrt(D * O * L);

        return {
            score: Math.round(score * 100) / 100,
            components: {
                D_liquidity: Math.round(D * 1000) / 1000,
                O_oracle: Math.round(O * 1000) / 1000,
                L_reliability: Math.round(L * 1000) / 1000
            },
            alert: this._getAlertLevel(score)
        };
    }

    /**
     * Get alert level based on score
     */
    _getAlertLevel(score) {
        if (score < HEALTH_THRESHOLDS.CRITICAL) {
            return ALERT_LEVEL.CRITICAL;
        }
        if (score < HEALTH_THRESHOLDS.WARNING) {
            return ALERT_LEVEL.WARNING;
        }
        return ALERT_LEVEL.HEALTHY;
    }

    // ═══════════════════════════════════════════════════════════════
    // METRICS COLLECTION
    // ═══════════════════════════════════════════════════════════════

    /**
     * Calculate liquidity depth (D_liquidity)
     * Based on available liquidity vs required thresholds
     */
    async calculateLiquidityScore(symbol) {
        const token = INFRA_TOKENS[symbol];
        if (!token) return 0;

        try {
            // Get liquidity data from database
            const result = await this.db.query(`
                SELECT
                    total_liquidity,
                    liquidity_24h_change,
                    pool_count
                FROM infra_liquidity
                WHERE symbol = $1
                ORDER BY recorded_at DESC
                LIMIT 1
            `, [symbol]);

            if (result.rows.length === 0) {
                // No data - check if we can estimate from Jupiter
                return await this._estimateLiquidityFromRoutes(token.mint);
            }

            const data = result.rows[0];
            const liquidity = Number(data.total_liquidity);

            // Thresholds based on token type
            const thresholds = {
                native: 1000000000,  // $1B for SOL
                stable: 500000000,   // $500M for stables
                wrapped: 100000000,  // $100M for wrapped
                lst: 50000000        // $50M for LSTs
            };

            const threshold = thresholds[token.type] || 10000000;
            const normalized = Math.min(1, liquidity / threshold);

            // Apply decay for negative 24h change
            const changeMultiplier = data.liquidity_24h_change < -10
                ? 0.9
                : data.liquidity_24h_change < -5
                    ? 0.95
                    : 1.0;

            return normalized * changeMultiplier;

        } catch (error) {
            logger.warn(`[InfraScore] Failed to get liquidity for ${symbol}: ${error.message}`);
            return 0.5; // Default to mid-range on error
        }
    }

    /**
     * Estimate liquidity from route availability
     */
    async _estimateLiquidityFromRoutes(_mint) {
        // If no direct liquidity data, estimate from route quality
        // This is a fallback - actual implementation would query Jupiter
        return 0.6; // Conservative estimate
    }

    /**
     * Calculate oracle freshness/accuracy (O_oracle)
     */
    async calculateOracleScore(symbol) {
        try {
            // Get latest oracle data
            const result = await this.db.query(`
                SELECT
                    price,
                    last_update,
                    confidence,
                    source
                FROM oracle_prices
                WHERE symbol = $1
                ORDER BY last_update DESC
                LIMIT 5
            `, [symbol]);

            if (result.rows.length === 0) {
                return 0;
            }

            const latest = result.rows[0];
            const now = Date.now();
            const lastUpdate = new Date(latest.last_update).getTime();
            const ageSeconds = (now - lastUpdate) / 1000;

            // Freshness score (decay over time)
            // Full score if < 10s, degrades to 0 at 5 minutes
            const freshnessScore = Math.max(0, 1 - (ageSeconds / 300));

            // Confidence score (from oracle)
            const confidence = Number(latest.confidence) || 0.95;

            // Source diversity (multiple sources = more reliable)
            const sources = new Set(result.rows.map(r => r.source));
            const diversityScore = Math.min(1, sources.size / 3);

            // Combined oracle score
            return (freshnessScore * 0.5) + (confidence * 0.3) + (diversityScore * 0.2);

        } catch (error) {
            logger.warn(`[InfraScore] Failed to get oracle data for ${symbol}: ${error.message}`);
            return 0.5;
        }
    }

    /**
     * Calculate reliability score (L_reliability)
     * Based on historical uptime and stability
     */
    async calculateReliabilityScore(symbol) {
        try {
            // Get reliability metrics from last 24 hours
            const result = await this.db.query(`
                SELECT
                    AVG(uptime_percent) as avg_uptime,
                    COUNT(*) FILTER (WHERE is_available = TRUE) as available_checks,
                    COUNT(*) as total_checks,
                    AVG(response_time_ms) as avg_response_time
                FROM infra_health_checks
                WHERE symbol = $1
                  AND checked_at > NOW() - INTERVAL '24 hours'
            `, [symbol]);

            if (result.rows.length === 0 || result.rows[0].total_checks === 0) {
                return 0.8; // Default to good if no data
            }

            const data = result.rows[0];

            // Uptime component (50% weight)
            const uptimeScore = (Number(data.available_checks) / Number(data.total_checks)) || 0.8;

            // Response time component (30% weight) - sub 500ms is ideal
            const responseMs = Number(data.avg_response_time) || 200;
            const responseScore = Math.max(0, 1 - (responseMs / 1000));

            // Historical uptime average (20% weight)
            const historicalUptime = Number(data.avg_uptime) / 100 || 0.95;

            return (uptimeScore * 0.5) + (responseScore * 0.3) + (historicalUptime * 0.2);

        } catch (error) {
            logger.warn(`[InfraScore] Failed to get reliability for ${symbol}: ${error.message}`);
            return 0.7;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // AGGREGATED SCORES
    // ═══════════════════════════════════════════════════════════════

    /**
     * Get I_infra score for a specific token (cached)
     */
    async getTokenInfraScore(symbol) {
        const cacheKey = `infra:${symbol}`;

        // Check cache
        const cached = this.cache.get(cacheKey);
        if (cached && Date.now() - cached.ts < CACHE_TTL * 1000) {
            return cached.data;
        }

        // Calculate fresh
        const token = INFRA_TOKENS[symbol];
        if (!token) {
            return { error: `Unknown infrastructure token: ${symbol}` };
        }

        const [liquidity, oracle, reliability] = await Promise.all([
            this.calculateLiquidityScore(symbol),
            this.calculateOracleScore(symbol),
            this.calculateReliabilityScore(symbol)
        ]);

        const scoreResult = this.calculateInfraScore({ liquidity, oracle, reliability });

        const result = {
            symbol,
            name: token.name,
            mint: token.mint,
            type: token.type,
            weight: token.weight,
            critical: token.critical,
            ...scoreResult,
            timestamp: Date.now()
        };

        // Cache result
        this.cache.set(cacheKey, { data: result, ts: Date.now() });

        // Check for alerts
        await this._checkAndEmitAlert(symbol, result);

        return result;
    }

    /**
     * Get weighted aggregate I_infra score
     * Aggregate = Σ(score × weight) / Σ(weights)
     */
    async getAggregateInfraScore() {
        const cacheKey = 'infra:aggregate';

        // Check Redis cache
        const redis = getRedis();
        if (redis) {
            try {
                const cached = await redis.get(cacheKey);
                if (cached) {
                    return JSON.parse(cached);
                }
            } catch (_e) { /* continue */ }
        }

        // Calculate for all tokens
        const scores = [];
        let weightedSum = 0;
        let totalWeight = 0;
        let criticalAlerts = 0;
        let warningAlerts = 0;

        for (const symbol of Object.keys(INFRA_TOKENS)) {
            const tokenScore = await this.getTokenInfraScore(symbol);

            if (tokenScore.error) continue;

            scores.push(tokenScore);
            weightedSum += tokenScore.score * tokenScore.weight;
            totalWeight += tokenScore.weight;

            if (tokenScore.alert === ALERT_LEVEL.CRITICAL) criticalAlerts++;
            if (tokenScore.alert === ALERT_LEVEL.WARNING) warningAlerts++;
        }

        const aggregateScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

        // Determine overall health
        let overallHealth = ALERT_LEVEL.HEALTHY;
        if (criticalAlerts > 0) {
            overallHealth = ALERT_LEVEL.CRITICAL;
        } else if (warningAlerts > 0) {
            overallHealth = ALERT_LEVEL.WARNING;
        }

        const result = {
            score: Math.round(aggregateScore * 100) / 100,
            health: overallHealth,
            criticalAlerts,
            warningAlerts,
            tokens: scores,
            thresholds: HEALTH_THRESHOLDS,
            timestamp: Date.now()
        };

        // Cache in Redis
        if (redis) {
            await redis.set(cacheKey, JSON.stringify(result), { EX: CACHE_TTL }).catch(() => {});
        }

        return result;
    }

    /**
     * Get critical infrastructure status
     * Only tokens marked as critical
     */
    async getCriticalInfraStatus() {
        const criticalTokens = Object.entries(INFRA_TOKENS)
            .filter(([_, config]) => config.critical)
            .map(([symbol]) => symbol);

        const statuses = [];
        let allHealthy = true;

        for (const symbol of criticalTokens) {
            const score = await this.getTokenInfraScore(symbol);
            statuses.push(score);
            if (score.alert !== ALERT_LEVEL.HEALTHY) {
                allHealthy = false;
            }
        }

        return {
            allHealthy,
            criticalTokens: statuses,
            timestamp: Date.now()
        };
    }

    // ═══════════════════════════════════════════════════════════════
    // ALERTING
    // ═══════════════════════════════════════════════════════════════

    /**
     * Check and emit alerts for score changes
     */
    async _checkAndEmitAlert(symbol, scoreResult) {
        const lastAlert = this.lastAlerts.get(symbol);
        const currentAlert = scoreResult.alert;

        // Only alert on state changes or critical issues
        if (lastAlert !== currentAlert) {
            this.lastAlerts.set(symbol, currentAlert);

            const token = INFRA_TOKENS[symbol];

            if (currentAlert === ALERT_LEVEL.CRITICAL) {
                logger.error(`[InfraScore] 🚨 CRITICAL: ${symbol} I_infra=${scoreResult.score.toFixed(1)} (threshold: ${HEALTH_THRESHOLDS.CRITICAL.toFixed(1)})`);

                // Record alert
                await this._recordAlert(symbol, currentAlert, scoreResult);

                // If critical token, this is a major incident
                if (token.critical) {
                    logger.error(`[InfraScore] ⚠️ CRITICAL INFRASTRUCTURE DEGRADED: ${token.name}`);
                }
            } else if (currentAlert === ALERT_LEVEL.WARNING) {
                logger.warn(`[InfraScore] ⚠️ WARNING: ${symbol} I_infra=${scoreResult.score.toFixed(1)} (threshold: ${HEALTH_THRESHOLDS.WARNING.toFixed(1)})`);
                await this._recordAlert(symbol, currentAlert, scoreResult);
            } else if (lastAlert && lastAlert !== ALERT_LEVEL.HEALTHY) {
                logger.info(`[InfraScore] ✅ RECOVERED: ${symbol} I_infra=${scoreResult.score.toFixed(1)}`);
                await this._recordAlert(symbol, 'recovered', scoreResult);
            }
        }
    }

    /**
     * Record alert to database
     */
    async _recordAlert(symbol, alertLevel, scoreResult) {
        try {
            await this.db.query(`
                INSERT INTO infra_alerts (symbol, alert_level, score, components, recorded_at)
                VALUES ($1, $2, $3, $4, NOW())
            `, [
                symbol,
                alertLevel,
                scoreResult.score,
                JSON.stringify(scoreResult.components)
            ]);
        } catch (error) {
            logger.warn(`[InfraScore] Failed to record alert: ${error.message}`);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // DATA RECORDING
    // ═══════════════════════════════════════════════════════════════

    /**
     * Record liquidity snapshot
     */
    async recordLiquiditySnapshot(symbol, data) {
        const { totalLiquidity, change24h, poolCount } = data;

        await this.db.query(`
            INSERT INTO infra_liquidity (symbol, total_liquidity, liquidity_24h_change, pool_count)
            VALUES ($1, $2, $3, $4)
        `, [symbol, totalLiquidity, change24h, poolCount]);

        // Invalidate cache
        this.cache.delete(`infra:${symbol}`);
    }

    /**
     * Record oracle price update
     */
    async recordOraclePrice(symbol, data) {
        const { price, confidence, source } = data;

        await this.db.query(`
            INSERT INTO oracle_prices (symbol, price, confidence, source, last_update)
            VALUES ($1, $2, $3, $4, NOW())
        `, [symbol, price, confidence, source]);

        // Invalidate cache
        this.cache.delete(`infra:${symbol}`);
    }

    /**
     * Record health check result
     */
    async recordHealthCheck(symbol, data) {
        const { isAvailable, responseTimeMs, uptimePercent } = data;

        await this.db.query(`
            INSERT INTO infra_health_checks (symbol, is_available, response_time_ms, uptime_percent)
            VALUES ($1, $2, $3, $4)
        `, [symbol, isAvailable, responseTimeMs, uptimePercent]);

        // Invalidate cache
        this.cache.delete(`infra:${symbol}`);
    }

    // ═══════════════════════════════════════════════════════════════
    // STATISTICS
    // ═══════════════════════════════════════════════════════════════

    /**
     * Get historical I_infra scores
     */
    async getHistoricalScores(symbol, days = 7) {
        const result = await this.db.query(`
            SELECT
                DATE_TRUNC('hour', recorded_at) as timestamp,
                AVG(score) as avg_score,
                MIN(score) as min_score,
                MAX(score) as max_score
            FROM infra_score_history
            WHERE symbol = $1
              AND recorded_at > NOW() - INTERVAL '${days} days'
            GROUP BY DATE_TRUNC('hour', recorded_at)
            ORDER BY timestamp DESC
        `, [symbol]);

        return result.rows;
    }

    /**
     * Get all alerts in time range
     */
    async getAlertHistory(hours = 24) {
        const result = await this.db.query(`
            SELECT
                symbol, alert_level, score, components, recorded_at
            FROM infra_alerts
            WHERE recorded_at > NOW() - INTERVAL '${hours} hours'
            ORDER BY recorded_at DESC
            LIMIT 100
        `);

        return result.rows;
    }

    /**
     * Get infrastructure dashboard data
     */
    async getDashboard() {
        const [aggregate, critical, alerts] = await Promise.all([
            this.getAggregateInfraScore(),
            this.getCriticalInfraStatus(),
            this.getAlertHistory(24)
        ]);

        return {
            aggregate,
            critical,
            recentAlerts: alerts.slice(0, 10),
            thresholds: HEALTH_THRESHOLDS,
            tokens: INFRA_TOKENS,
            phi: {
                PHI,
                PHI_SQ,
                PHI_INV,
                PHI_INV_SQ
            }
        };
    }
}

// Singleton pattern
let instance = null;

function getInfraScoreService(db) {
    if (!instance && db) {
        instance = new InfraScoreService(db);
    }
    return instance;
}

module.exports = {
    InfraScoreService,
    getInfraScoreService,
    INFRA_TOKENS,
    HEALTH_THRESHOLDS,
    ALERT_LEVEL,
    // Export φ constants for consistency
    PHI,
    PHI_SQ,
    PHI_INV,
    PHI_INV_SQ
};
