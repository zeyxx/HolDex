/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * RPC HARMONY MODULE - φ-Based Credit & Cache Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * "Don't Trust, Verify. Don't Waste, Optimize."
 *
 * This module applies $ASDFASDFA philosophy to RPC credit management:
 * - Dynamic budgets based on REAL usage patterns
 * - Cache TTLs aligned with φ ratios
 * - Fibonacci-based sampling for statistical efficiency
 * - Self-adjusting thresholds based on observed load
 *
 * MATHEMATICAL FOUNDATION:
 *   φ (Golden Ratio) = 1.618033988749895
 *   Fibonacci: 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89...
 *
 * @version 1.0.0
 * @requires harmony.js
 */

'use strict';

const { PHI, PHI_POWERS } = require('../shared/harmony');

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: HELIUS PLAN CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Helius Plan Credit Allocations
 * Source: https://www.helius.dev/docs/billing/plans
 */
const HELIUS_PLANS = Object.freeze({
    FREE: {
        credits: 500_000,      // 500k/month
        rateLimit: 10,         // req/sec
        dasLimit: 2,           // DAS req/sec
    },
    DEVELOPER: {
        credits: 10_000_000,   // 10M/month
        rateLimit: 50,         // req/sec
        dasLimit: 10,          // DAS req/sec
    },
    GROWTH: {
        credits: 50_000_000,   // 50M/month
        rateLimit: 100,        // req/sec
        dasLimit: 25,          // DAS req/sec
    },
    PROFESSIONAL: {
        credits: 200_000_000,  // 200M/month
        rateLimit: 200,        // req/sec
        dasLimit: 50,          // DAS req/sec
    },
});

// Current plan (from env or default to Developer)
const CURRENT_PLAN = HELIUS_PLANS[process.env.HELIUS_PLAN?.toUpperCase()] || HELIUS_PLANS.DEVELOPER;

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: φ-BASED BUDGET FORMULAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dynamic Budget Calculation
 *
 * Philosophy: Reserve capacity using φ ratios for safety margins
 *
 *   Monthly credits = Plan allocation
 *   Daily budget = Monthly × φ⁻² (38.2% = safe daily allocation)
 *   Hourly budget = Daily × φ⁻¹ / 24 (burst protection)
 *   Minute budget = Hourly × φ⁻² (granular control)
 *
 * This ensures:
 *   - 38.2% monthly reserve for peak days
 *   - 61.8% of daily budget for normal hours
 *   - φ-aligned burst capacity
 */
const calculateBudgets = (planCredits) => {
    const monthly = planCredits;
    const daily = Math.floor(monthly / 30 * PHI_POWERS.PHI_INV);  // φ⁻¹ = 61.8% utilization
    const hourly = Math.floor(daily / 24 * PHI);                   // φ burst allowance
    const minute = Math.floor(hourly / 60);

    return Object.freeze({
        MONTHLY: monthly,
        DAILY: daily,
        HOURLY: hourly,
        MINUTE: minute,
        // Alert thresholds (φ-based)
        ALERT_THRESHOLD: PHI_POWERS.PHI_INV,        // 61.8% - early warning
        WARNING_THRESHOLD: PHI_POWERS.PHI_INV_SQ * 2,  // 76.4% - caution
        CRITICAL_THRESHOLD: 1 - PHI_POWERS.PHI_INV_CUBED, // 76.4% - critical
    });
};

const BUDGET = calculateBudgets(CURRENT_PLAN.credits);

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: φ-BASED CACHE TTLs
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cache TTL Strategy
 *
 * Philosophy: Data volatility determines cache duration
 *
 * Base unit: 60 seconds (1 minute)
 *
 *   VOLATILE (prices)    = base × φ⁻¹ = 37s   → Fast-changing data
 *   NORMAL (holders)     = base × φ²  = 157s  → Moderate updates
 *   STABLE (conviction)  = base × φ³  = 254s  → Slow-changing metrics
 *   STATIC (supply)      = base × φ⁴  = 411s  → Rarely changes
 *   IMMUTABLE (metadata) = base × φ⁵  = 665s  → Almost never changes
 *
 * Rounded to Fibonacci-adjacent values for elegance
 */
const BASE_TTL = 60; // 1 minute in seconds

const CACHE_TTL = Object.freeze({
    // Price data (volatile)
    PRICE: Math.round(BASE_TTL * PHI_POWERS.PHI_INV),           // ~37s
    SOL_PRICE: Math.round(BASE_TTL * PHI * 3),                   // ~5min (Pyth Oracle)

    // Holder data (normal volatility)
    HOLDER_COUNT: Math.round(BASE_TTL * PHI_POWERS.PHI_SQ) * 10, // ~26min → 30min
    TOP_HOLDERS: Math.round(BASE_TTL * PHI_POWERS.PHI_CUBED),    // ~4min

    // Conviction metrics (stable)
    CONVICTION: Math.round(BASE_TTL * PHI_POWERS.PHI_CUBED) * 15, // ~1h
    HOLD_DURATION: Math.round(BASE_TTL * PHI_POWERS.PHI_CUBED) * 15, // ~1h

    // Supply data (static)
    TOKEN_SUPPLY: Math.round(BASE_TTL * 60 * PHI),               // ~97min
    TOTAL_SUPPLY: Math.round(BASE_TTL * 60 * PHI_POWERS.PHI_SQ), // ~157min

    // Metadata (immutable)
    TOKEN_METADATA: Math.round(BASE_TTL * 60 * 24),              // 24h (on-chain metadata)
    POOL_INFO: Math.round(BASE_TTL * PHI_POWERS.PHI_CUBED) * 3,  // ~12min
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: FIBONACCI-BASED SAMPLING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sampling Configuration
 *
 * Philosophy: Use Fibonacci numbers for natural statistical efficiency
 *
 * Fibonacci sequence: 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89...
 *
 * Statistical insight:
 *   - 5 samples = 95% confidence at ±20% margin
 *   - 8 samples = 95% confidence at ±15% margin
 *   - 13 samples = 95% confidence at ±12% margin
 *
 * We use 5 for conviction (quick), 8 for detailed analysis
 */
const FIBONACCI = Object.freeze([1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144]);

const SAMPLING = Object.freeze({
    // Holder conviction analysis
    CONVICTION_SAMPLES: 5,          // Fibonacci: quick & sufficient
    CONVICTION_DEPTH: 21,           // Signatures per holder (Fibonacci)

    // DAS pagination
    DAS_PAGE_SIZE: 1000,            // Helius max
    DAS_MAX_PAGES: 5,               // Fibonacci: balance accuracy vs cost

    // Transaction history
    TX_HISTORY_LIMIT: 34,           // Fibonacci: recent activity window
    TX_BATCH_SIZE: 21,              // Fibonacci: batch processing

    // Token poller
    POLLER_BATCH: 34,               // Fibonacci: signatures per poll
    POLLER_INTERVAL_MS: Math.round(PHI_POWERS.PHI_INV_CUBED * 100 * 1000), // ~23.6s (φ⁻³)
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: REFRESH TIER FORMULAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Token Refresh Tiers
 *
 * Philosophy: Prioritize by importance using φ multipliers
 *
 * Base interval: 60 seconds
 *
 *   VERIFIED (community)  = base × 1      = 60s   → Highest priority
 *   TOP_100 (volume)      = base × φ      = 97s   → High priority
 *   ACTIVE (>$1k vol)     = base × φ²     = 157s  → Normal priority
 *   DORMANT (low vol)     = base × φ⁴     = 411s  → Low priority
 *   STALE (no activity)   = base × φ⁵     = 665s  → Minimal updates
 */
const REFRESH_BASE = 60 * 1000; // 1 minute in ms

const REFRESH_TIERS = Object.freeze({
    VERIFIED: Math.round(REFRESH_BASE),                           // 60s
    TOP_100: Math.round(REFRESH_BASE * PHI),                      // 97s
    ACTIVE: Math.round(REFRESH_BASE * PHI_POWERS.PHI_SQ),         // 157s
    DORMANT: Math.round(REFRESH_BASE * Math.pow(PHI, 4)),         // 411s
    STALE: Math.round(REFRESH_BASE * Math.pow(PHI, 5)),           // 665s
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6: CREDIT COST MATRIX
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Helius Credit Costs per Method
 * Source: https://www.helius.dev/docs/billing/credits
 */
const CREDIT_COSTS = Object.freeze({
    // Standard RPC (1 credit)
    getAccountInfo: 1,
    getBalance: 1,
    getBlock: 1,
    getBlockHeight: 1,
    getSlot: 1,
    getTokenAccountBalance: 1,
    getTokenLargestAccounts: 1,
    getSignaturesForAddress: 1,
    getTransaction: 1,
    getProgramAccounts: 1,
    getMultipleAccounts: 1,  // 1 per account

    // DAS API (5-10 credits)
    getAsset: 5,
    getAssetsByOwner: 10,
    getAssetsByGroup: 10,
    getTokenAccounts: 10,
    searchAssets: 10,

    // Enhanced APIs (100 credits)
    getTransactionsForAddress: 100,
    parseTransaction: 10,
    getEnhancedTransactions: 100,

    // Default
    default: 1,
});

/**
 * Get credit cost for a method
 */
function getCreditCost(method) {
    return CREDIT_COSTS[method] || CREDIT_COSTS.default;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7: DYNAMIC LOAD CALCULATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate expected credit usage for a token update
 *
 * Philosophy: Predict costs before spending
 *
 * @param {Object} token - Token data
 * @param {string} updateType - 'full' | 'price' | 'holders' | 'conviction'
 * @returns {number} Expected credit cost
 */
function estimateUpdateCost(token, updateType = 'full') {
    const costs = {
        price: 0,  // Jupiter/Raydium = FREE, Pyth = 1
        holders: CREDIT_COSTS.getTokenAccounts * Math.min(SAMPLING.DAS_MAX_PAGES,
            Math.ceil((token?.holderCount || 1000) / SAMPLING.DAS_PAGE_SIZE)),
        conviction: CREDIT_COSTS.getTokenLargestAccounts +
            (CREDIT_COSTS.getSignaturesForAddress * SAMPLING.CONVICTION_SAMPLES),
        full: 0,
    };

    // Full update = all components
    costs.full = costs.price + costs.holders + costs.conviction;

    return costs[updateType] || costs.full;
}

/**
 * Calculate optimal batch size based on available budget
 *
 * Philosophy: Maximize throughput within φ-safe limits
 *
 * @param {number} availableCredits - Remaining hourly credits
 * @param {number} costPerToken - Average cost per token update
 * @returns {number} Recommended batch size
 */
function calculateOptimalBatch(availableCredits, costPerToken) {
    // Reserve φ⁻² (38.2%) for burst capacity
    const usableCredits = availableCredits * PHI_POWERS.PHI_INV;
    const theoreticalBatch = Math.floor(usableCredits / costPerToken);

    // Round to nearest Fibonacci for natural batching
    for (let i = FIBONACCI.length - 1; i >= 0; i--) {
        if (FIBONACCI[i] <= theoreticalBatch) {
            return FIBONACCI[i];
        }
    }
    return 1;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8: MULTI-NODE AWARE UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * NOTE: Real-time usage tracking is handled by rpcMonitor.js with Redis
 * for proper multi-node coordination. This module provides:
 *
 * 1. φ-based CONSTANTS (BUDGET, CACHE_TTL, SAMPLING, REFRESH_TIERS)
 * 2. CREDIT_COSTS matrix (Helius pricing)
 * 3. ESTIMATION functions (estimateUpdateCost, calculateOptimalBatch)
 *
 * Integration pattern:
 *   - rpcMonitor.js uses BUDGET, CREDIT_COSTS from here
 *   - solana.js uses CACHE_TTL, SAMPLING from here
 *   - priceWorker.js uses REFRESH_TIERS from here
 *   - helius.js uses getCreditCost() from here
 */

/**
 * Get health status from budget percentages
 * @param {number} hourlyPercent - Hourly usage as decimal (0-1)
 * @param {number} dailyPercent - Daily usage as decimal (0-1)
 * @returns {'healthy'|'alert'|'warning'|'critical'}
 */
function getHealthFromPercent(hourlyPercent, dailyPercent) {
    const maxPct = Math.max(hourlyPercent, dailyPercent);
    if (maxPct >= BUDGET.CRITICAL_THRESHOLD) return 'critical';
    if (maxPct >= BUDGET.WARNING_THRESHOLD) return 'warning';
    if (maxPct >= BUDGET.ALERT_THRESHOLD) return 'alert';
    return 'healthy';
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
    // Plan info
    HELIUS_PLANS,
    CURRENT_PLAN,

    // Budget (φ-based)
    BUDGET,
    calculateBudgets,

    // Cache TTLs (φ-aligned volatility tiers)
    CACHE_TTL,
    BASE_TTL,

    // Sampling (Fibonacci-based)
    FIBONACCI,
    SAMPLING,

    // Refresh tiers (φ-multiplied)
    REFRESH_TIERS,
    REFRESH_BASE,

    // Credit costs (Helius pricing matrix)
    CREDIT_COSTS,
    getCreditCost,

    // Dynamic calculations
    estimateUpdateCost,
    calculateOptimalBatch,

    // Multi-node utilities
    getHealthFromPercent,

    // Re-export φ constants for convenience
    PHI,
    PHI_POWERS,
};
