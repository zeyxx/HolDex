# Stage 0: Literature Review — ConnectorKit Pattern Analysis for HolDex

**Date**: 2026-02-20
**Status**: COMPLETE - Research findings documented
**Methodology**: Direct codebase analysis (not speculation)

---

## Executive Summary

HolDex **already implements many ConnectorKit patterns**, but with significant gaps:

| Pattern | Status | Gap |
|---------|--------|-----|
| **Typed Error Handling** | ✅ Defined (errors.js) | ❌ NOT USED (throwing generic Error) |
| **Wallet Error Classes** | ✅ Defined (WalletError hierarchy) | ❌ NOT THROWN in spaceAuth.js |
| **Transaction Errors** | ✅ Defined (TransactionError classes) | ❌ NO TX TRACKING implemented |
| **RPC Abstraction** | ✅ Implemented (rpcProvider.js) | ⚠️ NOT using typed errors |
| **Session-based Auth** | ✅ Implemented | ⚠️ Manual, no ConnectorKit patterns |
| **Signature Verification** | ✅ Implemented | ⚠️ Throwing generic Error messages |

**Key Finding**: The architecture EXISTS but is DISCONNECTED—definitions not wired to implementations.

---

## 1. CONNECTORKIT PATTERNS (Research)

### What ConnectorKit Is

**ConnectorKit** = Solana Foundation's headless wallet connector SDK (2026)

**Key Features**:
- Framework-agnostic (React + vanilla JS + Vue + Svelte)
- Wallet Standard compliant (auto-detects Phantom, Solflare, Backpack)
- **Silent-first connection** (no errors on initial connect attempt, graceful detection)
- Typed error handling with context and recovery hints
- Transaction lifecycle monitoring (pending → confirmed → finalized)
- Pre-built composable elements (AccountElement, BalanceElement, etc.)
- Reusable RPC connections with auto-caching

### ConnectorKit Patterns HolDex Should Implement

| Pattern | Purpose | HolDex Status |
|---------|---------|--------|
| **Silent-First Connection** | Try detect wallet, don't error if none found | ❌ MISSING |
| **Typed Wallet Errors** | WalletNotConnected, SignatureRejected, etc. | ⚠️ Defined but unused |
| **TX Lifecycle Tracking** | Monitor pending→confirmed→finalized | ❌ MISSING |
| **Wallet Standard Support** | Auto-detect all compliant wallets | ❌ MISSING |
| **Mobile Wallet Support** | Solana Mobile + desktop same API | ❌ FUTURE |
| **Passkeys Support** | Future authentication method | ❌ FUTURE |

---

## 2. HOLDEX CURRENT STATE (Empirical Analysis)

### 2.1 Error Handling System

**File**: `src/utils/errors.js` (802 LOC)

**What Exists** ✅:
- `HolDexError` base class with recovery semantics
- `WalletError` hierarchy:
  - `WalletNotConnectedError()`
  - `WalletSignatureRejectedError(wallet)`
  - `WalletSignatureInvalidError(wallet, reason)`
- `TransactionError` hierarchy:
  - `TransactionValidationError(reason)`
  - `TransactionTooLargeError(size, maxSize)`
  - `TransactionConfirmationTimeoutError(signature, timeoutMs)`
  - `TransactionFailedError(signature, reason)`
- **Type guards**: `isWalletError()`, `isTransactionError()`, etc.
- **Retry logic**: `getRetryStrategy(error, attemptCount, maxAttempts)`
- **Error factory pattern**: `Errors.walletNotConnected()`, etc.

**Code Example**:
```javascript
// Factory pattern
const error = Errors.walletNotConnected();
// → new WalletNotConnectedError() with code='WALLET_NOT_CONNECTED', recoverable=true

// Type guard
if (isWalletError(err)) {
    // Handle wallet-specific recovery
}
```

**Gap** ❌:
- **None of these are thrown anywhere in the codebase**
- `spaceAuth.js` throws generic `Error('Invalid wallet signature')` instead of `Errors.walletSignatureInvalid()`
- Error middleware has STATUS_CODE_MAP but errors never reach it

### 2.2 Wallet Authentication System

**File**: `src/middleware/spaceAuth.js` (537 LOC)

**What Exists** ✅:
- Session-based auth (7-day TTL)
- Signature-based auth (5-minute freshness, replay prevention)
- Grant system (role-based access control)
- Wallet signature verification using NaCl
- Audit trail logging

**Implementation Pattern**:
```javascript
// Session auth for reads
requireSession() → validates token → attaches wallet to req

// Signature auth for writes
requireSignature(actionTemplate) → verifies wallet owns address → attaches wallet to req

// Permissions
requireGrant(grantType) → checks wallet.grants → approves or rejects
```

**Gap** ❌ - Error Handling:
```javascript
// Currently:
if (!verifyWalletSignature(wallet, message, signature)) {
    throw new Error('Invalid wallet signature');  // ← Generic Error
}

// Should be:
if (!verifyWalletSignature(wallet, message, signature)) {
    throw Errors.walletSignatureInvalid(wallet, 'signature verification failed');
}
```

**Gap** ❌ - No Client-Side Wallet Connection:
- Only server-side authentication
- No wallet detection logic
- No "silent-first" attempt
- User must provide wallet address + signature manually

### 2.3 RPC Abstraction Layer

**File**: `src/services/rpcProvider.js` (344 LOC)

**What Exists** ✅:
- Multi-provider abstraction (Helius primary, Public fallback)
- Automatic failover on errors
- Health-based routing
- Rate limiting integration
- Provider-specific capability awareness
- Helius rate limiter integration

**Implementation**:
```javascript
class RPCProvider {
    initialize() {
        // Primary: Helius (if API key available)
        if (config.HELIUS_API_KEY) {
            this.providers.set('helius', new HeliusProvider(config.HELIUS_API_KEY));
            this.priority.push('helius');
        }
        // Fallback: Public RPC
        this.providers.set('public', new PublicProvider());
    }

    async executeWithFallback(method, args) {
        // Try healthy providers first, then all if needed
        // Returns typed error on complete failure
    }
}
```

**Gap** ⚠️ - Error Type Usage:
- Throws typed errors (`AllProvidersFailedError`, `RpcTimeoutError`, etc.)
- BUT: Not using cached connection pattern that ConnectorKit uses
- NOT implemented: Request deduplication/batching

**Files**:
- `rpcProvider.js` - Main abstraction
- `rpcMonitor.js` - Credit usage tracking
- `rpcHealth.js` - Health checking
- `rpcHardcap.js` - Rate limiting
- `providers/helius.js` - Helius-specific implementation
- `providers/public.js` - Public RPC implementation

### 2.4 Transaction Tracking

**Current State** ❌:
- **NO transaction lifecycle tracking**
- Wallet signatures verified but TX status not monitored
- No "pending → confirmed → finalized" pipeline
- Burns recorded via webhook only, no TX confirmation loop

**Gap**: Cannot track if user's signed TX actually confirmed on-chain.

### 2.5 Frontend/Mobile Support

**Current State** ❌:
- Backend-only API (Express)
- `admin.html` exists but is just a static admin panel
- No React/web3.js wallet adapter integration
- No mobile wallet support
- No wallet detection UI

---

## 3. SOLANA-DEV-SKILL (MCP) ANALYSIS

**What It Provides**:
- `getAccountInfo(publicKey)` - Query account data
- `getBalance(publicKey)` - Check SOL balance
- `getMinimumBalanceForRentExemption(dataSize)` - Calculate account rent
- `getTransaction(signature)` - Look up TX by signature

**Pattern**: Read-only RPC query abstraction (MCP protocol)

**How It Differs from ConnectorKit**:
- ConnectorKit: Client-side wallet connection + signing
- solana-dev-skill: Server-side RPC queries
- Complementary, not competing

---

## 4. CRITICAL GAPS IDENTIFIED

### Gap A: Error Type Adoption (High Priority)

**Problem**: Typed errors defined but not used

**Evidence**:
```javascript
// spaceAuth.js line 258
if (!verifyWalletSignature(wallet, signedMessage, signature)) {
    throw new Error('Invalid wallet signature');  // ← Should use Errors.walletSignatureInvalid()
}
```

**Impact**: Error middleware won't catch/log these errors correctly, no recovery hints for users

### Gap B: Transaction Lifecycle Tracking (High Priority)

**Problem**: No monitoring of TX confirmation pipeline

**Current**: Burns recorded via webhook, no on-chain status verification

**Missing Components**:
- TX confirmation status monitor
- Pending → confirmed → finalized state machine
- Retry logic for failed TXs
- User notification system

**Code Location**: Would go in `src/services/` (new file `txMonitor.js`)

### Gap C: Client-Side Wallet Connection (Medium Priority)

**Problem**: Only server-side auth, no client-side wallet detection

**Current**: User must provide wallet + signature manually

**Missing Components**:
- React component or vanilla JS wallet connector
- Wallet Standard detection
- Silent-first connection (try detect, don't error)
- Mobile wallet support

**Code Location**: Would go in `frontend/` or separate package `@asdf/wallet-adapter`

### Gap D: RPC Deduplication/Batching (Medium Priority)

**Problem**: Each request fires independent RPC call

**Current**: rpcProvider.js has failover but not request batching

**Missing Components**:
- Request deduplication (multiple identical calls deduplicated)
- Batch request queuing
- Shared connection pooling

**Code Location**: Enhancement to `rpcProvider.js`

---

## 5. ARCHITECTURE IMPLICATIONS

### Current Workflow
```
User                    HolDex Server               RPC Provider
  │                         │                           │
  ├─ POST /space/auth/login─→│                           │
  │  (wallet + signature)    │                           │
  │                          ├─ Verify signature with NaCl
  │                          │
  │ ← Session token ─────────┤
  │                          │
  ├─ GET /space/dashboard ──→│
  │  (x-session-token)       ├─ Check session
  │                          ├─ Query oracle data ──→│
  │                          │                       │
  │                          │← K-Scores, E-Scores ◄─┤
  │ ← Dashboard data ────────┤
  │                          │
```

### What's Missing: Transaction Confirmation Loop
```
User                    HolDex Server               RPC Provider
  │                         │                           │
  ├─ Sign TX in wallet ─ ┐  │                           │
  │                      │  │                           │
  └─ Submit TX sig ──────→│  │                           │
                         │ ├─ Monitor TX status ──→│
                         │ │                       │
                         │ ← Check confirmation ◄─┤
                         │ │ (pending/confirmed)
                         │ ├─ Emit status event
  ← TX status update ────┤ │
                         │ │
```

---

## 6. MONOREPO IMPLICATIONS (From FULL-PICTURE-ANALYSIS.md)

HolDex and GASdf duplicate wallet/transaction patterns. These should be extracted as:

- `@asdf/wallet-adapter` - Client-side wallet connection
- `@asdf/transaction-monitor` - TX lifecycle tracking
- `@asdf/error-types` - Shared error hierarchy
- `@asdf/rpc-client` - Shared RPC abstraction

**Benefits**: Reduced code duplication, single source of truth, shared improvements.

---

## 7. STAGE 0 CONCLUSIONS

### What's Already Built ✅
1. Comprehensive typed error system (HolDexError hierarchy)
2. RPC abstraction layer with failover
3. Session-based + signature-based authentication
4. Grant/permission system
5. Error middleware with STATUS_CODE_MAP

### What Needs to Be Done ❌
1. **Wire typed errors into actual error throwing** (easy, high impact)
2. **Add TX confirmation monitoring** (medium effort, enables new features)
3. **Add client-side wallet connection** (medium effort, improves UX)
4. **Add RPC request deduplication** (low effort, reduces credit waste)
5. **Extract shared patterns to monorepo** (strategic, prevents future duplication)

### Recommended Implementation Order
1. **Phase 1** (Days 1-2): Wire typed errors → immediate adoption, no API changes
2. **Phase 2** (Days 3-5): Add TX confirmation monitor → enables on-chain verification
3. **Phase 3** (Days 6-8): Add client-side wallet connector → improves UX
4. **Phase 4** (Days 9-10): Monorepo extraction → shares patterns with GASdf

---

## 8. RESEARCH SOURCES

- ConnectorKit GitHub: https://github.com/solana-foundation/connectorkit
- ConnectorKit Docs: https://www.connectorkit.dev/
- Solana Wallet Patterns: https://solana.com/developers/cookbook/wallets/connect-wallet-react
- HolDex Phase 3 Completion: PHASE-3-STATUS.txt
- HolDex Architecture Analysis: FULL-PICTURE-ANALYSIS.md

---

**Ready for Stage 1: Hypothesis Formulation**

The research reveals HolDex has a strong foundation but lacks execution integration. Stage 1 will formulate testable hypotheses around each gap.

