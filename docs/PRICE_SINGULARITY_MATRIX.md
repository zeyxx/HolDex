# Price System - Singularity Matrix

> "onchain in truth" - Every price derivable from blockchain state

## Current State (Incomplete)

```
PRICE SOURCE HIERARCHY (current):
├── TOKEN PRICES
│   ├── Raydium API         ← API (centralized)
│   ├── PumpFun On-Chain    ← ON-CHAIN ✓
│   └── Jupiter API         ← API (centralized, paid)
│
└── SOL/USD PRICE
    └── CoinGecko API       ← API (centralized) ✗ BREAKS PHILOSOPHY
```

## Target State (Singularity)

```
PRICE SOURCE HIERARCHY (harmonious):
├── TOKEN PRICES (Token/SOL)
│   ├── PumpFun Bonding Curve    ← ON-CHAIN ✓ (pre-graduation)
│   ├── PumpSwap AMM Reserves    ← ON-CHAIN ✓ (post-graduation)
│   ├── Raydium Pool Reserves    ← ON-CHAIN ✓ (via vault balances)
│   ├── Orca Whirlpool Reserves  ← ON-CHAIN ✓
│   ├── Meteora Pool Reserves    ← ON-CHAIN ✓
│   └── Raydium API              ← API fallback (degraded mode)
│
└── SOL/USD PRICE
    ├── Pyth Oracle              ← ON-CHAIN ✓ PRIMARY
    ├── Switchboard Oracle       ← ON-CHAIN ✓ FALLBACK
    └── CoinGecko API            ← API (emergency only)
```

## The Complete Matrix

### Layer 1: Base Currency (SOL/USD)

| Source | Type | Priority | Confidence | Latency |
|--------|------|----------|------------|---------|
| Pyth Oracle | On-Chain | 1 (PRIMARY) | High | ~400ms |
| Switchboard Oracle | On-Chain | 2 | High | ~400ms |
| Chainlink (if available) | On-Chain | 3 | High | ~1s |
| CoinGecko API | Off-Chain | 4 (EMERGENCY) | Medium | ~500ms |

**Pyth Oracle Address:** `H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG`

### Layer 2: Token Prices (Token/SOL)

| Source | Type | Token State | Priority | Confidence |
|--------|------|-------------|----------|------------|
| PumpFun Bonding Curve | On-Chain | Pre-graduation | 1 | Highest |
| PumpSwap AMM | On-Chain | Post-graduation | 1 | Highest |
| Raydium AMM V4 | On-Chain | Graduated | 1 | High |
| Raydium CLMM | On-Chain | Graduated | 1 | High |
| Orca Whirlpool | On-Chain | Graduated | 1 | High |
| Meteora DLMM | On-Chain | Graduated | 1 | High |
| Raydium API | Off-Chain | Any | 2 (FALLBACK) | Medium |
| Jupiter API | Off-Chain | Any | 3 (PAID) | Medium |

### Layer 3: Derived Metrics

```
PRICE CALCULATION:
├── price_sol = on_chain_reserves_ratio
├── price_usd = price_sol × sol_usd_pyth
├── mcap = price_usd × total_supply
└── liquidity = quote_reserves × sol_usd × 2

φ-HARMONY:
├── Primary sources: φ² weight (2.618)
├── Secondary sources: φ weight (1.618)
└── Fallback sources: 1.0 weight
```

## Program IDs

```javascript
// On-Chain Price Sources
const PROGRAMS = {
    // Oracles (SOL/USD)
    PYTH: 'FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH',      // Pyth Price Feeds
    PYTH_SOL_USD: 'H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG', // SOL/USD feed
    SWITCHBOARD: 'SW1TCH7qEPTdLsDHRgPuMQjbQxKdH2aBStViMFnt64f',   // Switchboard

    // DEX AMMs (Token/SOL)
    PUMPFUN_BONDING: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    PUMPSWAP_AMM: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    RAYDIUM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    METEORA_DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
    METEORA_DBC: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB'
};
```

## Account Layouts

### Pyth Price Account (SOL/USD)

```
Offset | Size | Field
-------|------|------
0      | 4    | magic
4      | 4    | version
8      | 4    | type
12     | 4    | size
16     | 8    | price_type
24     | 8    | exponent
32     | 8    | num_components
40     | 8    | num_quoters
48     | 8    | last_slot
56     | 8    | valid_slot
64     | 8    | ema_price (confidence weighted)
72     | 8    | ema_confidence
80     | 8    | timestamp
88     | 8    | min_publishers
96     | 8    | drv2
104    | 8    | drv3
112    | 8    | drv4
120    | 8    | product_account
152    | 8    | next_price_account
184    | 8    | previous_slot
192    | 8    | previous_price
200    | 8    | previous_confidence
208    | 8    | previous_timestamp
216    | 8    | aggregate_price_status
224    | 8    | aggregate_price     ← READ THIS
232    | 8    | aggregate_confidence
```

### PumpFun Bonding Curve (already implemented)

```
Offset | Size | Field
-------|------|------
0      | 8    | discriminator
8      | 8    | virtual_token_reserves
16     | 8    | virtual_sol_reserves
24     | 8    | real_token_reserves
32     | 8    | real_sol_reserves
40     | 8    | token_total_supply
48     | 1    | complete (bool)
```

### Raydium AMM V4 Pool

```
Offset | Size | Field
-------|------|------
...    | ...  | ...
320    | 32   | base_mint
352    | 32   | quote_mint
384    | 32   | base_vault    ← Read balance
416    | 32   | quote_vault   ← Read balance
...    | ...  | ...
```

## Implementation Roadmap

### Phase 1: Pyth Oracle Integration (Priority)

```javascript
// lib/oracles/pyth.js

const PYTH_SOL_USD_ACCOUNT = 'H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG';

async function getSolPricePyth(connection) {
    const accountInfo = await connection.getAccountInfo(
        new PublicKey(PYTH_SOL_USD_ACCOUNT)
    );

    if (!accountInfo) return null;

    // Read aggregate price at offset 224 (8 bytes, i64)
    const price = accountInfo.data.readBigInt64LE(224);
    // Read exponent at offset 24 (4 bytes, i32)
    const exponent = accountInfo.data.readInt32LE(24);

    // Convert: price × 10^exponent
    const solPrice = Number(price) * Math.pow(10, exponent);

    return {
        price: solPrice,
        source: 'pyth_oracle',
        onChain: true,
        timestamp: Date.now()
    };
}
```

### Phase 2: On-Chain Pool Reserves

```javascript
// Already have PumpFun, add:
// - Raydium V4 vault balance reading
// - Orca Whirlpool tick data
// - Meteora bin data
```

### Phase 3: Full Singularity

```
VERIFICATION CHAIN:
1. Price from on-chain source
2. Cross-verify with secondary source
3. Anomaly detection (>5% divergence = alert)
4. Confidence scoring based on source count
```

## Confidence Matrix

```
SOURCE AGREEMENT:
├── 3+ on-chain sources agree     → confidence: 100%
├── 2 on-chain sources agree      → confidence: 90%
├── 1 on-chain + 1 API agree      → confidence: 70%
├── Only API sources              → confidence: 50%
└── Single source                 → confidence: 30%
```

## Harmony Score (φ Integration)

```
PRICE_HARMONY = √(
    (on_chain_coverage)^φ² ×
    (source_agreement)^φ ×
    (freshness)^1.0
)

where:
- on_chain_coverage = % of prices from on-chain
- source_agreement = % of sources agreeing within 1%
- freshness = 1 - (age_seconds / 60)
```

## Current Gaps

| Gap | Impact | Priority |
|-----|--------|----------|
| SOL/USD from CoinGecko | Breaks "onchain in truth" | P0 - Critical |
| PumpSwap AMM pools | Missing post-graduation prices | P1 - High |
| Raydium on-chain reserves | Uses API instead | P2 - Medium |
| Orca/Meteora pools | No direct integration | P3 - Low |

## Migration Path

```
CURRENT → SINGULARITY:

Week 1:
├── Implement Pyth SOL/USD
├── Fallback chain: Pyth → Switchboard → CoinGecko
└── Remove CoinGecko from primary

Week 2:
├── PumpSwap AMM integration
├── Raydium V4 on-chain reserves
└── Remove Raydium API from primary

Week 3:
├── Orca Whirlpool integration
├── Meteora DLMM integration
└── Full on-chain coverage

Week 4:
├── Cross-verification system
├── Anomaly detection
└── Harmony scoring
```

---

*"Don't trust, verify" - Every price verifiable on-chain*
*φ guides the weighting, blockchain provides the truth*
