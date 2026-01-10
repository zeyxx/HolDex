/**
 * Helius Provider Adapter
 *
 * Supports both Standard RPC and Enhanced APIs (DAS, Enhanced Transactions)
 * This is the primary provider with full feature support.
 *
 * HARDCAP Integration:
 *   - All RPC calls go through consumeCredits() for per-node limits
 *   - API nodes: never blocked, just tracked
 *   - Calculator/Listener/Worker: throttled when limit reached
 */

const { Connection, PublicKey } = require('@solana/web3.js');
const { trackRpcCall } = require('../rpcMonitor');
const { consumeCredits, getCreditCost } = require('../rpcHardcap');

class HeliusProvider {
    constructor(apiKey) {
        if (!apiKey) {
            throw new Error('HeliusProvider requires API key');
        }

        this.id = 'helius';
        this.apiKey = apiKey;
        this.rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
        this.rpcUrlBase = 'https://mainnet.helius-rpc.com';
        this.enhancedUrl = 'https://api-mainnet.helius-rpc.com';
        this.connection = null;

        // Capabilities
        this.capabilities = {
            standardRpc: true,
            enhancedTransactions: true,
            tokenAccounts: true,  // DAS API
            websocket: true
        };
    }

    /**
     * Get or create Solana Connection
     */
    getConnection() {
        if (!this.connection) {
            this.connection = new Connection(this.rpcUrl, {
                commitment: 'confirmed',
                confirmTransactionInitialTimeout: 60000
            });
        }
        return this.connection;
    }

    /**
     * Track RPC call with HARDCAP enforcement
     *
     * Consumes credits and enforces per-node limits.
     * Also calls legacy trackRpcCall for backward compatibility.
     *
     * @param {string} method - RPC method name
     * @param {number} credits - Credit cost
     * @returns {Promise<Object>} Consumption result
     */
    async _trackWithHardcap(method, credits) {
        // Track in both systems for now (hardcap + legacy monitor)
        trackRpcCall(method, credits);
        return consumeCredits(method, credits);
    }

    // ============================================
    // STANDARD RPC METHODS
    // ============================================

    async getAccountInfo(pubkey) {
        const conn = this.getConnection();
        const pk = typeof pubkey === 'string' ? new PublicKey(pubkey) : pubkey;
        const result = await conn.getAccountInfo(pk);
        await this._trackWithHardcap('getAccountInfo', 1);
        return result;
    }

    async getMultipleAccountsInfo(pubkeys) {
        const conn = this.getConnection();
        const pks = pubkeys.map(p => typeof p === 'string' ? new PublicKey(p) : p);
        const result = await conn.getMultipleAccountsInfo(pks);
        await this._trackWithHardcap('getMultipleAccounts', pks.length); // 1 credit per account
        return result;
    }

    async getTokenLargestAccounts(mint) {
        const conn = this.getConnection();
        const pk = typeof mint === 'string' ? new PublicKey(mint) : mint;
        const result = await conn.getTokenLargestAccounts(pk);
        await this._trackWithHardcap('getTokenLargestAccounts', 1);
        return result;
    }

    async getSignaturesForAddress(address, options = {}) {
        const conn = this.getConnection();
        const pk = typeof address === 'string' ? new PublicKey(address) : address;
        const result = await conn.getSignaturesForAddress(pk, options);
        await this._trackWithHardcap('getSignaturesForAddress', 1);
        return result;
    }

    /**
     * getTransactionsForAddress - Helius Enhanced Transaction API
     *
     * OPTIMIZATION: Replaces getSignaturesForAddress + getTransaction pattern
     * - Single call returns fully parsed transactions
     * - Server-side sorting/filtering/pagination
     * - Returns type, source, transfers, timestamps in one request
     *
     * Uses REST Enhanced API (more reliable than RPC method)
     *
     * @param {string} address - Wallet or account address
     * @param {Object} options
     * @param {number} options.limit - Max transactions (default 100)
     * @param {string} options.before - Signature to paginate before
     * @param {string} options.type - Filter by type (e.g., "SWAP", "TRANSFER")
     * @param {string} options.source - Filter by source (e.g., "RAYDIUM", "JUPITER")
     * @returns {Promise<Array>} Parsed transactions with timestamps, transfers, etc.
     */
    async getTransactionsForAddress(address, options = {}) {
        // Delegate to getEnhancedTransactions (REST API - more reliable)
        return this.getEnhancedTransactions(address, options);
    }

    async getProgramAccounts(programId, config) {
        const conn = this.getConnection();
        const pk = typeof programId === 'string' ? new PublicKey(programId) : programId;
        const result = await conn.getProgramAccounts(pk, config);
        await this._trackWithHardcap('getProgramAccounts', 1);
        return result;
    }

    // ============================================
    // HELIUS ENHANCED APIs (Helius-only)
    // ============================================

    /**
     * Get enhanced transaction history for an address
     * Helius-specific API - no fallback available
     */
    async getEnhancedTransactions(address, options = {}) {
        const params = new URLSearchParams({ 'api-key': this.apiKey });

        if (options.limit) params.append('limit', options.limit.toString());
        if (options.before) params.append('before-signature', options.before);
        if (options.after) params.append('after-signature', options.after);
        if (options.sortOrder) params.append('sort-order', options.sortOrder);
        if (options.type) params.append('type', options.type);

        // Time-based filtering
        if (options.gtTime) params.append('gt-time', options.gtTime.toString());
        if (options.gteTime) params.append('gte-time', options.gteTime.toString());
        if (options.ltTime) params.append('lt-time', options.ltTime.toString());
        if (options.lteTime) params.append('lte-time', options.lteTime.toString());

        const url = `${this.enhancedUrl}/v0/addresses/${address}/transactions?${params}`;

        const response = await fetch(url, { method: 'GET' });
        if (!response.ok) {
            throw new Error(`Helius Enhanced API error: ${response.status}`);
        }
        const result = await response.json();
        await this._trackWithHardcap('getEnhancedTransactions', 100);
        return result;
    }

    /**
     * Get token accounts using Helius DAS API
     * Helius-specific API - no fallback available
     */
    async getTokenAccounts(mint, options = {}) {
        const params = { mint, limit: options.limit || 1000 };
        if (options.cursor) params.cursor = options.cursor;

        const response = await fetch(this.rpcUrlBase, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: Date.now(),
                method: 'getTokenAccounts',
                params
            })
        });

        const data = await response.json();
        if (data.error) {
            throw new Error(data.error.message);
        }
        await this._trackWithHardcap('getTokenAccounts', 10);
        return data.result;
    }

    /**
     * Generic RPC call
     */
    async rpcCall(method, params) {
        const response = await fetch(this.rpcUrlBase, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
        });

        const data = await response.json();
        if (data.error) {
            throw new Error(data.error.message);
        }
        await this._trackWithHardcap(method, getCreditCost(method));
        return data.result;
    }

    /**
     * Health check
     */
    async healthCheck() {
        try {
            const start = Date.now();
            const conn = this.getConnection();
            await conn.getSlot();
            await this._trackWithHardcap('getSlot', 1);
            return { healthy: true, latency: Date.now() - start };
        } catch (e) {
            return { healthy: false, error: e.message };
        }
    }
}

module.exports = HeliusProvider;
