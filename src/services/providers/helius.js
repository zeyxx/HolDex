/**
 * Helius Provider Adapter
 *
 * Supports both Standard RPC and Enhanced APIs (DAS, Enhanced Transactions)
 * This is the primary provider with full feature support.
 */

const { Connection, PublicKey } = require('@solana/web3.js');
const logger = require('../logger');

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

    // ============================================
    // STANDARD RPC METHODS
    // ============================================

    async getAccountInfo(pubkey) {
        const conn = this.getConnection();
        const pk = typeof pubkey === 'string' ? new PublicKey(pubkey) : pubkey;
        return conn.getAccountInfo(pk);
    }

    async getMultipleAccountsInfo(pubkeys) {
        const conn = this.getConnection();
        const pks = pubkeys.map(p => typeof p === 'string' ? new PublicKey(p) : p);
        return conn.getMultipleAccountsInfo(pks);
    }

    async getTokenLargestAccounts(mint) {
        const conn = this.getConnection();
        const pk = typeof mint === 'string' ? new PublicKey(mint) : mint;
        return conn.getTokenLargestAccounts(pk);
    }

    async getSignaturesForAddress(address, options = {}) {
        const conn = this.getConnection();
        const pk = typeof address === 'string' ? new PublicKey(address) : address;
        return conn.getSignaturesForAddress(pk, options);
    }

    /**
     * getTransactionsForAddress - Helius Enhanced RPC Method
     *
     * OPTIMIZATION: Replaces getSignaturesForAddress + getTransaction pattern
     * - 2-10x lower latency (single call vs N+1 calls)
     * - Server-side sorting/filtering/pagination
     * - Returns fully parsed transactions
     *
     * @param {string} address - Wallet or account address
     * @param {Object} options
     * @param {number} options.limit - Max transactions (default 100, max 1000)
     * @param {string} options.before - Signature to paginate before
     * @param {string} options.until - Signature to paginate until
     * @param {string} options.type - Filter by type (e.g., "SWAP", "TRANSFER")
     * @param {string} options.source - Filter by source (e.g., "RAYDIUM", "JUPITER")
     * @param {string} options.commitment - Commitment level
     * @returns {Promise<Array>} Parsed transactions with timestamps, transfers, etc.
     */
    async getTransactionsForAddress(address, options = {}) {
        const params = {
            address: typeof address === 'string' ? address : address.toString(),
            limit: options.limit || 100
        };

        // Optional filters
        if (options.before) params.before = options.before;
        if (options.until) params.until = options.until;
        if (options.type) params.type = options.type;
        if (options.source) params.source = options.source;
        if (options.commitment) params.commitment = options.commitment;

        const response = await fetch(this.rpcUrlBase, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: Date.now(),
                method: 'getTransactionsForAddress',
                params
            })
        });

        const data = await response.json();
        if (data.error) {
            throw new Error(data.error.message || 'getTransactionsForAddress failed');
        }
        return data.result || [];
    }

    async getProgramAccounts(programId, config) {
        const conn = this.getConnection();
        const pk = typeof programId === 'string' ? new PublicKey(programId) : programId;
        return conn.getProgramAccounts(pk, config);
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
        return response.json();
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
            return { healthy: true, latency: Date.now() - start };
        } catch (e) {
            return { healthy: false, error: e.message };
        }
    }
}

module.exports = HeliusProvider;
