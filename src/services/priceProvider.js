/**
 * Unified Price Provider - DexScreener-Free Implementation
 *
 * Data Sources (Priority Order):
 * 1. Jupiter Price API V3 - Primary price source (free tier available)
 * 2. Helius RPC - On-chain pool data, token accounts
 * 3. On-chain calculation - Vault balance ratios for liquidity
 * 4. CoinGecko - SOL/USD price (cached)
 *
 * Philosophy: Independent, verifiable, on-chain data
 */

const config = require('../config/env');
const logger = require('./logger');
const { getRedis } = require('./redis');
const { waitForRateLimit } = require('./heliusRateLimiter');

// ============================================
// CONFIGURATION
// ============================================

// Raydium Price API - FREE, no API key required
// Primary source for token prices
const RAYDIUM_PRICE_URL = 'https://api-v3.raydium.io/mint/price';
const RAYDIUM_BATCH_SIZE = 100; // Conservative batch size

// Jupiter as fallback (requires paid API key)
const JUPITER_API_KEY = config.JUPITER_API_KEY || process.env.JUPITER_API_KEY;
const JUPITER_PRICE_URL = 'https://api.jup.ag/price/v2';
const JUPITER_BATCH_SIZE = 100;

// Helius RPC for on-chain data
const HELIUS_RPC_URL = 'https://mainnet.helius-rpc.com';

// Known token addresses
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// Raydium AMM Program IDs for pool identification
const _RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const _RAYDIUM_CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const _ORCA_WHIRLPOOL = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

// ============================================
// PUMPFUN ON-CHAIN - "onchain in truth"
// ============================================
// Philosophy: Verify prices directly from blockchain state
// No third-party API dependencies for PumpFun tokens

// PumpFun Bonding Curve Program - for tokens still on curve
const PUMPFUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
// PumpSwap AMM Program - for graduated tokens (constant product AMM)
const PUMPSWAP_AMM_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

// Bonding curve account layout (49 bytes):
// [0-7]:  discriminator
// [8-15]: virtual_token_reserves (u64)
// [16-23]: virtual_sol_reserves (u64)
// [24-31]: real_token_reserves (u64)
// [32-39]: real_sol_reserves (u64)
// [40-47]: token_total_supply (u64)
// [48]: complete (bool - true = graduated to PumpSwap)
const PUMPFUN_LAYOUT = {
    VIRTUAL_TOKEN_RESERVES: 8,
    VIRTUAL_SOL_RESERVES: 16,
    REAL_TOKEN_RESERVES: 24,
    REAL_SOL_RESERVES: 32,
    TOKEN_TOTAL_SUPPLY: 40,
    COMPLETE: 48,
    ACCOUNT_SIZE: 49
};

// PumpSwap AMM pool layout (constant product x*y=k):
// Pool account contains base/quote vaults and reserves
// Reserved for future PumpSwap AMM integration
const _PUMPSWAP_LAYOUT = {
    // Pool account structure (simplified)
    BASE_MINT: 8,        // offset 8, 32 bytes
    QUOTE_MINT: 40,      // offset 40, 32 bytes
    BASE_VAULT: 72,      // offset 72, 32 bytes
    QUOTE_VAULT: 104,    // offset 104, 32 bytes
    ACCOUNT_SIZE: 200    // minimum expected size
};

// Cache settings
const PRICE_CACHE_TTL = 60000;      // 1 minute for prices
const LIQUIDITY_CACHE_TTL = 300000; // 5 minutes for liquidity

// In-memory cache
const priceCache = new Map();
const liquidityCache = new Map();

// SOL price cache (shared with priceService.js pattern)
let solPriceCache = { price: 0, timestamp: 0, lastAttempt: 0 };
const SOL_CACHE_DURATION = 300000; // 5 minutes
const SOL_RETRY_COOLDOWN = 60000;  // 1 minute

// ============================================
// BOUNDS VALIDATION
// ============================================
const PRICE_BOUNDS = {
    MIN_PRICE: 0,
    MAX_PRICE: 1e15,
    MIN_MCAP: 0,
    MAX_MCAP: 1e15,
    MIN_LIQUIDITY: 0,
    MAX_LIQUIDITY: 1e12,
    MIN_VOLUME: 0,
    MAX_VOLUME: 1e12,
    MIN_CHANGE_PCT: -100,
    MAX_CHANGE_PCT: 100000,
};

function clampValue(value, min, max, fallback = 0) {
    const num = parseFloat(value);
    if (!Number.isFinite(num)) return fallback;
    if (num < min) return min;
    if (num > max) return max;
    return num;
}

// ============================================
// SOL PRICE - "onchain in truth"
// ============================================
// Priority: Pyth Oracle (on-chain) > CoinGecko (fallback)

// Pyth SOL/USD Price Feed Account
const PYTH_SOL_USD_FEED = 'H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG';
// Pyth price account layout offsets
const PYTH_PRICE_OFFSET = 208;     // aggregate.price (i64)
const PYTH_EXPONENT_OFFSET = 20;   // exponent (i32)
const PYTH_CONF_OFFSET = 216;      // aggregate.conf (u64)

/**
 * Get SOL/USD price from Pyth Oracle (on-chain)
 * P6: Redis cache added (5 min TTL) to reduce RPC calls
 * @returns {Object|null} Price data or null if unavailable
 */
async function getSolPricePyth() {
    // P6: Check Redis cache first (5 min TTL)
    const redis = getRedis();
    const cacheKey = 'price:sol:pyth';

    if (redis) {
        try {
            const cached = await redis.get(cacheKey);
            if (cached) {
                logger.debug('[Pyth] Cache HIT for SOL/USD');
                return JSON.parse(cached);
            }
        } catch (_e) { /* cache miss */ }
    }

    try {
        const { PublicKey, Connection } = require('@solana/web3.js');

        // Use Helius if available, otherwise public RPC
        // Pyth is a simple account read, public RPC works fine
        const rpcUrl = config.HELIUS_API_KEY
            ? `${HELIUS_RPC_URL}?api-key=${config.HELIUS_API_KEY}`
            : 'https://api.mainnet-beta.solana.com';

        // P6: Rate limit before RPC call (if using Helius)
        if (config.HELIUS_API_KEY) {
            await waitForRateLimit();
        }

        const connection = new Connection(rpcUrl, 'confirmed');

        const accountInfo = await connection.getAccountInfo(
            new PublicKey(PYTH_SOL_USD_FEED)
        );

        if (!accountInfo || !accountInfo.data || accountInfo.data.length < 240) {
            return null;
        }

        const data = accountInfo.data;

        // Read exponent (i32 at offset 20)
        const exponent = data.readInt32LE(PYTH_EXPONENT_OFFSET);

        // Read aggregate price (i64 at offset 208)
        const priceRaw = data.readBigInt64LE(PYTH_PRICE_OFFSET);

        // Read confidence interval (u64 at offset 216)
        const confRaw = data.readBigUInt64LE(PYTH_CONF_OFFSET);

        // Convert: price × 10^exponent
        const price = Number(priceRaw) * Math.pow(10, exponent);
        const confidence = Number(confRaw) * Math.pow(10, exponent);

        if (price <= 0 || !Number.isFinite(price)) {
            return null;
        }

        logger.debug(`[Pyth] SOL/USD: $${price.toFixed(2)} (±$${confidence.toFixed(4)})`);

        const result = {
            price,
            confidence,
            source: 'pyth_oracle',
            onChain: true,
            timestamp: Date.now()
        };

        // P6: Cache the result (5 min TTL)
        if (redis) {
            redis.set(cacheKey, JSON.stringify(result), 'EX', 300).catch(() => {});
        }

        return result;

    } catch (e) {
        logger.debug(`[Pyth] SOL price fetch error: ${e.message}`);
        return null;
    }
}

/**
 * Get SOL/USD price from CoinGecko (fallback)
 * @returns {number} SOL price in USD
 */
async function getSolPriceCoinGecko() {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(
            'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
            { signal: controller.signal }
        );
        clearTimeout(timeout);

        if (!response.ok) throw new Error(`CoinGecko: ${response.status}`);

        const data = await response.json();
        return data?.solana?.usd || 0;

    } catch (e) {
        logger.debug(`[CoinGecko] SOL price error: ${e.message}`);
        return 0;
    }
}

/**
 * Get SOL/USD price with fallback chain
 * Priority: Pyth Oracle (on-chain) > CoinGecko (API)
 * Philosophy: "onchain in truth" - prefer on-chain sources
 */
async function getSolPrice() {
    const now = Date.now();

    // Return cached if fresh
    if (solPriceCache.price > 0 && (now - solPriceCache.timestamp) < SOL_CACHE_DURATION) {
        return solPriceCache.price;
    }

    // Cooldown after recent failure
    if (solPriceCache.lastAttempt > 0 && (now - solPriceCache.lastAttempt) < SOL_RETRY_COOLDOWN) {
        return solPriceCache.price || 190;
    }

    solPriceCache.lastAttempt = now;

    // 1. PRIMARY: Try Pyth Oracle (on-chain)
    const pythResult = await getSolPricePyth();
    if (pythResult && pythResult.price > 0) {
        solPriceCache = {
            price: pythResult.price,
            timestamp: now,
            lastAttempt: now,
            source: 'pyth_oracle'
        };
        return pythResult.price;
    }

    // 2. FALLBACK: CoinGecko (off-chain)
    logger.debug('[PriceProvider] Pyth unavailable, falling back to CoinGecko');
    const geckoPrice = await getSolPriceCoinGecko();

    if (geckoPrice > 0) {
        solPriceCache = {
            price: geckoPrice,
            timestamp: now,
            lastAttempt: now,
            source: 'coingecko'
        };
        logger.debug(`[PriceProvider] SOL: $${geckoPrice} (CoinGecko fallback)`);
        return geckoPrice;
    }

    // 3. EMERGENCY: Return cached or default
    logger.warn('[PriceProvider] All SOL price sources failed, using cached/default');
    return solPriceCache.price || 190;
}

// ============================================
// RAYDIUM PRICE API (PRIMARY - FREE)
// ============================================

/**
 * Fetch prices from Raydium API (free, no key required)
 * @param {string[]} mints - Array of token mint addresses
 * @returns {Map<string, Object>} Map of mint -> price data
 */
async function fetchRaydiumPrices(mints, retryCount = 0) {
    if (!mints || mints.length === 0) return new Map();

    const MAX_RETRIES = 3;
    const results = new Map();

    // Raydium batch: comma-separated
    const batchMints = mints.slice(0, RAYDIUM_BATCH_SIZE);
    const mintsParam = batchMints.join(',');
    const url = `${RAYDIUM_PRICE_URL}?mints=${mintsParam}`;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        // Handle rate limiting
        if (response.status === 429) {
            if (retryCount < MAX_RETRIES) {
                const delay = 1000 * Math.pow(2, retryCount);
                logger.debug(`[Raydium] Rate limited, retry ${retryCount + 1} in ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
                return fetchRaydiumPrices(mints, retryCount + 1);
            }
            logger.warn('[Raydium] Rate limit exceeded, max retries');
            return results;
        }

        if (!response.ok) {
            logger.warn(`[Raydium] Price API error: ${response.status}`);
            return results;
        }

        const data = await response.json();
        const now = Date.now();

        if (!data.success || !data.data) {
            logger.warn('[Raydium] Invalid response format');
            return results;
        }

        // Process Raydium response: { data: { [mint]: "price_string" } }
        for (const mint of batchMints) {
            const priceStr = data.data[mint];
            if (!priceStr) continue;

            const priceUsd = parseFloat(priceStr);
            if (!priceUsd || priceUsd <= 0) continue;

            results.set(mint, {
                priceUsd: clampValue(priceUsd, PRICE_BOUNDS.MIN_PRICE, PRICE_BOUNDS.MAX_PRICE),
                source: 'raydium',
                timestamp: now,
                confidence: 'high'
            });
        }

        logger.debug(`[Raydium] Fetched ${results.size}/${batchMints.length} prices`);
        return results;

    } catch (e) {
        if (e.name === 'AbortError') {
            logger.warn('[Raydium] Request timeout');
        } else {
            logger.error('[Raydium] Fetch error:', e.message);
        }
        return results;
    }
}

// ============================================
// JUPITER PRICE API (FALLBACK - PAID)
// ============================================

/**
 * Fetch prices from Jupiter Price API (requires API key)
 * @param {string[]} mints - Array of token mint addresses
 * @returns {Map<string, Object>} Map of mint -> price data
 */
async function fetchJupiterPrices(mints, retryCount = 0) {
    if (!mints || mints.length === 0) return new Map();

    const MAX_RETRIES = 3;
    const results = new Map();

    // Jupiter batch: comma-separated, max 100
    const batchMints = mints.slice(0, JUPITER_BATCH_SIZE);
    const ids = batchMints.join(',');
    // V2 API: ids param, showExtraInfo for additional data
    const url = `${JUPITER_PRICE_URL}?ids=${ids}&showExtraInfo=true`;

    // Build headers - include API key if available (for Pro tier)
    const headers = {};
    if (JUPITER_API_KEY) {
        headers['x-api-key'] = JUPITER_API_KEY;
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(url, {
            signal: controller.signal,
            headers: Object.keys(headers).length > 0 ? headers : undefined
        });
        clearTimeout(timeout);

        // Handle rate limiting
        if (response.status === 429) {
            if (retryCount < MAX_RETRIES) {
                const delay = 1000 * Math.pow(2, retryCount);
                logger.debug(`[Jupiter] Rate limited, retry ${retryCount + 1} in ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
                return fetchJupiterPrices(mints, retryCount + 1);
            }
            logger.warn('[Jupiter] Rate limit exceeded, max retries');
            return results;
        }

        if (!response.ok) {
            logger.warn(`[Jupiter] API error: ${response.status}`);
            return results;
        }

        const data = await response.json();
        const now = Date.now();

        // Process Jupiter V2 response
        // V2 format: { data: { [mint]: { id, type, price, extraInfo? } } }
        const priceData = data?.data || data;

        for (const mint of batchMints) {
            const tokenData = priceData[mint];
            if (!tokenData) continue;

            // V2 uses 'price' field (string), V3 uses 'usdPrice'
            const priceUsd = parseFloat(tokenData.price) || parseFloat(tokenData.usdPrice) || 0;
            if (priceUsd <= 0) continue;

            // V2 extraInfo contains additional data when showExtraInfo=true
            const extraInfo = tokenData.extraInfo || {};
            const quotedPrice = extraInfo.quotedPrice || {};

            results.set(mint, {
                priceUsd: clampValue(priceUsd, PRICE_BOUNDS.MIN_PRICE, PRICE_BOUNDS.MAX_PRICE),
                // V2 provides confidence score
                confidenceLevel: extraInfo.confidenceLevel || 'medium',
                // Buy/sell prices from extraInfo
                buyPrice: quotedPrice.buyPrice ? parseFloat(quotedPrice.buyPrice) : null,
                sellPrice: quotedPrice.sellPrice ? parseFloat(quotedPrice.sellPrice) : null,
                // No 24h change in V2 free tier - will get from Raydium if needed
                change24h: null,
                volume24h: null,
                // Metadata
                source: 'jupiter',
                timestamp: now,
                confidence: extraInfo.confidenceLevel === 'high' ? 'high' : 'medium'
            });
        }

        logger.debug(`[Jupiter] Fetched ${results.size}/${batchMints.length} prices`);
        return results;

    } catch (e) {
        if (e.name === 'AbortError') {
            logger.warn('[Jupiter] Request timeout');
        } else {
            logger.error('[Jupiter] Fetch error:', e.message);
        }
        return results;
    }
}

/**
 * Get single token price from Jupiter
 */
async function getJupiterPrice(mint) {
    // Check cache first
    const cached = priceCache.get(mint);
    if (cached && Date.now() - cached.timestamp < PRICE_CACHE_TTL) {
        return cached.data;
    }

    const prices = await fetchJupiterPrices([mint]);
    const priceData = prices.get(mint);

    if (priceData) {
        priceCache.set(mint, { data: priceData, timestamp: Date.now() });
    }

    return priceData || null;
}

// ============================================
// HELIUS ON-CHAIN DATA
// ============================================

/**
 * Get token account balances using Helius RPC
 */
async function getTokenAccountBalance(connection, vaultAddress) {
    try {
        const { PublicKey } = require('@solana/web3.js');
        const pubkey = new PublicKey(vaultAddress);
        const info = await connection.getAccountInfo(pubkey);

        if (!info || info.data.length < 72) return null;

        // SPL Token account layout: amount at offset 64 (8 bytes)
        const amount = info.data.readBigUInt64LE(64);
        return Number(amount);
    } catch (e) {
        logger.debug(`[Helius] Balance fetch error: ${e.message}`);
        return null;
    }
}

/**
 * Calculate liquidity from on-chain pool vault balances
 * Works for Raydium AMM pools
 */
async function calculateOnChainLiquidity(connection, poolAddress, baseDecimals = 9, quoteDecimals = 9) {
    try {
        const { PublicKey } = require('@solana/web3.js');

        // Check cache first
        const cacheKey = `liq:${poolAddress}`;
        const cached = liquidityCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < LIQUIDITY_CACHE_TTL) {
            return cached.data;
        }

        // Get pool account to extract vault addresses
        const poolPubkey = new PublicKey(poolAddress);
        const poolInfo = await connection.getAccountInfo(poolPubkey);

        if (!poolInfo || !poolInfo.data) {
            return null;
        }

        // Raydium AMM V4 layout - vault addresses at specific offsets
        // This is simplified - real implementation needs proper deserialization
        const data = poolInfo.data;

        // For Raydium AMM V4, approximate offsets:
        // baseVault: offset 336 (32 bytes)
        // quoteVault: offset 368 (32 bytes)
        if (data.length < 400) return null;

        const baseVault = new PublicKey(data.slice(336, 368)).toBase58();
        const quoteVault = new PublicKey(data.slice(368, 400)).toBase58();

        // Fetch vault balances
        const [baseBalance, quoteBalance] = await Promise.all([
            getTokenAccountBalance(connection, baseVault),
            getTokenAccountBalance(connection, quoteVault)
        ]);

        if (baseBalance === null || quoteBalance === null) return null;

        // Get SOL price for USD conversion
        const solPrice = await getSolPrice();

        // Calculate liquidity in USD
        // Assuming quote is SOL or stablecoin
        const baseAmount = baseBalance / Math.pow(10, baseDecimals);
        const quoteAmount = quoteBalance / Math.pow(10, quoteDecimals);

        // Total liquidity = 2 * quote side (standard AMM)
        const liquidityUsd = quoteAmount * solPrice * 2;

        const result = {
            liquidity: clampValue(liquidityUsd, PRICE_BOUNDS.MIN_LIQUIDITY, PRICE_BOUNDS.MAX_LIQUIDITY),
            baseReserve: baseAmount,
            quoteReserve: quoteAmount,
            poolAddress,
            source: 'on_chain',
            timestamp: Date.now()
        };

        // Cache result
        liquidityCache.set(cacheKey, { data: result, timestamp: Date.now() });

        return result;

    } catch (e) {
        logger.debug(`[OnChain] Liquidity calc error: ${e.message}`);
        return null;
    }
}

/**
 * Discover pools for a token using Helius DAS API
 */
async function _discoverPools(mint) {
    if (!config.HELIUS_API_KEY) return [];

    try {
        const response = await fetch(HELIUS_RPC_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.HELIUS_API_KEY}`
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'pool-search',
                method: 'searchAssets',
                params: {
                    ownerAddress: mint,
                    tokenType: 'fungible',
                    displayOptions: {
                        showCollectionMetadata: false
                    }
                }
            })
        });

        const data = await response.json();
        // Process and return pool addresses
        return data?.result?.items || [];

    } catch (e) {
        logger.debug(`[Helius] Pool discovery error: ${e.message}`);
        return [];
    }
}

// ============================================
// PUMPFUN ON-CHAIN PRICE CALCULATION
// ============================================
// "onchain in truth" - derive prices from blockchain state
// Two modes: Bonding Curve (pre-graduation) and PumpSwap AMM (post-graduation)

/**
 * Derive PumpFun bonding curve PDA from token mint
 * @param {string} mint - Token mint address
 * @returns {string} Bonding curve account address
 */
function derivePumpFunBondingCurve(mint) {
    const { PublicKey } = require('@solana/web3.js');
    const mintPubkey = new PublicKey(mint);
    const programId = new PublicKey(PUMPFUN_PROGRAM_ID);

    const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), mintPubkey.toBuffer()],
        programId
    );

    return bondingCurve.toBase58();
}

/**
 * Fetch price from PumpFun bonding curve (on-chain)
 * For tokens still on the bonding curve (not yet graduated)
 *
 * @param {string} mint - Token mint address
 * @param {Connection} connection - Solana RPC connection (optional)
 * @returns {Object|null} Price data or null if not on curve
 */
async function fetchPumpFunBondingCurvePrice(mint, connection = null) {
    // P6: Check Redis cache first (30s TTL for on-chain prices)
    const redis = getRedis();
    const cacheKey = `price:pumpfun:${mint}`;

    if (redis) {
        try {
            const cached = await redis.get(cacheKey);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (_e) { /* cache miss */ }
    }

    try {
        const { PublicKey, Connection } = require('@solana/web3.js');

        // Get or create connection
        if (!connection) {
            const heliusUrl = config.HELIUS_API_KEY
                ? `${HELIUS_RPC_URL}?api-key=${config.HELIUS_API_KEY}`
                : HELIUS_RPC_URL;
            connection = new Connection(heliusUrl, 'confirmed');
        }

        // P6: Rate limit before RPC call
        if (config.HELIUS_API_KEY) {
            await waitForRateLimit();
        }

        // Derive bonding curve PDA
        const bondingCurveAddress = derivePumpFunBondingCurve(mint);
        const bondingCurvePubkey = new PublicKey(bondingCurveAddress);

        // Fetch bonding curve account
        const accountInfo = await connection.getAccountInfo(bondingCurvePubkey);

        if (!accountInfo || !accountInfo.data) {
            // Token not on PumpFun bonding curve
            return null;
        }

        const data = accountInfo.data;

        // Verify account size
        if (data.length < PUMPFUN_LAYOUT.ACCOUNT_SIZE) {
            logger.debug(`[PumpFun] Invalid bonding curve size for ${mint}`);
            return null;
        }

        // Check if completed (graduated to PumpSwap)
        const isComplete = data[PUMPFUN_LAYOUT.COMPLETE] === 1;
        if (isComplete) {
            // Token graduated - should use PumpSwap AMM instead
            return { graduated: true, mint };
        }

        // Read virtual reserves (u64 little-endian)
        const virtualTokenReserves = data.readBigUInt64LE(PUMPFUN_LAYOUT.VIRTUAL_TOKEN_RESERVES);
        const virtualSolReserves = data.readBigUInt64LE(PUMPFUN_LAYOUT.VIRTUAL_SOL_RESERVES);
        // Note: realTokenReserves available at REAL_TOKEN_RESERVES offset if needed
        const realSolReserves = data.readBigUInt64LE(PUMPFUN_LAYOUT.REAL_SOL_RESERVES);

        // Calculate price: SOL per token = virtual_sol / virtual_token
        // Convert from lamports (9 decimals) and token units (6 decimals for PumpFun)
        const solPerToken = Number(virtualSolReserves) / Number(virtualTokenReserves);

        // Get SOL price for USD conversion
        const solPrice = await getSolPrice();
        const priceUsd = solPerToken * solPrice;

        // Calculate liquidity from real reserves
        const realSolAmount = Number(realSolReserves) / 1e9; // lamports to SOL
        const liquidityUsd = realSolAmount * solPrice * 2; // 2-sided liquidity

        // Calculate market cap (PumpFun tokens are 1B supply, 6 decimals)
        const totalSupply = 1_000_000_000; // 1B tokens
        const mcap = priceUsd * totalSupply;

        const now = Date.now();

        logger.debug(`[PumpFun] On-chain price for ${mint}: $${priceUsd.toFixed(12)} (bonding curve)`);

        const result = {
            priceUsd: clampValue(priceUsd, PRICE_BOUNDS.MIN_PRICE, PRICE_BOUNDS.MAX_PRICE),
            mcap: clampValue(mcap, PRICE_BOUNDS.MIN_MCAP, PRICE_BOUNDS.MAX_MCAP),
            liquidity: clampValue(liquidityUsd, PRICE_BOUNDS.MIN_LIQUIDITY, PRICE_BOUNDS.MAX_LIQUIDITY),
            volume24h: null, // Not available on-chain
            change24h: null,
            change1h: null,
            change5m: null,
            pairAddress: bondingCurveAddress,
            dex: 'pumpfun',
            source: 'onchain_bonding_curve',
            timestamp: now,
            confidence: 'high', // On-chain = highest confidence
            onChain: true,
            graduated: false,
            virtualReserves: {
                token: Number(virtualTokenReserves),
                sol: Number(virtualSolReserves)
            }
        };

        // P6: Cache result (30s TTL for on-chain prices)
        if (redis) {
            redis.set(cacheKey, JSON.stringify(result), 'EX', 30).catch(() => {});
        }

        return result;

    } catch (e) {
        logger.debug(`[PumpFun] Bonding curve fetch error for ${mint}: ${e.message}`);
        return null;
    }
}

/**
 * Batch fetch PumpFun on-chain prices for multiple tokens
 * Uses getMultipleAccountsInfo for efficiency
 *
 * @param {string[]} mints - Array of token mint addresses
 * @returns {Map<string, Object>} Map of mint -> price data
 */
async function fetchPumpFunOnChainPrices(mints) {
    if (!mints || mints.length === 0) return new Map();

    const results = new Map();

    try {
        const { PublicKey, Connection } = require('@solana/web3.js');

        // Get connection
        const heliusUrl = config.HELIUS_API_KEY
            ? `${HELIUS_RPC_URL}?api-key=${config.HELIUS_API_KEY}`
            : HELIUS_RPC_URL;
        const connection = new Connection(heliusUrl, 'confirmed');

        // Derive all bonding curve PDAs
        const bondingCurves = mints.map(mint => {
            try {
                return {
                    mint,
                    pda: new PublicKey(derivePumpFunBondingCurve(mint))
                };
            } catch {
                return null;
            }
        }).filter(Boolean);

        if (bondingCurves.length === 0) return results;

        // Batch fetch accounts (max 100 per call)
        const BATCH_SIZE = 100;
        const solPrice = await getSolPrice();
        const now = Date.now();

        for (let i = 0; i < bondingCurves.length; i += BATCH_SIZE) {
            const batch = bondingCurves.slice(i, i + BATCH_SIZE);
            const pubkeys = batch.map(b => b.pda);

            try {
                // P6: Rate limit before batch RPC call
                if (config.HELIUS_API_KEY) {
                    await waitForRateLimit();
                }

                const accounts = await connection.getMultipleAccountsInfo(pubkeys);

                for (let j = 0; j < accounts.length; j++) {
                    const accountInfo = accounts[j];
                    const { mint, pda } = batch[j];

                    if (!accountInfo || !accountInfo.data) continue;

                    const data = accountInfo.data;
                    if (data.length < PUMPFUN_LAYOUT.ACCOUNT_SIZE) continue;

                    // Check if graduated
                    const isComplete = data[PUMPFUN_LAYOUT.COMPLETE] === 1;
                    if (isComplete) {
                        // Mark as graduated - caller should try PumpSwap or Raydium
                        results.set(mint, { graduated: true, mint });
                        continue;
                    }

                    // Read reserves
                    const virtualTokenReserves = data.readBigUInt64LE(PUMPFUN_LAYOUT.VIRTUAL_TOKEN_RESERVES);
                    const virtualSolReserves = data.readBigUInt64LE(PUMPFUN_LAYOUT.VIRTUAL_SOL_RESERVES);
                    const realSolReserves = data.readBigUInt64LE(PUMPFUN_LAYOUT.REAL_SOL_RESERVES);

                    // Calculate price
                    const solPerToken = Number(virtualSolReserves) / Number(virtualTokenReserves);
                    const priceUsd = solPerToken * solPrice;

                    // Liquidity and mcap
                    const realSolAmount = Number(realSolReserves) / 1e9;
                    const liquidityUsd = realSolAmount * solPrice * 2;
                    const mcap = priceUsd * 1_000_000_000; // 1B supply

                    results.set(mint, {
                        priceUsd: clampValue(priceUsd, PRICE_BOUNDS.MIN_PRICE, PRICE_BOUNDS.MAX_PRICE),
                        mcap: clampValue(mcap, PRICE_BOUNDS.MIN_MCAP, PRICE_BOUNDS.MAX_MCAP),
                        liquidity: clampValue(liquidityUsd, PRICE_BOUNDS.MIN_LIQUIDITY, PRICE_BOUNDS.MAX_LIQUIDITY),
                        volume24h: null,
                        change24h: null,
                        change1h: null,
                        change5m: null,
                        pairAddress: pda.toBase58(),
                        dex: 'pumpfun',
                        source: 'onchain_bonding_curve',
                        timestamp: now,
                        confidence: 'high',
                        onChain: true,
                        graduated: false
                    });
                }
            } catch (e) {
                logger.debug(`[PumpFun] Batch fetch error: ${e.message}`);
            }
        }

        logger.debug(`[PumpFun] On-chain batch: ${results.size}/${mints.length} tokens`);
        return results;

    } catch (e) {
        logger.error(`[PumpFun] On-chain prices error: ${e.message}`);
        return results;
    }
}

// ============================================
// RAYDIUM API (for pool discovery - free)
// ============================================

/**
 * Get pool info from Raydium API (free, no key required)
 */
async function getRaydiumPoolInfo(mint) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        // Raydium V3 API - get pools by mint
        const response = await fetch(
            `https://api-v3.raydium.io/pools/info/mint?mint1=${mint}&poolType=all&poolSortField=liquidity&sortType=desc&pageSize=5&page=1`,
            { signal: controller.signal }
        );
        clearTimeout(timeout);

        if (!response.ok) return null;

        const data = await response.json();
        if (!data.success || !data.data?.data?.length) return null;

        const pools = data.data.data;
        const bestPool = pools[0];

        return {
            poolAddress: bestPool.id,
            dex: bestPool.type || 'raydium',
            liquidity: clampValue(bestPool.tvl, PRICE_BOUNDS.MIN_LIQUIDITY, PRICE_BOUNDS.MAX_LIQUIDITY),
            volume24h: clampValue(bestPool.day?.volume, PRICE_BOUNDS.MIN_VOLUME, PRICE_BOUNDS.MAX_VOLUME),
            price: clampValue(bestPool.price, PRICE_BOUNDS.MIN_PRICE, PRICE_BOUNDS.MAX_PRICE),
            lpMint: bestPool.lpMint?.address,
            source: 'raydium',
            timestamp: Date.now()
        };

    } catch (e) {
        logger.debug(`[Raydium] Pool info error: ${e.message}`);
        return null;
    }
}

// ============================================
// UNIFIED PRICE FETCHING
// ============================================

/**
 * Get comprehensive price data for a token
 * Combines Jupiter price + on-chain liquidity
 *
 * @param {string} mint - Token mint address
 * @param {Object} options - Optional: db connection, decimals
 * @returns {Object} Complete price data
 */
async function getPrice(mint, options = {}) {
    const timestamp = Date.now();

    // 1. Get price from Jupiter (primary source)
    const jupiterData = await getJupiterPrice(mint);

    // 2. Get pool/liquidity info from Raydium API
    const raydiumData = await getRaydiumPoolInfo(mint);

    // 3. Combine data sources
    const priceUsd = jupiterData?.priceUsd || raydiumData?.price || 0;
    const liquidity = raydiumData?.liquidity || 0;
    const volume24h = jupiterData?.volume24h || raydiumData?.volume24h || 0;

    // 4. Calculate market cap if we have price and supply
    let mcap = 0;
    if (options.supply && priceUsd > 0) {
        mcap = clampValue(options.supply * priceUsd, PRICE_BOUNDS.MIN_MCAP, PRICE_BOUNDS.MAX_MCAP);
    }

    return {
        priceUsd: clampValue(priceUsd, PRICE_BOUNDS.MIN_PRICE, PRICE_BOUNDS.MAX_PRICE),
        mcap,
        liquidity,
        volume24h: clampValue(volume24h, PRICE_BOUNDS.MIN_VOLUME, PRICE_BOUNDS.MAX_VOLUME),
        change24h: clampValue(jupiterData?.change24h, PRICE_BOUNDS.MIN_CHANGE_PCT, PRICE_BOUNDS.MAX_CHANGE_PCT),
        change1h: 0, // Not available from Jupiter free tier
        change5m: 0, // Not available from Jupiter free tier
        pairAddress: raydiumData?.poolAddress || null,
        dex: raydiumData?.dex || 'unknown',
        source: jupiterData ? 'jupiter' : (raydiumData ? 'raydium' : 'none'),
        timestamp,
        confidence: jupiterData?.confidence || 'low'
    };
}

/**
 * Batch fetch prices for multiple tokens
 * Priority: Raydium API > PumpFun On-Chain > Jupiter API
 * Philosophy: "onchain in truth" - prefer on-chain for PumpFun tokens
 *
 * @param {string[]} mints - Array of token mint addresses
 * @returns {Map<string, Object>} Map of mint -> price data
 */
async function fetchBatchPrices(mints) {
    if (!mints || mints.length === 0) return new Map();

    const results = new Map();
    const now = Date.now();

    // 1. PRIMARY: Batch fetch from Raydium API (FREE, works for graduated tokens)
    const raydiumPrices = await fetchRaydiumPrices(mints);

    // 2. Find tokens missing from Raydium
    const missingAfterRaydium = mints.filter(m => !raydiumPrices.has(m));

    // 3. SECOND: Try PumpFun on-chain for missing tokens
    // This catches tokens still on bonding curve that Raydium doesn't have
    let pumpfunPrices = new Map();
    if (missingAfterRaydium.length > 0) {
        pumpfunPrices = await fetchPumpFunOnChainPrices(missingAfterRaydium);
        // Filter out graduated tokens (they should have a price from Raydium)
        for (const [mint, data] of pumpfunPrices) {
            if (data.graduated) {
                pumpfunPrices.delete(mint);
            }
        }
    }

    // 4. THIRD: Try Jupiter for remaining missing tokens (if API key available)
    const missingAfterPumpFun = missingAfterRaydium.filter(m => !pumpfunPrices.has(m));
    let jupiterPrices = new Map();
    if (missingAfterPumpFun.length > 0 && JUPITER_API_KEY) {
        jupiterPrices = await fetchJupiterPrices(missingAfterPumpFun);
    }

    // 5. Fetch pool info for liquidity/volume (parallel, rate-limited)
    // Only for tokens NOT from PumpFun on-chain (which already has liquidity)
    const tokensNeedingPoolInfo = mints.filter(m => !pumpfunPrices.has(m));
    const poolPromises = [];
    for (const mint of tokensNeedingPoolInfo) {
        poolPromises.push(
            getRaydiumPoolInfo(mint)
                .then(data => ({ mint, data }))
                .catch(() => ({ mint, data: null }))
        );
    }

    // Limit concurrent pool requests
    const POOL_CONCURRENCY = 5;
    const poolResults = new Map();

    for (let i = 0; i < poolPromises.length; i += POOL_CONCURRENCY) {
        const batch = poolPromises.slice(i, i + POOL_CONCURRENCY);
        const batchResults = await Promise.all(batch);
        for (const { mint, data } of batchResults) {
            if (data) poolResults.set(mint, data);
        }
        // Small delay between batches
        if (i + POOL_CONCURRENCY < poolPromises.length) {
            await new Promise(r => setTimeout(r, 200));
        }
    }

    // 6. Combine results with priority: Raydium > PumpFun OnChain > Jupiter > Pool
    for (const mint of mints) {
        const raydium = raydiumPrices.get(mint);
        const pumpfun = pumpfunPrices.get(mint);
        const jupiter = jupiterPrices.get(mint);
        const pool = poolResults.get(mint);

        // If PumpFun on-chain data available, use it directly (highest confidence)
        if (pumpfun && pumpfun.priceUsd > 0) {
            results.set(mint, pumpfun);
            continue;
        }

        // Get price from Raydium (primary) or Jupiter (fallback)
        const priceUsd = raydium?.priceUsd || jupiter?.priceUsd || pool?.price || null;

        // Skip if we have no price data at all
        if (!priceUsd || priceUsd <= 0) continue;

        // Get liquidity/volume from pool info
        const liquidity = pool?.liquidity || null;
        const volume24h = pool?.volume24h || null;

        // Determine source and dex
        let source = 'pool';
        let dex = pool?.dex || 'unknown';
        if (raydium) {
            source = 'raydium';
            dex = pool?.dex || 'raydium';
        } else if (jupiter) {
            source = 'jupiter';
        }

        results.set(mint, {
            priceUsd: clampValue(priceUsd, PRICE_BOUNDS.MIN_PRICE, PRICE_BOUNDS.MAX_PRICE),
            mcap: 0, // Calculated separately with supply
            liquidity: liquidity !== null ? clampValue(liquidity, PRICE_BOUNDS.MIN_LIQUIDITY, PRICE_BOUNDS.MAX_LIQUIDITY) : null,
            volume24h: volume24h !== null ? clampValue(volume24h, PRICE_BOUNDS.MIN_VOLUME, PRICE_BOUNDS.MAX_VOLUME) : null,
            change24h: null, // Not available from Raydium price API
            change1h: null,
            change5m: null,
            pairAddress: pool?.poolAddress || null,
            dex,
            source,
            timestamp: now,
            confidence: raydium ? 'high' : 'medium'
        });
    }

    logger.debug(`[PriceProvider] Batch: ${results.size}/${mints.length} tokens (Raydium: ${raydiumPrices.size}, PumpFun: ${pumpfunPrices.size}, Jupiter: ${jupiterPrices.size})`);
    return results;
}

/**
 * Get cached price (for quick lookups without API call)
 */
function getCachedPrice(mint, maxAge = PRICE_CACHE_TTL) {
    const cached = priceCache.get(mint);
    if (cached && Date.now() - cached.timestamp < maxAge) {
        return cached.data;
    }
    return null;
}

// ============================================
// CACHE MANAGEMENT
// ============================================

const PRICE_CACHE_MAX_SIZE = 2000;

function evictOldestEntries() {
    if (priceCache.size <= PRICE_CACHE_MAX_SIZE) return;

    const toDelete = priceCache.size - PRICE_CACHE_MAX_SIZE;
    let deleted = 0;
    for (const key of priceCache.keys()) {
        if (deleted >= toDelete) break;
        priceCache.delete(key);
        deleted++;
    }
}

// Periodic cache cleanup
setInterval(() => {
    const now = Date.now();
    const staleThreshold = 30 * 60 * 1000;

    for (const [mint, cached] of priceCache) {
        if (now - cached.timestamp > staleThreshold) {
            priceCache.delete(mint);
        }
    }

    for (const [key, cached] of liquidityCache) {
        if (now - cached.timestamp > staleThreshold) {
            liquidityCache.delete(key);
        }
    }

    logger.debug(`[PriceProvider] Cache: ${priceCache.size} prices, ${liquidityCache.size} liquidity`);
}, 10 * 60 * 1000);

// ============================================
// EXPORTS
// ============================================

module.exports = {
    // Core functions
    getPrice,
    fetchBatchPrices,
    getCachedPrice,
    getSolPrice,

    // Individual source functions
    fetchRaydiumPrices,
    fetchJupiterPrices,
    getJupiterPrice,
    getRaydiumPoolInfo,
    calculateOnChainLiquidity,

    // PumpFun on-chain functions ("onchain in truth")
    fetchPumpFunBondingCurvePrice,
    fetchPumpFunOnChainPrices,
    derivePumpFunBondingCurve,

    // Program IDs (for external reference)
    PUMPFUN_PROGRAM_ID,
    PUMPSWAP_AMM_PROGRAM_ID,
    PYTH_SOL_USD_FEED,

    // Oracle functions
    getSolPricePyth,
    getSolPriceCoinGecko,

    // Utilities
    clampValue,
    evictOldestEntries,

    // Constants
    PRICE_BOUNDS,
    SOL_MINT,
    USDC_MINT,
    USDT_MINT
};
