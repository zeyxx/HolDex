/**
 * Price Worker - Unified Price Service
 *
 * Philosophy: Independent data sources, no DexScreener dependency
 * - Jupiter Price API V3 for token prices (free tier)
 * - Raydium API for pool/liquidity data (free)
 * - On-chain calculations via Helius RPC
 *
 * Features:
 * - Batch API: 100 tokens per Jupiter call
 * - Tiered refresh: Verified (1min), Active (5min), Dormant (30min)
 * - Zero external paid API dependencies
 * - WebSocket broadcast on price changes
 */

const { logger } = require('../services');
const priceProvider = require('../services/priceProvider');
// Note: sig_market updates deferred to K-Score updater to reduce DB calls

// Refresh tiers (in milliseconds)
const TIERS = {
    VERIFIED: 60 * 1000,      // 1 minute
    TOP_100: 60 * 1000,       // 1 minute
    ACTIVE: 5 * 60 * 1000,    // 5 minutes
    DORMANT: 30 * 60 * 1000   // 30 minutes
};

// Batch size limit (Jupiter allows 100)
// Raydium is fetched in parallel with concurrency limit inside priceProvider
const BATCH_SIZE = 100;

/**
 * Main price update cycle
 * Fetches prices for all tokens based on their tier
 */
async function runPriceUpdateCycle(db, broadcast) {
    const startTime = Date.now();

    try {
        // Get tokens grouped by tier
        const tokens = await db.all(`
            SELECT
                mint,
                symbol,
                hasCommunityUpdate,
                volume24h,
                price_timestamp
            FROM tokens
            WHERE mint != 'So11111111111111111111111111111111111111112'
            ORDER BY
                CASE WHEN hasCommunityUpdate = TRUE THEN 0 ELSE 1 END,
                volume24h DESC NULLS LAST
            LIMIT 1000
        `);

        const now = Date.now();
        const toUpdate = {
            verified: [],
            top100: [],
            active: [],
            dormant: []
        };

        // Classify tokens by tier and staleness
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            const lastUpdate = parseInt(t.price_timestamp || 0);
            const age = now - lastUpdate;

            if (t.hascommunityupdate || t.hasCommunityUpdate) {
                if (age > TIERS.VERIFIED) toUpdate.verified.push(t.mint);
            } else if (i < 100) {
                if (age > TIERS.TOP_100) toUpdate.top100.push(t.mint);
            } else if (t.volume24h > 1000) {
                if (age > TIERS.ACTIVE) toUpdate.active.push(t.mint);
            } else {
                if (age > TIERS.DORMANT) toUpdate.dormant.push(t.mint);
            }
        }

        // Combine all tokens needing update (prioritized)
        const allToUpdate = [
            ...toUpdate.verified,
            ...toUpdate.top100,
            ...toUpdate.active.slice(0, 100), // Limit active per cycle
            ...toUpdate.dormant.slice(0, 30)   // Limit dormant per cycle
        ];

        if (allToUpdate.length === 0) {
            logger.debug('[PriceWorker] All prices fresh');
            return { updated: 0, duration: Date.now() - startTime };
        }

        // Batch fetch (30 tokens per API call to respect rate limits)
        let totalUpdated = 0;
        const batches = [];

        for (let i = 0; i < allToUpdate.length; i += BATCH_SIZE) {
            batches.push(allToUpdate.slice(i, i + BATCH_SIZE));
        }

        logger.info(`[PriceWorker] Updating ${allToUpdate.length} tokens in ${batches.length} batches`);

        // Collect all price data from API batches first (no DB calls yet)
        const allPriceData = new Map();

        for (const batch of batches) {
            // Use new price provider instead of DexScreener
            const prices = await priceProvider.fetchBatchPrices(batch);

            for (const [mint, priceData] of prices) {
                allPriceData.set(mint, priceData);
            }

            // Delay between API batches to respect rate limits
            if (batches.length > 1) {
                await new Promise(r => setTimeout(r, 500));
            }
        }

        // BATCH DB UPDATE: Single query for all prices using unnest()
        // This reduces ~90 DB calls per batch to just 1
        if (allPriceData.size > 0) {
            const mints = [];
            const prices = [];
            const mcaps = [];
            const liquidities = [];
            const volumes = [];
            const changes24h = [];
            const changes1h = [];
            const changes5m = [];
            const sources = [];
            const timestamps = [];
            const pools = [];

            for (const [mint, pd] of allPriceData) {
                mints.push(mint);
                prices.push(pd.priceUsd || null);
                mcaps.push(pd.mcap || null);
                liquidities.push(pd.liquidity || null);
                volumes.push(pd.volume24h || null);
                changes24h.push(pd.change24h || null);
                changes1h.push(pd.change1h || null);
                changes5m.push(pd.change5m || null);
                sources.push(pd.source || 'jupiter');
                timestamps.push(pd.timestamp ? parseInt(pd.timestamp) : Date.now());
                pools.push(pd.pairAddress || null);
            }

            try {
                // Single batch UPDATE using unnest arrays
                const result = await db.run(`
                    UPDATE tokens AS t SET
                        priceusd = CASE WHEN v.price::numeric > 0 THEN v.price ELSE t.priceusd END,
                        marketcap = CASE WHEN v.mcap::numeric > 0 THEN v.mcap ELSE t.marketcap END,
                        liquidity = CASE WHEN v.liq::numeric > 0 THEN v.liq ELSE t.liquidity END,
                        volume24h = CASE WHEN v.vol::numeric > 0 THEN v.vol ELSE t.volume24h END,
                        change24h = CASE WHEN v.price::numeric > 0 THEN COALESCE(v.c24h, t.change24h) ELSE t.change24h END,
                        change1h = CASE WHEN v.price::numeric > 0 THEN COALESCE(v.c1h, t.change1h) ELSE t.change1h END,
                        change5m = CASE WHEN v.price::numeric > 0 THEN COALESCE(v.c5m, t.change5m) ELSE t.change5m END,
                        price_source = CASE WHEN v.price::numeric > 0 THEN v.src ELSE t.price_source END,
                        price_timestamp = CASE WHEN v.price::numeric > 0 THEN v.ts::bigint ELSE t.price_timestamp END,
                        price_pool = CASE WHEN v.price::numeric > 0 THEN COALESCE(v.pool, t.price_pool) ELSE t.price_pool END,
                        liquidity_source = CASE WHEN v.liq::numeric > 0 THEN v.src ELSE t.liquidity_source END,
                        liquidity_timestamp = CASE WHEN v.liq::numeric > 0 THEN v.ts::bigint ELSE t.liquidity_timestamp END,
                        sig_market = NULL
                    FROM (
                        SELECT
                            unnest($1::text[]) as mint,
                            unnest($2::numeric[]) as price,
                            unnest($3::numeric[]) as mcap,
                            unnest($4::numeric[]) as liq,
                            unnest($5::numeric[]) as vol,
                            unnest($6::numeric[]) as c24h,
                            unnest($7::numeric[]) as c1h,
                            unnest($8::numeric[]) as c5m,
                            unnest($9::text[]) as src,
                            unnest($10::bigint[]) as ts,
                            unnest($11::text[]) as pool
                    ) AS v
                    WHERE t.mint = v.mint
                `, [mints, prices, mcaps, liquidities, volumes, changes24h, changes1h, changes5m, sources, timestamps, pools]);

                totalUpdated = allPriceData.size;

                // Note: sig_market set to NULL will be recomputed by K-Score updater
                // This avoids 2 extra DB calls per token (SELECT sigs + UPDATE sigs)
                // K-Score updater already re-signs all tokens periodically

            } catch (e) {
                logger.error('[PriceWorker] Batch DB update failed:', e.message);
                // Fallback: try individual updates (slower but more resilient)
                for (const [mint, priceData] of allPriceData) {
                    try {
                        await db.run(`
                            UPDATE tokens SET
                                priceusd = CASE WHEN $1::numeric > 0 THEN $1 ELSE priceusd END,
                                marketcap = CASE WHEN $2::numeric > 0 THEN $2 ELSE marketcap END,
                                liquidity = CASE WHEN $3::numeric > 0 THEN $3 ELSE liquidity END,
                                volume24h = CASE WHEN $4::numeric > 0 THEN $4 ELSE volume24h END,
                                price_source = CASE WHEN $1::numeric > 0 THEN $5 ELSE price_source END,
                                price_timestamp = CASE WHEN $1::numeric > 0 THEN $6 ELSE price_timestamp END,
                                sig_market = NULL
                            WHERE mint = $7
                        `, [
                            priceData.priceUsd,
                            priceData.mcap,
                            priceData.liquidity,
                            priceData.volume24h,
                            priceData.source,
                            priceData.timestamp?.toString(),
                            mint
                        ]);
                        totalUpdated++;
                    } catch (e2) {
                        logger.error(`[PriceWorker] Individual update failed for ${mint}:`, e2.message);
                    }
                }
            }

            // Broadcast price updates via WebSocket
            if (broadcast) {
                for (const [mint, priceData] of allPriceData) {
                    broadcast.priceUpdate(mint, priceData);
                }
            }
        }

        const duration = Date.now() - startTime;
        logger.info(`[PriceWorker] Updated ${totalUpdated} prices in ${duration}ms (${batches.length} API calls)`);

        return { updated: totalUpdated, duration, batches: batches.length };

    } catch (e) {
        logger.error('[PriceWorker] Cycle failed:', e.message);
        return { updated: 0, error: e.message };
    }
}

/**
 * Get price for a single token (with cache)
 * Used by other services that need current price
 */
async function getPrice(mint) {
    // Check cache first (from priceProvider)
    const cached = priceProvider.getCachedPrice(mint, 60000);
    if (cached) return cached;

    // Fetch single token price
    return await priceProvider.getPrice(mint);
}

/**
 * Get cached price (quick lookup, no API call)
 */
function getCachedPrice(mint, maxAge = 60000) {
    return priceProvider.getCachedPrice(mint, maxAge);
}

/**
 * Fetch batch prices (delegated to priceProvider)
 */
async function fetchBatchPrices(mints) {
    return await priceProvider.fetchBatchPrices(mints);
}

/**
 * Initialize and start the price worker
 */
function startPriceWorker(deps) {
    const { db, broadcast } = deps;

    logger.info('[PriceWorker] Starting unified price service (Jupiter + Raydium)');

    // Initial run after 5 seconds
    setTimeout(() => runPriceUpdateCycle(db, broadcast), 5000);

    // Main cycle: every 30 seconds
    const interval = setInterval(() => {
        runPriceUpdateCycle(db, broadcast);
    }, 30 * 1000);

    return {
        stop: () => clearInterval(interval),
        getPrice,
        getCachedPrice,
        fetchBatchPrices,
        runNow: () => runPriceUpdateCycle(db, broadcast)
    };
}

module.exports = {
    startPriceWorker,
    getPrice,
    getCachedPrice,
    fetchBatchPrices,
    runPriceUpdateCycle,
    TIERS
};
