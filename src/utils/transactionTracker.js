/**
 * Transaction Tracker — Lifecycle tracking & event emission
 * Maintains rolling history of recent transactions
 *
 * Patterns from: ConnectorKit (transaction-tracker.ts)
 * Emits events for UI updates + analytics
 */

const logger = require('../services/logger');
const EventEmitter = require('events');

// Fibonacci(7) = 13, but use 20 for more history
const MAX_TRANSACTIONS = 20;

/**
 * Transaction activity record
 * @typedef {Object} TransactionActivity
 * @property {string} signature - Transaction signature (base58)
 * @property {string} status - 'pending' | 'confirmed' | 'failed'
 * @property {string} method - Signing method used
 * @property {number} size - Serialized transaction size (bytes)
 * @property {string} timestamp - ISO timestamp
 * @property {Object} metadata - Optional metadata (computeUnits, priorityFee, etc)
 * @property {string} error - Error message if failed
 */

class TransactionTracker extends EventEmitter {
    constructor() {
        super();
        this.transactions = []; // Most recent first
        this.maxTransactions = MAX_TRANSACTIONS;
    }

    /**
     * Track a new transaction (before signing/sending)
     * @param {Omit<TransactionActivity, 'timestamp'>} activity
     * @returns {TransactionActivity}
     */
    trackTransaction(activity) {
        const fullActivity = {
            signature: activity.signature || null,
            status: activity.status || 'pending',
            method: activity.method || 'unknown',
            size: activity.size || 0,
            metadata: activity.metadata || {},
            timestamp: new Date().toISOString(),
            error: null,
        };

        this.transactions.unshift(fullActivity);

        // Maintain rolling cap
        if (this.transactions.length > this.maxTransactions) {
            const removed = this.transactions.pop();
            logger.debug(`[TxTracker] Purged old tx: ${removed.signature?.slice(0, 8) || 'pending'}`);
        }

        logger.info(`[TxTracker] Tracking: ${fullActivity.signature?.slice(0, 8) || 'pending'} (${fullActivity.method})`);

        // Emit event for subscribers
        this.emit('transaction:tracked', {
            signature: fullActivity.signature,
            status: fullActivity.status,
            method: fullActivity.method,
            timestamp: fullActivity.timestamp,
        });

        return fullActivity;
    }

    /**
     * Update transaction status (pending → confirmed/failed)
     * @param {string} signature
     * @param {string} newStatus - 'confirmed' | 'failed'
     * @param {string} error - Error message if failed
     */
    updateStatus(signature, newStatus, error = null) {
        if (!signature) {
            logger.warn('[TxTracker] updateStatus called with no signature');
            return;
        }

        const tx = this.transactions.find(t => t.signature === signature);
        if (!tx) {
            logger.warn(`[TxTracker] Transaction not found: ${signature.slice(0, 8)}`);
            return;
        }

        const oldStatus = tx.status;
        tx.status = newStatus;
        tx.error = error || null;

        logger.info(`[TxTracker] Status: ${signature.slice(0, 8)} ${oldStatus} → ${newStatus}`);

        // Emit event for subscribers
        this.emit('transaction:updated', {
            signature,
            status: newStatus,
            oldStatus,
            error,
            timestamp: new Date().toISOString(),
        });
    }

    /**
     * Get all transactions
     * @returns {TransactionActivity[]}
     */
    getAll() {
        return [...this.transactions];
    }

    /**
     * Get transactions by status
     * @param {string} status - 'pending' | 'confirmed' | 'failed'
     * @returns {TransactionActivity[]}
     */
    getByStatus(status) {
        return this.transactions.filter(tx => tx.status === status);
    }

    /**
     * Get transaction by signature
     * @param {string} signature
     * @returns {TransactionActivity|null}
     */
    getBySignature(signature) {
        return this.transactions.find(tx => tx.signature === signature) || null;
    }

    /**
     * Get recent N transactions
     * @param {number} n
     * @returns {TransactionActivity[]}
     */
    getRecent(n = 5) {
        return this.transactions.slice(0, n);
    }

    /**
     * Clear all transactions
     */
    clear() {
        logger.info(`[TxTracker] Clearing ${this.transactions.length} transactions`);
        this.transactions = [];
    }

    /**
     * Get summary stats
     * @returns {Object}
     */
    getStats() {
        const pending = this.getByStatus('pending').length;
        const confirmed = this.getByStatus('confirmed').length;
        const failed = this.getByStatus('failed').length;

        return {
            total: this.transactions.length,
            pending,
            confirmed,
            failed,
            successRate: confirmed + failed > 0 ? confirmed / (confirmed + failed) : 0,
            avgSize: this.transactions.length > 0
                ? Math.round(this.transactions.reduce((sum, tx) => sum + tx.size, 0) / this.transactions.length)
                : 0,
        };
    }

    /**
     * Subscribe to transaction events (convenience method)
     * @param {Function} callback - (event, data) => {}
     * @returns {Function} unsubscribe function
     */
    subscribe(callback) {
        const listener = (eventData) => {
            callback('tracked', eventData);
        };
        const updater = (eventData) => {
            callback('updated', eventData);
        };

        this.on('transaction:tracked', listener);
        this.on('transaction:updated', updater);

        // Return unsubscribe function
        return () => {
            this.removeListener('transaction:tracked', listener);
            this.removeListener('transaction:updated', updater);
        };
    }
}

// Singleton instance
let trackerInstance = null;

/**
 * Get global tracker instance (singleton pattern)
 */
function getTracker() {
    if (!trackerInstance) {
        trackerInstance = new TransactionTracker();
        logger.debug('[TxTracker] Global instance initialized');
    }
    return trackerInstance;
}

/**
 * Reset tracker (for testing)
 */
function resetTracker() {
    if (trackerInstance) {
        trackerInstance.clear();
    }
}

module.exports = {
    TransactionTracker,
    getTracker,
    resetTracker,
    MAX_TRANSACTIONS,
};
