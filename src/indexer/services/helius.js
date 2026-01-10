/**
 * Indexer Helius Connection
 *
 * Uses the shared TrackedConnection from solana.js for automatic credit tracking.
 * All RPC calls through this connection are tracked via the HARDCAP system.
 *
 * SECURITY NOTE: API keys are handled securely in the parent module.
 */
const { getSolanaConnection } = require('../../services/solana');
const logger = require('../../services/logger');

let initialized = false;

/**
 * Get Solana RPC connection for indexer
 * Uses TrackedConnection for automatic credit tracking via HARDCAP
 */
function getConnection() {
    if (!initialized) {
        logger.info(`🔌 Indexer using TrackedConnection (HARDCAP enabled)`);
        initialized = true;
    }
    return getSolanaConnection();
}

module.exports = { getConnection };
