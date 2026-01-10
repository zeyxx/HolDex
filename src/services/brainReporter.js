/**
 * Brain Reporter Service
 *
 * Sends metrics to asdf-brain for ecosystem-wide monitoring.
 * Uses CYNIC φ-constrained judgment for all data.
 *
 * "Don't trust, verify" - All metrics are φ-verified
 */

'use strict';

const https = require('https');
const logger = require('./logger');
const { getRPCHealth } = require('./rpcHealth');

// Configuration
const BRAIN_URL = process.env.BRAIN_URL || 'https://asdf-brain.onrender.com';
const BRAIN_METRICS_PATH = '/webhook/metrics';
const BRAIN_WEBHOOK_PATH = '/webhook/holdex';
const REPORT_INTERVAL = 5 * 60 * 1000; // 5 minutes
const NODE_ID = process.env.NODE_ID || process.env.RENDER_INSTANCE_ID || 'unknown';

// Track uptime
const startTime = Date.now();
let requestCount = 0;
let errorCount = 0;
let lastReportTime = null;

/**
 * Calculate current metrics
 */
async function collectMetrics() {
    const now = Date.now();
    const uptimeMs = now - startTime;
    const uptimePercent = 100; // We're up if this code is running

    // Get RPC health stats
    const rpcHealth = getRPCHealth();
    let avgLatency = 50; // Default
    let rpcErrors = 0;

    try {
        // Common RPC providers in HolDex
        const providers = ['helius-mainnet', 'quicknode', 'mainnet-beta'];
        let totalLatency = 0;
        let latencyCount = 0;

        for (const providerId of providers) {
            const stats = await rpcHealth.getStats(providerId);
            if (stats.avgLatencyMs > 0) {
                totalLatency += stats.avgLatencyMs;
                latencyCount++;
            }
            rpcErrors += stats.failures || 0;
        }

        if (latencyCount > 0) {
            avgLatency = Math.round(totalLatency / latencyCount);
        }
    } catch (e) {
        logger.warn(`[BrainReporter] Failed to get RPC stats: ${e.message}`);
    }

    // Calculate error rate (last period)
    const totalRequests = requestCount || 1;
    const errorRate = (errorCount / totalRequests) * 100;

    return {
        uptime: uptimePercent,
        response_time_ms: avgLatency,
        error_rate: Math.min(errorRate, 100),
        requests_total: requestCount,
        errors_total: errorCount,
        rpc_errors: rpcErrors,
        uptime_ms: uptimeMs
    };
}

/**
 * Send metrics to asdf-brain
 */
async function reportMetrics() {
    try {
        const metrics = await collectMetrics();

        const payload = JSON.stringify({
            service: 'holdex-api',
            node: NODE_ID,
            period: new Date().toISOString().slice(0, 7), // YYYY-MM
            metrics: {
                uptime: metrics.uptime,
                response_time_ms: metrics.response_time_ms,
                error_rate: metrics.error_rate
            },
            _extended: {
                requests_total: metrics.requests_total,
                errors_total: metrics.errors_total,
                rpc_errors: metrics.rpc_errors,
                uptime_ms: metrics.uptime_ms
            }
        });

        const url = new URL(BRAIN_METRICS_PATH, BRAIN_URL);

        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'X-Source': 'holdex-api',
                'X-Node': NODE_ID
            },
            timeout: 10000
        };

        return new Promise((resolve, _reject) => {
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        lastReportTime = Date.now();
                        logger.info(`[BrainReporter] ✅ Metrics sent: I_infra=${JSON.parse(data)?.i_infra?.score || 'N/A'}`);
                        resolve(JSON.parse(data));
                    } else {
                        logger.warn(`[BrainReporter] ⚠️ Non-200 response: ${res.statusCode}`);
                        resolve(null);
                    }
                });
            });

            req.on('error', (e) => {
                logger.warn(`[BrainReporter] ⚠️ Failed to report: ${e.message}`);
                resolve(null); // Don't reject - this is non-critical
            });

            req.on('timeout', () => {
                req.destroy();
                logger.warn('[BrainReporter] ⚠️ Request timeout');
                resolve(null);
            });

            req.write(payload);
            req.end();
        });

    } catch (e) {
        logger.warn(`[BrainReporter] ⚠️ Error collecting metrics: ${e.message}`);
        return null;
    }
}

/**
 * Send event to asdf-brain webhook
 */
async function sendEvent(eventType, data) {
    try {
        const payload = JSON.stringify({
            type: eventType,
            source: 'holdex-api',
            node: NODE_ID,
            timestamp: new Date().toISOString(),
            data
        });

        const url = new URL(BRAIN_WEBHOOK_PATH, BRAIN_URL);

        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                'X-Source': 'holdex-api',
                'X-Event-Type': eventType
            },
            timeout: 10000
        };

        return new Promise((resolve) => {
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        logger.info(`[BrainReporter] ✅ Event sent: ${eventType}`);
                        resolve(JSON.parse(data));
                    } else {
                        resolve(null);
                    }
                });
            });

            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });

            req.write(payload);
            req.end();
        });

    } catch (_e) {
        return null;
    }
}

/**
 * Increment request counter (call from middleware)
 */
function recordRequest() {
    requestCount++;
}

/**
 * Increment error counter (call from error handler)
 */
function recordError() {
    errorCount++;
}

/**
 * Start periodic reporting
 */
function startReporting() {
    // Initial report after 30 seconds (let system stabilize)
    setTimeout(() => {
        reportMetrics();

        // Then report every REPORT_INTERVAL
        setInterval(reportMetrics, REPORT_INTERVAL);

        logger.info(`[BrainReporter] 🧠 Started reporting to ${BRAIN_URL} every ${REPORT_INTERVAL / 1000}s`);
    }, 30000);

    // Send startup event
    sendEvent('startup', {
        version: process.env.npm_package_version || '1.0.0',
        node_id: NODE_ID,
        timestamp: new Date().toISOString()
    });
}

/**
 * Get reporter status
 */
function getStatus() {
    return {
        brain_url: BRAIN_URL,
        node_id: NODE_ID,
        report_interval_ms: REPORT_INTERVAL,
        last_report: lastReportTime ? new Date(lastReportTime).toISOString() : null,
        requests_tracked: requestCount,
        errors_tracked: errorCount,
        uptime_ms: Date.now() - startTime
    };
}

module.exports = {
    startReporting,
    reportMetrics,
    sendEvent,
    recordRequest,
    recordError,
    collectMetrics,
    getStatus
};
