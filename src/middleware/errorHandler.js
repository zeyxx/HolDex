/**
 * Error Handler Middleware — Phase 3
 *
 * Converts Phase 2 typed errors into standardized HTTP responses
 * Provides observability: logs all errors, tracks by type, enables dashboards
 *
 * Flow:
 * 1. Catch error (typed or generic)
 * 2. Classify error type
 * 3. Map to HTTP status code
 * 4. Log with context
 * 5. Return JSON response
 */

const logger = require('../services/logger');
const { isHolDexError, toHttpResponse } = require('../utils/errors');
const { trackErrorMetricToDB, getErrorMetricsFromDB, resetErrorMetricsDB } = require('../services/database');

/**
 * Error status code mapping
 */
const STATUS_CODE_MAP = {
    // RPC Errors
    'RPC_AUTH_FAILED': 401,
    'RPC_RATE_LIMIT': 429,
    'RPC_CIRCUIT_BREAKER_OPEN': 503,
    'RPC_TIMEOUT': 504,
    'RPC_SERVER_ERROR': 502,
    'RPC_NETWORK_ERROR': 503,
    'RPC_PROVIDER_UNAVAILABLE': 503,
    'ALL_PROVIDERS_FAILED': 503,

    // Cache Errors
    'CACHE_SET_FAILED': 500,
    'CACHE_INVALIDATION_FAILED': 500,
    'CACHE_HIT_ERROR': 500,

    // Data Mutation Errors
    'VOLUME_UPDATE_FAILED': 500,
    'CANDLE_INSERT_FAILED': 500,
    'BATCH_PROCESSING_FAILED': 500,

    // Webhook Errors
    'WEBHOOK_AUTH_FAILED': 401,
    'REPLAY_ATTACK_DETECTED': 403,
    'WEBHOOK_VALIDATION_FAILED': 400,
    'AUDIT_TRAIL_FAILED': 500,

    // Wallet Errors
    'WALLET_NOT_CONNECTED': 401,
    'WALLET_SIGNATURE_REJECTED': 401,
    'WALLET_SIGNATURE_INVALID': 400,

    // Transaction Errors
    'TRANSACTION_VALIDATION_FAILED': 400,
    'TRANSACTION_TOO_LARGE': 413,
    'TRANSACTION_CONFIRMATION_TIMEOUT': 504,
    'TRANSACTION_FAILED': 500,

    // Validation Errors
    'INVALID_SIGNATURE': 400,
    'SIGNATURE_EXPIRED': 401,

    // Configuration Errors
    'MISSING_API_KEY': 503,
    'DATABASE_NOT_INITIALIZED': 503,
};

/**
 * Main error handler middleware
 */
function errorHandler(err, req, res, next) {
    const startTime = Date.now();
    const endpoint = `${req.method} ${req.path}`;
    const requestId = req.id || 'unknown';

    // Determine status code
    let statusCode = 500;
    let errorCode = 'INTERNAL_SERVER_ERROR';
    let message = 'Internal server error';
    let context = {};
    let recoverable = false;

    if (isHolDexError(err)) {
        // Phase 2 typed error
        errorCode = err.code || 'UNKNOWN_ERROR';
        message = err.message;
        context = err.context || {};
        recoverable = err.recoverable === true;
        statusCode = STATUS_CODE_MAP[errorCode] || 500;

        // Log typed error with severity-appropriate logger method
        const severity = err.severity || 'error';
        const logData = {
            requestId,
            code: errorCode,
            message,
            recoverable,
            context,
            duration: Date.now() - startTime,
        };

        if (severity === 'critical') {
            logger.error(`[ErrorHandler] ${endpoint}`, logData);
        } else if (severity === 'warn') {
            logger.warn(`[ErrorHandler] ${endpoint}`, logData);
        } else {
            logger.error(`[ErrorHandler] ${endpoint}`, logData);
        }

        // Track metric for dashboard
        trackErrorMetric(err, endpoint);
    } else if (err instanceof SyntaxError && 'body' in err) {
        // JSON parse error
        statusCode = 400;
        errorCode = 'INVALID_JSON';
        message = 'Request body contains invalid JSON';
        logger.warn(`[ErrorHandler] ${endpoint}`, {
            requestId,
            code: errorCode,
            message,
            duration: Date.now() - startTime,
        });

        // Track metric
        trackErrorMetric(err, endpoint);
    } else {
        // Generic error
        message = err.message || 'Unknown error';
        logger.error(`[ErrorHandler] ${endpoint}`, {
            requestId,
            code: errorCode,
            message,
            stack: err.stack,
            duration: Date.now() - startTime,
        });

        // Track metric
        trackErrorMetric(err, endpoint);
    }

    // Send response
    res.status(statusCode).json({
        ok: false,
        error: {
            code: errorCode,
            message,
            recoverable,
            context: process.env.NODE_ENV === 'development' ? context : undefined,
        },
        requestId,
    });
}

/**
 * Async error wrapper - catches promise rejections in async routes
 */
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

/**
 * Track error metrics
 * @param {Error} err
 * @param {string} endpoint
 */
async function trackErrorMetric(err, endpoint) {
    if (!isHolDexError(err)) return;

    const errorType = err.code || 'unknown';
    const severity = err.severity || 'error';

    // Persist to database (Phase 3.2)
    try {
        await trackErrorMetricToDB(errorType, severity);
    } catch (e) {
        logger.warn(`[ErrorHandler] Failed to persist error metric: ${e.message}`);
    }
}

/**
 * Get error metrics for dashboard
 */
async function getErrorMetrics() {
    return await getErrorMetricsFromDB();
}

/**
 * Reset error metrics (for testing)
 */
async function resetErrorMetrics() {
    await resetErrorMetricsDB();
}

module.exports = {
    errorHandler,
    asyncHandler,
    trackErrorMetric,
    getErrorMetrics,
    resetErrorMetrics,
    STATUS_CODE_MAP,
};
