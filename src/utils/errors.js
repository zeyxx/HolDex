/**
 * HolDex Error Hierarchy — Typed Errors with Recovery Semantics
 *
 * Philosophy: Every error type knows if it's recoverable
 * Every error carries context for diagnostics
 * Every error has a recovery strategy
 *
 * Patterns from: ConnectorKit (typed-errors.ts) + solana-dev-skill
 */

const logger = require('../services/logger');

// ============================================
// BASE ERROR CLASS
// ============================================

class HolDexError extends Error {
    /**
     * @param {string} code - Machine-readable error code (e.g., 'RPC_NETWORK_TIMEOUT')
     * @param {string} message - Human-readable error message
     * @param {Object} context - Additional diagnostic context
     * @param {boolean} recoverable - Can this error be retried?
     */
    constructor(code, message, context = {}, recoverable = false) {
        super(message);
        this.name = 'HolDexError';
        this.code = code;
        this.context = context;
        this.recoverable = recoverable;
        this.timestamp = new Date().toISOString();
        this.severity = 'error';

        // Capture stack trace
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }

    /**
     * Serialize for logging/API responses
     */
    toJSON() {
        return {
            code: this.code,
            message: this.message,
            context: this.context,
            recoverable: this.recoverable,
            severity: this.severity,
            timestamp: this.timestamp,
            stack: this.stack,
        };
    }

    /**
     * Short diagnostic string for logging
     */
    toString() {
        return `${this.code}: ${this.message}${this.recoverable ? ' (recoverable)' : ''}`;
    }
}

// ============================================
// RPC ERRORS (Network, Provider, Timeout)
// ============================================

class RpcError extends HolDexError {
    constructor(method, statusCode, message, context = {}) {
        const isRecoverable = statusCode >= 500 || statusCode === 429 || statusCode === 408;
        super('RPC_ERROR', message, { method, statusCode, ...context }, isRecoverable);
        this.name = 'RpcError';
        this.statusCode = statusCode;
        this.method = method;
    }
}

class RpcTimeoutError extends RpcError {
    constructor(method, timeoutMs, context = {}) {
        super(method, 408, `RPC call ${method} timed out after ${timeoutMs}ms`, context);
        this.name = 'RpcTimeoutError';
        this.code = 'RPC_TIMEOUT';
        this.recoverable = true; // Always retry on timeout
        this.severity = 'warn';
    }
}

class RpcNetworkError extends RpcError {
    constructor(method, originalError, context = {}) {
        super(
            method,
            0,
            `Network error calling ${method}: ${originalError.message}`,
            { originalError: originalError.message, ...context }
        );
        this.name = 'RpcNetworkError';
        this.code = 'RPC_NETWORK_ERROR';
        this.recoverable = true; // Try failover
    }
}

class RpcProviderUnavailableError extends RpcError {
    constructor(provider, method, context = {}) {
        super(
            method,
            503,
            `RPC provider ${provider} unavailable (circuit breaker open or all providers failed)`,
            { provider, ...context }
        );
        this.name = 'RpcProviderUnavailableError';
        this.code = 'RPC_PROVIDER_UNAVAILABLE';
        this.recoverable = false; // Fail fast, user must retry
        this.severity = 'critical';
    }
}

class RpcAuthError extends RpcError {
    constructor(method, context = {}) {
        super(method, 401, `Authentication failed for ${method}`, context);
        this.name = 'RpcAuthError';
        this.code = 'RPC_AUTH_FAILED';
        this.recoverable = false; // Auth failure won't resolve by retry
        this.severity = 'critical';
    }
}

class RpcRateLimitError extends RpcError {
    constructor(method, retryAfterMs, creditsRemaining = 0, context = {}) {
        super(
            method,
            429,
            `Rate limited on ${method}. Retry after ${retryAfterMs}ms (${creditsRemaining} credits remaining)`,
            { retryAfterMs, creditsRemaining, ...context }
        );
        this.name = 'RpcRateLimitError';
        this.code = 'RPC_RATE_LIMIT';
        this.recoverable = true; // Can retry after delay
        this.retryAfterMs = retryAfterMs;
        this.creditsRemaining = creditsRemaining;
    }
}

class RpcServerError extends RpcError {
    constructor(method, statusCode, message, context = {}) {
        super(method, statusCode, `Server error (${statusCode}) on ${method}: ${message}`, context);
        this.name = 'RpcServerError';
        this.code = 'RPC_SERVER_ERROR';
        this.recoverable = true; // Server errors often transient
    }
}

class RpcCircuitBreakerError extends RpcError {
    constructor(method, breaker, context = {}) {
        super(method, 503, `Circuit breaker open for ${method} (${breaker})`, context);
        this.name = 'RpcCircuitBreakerError';
        this.code = 'RPC_CIRCUIT_BREAKER_OPEN';
        this.recoverable = false; // Wait for breaker to reset
        this.breaker = breaker;
    }
}

class AllProvidersFailedError extends RpcError {
    constructor(method, providerErrors = {}, context = {}) {
        const summary = Object.entries(providerErrors)
            .map(([provider, err]) => `${provider}: ${err.message}`)
            .join('; ');
        super(method, 503, `All RPC providers failed: ${summary}`, { providerErrors, ...context });
        this.name = 'AllProvidersFailedError';
        this.code = 'ALL_PROVIDERS_FAILED';
        this.recoverable = false;
        this.severity = 'critical';
        this.providerErrors = providerErrors;
    }
}

class ProviderHealthError extends RpcError {
    constructor(provider, reason, context = {}) {
        super('health_check', 503, `Provider ${provider} health check failed: ${reason}`, context);
        this.name = 'ProviderHealthError';
        this.code = 'PROVIDER_HEALTH_CHECK_FAILED';
        this.recoverable = true;
        this.provider = provider;
        this.reason = reason;
    }
}

// ============================================
// CACHE/REDIS ERRORS
// ============================================

class CacheError extends HolDexError {
    constructor(operation, key, message, context = {}) {
        super(
            'CACHE_ERROR',
            `Cache ${operation} failed for ${key}: ${message}`,
            { operation, key, ...context },
            true // Cache errors are recoverable (fall back to DB)
        );
        this.name = 'CacheError';
        this.operation = operation;
        this.key = key;
    }
}

class CacheSetError extends CacheError {
    constructor(key, ttl, context = {}) {
        super('set', key, `Failed to write to cache (TTL: ${ttl}s)`, context);
        this.code = 'CACHE_SET_FAILED';
        this.ttl = ttl;
    }
}

class CacheInvalidationError extends CacheError {
    constructor(key, context = {}) {
        super('invalidate', key, 'Failed to invalidate cache', context);
        this.code = 'CACHE_INVALIDATION_FAILED';
    }
}

class CacheHitError extends CacheError {
    constructor(key, context = {}) {
        super('get', key, 'Cache read failed, falling back to database', context);
        this.code = 'CACHE_READ_FAILED';
    }
}

class MintRegistryError extends CacheError {
    constructor(operation, mint, context = {}) {
        super(operation, `mints:registry:${mint}`, `Mint registry ${operation} failed for ${mint}`, context);
        this.code = 'MINT_REGISTRY_ERROR';
        this.mint = mint;
    }
}

// ============================================
// DATA MUTATION ERRORS
// ============================================

class DataMutationError extends HolDexError {
    constructor(table, operation, message, context = {}) {
        super(
            'DATA_MUTATION_ERROR',
            `${table} ${operation} failed: ${message}`,
            { table, operation, ...context },
            false
        );
        this.name = 'DataMutationError';
        this.table = table;
        this.operation = operation;
    }
}

class VolumeUpdateError extends DataMutationError {
    constructor(pool, reason, context = {}) {
        super('pools', 'volume_update', `Failed to update volume for pool ${pool}: ${reason}`, context);
        this.code = 'VOLUME_UPDATE_FAILED';
        this.severity = 'error';
        this.pool = pool;
    }
}

class CandleInsertError extends DataMutationError {
    constructor(pool, interval, reason, context = {}) {
        super('candles', 'insert', `Failed to insert ${interval}m candle for ${pool}: ${reason}`, context);
        this.code = 'CANDLE_INSERT_FAILED';
        this.pool = pool;
        this.interval = interval;
    }
}

class BatchProcessingError extends DataMutationError {
    constructor(batchSize, failedCount, reason, context = {}) {
        super('batch', 'process',
            `Batch processing failed: ${failedCount}/${batchSize} records. ${reason}`,
            { batchSize, failedCount, ...context }
        );
        this.code = 'BATCH_PROCESSING_FAILED';
        this.severity = 'critical';
        this.batchSize = batchSize;
        this.failedCount = failedCount;
    }
}

// ============================================
// WEBHOOK/AUDIT ERRORS
// ============================================

class WebhookError extends HolDexError {
    constructor(eventType, message, context = {}) {
        super(
            'WEBHOOK_ERROR',
            `Webhook ${eventType} error: ${message}`,
            { eventType, ...context },
            false
        );
        this.name = 'WebhookError';
        this.eventType = eventType;
    }
}

class WebhookAuthError extends WebhookError {
    constructor(reason, context = {}) {
        super('auth', `Signature verification failed: ${reason}`, context);
        this.code = 'WEBHOOK_AUTH_FAILED';
        this.severity = 'critical';
    }
}

class ReplayAttackError extends WebhookError {
    constructor(signature, reason, context = {}) {
        super('replay', `Replay attack detected: ${reason}`, { signature, ...context });
        this.code = 'REPLAY_ATTACK_DETECTED';
        this.severity = 'critical';
        this.signature = signature;
    }
}

class WebhookValidationError extends WebhookError {
    constructor(field, reason, context = {}) {
        super('validation', `Event validation failed on ${field}: ${reason}`, context);
        this.code = 'WEBHOOK_VALIDATION_FAILED';
        this.field = field;
    }
}

class AuditTrailError extends WebhookError {
    constructor(reason, context = {}) {
        super('audit', `Failed to log audit trail: ${reason}`, context);
        this.code = 'AUDIT_TRAIL_FAILED';
        this.severity = 'warn'; // Non-blocking, but concerning
        this.recoverable = false; // Audit trail can't be retried (event already processed)
    }
}

// ============================================
// WALLET ERRORS
// ============================================

class WalletError extends HolDexError {
    constructor(operation, wallet, message, context = {}) {
        super(
            'WALLET_ERROR',
            message,
            { operation, wallet, ...context },
            true // Wallets usually recoverable (reconnect)
        );
        this.name = 'WalletError';
        this.operation = operation;
        this.wallet = wallet;
    }
}

class WalletNotConnectedError extends WalletError {
    constructor(context = {}) {
        super('connect', null, 'No wallet connected', context);
        this.code = 'WALLET_NOT_CONNECTED';
        this.recoverable = true; // User can connect
    }
}

class WalletSignatureRejectedError extends WalletError {
    constructor(wallet, context = {}) {
        super('sign', wallet, `User rejected signature on ${wallet}`, context);
        this.code = 'WALLET_SIGNATURE_REJECTED';
        this.recoverable = true; // User can retry
        this.severity = 'warn';
    }
}

class WalletSignatureInvalidError extends WalletError {
    constructor(wallet, reason, context = {}) {
        super('sign', wallet, `Invalid signature from ${wallet}: ${reason}`, context);
        this.code = 'WALLET_SIGNATURE_INVALID';
        this.recoverable = true; // User can try different wallet
    }
}

// ============================================
// TRANSACTION ERRORS
// ============================================

class TransactionError extends HolDexError {
    constructor(signature, message, context = {}) {
        super('TRANSACTION_ERROR', message, { signature, ...context }, false);
        this.name = 'TransactionError';
        this.signature = signature;
    }
}

class TransactionValidationError extends TransactionError {
    constructor(reason, context = {}) {
        super(null, `Transaction validation failed: ${reason}`, context);
        this.code = 'TRANSACTION_VALIDATION_ERROR';
        this.reason = reason;
    }
}

class TransactionTooLargeError extends TransactionValidationError {
    constructor(size, maxSize = 1232, context = {}) {
        super(`Transaction too large (${size}B, max ${maxSize}B)`, context);
        this.code = 'TRANSACTION_TOO_LARGE';
        this.size = size;
        this.maxSize = maxSize;
    }
}

class TransactionConfirmationTimeoutError extends TransactionError {
    constructor(signature, timeoutMs, context = {}) {
        super(
            signature,
            `Transaction confirmation timeout after ${timeoutMs}ms: ${signature}`,
            context
        );
        this.code = 'TRANSACTION_CONFIRMATION_TIMEOUT';
        this.recoverable = true; // Can check status or replay
        this.severity = 'warn';
    }
}

class TransactionFailedError extends TransactionError {
    constructor(signature, reason, context = {}) {
        super(signature, `Transaction failed: ${reason}`, context);
        this.code = 'TRANSACTION_FAILED';
        this.reason = reason;
        this.recoverable = false; // Failed, need new signature
    }
}

// ============================================
// VALIDATION ERRORS
// ============================================

class ValidationError extends HolDexError {
    constructor(field, reason, context = {}) {
        super('VALIDATION_ERROR', `Validation failed on ${field}: ${reason}`, context, false);
        this.name = 'ValidationError';
        this.field = field;
        this.reason = reason;
    }
}

class InvalidSignatureError extends ValidationError {
    constructor(wallet, context = {}) {
        super('signature', `Invalid wallet signature from ${wallet}`, context);
        this.code = 'INVALID_SIGNATURE';
        this.wallet = wallet;
    }
}

class SignatureExpiredError extends ValidationError {
    constructor(expiryTime, context = {}) {
        super('signature', `Signature expired at ${expiryTime}`, context);
        this.code = 'SIGNATURE_EXPIRED';
        this.expiryTime = expiryTime;
    }
}

// ============================================
// CONFIGURATION ERRORS
// ============================================

class ConfigurationError extends HolDexError {
    constructor(variable, message, context = {}) {
        super(
            'CONFIGURATION_ERROR',
            `Configuration error: ${variable} - ${message}`,
            context,
            false
        );
        this.name = 'ConfigurationError';
        this.variable = variable;
    }
}

class MissingApiKeyError extends ConfigurationError {
    constructor(provider, context = {}) {
        super(provider, `API key not configured for ${provider}`, context);
        this.code = 'MISSING_API_KEY';
        this.provider = provider;
    }
}

class DatabaseNotInitializedError extends ConfigurationError {
    constructor(context = {}) {
        super('DATABASE', 'Database connection not initialized', context);
        this.code = 'DATABASE_NOT_INITIALIZED';
        this.severity = 'critical';
    }
}

// ============================================
// ERROR FACTORY PATTERN
// ============================================

const Errors = {
    // RPC
    rpcTimeout: (method, timeoutMs) =>
        new RpcTimeoutError(method, timeoutMs),

    rpcNetwork: (method, error) =>
        new RpcNetworkError(method, error),

    rpcProviderUnavailable: (provider, method) =>
        new RpcProviderUnavailableError(provider, method),

    rpcMethodFailed: (method, statusCode, message) =>
        new RpcError(method, statusCode, message),

    rpcAuth: (method) =>
        new RpcAuthError(method),

    rpcRateLimit: (method, retryAfterMs, creditsRemaining) =>
        new RpcRateLimitError(method, retryAfterMs, creditsRemaining),

    rpcServer: (method, statusCode, message) =>
        new RpcServerError(method, statusCode, message),

    rpcCircuitBreaker: (method, breaker) =>
        new RpcCircuitBreakerError(method, breaker),

    allProvidersFailed: (method, providerErrors) =>
        new AllProvidersFailedError(method, providerErrors),

    providerHealth: (provider, reason) =>
        new ProviderHealthError(provider, reason),

    // Cache
    cacheSet: (key, ttl) =>
        new CacheSetError(key, ttl),

    cacheInvalidation: (key) =>
        new CacheInvalidationError(key),

    cacheHit: (key) =>
        new CacheHitError(key),

    mintRegistry: (operation, mint) =>
        new MintRegistryError(operation, mint),

    // Data Mutation
    volumeUpdate: (pool, reason) =>
        new VolumeUpdateError(pool, reason),

    candleInsert: (pool, interval, reason) =>
        new CandleInsertError(pool, interval, reason),

    batchProcessing: (batchSize, failedCount, reason) =>
        new BatchProcessingError(batchSize, failedCount, reason),

    // Webhook
    webhookAuth: (reason) =>
        new WebhookAuthError(reason),

    replayAttack: (signature, reason) =>
        new ReplayAttackError(signature, reason),

    webhookValidation: (field, reason) =>
        new WebhookValidationError(field, reason),

    auditTrail: (reason) =>
        new AuditTrailError(reason),

    // Wallet
    walletNotConnected: () =>
        new WalletNotConnectedError(),

    walletSignatureRejected: (wallet) =>
        new WalletSignatureRejectedError(wallet),

    walletSignatureInvalid: (wallet, reason) =>
        new WalletSignatureInvalidError(wallet, reason),

    // Transaction
    transactionValidation: (reason) =>
        new TransactionValidationError(reason),

    transactionTooLarge: (size, maxSize) =>
        new TransactionTooLargeError(size, maxSize),

    transactionConfirmationTimeout: (signature, timeoutMs) =>
        new TransactionConfirmationTimeoutError(signature, timeoutMs),

    transactionFailed: (signature, reason) =>
        new TransactionFailedError(signature, reason),

    // Validation
    invalidSignature: (wallet) =>
        new InvalidSignatureError(wallet),

    signatureExpired: (expiryTime) =>
        new SignatureExpiredError(expiryTime),

    // Configuration
    missingApiKey: (provider) =>
        new MissingApiKeyError(provider),

    databaseNotInitialized: () =>
        new DatabaseNotInitializedError(),
};

// ============================================
// TYPE GUARDS
// ============================================

function isHolDexError(error) {
    return error instanceof HolDexError;
}

function isRecoverable(error) {
    return isHolDexError(error) && error.recoverable === true;
}

function isRpcError(error) {
    return error instanceof RpcError;
}

function isWalletError(error) {
    return error instanceof WalletError;
}

function isTransactionError(error) {
    return error instanceof TransactionError;
}

function isValidationError(error) {
    return error instanceof ValidationError;
}

function isConfigurationError(error) {
    return error instanceof ConfigurationError;
}

function isCacheError(error) {
    return error instanceof CacheError;
}

function isDataMutationError(error) {
    return error instanceof DataMutationError;
}

function isWebhookError(error) {
    return error instanceof WebhookError;
}

function isAuthError(error) {
    return error instanceof RpcAuthError || error instanceof WebhookAuthError;
}

function isCircuitBreakerOpen(error) {
    return error instanceof RpcCircuitBreakerError;
}

function isRateLimited(error) {
    return error instanceof RpcRateLimitError;
}

// ============================================
// ERROR HANDLER UTILITIES
// ============================================

/**
 * Determine retry strategy based on error type
 * @param {Error} error
 * @param {number} attemptCount - Current attempt number
 * @param {number} maxAttempts - Maximum retry attempts
 * @returns {Object} { shouldRetry: boolean, delayMs: number, reason: string }
 */
function getRetryStrategy(error, attemptCount = 1, maxAttempts = 3) {
    if (!isRecoverable(error)) {
        return { shouldRetry: false, reason: 'Error not recoverable' };
    }

    if (attemptCount >= maxAttempts) {
        return { shouldRetry: false, reason: 'Max attempts reached' };
    }

    // Exponential backoff: 100ms, 200ms, 400ms, 800ms...
    const delayMs = Math.min(100 * Math.pow(2, attemptCount - 1), 10000);

    return {
        shouldRetry: true,
        delayMs,
        reason: `Retrying (attempt ${attemptCount}/${maxAttempts})`,
    };
}

/**
 * Convert error to HTTP response
 * @param {Error} error
 * @returns {Object} { statusCode, body }
 */
function toHttpResponse(error) {
    if (isHolDexError(error)) {
        let statusCode = 500;

        if (isValidationError(error)) statusCode = 400;
        if (isWalletError(error)) statusCode = 401;
        if (isConfigurationError(error)) statusCode = 503;
        if (isRpcError(error) && error.statusCode) statusCode = error.statusCode;

        return {
            statusCode,
            body: {
                error: error.code,
                message: error.message,
                context: error.context,
                recoverable: error.recoverable,
            },
        };
    }

    // Generic error
    return {
        statusCode: 500,
        body: {
            error: 'INTERNAL_SERVER_ERROR',
            message: error.message,
            recoverable: false,
        },
    };
}

module.exports = {
    // Error classes — Base
    HolDexError,

    // Error classes — RPC
    RpcError,
    RpcTimeoutError,
    RpcNetworkError,
    RpcProviderUnavailableError,
    RpcAuthError,
    RpcRateLimitError,
    RpcServerError,
    RpcCircuitBreakerError,
    AllProvidersFailedError,
    ProviderHealthError,

    // Error classes — Cache
    CacheError,
    CacheSetError,
    CacheInvalidationError,
    CacheHitError,
    MintRegistryError,

    // Error classes — Data Mutation
    DataMutationError,
    VolumeUpdateError,
    CandleInsertError,
    BatchProcessingError,

    // Error classes — Webhook
    WebhookError,
    WebhookAuthError,
    ReplayAttackError,
    WebhookValidationError,
    AuditTrailError,

    // Error classes — Wallet
    WalletError,
    WalletNotConnectedError,
    WalletSignatureRejectedError,
    WalletSignatureInvalidError,

    // Error classes — Transaction
    TransactionError,
    TransactionValidationError,
    TransactionTooLargeError,
    TransactionConfirmationTimeoutError,
    TransactionFailedError,

    // Error classes — Validation
    ValidationError,
    InvalidSignatureError,
    SignatureExpiredError,

    // Error classes — Configuration
    ConfigurationError,
    MissingApiKeyError,
    DatabaseNotInitializedError,

    // Factory
    Errors,

    // Type guards
    isHolDexError,
    isRecoverable,
    isRpcError,
    isWalletError,
    isTransactionError,
    isValidationError,
    isConfigurationError,
    isCacheError,
    isDataMutationError,
    isWebhookError,
    isAuthError,
    isCircuitBreakerOpen,
    isRateLimited,

    // Utilities
    getRetryStrategy,
    toHttpResponse,
};
