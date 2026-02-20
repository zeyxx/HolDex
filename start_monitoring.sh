#!/bin/bash
# Quick-Start RPC Monitoring Suite
# Usage: ./start_monitoring.sh

set -e

PROJECT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$PROJECT_DIR"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  HolDex RPC Leak Empirical Phase — Quick Start           ║"
echo "║  Starting Docker containers + monitoring                ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# Phase 1: Startup
echo "[1/5] Stopping old containers..."
docker-compose down -v 2>/dev/null || true
sleep 2

echo "[2/5] Starting fresh containers..."
docker-compose up -d api redis db
sleep 15

echo "[3/5] Verifying health..."
docker-compose ps
echo ""

# Verify connectivity
max_attempts=30
attempts=0
while ! docker exec holdex-redis-1 redis-cli ping > /dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ $attempts -ge $max_attempts ]; then
        echo "❌ Redis failed to start"
        exit 1
    fi
    sleep 1
done
echo "✅ Redis connected"

echo "[4/5] Initializing database..."
docker-compose exec api npm run db:init-full > /tmp/db_init.log 2>&1
echo "✅ Database initialized"

echo "[5/5] Starting log capture..."
mkdir -p /tmp/holdex_monitoring
docker-compose logs -f api > /tmp/holdex_monitoring/api.log 2>&1 &
API_LOG_PID=$!
echo $API_LOG_PID > /tmp/holdex_monitoring/api_log.pid

# Optional: Start calculator
echo ""
read -p "Start calculator service for K-Score analysis? (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    docker-compose --profile workers up -d calculator
    sleep 10
    docker-compose logs -f calculator > /tmp/holdex_monitoring/calculator.log 2>&1 &
    CALC_LOG_PID=$!
    echo $CALC_LOG_PID > /tmp/holdex_monitoring/calc_log.pid
fi

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ✅ READY FOR MONITORING                                 ║"
echo "║                                                          ║"
echo "║  Next Steps:                                             ║"
echo "║  1. In NEW terminal, run:                                ║"
echo "║     ./monitor_rpc_live.sh                                ║"
echo "║                                                          ║"
echo "║  2. In ANOTHER terminal, trigger activity:               ║"
echo "║     curl http://localhost:3000/api/health                ║"
echo "║     (or make API calls to trigger K-Score calc)          ║"
echo "║                                                          ║"
echo "║  3. Let monitor run for 1-2 hours                        ║"
echo "║                                                          ║"
echo "║  4. Analyze results:                                     ║"
echo "║     ./analyze_rpc_results.sh                             ║"
echo "║                                                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# Check baseline
echo "📊 Current RPC key count (should be ~0):"
docker exec holdex-redis-1 redis-cli KEYS "rpc:*" 2>/dev/null | wc -l || echo "0"
echo ""

# Save metadata
echo "$(date +%s)" > /tmp/holdex_monitoring/start_timestamp.txt
echo "Monitoring started at $(date)" > /tmp/holdex_monitoring/session.txt

echo "Logs saved to: /tmp/holdex_monitoring/"
