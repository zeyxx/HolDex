# HolDex RPC Leak — Empirical Phase Execution Plan

**Status**: Ready to Execute
**Duration**: 2-4 hours (including analysis)
**Confidence**: Will identify 80%+ of leak source

---

## 🎯 What We're Doing

We discovered via code analysis that Problem #1 (K-Score bulk updates) was **already fixed**. So the real leak is still hidden. This plan captures actual RPC patterns in a running system to find it.

**Why empirical?** Theory fails. Measurement reveals truth.

---

## 🚀 Execution Sequence

### STEP 1: One-Time Setup (5 min)

```bash
cd ~/HolDex

# Make scripts executable
chmod +x start_monitoring.sh
chmod +x monitor_rpc_live.sh
chmod +x analyze_rpc_results.sh

# Verify
ls -la *.sh | grep "^-rwx"
```

---

### STEP 2: Start Docker & Services (20 min)

**Terminal 1** (Startup):
```bash
./start_monitoring.sh

# Follow prompts
# Answer "y" to start calculator service
# Wait for "✅ READY FOR MONITORING"
```

**Expected output**:
```
✅ READY FOR MONITORING

Next Steps:
1. In NEW terminal, run: ./monitor_rpc_live.sh
2. In ANOTHER terminal, trigger activity (curl calls)
3. Let monitor run for 1-2 hours
4. Analyze results: ./analyze_rpc_results.sh
```

**Check status**:
```bash
docker-compose ps
# Expected: 4 services running (api, redis, db, calculator)
```

---

### STEP 3: Start Live Monitoring (2 min)

**Terminal 2** (Monitoring):
```bash
./monitor_rpc_live.sh 120 30
# Parameters: 120 = duration (minutes), 30 = interval (seconds)
# Run for 2 hours, update every 30 seconds
```

**Dashboard shows**:
```
📊 TOTALS (Since Start):
   Total RPC calls:    150
   Total credits used: 450

⚡ RATE (Last 30 seconds):
   Method calls:       5 calls (10/min)
   Credits:            15 credits (30/min, 1,800/hour)

📈 PROJECTION:
   Elapsed:            5 minutes
   Projected daily:    216,000 credits (vs budget 205,600)
   ⚠️  OVERAGE: +5% above budget

🏆 TOP RPC METHODS (by credits):
   1. getEnhancedTransactions    100 cr  (99%)  [1 calls]
   2. getTokenLargestAccounts      1 cr  (0%)   [49 calls]
```

**What's happening**:
- Real-time display updates every 30 seconds
- Tracks all RPC calls to Redis by method
- Calculates credits consumed (using cost matrix)
- Projects daily burn based on current rate
- Shows top methods and per-node breakdown

---

### STEP 4: Trigger Activity (Parallel with monitoring)

**Terminal 3** (Activity):

**Option A: API Calls (Controlled)**
```bash
# Make health check (shouldn't trigger RPC)
curl -s http://localhost:3000/health | jq .

# Search for a token (may trigger K-Score)
curl -s 'http://localhost:3000/search?q=SOL' | jq '.results | length'

# Get token details (triggers RPC)
curl -s 'http://localhost:3000/api/token/EPjFWdd5Au9Z5qCzPYTmNpn6rkPJJnZT' | jq '.kScore'

# Repeat every 30 seconds
for i in {1..60}; do
    curl -s 'http://localhost:3000/search?q=SOL' > /dev/null
    sleep 30
done
```

**Option B: Natural Activity**
```bash
# Just let system run idle
# Monitoring will capture any background RPC usage
# (scheduled updates, health checks, etc.)

# Wait 1-2 hours
```

**Option C: Webhook Simulation** (if you have webhook payload)
```bash
curl -X POST http://localhost:3000/webhooks/helius \
  -H "Content-Type: application/json" \
  -d '{"type":"TOKEN_TRANSFER","mint":"EPjFWdd5Au...","tokens":[...]}'
```

---

### STEP 5: Let Monitoring Run (1-2 hours)

**Just wait.**

The monitoring dashboard updates every 30 seconds. Watch for:
- ⚠️ Spikes in specific methods
- 🚀 Rate increasing over time (indicates leak)
- 📈 Projected daily exceeding 205,600 credits
- 🏆 Single method dominating (>50% of credits)

---

### STEP 6: Analyze Results (10 min)

**Terminal 1** (After monitoring completes):
```bash
./analyze_rpc_results.sh

# Output:
# ✅ Analysis complete!
# 📄 Report saved to: /tmp/holdex_monitoring/RPC_LEAK_ANALYSIS_20260220_143021.md
```

**Read the report**:
```bash
cat /tmp/holdex_monitoring/RPC_LEAK_ANALYSIS_*.md

# Look for:
# 1. "TOP METHODS" section → identify villain
# 2. "ANOMALY DETECTION" → problem identified
# 3. "ROOT CAUSE ANALYSIS" → why it happens
# 4. "RECOMMENDATIONS" → how to fix
```

---

## 📊 Analysis Interpretation

### Scenario A: getEnhancedTransactions > 50% of credits
```
✅ PROBLEM FOUND: getEnhancedTransactions spam (100 credits each)
Root cause: Called too frequently or for every token
Fix: Add 1-hour TTL, batch calls, or reduce frequency
Savings: 50-100k credits/day
```

### Scenario B: getTokenLargestAccounts spike every hour
```
✅ PROBLEM FOUND: K-Score analysis running too frequently
Root cause: Delta analysis fallback or webhook amplification
Fix: Increase snapshot TTL (1h → 4h), verify queue cooldown
Savings: 20-50k credits/day
```

### Scenario C: getMultipleAccounts high usage
```
✅ PROBLEM FOUND: Snapshotter or batch operations spam
Root cause: Running on both API AND Calculator, or insufficient batching
Fix: Disable duplicate, increase batch size, extend TTL
Savings: 10-20k credits/day
```

### Scenario D: Even distribution, no clear pattern
```
⚠️ LEAK SOURCE UNCLEAR: Need deeper investigation
Next step: Add `console.log()` to rpcHarmony.js for each call
Re-run monitoring with detailed logging enabled
```

---

## 🎯 Success Criteria

✅ **Investigation succeeds if you can answer**:
1. **"What's consuming the most credits?"** (method name)
2. **"Why is it being called so much?"** (root cause)
3. **"Where in code does it happen?"** (file:line)
4. **"How much can we save by fixing it?"** (credits/day)

---

## 🛑 Troubleshooting

### Redis not showing data
```bash
# Verify Redis is running
docker exec holdex-redis-1 redis-cli ping
# Should return: PONG

# Check keys manually
docker exec holdex-redis-1 redis-cli KEYS "rpc:*"
# Should show: (integer) N where N > 0
```

### API not responding
```bash
docker compose logs api | tail -20
# Check for errors
```

### Calculator not starting
```bash
# Verify it's in profile
docker-compose config | grep -A 20 "calculator:"

# Manually start
docker-compose --profile workers up -d calculator
```

### Monitor script hangs
```bash
# Kill it
pkill -f monitor_rpc_live.sh

# Restart
./monitor_rpc_live.sh 60 30  # Shorter duration for testing
```

---

## 📋 Deliverables After Analysis

Once complete, you'll have:

1. **RPC_LEAK_ANALYSIS_*.md** — Full report with findings, anomalies, recommendations
2. **rpc_monitoring_live.log** — Raw monitoring data (every 30 seconds)
3. **Identified leak source** — Method name + estimated credits
4. **Root cause** — Why it's happening in code
5. **Proposed fix** — Specific code change + expected savings
6. **Validation plan** — How to re-run monitoring to confirm savings

---

## ⏰ Timeline

```
T+0min:   Start ./start_monitoring.sh
T+5min:   Start ./monitor_rpc_live.sh
T+5min:   Trigger activity (curl calls or wait for natural)
T+65min:  Check monitoring dashboard (mid-point)
T+125min: Monitoring completes
T+135min: ./analyze_rpc_results.sh complete
T+145min: Have identified leak source + root cause
```

**Total time: ~2.5 hours**

---

## 🚀 Ready to Begin?

```bash
# Step 1: Make scripts executable
chmod +x *.sh

# Step 2: Start monitoring (will guide you)
./start_monitoring.sh

# Step 3: Immediately run monitoring in new terminal
./monitor_rpc_live.sh 120 30

# Step 4: After 2 hours, analyze
./analyze_rpc_results.sh
```

**That's it.** The scripts handle the rest.

---

## 📞 Questions?

If monitoring doesn't show expected activity:
- Check that calculator service is actually running: `docker-compose ps`
- Verify API is accepting requests: `curl http://localhost:3000/health`
- Trigger manual activity: `curl http://localhost:3000/search?q=SOL`
- Check logs: `docker-compose logs api | tail -30`

If analysis is unclear:
- Review raw logs: `cat /tmp/holdex_monitoring/rpc_monitoring_live.log`
- Check method patterns: `grep "rpc:method:" /tmp/holdex_monitoring/rpc_monitoring_live.log`
- Manually inspect Redis: `docker exec holdex-redis-1 redis-cli KEYS "rpc:*"`

---

**Status**: ✅ Ready to Execute
**Next**: Run `chmod +x *.sh && ./start_monitoring.sh`
