# RPC Leak Verification Protocol

**Purpose**: Scientifically test each architectural hypothesis
**Duration**: 3-4 hours active monitoring
**Method**: Empirical observation through code instrumentation + Redis stats

---

## 🔬 Hypothesis Testing Framework

Each problem gets a **binary verdict**:
- ✅ **CONFIRMED**: Found evidence of leak (proceed with fix)
- ❌ **REJECTED**: Not a significant contributor (move to next)
- ⚠️ **PARTIAL**: Confirms some but not all predictions (refine hypothesis)

---

## ⚙️ Instrumentation Phase (15 minutes)

### Step 1: Add Logging to K-Score Updater

**File**: `src/tasks/kScoreUpdater.js`

Find the main update loop (likely around line 600+) and add:

```javascript
// INSTRUMENTATION: Track batch statistics
const BATCH_START_TIME = Date.now();
const BATCH_STATS = {
    totalTokens: 0,
    successCount: 0,
    failureCount: 0,
    costEstimate: 0,
};

// Before each batch starts:
logger.info(`[KScore] BATCH_START | time=${new Date().toISOString()} | tokens=${mints.length}`);

// For each token processed:
BATCH_STATS.totalTokens++;
BATCH_STATS.costEstimate += 45; // Conservative: 45 credits per K-Score update

// After batch completes:
const batchDuration = Math.round((Date.now() - BATCH_START_TIME) / 1000);
logger.info(`[KScore] BATCH_COMPLETE | duration=${batchDuration}s | success=${BATCH_STATS.successCount} | fail=${BATCH_STATS.failureCount} | estimatedCost=${BATCH_STATS.costEstimate}`);
```

### Step 2: Add Delta vs Full Counter

**File**: `src/tasks/kScoreUpdater.js`

In the `deltaConvictionAnalysis()` function:

```javascript
// INSTRUMENTATION: Track analysis type distribution
let DELTA_COUNT = 0;
let FULL_COUNT = 0;

// When returning delta analysis:
DELTA_COUNT++;
logger.debug(`[KScore] DELTA_USED for ${mint.slice(0,8)}`);

// When triggering full analysis:
FULL_COUNT++;
logger.warn(`[KScore] FULL_ANALYSIS_TRIGGERED for ${mint.slice(0,8)} (snapshots stale)`);

// Log stats every 10 tokens:
if ((DELTA_COUNT + FULL_COUNT) % 10 === 0) {
    const ratio = Math.round((DELTA_COUNT / (DELTA_COUNT + FULL_COUNT)) * 100);
    logger.info(`[KScore] RATIO: ${ratio}% delta, ${100-ratio}% full (${DELTA_COUNT}/${FULL_COUNT})`);
}
```

### Step 3: Add Metadata Updater Interval Logging

**File**: `src/tasks/metadataUpdater.js`

Find the main loop and add:

```javascript
// INSTRUMENTATION: Log update interval
let LAST_BATCH_TIME = Date.now();
const METADATA_INTERVAL_MS = 300000; // Assume 5 min, adjust as found

setInterval(() => {
    const now = Date.now();
    const intervalSinceLastBatch = now - LAST_BATCH_TIME;
    logger.info(`[Metadata] BATCH_STARTING | interval=${intervalSinceLastBatch}ms | tokens=${tokenCount}`);
    LAST_BATCH_TIME = now;
    // ... perform update ...
    logger.info(`[Metadata] BATCH_COMPLETE | tokens_updated=${updatedCount} | estimated_cost=${updatedCount * 2.5}`);
}, METADATA_INTERVAL_MS);
```

---

## 📊 Collection Phase (1-2 hours)

### Step 1: Start Docker + Capture Logs

```bash
# Terminal 1: Start services
docker-compose up -d
sleep 30
docker-compose exec api npm run db:init-full

# Terminal 2: Capture calculator logs
docker-compose logs -f calculator > /tmp/calculator.log 2>&1 &

# Terminal 3: Capture API logs
docker-compose logs -f api > /tmp/api.log 2>&1 &

# Let run for 1-2 hours...
```

### Step 2: Query Redis Statistics Every 5 Minutes

```bash
# Terminal 4: Create monitoring script
cat > /tmp/monitor_rpc.sh << 'EOF'
#!/bin/bash

while true; do
    echo "=== $(date) ===" >> /tmp/rpc_stats.log

    # Get all RPC method usage for current hour
    docker exec holdex-redis-1 redis-cli KEYS "rpc:method:*:2026-02-20*" | while read key; do
        count=$(docker exec holdex-redis-1 redis-cli GET "$key")
        echo "$key → $count" >> /tmp/rpc_stats.log
    done

    # Get per-node usage
    docker exec holdex-redis-1 redis-cli KEYS "rpc:node:*:2026-02-20*" | while read key; do
        count=$(docker exec holdex-redis-1 redis-cli GET "$key")
        echo "$key → $count" >> /tmp/rpc_stats.log
    done

    sleep 300  # Every 5 minutes
done
EOF

chmod +x /tmp/monitor_rpc.sh
/tmp/monitor_rpc.sh &
```

### Step 3: Extract Logs for Analysis

```bash
# After 1-2 hours, extract key data:

# K-Score batch timing
grep '\[KScore\] BATCH_' /tmp/calculator.log | tee /tmp/kscore_batches.txt

# Delta vs Full ratio
grep '\[KScore\] RATIO' /tmp/calculator.log | tee /tmp/kscore_ratio.txt

# Metadata updates
grep '\[Metadata\] BATCH' /tmp/calculator.log | tee /tmp/metadata_batches.txt

# All RPC stats
cat /tmp/rpc_stats.log | tee /tmp/all_rpc_stats.txt
```

---

## 🔍 Analysis Phase

### Analysis 1: K-Score Update Frequency

**From logs**:
```bash
# Count how many BATCH_START entries
grep -c "BATCH_START" /tmp/calculator.log
# Expected: 1-2 per hour, so 2-4 per 2 hours
# Problem if: >10 in 2 hours (indicates runaway loop)
```

**Interpretation**:
- 1-2 batches/2h = OK (every 60-120 min) → **credits under control**
- 5+ batches/2h = HIGH (every 20-40 min) → **LEAK CONFIRMED**
- 10+ batches/2h = CRITICAL (every 10-15 min) → **MAJOR LEAK**

### Analysis 2: Delta vs Full Ratio

**From logs**:
```bash
# Get final ratio
tail -1 /tmp/kscore_ratio.txt
# Expected format: "RATIO: 70% delta, 30% full (...)""
```

**Interpretation**:
- 60-80% delta = OK (snapshots staying fresh)
- 40-60% delta = MODERATE (snapshots stale ~2x per day)
- <40% delta = HIGH LEAK (most updates are expensive full analyses)

### Analysis 3: Metadata Update Interval

**From logs**:
```bash
# Extract intervals
grep "BATCH_STARTING" /tmp/calculator.log | awk '{print $(NF-2)}' | sort -n
# Shows: interval=300005ms, interval=299998ms, etc.
```

**Interpretation**:
- Intervals 250k-350k ms = OK (5 min refresh)
- Intervals <150k ms = HIGH (too aggressive)
- Intervals >600k ms = OK (10+ min refresh)

### Analysis 4: Method Breakdown from Redis

**From stats**:
```bash
# Calculate totals by method
awk -F' → ' '{ method=$(NF-1); count=$NF; total[method]+=count } END { for(m in total) print m, total[m] }' /tmp/rpc_stats.log | sort -k2 -rn
```

**Interpretation**:
- Compare to hypothesis breakdown:
  - getTokenLargestAccounts + getSignaturesForAddress: should be 50-70% (K-Score)
  - getTokenSupply + getAccountInfo: should be 5-15% (Metadata)
  - getAssetsByOwner + getMultipleAccounts: should be 2-5% (PnL + Snapshots)
  - Other: 20-30% (base API traffic)

---

## 📈 Decision Tree

```
IF K-Score batches/hour > 1.5:
  ✅ PROBLEM #1 CONFIRMED
  → Fix: Reduce K-Score update frequency
  → Save: 10-15k credits/day

IF Delta ratio < 50%:
  ✅ PROBLEM #2 CONFIRMED
  → Fix: Extend snapshot TTL (1h → 4h)
  → Save: 15-20k credits/day

IF Metadata interval < 5 min:
  ✅ PROBLEM #3 CONFIRMED
  → Fix: Add change-detection logic
  → Save: 5-10k credits/day

IF getMultipleAccounts > 5% of budget:
  ✅ PROBLEM #4 CONFIRMED
  → Fix: Verify snapshotter not duplicated
  → Save: 5k credits/day

IF NO problems confirmed:
  ⚠️ Leak is elsewhere
  → Re-examine pnlService batch sizes
  → Check for webhook spam
  → Look for hidden polling loops
```

---

## 🚀 Quick Start Commands

```bash
# All-in-one: Run verification suite
cd /tmp

# 1. Add instrumentation (MANUAL - edit files above)
echo "TODO: Add logging to calculator.js, kScoreUpdater.js, metadataUpdater.js"

# 2. Start monitoring
docker-compose -f ~/HolDex up -d
docker-compose logs -f calculator > calculator.log 2>&1 &
docker-compose logs -f api > api.log 2>&1 &

# 3. Create Redis monitoring
cat > monitor.sh << 'EOF'
#!/bin/bash
while true; do
    docker exec holdex-redis-1 redis-cli KEYS "rpc:*:*" | wc -l >> redis_key_count.txt
    sleep 60
done
EOF
chmod +x monitor.sh
./monitor.sh &

# 4. After 1-2 hours, analyze
grep "BATCH_" calculator.log | head -5
grep "RATIO:" calculator.log | tail -1
docker exec holdex-redis-1 redis-cli KEYS "rpc:method:*" | wc -l
```

---

## 📋 Deliverable After Verification

Create `RPC_LEAK_FINDINGS.md` with:
1. **Confirmed Problems**: Which of the 4 are real
2. **Statistics**: Exact numbers from Redis + logs
3. **Breakdown**: Attribution of 320k to each problem
4. **Fixes**: Specific code changes needed
5. **Savings**: Estimated credits recovered per fix

---

**Ready to instrument?** Proceed when you have 2-4 hours for active monitoring.

