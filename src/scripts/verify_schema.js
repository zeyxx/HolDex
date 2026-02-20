#!/usr/bin/env node

/**
 * Verify HolDex Database Schema
 *
 * Checks that all required tables exist and have correct structure.
 * Useful for Phase 1.2 validation after initialization.
 */

require('dotenv').config();
const { Pool } = require('pg');
const config = require('../config/env');

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const REQUIRED_TABLES = [
  'tokens',
  'holders_history',
  'pools',
  'candles_1m',
  'active_trackers',
  'token_updates',
  'api_keys',
  'holder_snapshots',
  'webhooks',
];

async function verifySchema() {
  console.log('🔍 Verifying HolDex Database Schema...\n');

  try {
    const client = await pool.connect();

    // Check TimescaleDB extension
    console.log('1️⃣  Checking TimescaleDB Extension...');
    try {
      const ext = await client.query(`
        SELECT extname FROM pg_extension WHERE extname = 'timescaledb';
      `);
      if (ext.rows.length > 0) {
        console.log('   ✅ TimescaleDB extension installed\n');
      } else {
        console.log('   ⚠️  TimescaleDB extension NOT installed\n');
      }
    } catch (e) {
      console.log(`   ⚠️  Could not check extension: ${e.message}\n`);
    }

    // Check for hypertable
    console.log('2️⃣  Checking for Hypertables...');
    try {
      const hyper = await client.query(`
        SELECT hypertable_name FROM timescaledb_information.hypertables
        WHERE hypertable_name = 'candles_1m';
      `);
      if (hyper.rows.length > 0) {
        console.log('   ✅ candles_1m is a hypertable\n');
      } else {
        console.log('   ⚠️  candles_1m is NOT a hypertable (run migrate_timescaledb.js)\n');
      }
    } catch (e) {
      console.log(`   ⚠️  Could not check hypertables: ${e.message}\n`);
    }

    // Check required tables
    console.log('3️⃣  Checking Required Tables...');
    const tableResult = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename;
    `);

    const existingTables = tableResult.rows.map(r => r.tablename);
    let allTablesExist = true;

    for (const table of REQUIRED_TABLES) {
      if (existingTables.includes(table)) {
        console.log(`   ✅ ${table}`);
      } else {
        console.log(`   ❌ ${table} (MISSING)`);
        allTablesExist = false;
      }
    }

    if (allTablesExist) {
      console.log('\n   All required tables exist! ✅\n');
    } else {
      console.log('\n   ❌ Some tables are missing. Run force_init.js\n');
    }

    // Check key indexes
    console.log('4️⃣  Checking Indexes...');
    const indexResult = await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
      AND indexname LIKE 'idx_%'
      ORDER BY indexname;
    `);

    const expectedIndexes = [
      'idx_tokens_kscore',
      'idx_tokens_mcap',
      'idx_tokens_volume',
      'idx_tokens_timestamp',
      'idx_candles_pool_time',
    ];

    const existingIndexes = indexResult.rows.map(r => r.indexname);

    for (const idx of expectedIndexes) {
      if (existingIndexes.includes(idx)) {
        console.log(`   ✅ ${idx}`);
      } else {
        console.log(`   ⚠️  ${idx} (missing, but not critical)`);
      }
    }

    // Check table row counts
    console.log('\n5️⃣  Table Row Counts...');
    for (const table of REQUIRED_TABLES) {
      if (existingTables.includes(table)) {
        const count = await client.query(`SELECT COUNT(*) as cnt FROM ${table};`);
        console.log(`   ${table}: ${count.rows[0].cnt} rows`);
      }
    }

    console.log('\n✅ Schema Verification Complete!\n');

    client.release();
  } catch (error) {
    console.error('❌ Verification Failed:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

verifySchema();
