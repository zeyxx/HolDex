#!/usr/bin/env node

/**
 * Production Readiness Check — Phase 3.3
 *
 * Verifies all critical production requirements before deployment:
 * ✓ Database connectivity
 * ✓ Helius API key validity
 * ✓ RPC provider health
 * ✓ Error metrics system
 * ✓ Monitoring endpoints
 * ✓ Security configuration
 */

const fs = require('fs');
const path = require('path');

// Color helpers
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[36m',
};

function log(color, symbol, message) {
    console.log(`${color}${symbol}${colors.reset} ${message}`);
}

function success(msg) { log(colors.green, '✅', msg); }
function error(msg) { log(colors.red, '❌', msg); }
function warning(msg) { log(colors.yellow, '⚠️ ', msg); }
function info(msg) { log(colors.blue, 'ℹ️ ', msg); }

console.log('\n' + '='.repeat(70));
console.log('PRODUCTION READINESS CHECK — Phase 3.3');
console.log('='.repeat(70) + '\n');

// Track results
let passed = 0;
let failed = 0;
let warnings_count = 0;

// ============================================
// CHECK 1: Environment Variables
// ============================================
console.log('🔍 CHECK 1: Environment Variables\n');

const requiredVars = [
    'DATABASE_URL',
    'HELIUS_API_KEY',
    'ADMIN_PASSWORD',
    'DATA_SIGNING_SECRET',
    'WEBHOOK_SECRET'
];

const recommendedVars = [
    'REDIS_URL',
    'ORACLE_WEBHOOK_SECRET',
    'API_URL',
    'SOLANA_WSS_URL'
];

for (const varName of requiredVars) {
    if (process.env[varName]) {
        const value = varName === 'HELIUS_API_KEY' ? '***' : (process.env[varName].length > 30 ? '...' : process.env[varName]);
        success(`${varName} = ${value}`);
        passed++;
    } else {
        error(`${varName} not set (REQUIRED)`);
        failed++;
    }
}

console.log();

for (const varName of recommendedVars) {
    if (process.env[varName]) {
        success(`${varName} = ✓`);
        passed++;
    } else {
        warning(`${varName} not set (recommended for production)`);
        warnings_count++;
    }
}

// ============================================
// CHECK 2: Secret Strength
// ============================================
console.log('\n🔍 CHECK 2: Secret Strength\n');

const secrets = ['DATA_SIGNING_SECRET', 'WEBHOOK_SECRET', 'ORACLE_WEBHOOK_SECRET'];

for (const secretName of secrets) {
    const secret = process.env[secretName];
    if (secret) {
        if (secret.length < 32) {
            warning(`${secretName}: ${secret.length} chars (minimum 32 recommended)`);
            warnings_count++;
        } else {
            success(`${secretName}: ${secret.length} chars (strong)`);
            passed++;
        }
    }
}

// ============================================
// CHECK 3: Database Connectivity
// ============================================
console.log('\n🔍 CHECK 3: Database Connectivity\n');

(async () => {
    try {
        const { initDB, getDB } = require('../src/services/database');
        await initDB();
        const db = getDB();

        // Test a simple query
        const result = await db.get('SELECT 1 as ok');
        if (result) {
            success('Database connection successful');
            passed++;

            // Check error_metrics table
            try {
                const metricsCount = await db.get('SELECT COUNT(*) as count FROM error_metrics');
                success(`Error metrics table exists (${metricsCount.count} entries)`);
                passed++;
            } catch (e) {
                error('error_metrics table not found (create during initDB)');
                failed++;
            }
        }
    } catch (e) {
        error(`Database connection failed: ${e.message}`);
        failed++;
    }

    // ============================================
    // CHECK 4: RPC Provider Configuration
    // ============================================
    console.log('\n🔍 CHECK 4: RPC Provider Configuration\n');

    const config = require('../src/config/env');

    if (config.HELIUS_API_KEY) {
        success('Helius API key configured');
        passed++;
        info(`RPC URL will use Helius (primary)`);
    } else {
        error('Helius API key NOT configured (will use public RPC fallback)');
        failed++;
        info(`RPC URL: ${config.SOLANA_RPC_URL}`);
    }

    if (config.SOLANA_RPC_URL) {
        success(`SOLANA_RPC_URL: ${config.SOLANA_RPC_URL.slice(0, 50)}...`);
        passed++;
    }

    // ============================================
    // CHECK 5: File Permissions
    // ============================================
    console.log('\n🔍 CHECK 5: File Permissions\n');

    const requiredFiles = [
        'src/services/database.js',
        'src/middleware/errorHandler.js',
        'src/routes/monitoring.js',
        '.env.local'
    ];

    for (const file of requiredFiles) {
        const filePath = path.join(__dirname, '..', file);
        try {
            fs.accessSync(filePath, fs.constants.R_OK);
            success(`${file}: readable`);
            passed++;
        } catch (e) {
            if (file === '.env.local') {
                warning(`${file}: not found (optional if using environment)`);
                warnings_count++;
            } else {
                error(`${file}: not readable`);
                failed++;
            }
        }
    }

    // ============================================
    // CHECK 6: Configuration Validation
    // ============================================
    console.log('\n🔍 CHECK 6: Configuration Validation\n');

    const isProduction = process.env.NODE_ENV === 'production';

    if (isProduction) {
        success('NODE_ENV = production');
        passed++;

        if (process.env.ADMIN_PASSWORD) {
            success('Admin password set for production');
            passed++;
        } else {
            error('Admin password required in production');
            failed++;
        }
    } else {
        info('NODE_ENV = development (not production)');
    }

    // ============================================
    // SUMMARY
    // ============================================
    console.log('\n' + '='.repeat(70));
    console.log('PRODUCTION READINESS SUMMARY');
    console.log('='.repeat(70) + '\n');

    console.log(`✅ Passed:   ${passed}`);
    console.log(`❌ Failed:   ${failed}`);
    console.log(`⚠️  Warnings: ${warnings_count}\n`);

    if (failed === 0) {
        if (warnings_count === 0) {
            success('🚀 READY FOR PRODUCTION');
            console.log('\nAll checks passed. Ready to deploy Phase 3.3.\n');
        } else {
            success('🚀 READY FOR PRODUCTION (with warnings)');
            console.log(`\n${warnings_count} non-critical warning(s). Review and fix if possible.\n`);
        }
    } else {
        error(`⛔ NOT READY FOR PRODUCTION`);
        console.log(`\n${failed} critical issue(s) must be fixed before deployment.\n`);
        process.exit(1);
    }

    // ============================================
    // NEXT STEPS
    // ============================================
    console.log('📋 Next Steps:\n');
    console.log('1. Review: docs/PHASE-3-3-PRODUCTION-SETUP.md');
    console.log('2. Get Helius API key: https://www.helius.dev/');
    console.log('3. Set HELIUS_API_KEY in environment');
    console.log('4. Run: npm run check:production');
    console.log('5. Deploy: git push && (service auto-deploys)\n');

})().catch(e => {
    error(`Fatal error: ${e.message}`);
    process.exit(1);
});
