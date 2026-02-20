# Tier 1 Improvements — Wallet Integration & Error Handling

**Status**: Implementation-Ready
**Based on**: ConnectorKit + solana-dev-skill empirical analysis
**Implementation Time**: ~25 hours (phased)
**Risk Level**: LOW → MEDIUM (lowest risk first)

---

## Phase 1: SAFE FOUNDATION (No Breaking Changes)
Estimated: 5 hours | Risk: ZERO

### 1.1 Transaction Validator (NEW)
**File**: `src/utils/transactionValidator.js`

What it does:
- Validates transaction size (max 1232 bytes)
- Detects empty/corrupted transactions
- Warns on unusual patterns (all zeros, duplicates)
- Pre-signature validation → catches errors early

Impact: **Prevents silent transaction failures**

```javascript
// Usage:
const result = TransactionValidator.validate(transaction);
if (!result.valid) {
    logger.error('Invalid transaction', result.errors);
    throw new Error(`Transaction validation failed: ${result.errors[0]}`);
}
```

### 1.2 Transaction Tracker (NEW)
**File**: `src/utils/transactionTracker.js`

What it does:
- Tracks tx lifecycle: pending → confirmed/failed
- Maintains rolling cap (F(7)=13 transactions)
- Emits events on state changes
- Stores metadata: size, compute units, cluster

Impact: **UI can show real-time tx progress**

```javascript
// Usage:
tracker.trackTransaction({ signature, method: 'signAndSendTransaction' });
// Later, user polls or subscribes:
tracker.on('transaction:updated', (sig, status) => {
    updateUI(sig, status);
});
```

### 1.3 Enhanced Health Diagnostics (EXTEND)
**File**: `src/services/rpcHealth.js` (modify)

What changes:
- Add `diagnostics` object alongside status
- Accumulate per-component errors instead of just status string
- Provide error history (last 5 errors per component)

Impact: **Better debugging, clearer failure reasons**

Before:
```json
{ "helius": "unhealthy", "public": "healthy" }
```

After:
```json
{
  "helius": {
    "status": "unhealthy",
    "diagnostics": {
      "errors": ["invalid api key", "circuit breaker open"],
      "lastFailure": "2026-02-20T16:41:00Z",
      "consecutiveFailures": 5
    }
  }
}
```

---

## Phase 2: TYPED ERRORS (Refactoring Required)
Estimated: 12 hours | Risk: MEDIUM

### 2.1 Define Error Hierarchy
**File**: `src/utils/errors.js`

Base structure (copy ConnectorKit pattern):
```javascript
class HolDexError extends Error {
    constructor(code, message, context = {}) {
        super(message);
        this.code = code;
        this.context = context;
        this.timestamp = new Date().toISOString();
    }
}

// Specific error types
class RpcError extends HolDexError {
    constructor(method, statusCode, message) {
        super('RPC_ERROR', message, { method, statusCode });
        this.recoverable = statusCode >= 500 || statusCode === 429; // Retry-able?
    }
}

class TransactionError extends HolDexError {
    constructor(signature, reason) {
        super('TRANSACTION_ERROR', reason, { signature });
        this.recoverable = false; // Once failed, need new signature
    }
}

class WalletError extends HolDexError {
    constructor(operation, walletName) {
        super('WALLET_ERROR', `${operation} failed on ${walletName}`);
        this.recoverable = true; // Can retry/reconnect
    }
}
```

### 2.2 Error Factory Pattern
Simplify error creation:
```javascript
export const Errors = {
    rpcMethodFailed: (method, statusCode, err) =>
        new RpcError(method, statusCode, err.message),

    transactionFailed: (sig, reason) =>
        new TransactionError(sig, reason),

    walletNotConnected: (name) =>
        new WalletError('connect', name),

    transactionTooLarge: (size) =>
        new TransactionError(null, `Transaction ${size}B exceeds limit 1232B`),
};

// Usage:
throw Errors.rpcMethodFailed('getTokenAccounts', 401, innerError);
```

### 2.3 Type Guards for Error Handling
```javascript
function isRecoverable(error) {
    return error instanceof HolDexError && error.recoverable;
}

function isRpcError(error) {
    return error instanceof RpcError;
}

// Usage:
try {
    await rpc.call(method);
} catch (error) {
    if (isRecoverable(error)) {
        await sleep(exponentialBackoff(retries));
        return rpc.call(method);
    }
    throw error; // Not recoverable
}
```

---

## Phase 3: TRANSACTION LIFECYCLE (Observable Pattern)
Estimated: 6 hours | Risk: LOW

### 3.1 Wire Transaction Tracker into Signing Flow
**File**: `src/routes/webhooks.js` (or relevant signing flow)

Before:
```javascript
async sendTransaction(tx) {
    const sig = await wallet.sendTransaction(tx);
    return sig;
}
```

After:
```javascript
async sendTransaction(tx) {
    // Validate first
    const validation = TransactionValidator.validate(tx);
    if (!validation.valid) throw Errors.transactionTooLarge(validation.size);

    // Track
    tracker.trackTransaction({
        signature: null, // Not yet signed
        method: 'sendTransaction',
        size: validation.size,
    });

    try {
        const sig = await wallet.sendTransaction(tx);
        tracker.trackTransaction({ signature: sig });

        // Emit event for UI
        eventBus.emit('transaction:sent', { sig });

        return sig;
    } catch (error) {
        tracker.updateStatus(null, 'failed', error.message);
        throw error;
    }
}
```

### 3.2 Add Confirmation Polling
```javascript
async function waitForConfirmation(signature, commitment = 'confirmed') {
    const pollInterval = 500; // ms
    const maxWait = 60000; // 1 minute
    const start = Date.now();

    while (Date.now() - start < maxWait) {
        const status = await connection.getSignatureStatus(signature);

        if (status?.err) {
            tracker.updateStatus(signature, 'failed', JSON.stringify(status.err));
            throw Errors.transactionFailed(signature, status.err);
        }

        if (status?.confirmationStatus === commitment) {
            tracker.updateStatus(signature, 'confirmed');
            eventBus.emit('transaction:confirmed', { signature });
            return true;
        }

        await sleep(pollInterval);
    }

    throw new Error(`Timeout waiting for confirmation: ${signature}`);
}
```

---

## Phase 4: HEALTH + DIAGNOSTICS (Dashboard Ready)
Estimated: 2 hours | Risk: ZERO

### 4.1 Expose Diagnostic Endpoint
**File**: `src/routes/health.js`

New endpoint: `GET /api/health/diagnostics`

Response:
```json
{
  "rpc": {
    "helius": {
      "status": "degraded",
      "diagnostics": {
        "lastErrors": ["Circuit breaker open", "Rate limit exceeded"],
        "consecutiveFailures": 2,
        "recoveryEta": "2026-02-20T16:42:00Z"
      }
    },
    "wallet": {
      "status": "connected",
      "diagnostics": {
        "wallet": "Phantom",
        "transactions": { "pending": 0, "confirmed": 5, "failed": 0 }
      }
    }
  }
}
```

### 4.2 Surface in Dashboard (UI)
- Show diagnostics panel in dev tools
- Color-code errors: red=fatal, yellow=degraded, blue=recovering
- Display recovery ETA for circuit-broken providers

---

## IMPLEMENTATION CHECKLIST

### Phase 1: Foundation (Week 1, Mon-Tue)
- [ ] Create `src/utils/transactionValidator.js`
- [ ] Create `src/utils/transactionTracker.js`
- [ ] Extend `src/services/rpcHealth.js` with diagnostics
- [ ] Write tests for all three
- [ ] **Commit**: `[Tier 1] Phase 1: Foundation - Transaction validation & tracking`
- [ ] Verify zero breaking changes

### Phase 2: Typed Errors (Week 1, Wed-Thu)
- [ ] Create `src/utils/errors.js` with error hierarchy
- [ ] Add type guards (`isRpcError`, `isRecoverable`, etc.)
- [ ] Replace top 5 error-throwing functions (start with RPC, then wallet)
- [ ] Add error factory to each module that uses errors
- [ ] Write tests for error type guards
- [ ] **Commit**: `[Tier 1] Phase 2: Typed Errors - Error hierarchy & recovery flags`
- [ ] Run integration tests (expect some breakage, patch as found)

### Phase 3: Transaction Lifecycle (Week 2, Mon)
- [ ] Wire tracker into signing flow
- [ ] Add confirmation polling
- [ ] Emit events on state changes (transaction:sent, transaction:confirmed, transaction:failed)
- [ ] Subscribe UI to events
- [ ] Test with real wallet send
- [ ] **Commit**: `[Tier 1] Phase 3: Lifecycle - Transaction tracking & confirmation`

### Phase 4: Dashboard (Week 2, Tue)
- [ ] Create `/api/health/diagnostics` endpoint
- [ ] Add diagnostic UI panel
- [ ] Test diagnostics panel with RPC failures
- [ ] **Commit**: `[Tier 1] Phase 4: Dashboard - Diagnostic endpoint & UI`

---

## TESTING STRATEGY

### Phase 1 Tests
```bash
npm test src/utils/transactionValidator.test.js
npm test src/utils/transactionTracker.test.js
npm test src/services/rpcHealth.test.js
```

### Phase 2 Tests
```bash
npm test src/utils/errors.test.js
# Run existing error-throwing functions:
npm test src/tasks/kScoreUpdater.test.js
npm test src/routes/tokens.test.js
```

### Phase 3 Integration Tests
```bash
# Manual: Send transaction, observe:
# 1. tracker.trackTransaction() called
# 2. 'transaction:sent' event fired
# 3. Confirmation polling started
# 4. 'transaction:confirmed' event fired
# 5. UI updates with status
```

### Phase 4 Integration Tests
```bash
curl http://localhost:3000/api/health/diagnostics | jq .
# Verify: RPC status, error history, recovery ETA
```

---

## RISK MITIGATION

### Risk: Typed Errors Break Existing Code
**Mitigation**:
- Start with new functions only (validator, tracker, health)
- For existing error-throwing code, add dual-support:
  ```javascript
  // Old way still works:
  try { ... } catch (e) { logger.error(e.message); }
  // New way:
  try { ... } catch (e) { if (isRecoverable(e)) retry(); }
  ```
- Feature-flag the new error behavior until 100% migrated

### Risk: Transaction Tracker Memory Overhead
**Mitigation**:
- Rolling cap: only store F(7)=13 recent transactions
- Purge old entries from memory every 1 hour
- Lazy-load from Redis if more history needed

### Risk: Confirmation Polling Spins CPU
**Mitigation**:
- Exponential backoff (500ms → 1s → 2s) if no updates
- Max 60 seconds total wait (fail fast)
- Use WebSocket if available (cheaper than polling)

---

## SUCCESS CRITERIA

✅ **Phase 1**: Transaction validator catches malformed transactions before signing
✅ **Phase 2**: All RPC errors are typed; recovery decisions are automatic
✅ **Phase 3**: UI shows real-time transaction status (pending → confirmed)
✅ **Phase 4**: Dashboard diagnostics show RPC degradation + recovery ETA

---

## FOLLOW-UP (Tier 2+)

After Tier 1 completes:
- **Tier 2**: Silent-first wallet connection (no errors on init)
- **Tier 3**: Multi-wallet fallback (user connected with Phantom, fall back to Slope if needed)
- **Tier 4**: Transaction replay (if tx failed, automatically retry with new blockhash)

---

**Ownership**: Ralph (autonomous loop iteration 3-4)
**Target Completion**: End of Week 2 (Friday)
**Confidence**: 78% (based on ConnectorKit success + HolDex's existing health layer)

