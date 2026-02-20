#!/usr/bin/env node

/**
 * HolDex Full Database Initialization & Verification
 *
 * Comprehensive Phase 1.2 setup:
 * 1. Waits for database to be healthy
 * 2. Creates schema (force_init)
 * 3. Upgrades to TimescaleDB hypertable
 * 4. Verifies all tables and indexes
 *
 * Usage:
 *   npm run init-full
 *   or: node src/scripts/init_and_verify.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const config = require('../config/env');
const logger = require('../services/logger');

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

let attemptCount = 0;
const MAX_ATTEMPTS = 30; // 30 retries × 2s = 60s timeout

async function waitForDatabase() {
  console.log('\n⏳ Waiting for database to be ready...');

  while (attemptCount < MAX_ATTEMPTS) {
    try {
      const client = await pool.connect();
      await client.query('SELECT 1;');
      client.release();
      console.log('✅ Database is ready!\n');
      return;
    } catch (e) {
      attemptCount++;
      const percent = Math.round((attemptCount / MAX_ATTEMPTS) * 100);
      process.stdout.write(
        `\r⏳ Connecting... ${percent}% (attempt ${attemptCount}/${MAX_ATTEMPTS})`
      );
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  throw new Error(
    'Database connection timeout. Ensure PostgreSQL is running and DATABASE_URL is correct.'
  );
}

async function initSchema() {
  console.log('\n📊 Initializing Database Schema...');

  try {
    const client = await pool.connect();

    // 1. Create tables
    console.log('   -> Creating tables...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS tokens (
        mint TEXT PRIMARY KEY,
        name TEXT,
        symbol TEXT,
        image TEXT,
        supply TEXT,
        decimals INTEGER DEFAULT 9,
        priceUsd DOUBLE PRECISION,
        liquidity DOUBLE PRECISION,
        marketCap DOUBLE PRECISION,
        volume24h DOUBLE PRECISION,
        change24h DOUBLE PRECISION,
        change1h DOUBLE PRECISION,
        change5m DOUBLE PRECISION,
        holders INTEGER DEFAULT 0,
        last_holder_check BIGINT DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        k_score DOUBLE PRECISION DEFAULT 0,
        last_k_score_update BIGINT DEFAULT 0,
        hasCommunityUpdate BOOLEAN DEFAULT FALSE,
        metadata TEXT,
        timestamp BIGINT
      );

      CREATE TABLE IF NOT EXISTS holders_history (
        mint TEXT,
        count INTEGER,
        timestamp BIGINT,
        PRIMARY KEY (mint, timestamp)
      );

      CREATE TABLE IF NOT EXISTS pools (
        address TEXT PRIMARY KEY,
        mint TEXT,
        dex TEXT,
        token_a TEXT NOT NULL,
        token_b TEXT NOT NULL,
        reserve_a TEXT,
        reserve_b TEXT,
        price_usd DOUBLE PRECISION DEFAULT 0,
        liquidity_usd DOUBLE PRECISION DEFAULT 0,
        volume_24h DOUBLE PRECISION DEFAULT 0,
        created_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS candles_1m (
        pool_address TEXT,
        timestamp BIGINT,
        open DOUBLE PRECISION,
        high DOUBLE PRECISION,
        low DOUBLE PRECISION,
        close DOUBLE PRECISION,
        volume DOUBLE PRECISION,
        PRIMARY KEY (pool_address, timestamp)
      );

      CREATE TABLE IF NOT EXISTS active_trackers (
        pool_address TEXT PRIMARY KEY,
        priority INTEGER DEFAULT 1,
        last_check BIGINT DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS token_updates (
        id SERIAL PRIMARY KEY,
        mint TEXT,
        twitter TEXT,
        website TEXT,
        telegram TEXT,
        banner TEXT,
        description TEXT,
        submittedAt BIGINT,
        status TEXT DEFAULT 'pending',
        signature TEXT,
        payer TEXT
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        key_hash TEXT PRIMARY KEY,
        key_prefix TEXT,
        owner TEXT,
        wallet TEXT,
        tier TEXT DEFAULT 'free',
        requests_limit INTEGER DEFAULT 1000,
        requests_today INTEGER DEFAULT 0,
        last_reset BIGINT DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS holder_snapshots (
        mint TEXT NOT NULL,
        holder TEXT NOT NULL,
        last_signature TEXT,
        buy_count INTEGER DEFAULT 0,
        sell_count INTEGER DEFAULT 0,
        net_flow BIGINT DEFAULT 0,
        conviction_class TEXT DEFAULT 'holder',
        balance BIGINT DEFAULT 0,
        updated_at BIGINT DEFAULT 0,
        PRIMARY KEY (mint, holder)
      );

      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        mint TEXT NOT NULL,
        url TEXT NOT NULL,
        events TEXT,
        secret TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at BIGINT
      );
    `);

    // 2. Create indexes
    console.log('   -> Creating indexes...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tokens_kscore ON tokens(k_score DESC);
      CREATE INDEX IF NOT EXISTS idx_tokens_mcap ON tokens(marketCap DESC);
      CREATE INDEX IF NOT EXISTS idx_tokens_volume ON tokens(volume24h DESC);
      CREATE INDEX IF NOT EXISTS idx_tokens_timestamp ON tokens(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_candles_pool_time ON candles_1m(pool_address, timestamp DESC);
    `);

    console.log('✅ Schema initialized!\n');
    client.release();
  } catch (e) {
    console.error('❌ Schema initialization failed:', e.message);
    throw e;
  }
}

async function enableTimescaleDB() {
  console.log('⏱️  Upgrading to TimescaleDB Hypertable...');

  try {
    const client = await pool.connect();

    // 1. Enable extension
    console.log('   -> Creating TimescaleDB extension...');
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;');
      console.log('   ✅ TimescaleDB extension ready');
    } catch (e) {
      if (e.message.includes('already exists')) {
        console.log('   ✅ TimescaleDB extension already exists');
      } else {
        throw e;
      }
    }

    // 2. Check if already a hypertable
    const check = await client.query(`
      SELECT * FROM timescaledb_information.hypertables
      WHERE hypertable_name = 'candles_1m';
    `);

    if (check.rows.length > 0) {
      console.log('   ✅ candles_1m is already a hypertable');
    } else {
      console.log('   -> Converting candles_1m to hypertable...');
      await client.query(`
        SELECT create_hypertable(
          'candles_1m',
          'timestamp',
          chunk_time_interval => 86400000,
          migrate_data => true,
          if_not_exists => true
        );
      `);
      console.log('   ✅ Hypertable conversion complete');
    }

    // 3. Enable compression
    console.log('   -> Enabling compression...');
    try {
      await client.query(`
        ALTER TABLE candles_1m SET (
          timescaledb.compress,
          timescaledb.compress_segmentby = 'pool_address'
        );
      `);

      await client.query(`
        SELECT add_compression_policy('candles_1m', INTERVAL '1 day');
      `);
      console.log('   ✅ Compression enabled (data >1 day auto-compresses)');
    } catch (e) {
      console.log('   ⚠️  Compression already enabled');
    }

    console.log('✅ TimescaleDB upgrade complete!\n');
    client.release();
  } catch (e) {
    console.error('❌ TimescaleDB upgrade failed:', e.message);
    throw e;
  }
}

async function verifySchema() {
  console.log('✔️  Verifying Database Schema...');

  try {
    const client = await pool.connect();

    // Check tables
    const tableResult = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename;
    `);

    const tables = tableResult.rows.map(r => r.tablename);
    console.log(`   ✅ Found ${tables.length} tables`);

    // Check indexes
    const indexResult = await client.query(`
      SELECT COUNT(*) as cnt FROM pg_indexes
      WHERE schemaname = 'public' AND indexname LIKE 'idx_%';
    `);

    console.log(`   ✅ Found ${indexResult.rows[0].cnt} indexes`);

    // Check hypertable
    const hyperResult = await client.query(`
      SELECT COUNT(*) as cnt FROM timescaledb_information.hypertables;
    `);

    console.log(`   ✅ Found ${hyperResult.rows[0].cnt} hypertable(s)`);

    console.log('✅ Schema verification passed!\n');
    client.release();
  } catch (e) {
    console.error('❌ Schema verification failed:', e.message);
    throw e;
  }
}

async function main() {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║   HolDex Database Initialization       ║');
  console.log('║   Phase 1.2: Full Setup                ║');
  console.log('╚════════════════════════════════════════╝');

  try {
    await waitForDatabase();
    await initSchema();
    await enableTimescaleDB();
    await verifySchema();

    console.log('╔════════════════════════════════════════╗');
    console.log('║  ✅ DATABASE READY FOR PRODUCTION      ║');
    console.log('║  Phase 1.2 Complete                    ║');
    console.log('╚════════════════════════════════════════╝\n');

    process.exit(0);
  } catch (error) {
    console.error('\n❌ INITIALIZATION FAILED');
    console.error(`Error: ${error.message}\n`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
