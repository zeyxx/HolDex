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

### P4: Global Helius Rate Limit
```
Fichier: src/services/solana.js (ou nouveau middleware)
Action: Redis counter 50 req/s max pour TOUS les appels Helius
Pattern: Leaky bucket ou sliding window
```

### P5: Désactiver Auto-Index sur Search Public
```
Fichier: src/routes/tokens.js:2546
Action: Commenter ou conditionner indexNewToken() sur recherche publique
Raison: Chaque search "unknown token" déclenche indexation = ~50 RPC
```

### P6: Cache Agressif priceProvider.js
```
Fichier: src/services/priceProvider.js
Fonctions à cacher:
  - getPythPrice() - TTL 30s
  - getRaydiumPoolPrice() - TTL 30s
  - getPumpFunPrice() - TTL 30s
Pattern: Redis cache avec fallback
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
