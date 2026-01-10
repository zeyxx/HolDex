/**
 * RPC Health Monitor
 *
 * Tracks health status of RPC providers for intelligent failover.
 * Uses Redis for distributed state across workers.
 */

const { getRedis } = require('./redis');
const logger = require('./logger');

// Configuration
const FAILURE_THRESHOLD = 3;      // Consecutive failures to mark unhealthy
const RECOVERY_THRESHOLD = 2;     // Consecutive successes to recover
const HEALTH_CHECK_INTERVAL = 30000; // 30 seconds
const STATS_TTL = 3600;           // 1 hour TTL for Redis stats

class RPCHealth {
    constructor() {
        this.stats = new Map();
        this.redisPrefix = 'rpc:health:';
    }

    /**
     * Get stats for a provider (memory + Redis sync)
     */
    async getStats(providerId) {
        // Try Redis first for distributed state
        const redis = getRedis();
        if (redis) {
            try {
                const key = `${this.redisPrefix}${providerId}`;
                const cached = await redis.get(key);
                if (cached) {
                    const stats = JSON.parse(cached);
                    this.stats.set(providerId, stats);
                    return stats;
                }
            } catch (_e) { /* fallback to memory */ }
        }

        // Memory fallback
        if (!this.stats.has(providerId)) {
            this.stats.set(providerId, this.createDefaultStats());
        }

        return this.stats.get(providerId);
    }

    /**
     * Create default stats object
     */
    createDefaultStats() {
        return {
            status: 'healthy',
            successes: 0,
            failures: 0,
            consecutiveFailures: 0,
            consecutiveSuccesses: 0,
            latencyMs: [],
            avgLatencyMs: 0,
            lastCheck: null,
            lastError: null,
            lastSuccess: null
        };
    }

    /**
     * Record a successful call
     */
    async recordSuccess(providerId, latencyMs = 0) {
        const stats = await this.getStats(providerId);

        stats.successes++;
        stats.consecutiveSuccesses++;
        stats.consecutiveFailures = 0;
        stats.lastSuccess = Date.now();

        // Track latency (keep last 100)
        if (latencyMs > 0) {
            stats.latencyMs.push(latencyMs);
            if (stats.latencyMs.length > 100) {
                stats.latencyMs.shift();
            }
            stats.avgLatencyMs = Math.round(
                stats.latencyMs.reduce((a, b) => a + b, 0) / stats.latencyMs.length
            );
        }

        // Recovery check
        if (stats.status !== 'healthy' && stats.consecutiveSuccesses >= RECOVERY_THRESHOLD) {
            const oldStatus = stats.status;
            stats.status = 'healthy';
            logger.info(`[RPCHealth] ${providerId}: ${oldStatus} → healthy (recovered)`);
        }

        await this.saveStats(providerId, stats);
    }

    /**
     * Record a failed call
     */
    async recordFailure(providerId, error) {
        const stats = await this.getStats(providerId);

        stats.failures++;
        stats.consecutiveFailures++;
        stats.consecutiveSuccesses = 0;
        stats.lastError = error?.message || String(error);
        stats.lastCheck = Date.now();

        // Degraded after some failures
        if (stats.consecutiveFailures >= Math.floor(FAILURE_THRESHOLD / 2) && stats.status === 'healthy') {
            stats.status = 'degraded';
            logger.warn(`[RPCHealth] ${providerId}: healthy → degraded (${stats.consecutiveFailures} failures)`);
        }

        // Unhealthy after threshold
        if (stats.consecutiveFailures >= FAILURE_THRESHOLD && stats.status !== 'unhealthy') {
            stats.status = 'unhealthy';
            logger.error(`[RPCHealth] ${providerId}: → unhealthy (${stats.consecutiveFailures} consecutive failures: ${stats.lastError})`);
        }

        await this.saveStats(providerId, stats);
    }

    /**
     * Save stats to Redis (fire-and-forget)
     */
    async saveStats(providerId, stats) {
        this.stats.set(providerId, stats);

        const redis = getRedis();
        if (redis) {
            const key = `${this.redisPrefix}${providerId}`;
            // Don't await - fire and forget
            redis.set(key, JSON.stringify(stats), 'EX', STATS_TTL).catch(() => {});
        }
    }

    /**
     * Get healthy providers from a priority list
     */
    async getHealthyProviders(priority) {
        const healthy = [];
        const degraded = [];

        for (const id of priority) {
            const stats = await this.getStats(id);

            if (stats.status === 'healthy') {
                healthy.push(id);
            } else if (stats.status === 'degraded') {
                degraded.push(id);
            }
            // Skip unhealthy
        }

        // Return healthy first, then degraded as fallback
        return [...healthy, ...degraded];
    }

    /**
     * Check if a specific provider is available
     */
    async isAvailable(providerId) {
        const stats = await this.getStats(providerId);
        return stats.status !== 'unhealthy';
    }

    /**
     * Force reset a provider to healthy (admin use)
     */
    async resetProvider(providerId) {
        const stats = this.createDefaultStats();
        await this.saveStats(providerId, stats);
        logger.info(`[RPCHealth] ${providerId}: force reset to healthy`);
    }

    /**
     * Get summary of all providers
     */
    async getSummary(providerIds) {
        const summary = {};

        for (const id of providerIds) {
            const stats = await this.getStats(id);
            summary[id] = {
                status: stats.status,
                successes: stats.successes,
                failures: stats.failures,
                avgLatencyMs: stats.avgLatencyMs,
                lastError: stats.lastError,
                lastSuccess: stats.lastSuccess ? new Date(stats.lastSuccess).toISOString() : null
            };
        }

        return summary;
    }
}

// Singleton
let instance = null;

function getRPCHealth() {
    if (!instance) {
        instance = new RPCHealth();
    }
    return instance;
}

module.exports = {
    RPCHealth,
    getRPCHealth,
    FAILURE_THRESHOLD,
    RECOVERY_THRESHOLD,
    HEALTH_CHECK_INTERVAL
};
