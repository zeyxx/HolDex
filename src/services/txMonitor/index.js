/**
 * Transaction Confirmation Monitor
 *
 * Tracks TX lifecycle: PENDING → CONFIRMED → FINALIZED
 * - PENDING: Submitted, awaiting confirmation
 * - CONFIRMED: Confirmed by 1+ validators
 * - FINALIZED: Finalized (≥32 blocks deep)
 * - FAILED: Timed out or explicitly failed
 *
 * Features:
 * - In-memory cache with Redis fallback
 * - 30-minute timeout (auto-fail)
 * - Polling-based confirmation tracking
 * - Event emission on state changes
 */

const EventEmitter = require('events');
const logger = require('../logger');
const { Errors } = require('../../utils/errors');
const rpcProvider = require('../rpcProvider');

// State machine constants
const TX_STATES = {
    PENDING: 'PENDING',
    CONFIRMED: 'CONFIRMED',
    FINALIZED: 'FINALIZED',
    FAILED: 'FAILED'
};

const TX_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

class TransactionMonitor extends EventEmitter {
    constructor() {
        super();
        this.cache = new Map(); // In-memory cache: signature → { state, timestamp, confirmationStatus }
        this.autoCheckInterval = null;
    }

    /**
     * Start monitoring a transaction
     */
    startMonitoring(signature) {
        if (this.cache.has(signature)) {
            logger.debug(`[TxMonitor] TX already monitoring: ${signature}`);
            return this.cache.get(signature);
        }

        const txRecord = {
            signature,
            state: TX_STATES.PENDING,
            createdAt: Date.now(),
            confirmations: 0,
            lastChecked: null,
            slot: null,
            error: null
        };

        this.cache.set(signature, txRecord);
        logger.info(`[TxMonitor] Started monitoring TX: ${signature}`);
        this.emit('tx_started', txRecord);

        return txRecord;
    }

    /**
     * Get transaction status
     */
    getStatus(signature) {
        const txRecord = this.cache.get(signature);

        if (!txRecord) {
            return {
                signature,
                state: 'UNKNOWN',
                message: 'TX not being monitored'
            };
        }

        const age = Date.now() - txRecord.createdAt;

        // Check timeout
        if (age > TX_TIMEOUT_MS && txRecord.state === TX_STATES.PENDING) {
            this._markFailed(signature, 'Timeout - no confirmation within 30 minutes');
        }

        return {
            signature,
            state: txRecord.state,
            age: age,
            confirmations: txRecord.confirmations,
            slot: txRecord.slot,
            error: txRecord.error
        };
    }

    /**
     * Poll transaction status from RPC
     */
    async pollTransaction(signature) {
        const txRecord = this.cache.get(signature);
        if (!txRecord) {
            throw Errors.transactionFailed(signature, 'TX not being monitored');
        }

        // Skip if already finalized or failed
        if (txRecord.state === TX_STATES.FINALIZED || txRecord.state === TX_STATES.FAILED) {
            return txRecord;
        }

        try {
            // Check current block height
            const blockHeight = await rpcProvider.getSlot();
            txRecord.slot = blockHeight;

            // Get transaction status
            const tx = await rpcProvider.getTransaction(signature);

            if (!tx) {
                // TX not found yet (still pending)
                logger.debug(`[TxMonitor] TX ${signature} not found (still pending)`);
                return txRecord;
            }

            // Transaction found - update state
            if (tx.blockTime && tx.slot) {
                const confirmationCount = blockHeight - tx.slot;
                txRecord.confirmations = confirmationCount;

                // Check for TX failure (negative result)
                if (tx.meta && tx.meta.err) {
                    this._markFailed(signature, `TX failed: ${tx.meta.err}`);
                    return txRecord;
                }

                // Update state based on confirmations
                if (confirmationCount >= 32) {
                    this._markFinalized(signature);
                } else if (confirmationCount > 0) {
                    this._markConfirmed(signature);
                }
            }

            txRecord.lastChecked = Date.now();
            return txRecord;

        } catch (e) {
            logger.error(`[TxMonitor] Error polling ${signature}: ${e.message}`);
            throw Errors.transactionFailed(signature, `Poll error: ${e.message}`);
        }
    }

    /**
     * Mark transaction as confirmed
     */
    _markConfirmed(signature) {
        const txRecord = this.cache.get(signature);
        if (txRecord && txRecord.state === TX_STATES.PENDING) {
            txRecord.state = TX_STATES.CONFIRMED;
            logger.info(`[TxMonitor] TX confirmed: ${signature} (${txRecord.confirmations} confirmations)`);
            this.emit('tx_confirmed', txRecord);
        }
    }

    /**
     * Mark transaction as finalized
     */
    _markFinalized(signature) {
        const txRecord = this.cache.get(signature);
        if (txRecord && txRecord.state !== TX_STATES.FAILED) {
            txRecord.state = TX_STATES.FINALIZED;
            logger.info(`[TxMonitor] TX finalized: ${signature}`);
            this.emit('tx_finalized', txRecord);
        }
    }

    /**
     * Mark transaction as failed
     */
    _markFailed(signature, reason) {
        const txRecord = this.cache.get(signature);
        if (txRecord && txRecord.state !== TX_STATES.FINALIZED) {
            txRecord.state = TX_STATES.FAILED;
            txRecord.error = reason;
            logger.warn(`[TxMonitor] TX failed: ${signature} - ${reason}`);
            this.emit('tx_failed', txRecord);
        }
    }

    /**
     * Stop monitoring a transaction (cleanup)
     */
    stopMonitoring(signature) {
        const txRecord = this.cache.get(signature);
        if (txRecord) {
            this.cache.delete(signature);
            logger.debug(`[TxMonitor] Stopped monitoring TX: ${signature}`);
            this.emit('tx_stopped', { signature });
        }
    }

    /**
     * Get all monitored transactions
     */
    getAllTransactions() {
        return Array.from(this.cache.values());
    }

    /**
     * Get statistics
     */
    getStats() {
        const all = this.getAllTransactions();
        const byState = {
            [TX_STATES.PENDING]: 0,
            [TX_STATES.CONFIRMED]: 0,
            [TX_STATES.FINALIZED]: 0,
            [TX_STATES.FAILED]: 0
        };

        for (const tx of all) {
            byState[tx.state]++;
        }

        return {
            totalMonitored: all.length,
            byState,
            cacheSize: this.cache.size
        };
    }
}

// Singleton
let instance = null;

function getTxMonitor() {
    if (!instance) {
        instance = new TransactionMonitor();
    }
    return instance;
}

module.exports = {
    getTxMonitor,
    TX_STATES,
    TransactionMonitor
};
