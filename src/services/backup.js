/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOLDEX BACKUP/RESTORE SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 * Comprehensive database backup and restore with transaction safety.
 *
 * Philosophy: "Don't trust, verify" - All restores are atomic.
 *
 * Tables covered:
 * - Core: tokens, token_updates, api_keys, holder_snapshots
 * - History: k_score_history, holder_history, supply_history, holders_history
 * - Harmony: participants, contributions, wallet_credits
 * - Infrastructure: pools, nodes, token_verifications, access_grants
 * - Signals: token_signals, judgment_history, judgment_thresholds
 *
 * Excluded (ephemeral/rebuildable):
 * - candles_1m (large, can be rebuilt from RPC)
 * - wallet_tx_cache (cache, rebuilt on demand)
 * - wallet_sessions (ephemeral session tokens)
 * - space_actions (audit log, not critical for restore)
 * - webhooks (registration state, may be stale)
 * - active_trackers (runtime state)
 * - reward_distributions (can be reconstructed)
 * - operation_costs (config, should be seeded separately)
 * ═══════════════════════════════════════════════════════════════════════════
 */

const logger = require('./logger');

// Backup schema version for compatibility checking
const BACKUP_VERSION = '2.0.0';

/**
 * Table definitions with export/import configurations
 */
const TABLE_CONFIGS = {
    // ═══════════════════════════════════════════════════════════════════════
    // CORE TABLES - Essential for operation
    // ═══════════════════════════════════════════════════════════════════════
    tokens: {
        priority: 1, // Restore first
        exportQuery: 'SELECT * FROM tokens ORDER BY updated_at DESC',
        primaryKey: 'mint',
        excludeFromExport: [], // Export everything
        sensitive: false,
    },

    token_updates: {
        priority: 2,
        exportQuery: 'SELECT * FROM token_updates ORDER BY submittedAt DESC',
        primaryKey: 'id',
        upsertKey: 'signature', // Use signature for deduplication
        sensitive: false,
    },

    api_keys: {
        priority: 3,
        exportQuery: `
            SELECT key_prefix, owner, wallet, tier, requests_limit, requests_today,
                   last_reset, is_active, created_at
            FROM api_keys
        `,
        primaryKey: 'key_hash',
        sensitive: true, // key_hash excluded for security
        warning: 'API key hashes excluded for security. Keys must be regenerated after restore.',
    },

    holder_snapshots: {
        priority: 4,
        exportQuery: 'SELECT * FROM holder_snapshots ORDER BY updated_at DESC',
        primaryKey: ['mint', 'holder'], // Composite key
        sensitive: false,
    },

    // ═══════════════════════════════════════════════════════════════════════
    // HISTORY TABLES - Time-series data for analysis
    // ═══════════════════════════════════════════════════════════════════════
    k_score_history: {
        priority: 5,
        exportQuery: 'SELECT * FROM k_score_history ORDER BY date DESC',
        primaryKey: ['mint', 'date'],
        sensitive: false,
    },

    holder_history: {
        priority: 6,
        exportQuery: 'SELECT * FROM holder_history ORDER BY date DESC',
        primaryKey: ['mint', 'date'],
        sensitive: false,
    },

    supply_history: {
        priority: 7,
        exportQuery: 'SELECT * FROM supply_history ORDER BY timestamp DESC',
        primaryKey: ['mint', 'timestamp'],
        sensitive: false,
    },

    holders_history: {
        priority: 8,
        exportQuery: 'SELECT * FROM holders_history ORDER BY timestamp DESC',
        primaryKey: ['mint', 'timestamp'],
        sensitive: false,
    },

    // ═══════════════════════════════════════════════════════════════════════
    // HARMONY SYSTEM - E-Score and contributions
    // ═══════════════════════════════════════════════════════════════════════
    participants: {
        priority: 9,
        exportQuery: 'SELECT * FROM participants ORDER BY last_activity_at DESC',
        primaryKey: 'wallet',
        sensitive: false,
    },

    contributions: {
        priority: 10,
        exportQuery: 'SELECT * FROM contributions ORDER BY created_at DESC',
        primaryKey: 'id',
        upsertKey: 'tx_signature', // Prevent duplicate contributions
        sensitive: false,
    },

    wallet_credits: {
        priority: 11,
        exportQuery: 'SELECT * FROM wallet_credits ORDER BY last_call DESC NULLS LAST',
        primaryKey: 'wallet',
        sensitive: false,
    },

    // ═══════════════════════════════════════════════════════════════════════
    // INFRASTRUCTURE - Nodes and verification
    // ═══════════════════════════════════════════════════════════════════════
    pools: {
        priority: 12,
        exportQuery: 'SELECT * FROM pools ORDER BY created_at DESC NULLS LAST',
        primaryKey: 'address',
        sensitive: false,
    },

    nodes: {
        priority: 13,
        exportQuery: 'SELECT * FROM nodes ORDER BY joined_at DESC',
        primaryKey: 'node_id',
        sensitive: false,
    },

    token_verifications: {
        priority: 14,
        exportQuery: 'SELECT * FROM token_verifications ORDER BY verified_at DESC',
        primaryKey: 'id',
        upsertKey: ['mint', 'node_id'], // Composite unique
        sensitive: false,
    },

    access_grants: {
        priority: 15,
        exportQuery: 'SELECT * FROM access_grants ORDER BY created_at DESC',
        primaryKey: 'wallet',
        sensitive: false,
    },

    // ═══════════════════════════════════════════════════════════════════════
    // SIGNAL SYSTEM - Pre-judgment infrastructure
    // ═══════════════════════════════════════════════════════════════════════
    token_signals: {
        priority: 16,
        exportQuery: 'SELECT * FROM token_signals ORDER BY last_seen DESC',
        primaryKey: 'mint',
        sensitive: false,
    },

    judgment_history: {
        priority: 17,
        exportQuery: 'SELECT * FROM judgment_history ORDER BY created_at DESC',
        primaryKey: 'id',
        sensitive: false,
    },

    judgment_thresholds: {
        priority: 18,
        exportQuery: 'SELECT * FROM judgment_thresholds',
        primaryKey: 'dimension',
        sensitive: false,
    },
};

/**
 * Create a full database backup
 * @param {Object} db - Database wrapper
 * @param {Object} options - Backup options
 * @returns {Object} Backup data with metadata
 */
async function createBackup(db, options = {}) {
    const {
        tables = Object.keys(TABLE_CONFIGS), // All tables by default
        includeMetadata = true,
    } = options;

    const backup = {
        version: BACKUP_VERSION,
        timestamp: Date.now(),
        created_at: new Date().toISOString(),
        tables: {},
        metadata: {},
        warnings: [],
    };

    logger.info(`💾 Starting backup of ${tables.length} tables...`);

    for (const tableName of tables) {
        const config = TABLE_CONFIGS[tableName];
        if (!config) {
            logger.warn(`⚠️ Unknown table: ${tableName}, skipping`);
            continue;
        }

        try {
            const rows = await db.all(config.exportQuery);
            backup.tables[tableName] = rows || [];

            if (config.warning) {
                backup.warnings.push(`${tableName}: ${config.warning}`);
            }

            logger.info(`  ✅ ${tableName}: ${rows?.length || 0} rows`);
        } catch (err) {
            // Table might not exist in older schemas
            logger.warn(`  ⚠️ ${tableName}: ${err.message}`);
            backup.tables[tableName] = [];
        }
    }

    if (includeMetadata) {
        // Add useful metadata for restore validation
        backup.metadata = {
            token_count: backup.tables.tokens?.length || 0,
            participant_count: backup.tables.participants?.length || 0,
            total_rows: Object.values(backup.tables).reduce((sum, t) => sum + (t?.length || 0), 0),
        };
    }

    logger.info(`💾 Backup complete: ${backup.metadata.total_rows} total rows`);

    return backup;
}

/**
 * Restore database from backup with transaction safety
 * @param {Object} db - Database wrapper
 * @param {Object} backup - Backup data
 * @param {Object} options - Restore options
 * @returns {Object} Restore results
 */
async function restoreBackup(db, backup, options = {}) {
    const {
        merge = true,           // Merge with existing data (vs replace)
        dryRun = false,         // Preview without committing
        skipTables = [],        // Tables to skip
        onProgress = null,      // Progress callback
    } = options;

    // Validate backup format
    if (!backup.version || !backup.tables) {
        throw new Error('Invalid backup format: missing version or tables');
    }

    // Version compatibility check
    const [majorBackup] = backup.version.split('.');
    const [majorCurrent] = BACKUP_VERSION.split('.');
    if (parseInt(majorBackup) > parseInt(majorCurrent)) {
        throw new Error(`Backup version ${backup.version} is newer than supported ${BACKUP_VERSION}`);
    }

    const results = {
        success: true,
        tables: {},
        errors: [],
        summary: { restored: 0, merged: 0, skipped: 0, failed: 0 },
    };

    logger.info(`💾 Starting restore from backup v${backup.version}...`);
    logger.info(`   Mode: ${merge ? 'MERGE' : 'REPLACE'}, Dry run: ${dryRun}`);

    // Sort tables by priority for restore order
    const sortedTables = Object.keys(backup.tables)
        .filter(t => !skipTables.includes(t))
        .sort((a, b) => {
            const pa = TABLE_CONFIGS[a]?.priority || 99;
            const pb = TABLE_CONFIGS[b]?.priority || 99;
            return pa - pb;
        });

    // Get database client for transaction
    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        for (const tableName of sortedTables) {
            const config = TABLE_CONFIGS[tableName];
            const rows = backup.tables[tableName];

            if (!rows || rows.length === 0) {
                results.tables[tableName] = { restored: 0, merged: 0, skipped: 0 };
                continue;
            }

            if (!config) {
                logger.warn(`⚠️ Unknown table ${tableName}, skipping`);
                results.tables[tableName] = { skipped: rows.length, error: 'Unknown table' };
                continue;
            }

            // Skip sensitive tables that need special handling
            if (config.sensitive && tableName === 'api_keys') {
                results.tables[tableName] = {
                    skipped: rows.length,
                    note: 'API keys are metadata-only, cannot restore key hashes'
                };
                logger.info(`  ⚠️ ${tableName}: Skipped (sensitive data)`);
                continue;
            }

            try {
                const tableResult = await restoreTable(client, tableName, rows, config, merge);
                results.tables[tableName] = tableResult;
                results.summary.restored += tableResult.restored || 0;
                results.summary.merged += tableResult.merged || 0;
                results.summary.skipped += tableResult.skipped || 0;

                logger.info(`  ✅ ${tableName}: +${tableResult.restored} new, ~${tableResult.merged} merged, =${tableResult.skipped} skipped`);

                if (onProgress) {
                    onProgress({ table: tableName, ...tableResult });
                }
            } catch (err) {
                results.tables[tableName] = { error: err.message };
                results.errors.push({ table: tableName, error: err.message });
                results.summary.failed++;
                logger.error(`  ❌ ${tableName}: ${err.message}`);
            }
        }

        if (dryRun) {
            await client.query('ROLLBACK');
            logger.info('💾 Dry run complete - changes rolled back');
        } else if (results.errors.length > 0 && !options.continueOnError) {
            await client.query('ROLLBACK');
            results.success = false;
            logger.error('💾 Restore failed - changes rolled back');
        } else {
            await client.query('COMMIT');
            logger.info('💾 Restore complete - changes committed');
        }

    } catch (err) {
        await client.query('ROLLBACK');
        results.success = false;
        results.errors.push({ error: err.message });
        logger.error(`💾 Restore failed: ${err.message}`);
        throw err;
    } finally {
        client.release();
    }

    return results;
}

/**
 * Restore a single table
 * @private
 */
async function restoreTable(client, tableName, rows, config, merge) {
    const result = { restored: 0, merged: 0, skipped: 0 };

    // Get table columns from first row
    if (rows.length === 0) return result;

    const sampleRow = rows[0];
    const columns = Object.keys(sampleRow).filter(col => {
        // Skip excluded columns and auto-generated IDs
        if (config.excludeFromExport?.includes(col)) return false;
        if (col === 'id' && config.primaryKey !== 'id') return false;
        return true;
    });

    // Determine the key for upsert/merge operations
    const upsertKey = config.upsertKey || config.primaryKey;
    const keyColumns = Array.isArray(upsertKey) ? upsertKey : [upsertKey];

    for (const row of rows) {
        try {
            // Check if record exists
            const whereClause = keyColumns
                .map((col, i) => `${col} = $${i + 1}`)
                .join(' AND ');
            const keyValues = keyColumns.map(col => row[col]);

            // Skip if key values are missing
            if (keyValues.some(v => v === undefined || v === null)) {
                result.skipped++;
                continue;
            }

            const existing = await client.query(
                `SELECT 1 FROM ${tableName} WHERE ${whereClause} LIMIT 1`,
                keyValues
            );

            if (existing.rows.length > 0) {
                if (merge) {
                    // Update existing record (merge non-null values)
                    const updateCols = columns.filter(col => {
                        // Don't update primary key columns
                        if (keyColumns.includes(col)) return false;
                        // Only update if new value is not null/undefined
                        return row[col] !== null && row[col] !== undefined;
                    });

                    if (updateCols.length > 0) {
                        const setClause = updateCols
                            .map((col, i) => `${col} = $${i + 1}`)
                            .join(', ');
                        const values = updateCols.map(col => formatValue(row[col]));
                        const whereParams = keyColumns.map((col, i) => `${col} = $${updateCols.length + i + 1}`).join(' AND ');
                        values.push(...keyValues);

                        await client.query(
                            `UPDATE ${tableName} SET ${setClause} WHERE ${whereParams}`,
                            values
                        );
                        result.merged++;
                    } else {
                        result.skipped++;
                    }
                } else {
                    result.skipped++;
                }
            } else {
                // Insert new record
                const insertCols = columns.filter(col => row[col] !== undefined);
                const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
                const values = insertCols.map(col => formatValue(row[col]));

                await client.query(
                    `INSERT INTO ${tableName} (${insertCols.join(', ')}) VALUES (${placeholders})`,
                    values
                );
                result.restored++;
            }
        } catch (err) {
            // Log but continue with other rows
            logger.warn(`  Row error in ${tableName}: ${err.message}`);
            result.skipped++;
        }
    }

    return result;
}

/**
 * Format value for PostgreSQL insertion
 * Handles JSON objects, arrays, dates, etc.
 * @private
 */
function formatValue(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'object' && !(value instanceof Date)) {
        return JSON.stringify(value);
    }
    return value;
}

/**
 * Get backup size estimate (without actually fetching data)
 * @param {Object} db - Database wrapper
 * @returns {Object} Size estimates per table
 */
async function getBackupSizeEstimate(db) {
    const estimates = {};

    for (const [tableName] of Object.entries(TABLE_CONFIGS)) {
        try {
            const result = await db.get(`SELECT COUNT(*) as count FROM ${tableName}`);
            estimates[tableName] = result?.count || 0;
        } catch {
            estimates[tableName] = 0;
        }
    }

    estimates.total = Object.values(estimates).reduce((sum, count) => sum + count, 0);
    return estimates;
}

/**
 * Create a selective backup (specific tables or mints)
 * @param {Object} db - Database wrapper
 * @param {Object} options - Selection options
 */
async function createSelectiveBackup(db, options = {}) {
    const { mints = [], tables = Object.keys(TABLE_CONFIGS) } = options;

    if (mints.length > 0) {
        // Create backup filtered by specific mints
        const backup = {
            version: BACKUP_VERSION,
            timestamp: Date.now(),
            created_at: new Date().toISOString(),
            tables: {},
            metadata: { selective: true, mints },
            warnings: [],
        };

        const mintList = mints.map(m => `'${m}'`).join(',');

        // Tables that have mint column
        const mintTables = ['tokens', 'token_updates', 'holder_snapshots', 'k_score_history',
                           'holder_history', 'supply_history', 'holders_history', 'pools',
                           'token_signals', 'judgment_history', 'token_verifications'];

        for (const tableName of tables) {
            const config = TABLE_CONFIGS[tableName];
            if (!config) continue;

            try {
                let query = config.exportQuery;

                // Add mint filter for applicable tables
                if (mintTables.includes(tableName)) {
                    const hasWhere = query.toLowerCase().includes('where');
                    const hasOrder = query.toLowerCase().includes('order by');

                    if (hasOrder) {
                        query = query.replace(/order by/i, `${hasWhere ? 'AND' : 'WHERE'} mint IN (${mintList}) ORDER BY`);
                    } else {
                        query += ` ${hasWhere ? 'AND' : 'WHERE'} mint IN (${mintList})`;
                    }
                }

                const rows = await db.all(query);
                backup.tables[tableName] = rows || [];
            } catch (err) {
                backup.tables[tableName] = [];
                logger.warn(`Selective backup error for ${tableName}: ${err.message}`);
            }
        }

        return backup;
    }

    // Default to full backup with table filter
    return createBackup(db, { tables });
}

module.exports = {
    BACKUP_VERSION,
    TABLE_CONFIGS,
    createBackup,
    restoreBackup,
    getBackupSizeEstimate,
    createSelectiveBackup,
};
