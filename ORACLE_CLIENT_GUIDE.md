# HolDex Oracle Client Guide for GASdf

**Quick reference for integrating GASdf with HolDex oracle endpoints**

---

## 🚀 Quick Start

```javascript
// GASdf Code

const ORACLE_BASE = 'http://holdex:3000/oracle';

// 1. Check if token is accepted
const kscoreResp = await fetch(`${ORACLE_BASE}/kscore/${mint}`);
const { k_score, accepted, tier } = await kscoreResp.json();

if (!accepted) {
  return { error: `Token not accepted (K-Score: ${k_score})` };
}

// 2. Get user's discount
const discountResp = await fetch(
  `${ORACLE_BASE}/discount/${userWallet}/token_transfer`
);
const { finalFee, baseFee, discounts } = await discountResp.json();

// 3. After transaction, notify of burn
const signature = createHmac('sha256', secret)
  .update(JSON.stringify({
    amount, source: 'gasdf', txSignature, wallet
  }))
  .digest('hex');

await fetch(`${ORACLE_BASE}/webhook/burns`, {
  method: 'POST',
  headers: { 'x-holdex-signature': signature },
  body: JSON.stringify({
    wallet, amount, txSignature, source: 'gasdf'
  })
});
```

---

## 📚 Endpoint Reference

### 1. K-Score (Token Acceptance)

**Endpoint**: `GET /oracle/kscore/:mint`

**Purpose**: Check if a token is accepted for fee payment

**Parameters**:
- `mint` (string): Solana token mint address (Base58, 32-44 chars)

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "k_score": 100,
    "tier": "Diamond",
    "accepted": true,
    "reason": null,
    "cached": true,
    "ttl": 7200
  }
}
```

**Errors**:
- `400`: Invalid mint address format
- `500`: Database/cache error

**Hardcoded Accept List** (always K-Score 100):
- SOL (token address in config)
- USDC: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- USDT: `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenEb9`
- $ASDF: `9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump`

**Flow**:
```
┌─────────────────────┐
│ Token Mint Address  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Hardcoded Accepts?  │ ← Diamond (K-Score 100)
└──────────┬──────────┘
           │ No
           ▼
┌─────────────────────┐
│ Redis Cache?        │ ← 2h TTL
└──────────┬──────────┘
           │ No
           ▼
┌─────────────────────┐
│ Database Query      │ ← tokens.k_score
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ K-Score ≥ 50?       │ ← Threshold
└──────────┬──────────┘
           │
      ┌────┴────┐
      ▼         ▼
  Accepted   Rejected
```

---

### 2. E-Score (Participant Benefits)

**Endpoint**: `GET /oracle/escore/:wallet`

**Purpose**: Get user's engagement score and fee discount tier

**Parameters**:
- `wallet` (string): Solana wallet address (Base58, 32-44 chars)

**Response** (200 OK):
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

**Tier Scale**:
```
Tier          | E-Score | Discount | Free Calls | Priority
──────────────┼─────────┼──────────┼────────────┼──────────
Unregistered  | 0       | 0%       | 0          | low
Bronze        | 1-20    | 5%       | 10         | low
Silver        | 20-35   | 10%      | 25         | medium
Gold          | 35-50   | 15%      | 50         | high
Platinum      | 50-70   | 20%      | 100        | very high
Diamond       | 70+     | 25%      | 200        | ultra high
```

**E-Score Components**:
- Holdings (tokens owned)
- Burns ($ASDF burned in ecosystem)
- API calls (usage of HolDex)
- Apps (interactions with ecosystem)
- Nodes (running infrastructure)
- Referrals (bringing users)
- Duration (time active)

---

### 3. Discount Calculation

**Endpoint**: `GET /oracle/discount/:wallet/:operation`

**Purpose**: Calculate exact fee with discount applied

**Parameters**:
- `wallet` (string): Solana wallet address (Base58)
- `operation` (string): Operation type (alphanumeric + underscore)

**Supported Operations**:
- `token_transfer` — Simple token transfer
- `token_swap` — Swap via DEX
- `token_stake` — Staking operation
- `nft_mint` — NFT minting
- `nft_transfer` — NFT transfer

**Response** (200 OK):
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
    "isViable": true,
    "breakdown": {
      "escore_discount": 0.15,
      "asdf_bonus": 0.00,
      "loyalty_bonus": 0.00
    }
  }
}
```

**Fee Calculation**:
```
baseFee = operation_base_cost (in lamports)
discount = min(e_score_discount, MAX_DISCOUNT = 25%)
finalFee = baseFee × (1 - discount)
```

---

### 4. Operation Costs

**Endpoint**: `GET /oracle/costs`

**Purpose**: Get all operation costs and system constants

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "operations": {
      "token_transfer": {
        "baseFee": 1000,
        "cost": "0.001 SOL",
        "minFee": 100,
        "maxDiscount": 250
      },
      "token_swap": {
        "baseFee": 2500,
        "cost": "0.0025 SOL",
        "minFee": 250,
        "maxDiscount": 625
      }
    },
    "constants": {
      "PHI": 1.618033988749895,
      "RATIOS": { "burn": 0.764, "treasury": 0.236 },
      "SAFETY_MARGIN": 1.1,
      "MAX_DISCOUNT_CAP": 0.25,
      "DISCOUNT_ASYMPTOTE": 0.382
    },
    "acceptance": {
      "threshold": 50,
      "hardcodedTokens": [
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenEb9"
      ]
    }
  }
}
```

**Usage**: Cache this response daily to reduce API calls

---

### 5. Burn Webhook

**Endpoint**: `POST /oracle/webhook/burns`

**Purpose**: Notify HolDex of burn transaction (updates E-Score)

**Request Body**:
```json
{
  "wallet": "2s91VW55dNZhp7SGE9cPzyBVpJKMVB5yJpCs6YqZBhHQ",
  "amount": 1000000,
  "txSignature": "xJvxvWQNnKk9XsWj82VzKQ4cCt1eBxbKphPGu6KFVwKbCJzMmxdqHPvFKCQ9HHW5vwEqK6yB1aU7e5Y2ksH4B12",
  "source": "gasdf"
}
```

**Headers**:
```
x-holdex-signature: <hmac-sha256>
```

**HMAC Signature Calculation**:
```javascript
const crypto = require('crypto');

const canonical = JSON.stringify({
  amount: 1000000,
  source: 'gasdf',
  txSignature: '...',
  wallet: '2s91VW55dNZhp7SGE9cPzyBVpJKMVB5yJpCs6YqZBhHQ'
}, undefined, 0);  // No spaces, sorted keys

const signature = crypto
  .createHmac('sha256', HOLDEX_WEBHOOK_SECRET)
  .update(canonical)
  .digest('hex');

// Result: signature header
```

**Response** (200 OK):
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

**Errors**:
- `400`: Invalid amount or wallet format
- `401`: Invalid HMAC signature
- `403`: Unknown source (only "gasdf" allowed)
- `500`: Database/recording error

---

## 🔒 Security Checklist

- [ ] Validate all mint/wallet addresses (Solana Base58 format)
- [ ] Use HMAC-SHA256 for webhook signing
- [ ] Store `HOLDEX_WEBHOOK_SECRET` securely (environment variable)
- [ ] Verify webhook signature before processing
- [ ] Handle rate limits gracefully (100 reads/min, 20 writes/min)
- [ ] Retry failed webhooks with exponential backoff
- [ ] Log all oracle API calls for audit trail

---

## ⚡ Performance Tips

1. **Cache K-Score Responses** (2-hour TTL)
   - Store mint → tier mappings locally
   - Reduces oracle API calls by 90%

2. **Batch E-Score Queries**
   - If processing many wallets, queue requests
   - Prevents rate limit hits

3. **Use /costs Endpoint Once Daily**
   - Cache operation costs in your app
   - Reduces per-quote API calls

4. **Async Webhook Processing**
   - Don't block user on burn notification
   - Queue and process asynchronously

---

## 🧪 Testing

```bash
# Test endpoints locally
docker-compose up -d  # Start HolDex

# K-Score test
curl http://localhost/oracle/kscore/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# E-Score test
curl http://localhost/oracle/escore/2s91VW55dNZhp7SGE9cPzyBVpJKMVB5yJpCs6YqZBhHQ

# Discount test
curl http://localhost/oracle/discount/2s91VW55dNZhp7SGE9cPzyBVpJKMVB5yJpCs6YqZBhHQ/token_transfer

# Costs test
curl http://localhost/oracle/costs

# Burn webhook test (see oracle-gasdf.test.js for signature generation)
```

---

## 📞 Support

**Issues?**

1. Check rate limits: `X-RateLimit-Remaining` header
2. Verify wallet/mint format (Base58, length 32-44)
3. Check webhook HMAC signature (use canonical JSON)
4. Review error response for details
5. Check HolDex logs: `docker-compose logs oracle`

---

**Oracle API Version**: 1.0
**Last Updated**: 2026-02-20
**Status**: Production Ready
