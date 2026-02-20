#!/bin/bash
# Real-time RPC Monitoring Dashboard
# Usage: ./monitor_rpc_live.sh [DURATION_MINUTES] [INTERVAL_SECONDS]

DURATION_MINUTES=${1:-120}  # Default 2 hours
INTERVAL_SECONDS=${2:-30}   # Default 30 second updates
OUTPUT_DIR="/tmp/holdex_monitoring"

mkdir -p "$OUTPUT_DIR"
OUTPUT_FILE="$OUTPUT_DIR/rpc_monitoring_live.log"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  RPC Monitoring Dashboard                                ║"
echo "║  Duration: ${DURATION_MINUTES} minutes                        ║"
echo "║  Update interval: ${INTERVAL_SECONDS} seconds              ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Logging to: $OUTPUT_FILE"
echo ""

# Initialize log
echo "=== RPC Monitoring Session ===" > "$OUTPUT_FILE"
echo "Started: $(date)" >> "$OUTPUT_FILE"
echo "Duration: ${DURATION_MINUTES} minutes" >> "$OUTPUT_FILE"
echo "Interval: ${INTERVAL_SECONDS} seconds" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"

START_TIME=$(date +%s)
END_TIME=$((START_TIME + DURATION_MINUTES * 60))
ITERATION=0
LAST_TOTAL_METHODS=0
LAST_TOTAL_CREDITS=0

while [ $(date +%s) -lt $END_TIME ]; do
    ITERATION=$((ITERATION + 1))
    CURRENT_TIME=$(date '+%Y-%m-%d %H:%M:%S')

    # Get method breakdown
    METHODS=$(docker exec holdex-redis-1 redis-cli KEYS "rpc:method:*:$(date +%Y-%m-%d)*" 2>/dev/null)

    # Calculate totals
    TOTAL_METHODS=0
    TOTAL_CREDITS=0
    declare -A METHOD_CALLS
    declare -A METHOD_CREDITS

    if [ ! -z "$METHODS" ]; then
        while IFS= read -r method_key; do
            count=$(docker exec holdex-redis-1 redis-cli GET "$method_key" 2>/dev/null || echo "0")
            method_name=$(echo "$method_key" | cut -d: -f3)

            # Lookup credit cost
            case "$method_name" in
                getEnhancedTransactions) cost=100 ;;
                getAssetsByOwner) cost=10 ;;
                getMultipleAccounts) cost=5 ;;
                *) cost=1 ;;
            esac

            METHOD_CALLS[$method_name]=$count
            METHOD_CREDITS[$method_name]=$((count * cost))
            TOTAL_METHODS=$((TOTAL_METHODS + count))
            TOTAL_CREDITS=$((TOTAL_CREDITS + METHOD_CREDITS[$method_name]))
        done <<< "$METHODS"
    fi

    # Calculate delta since last iteration
    METHODS_DELTA=$((TOTAL_METHODS - LAST_TOTAL_METHODS))
    CREDITS_DELTA=$((TOTAL_CREDITS - LAST_TOTAL_CREDITS))

    # Format display
    RATE_METHODS_PER_MIN=$(( (METHODS_DELTA * 60) / INTERVAL_SECONDS ))
    RATE_CREDITS_PER_MIN=$(( (CREDITS_DELTA * 60) / INTERVAL_SECONDS ))
    RATE_CREDITS_PER_HOUR=$((RATE_CREDITS_PER_MIN * 60))

    # Clear screen and display
    clear
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║  RPC Monitoring Dashboard - Iteration $ITERATION                   ║"
    echo "║  Time: $CURRENT_TIME                       ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo ""

    # Summary
    echo "📊 TOTALS (Since Start):"
    echo "   Total RPC calls:    $TOTAL_METHODS"
    echo "   Total credits used: $TOTAL_CREDITS"
    echo ""

    # Rate
    echo "⚡ RATE (Last $INTERVAL_SECONDS seconds):"
    echo "   Method calls:       $METHODS_DELTA calls ($RATE_METHODS_PER_MIN/min)"
    echo "   Credits:            $CREDITS_DELTA credits ($RATE_CREDITS_PER_MIN/min, $RATE_CREDITS_PER_HOUR/hour)"
    echo ""

    # Projection
    REMAINING_MINUTES=$((( $(date +%s) - START_TIME ) / 60))
    PROJECTED_DAILY=$((TOTAL_CREDITS * 12 * 60 / (REMAINING_MINUTES + 1)))
    echo "📈 PROJECTION:"
    echo "   Elapsed:            ${REMAINING_MINUTES} minutes"
    echo "   Projected daily:    $PROJECTED_DAILY credits (vs budget 205,600)"
    if [ $PROJECTED_DAILY -gt 205600 ]; then
        OVERAGE=$(( (PROJECTED_DAILY * 100) / 205600 - 100 ))
        echo "   ⚠️  OVERAGE: +${OVERAGE}% above budget"
    fi
    echo ""

    # Top methods
    echo "🏆 TOP RPC METHODS (by credits):"
    if [ ${#METHOD_CREDITS[@]} -eq 0 ]; then
        echo "   (No activity yet)"
    else
        (for method in "${!METHOD_CREDITS[@]}"; do
            echo "${METHOD_CREDITS[$method]}|${METHOD_CALLS[$method]}|$method"
        done) | sort -rn | head -10 | nl | while IFS= read -r num line; do
            credits=$(echo "$line" | cut -d| -f1)
            calls=$(echo "$line" | cut -d| -f2)
            method=$(echo "$line" | cut -d| -f3)
            pct=$(( (credits * 100) / (TOTAL_CREDITS + 1) ))
            printf "   %2d. %-30s %6d cr (%3d%%) [%5d calls]\n" "$num" "$method" "$credits" "$pct" "$calls"
        done
    fi
    echo ""

    # Per-node breakdown
    NODES=$(docker exec holdex-redis-1 redis-cli KEYS "rpc:node:*:$(date +%Y-%m-%d)*" 2>/dev/null)
    if [ ! -z "$NODES" ]; then
        echo "🖥️  PER-NODE BREAKDOWN:"
        echo "$NODES" | while read node_key; do
            node_name=$(echo "$node_key" | cut -d: -f3)
            count=$(docker exec holdex-redis-1 redis-cli GET "$node_key" 2>/dev/null || echo "0")
            pct=$(( (count * 100) / (TOTAL_METHODS + 1) ))
            printf "   %-20s %6d calls (%3d%%)\n" "$node_name" "$count" "$pct"
        done
        echo ""
    fi

    # Save to log
    {
        echo ""
        echo "=== Iteration $ITERATION @ $CURRENT_TIME ==="
        echo "Total methods: $TOTAL_METHODS (+$METHODS_DELTA)"
        echo "Total credits: $TOTAL_CREDITS (+$CREDITS_DELTA)"
        echo "Rate: $RATE_CREDITS_PER_HOUR credits/hour"
        echo "Projected daily: $PROJECTED_DAILY"
        echo ""
    } >> "$OUTPUT_FILE"

    # Update for next iteration
    LAST_TOTAL_METHODS=$TOTAL_METHODS
    LAST_TOTAL_CREDITS=$TOTAL_CREDITS

    # Sleep
    sleep "$INTERVAL_SECONDS"
done

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ✅ Monitoring Complete                                  ║"
echo "║  Results saved to: $OUTPUT_FILE           ║"
echo "║  Next: ./analyze_rpc_results.sh                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
