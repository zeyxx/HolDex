# Phase 2: GASdf Integration Wiring — Complete

**Status**: Oracle endpoints verified, integration tests created, ready for E2E testing

---

## 📋 Phase 2.1: Oracle Endpoints Verification

### ✅ Endpoints Already Implemented

All 4 required oracle endpoints are **already implemented and mounted** at `/oracle`:

| Endpoint | Method | Purpose | Status |
|----------|--------|---------|--------|
| `/oracle/kscore/:mint` | GET | Check token acceptance (K-Score ≥ threshold) | ✅ Live |
| `/oracle/escore/:wallet` | GET | Get wallet engagement score & benefits | ✅ Live |
| `/oracle/discount/:wallet/:operation` | GET | Calculate fee discount | ✅ Live |
| `/oracle/costs` | GET | Get operation pricing constants | ✅ Live |
| `/oracle/webhook/burns` | POST | Record burn → update E-Score | ✅ Live |

### Quick Manual Verification

```bash
# 1. Check K-Score for Diamond token (USDC)
curl http://localhost/oracle/kscore/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# Expected: k_score: 100, accepted: true

# 2. Check E-Score for wallet
curl http://localhost/oracle/escore/2s91VW55dNZhp7SGE9cPzyBVpJKMVB5yJpCs6YqZBhHQ

# Expected: e_score: number, benefits: { discount: number, ... }

# 3. Calculate discount for operation
curl http://localhost/oracle/discount/2s91VW55dNZhp7SGE9cPzyBVpJKMVB5yJpCs6YqZBhHQ/token_transfer

# Expected: finalFee: number, discounts: { theoretical, effective, maxAllowed }

# 4. Get operation costs
curl http://localhost/oracle/costs

# Expected: operations: {token_swap: {...}, token_transfer: {...}, ...}

# 5. Test burn webhook (requires HMAC signature)
curl -X POST http://localhost/oracle/webhook/burns \
  -H "Content-Type: application/json" \
  -H "x-holdex-signature: <valid-hmac-sha256>" \
  -d '{
    "wallet": "2s91VW55dNZhp7SGE9cPzyBVpJKMVB5yJpCs6YqZBhHQ",
    "amount": 1000000,
    "txSignature": "xJvxvWQNnKk9XsWj82VzKQ4cCt1eBxbKphPGu6KFVwKbCJzMmxdqHPvFKCQ9HHW5vwEqK6yB1aU7e5Y2ksH4B12",
    "source": "gasdf"
  }'

# Expected: success: true, newEScore: number
```

---

## 🔐 Security Features Implemented

### 1. Input Validation
- ✅ Solana address validation (Base58 format, length 32-44 chars)
- ✅ Amount validation (positive finite number)
- ✅ Operation type validation (alphanumeric + underscore only)
- ✅ Transaction signature validation (87-88 chars, Base58)

### 2. Rate Limiting
- ✅ Oracle reads: 100/minute (per IP or API key)
- ✅ Webhook writes: 20/minute (per IP)
- ✅ Rate limit headers returned in response

### 3. Webhook Security
- ✅ HMAC-SHA256 signature verification (canonical JSON)
- ✅ Source validation (only accepts "gasdf")
- ✅ HTTP 401 on invalid signature

### 4. Caching
- ✅ K-Score cached in Redis (2-hour TTL)
- ✅ E-Score cached internally (configured TTL)
- ✅ Cache hit indicators in response

---

## 📊 Oracle Response Format

### K-Score Response (GET /oracle/kscore/:mint)

```json
{
  "success": true,
  "data": {
    "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "k_score": 100,
    "tier": "Diamond",
    "tier_icon": "💎",
    "accepted": true,
    "reason": null,
    "cached": false,
    "ttl": 7200
  }
}
```

### E-Score Response (GET /oracle/escore/:wallet)

```json
{
  "success": true,
  "data": {
    "wallet": "2s91VW55dNZhp7SGE9cPzyBVpJKMVB5yJpCs6YqZBhHQ",
    "e_score": 45.23,
    "tier": {
      "name": "Gold",
      "icon": "🥇",
      "color": "#FFD700"
    },
    "is_registered": true,
    "benefits": {
      "discount": 0.15,
      "freeCalls": 50,
      "rateLimit": 1000,
      "priority": "high"
    },
    "display": "Gold Tier | 45.23 pts",
    "progress": {
      "current": 45,
      "nextTier": 50,
      "remaining": 5
    }
  }
}
```

### Discount Response (GET /oracle/discount/:wallet/:operation)

```json
{
  "success": true,
  "data": {
    "wallet": "2s91VW55dNZhp7SGE9cPzyBVpJKMVB5yJpCs6YqZBhHQ",
    "operation": "token_transfer",
    "e_score": 45.23,
    "discounts": {
      "theoretical": 0.22,
      "maxAllowed": 0.15,
      "effective": 0.15
    },
    "baseFee": 1000,
    "finalFee": 850,
    "isViable": true
  }
}
```

### Burn Webhook Request (POST /oracle/webhook/burns)

```json
{
  "wallet": "2s91VW55dNZhp7SGE9cPzyBVpJKMVB5yJpCs6YqZBhHQ",
  "amount": 1000000,
  "txSignature": "xJvxvWQNnKk9XsWj82VzKQ4cCt1eBxbKphPGu6KFVwKbCJzMmxdqHPvFKCQ9HHW5vwEqK6yB1aU7e5Y2ksH4B12",
  "source": "gasdf",
  "x-holdex-signature": "<hmac-sha256-hex>"
}
```

**Webhook Response**:
```json
{
  "success": true,
  "data": {
    "wallet": "2s91VW55dNZhp7SGE9cPzyBVpJKMVB5yJpCs6YqZBhHQ",
    "amount": 1000000,
    "newEScore": 46.5,
    "tier": "Gold"
  }
}
```

---

## 🧪 Integration Testing

### Run Integration Tests

```bash
# Full test suite (requires running API)
npm test tests/integration/oracle-gasdf.test.js

# Or run with verbose output
NODE_OPTIONS='--test-reporter=tap' npm test tests/integration/oracle-gasdf.test.js
```

### Test Coverage

| Component | Tests | Status |
|-----------|-------|--------|
| K-Score Oracle | 4 tests | ✅ Hardcoded, unknown, caching |
| E-Score Oracle | 2 tests | ✅ Valid, invalid wallet |
| Discount Oracle | 2 tests | ✅ Valid, invalid operation |
| Costs Oracle | 1 test | ✅ Returns constants |
| Burn Webhook | 3 tests | ✅ Valid sig, invalid sig, invalid amount |
| Full GASdf Flow | 1 test | ✅ End-to-end token→discount |
| Rate Limiting | 1 test | ✅ Rapid requests |

**Total: 14 integration tests**

---

## 🔗 GASdf Integration Checklist

### Prerequisites
- [ ] HolDex running with database initialized (`docker-compose exec api npm run db:init-full`)
- [ ] Oracle endpoints responding (`curl http://localhost/oracle/costs`)
- [ ] Redis cache working (used for K-Score TTL)

### K-Score Integration
- [ ] GASdf calls `/oracle/kscore/:mint` before accepting token
- [ ] Handles K-Score threshold correctly (default: 50)
- [ ] Caches response for 2 hours (TTL)
- [ ] Falls back to hardcoded tokens (SOL, USDC, USDT, $ASDF)

### E-Score Integration
- [ ] GASdf calls `/oracle/escore/:wallet` to get benefits
- [ ] Applies discount from E-Score tier
- [ ] Handles unregistered wallets gracefully
- [ ] Shows tier progression to user

### Discount Calculation
- [ ] GASdf calls `/oracle/discount/:wallet/:operation` for exact fee
- [ ] Uses returned `finalFee` in quote
- [ ] Handles operations: token_transfer, token_swap, etc.
- [ ] Validates negative amounts rejected

### Burn Webhook
- [ ] GASdf sends burn notification to `/oracle/webhook/burns`
- [ ] Includes HMAC-SHA256 signature header
- [ ] HolDex updates E-Score on burn
- [ ] Wallet can immediately see new tier benefits

### Full E2E Flow
```
GASdf User:
  1. Search for token (USDC)
  2. GASdf calls /oracle/kscore/USDC_MINT → gets tier + acceptance
  3. Get user's wallet E-Score: /oracle/escore/USER_WALLET
  4. Calculate discount: /oracle/discount/USER_WALLET/token_transfer
  5. Show quote with discounted fee
  6. User approves transaction
  7. GASdf executes, then notifies: POST /oracle/webhook/burns
  8. HolDex updates E-Score, user sees new tier
```

---

## 📈 Performance Targets

| Endpoint | p50 | p95 | p99 |
|----------|-----|-----|-----|
| GET /kscore | 5ms (cached) | 50ms | 100ms |
| GET /escore | 10ms | 80ms | 150ms |
| GET /discount | 15ms | 100ms | 200ms |
| POST /webhook/burns | 20ms | 120ms | 250ms |
| GET /costs | 2ms | 10ms | 30ms |

**Target**: p95 latency < 100ms (for all reads)

---

## 🚀 Phase 2.1 → Phase 2.2 Next

**Phase 2.2 (Task 2.2)**: Enhance discount calculation with dual-burn ecosystem bonus

**What's next**:
1. Verify fees flow correctly in quote endpoint
2. Add discount bonuses for ASDF token holders
3. Implement dual-burn flywheel (76.4% burn, 23.6% treasury)
4. Create Phase 3 observability dashboards

**Time budget**: 4 hours (Oracle verification: 2h, Task 2.2: 2h)

---

## 📝 Files Created/Updated

- ✅ `tests/integration/oracle-gasdf.test.js` (300 LOC) — Integration test suite
- ✅ `PHASE_2_INTEGRATION.md` (this file) — Complete integration guide

**Files Already Existing**:
- ✅ `src/routes/oracle.js` (750+ LOC) — All oracle endpoints
- ✅ `src/index.js` — Oracle routes mounted at `/oracle`
- ✅ `src/services/harmonyEngine.js` — E-Score calculation
- ✅ `src/services/rpcMonitor.js` — RPC cost tracking

---

**Version**: Phase 2.1 Complete — 2026-02-20
**Next**: Phase 2.2 (Enhanced Discount Calculation) — 2 hours
**Overall Progress**: 14/70 hours completed (Phase 1 + Phase 2.1)
