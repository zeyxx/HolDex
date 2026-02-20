/**
 * Transaction Validator — Pre-signing validation
 * Catches malformed/corrupted transactions before wallet processing
 *
 * Patterns from: ConnectorKit (transaction-validator.ts)
 * Zero runtime cost after initial validation
 */

const logger = require('../services/logger');

// Solana transaction size limits (Metaplex standard)
const MAX_TRANSACTION_SIZE = 1232; // bytes
const MIN_TRANSACTION_SIZE = 32;   // bytes (header only)

/**
 * Detect unusual byte patterns that suggest corruption
 * @param {Uint8Array} buffer
 * @returns {boolean}
 */
function detectSuspiciousPatterns(buffer) {
    const view = new Uint8Array(buffer);

    // All zeros (empty/uninitialized)
    if (view.every(byte => byte === 0x00)) return true;

    // All 0xFF (memory uninitialized, often 0xFF padding)
    if (view.every(byte => byte === 0xFF)) return true;

    // Repetitive pattern (e.g., 0xABCDABCDABCD...)
    if (view.length >= 4) {
        const chunk = view.slice(0, 4);
        let repetitions = 0;
        for (let i = 4; i < view.length; i += 4) {
            const nextChunk = view.slice(i, i + 4);
            if (chunk.every((b, j) => b === nextChunk[j])) repetitions++;
        }
        if (repetitions > view.length / 4 - 2) return true; // >50% repetition
    }

    return false;
}

/**
 * Check for duplicate signers in transaction
 * @param {any} transaction - Solana Transaction object
 * @returns {Set<string>} unique signer public keys
 */
function getUniqueSigners(transaction) {
    const signers = new Set();

    if (transaction.feePayer) {
        signers.add(transaction.feePayer.toBase58());
    }

    if (transaction.instructions && Array.isArray(transaction.instructions)) {
        transaction.instructions.forEach(ix => {
            if (ix.keys) {
                ix.keys.forEach(meta => {
                    if (meta.isSigner) {
                        signers.add(meta.pubkey.toBase58());
                    }
                });
            }
        });
    }

    return signers;
}

/**
 * Main validation function
 * @param {any} transaction - Solana Transaction to validate
 * @param {Object} options - Validation options
 * @returns {TransactionValidationResult}
 */
function validate(transaction, options = {}) {
    const errors = [];
    const warnings = [];
    let serialized;
    let size = 0;

    try {
        // 1. Check if transaction is serializable
        serialized = transaction.serialize({
            verifySignatures: false,
            requireAllSignatures: false,
        });
        size = serialized.length;
    } catch (err) {
        errors.push(`Failed to serialize transaction: ${err.message}`);
        return { valid: false, errors, warnings, size: 0 };
    }

    // 2. Size validation
    if (size === 0) {
        errors.push('Transaction is empty (size 0 bytes)');
    } else if (size < MIN_TRANSACTION_SIZE) {
        errors.push(`Transaction too small: ${size} bytes (min ${MIN_TRANSACTION_SIZE})`);
    } else if (size > MAX_TRANSACTION_SIZE) {
        errors.push(`Transaction too large: ${size} bytes (max ${MAX_TRANSACTION_SIZE})`);
    }

    // 3. Pattern analysis (corruption detection)
    if (detectSuspiciousPatterns(serialized)) {
        warnings.push('Transaction contains unusual byte patterns (may be corrupted)');
    }

    // 4. Duplicate signer check
    try {
        const uniqueSigners = getUniqueSigners(transaction);
        const totalSignatures = transaction.signatures?.length || 0;

        if (uniqueSigners.size > 0 && totalSignatures > uniqueSigners.size) {
            warnings.push(
                `Transaction has ${totalSignatures} signatures but only ` +
                `${uniqueSigners.size} unique signers (may indicate duplicates)`
            );
        }
    } catch (err) {
        warnings.push(`Could not verify signer uniqueness: ${err.message}`);
    }

    // 5. Instruction validation
    if (!transaction.instructions || transaction.instructions.length === 0) {
        warnings.push('Transaction contains no instructions (will be no-op)');
    }

    // 6. Fee payer validation
    if (!transaction.feePayer) {
        warnings.push('Transaction has no fee payer (may fail)');
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        size,
        timestamp: new Date().toISOString(),
    };
}

/**
 * Validate and throw if invalid
 * Use this in critical paths (transaction sending)
 */
function validateOrThrow(transaction, options = {}) {
    const result = validate(transaction, options);

    if (!result.valid) {
        const errorMsg = result.errors.join('; ');
        const error = new Error(`Transaction validation failed: ${errorMsg}`);
        error.validationResult = result;
        throw error;
    }

    // Still log warnings even if valid
    if (result.warnings.length > 0) {
        logger.warn(`[TxValidator] Warnings: ${result.warnings.join('; ')}`);
    }

    return result;
}

/**
 * Silent validation (doesn't throw, returns result)
 * Use for batch validation or analytics
 */
function validateSilent(transaction, options = {}) {
    try {
        return validate(transaction, options);
    } catch (err) {
        logger.error(`[TxValidator] Unexpected error: ${err.message}`);
        return {
            valid: false,
            errors: [err.message],
            warnings: [],
            size: 0,
            timestamp: new Date().toISOString(),
        };
    }
}

module.exports = {
    validate,
    validateOrThrow,
    validateSilent,
    MAX_TRANSACTION_SIZE,
    MIN_TRANSACTION_SIZE,

    // For testing
    _detectSuspiciousPatterns: detectSuspiciousPatterns,
    _getUniqueSigners: getUniqueSigners,
};
