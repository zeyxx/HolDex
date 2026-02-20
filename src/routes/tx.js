/**
 * Transaction Status Routes
 *
 * GET /tx/:signature - Get TX status (PENDING/CONFIRMED/FINALIZED/FAILED)
 */

const express = require('express');
const { getTxMonitor } = require('../services/txMonitor');
const logger = require('../services/logger');

const router = express.Router();
const txMonitor = getTxMonitor();

/**
 * GET /tx/:signature
 * Get current transaction status
 */
router.get('/:signature', async (req, res, next) => {
    try {
        const { signature } = req.params;

        // Validate signature format (58-88 chars, base58)
        if (!signature || signature.length < 58 || signature.length > 88) {
            return res.status(400).json({
                ok: false,
                error: {
                    code: 'INVALID_SIGNATURE_FORMAT',
                    message: 'TX signature must be 58-88 characters (base58)'
                }
            });
        }

        const status = txMonitor.getStatus(signature);

        res.json({
            ok: true,
            data: status
        });

    } catch (err) {
        next(err);
    }
});

/**
 * POST /tx/:signature/poll
 * Manually poll for TX confirmation (usually auto-polled)
 */
router.post('/:signature/poll', async (req, res, next) => {
    try {
        const { signature } = req.params;

        // Ensure TX is being monitored
        if (!txMonitor.getStatus(signature) || txMonitor.getStatus(signature).state === 'UNKNOWN') {
            // Start monitoring if not already
            txMonitor.startMonitoring(signature);
        }

        // Poll RPC for current status
        const updated = await txMonitor.pollTransaction(signature);

        res.json({
            ok: true,
            data: {
                signature,
                state: updated.state,
                confirmations: updated.confirmations,
                age: Date.now() - updated.createdAt,
                slot: updated.slot
            }
        });

    } catch (err) {
        next(err);
    }
});

/**
 * POST /tx/:signature/start
 * Start monitoring a transaction
 */
router.post('/:signature/start', async (req, res, next) => {
    try {
        const { signature } = req.params;

        const txRecord = txMonitor.startMonitoring(signature);

        res.status(201).json({
            ok: true,
            data: {
                signature,
                state: txRecord.state,
                message: 'TX monitoring started'
            }
        });

    } catch (err) {
        next(err);
    }
});

/**
 * GET /tx
 * Get all monitored transactions and stats
 */
router.get('/', async (req, res, next) => {
    try {
        const stats = txMonitor.getStats();
        const allTx = txMonitor.getAllTransactions();

        res.json({
            ok: true,
            data: {
                stats,
                transactions: allTx
            }
        });

    } catch (err) {
        next(err);
    }
});

module.exports = router;
