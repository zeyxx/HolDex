/**
 * Public RPC Provider Adapter
 *
 * Free fallback using public Solana RPC endpoints.
 * Limited to standard RPC methods only - no enhanced APIs.
 *
 * Endpoints rotate on failure for resilience.
 */

const { Connection, PublicKey } = require('@solana/web3.js');
const logger = require('../logger');

// Public RPC endpoints (free, rate-limited)
const PUBLIC_ENDPOINTS = [
    'https://api.mainnet-beta.solana.com',
    'https://solana-api.projectserum.com',
    'https://rpc.ankr.com/solana'
];

class PublicProvider {
    constructor() {
        this.id = 'public';
        this.endpoints = [...PUBLIC_ENDPOINTS];
        this.currentIndex = 0;
        this.connections = new Map();

        // Capabilities - standard RPC only
        this.capabilities = {
            standardRpc: true,
            enhancedTransactions: false,
            tokenAccounts: false,
            websocket: false
        };
    }

    /**
     * Get current endpoint URL
     */
    getCurrentEndpoint() {
        return this.endpoints[this.currentIndex];
    }

    /**
     * Rotate to next endpoint
     */
    rotateEndpoint() {
        this.currentIndex = (this.currentIndex + 1) % this.endpoints.length;
        logger.debug(`[PublicRPC] Rotated to endpoint: ${this.getCurrentEndpoint()}`);
    }

    /**
     * Get or create Solana Connection for current endpoint
     */
    getConnection() {
        const url = this.getCurrentEndpoint();

        if (!this.connections.has(url)) {
            this.connections.set(url, new Connection(url, {
                commitment: 'confirmed',
                confirmTransactionInitialTimeout: 60000,
                disableRetryOnRateLimit: true // We handle rotation ourselves
            }));
        }

        return this.connections.get(url);
    }

    /**
     * Execute with endpoint rotation on failure
     */
    async executeWithRotation(fn, maxRetries = 3) {
        let lastError;
        const startIndex = this.currentIndex;

        for (let i = 0; i < maxRetries; i++) {
            try {
                return await fn(this.getConnection());
            } catch (e) {
                lastError = e;

                // Rotate on rate limit or connection error
                if (e.message?.includes('429') ||
                    e.message?.includes('Too Many Requests') ||
                    e.message?.includes('ECONNREFUSED') ||
                    e.message?.includes('timeout')) {

                    this.rotateEndpoint();

                    // If we've tried all endpoints, throw
                    if (this.currentIndex === startIndex && i > 0) {
                        break;
                    }

                    // Small delay before retry
                    await new Promise(r => setTimeout(r, 100 * (i + 1)));
                } else {
                    // Non-retryable error
                    throw e;
                }
            }
        }

        throw lastError;
    }

    // ============================================
    // STANDARD RPC METHODS
    // ============================================

    async getAccountInfo(pubkey) {
        const pk = typeof pubkey === 'string' ? new PublicKey(pubkey) : pubkey;
        return this.executeWithRotation(conn => conn.getAccountInfo(pk));
    }

    async getMultipleAccountsInfo(pubkeys) {
        const pks = pubkeys.map(p => typeof p === 'string' ? new PublicKey(p) : p);
        return this.executeWithRotation(conn => conn.getMultipleAccountsInfo(pks));
    }

    async getTokenLargestAccounts(mint) {
        const pk = typeof mint === 'string' ? new PublicKey(mint) : mint;
        return this.executeWithRotation(conn => conn.getTokenLargestAccounts(pk));
    }

    async getSignaturesForAddress(address, options = {}) {
        const pk = typeof address === 'string' ? new PublicKey(address) : address;
        return this.executeWithRotation(conn => conn.getSignaturesForAddress(pk, options));
    }

    async getProgramAccounts(programId, config) {
        const pk = typeof programId === 'string' ? new PublicKey(programId) : programId;
        return this.executeWithRotation(conn => conn.getProgramAccounts(pk, config));
    }

    // ============================================
    // UNSUPPORTED METHODS (Helius-only)
    // ============================================

    async getEnhancedTransactions(_address, _options) {
        throw new Error('Enhanced Transactions API not available on public RPC');
    }

    async getTokenAccounts(_mint, _options) {
        throw new Error('DAS Token Accounts API not available on public RPC');
    }

    /**
     * Health check
     */
    async healthCheck() {
        try {
            const start = Date.now();
            const conn = this.getConnection();
            await conn.getSlot();
            return {
                healthy: true,
                latency: Date.now() - start,
                endpoint: this.getCurrentEndpoint()
            };
        } catch (_e) {
            // Try rotating and checking again
            this.rotateEndpoint();
            try {
                const start = Date.now();
                const conn = this.getConnection();
                await conn.getSlot();
                return {
                    healthy: true,
                    latency: Date.now() - start,
                    endpoint: this.getCurrentEndpoint(),
                    rotated: true
                };
            } catch (e2) {
                return { healthy: false, error: e2.message };
            }
        }
    }
}

module.exports = PublicProvider;
