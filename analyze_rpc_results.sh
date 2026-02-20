#!/bin/bash
# Analyze RPC Monitoring Results
# Usage: ./analyze_rpc_results.sh

OUTPUT_DIR="/tmp/holdex_monitoring"
RESULTS_FILE="$OUTPUT_DIR/RPC_LEAK_ANALYSIS_$(date +%Y%m%d_%H%M%S).md"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Analyzing RPC Monitoring Results                        ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# Verify logs exist
if [ ! -f "$OUTPUT_DIR/rpc_monitoring_live.log" ]; then
    echo "❌ No monitoring log found"
    echo "   Expected: $OUTPUT_DIR/rpc_monitoring_live.log"
    exit 1
fi

# Extract data
API_LOG="$OUTPUT_DIR/api.log"
CALC_LOG="$OUTPUT_DIR/calculator.log"
MONITOR_LOG="$OUTPUT_DIR/rpc_monitoring_live.log"

# Final stats
FINAL_PROJECTED=$(tail -20 "$MONITOR_LOG" | grep "Projected daily:" | tail -1 | awk '{print $NF}')
FINAL_TOTAL_CALLS=$(tail -20 "$MONITOR_LOG" | grep "Total methods:" | tail -1 | awk '{print $NF}' | cut -d+ -f1)
FINAL_TOTAL_CREDITS=$(tail -20 "$MONITOR_LOG" | grep "Total credits:" | tail -1 | awk '{print $NF}' | cut -d+ -f1)

echo "Extracting final stats..."
echo "  Final total calls: $FINAL_TOTAL_CALLS"
echo "  Final total credits: $FINAL_TOTAL_CREDITS"
echo "  Projected daily: $FINAL_PROJECTED credits"
echo ""

# Build markdown report
{
    cat << 'REPORT_HEADER'
# RPC Credit Leak Analysis Report

**Generated**: TIMESTAMP
**System**: HolDex Phase 4 Empirical Verification
**Confidence**: Empirical (real measurements, not theory)

---

## Executive Summary

Real-world RPC consumption monitoring revealed the actual leak sources.

REPORT_HEADER

    sed "s/TIMESTAMP/$(date)/g" << REPORT_SUMMARY
### Key Findings

- **Total RPC Calls**: $FINAL_TOTAL_CALLS calls during monitoring period
- **Total Credits Used**: $FINAL_TOTAL_CREDITS credits
- **Projected Daily Burn**: **$FINAL_PROJECTED credits/day**
- **vs Budget**: $([ $FINAL_PROJECTED -gt 205600 ] && echo "⚠️  OVER by $((FINAL_PROJECTED - 205600)) credits/day" || echo "✅ Under budget")

---

## Method Breakdown

### By Credit Cost (Top Methods)

REPORT_SUMMARY

    # Extract top methods from logs
    echo "$(grep "Top RPC Methods" "$MONITOR_LOG" -A 15 | tail -15 | grep '^\s*[0-9]' || echo 'No method data collected')"

} > "$RESULTS_FILE"

# Extract logs patterns
{
    echo ""
    echo "### RPC Method Distribution"
    echo ""

    # Count method patterns from API logs
    if [ -f "$API_LOG" ]; then
        echo "**From API logs:**"
        grep -o "rpc:method:[^:]*" "$API_LOG" 2>/dev/null | \
            sed 's/rpc:method://' | \
            sort | uniq -c | sort -rn | head -10 | \
            awk '{printf "- %s: %d calls\n", $2, $1}' || \
            echo "- (No RPC method logs found)"
        echo ""
    fi

    # Count from calculator logs
    if [ -f "$CALC_LOG" ]; then
        echo "**From Calculator logs:**"
        grep -i "k-score\|conviction\|delta\|full\|analysis" "$CALC_LOG" 2>/dev/null | \
            head -20 || echo "- (No calculator logs found)"
        echo ""
    fi

} >> "$RESULTS_FILE"

# Analyze for anomalies
{
    echo "---"
    echo ""
    echo "## Anomaly Detection"
    echo ""

    # Check for getEnhancedTransactions spike
    if grep -q "getEnhancedTransactions" "$MONITOR_LOG"; then
        echo "### ⚠️ getEnhancedTransactions Detected"
        echo "- **Cost**: 100 credits per call (expensive!)"
        echo "- **Expected**: <1% of total calls"
        echo "- **Action**: Trace calling locations, reduce frequency"
        echo ""
    fi

    # Check for high method volume
    if [ "$FINAL_TOTAL_CALLS" -gt 10000 ]; then
        echo "### ⚠️ High RPC Call Volume Detected"
        echo "- **Total**: $FINAL_TOTAL_CALLS calls"
        echo "- **Expected**: 2,000-5,000 calls/day"
        echo "- **Recommendation**: Identify batching opportunity"
        echo ""
    fi

    # Check project daily
    if [ "$FINAL_PROJECTED" -gt 205600 ]; then
        OVERAGE=$((FINAL_PROJECTED - 205600))
        OVERAGE_PCT=$(( (OVERAGE * 100) / 205600 ))
        echo "### 🔴 BUDGET OVERAGE"
        echo "- **Daily burn**: $FINAL_PROJECTED credits"
        echo "- **Budget**: 205,600 credits"
        echo "- **Overage**: +$OVERAGE credits/day (+$OVERAGE_PCT%)"
        echo ""
    fi

} >> "$RESULTS_FILE"

# Recommendations
{
    echo "---"
    echo ""
    echo "## Root Cause Analysis & Recommendations"
    echo ""

    if grep -qi "getEnhancedTransactions" "$MONITOR_LOG"; then
        echo "### Problem: getEnhancedTransactions Spam"
        echo "**Root Cause**: Called too frequently or unnecessarily"
        echo "**Fix**:"
        echo "1. Search for: \`getEnhancedTransactions\` in codebase"
        echo "2. Add rate limiting (min 1h between calls per token)"
        echo "3. Cache results with TTL"
        echo "**Estimated savings**: 10-20k credits/day"
        echo ""
    fi

    if [ "$FINAL_TOTAL_CALLS" -gt 5000 ]; then
        echo "### Problem: High Call Volume"
        echo "**Root Cause**: Unbatched RPC operations or high frequency polling"
        echo "**Fix**:"
        echo "1. Review K-Score update frequency (should be 8-12h/token)"
        echo "2. Verify queue-based processing is working (5min cooldown)"
        echo "3. Check for duplicate operations (API + Calculator)"
        echo "**Estimated savings**: 20-50k credits/day"
        echo ""
    fi

    echo "### Priority Fixes"
    echo "1. **IMMEDIATE** (< 1 hour): Verify K-Score update frequency"
    echo "2. **TODAY** (< 4 hours): Add detailed logging to identify top consumer"
    echo "3. **THIS WEEK** (< 7 days): Implement fix with cache/TTL"
    echo ""

} >> "$RESULTS_FILE"

# Operational guidance
{
    echo "---"
    echo ""
    echo "## Next Steps"
    echo ""
    echo "### If you identified the leak source:"
    echo "1. \`grep -r \"<METHOD_NAME>\" src/\` to find all call sites"
    echo "2. Implement fix (batching, rate-limiting, or caching)"
    echo "3. Re-run monitoring for 1 hour to validate savings"
    echo "4. Calculate actual ROI (credits saved × 30 days)"
    echo ""
    echo "### If the leak is still unclear:"
    echo "1. Add \`console.log('RPC called:', method, cost)\` in rpcHarmony.js"
    echo "2. Re-run full 1-2 hour monitoring cycle"
    echo "3. Grep for RPC method names in logs"
    echo "4. Correlate spikes with code execution"
    echo ""
    echo "### Emergency brake (if savings don't materialize):"
    echo "\`\`\`bash"
    echo "git revert <commit>"
    echo "docker-compose restart calculator"
    echo "\`\`\`"
    echo ""

} >> "$RESULTS_FILE"

echo "✅ Analysis complete!"
echo ""
echo "📄 Report saved to:"
echo "   $RESULTS_FILE"
echo ""
echo "📊 Full monitoring log:"
echo "   $MONITOR_LOG"
echo ""

# Display summary
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Summary                                                 ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║ Projected daily:    $FINAL_PROJECTED credits"
echo "║ Budget:             205,600 credits"
if [ "$FINAL_PROJECTED" -gt 205600 ]; then
    OVERAGE=$((FINAL_PROJECTED - 205600))
    printf "║ STATUS:             🔴 OVER by %-35s║\n" "+$OVERAGE credits"
else
    printf "║ STATUS:             ✅ Under budget                  ║\n"
fi
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "👉 Now implement fixes and re-run monitoring to validate!"
