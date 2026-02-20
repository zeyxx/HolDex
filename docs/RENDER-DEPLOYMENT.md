# Render Deployment — Phase 3.3 Production Setup

> **Status**: Ready for Production Deployment
> **Helius Key**: ✅ Verified working (40% faster than public RPC)
> **Next Step**: Set environment variables on Render

---

## Quick Setup (5 minutes)

### 1. Log into Render Dashboard
```
https://dashboard.render.com/
Select: holdex-backend service
```

### 2. Set Environment Variables
Go to **Settings** → **Environment** → **Add Environment Variable**

Add these critical variables:

| Variable | Value | Status |
|----------|-------|--------|
| `HELIUS_API_KEY` | `ac94987a-2acd-4778-8759-1bb4708e905b` | ✅ Ready |
| `DATABASE_URL` | `postgresql://...` | ⏳ Update if needed |
| `ADMIN_PASSWORD` | `<secure-password>` | ⏳ Set strong password |
| `DATA_SIGNING_SECRET` | `<32+ char random>` | ⏳ Generate random |
| `WEBHOOK_SECRET` | `<32+ char random>` | ⏳ Generate random |
| `NODE_ENV` | `production` | ⏳ Set to production |

**Recommended**:
| Variable | Value |
|----------|-------|
| `REDIS_URL` | `redis://...` | If available |
| `ORACLE_WEBHOOK_SECRET` | `<32+ char random>` | For GASdf integration |
| `API_URL` | `https://holdex.example.com` | For webhooks |

### 3. Generate Secrets (bash)
```bash
# DATA_SIGNING_SECRET (32+ chars)
openssl rand -hex 32

# Output: abc123def456ghi789jkl012mno345pq
# Copy and paste into Render environment
```

### 4. Deploy
Once all variables are set:
```
Render auto-detects changes → Auto-redeploys service
OR manually trigger:
  Dashboard → Deploy → Manual Deploy
```

### 5. Verify Deployment
```bash
# Check logs
Render Dashboard → Logs tab

# Test API
curl https://holdex-backend.onrender.com/monitoring/health
# Expected: {"ok": true, "status": "healthy", ...}
```

---

## Environment Variable Details

### HELIUS_API_KEY ✅
```
Current: ac94987a-2acd-4778-8759-1bb4708e905b
Status: ✅ Verified working
Latency: 216ms (40% faster than public RPC)
Provider: Primary for all RPC calls
Fallback: Public Solana RPC if Helius fails
```

### DATABASE_URL (CRITICAL)
Format:
```
postgresql://user:password@host:port/database
```
- Check Render PostgreSQL service for current URL
- Must be accessible from backend service

### ADMIN_PASSWORD (CRITICAL)
- ≥12 characters recommended
- Used for admin endpoints (/admin/*)
- Should be strong and unique

### DATA_SIGNING_SECRET (CRITICAL)
- ≥32 characters
- Used for K-Score integrity verification
- Generate: `openssl rand -hex 32`

### WEBHOOK_SECRET (CRITICAL)
- ≥32 characters
- Used for Helius webhook verification
- Generate: `openssl rand -hex 32`

### NODE_ENV
```
production
```
- Enables security checks
- Validates critical config
- Fails startup if missing secrets

---

## Verification Checklist

After deployment, verify:

```bash
# 1. API is responding
curl https://holdex-backend.onrender.com/health
# ✅ 200 OK

# 2. Helius RPC is primary
curl https://holdex-backend.onrender.com/monitoring/health
# ✅ "status": "healthy"

# 3. Error metrics are persisted
curl https://holdex-backend.onrender.com/monitoring/errors
# ✅ Returns error metrics from PostgreSQL

# 4. Database connectivity
curl https://holdex-backend.onrender.com/admin/status
# ✅ Database connected

# 5. RPC failover working
# (Artificially disable Helius, should fall back to public)
```

---

## Monitoring Production

### Real-Time Metrics
```bash
# Watch error rate
watch -n 5 'curl -s https://holdex-backend.onrender.com/monitoring/errors | jq .summary'

# Check Helius credit usage
# (Monitor for RPC_RATE_LIMIT errors)
curl https://holdex-backend.onrender.com/monitoring/errors | jq '.errorsByType[] | select(.code | startswith("RPC_"))'
```

### Alert Thresholds
Monitor for these in logs/dashboard:

| Error | Threshold | Action |
|-------|-----------|--------|
| `RPC_RATE_LIMIT` | >10/hour | Check credit usage |
| `RPC_AUTH_FAILED` | >0 | Verify API key |
| `RPC_TIMEOUT` | >5/hour | Network issue |
| Health degraded | Any | Manual review |

---

## Rollback Procedure

If something breaks after deployment:

### Quick Rollback
```
Render Dashboard → Deploys tab → Previous deploy → Rollback
(Takes ~2 min)
```

### If Helius Key is Wrong
```
1. Update HELIUS_API_KEY in Render environment
2. Manual deploy
3. Monitor logs for "Helius provider initialized"
```

### If Database Connection Breaks
```
1. Check DATABASE_URL format
2. Verify database is running
3. Update environment variable
4. Redeploy
```

---

## Support

### Logs
```
Render Dashboard → Logs tab
- Real-time logs
- Search for errors
- Filter by level (error, warn, info)
```

### Monitoring
```
GET /monitoring/errors        # All errors
GET /monitoring/health        # System status
GET /monitoring/errors/:code  # Specific error
```

### Debug Commands
```bash
# Check if Helius is working
curl -s https://holdex-backend.onrender.com/monitoring/health | jq '.status'

# See RPC errors
curl -s https://holdex-backend.onrender.com/monitoring/errors | jq '.errorsByType | to_entries[] | select(.value.code | startswith("RPC_"))'
```

---

## Next Steps

✅ **Done**:
- Helius API key verified (40% faster)
- Error handler integrated
- Database persistence ready
- Monitoring endpoints ready

⏳ **TODO**:
1. Set environment variables on Render (5 min)
2. Deploy to production (2 min)
3. Verify monitoring is live (2 min)
4. Monitor Helius credit usage (ongoing)

🎯 **Phase 4**: Research ConnectorKit patterns for wallet integration

---

## Timeline

```
Now           →  Set Render env vars (5 min)
            →  Deploy (2 min)
            →  Verify (2 min)
            →  Production Live ✅

Tomorrow      →  Monitor credit burn
            →  Start Phase 4 research
```

---

**Ready to deploy. Just need to set environment variables on Render.**
