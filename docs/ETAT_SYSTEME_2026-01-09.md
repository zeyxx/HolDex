# HolDex - Vision d'Ensemble
**Date**: 2026-01-09
**Auteur**: Audit automatique Claude

---

## Architecture Actuelle

```
                    ┌─────────────────────────────────────────┐
                    │           HELIUS WEBHOOKS               │
                    │  (9 launchpads Solana 2026)             │
                    │  - Pump.fun, PumpSwap                   │
                    │  - Raydium V4, LaunchLab, CLMM          │
                    │  - Meteora DBC, DLMM                    │
                    │  - Moonshot, Orca Whirlpool             │
                    └─────────────────┬───────────────────────┘
                                      │
                    ┌─────────────────▼───────────────────────┐
                    │         HOLDEX API (Render)             │
                    │                                         │
                    │  ┌──────────────────────────────────┐   │
                    │  │  /webhook/new-tokens             │   │
                    │  │  Reçoit events Helius            │   │
                    │  │  → Queue pour indexation         │   │
                    │  └──────────────────────────────────┘   │
                    │                                         │
                    │  ┌──────────────────────────────────┐   │
                    │  │  /api/tokens, /api/token/:mint   │   │
                    │  │  K-Score, verification           │   │
                    │  └──────────────────────────────────┘   │
                    │                                         │
                    │  ┌──────────────────────────────────┐   │
                    │  │  /api/space/watchlist            │   │
                    │  │  Watchlist utilisateurs          │   │
                    │  └──────────────────────────────────┘   │
                    └─────────────────┬───────────────────────┘
                                      │
          ┌───────────────────────────┼───────────────────────────┐
          │                           │                           │
          ▼                           ▼                           ▼
   ┌─────────────┐           ┌─────────────┐            ┌─────────────┐
   │  PostgreSQL │           │    Redis    │            │ Calculator  │
   │  TimescaleDB│           │   (Cache)   │            │   Worker    │
   │             │           │             │            │ (K-Score)   │
   └─────────────┘           └─────────────┘            └─────────────┘
```

---

## Etat des Branches (2 repos divergents)

### TON REPO (origin/main) - 20 commits uniques
| Priorité | Feature | Status |
|----------|---------|--------|
| **CRITICAL** | Helius webhook 9 launchpads | Actif |
| **CRITICAL** | DB schema fixes (participants) | Actif |
| **HIGH** | Watchlist feature complet | Actif |
| **HIGH** | Rate limiting fixes | Actif |
| **MEDIUM** | Token catchup service | Actif |
| **MEDIUM** | Security bigint-buffer fix | Actif |

### SOLLAMA58 (upstream/NewDexSOCKETS) - 15 commits uniques
| Priorité | Feature | Status |
|----------|---------|--------|
| **HIGH** | Admin panel fixes | Non mergé |
| **HIGH** | Homepage upgrade | Non mergé |
| **MEDIUM** | DB fixes (différents) | Non mergé |
| **LOW** | DB reset (fait sur son noeud) | N/A pour toi |

---

## Credits Helius

### Configuration Actuelle
- **Webhook ID**: `4a1ca70b-5932-4adf-b1f3-5e456b6cc913`
- **Type**: Enhanced (coût plus élevé mais données complètes)
- **Programs surveillés**: 9 launchpads

### Optimisations Appliquées
1. TTL sur cache Redis (évite re-fetch)
2. Delta mode (fetch seulement les changements)
3. Webhook au lieu de WebSocket (1 credit/token vs N RPC calls)

### Points d'Attention
- Le webhook enhanced consomme plus de credits que basic
- Surveiller le dashboard Helius pour anomalies
- Les 9 programs génèrent plus d'events qu'avant (2 programs)

---

## Sécurité Base de Données

### Tables Critiques
| Table | Intégrité | Notes |
|-------|-----------|-------|
| `tokens` | Signatures HMAC | sig_identity, sig_kscore, etc. |
| `participants` | Schema corrigé | e_score, tier, tier_icon |
| `holder_snapshots` | OK | Historique conviction |
| `candles_1m` | TimescaleDB | OHLCV prix |
| `k_score_history` | OK | Snapshots journaliers |

### Colonnes participants (Schema Corrigé)
```sql
-- AVANT (bug): cached_escore, cached_tier, escore_updated_at
-- APRES (fix): e_score, tier, e_score_updated_at
-- AJOUTÉ: rewards_lifetime
```

---

## Ce qui Fonctionne

- Webhook Helius reçoit les nouveaux tokens (9 launchpads)
- K-Score calculation (algorithm v10)
- Signatures cryptographiques (8 catégories)
- Watchlist backend + UI
- Rate limiting API

---

## Ce qui Nécessite Attention

### Urgent
1. **Sync avec sollama58** - Admin panel et homepage non mergés
2. **Monitoring credits** - 9 launchpads = plus d'events

### Moyen terme
1. **PR #7 fermée sans merge** - Coordonner avec sollama58
2. **Alertes watchlist** - Worker background à tester
3. **Error rate webhook** - 31% d'erreurs détectées

---

## Actions Recommandées

### Immédiat
```bash
# 1. Vérifier Render dashboard → déploie depuis main
# 2. Vérifier Helius dashboard → credits
# 3. Tester endpoint health
curl https://ton-api.onrender.com/api/health
```

### Cette Semaine
```bash
# 1. Cherry-pick admin fixes de sollama58
git cherry-pick 6039ced a7bfa5a a740a59

# 2. Cherry-pick homepage upgrade
git cherry-pick 5be1010 029422c
```

### Coordination sollama58
- Lui partager nos fixes webhook (PR sur son repo)
- Récupérer ses fixes admin (cherry-pick)
- Décider qui merge quoi pour éviter conflits

---

## Fichiers Clés Modifiés Récemment

| Fichier | Changement | Impact |
|---------|------------|--------|
| `render.yaml` | branch: main | Déploiement |
| `src/services/newTokenWebhook.js` | 9 launchpads | Discovery |
| `src/services/database.js` | Schema participants | Queries |
| `src/routes/webhooks.js` | PUT endpoint | Admin |
| `homepage.html` | Watchlist UI | Frontend |

---

## Contacts

- **sollama58**: upstream/NewDexSOCKETS maintainer
- **Helius Support**: Pour questions credits
- **Render Support**: Pour questions déploiement
