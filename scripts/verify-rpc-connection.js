#!/usr/bin/env node

/**
 * Verify RPC Connection — Phase 3.3
 *
 * Tests connectivity and performance of:
 * ✓ Helius RPC (primary)
 * ✓ Public Solana RPC (fallback)
 *
 * Helps diagnose RPC credit burn and connectivity issues
 */

const { Connection, clusterApiUrl } = require('@solana/web3.js');
require('dotenv').config();

const colors = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[36m',
    reset: '\x1b[0m',
};

function log(color, symbol, message) {
    console.log(`${color}${symbol}${colors.reset} ${message}`);
}

async function testRpc(name, url, timeout = 5000) {
    const startTime = Date.now();

    try {
        const connection = new Connection(url, 'confirmed');
        const slot = await Promise.race([
            connection.getSlot(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
        ]);

        const latency = Date.now() - startTime;

        return {
            status: 'ok',
            latency,
            slot,
            timestamp: new Date().toISOString()
        };
    } catch (e) {
        const latency = Date.now() - startTime;
        return {
            status: 'error',
            error: e.message,
            latency
        };
    }
}

(async () => {
    console.log('\n' + '='.repeat(70));
    console.log('RPC CONNECTION VERIFICATION — Phase 3.3');
    console.log('='.repeat(70) + '\n');

    const heliusKey = process.env.HELIUS_API_KEY;
    const heliusUrl = heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : null;
    const publicUrl = clusterApiUrl('mainnet-beta');

    // ============================================
    // TEST 1: Helius RPC
    // ============================================
    console.log('Testing Helius RPC (primary)...\n');

    if (!heliusKey) {
        log(colors.yellow, '⚠️ ', 'HELIUS_API_KEY not set - skipping Helius test');
    } else {
        const result = await testRpc('Helius', heliusUrl);

        if (result.status === 'ok') {
            log(colors.green, '✅', `Helius RPC: Connected`);
            log(colors.green, '✅', `  Latency: ${result.latency}ms`);
            log(colors.green, '✅', `  Current Slot: ${result.slot}`);
        } else {
            log(colors.red, '❌', `Helius RPC: ${result.error}`);
            log(colors.red, '❌', `  Latency: ${result.latency}ms (timeout: ${result.error === 'Timeout'})`);
        }
    }

    console.log();

    // ============================================
    // TEST 2: Public RPC
    // ============================================
    console.log('Testing Public Solana RPC (fallback)...\n');

    const publicResult = await testRpc('Public', publicUrl);

    if (publicResult.status === 'ok') {
        log(colors.green, '✅', `Public RPC: Connected`);
        log(colors.green, '✅', `  Latency: ${publicResult.latency}ms`);
        log(colors.green, '✅', `  Current Slot: ${publicResult.slot}`);
    } else {
        log(colors.red, '❌', `Public RPC: ${publicResult.error}`);
        log(colors.red, '❌', `  Latency: ${publicResult.latency}ms`);
    }

    console.log();

    // ============================================
    // PROVIDER SELECTION
    // ============================================
    console.log('Provider Priority:\n');

    if (heliusKey) {
        log(colors.blue, 'ℹ️ ', '1. Helius (primary) - lower latency, better rate limits');
        log(colors.blue, 'ℹ️ ', '2. Public RPC (fallback) - higher latency, strict limits');
    } else {
        log(colors.yellow, '⚠️ ', '1. Public RPC (only) - no Helius key configured');
        log(colors.yellow, '⚠️ ', '   → Setup Helius for better performance');
    }

    console.log();

    // ============================================
    // LATENCY COMPARISON
    // ============================================
    if (heliusKey && heliusUrl) {
        const heliusResult = await testRpc('Helius', heliusUrl);

        if (heliusResult.status === 'ok' && publicResult.status === 'ok') {
            console.log('Latency Comparison:\n');

            const diff = heliusResult.latency - publicResult.latency;
            const percent = ((diff / publicResult.latency) * 100).toFixed(1);

            if (diff < 0) {
                log(colors.green, '✅', `Helius is ${Math.abs(diff)}ms faster (${Math.abs(percent)}% improvement)`);
            } else {
                log(colors.yellow, '⚠️ ', `Helius is ${diff}ms slower (public RPC better for this region)`);
            }

            console.log();
        }
    }

    // ============================================
    // RECOMMENDATIONS
    // ============================================
    console.log('📋 Recommendations:\n');

    if (!heliusKey) {
        log(colors.yellow, '⚠️ ', 'ACTION REQUIRED: Set HELIUS_API_KEY environment variable');
        console.log('   1. Create account: https://www.helius.dev/');
        console.log('   2. Generate API key from dashboard');
        console.log('   3. Set: export HELIUS_API_KEY=your-key');
        console.log('   4. Restart service\n');
    } else {
        log(colors.green, '✅', 'Helius API key configured');

        const heliusResult = await testRpc('Helius', heliusUrl);
        if (heliusResult.status === 'ok') {
            if (heliusResult.latency > 1000) {
                log(colors.yellow, '⚠️ ', `High Helius latency (${heliusResult.latency}ms) - check network`);
            } else {
                log(colors.green, '✅', 'Helius latency optimal');
            }
        } else {
            log(colors.red, '❌', 'Helius connection failed - check API key validity');
        }
    }

    console.log();

    // ============================================
    // CREDIT MONITORING
    // ============================================
    console.log('💰 Credit Usage Monitoring:\n');

    log(colors.blue, 'ℹ️ ', 'Error metrics tracked in: /monitoring/errors');
    log(colors.blue, 'ℹ️ ', 'Watch for: RPC_RATE_LIMIT, RPC_TIMEOUT, RPC_AUTH_FAILED');
    log(colors.blue, 'ℹ️ ', 'Query: curl http://localhost:3000/monitoring/errors\n');

    // ============================================
    // SUMMARY
    // ============================================
    console.log('='.repeat(70));
    console.log('RPC CONNECTION VERIFICATION COMPLETE');
    console.log('='.repeat(70) + '\n');

})().catch(e => {
    log(colors.red, '❌', `Error: ${e.message}`);
    process.exit(1);
});
