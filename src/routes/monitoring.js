/**
 * Monitoring Routes — Phase 3
 *
 * Endpoints for:
 * - Error metrics dashboard
 * - System health status
 * - Error rate tracking
 */

const express = require('express');
const router = express.Router();
const logger = require('../services/logger');
const { getErrorMetrics } = require('../middleware/errorHandler');

/**
 * GET /monitoring/errors
 * Returns error metrics for dashboard
 */
router.get('/errors', (req, res) => {
    try {
        const metrics = getErrorMetrics();

        // Calculate error rates
        const errorsByType = {};
        let totalErrors = 0;

        for (const [errorCode, data] of Object.entries(metrics)) {
            errorsByType[errorCode] = {
                count: data.count,
                severity: data.severity,
                lastOccurrence: data.lastOccurrence,
            };
            totalErrors += data.count;
        }

        // Group by severity
        const bySeverity = {
            critical: [],
            error: [],
            warn: [],
        };

        for (const [code, data] of Object.entries(errorsByType)) {
            const severity = data.severity || 'error';
            if (!bySeverity[severity]) bySeverity[severity] = [];
            bySeverity[severity].push({ code, count: data.count, lastOccurrence: data.lastOccurrence });
        }

        // Sort by count
        for (const severity in bySeverity) {
            bySeverity[severity].sort((a, b) => b.count - a.count);
        }

        res.json({
            ok: true,
            timestamp: new Date().toISOString(),
            summary: {
                totalErrors,
                uniqueErrorTypes: Object.keys(errorsByType).length,
                byCritical: bySeverity.critical.length,
                byError: bySeverity.error.length,
                byWarning: bySeverity.warn.length,
            },
            errorsByType,
            bySeverity,
        });
    } catch (e) {
        logger.error('[Monitoring] /errors failed', { error: e.message });
        res.status(500).json({
            ok: false,
            error: { code: 'MONITORING_ERROR', message: e.message },
        });
    }
});

/**
 * GET /monitoring/errors/:code
 * Returns details for a specific error code
 */
router.get('/errors/:code', (req, res) => {
    try {
        const { code } = req.params;
        const metrics = getErrorMetrics();
        const errorData = metrics[code];

        if (!errorData) {
            return res.status(404).json({
                ok: false,
                error: { code: 'ERROR_TYPE_NOT_FOUND', message: `Error type ${code} not found` },
            });
        }

        res.json({
            ok: true,
            timestamp: new Date().toISOString(),
            code,
            data: errorData,
        });
    } catch (e) {
        logger.error('[Monitoring] /errors/:code failed', { error: e.message });
        res.status(500).json({
            ok: false,
            error: { code: 'MONITORING_ERROR', message: e.message },
        });
    }
});

/**
 * GET /monitoring/health
 * System health check
 */
router.get('/health', (req, res) => {
    try {
        const metrics = getErrorMetrics();
        let status = 'healthy';
        let issues = [];

        // Count critical errors
        const criticalCount = Object.values(metrics)
            .filter(m => m.severity === 'critical')
            .reduce((sum, m) => sum + m.count, 0);

        if (criticalCount > 10) {
            status = 'degraded';
            issues.push(`${criticalCount} critical errors in recent period`);
        }

        // Check RPC health (if available)
        const rpcErrors = Object.entries(metrics)
            .filter(([code]) => code.startsWith('RPC_'))
            .reduce((sum, [, data]) => sum + data.count, 0);

        if (rpcErrors > 50) {
            status = 'degraded';
            issues.push(`${rpcErrors} RPC errors in recent period`);
        }

        res.json({
            ok: true,
            status,
            issues,
            timestamp: new Date().toISOString(),
        });
    } catch (e) {
        logger.error('[Monitoring] /health failed', { error: e.message });
        res.status(500).json({
            ok: false,
            error: { code: 'MONITORING_ERROR', message: e.message },
        });
    }
});

module.exports = router;
