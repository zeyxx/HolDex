# TODO REMAINING - RPC Credit Protection
## Date: 2026-01-10

---

## ✅ COMPLETED (Session terminée)

| # | Fix | Fichier | Impact |
|---|-----|---------|--------|
| P1 | getHolderRetention Redis Cache 24h | `kScoreUpdater.js:1061-1147` | -120 RPC/token |
| P2 | Token-level Skip si < 24h | `kScoreUpdater.js:1181-1221` | -130 RPC/token/day |
| P3 | fetchTokenHolders Cache 1h | `kScoreUpdater.js:993-1059` | -10 RPC/token/hour |

---

## ⏳ À FAIRE (Prochaine session)

### ✅ P4: Global Helius Rate Limit (DONE)
```
Fichier: src/services/heliusRateLimiter.js (nouveau)
Action: Redis sliding window 50 req/s global
Appliqué à: rateLimitedFetch(), solana.js Helius calls
```

### ✅ P5: Désactiver Auto-Index sur Search Public (DONE)
```
Fichier: src/routes/tokens.js:2538, 2565
Env var: DISABLE_AUTO_INDEX=true
Action: Skip indexTokenOnChain() et GeckoTerminal backfill
Économie: ~50 RPC par recherche unknown token
```

### ✅ P6: Cache Agressif priceProvider.js (DONE)
```
Fichier: src/services/priceProvider.js
Fonctions cachées:
  - getSolPricePyth() - Redis 5min TTL + rate limit
  - fetchPumpFunBondingCurvePrice() - Redis 30s TTL + rate limit
  - fetchPumpFunOnChainPrices() - rate limit par batch
```

### P7: Audit getEnhancedTransactions
```
Action: grep -r "getEnhancedTransactions" src/
Vérifier: Chaque appel nécessaire? Cache possible?
Coût: 1 crédit par call (très cher pour listes)
```

---

## 📊 Impact Estimé Global

| Métrique | Avant | Après P1-P3 | Après P4-P7 |
|----------|-------|-------------|-------------|
| Crédits/jour | ~50,000+ | ~5,000 | ~1,000 |
| Réduction | - | 90% | 98% |

---

## 🔧 Commandes Utiles

```bash
# Vérifier utilisation RPC
grep -r "helius" src/ --include="*.js" | wc -l

# Trouver tous les appels coûteux
grep -rn "getEnhancedTransactions\|getTokenAccounts\|getAssetsByOwner" src/

# Logs cache
grep "\[Cache\]\|\[Holders\]\|\[Retention\]" logs/
```

---

## 🧠 Brain Reference
Decision ID: `0883e79486f361a6`
Query: `brain_search("RPC credit protection")`
