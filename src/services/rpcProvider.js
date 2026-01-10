/**
 * RPC Provider - Multi-Provider Abstraction Layer (L2)
 *
 * Provides unified interface to multiple RPC providers with:
 * - Automatic failover on errors
 * - Health-based routing
 * - Rate limiting integration
 * - Provider-specific capability awareness
 *
 * Architecture:
 *   Helius (primary) → Public (fallback)
 *
 * Enhanced APIs (Helius-only, graceful fallback):
 *   - getTransactionsForAddress (replaces getSignaturesForAddress + getTransaction)
 *   - getEnhancedTransactions
 *   - getTokenAccounts (DAS)
 */

const config = require('../config/env');
const logger = require('./logger');
const { getRPCHealth } = require('./rpcHealth');
const { waitForRateLimit } = require('./heliusRateLimiter');
const HeliusProvider = require('./providers/helius');
const PublicProvider = require('./providers/public');

class RPCProvider {
    constructor() {
        this.providers = new Map();
        this.priority = [];
        this.health = getRPCHealth();
        this.initialized = false;
    }

    /**
     * Initialize providers based on available credentials
     */
    initialize() {
        if (this.initialized) return;

        // Primary: Helius (if API key available)
        if (config.HELIUS_API_KEY) {
            try {
                this.providers.set('helius', new HeliusProvider(config.HELIUS_API_KEY));
                this.priority.push('helius');
                logger.info('[RPCProvider] Helius provider initialized (primary)');
            } catch (e) {
                logger.error(`[RPCProvider] Helius init failed: ${e.message}`);
            }
        }

        // Fallback: Public RPC (always available)
        this.providers.set('public', new PublicProvider());
        this.priority.push('public');
        logger.info('[RPCProvider] Public provider initialized (fallback)');

        this.initialized = true;
        logger.info(`[RPCProvider] Ready with ${this.providers.size} providers: ${this.priority.join(' → ')}`);
    }

    /**
     * Get a specific provider by ID
     */
    getProvider(id) {
        if (!this.initialized) this.initialize();
        return this.providers.get(id);
    }

    /**
     * Execute a method with automatic failover
     */
    async executeWithFallback(method, args, options = {}) {
        if (!this.initialized) this.initialize();

        const errors = [];
        const healthyProviders = await this.health.getHealthyProviders(this.priority);

        if (healthyProviders.length === 0) {
            // All providers unhealthy - try all anyway as last resort
            logger.warn('[RPCProvider] All providers unhealthy, trying anyway');
            healthyProviders.push(...this.priority);
        }

        for (const providerId of healthyProviders) {
            const provider = this.providers.get(providerId);

            if (!provider) continue;

            // Check if provider supports this method
            if (typeof provider[method] !== 'function') {
                continue;
            }

            try {
                // Rate limit for Helius
                if (providerId === 'helius') {
                    await waitForRateLimit();
                }

                const start = Date.now();
                const result = await provider[method](...args);
                const latency = Date.now() - start;

                // Record success
                await this.health.recordSuccess(providerId, latency);

                // Log if we used fallback
                if (providerId !== this.priority[0]) {
                    logger.debug(`[RPCProvider] ${method} succeeded via fallback: ${providerId}`);
                }

                return result;

            } catch (e) {
                await this.health.recordFailure(providerId, e);
                errors.push({ provider: providerId, error: e.message });
                logger.debug(`[RPCProvider] ${method} failed on ${providerId}: ${e.message}`);
            }
        }

        // All failed
        const errorSummary = errors.map(e => `${e.provider}: ${e.error}`).join('; ');
        throw new Error(`All RPC providers failed for ${method}: ${errorSummary}`);
    }

    // ============================================
    // STANDARD RPC METHODS (with fallback)
    // ============================================

    async getAccountInfo(pubkey) {
        return this.executeWithFallback('getAccountInfo', [pubkey]);
    }

    async getMultipleAccountsInfo(pubkeys) {
        return this.executeWithFallback('getMultipleAccountsInfo', [pubkeys]);
    }

    async getTokenLargestAccounts(mint) {
        return this.executeWithFallback('getTokenLargestAccounts', [mint]);
    }

    async getSignaturesForAddress(address, options = {}) {
        return this.executeWithFallback('getSignaturesForAddress', [address, options]);
    }

    async getProgramAccounts(programId, config) {
        return this.executeWithFallback('getProgramAccounts', [programId, config]);
    }

    // ============================================
    // HELIUS-ONLY METHODS (no fallback)
    // ============================================

    /**
     * Get enhanced transaction history
     * Helius-only - throws if Helius unavailable
     */
    async getEnhancedTransactions(address, options = {}) {
        if (!this.initialized) this.initialize();

        const helius = this.providers.get('helius');
        if (!helius) {
            throw new Error('Enhanced Transactions API requires Helius provider');
        }

        await waitForRateLimit();

        try {
            const start = Date.now();
            const result = await helius.getEnhancedTransactions(address, options);
            await this.health.recordSuccess('helius', Date.now() - start);
            return result;
        } catch (e) {
            await this.health.recordFailure('helius', e);
            throw e;
        }
    }

    /**
     * Get token accounts using DAS API
     * Helius-only - throws if Helius unavailable
     */
    async getTokenAccounts(mint, options = {}) {
        if (!this.initialized) this.initialize();

        const helius = this.providers.get('helius');
        if (!helius) {
            throw new Error('Token Accounts DAS API requires Helius provider');
        }

        await waitForRateLimit();

        try {
            const start = Date.now();
            const result = await helius.getTokenAccounts(mint, options);
            await this.health.recordSuccess('helius', Date.now() - start);
            return result;
        } catch (e) {
            await this.health.recordFailure('helius', e);
            throw e;
        }
    }

    /**
     * getTransactionsForAddress - Helius Enhanced RPC
     *
     * OPTIMIZATION: Single call replaces getSignaturesForAddress + getTransaction
     * - 2-10x lower latency
     * - Server-side sorting/filtering/pagination
     * - Returns parsed transactions with timestamps
     *
     * Helius-only - falls back to getSignaturesForAddress if Helius unavailable
     */
    async getTransactionsForAddress(address, options = {}) {
        if (!this.initialized) this.initialize();

        const helius = this.providers.get('helius');
        if (!helius) {
            // Graceful fallback to standard RPC
            logger.debug('[RPCProvider] getTransactionsForAddress falling back to getSignaturesForAddress');
            return this.getSignaturesForAddress(address, options);
        }

        await waitForRateLimit();

        try {
            const start = Date.now();
            const result = await helius.getTransactionsForAddress(address, options);
            await this.health.recordSuccess('helius', Date.now() - start);
            return result;
        } catch (e) {
            await this.health.recordFailure('helius', e);
            // Fallback to standard on error
            logger.warn(`[RPCProvider] getTransactionsForAddress failed, falling back: ${e.message}`);
            return this.getSignaturesForAddress(address, options);
        }
    }

    // ============================================
    // UTILITY METHODS
    // ============================================

    /**
     * Get raw Solana Connection (for legacy code)
     * Prefers Helius, falls back to public
     */
    getConnection() {
        if (!this.initialized) this.initialize();

        // Try Helius first
        const helius = this.providers.get('helius');
        if (helius) {
            return helius.getConnection();
        }

        // Fallback to public
        const publicProvider = this.providers.get('public');
        return publicProvider.getConnection();
    }

    /**
     * Health check all providers
     */
    async healthCheck() {
        if (!this.initialized) this.initialize();

        const results = {};

        for (const [id, provider] of this.providers) {
            try {
                results[id] = await provider.healthCheck();
            } catch (e) {
                results[id] = { healthy: false, error: e.message };
            }
        }

        return results;
    }

    /**
     * Get health summary
     */
    async getHealthSummary() {
        return this.health.getSummary(this.priority);
    }

    /**
     * Check if Helius is available
     */
    hasHelius() {
        return this.providers.has('helius');
    }

    /**
     * Get provider capabilities
     */
    getCapabilities() {
        const caps = {
            standardRpc: true,
            enhancedTransactions: false,
            tokenAccounts: false,
            websocket: false
        };

        for (const provider of this.providers.values()) {
            if (provider.capabilities) {
                if (provider.capabilities.enhancedTransactions) caps.enhancedTransactions = true;
                if (provider.capabilities.tokenAccounts) caps.tokenAccounts = true;
                if (provider.capabilities.websocket) caps.websocket = true;
            }
        }

        return caps;
    }
}

// Singleton instance
let instance = null;

/**
 * Get the RPC provider singleton
 */
function getRPCProvider() {
    if (!instance) {
        instance = new RPCProvider();
        instance.initialize();
    }
    return instance;
}

/**
 * Convenience: Get a Solana Connection (for legacy compatibility)
 */
function getConnection() {
    return getRPCProvider().getConnection();
}

module.exports = {
    RPCProvider,
    getRPCProvider,
    getConnection
};
