# Architectural Problems Found — RPC Credit Leak Root Causes

**Date**: 2026-02-20
**Method**: Code path analysis + empirical falsification
**Confidence**: 42% (needs verification through Redis stats)
**Status**: Proposed problems ready for hypothesis testing

---

## 🎯 Summary

Current RPC consumption: **~320k credits/day** vs budgeted **~205k**
**Gap: +115k credits/day** (56% overage)

Found **4 major architectural problems** that leak RPC credits:

| # | Problem | Suspected Leak | Severity | Fix Time |
|---|---------|-----------------|----------|----------|
| 1 | K-Score continuous updates (full convictions) | 50-100k/day | **CRITICAL** | 4h |
| 2 | Delta analysis always triggers full analysis | 20-50k/day | **HIGH** | 2h |
| 3 | Metadata updater lacks selective caching | 10-30k/day | **HIGH** | 2h |
| 4 | Pool snapshotter running on calculator (duplicate?) | 10-20k/day | **MEDIUM** | 1h |

---

## 🔍 Problem #1: K-Score Continuous Updates (CRITICAL)

**Location**: `src/calculator.js` line 232-235
**Code**:
```javascript
// 4. Start K-Score Updater
logger.info('📈 Starting K-Score Updater...');
const kScoreUpdater = require('./tasks/kScoreUpdater');
kScoreUpdater.start(deps);
logger.info('✅ K-Score Updater Running');
```

**The Issue**:
- `kScoreUpdater.start()` runs a CONTINUOUS loop (NOT event-driven)
- Likely updates K-Score for **all verified tokens** on some interval (every 1-2 hours?)
- Each K-Score update costs ~40-50 credits:
  - `getTokenLargestAccounts` (1 credit) — top holder list
  - For each of top 5-21 holders: `getSignaturesForAddress` (1 credit each) → 5-21 credits
  - Total: **~30-50 credits per token**

**Calculation** (Hypothesis):
```
Verified tokens: ~100-500 (conservative: 200)
Cost per token: 45 credits (average)
Updates per day: 2-3 times (every 8-12 hours)
Daily leak: 200 × 45 × 2.5 = 22,500 credits/day

BUT if running every 4-6 hours:
Daily leak: 200 × 45 × 4 = 36,000 credits/day

OR if triggered on webhook activity (highly frequent):
Daily leak: Could be 50-100k/day
```

**Why It Leaks**:
- No early exit if K-Score hasn't changed
- No smart throttling between tokens
- Continuous loop doesn't respect RECALC_COOLDOWN_MS (only listener_worker respects this)
- Delta analysis always triggers FULL analysis if snapshots stale (see Problem #2)

**Falsification Plan**:
1. Add DEBUG logging to kScoreUpdater to track:
   - How many tokens processed per cycle
   - Time between cycles
   - Cost per token update
2. Monitor Redis keys: `rpc:node:calculator-*:*` for actual consumption
3. Check calculator logs for update frequency

---

## 🔍 Problem #2: Delta Analysis Fallback (HIGH)

**Location**: `src/tasks/kScoreUpdater.js` line 542-555
**Code**:
```javascript
async function deltaConvictionAnalysis(db, mint) {
    const snapshots = await loadHolderSnapshots(db, mint);

    if (snapshots.length === 0) {
        logger.info(`[Delta] ${mint.slice(0,8)}: No snapshots, need full analysis`);
        return null;
    }

    // Check if snapshots are fresh enough
    const newestSnapshot = Math.max(...snapshots.map(s => s.updated_at || 0));
    if (Date.now() - newestSnapshot > SNAPSHOT_TTL) {  // ← PROBLEM: 3600000ms = 1 hour
        logger.info(`[Delta] ${mint.slice(0,8)}: Snapshots stale, need full analysis`);
        return null;  // Triggers FULL conviction re-analysis
    }
    // ...delta analysis code...
}
```

**The Issue**:
- SNAPSHOT_TTL = 3600000ms = **1 hour** (line 227)
- After 1 hour, delta analysis returns `null` → triggers **full conviction analysis**
- Full analysis costs **3-5× more** than delta:
  - Delta: ~2-3 credits (2 pages × getEnhancedTransactions)
  - Full: ~50-100 credits (full holder analysis + new snapshots)

**Calculation** (Hypothesis):
```
Verified tokens: 200
Tokens needing full analysis per day: 200 × (24 hours / 1 hour TTL) = 200 × 24 updates
But delta handles most: assume 20% trigger full → 40 tokens/day doing full
Full analysis cost: 75 credits per token
Daily leak: 40 × 75 = 3,000 credits/day

WAIT, that's too low. What if ALL K-Score updates use delta?
200 tokens × 24 updates/day × 50 credits (avg of delta+full) = 240,000 credits/day
That explains the 320k! The issue is FREQUENCY, not the per-token cost.
```

**Why It's a Problem**:
- 1-hour TTL means snapshots expire constantly
- Most tokens end up doing full analysis every few hours
- Full analysis includes expensive getEnhancedTransactions (100 credits each in rpcHarmony.js line 251!)

**Falsification Plan**:
1. Track in logs: how many delta vs full analyses per hour
2. Monitor Redis: track which tokens hit delta vs full pathways
3. Calculate actual cost per token category

---

## 🔍 Problem #3: Metadata Updater (HIGH)

**Location**: `src/calculator.js` line 271-274
**Code**:
```javascript
// 6. Start Metadata Updater
logger.info('📊 Starting Metadata Updater...');
const metadataUpdater = require('./tasks/metadataUpdater');
metadataUpdater.start(deps);
logger.info('✅ Metadata Updater Running');
```

**The Issue**:
- Likely runs a continuous loop updating supply, price, liquidity for all tokens
- No conditional logic: updates even if values haven't changed
- May call:
  - `getTokenSupply` (1 credit) for every token
  - `getAccountInfo` (1 credit) for price/liquidity lookups
  - Per-token cost: **2-3 credits**

**Calculation** (Hypothesis):
```
Verified tokens: 200
Cost per token: 2.5 credits (supply + price check)
Update frequency: Every 5-10 minutes (aggressive refresh)
Daily updates: 24h × 60min / 7.5min = 192 updates
Daily leak: 200 × 2.5 × 192 = 96,000 credits/day

Even if only every 30 minutes:
192 / 6 = 32 updates/day
Daily leak: 200 × 2.5 × 32 = 16,000 credits/day
```

**Why It's a Problem**:
- No delta detection: should only refresh if price changed >5% or supply changed
- No cache-aware logic: might bypass Redis TTL from rpcHarmony.js
- Runs independently on every Calculator startup

**Falsification Plan**:
1. Check metadataUpdater.js for loop interval
2. Track Redis keys: `rpc:method:getTokenSupply:*` for actual call volume
3. Compare to expected (should be ~200 calls/day, not 1000+)

---

## 🔍 Problem #4: Pool Snapshotter Duplication (MEDIUM)

**Location**: `src/calculator.js` line 297-299
**Code**:
```javascript
// Pool Snapshotter - moved from API to reduce API RPC load
// Uses direct connection for getMultipleAccountsInfo (pool reserve tracking)
const { startSnapshotter } = require('./indexer/tasks/snapshotter');
startSnapshotter();
logger.info('📸 Pool Snapshotter ACTIVE (moved from API)');
```

**The Issue**:
- Comment says "moved from API" — but is it ALSO running on API?
- Check `src/index.js` line 504: "MOVED TO CALCULATOR: startSnapshotter()" ← was removed ✅
- BUT: Snapshotter uses batch `getMultipleAccounts` which costs credits
- If running continuously, could be 5-10k credits/day

**Calculation** (Hypothesis):
```
Assuming 100 pools tracked
getMultipleAccounts cost: varies (batch size dependent)
If fetching every 5 minutes: 288 calls/day
Per batch: ~1000 credits per 100 accounts = ~10 credits per pool
Daily: 288 × 10 × 100 pools = 288,000 credits (massive!)

More realistic: 50 pools, 30min refresh, ~2 credits per batch
Daily: 48 × 2 × 50 = 4,800 credits/day
```

**Why It's a Problem**:
- Code comment suggests it was moved (good) but no confirmation it's NOT also on API
- Batch operation cost unknown without seeing snapshotter.js
- Could be source of hidden leak if running twice

**Falsification Plan**:
1. Check if Pool snapshotter is ACTUALLY disabled on API (verify index.js line 504)
2. Monitor Redis: look for high getMultipleAccounts usage
3. Trace snapshotter logs for run frequency

---

## 📋 Verification Checklist (Priority Order)

### Phase 1: Confirm K-Score Update Frequency (IMMEDIATE)
- [ ] Add logging to kScoreUpdater.js: `logger.info()` when processing batch starts/ends
- [ ] Add timing: log minutes between batch starts
- [ ] Run for 1 hour, capture logs
- [ ] **Expected**: 1-2 batches/hour (means ~200-400 tokens processed/hour × 45 credits = 9-18k credits/hour)
- [ ] **Problem if**: >500 credits/minute (indicates runaway loop)

### Phase 2: Verify Delta vs Full Analysis Split (NEXT)
- [ ] Add counter in kScoreUpdater: `fullAnalysisCount`, `deltaAnalysisCount`
- [ ] Log periodically: `logger.info('[KScore] Stats: ${deltaCount} delta, ${fullCount} full this hour')`
- [ ] Run for 2 hours
- [ ] **Expected**: ~70% delta, ~30% full (means 1-hour TTL working)
- [ ] **Problem if**: >50% full analyses (means snapshots too frequently stale)

### Phase 3: Inspect Metadata Updater Interval (NEXT)
- [ ] Read `src/tasks/metadataUpdater.js` for `setInterval` or `while(true)` loop
- [ ] Find: what's the update interval? (search for `INTERVAL` or `ms)`)
- [ ] **Expected**: 10-30 minutes between full token updates
- [ ] **Problem if**: <5 minutes (aggressive, wastes credits)

### Phase 4: Confirm Pool Snapshotter State (NEXT)
- [ ] Run `grep -n "startSnapshotter" src/index.js` → should show ONLY in comment
- [ ] Verify line 504 comment matches actual removals
- [ ] Check Redis logs for `getMultipleAccounts` usage spike
- [ ] **Expected**: No startSnapshotter() call on API
- [ ] **Problem if**: Found duplicate call

### Phase 5: Calculate Actual Attribution (FINAL)
- [ ] From Redis stats: `rpc:node:calculator-*:method:*`
- [ ] Group by method, sum per method for 24h
- [ ] Calculate: (sum_per_method / TOTAL) × 100 = % breakdown
- [ ] Compare to hypothesis (K-Score 50-70%, Metadata 5-15%, Snapshotter 2-5%, Other 20-25%)

---

## 🎯 Expected Outcome

**If verified**:
- K-Score calculator: **50-75k credits/day** (biggest leak)
- Metadata updater: **10-30k credits/day**
- Pool snapshotter: **5-10k credits/day**
- Other: **20-30k credits/day** (acceptable baseline)
- **Total**: 85-145k/day (vs 320k actual = other issues remain)

**If different**:
- Re-analyze conviction analysis depth (maybe conviction_samples too high?)
- Check for hidden batch operations in pnlService or priceService
- Look for webhook spam triggering K-Score recalcs

---

## 🛠️ Quick Wins If Confirmed

1. **Reduce K-Score update frequency**: 2-3 times/day → 1-2 times/day = **10-15k savings**
2. **Extend snapshot TTL**: 1 hour → 4 hours = **15-20k savings** (fewer full analyses)
3. **Add delta detection to metadata**: only refresh if >5% change = **5-10k savings**
4. **Reduce conviction_samples**: 5 → 3 = **20-30k savings**

**Potential total savings: 50-75k credits/day (25% reduction)**

---

## 📊 Next Action

1. **Now**: Run `/redis` queries to get current method breakdown
2. **In 1h**: Verify which problem is actually the biggest consumer
3. **In 2h**: Implement fix for top consumer
4. **In 4h**: Re-run stats to validate savings

**Ready**: ✅

