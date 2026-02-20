# HolDex RPC Leak Fix — Implementation Guide

## Problem
Calculator service burns 230,400+ credits/day due to continuous 401 Unauthorized errors with placeholder Helius API key.

## Solution
Replace placeholder `test_key_placeholder_replace_with_real` with a real Helius API key.

---

## Step 1: Obtain Real Helius API Key

1. Go to https://app.helius.dev/
2. Sign in or create account
3. Create a new API key from dashboard
4. Copy the key (format: `...your_key_here...`)

---

## Step 2: Update Configuration

### Option A: Via Environment Variable
```bash
cd /C/Users/zeyxm/Desktop/asdfasdfa/HolDex

# Create .env.local with real key
cat > .env.local << 'EOF'
HELIUS_API_KEY=your_real_api_key_here_paste_it
DATABASE_URL=postgres://holdex_user:secure_password_for_testing_12345678@db:5432/holdex_production
REDIS_URL=redis://redis:6379
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/
SOLANA_WSS_URL=wss://mainnet.helius-rpc.com/
PORT=3000
NODE_ENV=development
EOF

# Restart Calculator
docker-compose restart calculator
```

### Option B: Direct docker-compose.yml Edit
Edit line 40 in docker-compose.yml:
```yaml
api:
  environment:
    - HELIUS_API_KEY=your_real_api_key_here
```

Then:
```bash
docker-compose up -d api calculator
```

---

## Step 3: Verify Fix

### Monitor the logs for success
```bash
docker-compose logs calculator -f | grep -i "success\|holders\|helius"
```

**Good signs**:
- `[Holders] Cache HIT` → RPC calls working
- `[INFO] [RPCProvider] Ready` → Connected
- NO `invalid api key` errors

**Bad signs** (fix didn't work):
- Still seeing `401 Unauthorized`
- `[ERROR] Helius DAS failed`

### Check credit consumption
If you have Helius dashboard access:
- Expected: 50-100 credits/hour (actual K-Score calc)
- Before fix: 10,000+ credits/hour (all failed auths)

---

## Step 4: Monitor Credit Burn

Use the monitoring dashboard:
```bash
cd /C/Users/zeyxm/Desktop/asdfasdfa/HolDex
./monitor_rpc_live.sh
```

Expected after fix:
```
📊 TOTALS:
   Total RPC calls: ~300-500 (reasonable)
   Hourly rate: ~80-120 credits/hour

📈 PROJECTION:
   Projected daily: ~2,000-3,000 credits (vs budget 205,600 ✓)
```

---

## Rollback (if API key invalid)

If you get new 401 errors after updating:
```bash
# Revert to placeholder
export HELIUS_API_KEY="test_key_placeholder_replace_with_real"
docker-compose restart calculator

# Or disable Calculator entirely
docker-compose down calculator
```

---

## Expected Impact

| Metric | Before | After | Change |
|--------|--------|-------|--------|
| **Daily Credits** | 230,400 | ~2,000-3,000 | ✅ -98% |
| **Hourly Burn** | 9,600 | 80-120 | ✅ -99% |
| **Error Rate** | 100% | ~5% | ✅ Success |
| **K-Score Updates** | All fail | All succeed | ✅ Full functionality |

---

## Critical Files

Once fix is applied, verify these logs:
- `docker-compose logs calculator --tail=100` → Should show successful RPC calls
- `docker-compose logs api --tail=50` → Should show K-Score data being served

---

## Questions?

If fix doesn't work:
1. Double-check API key is correctly formatted (no spaces, full string)
2. Verify Helius account is active and has credits available
3. Check firewall isn't blocking helius-rpc.com
4. Restart docker: `docker-compose down && docker-compose up -d`

