# HolDex Docker Setup Guide — Phase 1 (Task 1.1)

**Status**: Production-ready configuration for local testing (Option B complete)

---

## Quick Start (30 seconds)

```bash
# 1. Create environment file
cp .env.example .env.local

# 2. Edit with your credentials (IMPORTANT: change passwords)
nano .env.local  # or use your editor

# 3. Build and start services
docker-compose up -d

# 4. Check service health
docker-compose ps
docker-compose logs -f api  # Watch API startup
```

---

## 📋 Prerequisites

- **Docker**: 24.0+
- **Docker Compose**: 2.0+
- **Git**: for cloning repo with package-lock.json

**Check versions**:
```bash
docker --version
docker-compose --version
```

---

## 🔧 Configuration

### Step 1: Create `.env.local` (CRITICAL - NOT COMMITTED)

```bash
cp .env.example .env.local
```

### Step 2: Edit `.env.local` with Production Credentials

**MINIMUM CHANGES** (all others have defaults):

```ini
# Database
POSTGRES_PASSWORD=your_secure_password_32_chars_minimum
POSTGRES_USER=holdex_user
POSTGRES_DB=holdex_production

# Solana RPC
HELIUS_API_KEY=your_helius_api_key_from_helius.dev
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/
SOLANA_WSS_URL=wss://mainnet.helius-rpc.com/

# RPC Credit Control (Phase 4 leak detection)
RPC_HARDCAP_ENABLED=true
RPC_MAX_CALLS_PER_HOUR=500
```

**⚠️ SECURITY CHECKLIST**:
- [ ] Database password changed (min 32 chars)
- [ ] `.env.local` added to `.gitignore` (already done)
- [ ] `.env.local` NEVER committed to git
- [ ] Helius API key is from https://helius.dev account
- [ ] Hardcap enabled to prevent RPC credit bleed

---

## 🚀 Starting Services

### Option A: Standard (API only)

```bash
docker-compose up -d
```

**What starts**:
- ✅ Nginx (port 80) — load balancer + micro-cache
- ✅ API (port 3000 internal, 80 via Nginx) — main service
- ✅ PostgreSQL/TimescaleDB (port 5432) — database
- ✅ Redis (port 6379) — session cache + message broker

**Health check**:
```bash
# Wait 30s for services to initialize
sleep 30
curl http://localhost/health
# Expected: 200 OK with service status
```

### Option B: With K-Score Calculator (Phase 4 RPC monitoring)

```bash
docker-compose --profile workers up -d
```

**What starts** (same as Option A plus):
- ✅ Calculator service — K-Score analysis + RPC credit tracker

### Option C: With Legacy Worker (NOT RECOMMENDED)

```bash
docker-compose --profile legacy up -d
```

**Status**: Legacy service disabled by default because automatic token discovery is turned OFF.

---

## 📊 Health Checks

### Check all services running

```bash
docker-compose ps
```

**Expected output**:
```
NAME          STATUS         PORTS
nginx         Up 2 min       0.0.0.0:80->80/tcp
api           Up 2 min       0.0.0.0:3000->3000/tcp
db            Up 2 min       0.0.0.0:5432->5432/tcp
redis         Up 2 min       0.0.0.0:6379->6379/tcp
```

### Check API logs

```bash
docker-compose logs -f api
```

**Look for**:
```
✅ Database Ready
✅ Redis Ready
✅ Listening on port 3000
```

### Test API endpoint

```bash
# Health check
curl http://localhost:3000/health

# Get accepted tokens
curl http://localhost/v1/tokens | jq .

# Get fee quote (example)
curl -X POST http://localhost/v1/quote \
  -H "Content-Type: application/json" \
  -d '{
    "paymentToken": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "userPubkey": "2s91VW55dNZhp7SGE9cPzyBVpJKMVB5yJpCs6YqZBhHQ"
  }'
```

---

## 🔍 Monitoring & Debugging

### View service logs

```bash
# API service
docker-compose logs -f api --tail 50

# Database
docker-compose logs db --tail 20

# Redis
docker-compose logs redis --tail 20

# All services
docker-compose logs -f
```

### Access database directly

```bash
# Connect to PostgreSQL (from host)
psql -h localhost -U holdex_user -d holdex_production

# From inside Docker
docker-compose exec db psql -U holdex_user -d holdex_production
```

### Check RPC credit usage (Phase 4)

```bash
# When calculator running (--profile workers)
docker-compose logs calculator | grep "RPC\|credit"
```

### View Nginx cache performance

```bash
curl -I http://localhost/v1/tokens
# Look for: X-Cache-Status: HIT (good) or MISS (first request)
```

---

## 🛑 Stopping & Cleanup

### Stop all services (preserve data)

```bash
docker-compose down
```

**Data persists** in named volumes: `postgres_data`, `redis_data`

### Remove everything (DESTRUCTIVE)

```bash
docker-compose down -v
# Removes volumes — all data deleted!
```

### Rebuild images

```bash
docker-compose down
docker-compose build --no-cache
docker-compose up -d
```

---

## 🐛 Troubleshooting

### "API service keeps restarting"

```bash
docker-compose logs api --tail 100
```

**Common causes**:
1. Database not ready yet (wait 10s, services take time to initialize)
2. Wrong DATABASE_URL in `.env.local`
3. Port 3000 already in use: `lsof -i :3000` (kill process or change port)

**Fix**: Check logs, verify `.env.local`, wait for `db` to be "healthy"

### "Cannot connect to database"

```bash
docker-compose exec db pg_isready -U holdex_user -d holdex_production
```

**Common causes**:
1. Postgres credentials wrong in `.env.local`
2. Database didn't initialize (volumes need clean start)

**Fix**:
```bash
docker-compose down -v  # Remove volumes
cp .env.example .env.local  # Verify credentials
docker-compose up -d
sleep 20  # Wait for DB init
```

### "Redis connection refused"

```bash
docker-compose exec redis redis-cli ping
```

**Common causes**:
1. Redis service not running
2. REDIS_URL wrong in `.env.local`

**Fix**:
```bash
docker-compose restart redis
```

### "Nginx reports backend down"

```bash
curl -v http://localhost/
# Check X-Cache-Status header
docker-compose logs nginx --tail 20
```

**Common causes**:
1. API not running
2. Health check failing (endpoint /health missing?)

**Fix**:
```bash
docker-compose restart api
curl http://localhost:3000/health  # Direct check
```

---

## 📊 Performance Testing (Phase 1.2)

Once services are healthy:

```bash
# Load test (install: brew install apache2)
ab -n 1000 -c 10 http://localhost/v1/tokens

# Check cache performance
for i in {1..5}; do curl -I http://localhost/v1/tokens | grep X-Cache-Status; done
# Expected: first MISS, rest HIT (1s micro-cache TTL)
```

---

## 📊 Phase 1.2: Database Initialization (Hours 2-4)

After services are running and healthy, initialize the database:

### Option A: Full Initialization (Recommended - 45s)

```bash
# One command: wait for DB → create schema → enable TimescaleDB → verify
docker-compose exec api npm run db:init-full
```

**What it does**:
1. Waits for PostgreSQL to be ready (30s timeout)
2. Creates all required tables
3. Creates indexes (for query performance)
4. Enables TimescaleDB extension
5. Converts candles_1m to hypertable
6. Enables compression (saves 90% space on old data)
7. Verifies all tables exist and are healthy

**Output should look like**:
```
╔════════════════════════════════════════╗
║   HolDex Database Initialization       ║
║   Phase 1.2: Full Setup                ║
╚════════════════════════════════════════╝

⏳ Waiting for database to be ready...
✅ Database is ready!

📊 Initializing Database Schema...
   -> Creating tables...
✅ Schema initialized!

⏱️  Upgrading to TimescaleDB Hypertable...
   -> Creating TimescaleDB extension...
   ✅ TimescaleDB extension ready
   -> Converting candles_1m to hypertable...
   ✅ Hypertable conversion complete
   -> Enabling compression...
   ✅ Compression enabled

✔️  Verifying Database Schema...
   ✅ Found 9 tables
   ✅ Found 5 indexes
   ✅ Found 1 hypertable(s)

╔════════════════════════════════════════╗
║  ✅ DATABASE READY FOR PRODUCTION      ║
║  Phase 1.2 Complete                    ║
╚════════════════════════════════════════╝
```

### Option B: Step-by-Step (Manual)

If you prefer to see each step:

```bash
# Step 1: Create tables only
docker-compose exec api npm run db:init

# Step 2: Enable TimescaleDB
docker-compose exec api npm run migrate:timescale

# Step 3: Verify everything
docker-compose exec api npm run db:verify
```

### Verify Database Health

```bash
# Check schema directly
docker-compose exec api npm run db:verify

# Check PostgreSQL directly
docker-compose exec db psql -U holdex_user -d holdex_production -c "\dt"

# Count rows in each table
docker-compose exec db psql -U holdex_user -d holdex_production << EOF
SELECT tablename, (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE table_name = tablename) as row_count
FROM pg_tables WHERE schemaname = 'public';
EOF
```

---

## 🎯 Phase 1 Completion Checklist

### Phase 1.1 (Docker Configuration)
- [x] Dockerfile updated (npm ci, non-root user)
- [x] .dockerignore created (50 exclusions)
- [x] docker-compose.yml updated (pinned versions, env vars)
- [x] .env.example template created
- [x] Legacy services hidden behind profiles

### Phase 1.2 (Database Initialization)
- [ ] `.env.local` created with real Helius API key
- [ ] `docker-compose up -d` succeeds
- [ ] All 4 services show "Up" in `docker-compose ps`
- [ ] `curl http://localhost/health` returns 200
- [ ] `docker-compose exec api npm run db:init-full` succeeds (0 errors)
- [ ] Hypertable "candles_1m" verified with `docker-compose exec api npm run db:verify`
- [ ] `curl http://localhost/v1/tokens` returns token list (schema working)
- [ ] Logs show no errors: `docker-compose logs`

**When all Phase 1 ✅**: Proceed to **Phase 2 (Task 2.1)**: GASdf integration wiring

---

## 📝 Next Steps

### Phase 1.2 (Hours 2-4): Database Initialization
- Run migration scripts: `docker-compose exec api npm run migrate:timescale`
- Verify schema: `docker-compose exec db psql -U holdex_user -d holdex_production -c '\dt'`

### Phase 2 (Hours 4-30): GASdf Integration
- Wire `/oracle/kscore` endpoint
- Implement `/oracle/discount` fee calculation
- Add `/oracle/webhook/burns` webhook handler

### Phase 3 (Hours 30-42): Observability
- RPC credit tracking (hardcap system)
- API latency profiling
- Cache hit/miss analysis

### Phase 4 (Hours 42-50): RPC Leak Detection [CRITICAL]
- Monitor credit bleed
- Identify silent callers
- Patch leaks before Render deployment

---

## 🆘 Need Help?

**Check logs first**:
```bash
docker-compose logs -f
```

**Rebuild clean**:
```bash
docker-compose down -v
docker volume rm $(docker volume ls -q)
docker-compose build --no-cache
docker-compose up -d
```

**Verify Helius API works**:
```bash
curl -H "x-solana-client: Helius" \
  "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
```

---

**Version**: Phase 1.1 Complete — 2026-02-20
**Changes**: Dockerfile (npm ci, non-root user), .dockerignore (50 excludes), docker-compose (pinned versions, env vars, profiles), .env.example (comprehensive template)
