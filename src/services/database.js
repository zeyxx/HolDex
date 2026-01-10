const { Pool } = require('pg');
const config = require('../config/env');
const logger = require('./logger');
const { getClient } = require('./redis');
// We require this dynamically inside functions if needed to avoid circular deps,
// or pass it in. For aggregateAndSaveToken, we need it.
const { getHolderCountFromRPC } = require('./solana');
const { signMarket, signKScore } = require('../utils/dataSignature'); 

let primaryPool = null;
let readPool = null; 
let dbWrapper = null;
let initPromise = null;

const pendingRequests = new Map();

async function initDB() {
    if (dbWrapper) return dbWrapper;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        try {
            // Guard against missing DATABASE_URL
            if (!config.DATABASE_URL) {
                throw new Error('DATABASE_URL is required - set it in .env or environment');
            }

            const isLocal = config.DATABASE_URL.includes('localhost') || config.DATABASE_URL.includes('127.0.0.1');

            // SECURITY: SSL Configuration (H1)
            // In production, prefer SSL verification. Set DB_SSL_REJECT_UNAUTHORIZED=true for strict mode.
            // Default to false for Render's managed Postgres (uses internal certs)
            const strictSsl = process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true';
            let sslConfig;

            if (isLocal) {
                sslConfig = false;
            } else {
                sslConfig = { rejectUnauthorized: strictSsl };
                if (!strictSsl && config.NODE_ENV === 'production') {
                    logger.warn('⚠️ SECURITY: SSL certificate verification disabled (DB_SSL_REJECT_UNAUTHORIZED != true)');
                    logger.warn('⚠️ Set DB_SSL_REJECT_UNAUTHORIZED=true in production for MITM protection');
                }
            }

            // SCALABILITY FIX: Pool size tuned for Render basic_256mb plan (max 22 connections)
            // With 3 services (API, Calculator, Worker), pool = 7 × 3 = 21 connections (under limit)
            // Previous value of 10 caused connection exhaustion (10 × 3 = 30 > 22)
            primaryPool = new Pool({
                connectionString: config.DATABASE_URL,
                ssl: sslConfig,
                max: 7,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 10000, // Increased from 5s to 10s for burst handling
            });

            primaryPool.on('error', (err) => logger.error(`Unexpected error on Primary DB: ${err.message}`));
            const client = await primaryPool.connect();
            client.release();
            logger.info(`💾 Database: Connection Successful.`);

            if (process.env.READ_DATABASE_URL) {
                readPool = new Pool({ connectionString: process.env.READ_DATABASE_URL, ssl: sslConfig });
            } else {
                readPool = primaryPool;
            }

            // --- SCHEMA DEFINITIONS ---
            await primaryPool.query(`
                CREATE TABLE IF NOT EXISTS tokens (
                    mint TEXT PRIMARY KEY,
                    name TEXT,
                    symbol TEXT,
                    image TEXT,
                    supply TEXT,
                    decimals INTEGER DEFAULT 9,
                    priceUsd DOUBLE PRECISION,
                    liquidity DOUBLE PRECISION,
                    marketCap DOUBLE PRECISION,
                    volume24h DOUBLE PRECISION,
                    change24h DOUBLE PRECISION,
                    change1h DOUBLE PRECISION,
                    change5m DOUBLE PRECISION,
                    holders INTEGER DEFAULT 0,
                    last_holder_check BIGINT DEFAULT 0,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    
                    -- K-Score Columns
                    k_score DOUBLE PRECISION DEFAULT 0,
                    last_k_score_update BIGINT DEFAULT 0,
                    
                    hasCommunityUpdate BOOLEAN DEFAULT FALSE,
                    metadata TEXT,
                    timestamp BIGINT
                );
                
                -- Stores daily snapshots of holder counts for Trend Calculation
                CREATE TABLE IF NOT EXISTS holders_history (
                    mint TEXT,
                    count INTEGER,
                    timestamp BIGINT,
                    PRIMARY KEY (mint, timestamp)
                );

                -- Detailed Pool Info for Liquidity Analysis
                CREATE TABLE IF NOT EXISTS pools (
                    address TEXT PRIMARY KEY,
                    mint TEXT,
                    dex TEXT,
                    token_a TEXT NOT NULL,
                    token_b TEXT NOT NULL,
                    reserve_a TEXT,
                    reserve_b TEXT,
                    price_usd DOUBLE PRECISION DEFAULT 0,
                    liquidity_usd DOUBLE PRECISION DEFAULT 0,
                    volume_24h DOUBLE PRECISION DEFAULT 0,
                    created_at BIGINT
                );
                
                CREATE TABLE IF NOT EXISTS candles_1m (
                    pool_address TEXT,
                    timestamp BIGINT,
                    open DOUBLE PRECISION,
                    high DOUBLE PRECISION,
                    low DOUBLE PRECISION,
                    close DOUBLE PRECISION,
                    volume DOUBLE PRECISION,
                    PRIMARY KEY (pool_address, timestamp)
                );

                CREATE TABLE IF NOT EXISTS active_trackers ( pool_address TEXT PRIMARY KEY, priority INTEGER DEFAULT 1, last_check BIGINT DEFAULT 0 );
                CREATE TABLE IF NOT EXISTS token_updates ( id SERIAL PRIMARY KEY, mint TEXT, twitter TEXT, website TEXT, telegram TEXT, banner TEXT, description TEXT, submittedAt BIGINT, status TEXT DEFAULT 'pending', signature TEXT, payer TEXT );
                CREATE TABLE IF NOT EXISTS api_keys ( key_hash TEXT PRIMARY KEY, key_prefix TEXT, owner TEXT, wallet TEXT, tier TEXT DEFAULT 'free', requests_limit INTEGER DEFAULT 1000, requests_today INTEGER DEFAULT 0, last_reset BIGINT DEFAULT 0, is_active BOOLEAN DEFAULT TRUE, created_at BIGINT );

                CREATE TABLE IF NOT EXISTS holder_snapshots (
                    mint TEXT NOT NULL,
                    holder TEXT NOT NULL,
                    last_signature TEXT,
                    buy_count INTEGER DEFAULT 0,
                    sell_count INTEGER DEFAULT 0,
                    net_flow BIGINT DEFAULT 0,
                    conviction_class TEXT DEFAULT 'holder',
                    balance BIGINT DEFAULT 0,
                    updated_at BIGINT DEFAULT 0,
                    PRIMARY KEY (mint, holder)
                );

                CREATE TABLE IF NOT EXISTS webhooks (
                    id TEXT PRIMARY KEY,
                    mint TEXT NOT NULL,
                    webhook_id TEXT NOT NULL,
                    created_at BIGINT DEFAULT 0,
                    UNIQUE(mint)
                );

                -- K-Score history for trajectory analysis (30/60/90 day trends)
                CREATE TABLE IF NOT EXISTS k_score_history (
                    mint TEXT NOT NULL,
                    date DATE NOT NULL,
                    k_score DOUBLE PRECISION,
                    conviction_score DOUBLE PRECISION,
                    holders INTEGER,
                    PRIMARY KEY (mint, date)
                );

                -- Holder history for trend analysis
                CREATE TABLE IF NOT EXISTS holder_history (
                    mint TEXT NOT NULL,
                    date DATE NOT NULL,
                    holders INTEGER,
                    real_holders INTEGER,
                    PRIMARY KEY (mint, date)
                );

                -- Supply history for Mayhem Mode (mutable supply) tracking
                CREATE TABLE IF NOT EXISTS supply_history (
                    mint TEXT NOT NULL,
                    supply TEXT NOT NULL,
                    timestamp BIGINT NOT NULL,
                    source TEXT DEFAULT 'kscore',
                    change_percent DOUBLE PRECISION DEFAULT 0,
                    PRIMARY KEY (mint, timestamp)
                );

                -- Wallet credits for burn-based API access
                -- "Burn = Value Creation = Lifetime API Access"
                CREATE TABLE IF NOT EXISTS wallet_credits (
                    wallet TEXT PRIMARY KEY,
                    used_calls BIGINT DEFAULT 0,
                    last_call BIGINT,
                    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
                );

                -- ═══════════════════════════════════════════════════════════
                -- WALLET TX CACHE: Cross-token transaction reuse
                -- Philosophy: Fetch once, analyze many tokens
                -- When fetching wallet transactions, extract ALL token interactions
                -- ═══════════════════════════════════════════════════════════
                CREATE TABLE IF NOT EXISTS wallet_tx_cache (
                    wallet TEXT NOT NULL,
                    mint TEXT NOT NULL,
                    buy_count INTEGER DEFAULT 0,
                    sell_count INTEGER DEFAULT 0,
                    net_flow BIGINT DEFAULT 0,
                    first_tx_timestamp BIGINT,
                    last_tx_timestamp BIGINT,
                    last_signature TEXT,
                    analyzed_at BIGINT DEFAULT 0,
                    PRIMARY KEY (wallet, mint)
                );

                -- ═══════════════════════════════════════════════════════════
                -- HARMONY SYSTEM: φ-Powered E-Score Infrastructure
                -- "Hold to enter. Burn to use. φ guides all ratios."
                -- ═══════════════════════════════════════════════════════════

                -- Participants: Unified E-Score tracking across ecosystem
                -- E-Score = geometric mean of 7 dimensions (hold, burn, use, build, run, refer, time)
                CREATE TABLE IF NOT EXISTS participants (
                    wallet TEXT PRIMARY KEY,
                    type TEXT DEFAULT 'user',              -- 'user' | 'holder' | 'burner' | 'dev' | 'infra'

                    -- Raw contribution metrics (source of truth)
                    -- Column names MUST match harmonyEngine.js expectations
                    holdings DOUBLE PRECISION DEFAULT 0,           -- Current $ASDF holdings
                    total_burned DOUBLE PRECISION DEFAULT 0,       -- Lifetime burned
                    api_calls_30d INTEGER DEFAULT 0,               -- Rolling 30-day API usage
                    apps_live INTEGER DEFAULT 0,                   -- Active applications built
                    nodes_active INTEGER DEFAULT 0,                -- Infrastructure nodes running
                    referrals_active INTEGER DEFAULT 0,            -- Active referrals

                    -- E-Score (recalculated on demand)
                    -- Column names MUST match harmonyEngine.js: e_score, tier, tier_icon
                    e_score DOUBLE PRECISION DEFAULT 0,
                    tier TEXT DEFAULT 'Newcomer',
                    tier_icon TEXT DEFAULT '🌱',
                    e_score_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                    -- Rewards tracking
                    rewards_lifetime DOUBLE PRECISION DEFAULT 0,

                    -- Timestamps
                    first_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                    -- Data integrity
                    sig_escore TEXT DEFAULT NULL
                );

                -- Contributions: Immutable audit trail for E-Score changes
                -- Every contribution is recorded for transparency
                CREATE TABLE IF NOT EXISTS contributions (
                    id SERIAL PRIMARY KEY,
                    wallet TEXT NOT NULL,
                    type TEXT NOT NULL,                    -- 'burn' | 'refer' | 'build' | 'run' | 'api_call'
                    amount DOUBLE PRECISION NOT NULL,
                    source TEXT NOT NULL,                  -- 'gasdf' | 'holdex' | 'direct'

                    -- Verification
                    tx_signature TEXT,                     -- Solana tx for burns
                    verified BOOLEAN DEFAULT FALSE,
                    verified_at BIGINT,

                    -- φ-Impact calculation
                    e_score_delta DOUBLE PRECISION DEFAULT 0,

                    -- Timestamps
                    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,

                    -- Prevent duplicates
                    UNIQUE(tx_signature)
                );

                -- Reward Distributions: φ-ratio fee distribution tracking
                -- 38.2% burn, 38.2% rewards, 23.6% treasury (based on φ²/φ³)
                CREATE TABLE IF NOT EXISTS reward_distributions (
                    id SERIAL PRIMARY KEY,
                    source_tx TEXT NOT NULL,               -- Original fee transaction
                    total_amount DOUBLE PRECISION NOT NULL,

                    -- φ-ratio splits
                    burn_amount DOUBLE PRECISION NOT NULL,      -- 38.2%
                    rewards_amount DOUBLE PRECISION NOT NULL,   -- 38.2%
                    treasury_amount DOUBLE PRECISION NOT NULL,  -- 23.6%

                    -- Distribution status
                    status TEXT DEFAULT 'pending',         -- 'pending' | 'distributed' | 'failed'
                    distributed_at BIGINT,

                    -- Timestamps
                    created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
                );

                -- Operation Costs: Fee structure with efficiency floor
                -- minFee = (cost / 0.236) × 1.2 guarantees infrastructure sustainability
                CREATE TABLE IF NOT EXISTS operation_costs (
                    operation_type TEXT PRIMARY KEY,       -- 'gasdf_submit_standard', 'gasdf_submit_priority', etc.
                    base_fee DOUBLE PRECISION NOT NULL,    -- Base fee in $ASDF
                    actual_cost DOUBLE PRECISION NOT NULL, -- Infrastructure cost
                    min_fee DOUBLE PRECISION NOT NULL,     -- Efficiency floor: (cost / 0.236) × 1.2
                    max_discount DOUBLE PRECISION NOT NULL, -- Maximum discount % (e.g., 0.50 = 50%)
                    is_active BOOLEAN DEFAULT TRUE,        -- Enable/disable operations

                    -- Analytics
                    total_calls INTEGER DEFAULT 0,
                    total_revenue DOUBLE PRECISION DEFAULT 0,

                    -- Timestamps
                    updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
                );

                -- ═══════════════════════════════════════════════════════════
                -- SPACE ACCESS SYSTEM: φ-Aligned Wallet-Based Permissions
                -- "Hold to enter. Grants unlock features. E-Score = benefits."
                -- ═══════════════════════════════════════════════════════════

                -- Access Grants: Feature-based permissions (not hierarchical roles)
                -- Philosophy: Tiers are cosmetic, grants unlock tools
                CREATE TABLE IF NOT EXISTS access_grants (
                    wallet TEXT PRIMARY KEY,
                    grants TEXT[] DEFAULT '{}',             -- ['space_access', 'card_generator', 'gasdf_analytics']

                    -- E-Score boost for special contributions (ambassadors, etc.)
                    e_score_boost DOUBLE PRECISION DEFAULT 0,

                    -- Audit trail
                    granted_by TEXT NOT NULL,               -- Admin wallet who granted
                    grant_reason TEXT,                      -- Why granted

                    -- Security: HMAC signature for integrity
                    signature TEXT NOT NULL,                -- HMAC(wallet + grants + granted_by + created_at)

                    -- Lifecycle
                    is_active BOOLEAN DEFAULT TRUE,
                    expires_at TIMESTAMP,                   -- NULL = permanent
                    revoked_at TIMESTAMP,
                    revoked_by TEXT,

                    -- Timestamps
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                -- Space Actions: Audit log for all space interactions
                -- Every action is logged for transparency and analytics
                CREATE TABLE IF NOT EXISTS space_actions (
                    id SERIAL PRIMARY KEY,
                    wallet TEXT NOT NULL,
                    action TEXT NOT NULL,                   -- 'generate_card', 'view_analytics', 'submit_token'
                    grant_used TEXT,                        -- Which grant authorized this action

                    -- For write actions: signature verification
                    signature TEXT,                         -- Wallet signature (for write actions)
                    signed_message TEXT,                    -- Original message that was signed

                    -- Action metadata
                    metadata JSONB DEFAULT '{}',            -- { mint: '...', mode: 'full', etc. }

                    -- Result
                    success BOOLEAN DEFAULT TRUE,
                    error TEXT,

                    -- Timestamps
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                -- Wallet Sessions: Optional session tokens for read-only access
                -- Write actions still require fresh signatures
                CREATE TABLE IF NOT EXISTS wallet_sessions (
                    wallet TEXT PRIMARY KEY,
                    session_token TEXT NOT NULL UNIQUE,

                    -- Verification
                    signed_message TEXT NOT NULL,           -- "Access HolDex Space: [timestamp]"
                    signature TEXT NOT NULL,                -- Wallet signature

                    -- Lifecycle
                    expires_at TIMESTAMP NOT NULL,          -- Default: 7 days
                    last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                    -- Timestamps
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );

                -- ═══════════════════════════════════════════════════════════
                -- NODE NETWORK: Decentralized Validation Infrastructure
                -- "Multiple nodes, shared truth, verified consensus."
                -- ═══════════════════════════════════════════════════════════

                -- Nodes: Registry of HolDex node operators
                -- Each node independently calculates K-Scores and validates data
                CREATE TABLE IF NOT EXISTS nodes (
                    node_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    operator TEXT NOT NULL,               -- Operator wallet address

                    -- Endpoints
                    api_url TEXT,                         -- Public API endpoint (optional)
                    region TEXT,                          -- Geographic region (us-west, eu-central, etc.)

                    -- Health metrics
                    last_heartbeat BIGINT DEFAULT 0,      -- Last heartbeat timestamp (ms)
                    uptime_30d DOUBLE PRECISION DEFAULT 0, -- 30-day uptime percentage

                    -- Verification stats
                    tokens_verified INTEGER DEFAULT 0,    -- Total tokens verified
                    verifications_24h INTEGER DEFAULT 0,  -- Verifications in last 24h
                    consensus_rate DOUBLE PRECISION DEFAULT 1.0, -- Agreement with other nodes

                    -- Status
                    status TEXT DEFAULT 'pending',        -- pending | active | degraded | offline
                    version TEXT DEFAULT '1.0.0',         -- Node software version

                    -- Timestamps
                    joined_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
                    updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
                );

                -- Token Verifications: Per-token verification log by node
                -- Tracks which nodes verified which tokens and when
                CREATE TABLE IF NOT EXISTS token_verifications (
                    id SERIAL PRIMARY KEY,
                    mint TEXT NOT NULL,
                    node_id TEXT NOT NULL REFERENCES nodes(node_id),

                    -- Verification data
                    verified_at BIGINT NOT NULL,
                    k_score DOUBLE PRECISION,
                    signatures_valid BOOLEAN DEFAULT TRUE,

                    -- Simple unique: one verification per node per token
                    UNIQUE(mint, node_id)
                );

                -- ═══════════════════════════════════════════════════════════
                -- SIGNAL ACCUMULATOR: 17-Dimension Pre-Judgment System
                -- "FREE webhooks → Judge → RPC only for winners"
                -- ═══════════════════════════════════════════════════════════

                CREATE TABLE IF NOT EXISTS token_signals (
                    mint                TEXT PRIMARY KEY,
                    swap_count          INTEGER DEFAULT 0,
                    transfer_count      INTEGER DEFAULT 0,
                    unique_wallets      JSONB DEFAULT '[]'::jsonb,
                    unique_wallet_count INTEGER DEFAULT 0,
                    first_seen          BIGINT NOT NULL,
                    last_seen           BIGINT NOT NULL,
                    amounts             JSONB DEFAULT '[]'::jsonb,
                    amount_variance     REAL DEFAULT 0,
                    sources             JSONB DEFAULT '[]'::jsonb,
                    wallet_e_scores     JSONB DEFAULT '[]'::jsonb,
                    avg_wallet_e_score  REAL DEFAULT 0,
                    pre_score           REAL DEFAULT 0,
                    judgment_status     TEXT DEFAULT 'pending',
                    judgment_reason     TEXT,
                    judgment_at         BIGINT,
                    dimension_scores    JSONB DEFAULT '{}'::jsonb,
                    node_signals        JSONB DEFAULT '{}'::jsonb,
                    nodes_seen          JSONB DEFAULT '[]'::jsonb,
                    created_at          BIGINT NOT NULL,
                    updated_at          BIGINT NOT NULL,
                    promoted_at         BIGINT,
                    promoted_reason     TEXT
                );

                CREATE TABLE IF NOT EXISTS judgment_history (
                    id                  SERIAL PRIMARY KEY,
                    mint                TEXT NOT NULL,
                    action              TEXT NOT NULL,
                    pre_score           REAL NOT NULL,
                    dimension_scores    JSONB NOT NULL,
                    signal_snapshot     JSONB NOT NULL,
                    content_hash        TEXT,
                    merkle_proof        JSONB,
                    was_correct         BOOLEAN,
                    k_score_outcome     REAL,
                    feedback_at         BIGINT,
                    created_at          BIGINT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS judgment_thresholds (
                    dimension           TEXT PRIMARY KEY,
                    threshold           REAL NOT NULL,
                    weight              REAL NOT NULL,
                    phi_default         REAL NOT NULL,
                    adjustments         JSONB DEFAULT '[]'::jsonb,
                    last_tuned          BIGINT,
                    true_positives      INTEGER DEFAULT 0,
                    false_positives     INTEGER DEFAULT 0,
                    true_negatives      INTEGER DEFAULT 0,
                    false_negatives     INTEGER DEFAULT 0
                );
            `);

            // Add new columns if they don't exist (migration-safe)
            const migrations = [
                // API Keys: Add columns for burn credits system
                `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS wallet TEXT`,
                `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_hash TEXT`,
                `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_prefix TEXT`,
                // Wallet Credits: Add columns for cached burns
                `ALTER TABLE wallet_credits ADD COLUMN IF NOT EXISTS total_burned DOUBLE PRECISION DEFAULT 0`,
                `ALTER TABLE wallet_credits ADD COLUMN IF NOT EXISTS last_burn_check BIGINT DEFAULT 0`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS initial_supply TEXT`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS burned_amount DOUBLE PRECISION DEFAULT 0`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS burned_percent DOUBLE PRECISION DEFAULT 0`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS is_pump_fun BOOLEAN DEFAULT FALSE`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS bonding_curve_complete BOOLEAN DEFAULT FALSE`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS conviction_score DOUBLE PRECISION DEFAULT 0`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS conviction_accumulators INTEGER DEFAULT 0`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS conviction_holders INTEGER DEFAULT 0`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS conviction_reducers INTEGER DEFAULT 0`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS conviction_extractors INTEGER DEFAULT 0`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS conviction_analyzed INTEGER DEFAULT 0`,
                // Mayhem Mode (mutable supply) support
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS supply_last_check BIGINT DEFAULT 0`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS supply_change_24h DOUBLE PRECISION DEFAULT 0`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS is_mutable_supply BOOLEAN DEFAULT FALSE`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS mint_authority_revoked BOOLEAN DEFAULT FALSE`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS freeze_authority_revoked BOOLEAN DEFAULT FALSE`,
                // Security/LP Status caching (with 24h TTL for integrity)
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS security_last_check BIGINT DEFAULT 0`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS lp_last_check BIGINT DEFAULT 0`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS lp_burn_pct DOUBLE PRECISION DEFAULT NULL`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS lp_locked_pct DOUBLE PRECISION DEFAULT NULL`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS lp_status TEXT DEFAULT NULL`,
                // DATA INTEGRITY: 8-Category Signature System (42 colonnes - Controlled Chaos)
                // $asdfasdfa philosophy: Don't Trust, Verify
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS data_signature TEXT DEFAULT NULL`, // Legacy
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS sig_identity TEXT DEFAULT NULL`,   // name|symbol|image|decimals
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS sig_security TEXT DEFAULT NULL`,   // mint_auth|freeze_auth|mutable|verified
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS sig_lp TEXT DEFAULT NULL`,         // lp_burn|lp_locked|lp_status
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS sig_supply TEXT DEFAULT NULL`,     // supply|initial|burned
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS sig_kscore TEXT DEFAULT NULL`,     // k_score|conviction|holders
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS sig_market TEXT DEFAULT NULL`,     // price|mcap|liquidity
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS sig_origin TEXT DEFAULT NULL`,     // is_pump|bonding|timestamp|metadata
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS sig_full TEXT DEFAULT NULL`,       // HMAC(all sigs + chaos)
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS chaos_nonce TEXT DEFAULT NULL`,    // Random entropy - 42nd column
                // K-Score v9: Activity freshness tracking
                `ALTER TABLE holder_snapshots ADD COLUMN IF NOT EXISTS last_tx_timestamp BIGINT DEFAULT 0`,
                // Age column for tokens (avoid recalculating from timestamp)
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS age_days DOUBLE PRECISION DEFAULT 0`,
                // Holder snapshots integrity (same standard as other data)
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS sig_holders TEXT DEFAULT NULL`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS holders_snapshot_check BIGINT DEFAULT 0`,
                // Price/Market provenance columns (required by signMarket)
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS price_source TEXT DEFAULT 'unknown'`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS price_timestamp BIGINT DEFAULT 0`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS price_pool TEXT DEFAULT ''`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS mcap_calculated BOOLEAN DEFAULT FALSE`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS liquidity_source TEXT DEFAULT 'unknown'`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS liquidity_timestamp BIGINT DEFAULT 0`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS holders_source TEXT DEFAULT 'unknown'`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS holders_timestamp BIGINT DEFAULT 0`,
                // K-Score v10: Real holders tracking
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS real_holders INTEGER DEFAULT 0`,
                `ALTER TABLE tokens ADD COLUMN IF NOT EXISTS total_holders INTEGER DEFAULT 0`,
                // Harmony: Fix operation_costs schema if old version exists
                `ALTER TABLE operation_costs RENAME COLUMN operation TO operation_type`,
                `ALTER TABLE operation_costs RENAME COLUMN infrastructure_cost TO actual_cost`,
                `ALTER TABLE operation_costs ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE`,
                // Harmony: Fix participants schema - handle column rename/copy scenarios
                // Scenario 1: Old column exists, new doesn't → RENAME
                // Scenario 2: Both exist → COPY data then DROP old
                // Scenario 3: Only new exists → Nothing to do
                `DO $$ BEGIN
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='participants' AND column_name='cached_escore') THEN
                        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='participants' AND column_name='e_score') THEN
                            ALTER TABLE participants RENAME COLUMN cached_escore TO e_score;
                        ELSE
                            UPDATE participants SET e_score = COALESCE(cached_escore, e_score) WHERE cached_escore IS NOT NULL AND cached_escore > 0;
                            ALTER TABLE participants DROP COLUMN cached_escore;
                        END IF;
                    END IF;
                END $$`,
                `DO $$ BEGIN
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='participants' AND column_name='cached_tier') THEN
                        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='participants' AND column_name='tier') THEN
                            ALTER TABLE participants RENAME COLUMN cached_tier TO tier;
                        ELSE
                            UPDATE participants SET tier = COALESCE(cached_tier, tier) WHERE cached_tier IS NOT NULL AND cached_tier != '';
                            ALTER TABLE participants DROP COLUMN cached_tier;
                        END IF;
                    END IF;
                END $$`,
                `DO $$ BEGIN
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='participants' AND column_name='cached_tier_icon') THEN
                        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='participants' AND column_name='tier_icon') THEN
                            ALTER TABLE participants RENAME COLUMN cached_tier_icon TO tier_icon;
                        ELSE
                            UPDATE participants SET tier_icon = COALESCE(cached_tier_icon, tier_icon) WHERE cached_tier_icon IS NOT NULL AND cached_tier_icon != '';
                            ALTER TABLE participants DROP COLUMN cached_tier_icon;
                        END IF;
                    END IF;
                END $$`,
                `DO $$ BEGIN
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='participants' AND column_name='escore_updated_at') THEN
                        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='participants' AND column_name='e_score_updated_at') THEN
                            ALTER TABLE participants RENAME COLUMN escore_updated_at TO e_score_updated_at;
                        ELSE
                            UPDATE participants SET e_score_updated_at = COALESCE(escore_updated_at, e_score_updated_at) WHERE escore_updated_at IS NOT NULL;
                            ALTER TABLE participants DROP COLUMN escore_updated_at;
                        END IF;
                    END IF;
                END $$`,
                // Harmony: Add missing columns (for fresh installs or post-rename)
                `ALTER TABLE participants ADD COLUMN IF NOT EXISTS holdings DOUBLE PRECISION DEFAULT 0`,
                `ALTER TABLE participants ADD COLUMN IF NOT EXISTS api_calls_30d INTEGER DEFAULT 0`,
                `ALTER TABLE participants ADD COLUMN IF NOT EXISTS apps_live INTEGER DEFAULT 0`,
                `ALTER TABLE participants ADD COLUMN IF NOT EXISTS nodes_active INTEGER DEFAULT 0`,
                `ALTER TABLE participants ADD COLUMN IF NOT EXISTS referrals_active INTEGER DEFAULT 0`,
                `ALTER TABLE participants ADD COLUMN IF NOT EXISTS e_score DOUBLE PRECISION DEFAULT 0`,
                `ALTER TABLE participants ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'Newcomer'`,
                `ALTER TABLE participants ADD COLUMN IF NOT EXISTS tier_icon TEXT DEFAULT '🌱'`,
                `ALTER TABLE participants ADD COLUMN IF NOT EXISTS e_score_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
                `ALTER TABLE participants ADD COLUMN IF NOT EXISTS rewards_lifetime DOUBLE PRECISION DEFAULT 0`,
                `ALTER TABLE participants ADD COLUMN IF NOT EXISTS first_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
                `ALTER TABLE participants ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
                // FIX: Ensure conviction_score is DOUBLE PRECISION (might be INTEGER in old DBs)
                `ALTER TABLE tokens ALTER COLUMN conviction_score TYPE DOUBLE PRECISION USING conviction_score::DOUBLE PRECISION`,
                // FIX: Ensure all market data columns are DOUBLE PRECISION (might be INTEGER in old DBs)
                // This fixes "invalid input syntax for type integer" errors when inserting decimal values
                `ALTER TABLE tokens ALTER COLUMN liquidity TYPE DOUBLE PRECISION USING liquidity::DOUBLE PRECISION`,
                `ALTER TABLE tokens ALTER COLUMN marketcap TYPE DOUBLE PRECISION USING marketcap::DOUBLE PRECISION`,
                `ALTER TABLE tokens ALTER COLUMN volume24h TYPE DOUBLE PRECISION USING volume24h::DOUBLE PRECISION`,
                `ALTER TABLE tokens ALTER COLUMN priceusd TYPE DOUBLE PRECISION USING priceusd::DOUBLE PRECISION`,
                `ALTER TABLE tokens ALTER COLUMN change24h TYPE DOUBLE PRECISION USING change24h::DOUBLE PRECISION`,
                `ALTER TABLE tokens ALTER COLUMN change1h TYPE DOUBLE PRECISION USING change1h::DOUBLE PRECISION`,
                `ALTER TABLE tokens ALTER COLUMN change5m TYPE DOUBLE PRECISION USING change5m::DOUBLE PRECISION`,
                `ALTER TABLE tokens ALTER COLUMN k_score TYPE DOUBLE PRECISION USING k_score::DOUBLE PRECISION`,
                `ALTER TABLE pools ALTER COLUMN price_usd TYPE DOUBLE PRECISION USING price_usd::DOUBLE PRECISION`,
                `ALTER TABLE pools ALTER COLUMN liquidity_usd TYPE DOUBLE PRECISION USING liquidity_usd::DOUBLE PRECISION`,
                `ALTER TABLE pools ALTER COLUMN volume_24h TYPE DOUBLE PRECISION USING volume_24h::DOUBLE PRECISION`,
                // ═══════════════════════════════════════════════════════════
                // PER-NODE CRYPTOGRAPHIC IDENTITY (Ed25519)
                // Philosophy: "Don't trust. Verify." - Each node has unique identity
                // ═══════════════════════════════════════════════════════════
                `ALTER TABLE nodes ADD COLUMN IF NOT EXISTS node_public_key TEXT DEFAULT NULL`,      // Ed25519 public key (base64)
                `ALTER TABLE nodes ADD COLUMN IF NOT EXISTS node_key_fingerprint TEXT DEFAULT NULL`, // SHA256 of public key (hex, first 16 chars)
                `ALTER TABLE nodes ADD COLUMN IF NOT EXISTS key_registered_at BIGINT DEFAULT NULL`,  // When key was registered
                // Node integrity signatures (HMAC-SHA256, like tokens)
                `ALTER TABLE nodes ADD COLUMN IF NOT EXISTS sig_node_identity TEXT DEFAULT NULL`,    // Signs: node_id, name, operator, public_key
                `ALTER TABLE nodes ADD COLUMN IF NOT EXISTS sig_node_status TEXT DEFAULT NULL`,      // Signs: status, last_heartbeat, version
                `ALTER TABLE nodes ADD COLUMN IF NOT EXISTS node_chaos_nonce TEXT DEFAULT NULL`,     // Random nonce for unpredictability
                `ALTER TABLE nodes ADD COLUMN IF NOT EXISTS updated_at BIGINT DEFAULT 0`,            // Last update timestamp
                // Token verifications: Add cryptographic proof
                `ALTER TABLE token_verifications ADD COLUMN IF NOT EXISTS node_signature TEXT DEFAULT NULL`, // Ed25519 signature (base64)
                `ALTER TABLE token_verifications ADD COLUMN IF NOT EXISTS signature_version TEXT DEFAULT 'v1'`, // For future algorithm upgrades
                // ═══════════════════════════════════════════════════════════
                // WATCHLIST SYSTEM (Consumer Journey Stage 4: Investment)
                // ═══════════════════════════════════════════════════════════
                `CREATE TABLE IF NOT EXISTS user_watchlists (
                    id SERIAL PRIMARY KEY,
                    wallet TEXT NOT NULL,
                    mint TEXT NOT NULL,
                    label TEXT DEFAULT NULL,
                    alert_threshold INTEGER DEFAULT NULL,
                    alert_direction TEXT DEFAULT 'below',
                    added_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
                    last_notified_at BIGINT DEFAULT NULL,
                    UNIQUE(wallet, mint)
                )`,
            ];

            // PERFORMANCE: Add indexes for frequently queried columns
            const indexMigrations = [
                // Index for verified tokens filter (hasCommunityUpdate = TRUE)
                `CREATE INDEX IF NOT EXISTS idx_tokens_community_update ON tokens (hasCommunityUpdate) WHERE hasCommunityUpdate = TRUE`,
                // Index for K-Score sorting (most common sort)
                `CREATE INDEX IF NOT EXISTS idx_tokens_kscore ON tokens (k_score DESC NULLS LAST)`,
                // Index for timestamp/age sorting
                `CREATE INDEX IF NOT EXISTS idx_tokens_timestamp ON tokens (timestamp DESC NULLS LAST)`,
                // Index for market cap sorting
                `CREATE INDEX IF NOT EXISTS idx_tokens_marketcap ON tokens (marketCap DESC NULLS LAST)`,
                // Composite index for verified + k_score (most common query pattern)
                `CREATE INDEX IF NOT EXISTS idx_tokens_verified_kscore ON tokens (hasCommunityUpdate, k_score DESC NULLS LAST) WHERE hasCommunityUpdate = TRUE`,
                // Index for pools by mint (frequent JOIN)
                `CREATE INDEX IF NOT EXISTS idx_pools_mint ON pools (mint)`,
                // Index for holder_snapshots queries
                `CREATE INDEX IF NOT EXISTS idx_holder_snapshots_mint_balance ON holder_snapshots (mint, balance DESC)`,
                // Index for wallet_tx_cache (cross-token reuse)
                `CREATE INDEX IF NOT EXISTS idx_wallet_tx_cache_wallet ON wallet_tx_cache (wallet, analyzed_at DESC)`,
                `CREATE INDEX IF NOT EXISTS idx_wallet_tx_cache_mint ON wallet_tx_cache (mint, wallet)`,
                // Index for k_score_history date range queries
                `CREATE INDEX IF NOT EXISTS idx_kscore_history_mint_date ON k_score_history (mint, date DESC)`,
                // ═══════════════════════════════════════════════════════════
                // HARMONY SYSTEM INDEXES
                // ═══════════════════════════════════════════════════════════
                // E-Score leaderboard queries (most common)
                `CREATE INDEX IF NOT EXISTS idx_participants_escore ON participants (e_score DESC NULLS LAST)`,
                // Contributions by wallet (for E-Score calculation)
                `CREATE INDEX IF NOT EXISTS idx_contributions_wallet ON contributions (wallet, created_at DESC)`,
                // Contributions by type (analytics)
                `CREATE INDEX IF NOT EXISTS idx_contributions_type ON contributions (type, created_at DESC)`,
                // Pending reward distributions
                `CREATE INDEX IF NOT EXISTS idx_reward_distributions_status ON reward_distributions (status) WHERE status = 'pending'`,
                // ═══════════════════════════════════════════════════════════
                // SPACE ACCESS SYSTEM INDEXES
                // ═══════════════════════════════════════════════════════════
                // Active grants lookup (most common)
                `CREATE INDEX IF NOT EXISTS idx_access_grants_active ON access_grants (is_active) WHERE is_active = TRUE`,
                // Session token lookup (for auth)
                `CREATE INDEX IF NOT EXISTS idx_wallet_sessions_token ON wallet_sessions (session_token)`,
                // Session expiry cleanup
                `CREATE INDEX IF NOT EXISTS idx_wallet_sessions_expires ON wallet_sessions (expires_at)`,
                // Space actions by wallet (for user history)
                `CREATE INDEX IF NOT EXISTS idx_space_actions_wallet ON space_actions (wallet, created_at DESC)`,
                // Space actions by action type (for analytics)
                `CREATE INDEX IF NOT EXISTS idx_space_actions_action ON space_actions (action, created_at DESC)`,
                // ═══════════════════════════════════════════════════════════
                // NODE NETWORK INDEXES
                // ═══════════════════════════════════════════════════════════
                // Active nodes lookup (for consensus)
                `CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes (status) WHERE status = 'active'`,
                // Heartbeat monitoring (for health checks)
                `CREATE INDEX IF NOT EXISTS idx_nodes_heartbeat ON nodes (last_heartbeat DESC)`,
                // Operator lookup (for E-Score integration)
                `CREATE INDEX IF NOT EXISTS idx_nodes_operator ON nodes (operator)`,
                // Token verifications by mint (for node count per token)
                `CREATE INDEX IF NOT EXISTS idx_token_verifications_mint ON token_verifications (mint, verified_at DESC)`,
                // Token verifications by node (for node stats)
                `CREATE INDEX IF NOT EXISTS idx_token_verifications_node ON token_verifications (node_id, verified_at DESC)`,
                // Node key fingerprint lookup (for signature verification)
                `CREATE INDEX IF NOT EXISTS idx_nodes_key_fingerprint ON nodes (node_key_fingerprint) WHERE node_key_fingerprint IS NOT NULL`,
                // ═══════════════════════════════════════════════════════════
                // WATCHLIST INDEXES
                // ═══════════════════════════════════════════════════════════
                // Watchlist by wallet (most common query)
                `CREATE INDEX IF NOT EXISTS idx_watchlist_wallet ON user_watchlists (wallet)`,
                // Watchlist by mint (for K-Score update broadcasts)
                `CREATE INDEX IF NOT EXISTS idx_watchlist_mint ON user_watchlists (mint)`,
                // Alert queries (for background worker)
                `CREATE INDEX IF NOT EXISTS idx_watchlist_alerts ON user_watchlists (alert_threshold) WHERE alert_threshold IS NOT NULL`,
                // ═══════════════════════════════════════════════════════════
                // SIGNAL ACCUMULATOR INDEXES (17-Dimension Pre-Judgment)
                // ═══════════════════════════════════════════════════════════
                `CREATE INDEX IF NOT EXISTS idx_signals_status ON token_signals(judgment_status)`,
                `CREATE INDEX IF NOT EXISTS idx_signals_pre_score ON token_signals(pre_score DESC)`,
                `CREATE INDEX IF NOT EXISTS idx_signals_first_seen ON token_signals(first_seen)`,
                `CREATE INDEX IF NOT EXISTS idx_signals_updated ON token_signals(updated_at DESC)`,
                `CREATE INDEX IF NOT EXISTS idx_signals_pending ON token_signals(pre_score DESC) WHERE judgment_status = 'pending'`,
                `CREATE INDEX IF NOT EXISTS idx_judgment_mint ON judgment_history(mint)`,
                `CREATE INDEX IF NOT EXISTS idx_judgment_action ON judgment_history(action)`,
                `CREATE INDEX IF NOT EXISTS idx_judgment_feedback ON judgment_history(was_correct) WHERE was_correct IS NOT NULL`,
            ];

            for (const sql of migrations) {
                try {
                    await primaryPool.query(sql);
                } catch (e) {
                    // Only ignore "column already exists" or "already type X" errors
                    // Log other errors to help debug migration issues
                    const msg = e.message || '';
                    const isExpected = msg.includes('already exists') ||
                                       msg.includes('already has type') ||
                                       msg.includes('does not exist');
                    if (!isExpected) {
                        logger.warn(`Migration warning: ${sql.slice(0, 60)}... - ${msg.slice(0, 80)}`);
                    }
                }
            }

            // Apply index migrations
            for (const sql of indexMigrations) {
                try {
                    await primaryPool.query(sql);
                } catch (e) {
                    // Index might already exist or column missing, ignore
                    logger.debug(`Index migration skipped: ${e.message?.slice(0, 50)}`);
                }
            }
            logger.info('💾 Database: Indexes verified');

            // Seed operation costs if empty (GASdf fee structure)
            // Based on φ-ratio efficiency floor: minFee = (cost / 0.236) × 1.2
            const existingCosts = await primaryPool.query('SELECT COUNT(*) as count FROM operation_costs');
            if (parseInt(existingCosts.rows[0].count) === 0) {
                const seedCosts = [
                    // operation_type, base_fee, actual_cost, min_fee, max_discount
                    ['gasdf_submit_standard', 100, 5, 25.42, 0.50],    // Standard submission
                    ['gasdf_submit_priority', 250, 15, 76.27, 0.40],   // Priority submission
                    ['gasdf_submit_instant', 500, 30, 152.54, 0.30],   // Instant submission
                    ['holdex_api_call', 1, 0.01, 0.05, 0.80],          // HolDex API call
                ];
                for (const [opType, baseFee, cost, minFee, maxDiscount] of seedCosts) {
                    await primaryPool.query(`
                        INSERT INTO operation_costs (operation_type, base_fee, actual_cost, min_fee, max_discount)
                        VALUES ($1, $2, $3, $4, $5)
                        ON CONFLICT (operation_type) DO NOTHING
                    `, [opType, baseFee, cost, minFee, maxDiscount]);
                }
                logger.info('⚗️ Harmony: Seeded operation costs (φ-ratio efficiency floor)');
            }

            // Seed judgment thresholds with φ-aligned defaults (17 dimensions)
            const existingThresholds = await primaryPool.query('SELECT COUNT(*) as count FROM judgment_thresholds');
            if (parseInt(existingThresholds.rows[0].count) === 0) {
                const PHI = 1.618033988749895;
                const seedThresholds = [
                    // dimension, threshold, weight, phi_default
                    // PRIMARY (φ² weight = 2.618)
                    ['truth', 70, PHI * PHI, 70],
                    ['relevance', 60, PHI * PHI, 60],
                    ['quality', 70, PHI * PHI, 70],
                    ['coherence', 75, PHI * PHI, 75],
                    ['progress', 50, PHI * PHI, 50],
                    ['ethics', 80, PHI * PHI * PHI, 80],  // φ³ for critical
                    ['harmony', 60, PHI * PHI, 60],
                    // SECONDARY (φ weight = 1.618)
                    ['security', 85, PHI, 85],
                    ['privacy', 90, PHI * PHI * PHI, 90],  // φ³ for critical
                    ['scalability', 50, PHI, 50],
                    ['simplicity', 60, PHI, 60],
                    ['autonomy', 40, PHI, 40],
                    // META (1.0 weight)
                    ['self_awareness', 50, 1.0, 50],
                    ['learning_rate', 50, 1.0, 50],
                    ['singularity', 30, 1.0, 30],
                    // DISTRIBUTED (φ weight = 1.618)
                    ['node_consensus', 60, PHI, 60],
                    ['signal_coverage', 50, PHI, 50]
                ];
                for (const [dim, threshold, weight, phiDefault] of seedThresholds) {
                    await primaryPool.query(`
                        INSERT INTO judgment_thresholds (dimension, threshold, weight, phi_default)
                        VALUES ($1, $2, $3, $4)
                        ON CONFLICT (dimension) DO NOTHING
                    `, [dim, threshold, weight, phiDefault]);
                }
                logger.info('📐 Signal Accumulator: Seeded 17-dimension φ-aligned thresholds');
            }

            // Clean up auto-generated nodes with unknown operators
            // First delete associated verifications to avoid foreign key constraint violations
            await primaryPool.query(`
                DELETE FROM token_verifications
                WHERE node_id IN (
                    SELECT node_id FROM nodes
                    WHERE operator = 'unknown'
                       OR node_id LIKE 'node-srv-%'
                )
            `);
            const cleanupResult = await primaryPool.query(`
                DELETE FROM nodes
                WHERE operator = 'unknown'
                   OR node_id LIKE 'node-srv-%'
                RETURNING node_id
            `);
            if (cleanupResult.rows.length > 0) {
                logger.info(`🧹 Network: Cleaned up ${cleanupResult.rows.length} orphan node(s)`);
            }

            // Ensure founding nodes exist (DO NOTHING if exists - initializeNode() will sign them)
            // IMPORTANT: Using DO NOTHING to avoid race condition with initializeNode() signatures
            // NOTE: Only seed nodes that have active services - inactive nodes will be unsigned and deleted
            const foundingNodes = [
                ['node-zeyxx-001', 'jeanterre552-primary', 'jeanterre552', 'https://holdex-api.onrender.com', 'us-oregon']
                // gcrtrd-001 removed - service not active, would be deleted as unsigned
            ];
            const now = Date.now();
            let nodesSeeded = 0;
            for (const [nodeId, name, operator, apiUrl, region] of foundingNodes) {
                const result = await primaryPool.query(`
                    INSERT INTO nodes (node_id, name, operator, api_url, region, status, joined_at, updated_at)
                    VALUES ($1, $2, $3, $4, $5, 'pending', $6, $6)
                    ON CONFLICT (node_id) DO NOTHING
                    RETURNING node_id
                `, [nodeId, name, operator, apiUrl, region, now]);
                if (result.rows.length > 0) nodesSeeded++;
            }
            if (nodesSeeded > 0) {
                logger.info(`🌐 Network: Registered ${nodesSeeded} founding node(s)`);
            }

            logger.info('⚗️ Harmony: E-Score tables ready (φ = 1.618)');

            dbWrapper = {
                query: (text, params) => (text.trim().toUpperCase().startsWith('SELECT') ? readPool : primaryPool).query(text, params),
                get: async (text, params) => { const res = await readPool.query(text, params); return res.rows[0]; },
                all: async (text, params) => { const res = await readPool.query(text, params); return res.rows; },
                // FIX: Return first row if RETURNING clause is used, otherwise return rowCount
                run: async (text, params) => {
                    const res = await primaryPool.query(text, params);
                    return res.rows && res.rows.length > 0 ? res.rows[0] : { rowCount: res.rowCount };
                },
                // Get raw client for transactions (caller must release)
                getClient: async () => primaryPool.connect(),
            };

            return dbWrapper;

        } catch (error) {
            logger.error(`Database Init Failed: ${error.message}`);
            initPromise = null;
            throw error;
        }
    })();

    return initPromise;
}

function getDB() { if (!dbWrapper) throw new Error("Database not initialized."); return dbWrapper; }

async function smartCache(key, ttlSeconds, fetchFn) {
    const redis = getClient();
    if (redis) { try { const cached = await redis.get(key); if (cached) return JSON.parse(cached); } catch (_e) { /* ignore */ } }
    if (pendingRequests.has(key)) return pendingRequests.get(key);
    const fetchPromise = (async () => {
        try { const data = await fetchFn(); if (redis && data) redis.set(key, JSON.stringify(data), 'EX', ttlSeconds).catch(() => {}); return data; } finally { pendingRequests.delete(key); }
    })();
    pendingRequests.set(key, fetchPromise);
    return fetchPromise;
}

async function enableIndexing(db, mint, poolData) {
    if (!poolData || !poolData.pairAddress) return;
    try {
        // Only update pool data if we have valid (non-zero) values, otherwise preserve existing
        // FIX: Explicit type casts to DOUBLE PRECISION to avoid "invalid input syntax for type integer" errors
        await db.run(`
            INSERT INTO pools (
                address, mint, dex, price_usd, liquidity_usd, volume_24h, created_at, token_a, token_b, reserve_a, reserve_b
            ) VALUES ($1, $2, $3, $4::DOUBLE PRECISION, $5::DOUBLE PRECISION, $6::DOUBLE PRECISION, $7, $8, $9, $10, $11)
            ON CONFLICT(address) DO UPDATE SET
                price_usd = CASE WHEN EXCLUDED.price_usd > 0 THEN EXCLUDED.price_usd ELSE pools.price_usd END,
                liquidity_usd = CASE WHEN EXCLUDED.liquidity_usd > 0 THEN EXCLUDED.liquidity_usd ELSE pools.liquidity_usd END,
                volume_24h = CASE WHEN EXCLUDED.volume_24h > 0 THEN EXCLUDED.volume_24h ELSE pools.volume_24h END,
                reserve_a = COALESCE(EXCLUDED.reserve_a, pools.reserve_a),
                reserve_b = COALESCE(EXCLUDED.reserve_b, pools.reserve_b)
        `, [
            poolData.pairAddress, mint, poolData.dexId,
            // FIX: Ensure price is a proper float (might come as string from APIs)
            parseFloat(poolData.priceUsd) || 0,
            Math.floor(parseFloat(poolData.liquidity?.usd) || 0),
            Math.floor(parseFloat(poolData.volume?.h24) || 0), Date.now(),
            // Handle both object format ({address: "..."}) and string format for token addresses
            typeof poolData.baseToken === 'object' ? poolData.baseToken?.address : poolData.baseToken,
            typeof poolData.quoteToken === 'object' ? poolData.quoteToken?.address : poolData.quoteToken,
            poolData.reserve_a || null, poolData.reserve_b || null
        ]);
        await db.run(`INSERT INTO active_trackers (pool_address, priority, last_check) VALUES ($1, 10, 0) ON CONFLICT(pool_address) DO NOTHING`, [poolData.pairAddress]);
    } catch (err) {
        // Log foreign key errors - these indicate token wasn't created first
        if (err.message && err.message.includes('foreign key')) {
            logger.error(`[enableIndexing] Foreign key error for ${mint.slice(0,8)}: Token must exist before adding pools`);
        } else {
            logger.warn(`[enableIndexing] Pool insert failed for ${mint.slice(0,8)}: ${err.message}`);
        }
    }
}

async function aggregateAndSaveToken(db, mint) {
    try {
        const pools = await db.all(`SELECT * FROM pools WHERE mint = $1`, [mint]);
        if (pools.length === 0) return;

        let totalLiq = 0; let totalVol = 0; let mainPool = pools[0]; 
        for (const p of pools) {
            const liq = parseFloat(p.liquidity_usd || 0);
            totalLiq += liq;
            totalVol += parseFloat(p.volume_24h || 0);
            if (liq > parseFloat(mainPool.liquidity_usd || 0)) mainPool = p;
        }

        const price = parseFloat(mainPool.price_usd || 0);
        let change24h = null, change1h = null, change5m = null;

        if (price > 0) {
            const getPriceAt = async (ts) => {
                const row = await db.get(`SELECT close FROM candles_1m WHERE pool_address = $1 AND timestamp <= $2 ORDER BY timestamp DESC LIMIT 1`, [mainPool.address, ts]);
                return row ? parseFloat(row.close) : null;
            };
            const now = Date.now();
            const [p24h, p1h, p5m] = await Promise.all([ getPriceAt(now - 86400000), getPriceAt(now - 3600000), getPriceAt(now - 300000) ]);
            if (p24h) change24h = ((price - p24h) / p24h) * 100;
            if (p1h) change1h = ((price - p1h) / p1h) * 100;
            if (p5m) change5m = ((price - p5m) / p5m) * 100;
        }

        // --- HOLDER CHECK LOGIC ---
        const now = Date.now();
        const tokenRow = await db.get(`SELECT last_holder_check, holders FROM tokens WHERE mint = $1`, [mint]);
        const lastCheck = parseInt(tokenRow?.last_holder_check || 0);
        
        let holderCount = null;
        // Check holders every 30 minutes (with 30s timeout to not block)
        if (now - lastCheck > 1800000) {
            try {
                // Fetch from RPC with timeout
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Holder count timeout')), 30000)
                );
                const count = await Promise.race([
                    getHolderCountFromRPC(mint),
                    timeoutPromise
                ]);
                if (typeof count === 'number' && count > 0) {
                    holderCount = count;
                    // Save history (Snapshot normalized to start of day)
                    const today = Math.floor(now / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
                    
                    await db.run(`
                        INSERT INTO holders_history (mint, count, timestamp)
                        VALUES ($1, $2::INTEGER, $3)
                        ON CONFLICT (mint, timestamp) DO UPDATE SET count = EXCLUDED.count::INTEGER
                    `, [mint, Math.floor(holderCount), today]);
                }
            } catch (e) {
                logger.warn(`Holder check failed for ${mint}: ${e.message}`);
            }
        }

        // Build Update Query
        // FIX: Removed `timestamp` column update to preserve original creation time.
        // FIX: Added `updated_at = NOW()` to track recent updates properly.
        // FIX: Only update liquidity/volume/price if we have valid data (> 0), otherwise preserve existing
        // FIX: Ensure all numeric values are properly typed to avoid integer overflow errors
        // FIX: Validate all numeric values are finite to prevent PostgreSQL type errors
        // FIX: Use Math.floor() for liquidity/volume/marketCap to avoid decimal precision issues (only price keeps decimals)
        const safeTotalLiq = Number.isFinite(totalLiq) ? Math.floor(totalLiq) : 0;
        const safeTotalVol = Number.isFinite(totalVol) ? Math.floor(totalVol) : 0;
        const safePrice = Number.isFinite(price) ? price : 0;  // Keep decimals for price
        const params = [safeTotalLiq, safeTotalVol, safePrice, mint];
        let query = `UPDATE tokens SET
            liquidity = CASE WHEN $1 > 0 THEN FLOOR($1)::DOUBLE PRECISION ELSE liquidity END,
            volume24h = CASE WHEN $2 > 0 THEN FLOOR($2)::DOUBLE PRECISION ELSE volume24h END,
            priceUsd = CASE WHEN $3 > 0 THEN $3::DOUBLE PRECISION ELSE priceUsd END,
            updated_at = NOW(),
            marketCap = CASE WHEN $3 > 0 THEN FLOOR($3::DOUBLE PRECISION * CAST(supply AS DOUBLE PRECISION) / POWER(10, COALESCE(decimals, 9)))::DOUBLE PRECISION ELSE marketCap END`;

        let idx = 5; // Start at 5 since we use $1-$4 above
        if (change24h !== null) { query += `, change24h = $${idx++}::DOUBLE PRECISION`; params.push(Number.isFinite(change24h) ? change24h : 0); }
        if (change1h !== null) { query += `, change1h = $${idx++}::DOUBLE PRECISION`; params.push(Number.isFinite(change1h) ? change1h : 0); }
        if (change5m !== null) { query += `, change5m = $${idx++}::DOUBLE PRECISION`; params.push(Number.isFinite(change5m) ? change5m : 0); }
        if (holderCount !== null && Number.isFinite(holderCount)) { query += `, holders = $${idx++}::INTEGER, last_holder_check = $${idx++}::BIGINT`; params.push(Math.floor(holderCount)); params.push(now); }

        // Include kscore fields in RETURNING if holders were updated (needed for sig_kscore)
        // Cast conviction_score to DOUBLE PRECISION in case column is still INTEGER
        query += ` WHERE mint = $4 RETURNING mint, priceusd, marketcap, liquidity, price_source, price_timestamp, price_pool, liquidity_source, liquidity_timestamp, mcap_calculated, holders_source, holders_timestamp, age_days, k_score, CAST(conviction_score AS DOUBLE PRECISION) as conviction_score, conviction_accumulators, conviction_holders, conviction_reducers, conviction_extractors, conviction_analyzed, holders, last_k_score_update`;

        const result = await db.get(query, params);

        // Re-sign market data to maintain integrity
        if (result) {
            const sig_market = signMarket(result);

            // FIX: If holders were updated, also re-sign sig_kscore (holders is part of the kscore signature)
            if (holderCount !== null) {
                const sig_kscore = signKScore(result);
                await db.run(`UPDATE tokens SET sig_market = $1, sig_kscore = $2 WHERE mint = $3`, [sig_market, sig_kscore, mint]);
            } else {
                await db.run(`UPDATE tokens SET sig_market = $1 WHERE mint = $2`, [sig_market, mint]);
            }
        }

    } catch (err) {
        logger.error(`Aggregation Error ${mint}: ${err.message}`);
        logger.error(`Aggregation Error Stack: ${err.stack}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WATCHLIST FUNCTIONS (Consumer Journey Stage 4: Investment)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get user's watchlist with current K-Scores
 * @param {string} wallet - Wallet address
 * @returns {Promise<Array>} Watchlist items with token details
 */
async function getWatchlist(wallet) {
    const db = getDB();
    if (!db) return [];

    const rows = await db.all(`
        SELECT w.*,
               t.name, t.symbol, t.k_score, t.tier, t.image as logo_uri,
               t.priceusd, t.marketcap, t.change24h
        FROM user_watchlists w
        LEFT JOIN tokens t ON w.mint = t.mint
        WHERE w.wallet = $1
        ORDER BY w.added_at DESC
    `, [wallet]);

    return rows.map(r => ({
        mint: r.mint,
        label: r.label,
        added_at: r.added_at,
        alert_threshold: r.alert_threshold,
        alert_direction: r.alert_direction,
        last_notified_at: r.last_notified_at,
        token: r.name ? {
            name: r.name,
            symbol: r.symbol,
            k_score: r.k_score,
            tier: r.tier,
            logo_uri: r.logo_uri,
            price_usd: r.priceusd,
            market_cap: r.marketcap,
            change_24h: r.change24h
        } : null
    }));
}

/**
 * Add token to watchlist
 * @param {string} wallet - Wallet address
 * @param {string} mint - Token mint address
 * @param {string|null} label - Optional label
 * @param {number|null} alertThreshold - K-Score threshold for alerts
 * @param {string} alertDirection - 'below' or 'above'
 * @returns {Promise<boolean>} Success
 */
async function addToWatchlist(wallet, mint, label = null, alertThreshold = null, alertDirection = 'below') {
    const db = getDB();
    if (!db) return false;

    try {
        // Check watchlist limit (50 tokens max)
        const count = await db.get('SELECT COUNT(*) as count FROM user_watchlists WHERE wallet = $1', [wallet]);
        if (count.count >= 50) {
            throw new Error('Watchlist limit reached (50 tokens)');
        }

        await db.run(`
            INSERT INTO user_watchlists (wallet, mint, label, alert_threshold, alert_direction, added_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT(wallet, mint) DO UPDATE SET
                label = COALESCE(EXCLUDED.label, user_watchlists.label),
                alert_threshold = EXCLUDED.alert_threshold,
                alert_direction = EXCLUDED.alert_direction
        `, [wallet, mint, label, alertThreshold, alertDirection, Date.now()]);

        return true;
    } catch (e) {
        logger.error(`[Watchlist] Add failed for ${wallet.slice(0,8)}: ${e.message}`);
        return false;
    }
}

/**
 * Remove token from watchlist
 * @param {string} wallet - Wallet address
 * @param {string} mint - Token mint address
 * @returns {Promise<boolean>} Success
 */
async function removeFromWatchlist(wallet, mint) {
    const db = getDB();
    if (!db) return false;

    try {
        await db.run('DELETE FROM user_watchlists WHERE wallet = $1 AND mint = $2', [wallet, mint]);
        return true;
    } catch (e) {
        logger.error(`[Watchlist] Remove failed: ${e.message}`);
        return false;
    }
}

/**
 * Update watchlist item
 * @param {string} wallet - Wallet address
 * @param {string} mint - Token mint address
 * @param {Object} updates - Fields to update (label, alert_threshold, alert_direction)
 * @returns {Promise<boolean>} Success
 */
async function updateWatchlistItem(wallet, mint, updates) {
    const db = getDB();
    if (!db) return false;

    const fields = [];
    const values = [];
    let idx = 1;

    if (updates.label !== undefined) { fields.push(`label = $${idx++}`); values.push(updates.label); }
    if (updates.alert_threshold !== undefined) { fields.push(`alert_threshold = $${idx++}`); values.push(updates.alert_threshold); }
    if (updates.alert_direction !== undefined) { fields.push(`alert_direction = $${idx++}`); values.push(updates.alert_direction); }

    if (fields.length === 0) return true;

    values.push(wallet, mint);

    try {
        await db.run(`UPDATE user_watchlists SET ${fields.join(', ')} WHERE wallet = $${idx++} AND mint = $${idx}`, values);
        return true;
    } catch (e) {
        logger.error(`[Watchlist] Update failed: ${e.message}`);
        return false;
    }
}

/**
 * Get all watchlist items with pending alerts (for background worker)
 * @returns {Promise<Array>} Items where K-Score crossed threshold
 */
async function getWatchlistAlerts() {
    const db = getDB();
    if (!db) return [];

    return db.all(`
        SELECT w.*, t.k_score, t.name, t.symbol
        FROM user_watchlists w
        JOIN tokens t ON w.mint = t.mint
        WHERE w.alert_threshold IS NOT NULL
        AND (
            (w.alert_direction = 'below' AND t.k_score < w.alert_threshold)
            OR
            (w.alert_direction = 'above' AND t.k_score > w.alert_threshold)
        )
        AND (w.last_notified_at IS NULL OR w.last_notified_at < $1)
    `, [Date.now() - 24 * 60 * 60 * 1000]); // Only alert once per 24 hours
}

/**
 * Mark watchlist alert as notified
 * @param {number} id - Watchlist item ID
 * @returns {Promise<void>}
 */
async function markWatchlistAlertNotified(id) {
    const db = getDB();
    if (!db) return;

    await db.run('UPDATE user_watchlists SET last_notified_at = $1 WHERE id = $2', [Date.now(), id]);
}

// ════════════════════════════════════════════════════════════════════════════
// REDIS-CACHED TOKEN EXISTENCE CHECKS
// Reduces DB load during high webhook volume by caching known mints in Redis
// ════════════════════════════════════════════════════════════════════════════

const KNOWN_MINTS_KEY = 'holdex:known_mints';
const UNKNOWN_MINTS_KEY = 'holdex:unknown_mints'; // Negative cache to avoid repeated DB misses
const UNKNOWN_MINT_TTL = 300; // 5 minutes TTL for negative cache

/**
 * Check if a token exists - Redis-first, DB fallback
 * @param {string} mint - Token mint address
 * @returns {Promise<boolean>} - true if token exists
 */
async function tokenExists(mint) {
    const redis = getClient();

    // Redis-first: Check positive cache
    if (redis) {
        try {
            const inCache = await redis.sismember(KNOWN_MINTS_KEY, mint);
            if (inCache) return true;

            // Check negative cache (recently checked, not found)
            const inNegativeCache = await redis.sismember(UNKNOWN_MINTS_KEY, mint);
            if (inNegativeCache) return false;
        } catch (_e) {
            // Redis error - fall through to DB
        }
    }

    // DB fallback
    const db = getDB();
    if (!db) return false;

    try {
        const result = await db.get('SELECT mint FROM tokens WHERE mint = $1', [mint]);
        const exists = !!result;

        // Cache the result in Redis
        if (redis) {
            if (exists) {
                redis.sadd(KNOWN_MINTS_KEY, mint).catch(() => {});
            } else {
                // Negative cache with TTL to avoid repeated misses
                redis.sadd(UNKNOWN_MINTS_KEY, mint).catch(() => {});
                redis.expire(UNKNOWN_MINTS_KEY, UNKNOWN_MINT_TTL).catch(() => {});
            }
        }

        return exists;
    } catch (_e) {
        // DB error - assume doesn't exist to allow retry
        return false;
    }
}

/**
 * Add a token to the known mints cache (call after successful insert)
 * @param {string} mint - Token mint address
 */
async function cacheKnownToken(mint) {
    const redis = getClient();
    if (!redis) return;

    try {
        await redis.sadd(KNOWN_MINTS_KEY, mint);
        // Remove from negative cache if present
        await redis.srem(UNKNOWN_MINTS_KEY, mint);
    } catch (_e) {
        // Ignore Redis errors - cache is optional
    }
}

/**
 * Bulk add tokens to known mints cache
 * @param {string[]} mints - Array of token mint addresses
 */
async function cacheKnownTokens(mints) {
    const redis = getClient();
    if (!redis || mints.length === 0) return;

    try {
        await redis.sadd(KNOWN_MINTS_KEY, ...mints);
        // Remove from negative cache
        await redis.srem(UNKNOWN_MINTS_KEY, ...mints);
    } catch (_e) {
        // Ignore Redis errors
    }
}

/**
 * Preload known mints cache from DB (call on startup)
 * @returns {Promise<number>} - Number of mints cached
 */
async function preloadKnownMintsCache() {
    const db = getDB();
    const redis = getClient();
    if (!db || !redis) return 0;

    try {
        const mints = await db.all('SELECT mint FROM tokens');
        if (mints.length > 0) {
            const mintAddresses = mints.map(m => m.mint);
            // Batch add in chunks of 1000 to avoid Redis command limits
            for (let i = 0; i < mintAddresses.length; i += 1000) {
                const chunk = mintAddresses.slice(i, i + 1000);
                await redis.sadd(KNOWN_MINTS_KEY, ...chunk);
            }
            logger.info(`🚀 Preloaded ${mints.length} known mints to Redis cache`);
        }
        return mints.length;
    } catch (e) {
        logger.warn(`⚠️ Failed to preload known mints cache: ${e.message}`);
        return 0;
    }
}

module.exports = {
    initDB,
    getDB,
    smartCache,
    enableIndexing,
    aggregateAndSaveToken,
    // Watchlist functions
    getWatchlist,
    addToWatchlist,
    removeFromWatchlist,
    updateWatchlistItem,
    getWatchlistAlerts,
    markWatchlistAlertNotified,
    // Redis-cached token existence
    tokenExists,
    cacheKnownToken,
    cacheKnownTokens,
    preloadKnownMintsCache
};
