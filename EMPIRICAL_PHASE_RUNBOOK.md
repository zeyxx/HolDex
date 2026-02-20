# RPC Leak Empirical Phase — Runbook
**Date**: 2026-02-20
**Status**: Ready to Execute
**Duration**: 2-4 hours active monitoring

---

## 🎯 Objective
Capture actual RPC credit consumption patterns in running system to identify mystery 320k/day burn.

---

## 📋 Pre-Flight Checklist

- [ ] Docker running (`docker --version`)
- [ ] .env.local configured with HELIUS_API_KEY (real key, not placeholder)
- [ ] Redis CLI available (`redis-cli --version`)
- [ ] 2-4 hours uninterrupted monitoring time
- [ ] Terminal multiplexing available (tmux or 4+ terminal windows)

---

## 🚀 PHASE 1: Container Startup & Baseline (15 minutes)

### Step 1: Fresh Start
```bash
cd ~/HolDex

# Clean old containers
docker-compose down -v

# Start fresh
docker-compose up -d api redis db
sleep 30

# Verify health
docker-compose ps
# Expected: 3 services running (api, redis, db)
```

### Step 2: Database Init
```bash
# Initialize schema
docker-compose exec api npm run db:init-full

# Verify tables created
docker exec holdex-db-1 psql -U holdex_user -d holdex_production -c "\dt"
# Expected: 20+ tables (tokens, holders, kscores, etc.)
```

### Step 3: Baseline RPC Count (Before Activity)
```bash
# Terminal 2: Check Redis for any existing RPC keys
docker exec holdex-redis-1 redis-cli KEYS "rpc:*" | wc -l
# Record this number: baseline_count = X

# Get timestamp
date +%s > /tmp/baseline_timestamp.txt
```

**Expected baseline**: 0-50 keys (system idle)

---

## 📊 PHASE 2: Log Capture Setup (10 minutes)

### Step 1: Capture API Logs
```bash
# Terminal 3: Stream API logs
docker-compose logs -f api > /tmp/api.log 2>&1 &
API_LOG_PID=$!
echo $API_LOG_PID > /tmp/api_log.pid
```

### Step 2: Capture Calculator Logs (if running)
```bash
# Terminal 4: Start calculator service
docker-compose --profile workers up -d calculator
sleep 10

# Capture calculator logs
docker-compose logs -f calculator > /tmp/calculator.log 2>&1 &
CALC_LOG_PID=$!
echo $CALC_LOG_PID > /tmp/calc_log.pid
```

---

## 🔍 PHASE 3: Redis Monitoring Loop (1-2 hours)

### Step 1: Create Monitoring Script
```bash
# Terminal 5: Create the monitor
cat > /tmp/monitor_rpc.sh << 'MONITOR_EOF'
#!/bin/bash

OUTPUT_FILE="/tmp/rpc_monitoring.log"
INTERVAL_SECONDS=60
DURATION_MINUTES=120

echo "Starting RPC monitoring for ${DURATION_MINUTES} minutes..."
echo "=== Monitoring started at $(date) ===" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"

START_TIME=$(date +%s)
END_TIME=$((START_TIME + DURATION_MINUTES * 60))

iteration=0
while [ $(date +%s) -lt $END_TIME ]; do
    iteration=$((iteration + 1))
    echo "=== Iteration $iteration @ $(date '+%H:%M:%S') ===" >> "$OUTPUT_FILE"

    # Get all RPC method keys for today
    METHODS=$(docker exec holdex-redis-1 redis-cli KEYS "rpc:method:*:$(date +%Y-%m-%d)*" 2>/dev/null)

    if [ -z "$METHODS" ]; then
        echo "No RPC methods recorded yet" >> "$OUTPUT_FILE"
    else
        echo "RPC Methods breakdown:" >> "$OUTPUT_FILE"
        echo "$METHODS" | while read method_key; do
            count=$(docker exec holdex-redis-1 redis-cli GET "$method_key" 2>/dev/null || echo "0")
            echo "  $method_key → $count calls" >> "$OUTPUT_FILE"
        done
    fi

    # Get per-node usage
    echo "Per-node breakdown:" >> "$OUTPUT_FILE"
    NODES=$(docker exec holdex-redis-1 redis-cli KEYS "rpc:node:*:$(date +%Y-%m-%d)*" 2>/dev/null)
    if [ -z "$NODES" ]; then
        echo "  No per-node data yet" >> "$OUTPUT_FILE"
    else
        echo "$NODES" | while read node_key; do
            count=$(docker exec holdex-redis-1 redis-cli GET "$node_key" 2>/dev/null || echo "0")
            echo "  $node_key → $count calls" >> "$OUTPUT_FILE"
        done
    fi

    # Total RPC keys
    total_keys=$(docker exec holdex-redis-1 redis-cli KEYS "rpc:*" 2>/dev/null | wc -l)
    echo "Total RPC keys: $total_keys" >> "$OUTPUT_FILE"

    echo "" >> "$OUTPUT_FILE"

    sleep $INTERVAL_SECONDS
done

echo "=== Monitoring completed at $(date) ===" >> "$OUTPUT_FILE"
MONITOR_EOF

chmod +x /tmp/monitor_rpc.sh
```

### Step 2: Start Monitoring
```bash
# Run the monitor
/tmp/monitor_rpc.sh &
MONITOR_PID=$!
echo $MONITOR_PID > /tmp/monitor.pid
```

---

## 🔧 PHASE 4: Trigger Activity (30-60 minutes)

### Option A: Trigger via API (Controlled)
```bash
# Terminal 1: Make API calls to trigger RPC operations

# Search for a token (triggers K-Score calc if needed)
curl -s http://localhost:3000/search?q=SOL | jq .

# Get token holdings
curl -s http://localhost:3000/api/token/EPjFWdd5Au... | jq .

# Force metadata refresh (shouldn't trigger RPC, but let's see)
curl -s http://localhost:3000/api/token/EPjFWdd5Au.../refresh
```

### Option B: Webhook Simulation (If Available)
```bash
# Simulate Helius webhook transfer event
curl -X POST http://localhost:3000/webhooks/helius \
  -H "Content-Type: application/json" \
  -d @/tmp/sample_webhook.json
```

### Option C: Wait for Natural Activity
```bash
# Let system run for 1-2 hours
# Monitor will capture whatever activity occurs naturally
# Useful for seeing baseline/background operations
```

---

## 📈 PHASE 5: Data Analysis (30 minutes)

### Step 1: Extract Key Data
```bash
# After 1-2 hours, stop monitoring
kill $(cat /tmp/monitor.pid) 2>/dev/null
kill $(cat /tmp/api_log.pid) 2>/dev/null
kill $(cat /tmp/calc_log.pid) 2>/dev/null

# Archive logs
tar czf /tmp/rpc_monitoring_$(date +%Y%m%d_%H%M%S).tar.gz \
  /tmp/api.log \
  /tmp/calculator.log \
  /tmp/rpc_monitoring.log
```

### Step 2: Analyze Method Breakdown
```bash
# Extract RPC method distribution
grep "rpc:method:" /tmp/rpc_monitoring.log | \
  sed 's/.*rpc:method://; s/:.*→ / = /' | \
  sort | \
  awk -F' = ' '{count[$1]+=$2} END {for(m in count) print m, count[m]}' | \
  sort -k2 -rn > /tmp/method_breakdown.txt

cat /tmp/method_breakdown.txt
```

**Expected output format**:
```
getTokenLargestAccounts 1200
getSignaturesForAddress 950
getTokenSupply 400
getAccountInfo 850
getEnhancedTransactions 180
getMultipleAccounts 120
...
```

### Step 3: Calculate Credits Consumed
```bash
# Use CREDIT_COSTS from rpcHarmony.js to calculate totals
cat > /tmp/calculate_credits.sh << 'CALC_EOF'
#!/bin/bash

# Credit costs per method (from rpcHarmony.js)
declare -A COSTS=(
    [getTokenLargestAccounts]=1
    [getSignaturesForAddress]=1
    [getTokenSupply]=1
    [getAccountInfo]=1
    [getBalance]=1
    [getTransaction]=1
    [getEnhancedTransactions]=100
    [getMultipleAccounts]=5  # variable, estimate 5
    [getAssetsByOwner]=10
)

echo "=== RPC CREDIT BREAKDOWN ===" > /tmp/credits_breakdown.txt
TOTAL_CREDITS=0

while IFS=' ' read -r method count; do
    cost=${COSTS[$method]:-1}  # Default 1 if unknown
    credits=$((count * cost))
    TOTAL_CREDITS=$((TOTAL_CREDITS + credits))
    printf "%-40s %6d calls × %3d cr = %8d credits\n" \
        "$method" "$count" "$cost" "$credits" >> /tmp/credits_breakdown.txt
done < /tmp/method_breakdown.txt

echo "" >> /tmp/credits_breakdown.txt
echo "TOTAL CREDITS (2 hours): $TOTAL_CREDITS" >> /tmp/credits_breakdown.txt
echo "Extrapolated daily (12×): $((TOTAL_CREDITS * 12))" >> /tmp/credits_breakdown.txt

cat /tmp/credits_breakdown.txt
CALC_EOF

chmod +x /tmp/calculate_credits.sh
/tmp/calculate_credits.sh
```

### Step 4: Extract Log Patterns
```bash
# Find K-Score operations
grep -i "k-score\|conviction\|delta\|full" /tmp/calculator.log | head -20

# Find webhook processing
grep -i "webhook\|transfer\|verified" /tmp/api.log | head -20

# Find expensive RPC calls
grep -i "enhanced\|getAssetsByOwner\|getMultipleAccounts" /tmp/api.log
```

---

## 📊 PHASE 6: Results Interpretation

### Decision Matrix

**If getEnhancedTransactions > 5% of calls**:
```
→ PROBLEM: Called too frequently (should be <1%)
→ Action: Find what triggers getEnhancedTransactions
→ Suspect: K-Score analysis, PnL calculation
→ Fix: Reduce frequency, cache results
```

**If getTokenLargestAccounts + getSignaturesForAddress > 40% of calls**:
```
→ PROBLEM: K-Score holder analysis happening constantly
→ Action: Verify staleness logic (should be 1h+ TTL)
→ Suspect: Delta analysis fallback, webhook spam
→ Fix: Extend TTL, add debouncing
```

**If getMultipleAccounts > 10% of calls**:
```
→ PROBLEM: Batch account fetches too frequent
→ Action: Check snapshotter running on both API + Calculator
→ Suspect: Duplicate snapshotter, redundant batch ops
→ Fix: Disable duplicate, batch more aggressively
```

**If no clear pattern (evenly distributed)**:
```
→ PROBLEM: Unknown operation dominating
→ Action: Review grep results, check for hidden loops
→ Suspect: Background health checks, admin operations
→ Fix: Add more detailed logging to track source
```

---

## 🎯 Success Criteria

✅ **Investigation Complete** if:
- Identified which method consumes >30% of 320k credits
- Traced back to code location (file + line number)
- Proposed fix with estimated savings
- Verified fix doesn't break functionality

---

## 📋 Deliverable

After PHASE 6, create: `RPC_LEAK_IDENTIFIED.md` with:

```markdown
# RPC Leak Root Cause Identified

## Finding
[Method name] consumes [X]% of daily credits

## Evidence
- Monitoring period: [start] → [end]
- Total calls: [N] in 2 hours
- Extrapolated: [N×12] per day
- Code location: [file]:[line]

## Impact
- Current: 320k credits/day
- Attributed to this leak: [X]k credits/day
- Remaining mystery: [Y]k credits/day

## Root Cause
[Explanation of why it happens]

## Proposed Fix
[Code changes needed]
[Estimated savings: Z credits/day]

## Risk Assessment
[Downside if implemented]
```

---

## 🛑 Emergency Stop

If credit burn accelerates or system becomes unstable:
```bash
# Kill everything
docker-compose down

# Kill background monitors
pkill -f monitor_rpc.sh
pkill -f docker-compose logs

# Restore baseline
rm -f /tmp/*.log /tmp/*.pid
docker-compose up -d api redis db
```

---

## ✅ Ready?

Execute PHASE 1 when ready. Report back with:
1. Container health status
2. Database row counts
3. First iteration of RPC monitoring (to verify setup)

*sniff* Then we'll let it run and find the leak.
