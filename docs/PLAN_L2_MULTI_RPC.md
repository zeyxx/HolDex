# L2: Multi-RPC Fallback Architecture

## Overview

Transform HolDex from single-provider (Helius) to multi-provider oracle with intelligent fallback.

```
┌─────────────────────────────────────────────────────────────┐
│                    RPC PROVIDER LAYER                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │  Helius  │  │  Alchemy │  │QuickNode │  │  Public  │   │
│  │  (paid)  │  │  (paid)  │  │  (paid)  │  │  (free)  │   │
│  │ Enhanced │  │ Standard │  │ Standard │  │ Standard │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │             │             │             │          │
│       └─────────────┴──────┬──────┴─────────────┘          │
│                            │                                │
│                    ┌───────▼───────┐                       │
│                    │ Health Monitor│                       │
│                    │ + Router      │                       │
│                    └───────┬───────┘                       │
│                            │                                │
│              ┌─────────────┼─────────────┐                 │
│              ▼             ▼             ▼                 │
│         Standard RPC   Enhanced API   WebSocket            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Provider Capabilities Matrix

| Provider | Standard RPC | Enhanced TX | Token Accounts | WebSocket | Cost |
|----------|-------------|-------------|----------------|-----------|------|
| Helius | ✅ | ✅ | ✅ (DAS) | ✅ | $49/mo |
| Alchemy | ✅ | ❌ | ❌ | ✅ | $49/mo |
| QuickNode | ✅ | ❌ | ❌ | ✅ | $49/mo |
| Triton | ✅ | ❌ | ❌ | ✅ | $99/mo |
| Public | ✅ | ❌ | ❌ | ❌ | FREE |

**Key Insight**: Only Helius has Enhanced APIs. Others = fallback for standard RPC only.

## Architecture

### New Files

```
src/services/
├── rpcProvider.js          # Main provider abstraction
├── rpcHealth.js            # Health monitoring
├── providers/
│   ├── helius.js           # Helius-specific (Enhanced APIs)
│   ├── alchemy.js          # Alchemy adapter
│   ├── quicknode.js        # QuickNode adapter
│   └── public.js           # Public RPC fallback
```

### Core Interface

```javascript
// src/services/rpcProvider.js

class RPCProvider {
    constructor() {
        this.providers = new Map();
        this.health = new Map();
        this.priority = ['helius', 'alchemy', 'quicknode', 'public'];
    }

    // Standard RPC - any provider can handle
    async getAccountInfo(pubkey, options = {}) {
        return this.executeWithFallback('getAccountInfo', [pubkey], options);
    }

    async getMultipleAccountsInfo(pubkeys, options = {}) {
        return this.executeWithFallback('getMultipleAccountsInfo', [pubkeys], options);
    }

    async getTokenLargestAccounts(mint, options = {}) {
        return this.executeWithFallback('getTokenLargestAccounts', [mint], options);
    }

    // Enhanced APIs - Helius only, no fallback
    async getEnhancedTransactions(address, options = {}) {
        return this.providers.get('helius').getEnhancedTransactions(address, options);
    }

    async getTokenAccounts(mint, options = {}) {
        return this.providers.get('helius').getTokenAccounts(mint, options);
    }

    // Fallback execution
    async executeWithFallback(method, args, options = {}) {
        const errors = [];

        for (const providerId of this.getHealthyProviders()) {
            try {
                const provider = this.providers.get(providerId);
                const result = await provider[method](...args);
                this.recordSuccess(providerId);
                return result;
            } catch (e) {
                this.recordFailure(providerId, e);
                errors.push({ provider: providerId, error: e.message });
            }
        }

        throw new Error(`All providers failed: ${JSON.stringify(errors)}`);
    }

    getHealthyProviders() {
        return this.priority.filter(id => {
            const health = this.health.get(id);
            return health && health.status === 'healthy';
        });
    }
}
```

### Health Monitoring

```javascript
// src/services/rpcHealth.js

const HEALTH_CHECK_INTERVAL = 30000; // 30s
const FAILURE_THRESHOLD = 3;
const RECOVERY_THRESHOLD = 2;

class RPCHealth {
    constructor() {
        this.stats = new Map();
        // stats per provider: { successes, failures, latency[], lastCheck, status }
    }

    recordSuccess(providerId, latencyMs) {
        const stats = this.getStats(providerId);
        stats.successes++;
        stats.consecutiveFailures = 0;
        stats.latency.push(latencyMs);
        if (stats.latency.length > 100) stats.latency.shift();

        if (stats.status === 'degraded' && stats.successes >= RECOVERY_THRESHOLD) {
            stats.status = 'healthy';
            logger.info(`[RPC] ${providerId} recovered`);
        }
    }

    recordFailure(providerId, error) {
        const stats = this.getStats(providerId);
        stats.failures++;
        stats.consecutiveFailures++;
        stats.lastError = error.message;

        if (stats.consecutiveFailures >= FAILURE_THRESHOLD) {
            stats.status = 'unhealthy';
            logger.warn(`[RPC] ${providerId} marked unhealthy: ${error.message}`);
        }
    }

    getHealthyProviders(priority) {
        return priority.filter(id => {
            const stats = this.stats.get(id);
            return stats?.status !== 'unhealthy';
        });
    }

    getStats(providerId) {
        if (!this.stats.has(providerId)) {
            this.stats.set(providerId, {
                successes: 0,
                failures: 0,
                consecutiveFailures: 0,
                latency: [],
                status: 'healthy',
                lastError: null
            });
        }
        return this.stats.get(providerId);
    }
}
```

### Provider Adapters

```javascript
// src/services/providers/helius.js

class HeliusProvider {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.rpcUrl = 'https://mainnet.helius-rpc.com';
        this.enhancedUrl = 'https://api-mainnet.helius-rpc.com';
    }

    // Standard RPC
    async getAccountInfo(pubkey) {
        return this.rpcCall('getAccountInfo', [pubkey.toBase58()]);
    }

    // Helius-specific Enhanced API
    async getEnhancedTransactions(address, options = {}) {
        const params = new URLSearchParams({ 'api-key': this.apiKey });
        if (options.limit) params.append('limit', options.limit);
        if (options.before) params.append('before-signature', options.before);

        const url = `${this.enhancedUrl}/v0/addresses/${address}/transactions?${params}`;
        const response = await fetch(url);
        return response.json();
    }

    // Helius DAS API
    async getTokenAccounts(mint, options = {}) {
        return this.rpcCall('getTokenAccounts', { mint, ...options });
    }

    async rpcCall(method, params) {
        const response = await fetch(this.rpcUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error.message);
        return data.result;
    }
}
```

```javascript
// src/services/providers/public.js

class PublicProvider {
    constructor() {
        this.endpoints = [
            'https://api.mainnet-beta.solana.com',
            'https://solana-api.projectserum.com',
            'https://rpc.ankr.com/solana'
        ];
        this.currentIndex = 0;
    }

    async getAccountInfo(pubkey) {
        return this.rpcCall('getAccountInfo', [pubkey.toBase58()]);
    }

    async rpcCall(method, params) {
        const url = this.endpoints[this.currentIndex];
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
            });
            const data = await response.json();
            if (data.error) throw new Error(data.error.message);
            return data.result;
        } catch (e) {
            // Rotate to next endpoint
            this.currentIndex = (this.currentIndex + 1) % this.endpoints.length;
            throw e;
        }
    }
}
```

## Migration Plan

### Phase 1: Create Abstraction (Week 1)
- [ ] Create `rpcProvider.js` with provider interface
- [ ] Create `rpcHealth.js` for monitoring
- [ ] Create Helius adapter (extract from kScoreUpdater.js)
- [ ] Create Public adapter
- [ ] Unit tests

### Phase 2: Migrate Standard RPC (Week 1)
- [ ] Replace `getSolanaConnection()` usages with provider
- [ ] Update `solana.js` to use provider
- [ ] Update `priceProvider.js` to use provider
- [ ] Test fallback behavior

### Phase 3: Add Secondary Providers (Week 2)
- [ ] Add Alchemy adapter (if API key available)
- [ ] Add QuickNode adapter (if API key available)
- [ ] Configure priority order
- [ ] Add Redis-backed health state

### Phase 4: Dashboard & Monitoring (Week 2)
- [ ] Add `/api/health/rpc` endpoint
- [ ] Track provider usage in Redis
- [ ] Alert on provider failures
- [ ] Cost tracking per provider

## Environment Variables

```bash
# Primary (required)
HELIUS_API_KEY=xxx

# Secondary (optional - enables fallback)
ALCHEMY_API_KEY=xxx
QUICKNODE_URL=https://xxx.quiknode.pro/xxx

# Configuration
RPC_PROVIDER_PRIORITY=helius,alchemy,quicknode,public
RPC_HEALTH_CHECK_INTERVAL=30000
RPC_FAILURE_THRESHOLD=3
```

## Cost Optimization

| Scenario | Current Cost | With L2 |
|----------|--------------|---------|
| Helius healthy | 100% Helius | 100% Helius |
| Helius rate-limited | Fail | Fallback to public |
| Helius down | Fail | Fallback chain |
| Standard RPC burst | 100% Helius | Distribute load |

**Strategy**: Use free/cheap providers for standard RPC, reserve Helius credits for Enhanced APIs only.

## Success Metrics

1. **Availability**: 99.9% uptime (vs current ~99% with single provider)
2. **Latency**: P95 < 500ms for standard RPC
3. **Cost**: Reduce Helius credit usage by 30% (offload standard RPC)
4. **Resilience**: Survive single provider outage without user impact

## Open Questions

1. **Alchemy/QuickNode accounts**: Do we have them? Budget?
2. **WebSocket fallback**: Needed for listener_worker.js?
3. **Cross-validation**: Compare results between providers? (L3 feature?)

---

*Plan created: 2026-01-10*
*Status: DRAFT - Ready for review*
