# Stage 1: Hypothesis Formulation

**Date**: 2026-02-20
**Status**: READY FOR USER VALIDATION
**Based On**: Stage 0 empirical analysis + ConnectorKit research

---

## FOUR TESTABLE HYPOTHESES

Each hypothesis is falsifiable, tied to specific code locations, and measurable.

---

### HYPOTHESIS H1: Error Type Integration

**Statement**:
> "Adopting typed errors in spaceAuth.js (replacing generic Error throws) will enable proper error recovery, improve client UX, and require zero API changes."

**Testing Strategy**:
- Replace 8 generic `throw new Error()` calls in spaceAuth.js with typed errors
- Verify error middleware correctly maps all typed errors to HTTP status codes
- Run existing tests - should all pass (no API change)
- Test recovery semantics: recoverable errors suggest retry, non-recoverable suggest different approach

**Success Criteria**:
- ✅ All 8 error throws use Errors.* factory
- ✅ Error middleware receives typed errors and logs correctly
- ✅ HTTP responses include error.code (not just message)
- ✅ Clients can detect if error is recoverable
- ✅ All existing tests still pass

**Falsification Path**:
- If error middleware doesn't recognize typed errors → API was incompatible
- If status codes change → API compatibility broken
- If tests fail → unexpected dependencies introduced

**Code Locations**:
- Throw sites: `spaceAuth.js` lines 258, 264, 272, 318, 378, 383, 412, 457, 469
- Handler: `middleware/errorHandler.js` line 84 (isHolDexError check)
- Status mapping: `middleware/errorHandler.js` STATUS_CODE_MAP

**Effort**: Low (1-2 hours, pure substitution)
**Impact**: High (enables all subsequent improvements)

---

### HYPOTHESIS H2: Transaction Confirmation Monitoring

**Statement**:
> "A TX confirmation monitor (pending→confirmed→finalized state machine) can be implemented without modifying existing endpoints, enabling clients to poll TX status and reducing 'did my TX confirm?' support requests."

**Testing Strategy**:
- Create `services/txMonitor.js` with TX status tracking
- Implement state machine: PENDING → CONFIRMED → FINALIZED
- Add `/oracle/tx/:signature` GET endpoint (non-breaking)
- Test with real TX signatures from Helius RPC
- Verify timeout handling (TXs pending >30 min auto-fail)

**Success Criteria**:
- ✅ Can track TX from submission → finalization
- ✅ Timeout handling works (TX marked failed after 30 min pending)
- ✅ New endpoint doesn't break existing API
- ✅ Can distinguish tx states: PENDING, CONFIRMED, FINALIZED, FAILED
- ✅ TX status persists (Redis cache + PostgreSQL)

**Falsification Path**:
- If TX status unreliable → polling won't work
- If timeout handling fails → TXs can hang indefinitely
- If persistence fails → TX status lost on service restart

**Code Locations**:
- New: `src/services/txMonitor.js` (~200 LOC)
- New: `src/routes/tx.js` (~50 LOC for endpoint)
- Update: `src/index.js` (wire new route)
- Integration: `spaceAuth.js` - log TX signature on signed actions

**Effort**: Medium (5-8 hours)
**Impact**: High (enables on-chain verification, reduces support burden)

---

### HYPOTHESIS H3: Silent-First Wallet Detection

**Statement**:
> "A client-side wallet adapter (React hook + vanilla JS) that silently attempts to detect installed wallets without throwing errors will improve UX by showing 'wallet found' or 'install wallet' UI instead of errors."

**Testing Strategy**:
- Create `frontend/wallet-adapter.js` (vanilla JS, Wallet Standard compliant)
- Implement `useWallet()` React hook wrapper
- Test silent detection: try → detect → don't error if none found
- Test with Phantom, Solflare, Backpack (Wallet Standard compliant)
- Add detection UI: "Phantom found ✓" or "No wallet detected. Install one?"

**Success Criteria**:
- ✅ Detects installed wallets without errors
- ✅ Gracefully handles no wallet case (no throw)
- ✅ Works with Phantom, Solflare, Backpack (Wallet Standard)
- ✅ React hook + vanilla JS both work
- ✅ Mobile wallet detection works (future: Solana Mobile Stack)

**Falsification Path**:
- If detection errors on missing wallet → not silent
- If can't detect multiple wallet types → limited compatibility
- If doesn't work without React → not truly framework-agnostic

**Code Locations**:
- New: `frontend/wallet-adapter.js` (~150 LOC)
- New: `frontend/useWallet.js` (~50 LOC React hook)
- New: `frontend/demo.html` (test page)

**Effort**: Medium (6-10 hours)
**Impact**: Medium (UX improvement, not revenue-critical)

---

### HYPOTHESIS H4: RPC Request Deduplication

**Statement**:
> "Deduplicating concurrent identical RPC requests (e.g., 5 requests for same K-Score) can reduce RPC credit usage by 30-50% without API changes, by routing duplicate requests to the same in-flight call."

**Testing Strategy**:
- Enhance `rpcProvider.js` with deduplication layer
- Track in-flight requests: `{ method:params → Promise }`
- When duplicate arrives, return existing Promise
- Clean up after response
- Load test: 100 concurrent requests for same data

**Success Criteria**:
- ✅ Concurrent duplicate requests deduplicated
- ✅ Only 1 RPC call made for N identical requests
- ✅ All N clients get same response
- ✅ Errors handled: if 1 call fails, all get error
- ✅ No API changes (transparent to callers)
- ✅ Measurable RPC credit reduction (target: 30%)

**Falsification Path**:
- If deduplication fails for some request types → incomplete solution
- If causes race conditions → brittle under load
- If doesn't reduce credits → hypothesis wrong

**Code Locations**:
- Update: `src/services/rpcProvider.js` (add dedup map)
- Update: `src/services/rpcMonitor.js` (track credit savings)
- New: `tests/dedup.test.js` (~100 LOC tests)

**Effort**: Low-Medium (4-6 hours)
**Impact**: High (directly reduces RPC waste, aligns with budget goals)

---

## VALIDATION CHECKPOINT

**Before proceeding to Stage 2 (Experimental Design), please confirm**:

1. **Scope**: Should we pursue all 4 hypotheses, or prioritize?
   - Priority ranking? (My suggestion: H1→H4→H2→H3)

2. **Success Definition**: Are these success criteria acceptable, or should they be stricter/looser?

3. **Resource Budget**:
   - H1: 2 hours
   - H4: 5 hours
   - H2: 7 hours
   - H3: 8 hours
   - **Total: ~20 hours (2-3 days, 1 FTE)**

   Is this acceptable?

4. **Timeline**: Should we implement sequentially (H1 first, then H4, etc.) or in parallel?

5. **Measurement**: For H4 (RPC credits), do you want before/after metrics captured? (I suggest we run current RPC load for 24h, then after dedup for 24h, compare credits/day)

---

**What's Next After Validation**:
- Stage 2: Experimental Design (define variables, baselines, controls)
- Stage 3: Systematic Experimentation (implement + test each hypothesis)
- Stage 4: Validation & Synthesis (confirm findings, document patterns)

Awaiting your validation on the 4 hypotheses above.

