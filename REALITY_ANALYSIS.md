# Reality Analysis: Where HolDex RPC Credits Go

**Objective**: Empirical observation of credit consumption through statistics, not theory

---

## 📊 Current State Analysis

### 1. Budget Model (from code)

**Helius DEVELOPER Plan** (default):
```
Monthly: 10,000,000 credits
Daily:   ~205,600 credits (10M / 30 × 0.618)
Hourly:  ~332,222 credits (205,600 × φ / 24)
Minute:  ~5,537 credits (hourly / 60)
```

**Per-Service Allocation** (φ-based):
```
API:        61.8% → ~126,800 credits/day
Calculator: 23.6% → ~48,500 credits/day
Listener:   9.0%  → ~18,500 credits/day
Worker:     5.6%  → ~11,500 credits/day
────────────────────────────────
Total:      100%  → ~205,600 credits/day
```

**Problem**: User's system uses ~320k credits/day according to earlier notes
- **Implication**: Running on GROWTH plan (50M/month) or higher
- **Current usage**: 320k × 30 = 9.6M/month = ~96% of DEVELOPER plan
- **Or**: Running multiple instances / redundant polling

---

## 🔍 RPC Call Sites (Where Credits Leak)

### High-Cost Operations (1+ credit each)

| Method | Cost | Purpose | Frequency |
|--------|------|---------|-----------|
| `getAccountInfo` | 1 | Account state lookup | High (batch) |
| `getTokenLargestAccounts` | 1 | Top holder list | High (batch) |
| `getTokenSupply` | 1 | Total supply query | Medium |
| `getMultipleAccounts` | Variable | Batch account lookup | Very high |
| `getTransaction` | 0.1-1 | Tx verification | Medium |
| `getSignaturesForAddress` | Variable | Address history | Medium |
| `getProgramAccounts` | Variable | Account scan | High (if used) |

### Known Call Sites

1. **indexer.js**: `getTokenSupply` for supply tracking
2. **pnlService.js**: Batch `getTokenLargestAccounts` + `getAccountInfo` (high volume)
3. **priceProvider.js**: `getAccountInfo` for pool state
4. **priceService.js**: `getAccountInfo` for price lookups
5. **pool_finder.js**: `getAccountInfo` for bonding curve
6. **calculator.js** (src/calculator.js): K-Score calculation (unknown volume - need to trace)

---

## 🎯 Phase 4 Analysis: RPC Leak Detection

To identify THE leak, we need **statistical fingerprints** of each component:

### Fingerprint 1: Method Breakdown
```
Query: Redis keys matching "rpc:method:*:2026-02-20-14"
Shows: Which methods consumed most credits in hour 14
Example pattern: "rpc:method:getAccountInfo:2026-02-20-14" → 5,420 credits
```

### Fingerprint 2: Per-Node Breakdown
```
Query: Redis keys matching "rpc:node:*:2026-02-20-14"
Shows: Which service (API/Calculator/Listener/Worker) used most
Example: "rpc:node:calculator-xxxx:2026-02-20-14" → 18,500 credits (at budget)
```

### Fingerprint 3: Anomaly Detection
```
Compare hourly patterns:
- Normal hour: 8,000-12,000 credits
- Anomaly hour: 45,000+ credits
- Indicates: Task running beyond budget (e.g., discovery re-triggered)
```

### Fingerprint 4: Accumulation Pattern
```
Daily trend:
- Hour 0-5:   Low (night baseline)
- Hour 6-12:  Spike (K-Score calc + API traffic)
- Hour 12-18: Sustained (continuous updates)
- Hour 18-24: Decline (market cooldown)
```

---

## 🏃 Commands to Capture Reality

### Start System & Monitor Live

```bash
# Terminal 1: Start Docker
docker-compose up -d
sleep 30
docker-compose exec api npm run db:init-full

# Terminal 2: Monitor RPC in real-time
docker-compose logs -f api | grep -E "RPC|Credit|ALERT|CRITICAL"

# Terminal 3: Query Redis statistics (every 5 seconds)
watch -n 5 'docker-compose exec redis redis-cli KEYS "rpc:*:2026-02-20-*" | wc -l'

# Terminal 4: Get top methods THIS hour
docker exec holdex-redis-1 redis-cli KEYS "rpc:method:*:$(date +%Y-%m-%d-%H)" | \
  xargs -I {} docker exec holdex-redis-1 redis-cli GET {} | \
  paste - - | sort -rn | head -10
```

### Extract Statistics After 1-2 Hours of Running

```bash
# Get all RPC usage for today
docker-compose exec redis redis-cli --raw KEYS "rpc:credits:day:2026-02-20" | \
  xargs -I {} docker-compose exec redis redis-cli GET {}

# Get per-method breakdown (today)
docker-compose exec redis redis-cli --raw KEYS "rpc:method:*:2026-02-20*" | sort | \
  xargs -I {} sh -c 'echo "{} → $(docker-compose exec redis redis-cli GET {})"'

# Get per-node breakdown (today)
docker-compose exec redis redis-cli --raw KEYS "rpc:node:*:2026-02-20*" | sort | \
  xargs -I {} sh -c 'echo "{} → $(docker-compose exec redis redis-cli GET {})"'
```

### Create Statistics Dashboard

```bash
# Save current stats to file (run every 15 min)
cat > /tmp/holdex_stats_$(date +%s).json << 'EOF'
{
  "timestamp": "$(date -Iseconds)",
  "daily_total": $(docker-compose exec redis redis-cli GET "rpc:credits:day:2026-02-20" || echo "0"),
  "top_methods": [
    # Will populate from Redis keys
  ],
  "per_node": {
    # Will populate from Redis keys
  }
}
EOF
```

---

## 📈 Expected Results (Hypothesis)

**Based on code analysis**, likely credit breakdown:

```
Daily Budget: ~205,600 credits

Actual Usage Hypothesis:
├─ API Requests          [5,000-10,000]  (user endpoints, cached)
├─ K-Score Calculator    [50,000-100,000] ← SUSPECT #1 (runs every min on N tokens)
├─ Price Updates         [30,000-50,000]  ← SUSPECT #2 (needs pool state)
├─ Holder Tracking       [20,000-40,000]  ← SUSPECT #3 (large batches)
├─ Token Discovery       [10,000-30,000]  ← SUSPECT #4 (if re-triggered)
└─ Background Tasks      [5,000-20,000]   (indexing, etc.)
────────────────────────
Total Estimate:          [120,000-250,000] ← Below 320k, so somewhere else is hidden
```

**Where's the 70k-200k gap?**
- [ ] Multiple instances of Calculator running?
- [ ] Continuous token discovery (should be disabled)?
- [ ] Webhook processing calling back?
- [ ] Silent polling threads?
- [ ] Connection pool with embedded queries?

---

## 🔧 Phase 4 Plan (After Reality Check)

Once we have statistics from running system:

1. **Hour 1**: Baseline - identify normal consumption
2. **Hour 2**: Spike test - trigger K-Score recalc, measure impact
3. **Hour 3**: Discovery test - run token discovery, measure cost
4. **Hour 4**: Full analysis - correlate spikes with code paths

**Outcome**: Exact answer to "which operation costs 50k credits?" or "which task triggers at peak?"

---

## 📝 Reality Checkpoint Checklist

**Before Phase 2.2-2.4**:
- [ ] Docker running, all services healthy
- [ ] Database initialized (9 tables, hypertable)
- [ ] API responding to oracle endpoints
- [ ] Redis connected and storing RPC stats
- [ ] 30 minutes of monitoring complete
- [ ] RPC daily total captured
- [ ] Top 3 methods identified
- [ ] Per-node usage breakdown captured
- [ ] Anomalies noted (spikes, gaps)
- [ ] Hypothesis formed about 320k → actual cost

**Then**: Design Phase 4 fixes based on ACTUAL data, not theory

---

## 🎯 Action Items

**Immediately** (next 30 min):
1. Start Docker: `docker-compose up -d`
2. Init DB: `docker-compose exec api npm run db:init-full`
3. Check health: `curl http://localhost/health`
4. Enable monitoring: Multiple terminals watching logs + Redis
5. Capture baseline stats

**Then** (after 1-2 hours):
1. Extract statistics
2. Identify culprits
3. Return findings
4. Plan Phase 4 with REAL data

**Then** (Phase 2.2+):
1. All fixes based on verified credit consumers
2. Discount logic on proven numbers
3. Render deployment with confidence

---

**Status**: Ready for reality check
**Approach**: Observe → Verify → Act (not Theorize → Code → Hope)
**Timeline**: 30 min setup + 1-2 hours monitoring = clear picture by tomorrow
