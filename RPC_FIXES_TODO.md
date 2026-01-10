# RPC Credit Protection - TODO List

## COMPLETED (2026-01-10)

### P1: getHolderRetention Cache
- **File**: `src/tasks/kScoreUpdater.js:1061-1147`
- **TTL**: 24h
- **Key**: `retention:{mint}:{wallet}`
- **Saves**: ~120 RPC/token (6 calls × 20 holders)

### P2: Token-level Skip
- **File**: `src/tasks/kScoreUpdater.js:1181-1221`
- **Logic**: Skip if `holders_snapshot_check < 24h` AND `conviction_analyzed > 0`
- **Saves**: ~130 RPC/token/day

### P3: fetchTokenHolders Cache
- **File**: `src/tasks/kScoreUpdater.js:993-1059`
- **TTL**: 1h
- **Key**: `holders_list:{mint}`
- **Saves**: ~10 RPC/token/hour

---

## REMAINING TODO

### P4: Global Helius Rate Limit
- Add Redis counter for global 50 req/s limit
- Location: `heliusRpc()` function (kScoreUpdater.js:837)
- Prevent burst abuse

### P5: Disable Auto-Index on Public Search
- Location: `src/routes/tokens.js:2546`
- Currently: `indexTokenOnChain(search)` called on CA search
- Fix: Remove or add stricter rate limit

### P6: priceProvider.js Cache
- Locations:
  - `getPythPrice()` - line 149
  - `getRaydiumPoolPrice()` - line 515
  - `getPumpFunBondingPrice()` - line 658
- Add 1-5 min Redis cache

### P7: Audit getEnhancedTransactions
- Find all callers
- Ensure all have caching layer
- Check: deltaConvictionAnalysis, getNewTransactions

---

## ESTIMATED SAVINGS

| Status | RPC/day | Credits/day |
|--------|---------|-------------|
| Before | 50,000+ | 50,000+ |
| After P1-P3 | ~5,000 | ~5,000 |
| After All | ~1,000 | ~1,000 |

---

## BYPASS

Force refresh mode bypasses all caches:
```javascript
forceDeepRefreshMode = true
```

Or admin endpoint:
```
POST /admin/refresh-kscore?force=true
```
