/**
 * Credit Monitor - RPC Credit Usage Tracking
 *
 * Tracks Helius API credit consumption and validates deduplication savings.
 *
 * Helius Credit Model:
 * - Standard RPC calls: 1 credit per call
 * - Enhanced API calls: 2-10 credits depending on complexity
 * - WebSocket: 1 credit per transaction received
 *
 * Goal: Measure credit reduction from RPC deduplication (target: 30% savings)
 */

const logger = require('./logger');

class CreditMonitor {
    constructor() {
        this.metrics = {
            period: null,
            startTime: null,
            estimatedCreditsUsed: 0,
            rpcCallsMade: 0,
            rpcCallsDedup: 0,
            creditsSaved: 0,
            savingsPercent: 0,
            breakdown: {
                method_counts: {},      // counts per RPC method
                provider_usage: {}      // credits per provider
            }
        };
        this.sessionStart = Date.now();
    }

    /**
     * Record RPC call execution
     */
    recordCall(method, provider = 'helius', creditsUsed = 1, wasDeduped = false) {
        this.metrics.rpcCallsMade++;

        if (wasDeduped) {
            this.metrics.rpcCallsDedup++;
            // Deduped call would have cost these credits - add to savings, not used
            this.metrics.creditsSaved += creditsUsed;
        } else {
            // Only count credits for actual calls, not deduped ones
            this.metrics.estimatedCreditsUsed += creditsUsed;
        }

        // Track method breakdown
        if (!this.metrics.breakdown.method_counts[method]) {
            this.metrics.breakdown.method_counts[method] = { made: 0, dedup: 0, credits: 0 };
        }
        this.metrics.breakdown.method_counts[method].made++;
        this.metrics.breakdown.method_counts[method].credits += creditsUsed;
        if (wasDeduped) {
            this.metrics.breakdown.method_counts[method].dedup++;
        }

        // Track provider usage
        if (!this.metrics.breakdown.provider_usage[provider]) {
            this.metrics.breakdown.provider_usage[provider] = { calls: 0, credits: 0 };
        }
        this.metrics.breakdown.provider_usage[provider].calls++;
        this.metrics.breakdown.provider_usage[provider].credits += creditsUsed;

        // Calculate savings percentage (savings / total possible credits without dedup * 100)
        if (this.metrics.rpcCallsMade > 0) {
            const totalWithoutDedup = this.metrics.creditsSaved + this.metrics.estimatedCreditsUsed;
            this.metrics.savingsPercent = totalWithoutDedup > 0
                ? (this.metrics.creditsSaved / totalWithoutDedup * 100).toFixed(1)
                : '0.0';
        }
    }

    /**
     * Update metrics from RPCProvider deduplication stats
     */
    updateFromRPC(dedupStats) {
        if (!dedupStats) return;

        const totalRequests = dedupStats.totalRequests || 0;
        const deduplicatedRequests = dedupStats.deduplicatedRequests || 0;

        if (totalRequests === 0) return;

        // Estimate credits saved (1 credit per deduplicated request)
        const estimatedSavings = deduplicatedRequests * 1;
        const dedupRate = (deduplicatedRequests / totalRequests * 100).toFixed(1);

        logger.info(`[CreditMonitor] RPC Deduplication Stats:`);
        logger.info(`  Total Requests: ${totalRequests}`);
        logger.info(`  Deduplicated: ${deduplicatedRequests} (${dedupRate}%)`);
        logger.info(`  Estimated Credits Saved: ${estimatedSavings}`);

        this.metrics.rpcCallsMade = totalRequests;
        this.metrics.rpcCallsDedup = deduplicatedRequests;
        this.metrics.creditsSaved = estimatedSavings;
        this.metrics.savingsPercent = dedupRate;
    }

    /**
     * Get current metrics snapshot
     */
    getMetrics() {
        const uptime = Date.now() - this.sessionStart;
        return {
            ...this.metrics,
            uptime_ms: uptime,
            uptime_minutes: (uptime / 1000 / 60).toFixed(2),
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Get summary for logging
     */
    getSummary() {
        const metrics = this.getMetrics();
        const percent = typeof metrics.savingsPercent === 'number' ? metrics.savingsPercent.toFixed(1) : metrics.savingsPercent;
        return `RPC Credits: ${metrics.estimatedCreditsUsed} used | ` +
               `${metrics.creditsSaved} saved (${percent}% dedup) | ` +
               `Calls: ${metrics.rpcCallsMade} made, ${metrics.rpcCallsDedup} deduped`;
    }

    /**
     * Reset metrics
     */
    reset() {
        this.metrics = {
            period: null,
            startTime: null,
            estimatedCreditsUsed: 0,
            rpcCallsMade: 0,
            rpcCallsDedup: 0,
            creditsSaved: 0,
            savingsPercent: 0,
            breakdown: {
                method_counts: {},
                provider_usage: {}
            }
        };
        this.sessionStart = Date.now();
        logger.info('[CreditMonitor] Metrics reset');
    }
}

// Singleton instance
let instance = null;

function getCreditMonitor() {
    if (!instance) {
        instance = new CreditMonitor();
    }
    return instance;
}

module.exports = {
    CreditMonitor,
    getCreditMonitor
};
