/**
 * Metrics Routes - RPC and System Metrics
 *
 * Provides visibility into:
 * - RPC deduplication effectiveness
 * - Credit usage and savings
 * - Request latencies
 * - Error rates
 */

const express = require('express');
const { getRPCProvider } = require('../services/rpcProvider');
const { getCreditMonitor } = require('../services/creditMonitor');

const router = express.Router();

/**
 * GET /metrics/credits
 * Credit usage metrics and deduplication savings
 */
router.get('/credits', (req, res) => {
    try {
        const rpc = getRPCProvider();
        const credits = getCreditMonitor();

        const dedupStats = rpc.getDeduplicationStats();
        credits.updateFromRPC(dedupStats);

        const metrics = credits.getMetrics();

        res.json({
            ok: true,
            metrics: {
                credits_used: metrics.estimatedCreditsUsed,
                credits_saved: metrics.creditsSaved,
                savings_percent: parseFloat(metrics.savingsPercent),
                rpc_calls_made: metrics.rpcCallsMade,
                rpc_calls_deduped: metrics.rpcCallsDedup,
                uptime_minutes: parseFloat(metrics.uptime_minutes),
                breakdown: metrics.breakdown,
                timestamp: metrics.timestamp
            }
        });
    } catch (err) {
        res.status(500).json({
            ok: false,
            error: 'Failed to fetch credit metrics',
            message: err.message
        });
    }
});

/**
 * GET /metrics/dedup
 * RPC deduplication statistics
 */
router.get('/dedup', (req, res) => {
    try {
        const rpc = getRPCProvider();
        const stats = rpc.getDeduplicationStats();

        res.json({
            ok: true,
            dedup: {
                total_requests: stats.totalRequests,
                deduplicated_requests: stats.deduplicatedRequests,
                percent_saved: stats.percentSaved,
                inflight_requests: stats.inflightCount
            }
        });
    } catch (err) {
        res.status(500).json({
            ok: false,
            error: 'Failed to fetch dedup stats',
            message: err.message
        });
    }
});

/**
 * POST /metrics/reset
 * Reset deduplication counters (for testing)
 */
router.post('/reset', (req, res) => {
    try {
        const rpc = getRPCProvider();
        const credits = getCreditMonitor();

        rpc.resetDeduplicationStats();
        credits.reset();

        res.json({
            ok: true,
            message: 'Metrics reset successfully'
        });
    } catch (err) {
        res.status(500).json({
            ok: false,
            error: 'Failed to reset metrics',
            message: err.message
        });
    }
});

/**
 * GET /metrics/health
 * Overall RPC health and provider status
 */
router.get('/health', async (req, res) => {
    try {
        const rpc = getRPCProvider();
        const health = await rpc.healthCheck();
        const summary = await rpc.getHealthSummary();

        res.json({
            ok: true,
            health: {
                providers: health,
                summary: summary
            }
        });
    } catch (err) {
        res.status(500).json({
            ok: false,
            error: 'Failed to fetch health',
            message: err.message
        });
    }
});

module.exports = router;
