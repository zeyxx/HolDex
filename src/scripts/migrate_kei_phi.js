/**
 * K-E-I-Φ MIGRATION SCRIPT
 *
 * Creates the database schema for the unified K-E-I-Φ scoring system.
 * Run: node src/scripts/migrate_kei_phi.js
 *
 * This migration adds:
 * - Node network tables (nodes, node_approvals, token_verifications)
 * - Node rewards system (reward_claims, participant linkage)
 * - Infrastructure monitoring (infra_liquidity, oracle_prices, etc.)
 * - Consensus tracking (consensus_snapshots)
 *
 * Philosophy: "Don't Trust, Verify" - All participants earn through contribution
 */

'use strict';

require('dotenv').config();
const { Pool } = require('pg');

// φ Constants for default values
const PHI = 1.618033988749895;
const PHI_INV = 0.618033988749895;
const PHI_INV_SQ = 0.381966011250105;
const PHI_INV_CUBED = 0.236067977499790;

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'false'
        ? { rejectUnauthorized: false }
        : undefined
});

async function migrate() {
    const client = await pool.connect();

    try {
        console.log('\n🚀 K-E-I-Φ Migration\n');
        console.log('═══════════════════════════════════════════════════════════════');
        console.log('  φ = 1.618033988749895 (Golden Ratio)');
        console.log('  φ⁻¹ = 0.618... (Node rewards share)');
        console.log('  φ⁻² = 0.382... (Burn/Rewards rate)');
        console.log('  φ⁻³ = 0.236... (Treasury rate)');
        console.log('═══════════════════════════════════════════════════════════════\n');

        await client.query('BEGIN');

        // ═══════════════════════════════════════════════════════════════
        // PART 1: NODE NETWORK TABLES
        // ═══════════════════════════════════════════════════════════════

        console.log('📦 [1/5] Creating node network tables...\n');

        // NODES TABLE
        await client.query(`
            CREATE TABLE IF NOT EXISTS nodes (
                node_id TEXT PRIMARY KEY,
                name TEXT,
                operator TEXT,
                status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'degraded', 'offline', 'banned')),

                -- Ed25519 Identity
                node_public_key TEXT,
                node_key_fingerprint TEXT UNIQUE,

                -- Genesis status
                is_genesis BOOLEAN DEFAULT FALSE,

                -- Approval tracking
                approval_status TEXT DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected', 'expired')),
                required_approvals INTEGER DEFAULT 2,
                current_approvals INTEGER DEFAULT 0,
                approval_expires_at BIGINT,
                approved_at BIGINT,

                -- Capabilities
                capabilities JSONB DEFAULT '["polling", "verification"]'::jsonb,

                -- Metrics
                verifications_count INTEGER DEFAULT 0,
                consensus_count INTEGER DEFAULT 0,
                uptime_percent DECIMAL(5,2) DEFAULT 100.0,
                last_heartbeat BIGINT,

                -- E-Score linkage (for rewards)
                participant_wallet TEXT REFERENCES participants(wallet),

                -- Work tracking
                work_verifications INTEGER DEFAULT 0,
                work_consensus_participated INTEGER DEFAULT 0,
                work_uptime_hours DECIMAL(10,2) DEFAULT 0,
                work_score DECIMAL(10,2) DEFAULT 0,

                -- Timestamps
                joined_at BIGINT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        console.log('  ✓ nodes table');

        // NODE APPROVALS TABLE
        await client.query(`
            CREATE TABLE IF NOT EXISTS node_approvals (
                id SERIAL PRIMARY KEY,
                node_id TEXT NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
                approved_by TEXT NOT NULL REFERENCES nodes(node_id),
                approval_signature TEXT NOT NULL,
                approved_at BIGINT NOT NULL,

                UNIQUE(node_id, approved_by)
            )
        `);
        console.log('  ✓ node_approvals table');

        // TOKEN VERIFICATIONS TABLE (for K-Score consensus)
        await client.query(`
            CREATE TABLE IF NOT EXISTS token_verifications (
                id SERIAL PRIMARY KEY,
                mint TEXT NOT NULL,
                node_id TEXT NOT NULL REFERENCES nodes(node_id),
                k_score INTEGER NOT NULL,
                node_signature TEXT,
                verified_at BIGINT NOT NULL,

                UNIQUE(mint, node_id)
            )
        `);
        console.log('  ✓ token_verifications table');

        // CONSENSUS SNAPSHOTS TABLE
        await client.query(`
            CREATE TABLE IF NOT EXISTS consensus_snapshots (
                mint TEXT PRIMARY KEY,
                k_score_consensus INTEGER NOT NULL,
                agreeing_nodes INTEGER NOT NULL,
                total_nodes INTEGER NOT NULL,
                consensus_at BIGINT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        console.log('  ✓ consensus_snapshots table');

        // Add K-Score signature fields to tokens table
        await client.query(`
            ALTER TABLE tokens
            ADD COLUMN IF NOT EXISTS sig_node_id TEXT,
            ADD COLUMN IF NOT EXISTS sig_node_signature TEXT,
            ADD COLUMN IF NOT EXISTS sig_node_timestamp BIGINT,
            ADD COLUMN IF NOT EXISTS last_k_score_update BIGINT,
            ADD COLUMN IF NOT EXISTS k_score_consensus_nodes INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS k_score_confidence DECIMAL(5,4) DEFAULT 0
        `);
        console.log('  ✓ tokens table extended with signature fields');

        // ═══════════════════════════════════════════════════════════════
        // PART 2: NODE REWARDS TABLES
        // ═══════════════════════════════════════════════════════════════

        console.log('\n📦 [2/5] Creating node rewards tables...\n');

        // REWARD CLAIMS TABLE
        await client.query(`
            CREATE TABLE IF NOT EXISTS reward_claims (
                id SERIAL PRIMARY KEY,
                node_id TEXT NOT NULL REFERENCES nodes(node_id),
                amount DECIMAL(18,8) NOT NULL,
                period_start BIGINT NOT NULL,
                period_end BIGINT NOT NULL,
                claim_signature TEXT,
                claimed_at BIGINT,
                status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'claimed', 'failed')),
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        console.log('  ✓ reward_claims table');

        // NODE REWARDS HISTORY
        await client.query(`
            CREATE TABLE IF NOT EXISTS node_rewards_history (
                id SERIAL PRIMARY KEY,
                distribution_id INTEGER,
                node_id TEXT NOT NULL REFERENCES nodes(node_id),
                e_score DECIMAL(10,2) NOT NULL,
                work_score DECIMAL(10,2) NOT NULL,
                share_amount DECIMAL(18,8) NOT NULL,
                pool_total DECIMAL(18,8) NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        console.log('  ✓ node_rewards_history table');

        // ═══════════════════════════════════════════════════════════════
        // PART 3: INFRASTRUCTURE MONITORING TABLES (I_infra)
        // ═══════════════════════════════════════════════════════════════

        console.log('\n📦 [3/5] Creating infrastructure monitoring tables...\n');

        // INFRA LIQUIDITY TABLE
        await client.query(`
            CREATE TABLE IF NOT EXISTS infra_liquidity (
                id SERIAL PRIMARY KEY,
                symbol TEXT NOT NULL,
                total_liquidity DECIMAL(24,8) NOT NULL,
                liquidity_24h_change DECIMAL(10,4) DEFAULT 0,
                pool_count INTEGER DEFAULT 0,
                recorded_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        console.log('  ✓ infra_liquidity table');

        // ORACLE PRICES TABLE
        await client.query(`
            CREATE TABLE IF NOT EXISTS oracle_prices (
                id SERIAL PRIMARY KEY,
                symbol TEXT NOT NULL,
                price DECIMAL(24,12) NOT NULL,
                confidence DECIMAL(5,4) DEFAULT 0.95,
                source TEXT NOT NULL,
                last_update TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        console.log('  ✓ oracle_prices table');

        // INFRA HEALTH CHECKS TABLE
        await client.query(`
            CREATE TABLE IF NOT EXISTS infra_health_checks (
                id SERIAL PRIMARY KEY,
                symbol TEXT NOT NULL,
                is_available BOOLEAN DEFAULT TRUE,
                response_time_ms INTEGER,
                uptime_percent DECIMAL(5,2) DEFAULT 100,
                checked_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        console.log('  ✓ infra_health_checks table');

        // INFRA ALERTS TABLE
        await client.query(`
            CREATE TABLE IF NOT EXISTS infra_alerts (
                id SERIAL PRIMARY KEY,
                symbol TEXT NOT NULL,
                alert_level TEXT NOT NULL CHECK (alert_level IN ('healthy', 'warning', 'critical', 'offline', 'recovered')),
                score DECIMAL(5,2) NOT NULL,
                components JSONB,
                recorded_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        console.log('  ✓ infra_alerts table');

        // INFRA SCORE HISTORY TABLE
        await client.query(`
            CREATE TABLE IF NOT EXISTS infra_score_history (
                id SERIAL PRIMARY KEY,
                symbol TEXT NOT NULL,
                score DECIMAL(5,2) NOT NULL,
                d_liquidity DECIMAL(5,4),
                o_oracle DECIMAL(5,4),
                l_reliability DECIMAL(5,4),
                recorded_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        console.log('  ✓ infra_score_history table');

        // FEE COLLECTIONS TABLE (from GASdf webhooks)
        await client.query(`
            CREATE TABLE IF NOT EXISTS fee_collections (
                id SERIAL PRIMARY KEY,
                tx_signature TEXT UNIQUE,
                total_fee BIGINT NOT NULL,
                rewards_amount BIGINT NOT NULL,
                user_wallet TEXT,
                payment_token TEXT,
                collected_at BIGINT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        console.log('  ✓ fee_collections table');

        // FEE DISTRIBUTIONS TABLE
        await client.query(`
            CREATE TABLE IF NOT EXISTS fee_distributions (
                id SERIAL PRIMARY KEY,
                period_start BIGINT NOT NULL,
                period_end BIGINT NOT NULL,
                total_pool BIGINT NOT NULL,
                nodes_amount BIGINT NOT NULL,
                users_amount BIGINT NOT NULL,
                devs_amount BIGINT NOT NULL,
                nodes_recipients INTEGER DEFAULT 0,
                users_recipients INTEGER DEFAULT 0,
                distributed_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        console.log('  ✓ fee_distributions table');

        // DEV REWARDS POOL TABLE
        await client.query(`
            CREATE TABLE IF NOT EXISTS dev_rewards_pool (
                id SERIAL PRIMARY KEY,
                amount BIGINT NOT NULL,
                period_start BIGINT NOT NULL,
                period_end BIGINT NOT NULL,
                status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'expired')),
                claimed_by TEXT,
                claimed_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        console.log('  ✓ dev_rewards_pool table');

        // ═══════════════════════════════════════════════════════════════
        // PART 4: INDEXES
        // ═══════════════════════════════════════════════════════════════

        console.log('\n📦 [4/5] Creating indexes...\n');

        // Node indexes
        await client.query(`CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_nodes_approval ON nodes(approval_status)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_nodes_genesis ON nodes(is_genesis)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_nodes_wallet ON nodes(participant_wallet)`);
        console.log('  ✓ nodes indexes');

        // Verification indexes
        await client.query(`CREATE INDEX IF NOT EXISTS idx_verifications_mint ON token_verifications(mint)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_verifications_node ON token_verifications(node_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_verifications_time ON token_verifications(verified_at DESC)`);
        console.log('  ✓ token_verifications indexes');

        // Reward indexes
        await client.query(`CREATE INDEX IF NOT EXISTS idx_reward_claims_node ON reward_claims(node_id)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_reward_claims_status ON reward_claims(status)`);
        console.log('  ✓ reward_claims indexes');

        // Infrastructure indexes
        await client.query(`CREATE INDEX IF NOT EXISTS idx_infra_liquidity_symbol ON infra_liquidity(symbol)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_infra_liquidity_time ON infra_liquidity(recorded_at DESC)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_oracle_prices_symbol ON oracle_prices(symbol)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_oracle_prices_time ON oracle_prices(last_update DESC)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_infra_health_symbol ON infra_health_checks(symbol)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_infra_alerts_symbol ON infra_alerts(symbol)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_infra_alerts_level ON infra_alerts(alert_level)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_infra_score_symbol ON infra_score_history(symbol)`);
        console.log('  ✓ infrastructure indexes');

        // Fee distribution indexes
        await client.query(`CREATE INDEX IF NOT EXISTS idx_fee_collections_time ON fee_collections(collected_at DESC)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_fee_collections_wallet ON fee_collections(user_wallet)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_fee_distributions_time ON fee_distributions(distributed_at DESC)`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_dev_rewards_status ON dev_rewards_pool(status)`);
        console.log('  ✓ fee distribution indexes');

        // ═══════════════════════════════════════════════════════════════
        // PART 5: SEED DATA
        // ═══════════════════════════════════════════════════════════════

        console.log('\n📦 [5/5] Seeding infrastructure tokens...\n');

        const infraTokens = [
            { symbol: 'SOL', name: 'Solana', type: 'native' },
            { symbol: 'USDC', name: 'USD Coin', type: 'stable' },
            { symbol: 'USDT', name: 'Tether USD', type: 'stable' },
            { symbol: 'wSOL', name: 'Wrapped SOL', type: 'wrapped' },
            { symbol: 'JitoSOL', name: 'Jito Staked SOL', type: 'lst' },
            { symbol: 'mSOL', name: 'Marinade Staked SOL', type: 'lst' },
            { symbol: 'bSOL', name: 'BlazeStake Staked SOL', type: 'lst' }
        ];

        // Initialize with healthy baseline
        for (const token of infraTokens) {
            // Liquidity baseline
            await client.query(`
                INSERT INTO infra_liquidity (symbol, total_liquidity, pool_count)
                VALUES ($1, 100000000, 10)
                ON CONFLICT DO NOTHING
            `, [token.symbol]);

            // Oracle baseline
            await client.query(`
                INSERT INTO oracle_prices (symbol, price, confidence, source)
                VALUES ($1, 1.0, 0.95, 'baseline')
            `, [token.symbol]);

            // Health baseline
            await client.query(`
                INSERT INTO infra_health_checks (symbol, is_available, response_time_ms, uptime_percent)
                VALUES ($1, TRUE, 100, 99.9)
            `, [token.symbol]);

            console.log(`  ✓ ${token.symbol} (${token.name})`);
        }

        await client.query('COMMIT');

        // ═══════════════════════════════════════════════════════════════
        // SUMMARY
        // ═══════════════════════════════════════════════════════════════

        console.log('\n═══════════════════════════════════════════════════════════════');
        console.log('✅ K-E-I-Φ Migration Complete');
        console.log('═══════════════════════════════════════════════════════════════\n');

        console.log('Tables created:');
        console.log('  Node Network:');
        console.log('    • nodes - Verification network participants');
        console.log('    • node_approvals - φ⁻¹ threshold approvals');
        console.log('    • token_verifications - K-Score signatures');
        console.log('    • consensus_snapshots - Agreement records');
        console.log('');
        console.log('  Node Rewards:');
        console.log('    • reward_claims - Pending/claimed rewards');
        console.log('    • node_rewards_history - Distribution audit trail');
        console.log('');
        console.log('  Infrastructure (I_infra):');
        console.log('    • infra_liquidity - D_liquidity tracking');
        console.log('    • oracle_prices - O_oracle freshness');
        console.log('    • infra_health_checks - L_reliability');
        console.log('    • infra_alerts - Health alerts');
        console.log('    • infra_score_history - Historical I_infra');
        console.log('');
        console.log('φ Constants Used:');
        console.log(`    φ   = ${PHI.toFixed(15)}`);
        console.log(`    φ⁻¹ = ${PHI_INV.toFixed(15)} (61.8%)`);
        console.log(`    φ⁻² = ${PHI_INV_SQ.toFixed(15)} (38.2%)`);
        console.log(`    φ⁻³ = ${PHI_INV_CUBED.toFixed(15)} (23.6%)`);
        console.log('');

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('\n❌ Migration failed:', error.message);
        console.error(error.stack);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

// Run migration
migrate().catch(err => {
    console.error(err);
    process.exit(1);
});
