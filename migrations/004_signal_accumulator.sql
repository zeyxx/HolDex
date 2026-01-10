-- ═══════════════════════════════════════════════════════════════════════════
-- SIGNAL ACCUMULATOR - Persistent Pre-Judgment Data
-- ═══════════════════════════════════════════════════════════════════════════
--
-- φ-aligned signal accumulation for 15-dimension token pre-judgment.
-- Persists webhook signals to survive Redis restarts.
-- Privacy: wallet addresses are hashed (SHA256).
--
-- Architecture:
--   Redis (hot)  ←→  PostgreSQL (cold)
--   Fast lookups     Persistence + Recovery
-- ═══════════════════════════════════════════════════════════════════════════

-- Token signals accumulator
CREATE TABLE IF NOT EXISTS token_signals (
    mint                TEXT PRIMARY KEY,

    -- Signal counts
    swap_count          INTEGER DEFAULT 0,
    transfer_count      INTEGER DEFAULT 0,

    -- Unique wallets (hashed, stored as JSONB array)
    unique_wallets      JSONB DEFAULT '[]'::jsonb,
    unique_wallet_count INTEGER DEFAULT 0,

    -- Time spread (for bot detection)
    first_seen          BIGINT NOT NULL,
    last_seen           BIGINT NOT NULL,

    -- Amount analysis (for wash trading detection)
    amounts             JSONB DEFAULT '[]'::jsonb,
    amount_variance     REAL DEFAULT 0,

    -- Sources (Pump.fun, Raydium, etc.)
    sources             JSONB DEFAULT '[]'::jsonb,

    -- Wallet E-Score integration (from GASdf)
    wallet_e_scores     JSONB DEFAULT '[]'::jsonb,
    avg_wallet_e_score  REAL DEFAULT 0,

    -- Pre-judgment result
    pre_score           REAL DEFAULT 0,
    judgment_status     TEXT DEFAULT 'pending',  -- pending, accepted, rejected, expired
    judgment_reason     TEXT,
    judgment_at         BIGINT,

    -- Dimension scores (cached for analysis)
    dimension_scores    JSONB DEFAULT '{}'::jsonb,

    -- Multi-node tracking (distributed consensus)
    node_signals        JSONB DEFAULT '{}'::jsonb,  -- { node_id: { count, first_seen, last_seen } }
    nodes_seen          JSONB DEFAULT '[]'::jsonb,   -- List of node IDs that contributed

    -- Metadata
    created_at          BIGINT NOT NULL,
    updated_at          BIGINT NOT NULL,

    -- Promotion tracking
    promoted_at         BIGINT,
    promoted_reason     TEXT
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_signals_status ON token_signals(judgment_status);
CREATE INDEX IF NOT EXISTS idx_signals_pre_score ON token_signals(pre_score DESC);
CREATE INDEX IF NOT EXISTS idx_signals_first_seen ON token_signals(first_seen);
CREATE INDEX IF NOT EXISTS idx_signals_updated ON token_signals(updated_at DESC);

-- Partial index for pending signals (most queried)
CREATE INDEX IF NOT EXISTS idx_signals_pending
    ON token_signals(pre_score DESC)
    WHERE judgment_status = 'pending';

-- ═══════════════════════════════════════════════════════════════════════════
-- JUDGMENT HISTORY - Provenance for all decisions
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS judgment_history (
    id                  SERIAL PRIMARY KEY,
    mint                TEXT NOT NULL,

    -- Judgment details
    action              TEXT NOT NULL,  -- ACCEPT, REJECT, PENDING, EXPIRE
    pre_score           REAL NOT NULL,
    dimension_scores    JSONB NOT NULL,

    -- Context at time of judgment
    signal_snapshot     JSONB NOT NULL,

    -- Merkle provenance
    content_hash        TEXT,
    merkle_proof        JSONB,

    -- Feedback (filled later when ground truth known)
    was_correct         BOOLEAN,
    k_score_outcome     REAL,
    feedback_at         BIGINT,

    created_at          BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_judgment_mint ON judgment_history(mint);
CREATE INDEX IF NOT EXISTS idx_judgment_action ON judgment_history(action);
CREATE INDEX IF NOT EXISTS idx_judgment_feedback ON judgment_history(was_correct) WHERE was_correct IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- THRESHOLD TUNING - Self-optimizing φ thresholds
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS judgment_thresholds (
    dimension           TEXT PRIMARY KEY,

    -- Current threshold
    threshold           REAL NOT NULL,
    weight              REAL NOT NULL,

    -- φ-based defaults
    phi_default         REAL NOT NULL,

    -- Auto-tuning history
    adjustments         JSONB DEFAULT '[]'::jsonb,
    last_tuned          BIGINT,

    -- Performance metrics
    true_positives      INTEGER DEFAULT 0,
    false_positives     INTEGER DEFAULT 0,
    true_negatives      INTEGER DEFAULT 0,
    false_negatives     INTEGER DEFAULT 0
);

-- Seed with φ-aligned defaults
INSERT INTO judgment_thresholds (dimension, threshold, weight, phi_default) VALUES
    -- PRIMARY (φ² weight = 2.618)
    ('truth',      70, 2.618, 70),
    ('relevance',  60, 2.618, 60),
    ('quality',    70, 2.618, 70),
    ('coherence',  75, 2.618, 75),
    ('progress',   50, 2.618, 50),
    ('ethics',     80, 4.236, 80),  -- φ³ for critical
    ('harmony',    60, 2.618, 60),
    -- SECONDARY (φ weight = 1.618)
    ('security',   85, 1.618, 85),
    ('privacy',    90, 4.236, 90),  -- φ³ for critical
    ('scalability', 50, 1.618, 50),
    ('simplicity', 60, 1.618, 60),
    ('autonomy',   40, 1.618, 40),
    -- META (1.0 weight)
    ('self_awareness', 50, 1.0, 50),
    ('learning_rate',  50, 1.0, 50),
    ('singularity',    30, 1.0, 30),
    -- DISTRIBUTED (φ weight = 1.618) - Multi-node consensus
    ('node_consensus', 60, 1.618, 60),
    ('signal_coverage', 50, 1.618, 50)
ON CONFLICT (dimension) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════════
-- COMMENTS
-- ═══════════════════════════════════════════════════════════════════════════

COMMENT ON TABLE token_signals IS 'Accumulated webhook signals for token pre-judgment. Privacy: wallets are hashed.';
COMMENT ON TABLE judgment_history IS 'Immutable log of all pre-judgment decisions for provenance and learning.';
COMMENT ON TABLE judgment_thresholds IS 'φ-aligned thresholds that self-optimize based on feedback loop.';

COMMENT ON COLUMN token_signals.unique_wallets IS 'SHA256 hashes of wallet addresses, never cleartext';
COMMENT ON COLUMN token_signals.dimension_scores IS 'Cached 17-dimension scores (15 + 2 distributed): {truth: 85, nodeConsensus: 100, ...}';
COMMENT ON COLUMN token_signals.node_signals IS 'Multi-node signal contributions: { node_id: { count, first_seen, last_seen } }';
COMMENT ON COLUMN token_signals.nodes_seen IS 'List of node IDs that contributed signals for distributed consensus';
COMMENT ON COLUMN judgment_history.was_correct IS 'Filled by feedback loop: K-Score outcome validates prediction';
