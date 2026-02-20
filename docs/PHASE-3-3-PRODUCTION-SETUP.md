# Phase 3.3 — Production Deployment Setup

> **Status**: Production Readiness Checklist
> **Goal**: Fix RPC credit leak, wire credentials, verify monitoring

---

## 1. RPC Configuration (Fix Credit Leak)

### Current Issue
- `.env.local` has placeholder: `HELIUS_API_KEY=test_key_placeholder_replace_with_real`
- Without valid key, all RPC calls fall back to public Solana RPC (`api.mainnet-beta.solana.com`)
- Public RPC has strict rate limits → increased errors → wasted retries → credits burn inefficiently

### Solution: Get Helius API Key

1. **Create Helius Account** (if not exists):
   ```
   https://www.helius.dev/
   ```

2. **Generate API Key**:
   - Dashboard → API Keys → Create New Key
   - Choose plan (Free tier available for testing)
   - Copy key (format: `xxx-xxx-xxx-xxx-xxx`)

3. **Set Environment Variable**:
   ```bash
   # Development (.env.local)
   HELIUS_API_KEY=<your-actual-key>

   # Production (Render Environment Variables)
   # Dashboard → Settings → Environment
   HELIUS_API_KEY=<your-actual-key>
   ```

### Verification
```bash
# Test RPC connectivity with real key
node scripts/verify-rpc-connection.js

# Expected output:
# ✅ Helius RPC: Connected (latency: 245ms)
# ✅ Public RPC: Connected (latency: 512ms)
# ✅ Primary Provider: helius
# ✅ Fallback Available: yes
```

---

## 2. RPC Usage Monitoring

### What to Monitor

**Credit Burn Metrics** (persisted in `error_metrics` table):
- `RPC_RATE_LIMIT` — Hit rate limit (wasted request)
- `RPC_AUTH_FAILED` — Auth error (credentials issue)
- `RPC_TIMEOUT` — Timeout (slow provider or network)
- `RPC_SERVER_ERROR` — 500 error (provider down)

**Dashboard Endpoints**:
```
GET /monitoring/errors           # All error types
GET /monitoring/errors/RPC_*     # RPC-specific errors
GET /monitoring/health           # System health (alerts if RPC errors > 50)
```

### Setup
```bash
# 1. Errors already persisted to PostgreSQL (Phase 3.2)
# 2. Monitoring routes already query database
# 3. Dashboard can now query real credit burn metrics

# Verify monitoring is working:
curl http://localhost:3000/monitoring/errors
# Returns: error_metrics with RPC errors tracked over time
```

---

## 3. RPC Provider Priority

### Current Architecture
```
Request → RPCProvider.executeWithFallback()
           ↓
        Try Helius (primary) with rate limiting
           ↓ (if fails)
        Try Public RPC (fallback)
           ↓ (if all fail)
        Return error with typed error code
```

### With Real Helius Key
- ✅ Helius serves primary requests (lower latency, better rate limits)
- ✅ Public RPC only used for failover (rare)
- ✅ Credits burn at controlled rate
- ✅ Monitoring tracks any failures

### Health Checks
- `rpcHealth.js` monitors provider status every 30s
- Automatically routes around unhealthy providers
- Dashboard shows provider availability

---

## 4. Production Configuration Checklist

### Critical (Must Have)
- [ ] DATABASE_URL — PostgreSQL connection
- [ ] HELIUS_API_KEY — Real Helius API key
- [ ] ADMIN_PASSWORD — Secure password for admin endpoints
- [ ] DATA_SIGNING_SECRET — ≥32 char secret for K-Score integrity
- [ ] WEBHOOK_SECRET — ≥32 char secret for webhook verification

### Highly Recommended
- [ ] REDIS_URL — For rate limiting (else in-memory fallback)
- [ ] ORACLE_WEBHOOK_SECRET — For GASdf burn verification
- [ ] API_URL — Public domain for webhooks (e.g., https://holdex.example.com)
- [ ] SOLANA_WSS_URL — WebSocket endpoint for real-time data

### Monitoring Setup
- [ ] Error metrics persisted (Phase 3.2) ✓
- [ ] Monitoring endpoints accessible ✓
- [ ] RPC health checks running ✓
- [ ] Dashboard configured to query `/monitoring/errors`

---

## 5. Deployment Steps

### 1. Set Environment Variables
```bash
# On Render or your hosting provider
# Settings → Environment Variables

DATABASE_URL=postgresql://...
HELIUS_API_KEY=your-real-key-here
ADMIN_PASSWORD=secure-password
DATA_SIGNING_SECRET=32-character-minimum-secret
WEBHOOK_SECRET=32-character-minimum-secret
NODE_ENV=production
```

### 2. Restart Service
```bash
# Service automatically redeploys when environment changes
# Or manually trigger:
render-cli services restart --name holdex-backend
```

### 3. Verify Startup
```bash
# Logs should show:
# ✅ [ENV] HELIUS_API_KEY set
# ✅ [RPCProvider] Helius provider initialized (primary)
# ✅ [RPCProvider] Ready with 2 providers: helius → public
```

### 4. Test Error Tracking
```bash
# Monitor errors in real-time:
watch -n 2 'curl -s http://localhost:3000/monitoring/errors | jq'

# Check health status:
curl http://localhost:3000/monitoring/health
```

---

## 6. RPC Credit Usage Tracking

### Where Credits Are Spent

**High-Cost Operations** (prioritize optimization):
1. `getSignaturesForAddress()` — Historical wallet analysis
2. `getTokenAccounts()` — DAS token enumeration
3. `getEnhancedTransactions()` — Helius-specific enrichment

**Low-Cost Operations**:
- `getBalance()` — Single account balance
- `getTokenSupply()` — Token metadata
- `getTransaction()` — Single tx details

### Optimization Strategy

**Already Implemented**:
- ✅ Rate limiting (prevents wasteful retries)
- ✅ Health checks (routes around bad providers)
- ✅ Typed errors (RPC_RATE_LIMIT, RPC_TIMEOUT tracked)
- ✅ Error metrics (persisted for analysis)

**Next Steps**:
1. Monitor RPC error rates via `/monitoring/errors`
2. If RPC_RATE_LIMIT errors spike → increase retries or optimize queries
3. If RPC_TIMEOUT errors spike → consider adding redundant RPC provider

---

## 7. Testing Production Readiness

### Test Script
```bash
# Run all production checks
node scripts/production-readiness-check.js

# Checks:
# ✅ Database accessible
# ✅ Helius API key valid
# ✅ RPC connectivity (helius + public)
# ✅ Error metrics table exists
# ✅ Monitoring endpoints respond
# ✅ Admin password set
# ✅ Webhook secrets configured
```

### Load Testing
```bash
# Monitor RPC usage under load
npm run test:load

# Generates:
# - RPC request count per provider
# - Credit burn rate
# - Error distribution
# - P95 latency by operation
```

---

## 8. Monitoring Dashboard Setup

### Configure External Dashboard
```
Use Grafana / Datadog / New Relic to query:

SELECT error_code, severity, count, last_occurrence
FROM error_metrics
WHERE error_code LIKE 'RPC_%'
ORDER BY last_occurrence DESC;
```

### Key Metrics to Alert On
- **RPC_RATE_LIMIT** count > 10/hour → Increase rate limit or usage
- **RPC_AUTH_FAILED** count > 0 → Check API key validity
- **RPC_TIMEOUT** count > 5/hour → Network or provider issue
- **Health status degraded** → Manual investigation needed

---

## 9. Rollback / Emergency

### If Helius Key Compromised
1. Revoke key immediately (Helius dashboard)
2. Generate new key
3. Update HELIUS_API_KEY environment variable
4. Service auto-restarts

### If RPC Provider Down
1. Error metrics track it automatically
2. System falls back to public RPC (slower but works)
3. No action needed — automatic failover
4. Monitor `/monitoring/health` for degraded status

---

## 10. Next: ConnectorKit Integration (Phase 4)

Once Phase 3.3 is complete:
- Analyze ConnectorKit patterns for wallet integration
- Research transaction signing flow
- Design improvement areas
- See: [ConnectorKit Research Plan](../HOLDEX-CONNECTOR-PATTERN-ANALYSIS.md)

---

## Summary

**Phase 3.3 Deliverables**:
- ✅ Error metrics persisted (Phase 3.2)
- ✅ RPC monitoring infrastructure (monitoring routes)
- ✅ Production configuration guide (this document)
- ⏳ Helius API key configured (user action needed)
- ⏳ Production verification tests (scripts ready)

**Before Shipping**:
1. Get Helius API key from user
2. Run production-readiness-check.js
3. Verify monitoring endpoints work
4. Load test and monitor RPC credits
5. Deploy to production

**Expected Outcome**:
- RPC credit burn controlled and monitored
- All errors tracked in real-time
- Production-ready for Phase 4 (ConnectorKit research)
