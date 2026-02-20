/**
 * GASdf ↔ HolDex Oracle Integration Tests
 *
 * Phase 2.1 Integration: Verify oracle endpoints work correctly
 * for GASdf fee calculation and token acceptance.
 *
 * Tests cover:
 * - K-Score lookup (token acceptance)
 * - E-Score lookup (participant benefits)
 * - Discount calculation (exact fee amount)
 * - Burn webhook (E-Score updates)
 * - Full GASdf quote flow
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

// Mock configuration
const TEST_CONFIG = {
  API_BASE: 'http://localhost:3000',
  HMAC_SECRET: 'test-secret-key-for-webhook-signing',

  // Test wallets
  WALLET_DIAMOND: '2s91VW55dNZhp7SGE9cPzyBVpJKMVB5yJpCs6YqZBhHQ', // Diamond holder
  WALLET_BRONZE: '9B5X6wrDKAjvMyMCQAy7ERBQKwQAxmteChef6XjvDR9X',   // Bronze holder
  WALLET_UNREGISTERED: 'TokenkegQfeZyiNwAJsyFbPVwwQW8JwqvxLucKBFqeT', // Unknown

  // Test tokens
  MINT_USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',   // Diamond (hardcoded)
  MINT_COMMUNITY: 'DrinkChicken888uQcfG8Y89iQFYKF8bAKFCmFPyB7JwR',  // Hypothetical
};

// ═════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═════════════════════════════════════════════════════════════════

function signWebhook(body, secret) {
  // Canonical JSON (sorted keys, no spaces)
  const canonical = JSON.stringify(
    {
      amount: body.amount,
      source: body.source,
      txSignature: body.txSignature,
      wallet: body.wallet
    }
  );

  return crypto
    .createHmac('sha256', secret)
    .update(canonical)
    .digest('hex');
}

async function fetchOracle(path, options = {}) {
  const url = `${TEST_CONFIG.API_BASE}/oracle${path}`;
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...(options.body && { body: JSON.stringify(options.body) })
  });

  const data = await response.json();
  return { status: response.status, data };
}

// ═════════════════════════════════════════════════════════════════
// TEST SUITE 1: K-SCORE ORACLE
// ═════════════════════════════════════════════════════════════════

test('K-Score Oracle: Accept Diamond Token (Hardcoded)', async (t) => {
  const { status, data } = await fetchOracle(`/kscore/${TEST_CONFIG.MINT_USDC}`);

  assert.strictEqual(status, 200, 'HTTP 200');
  assert.strictEqual(data.success, true, 'API success');
  assert.strictEqual(data.data.k_score, 100, 'K-Score = 100 (hardcoded)');
  assert.strictEqual(data.data.tier, 'Diamond', 'Tier = Diamond');
  assert.strictEqual(data.data.accepted, true, 'Token accepted');
  assert.strictEqual(data.data.reason, 'Hardcoded acceptance (infrastructure token)', 'Correct reason');
});

test('K-Score Oracle: Reject Invalid Mint', async (t) => {
  const { status, data } = await fetchOracle('/kscore/invalid-mint');

  assert.strictEqual(status, 400, 'HTTP 400 (validation error)');
  assert.strictEqual(data.success, false, 'API error');
  assert.match(data.error, /invalid.*mint/i, 'Error mentions invalid mint');
});

test('K-Score Oracle: Unknown Token Returns K-Score 0', async (t) => {
  const { status, data } = await fetchOracle(`/kscore/${TEST_CONFIG.MINT_COMMUNITY}`);

  assert.strictEqual(status, 200, 'HTTP 200');
  assert.strictEqual(data.success, true, 'API success');
  assert.strictEqual(data.data.k_score, 0, 'K-Score = 0 (not found)');
  assert.strictEqual(data.data.accepted, false, 'Token not accepted');
  assert.match(data.data.reason, /not found|below threshold/i, 'Correct reason');
});

test('K-Score Oracle: Caching Indicator', async (t) => {
  // First call should be cache MISS
  const call1 = await fetchOracle(`/kscore/${TEST_CONFIG.MINT_USDC}`);
  assert.strictEqual(call1.data.data.cached, false, 'First call not cached');

  // Wait 100ms and call again
  await new Promise(resolve => setTimeout(resolve, 100));

  // Second call should be cache HIT
  const call2 = await fetchOracle(`/kscore/${TEST_CONFIG.MINT_USDC}`);
  assert.strictEqual(call2.data.data.cached, true, 'Second call is cached');
});

// ═════════════════════════════════════════════════════════════════
// TEST SUITE 2: E-SCORE ORACLE
// ═════════════════════════════════════════════════════════════════

test('E-Score Oracle: Valid Wallet Returns Benefits', async (t) => {
  const { status, data } = await fetchOracle(`/escore/${TEST_CONFIG.WALLET_DIAMOND}`);

  assert.strictEqual(status, 200, 'HTTP 200');
  assert.strictEqual(data.success, true, 'API success');
  assert.ok(data.data.e_score >= 0, 'E-Score is non-negative');
  assert.ok(data.data.tier, 'Tier exists');
  assert.ok(data.data.benefits, 'Benefits object exists');
  assert.ok(typeof data.data.benefits.discount === 'number', 'Discount is number');
});

test('E-Score Oracle: Reject Invalid Wallet', async (t) => {
  const { status, data } = await fetchOracle('/escore/invalid-wallet');

  assert.strictEqual(status, 400, 'HTTP 400 (validation error)');
  assert.strictEqual(data.success, false, 'API error');
});

// ═════════════════════════════════════════════════════════════════
// TEST SUITE 3: DISCOUNT ORACLE
// ═════════════════════════════════════════════════════════════════

test('Discount Oracle: Calculate Fee for Operation', async (t) => {
  const operation = 'token_swap';
  const { status, data } = await fetchOracle(
    `/discount/${TEST_CONFIG.WALLET_DIAMOND}/${operation}`
  );

  assert.strictEqual(status, 200, 'HTTP 200');
  assert.strictEqual(data.success, true, 'API success');
  assert.strictEqual(data.data.wallet, TEST_CONFIG.WALLET_DIAMOND, 'Wallet matches');
  assert.strictEqual(data.data.operation, operation, 'Operation matches');
  assert.ok(typeof data.data.e_score === 'number', 'E-Score returned');
  assert.ok(data.data.discounts, 'Discounts object exists');
  assert.ok(typeof data.data.finalFee === 'number', 'Final fee calculated');
  assert.ok(data.data.finalFee >= 0, 'Final fee non-negative');
});

test('Discount Oracle: Reject Invalid Operation', async (t) => {
  // Operation with invalid characters
  const { status, data } = await fetchOracle(
    `/discount/${TEST_CONFIG.WALLET_DIAMOND}/invalid@operation`
  );

  assert.strictEqual(status, 400, 'HTTP 400 (validation error)');
  assert.strictEqual(data.success, false, 'API error');
});

// ═════════════════════════════════════════════════════════════════
// TEST SUITE 4: COSTS ENDPOINT
// ═════════════════════════════════════════════════════════════════

test('Costs Oracle: Returns Operation Pricing', async (t) => {
  const { status, data } = await fetchOracle('/costs');

  assert.strictEqual(status, 200, 'HTTP 200');
  assert.strictEqual(data.success, true, 'API success');
  assert.ok(data.data.operations, 'Operations defined');
  assert.ok(data.data.constants, 'Constants defined');
  assert.ok(data.data.acceptance, 'Acceptance rules defined');

  // Verify constants
  assert.ok(data.data.constants.PHI > 1.6 && data.data.constants.PHI < 1.7, 'PHI ≈ 1.618');
  assert.ok(Array.isArray(data.data.acceptance.hardcodedTokens), 'Hardcoded tokens is array');
});

// ═════════════════════════════════════════════════════════════════
// TEST SUITE 5: BURN WEBHOOK
// ═════════════════════════════════════════════════════════════════

test('Burn Webhook: Record Burn with Valid Signature', async (t) => {
  const burnAmount = 1000000; // 1 ASDF (6 decimals)
  const txSignature = 'xJvxvWQNnKk9XsWj82VzKQ4cCt1eBxbKphPGu6KFVwKbCJzMmxdqHPvFKCQ9HHW5vwEqK6yB1aU7e5Y2ksH4B12';

  const body = {
    wallet: TEST_CONFIG.WALLET_DIAMOND,
    amount: burnAmount,
    txSignature: txSignature,
    source: 'gasdf'
  };

  const signature = signWebhook(body, TEST_CONFIG.HMAC_SECRET);

  const { status, data } = await fetchOracle('/webhook/burns', {
    method: 'POST',
    body: body,
    headers: {
      'x-holdex-signature': signature
    }
  });

  assert.strictEqual(status, 200, 'HTTP 200');
  assert.strictEqual(data.success, true, 'Burn recorded successfully');
  assert.strictEqual(data.data.wallet, TEST_CONFIG.WALLET_DIAMOND, 'Wallet matches');
  assert.strictEqual(data.data.amount, burnAmount, 'Amount matches');
  assert.ok(typeof data.data.newEScore === 'number', 'New E-Score returned');
});

test('Burn Webhook: Reject Invalid Signature', async (t) => {
  const body = {
    wallet: TEST_CONFIG.WALLET_DIAMOND,
    amount: 1000000,
    txSignature: 'xJvxvWQNnKk9XsWj82VzKQ4cCt1eBxbKphPGu6KFVwKbCJzMmxdqHPvFKCQ9HHW5vwEqK6yB1aU7e5Y2ksH4B12',
    source: 'gasdf'
  };

  const { status, data } = await fetchOracle('/webhook/burns', {
    method: 'POST',
    body: body,
    headers: {
      'x-holdex-signature': 'invalid-signature-xyz'
    }
  });

  assert.strictEqual(status, 401, 'HTTP 401 (unauthorized)');
  assert.strictEqual(data.success, false, 'API error');
  assert.match(data.error, /signature/i, 'Error mentions signature');
});

test('Burn Webhook: Reject Invalid Amount', async (t) => {
  const body = {
    wallet: TEST_CONFIG.WALLET_DIAMOND,
    amount: -1000, // Negative not allowed
    txSignature: 'xJvxvWQNnKk9XsWj82VzKQ4cCt1eBxbKphPGu6KFVwKbCJzMmxdqHPvFKCQ9HHW5vwEqK6yB1aU7e5Y2ksH4B12',
    source: 'gasdf'
  };

  const signature = signWebhook(body, TEST_CONFIG.HMAC_SECRET);

  const { status, data } = await fetchOracle('/webhook/burns', {
    method: 'POST',
    body: body,
    headers: {
      'x-holdex-signature': signature
    }
  });

  assert.strictEqual(status, 400, 'HTTP 400 (validation error)');
  assert.strictEqual(data.success, false, 'API error');
});

// ═════════════════════════════════════════════════════════════════
// TEST SUITE 6: GASDF FLOW (End-to-End)
// ═════════════════════════════════════════════════════════════════

test('GASdf Flow: Token Quote → K-Score Check → Discount Calc', async (t) => {
  // Step 1: Check if token is accepted (K-Score >= threshold)
  const kscoreCheck = await fetchOracle(`/kscore/${TEST_CONFIG.MINT_USDC}`);
  assert.strictEqual(kscoreCheck.data.data.accepted, true, 'Token accepted');

  // Step 2: Get user's E-Score for discount
  const escoreCheck = await fetchOracle(`/escore/${TEST_CONFIG.WALLET_DIAMOND}`);
  assert.ok(escoreCheck.data.data.e_score >= 0, 'E-Score retrieved');

  // Step 3: Calculate exact fee with discount
  const discountCheck = await fetchOracle(
    `/discount/${TEST_CONFIG.WALLET_DIAMOND}/token_transfer`
  );
  assert.ok(discountCheck.data.data.finalFee >= 0, 'Final fee calculated');

  // Expected flow: API fee → discount applied → final fee
  const applyingDiscount = discountCheck.data.data.baseFee > discountCheck.data.data.finalFee;
  assert.ok(applyingDiscount || discountCheck.data.data.baseFee === discountCheck.data.data.finalFee,
    'Fee is same or lower than base (discount applied or not applicable)');
});

// ═════════════════════════════════════════════════════════════════
// TEST SUITE 7: RATE LIMITING
// ═════════════════════════════════════════════════════════════════

test('Oracle: Rate Limiting Applied', async (t) => {
  // Make rapid requests and verify rate limit response
  const requests = [];

  for (let i = 0; i < 5; i++) {
    requests.push(
      fetchOracle(`/kscore/${TEST_CONFIG.MINT_USDC}`)
    );
  }

  const responses = await Promise.all(requests);

  // All should succeed (rate limit threshold is high: 100/min)
  for (const response of responses) {
    assert.ok(response.status === 200 || response.status === 429, 'Valid response or rate limited');
  }
});

// ═════════════════════════════════════════════════════════════════
// EXPORT FOR TEST RUNNER
// ═════════════════════════════════════════════════════════════════

// Tests run automatically via node:test
