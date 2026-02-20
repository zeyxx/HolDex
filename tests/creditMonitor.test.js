const test = require('node:test');
const assert = require('node:assert');
const { CreditMonitor, getCreditMonitor } = require('../src/services/creditMonitor');

test('CreditMonitor - RPC Credit Usage Tracking', async (t) => {
    await t.test('tracks RPC calls and credits', () => {
        const monitor = new CreditMonitor();

        monitor.recordCall('getBalance', 'helius', 1);
        monitor.recordCall('getBalance', 'helius', 1);

        const metrics = monitor.getMetrics();
        assert.strictEqual(metrics.rpcCallsMade, 2);
        assert.strictEqual(metrics.estimatedCreditsUsed, 2);
        assert.strictEqual(metrics.creditsSaved, 0);
    });

    await t.test('tracks deduplicated calls and calculates savings', () => {
        const monitor = new CreditMonitor();

        // First call uses 1 credit
        monitor.recordCall('getBalance', 'helius', 1, false);

        // Second identical call is deduped, saves 1 credit
        monitor.recordCall('getBalance', 'helius', 1, true);

        const metrics = monitor.getMetrics();
        assert.strictEqual(metrics.rpcCallsMade, 2);
        assert.strictEqual(metrics.rpcCallsDedup, 1);
        assert.strictEqual(metrics.creditsSaved, 1);
        assert.strictEqual(metrics.savingsPercent, '50.0');
    });

    await t.test('calculates method breakdown', () => {
        const monitor = new CreditMonitor();

        monitor.recordCall('getBalance', 'helius', 1);
        monitor.recordCall('getBalance', 'helius', 1, true);
        monitor.recordCall('getTransaction', 'helius', 1);

        const metrics = monitor.getMetrics();
        assert.strictEqual(metrics.breakdown.method_counts['getBalance'].made, 2);
        assert.strictEqual(metrics.breakdown.method_counts['getBalance'].dedup, 1);
        assert.strictEqual(metrics.breakdown.method_counts['getTransaction'].made, 1);
    });

    await t.test('tracks provider usage', () => {
        const monitor = new CreditMonitor();

        monitor.recordCall('getBalance', 'helius', 1);
        monitor.recordCall('getTransaction', 'public', 1);

        const metrics = monitor.getMetrics();
        assert.strictEqual(metrics.breakdown.provider_usage['helius'].calls, 1);
        assert.strictEqual(metrics.breakdown.provider_usage['public'].calls, 1);
        assert.strictEqual(metrics.breakdown.provider_usage['helius'].credits, 1);
        assert.strictEqual(metrics.breakdown.provider_usage['public'].credits, 1);
    });

    await t.test('updates from RPC deduplication stats', () => {
        const monitor = new CreditMonitor();

        const dedupStats = {
            totalRequests: 100,
            deduplicatedRequests: 30,
            percentSaved: '30.0%',
            inflightCount: 5
        };

        monitor.updateFromRPC(dedupStats);

        const metrics = monitor.getMetrics();
        assert.strictEqual(metrics.rpcCallsMade, 100);
        assert.strictEqual(metrics.rpcCallsDedup, 30);
        assert.strictEqual(metrics.creditsSaved, 30);
        assert.strictEqual(metrics.savingsPercent, '30.0');
    });

    await t.test('generates summary string', () => {
        const monitor = new CreditMonitor();

        monitor.recordCall('getBalance', 'helius', 1);
        monitor.recordCall('getBalance', 'helius', 1, true);

        const summary = monitor.getSummary();
        assert(summary.includes('1 used'), 'Summary should contain credit usage');
        assert(summary.includes('1 saved'), 'Summary should contain credits saved');
        assert(summary.includes('50.0%'), 'Summary should contain savings percentage');
        assert(summary.includes('2 made'), 'Summary should contain calls made');
        assert(summary.includes('1 deduped'), 'Summary should contain deduped calls');
    });

    await t.test('resets metrics', () => {
        const monitor = new CreditMonitor();

        monitor.recordCall('getBalance', 'helius', 1);
        monitor.recordCall('getBalance', 'helius', 1, true);

        monitor.reset();

        const metrics = monitor.getMetrics();
        assert.strictEqual(metrics.rpcCallsMade, 0);
        assert.strictEqual(metrics.creditsSaved, 0);
        assert.strictEqual(metrics.savingsPercent, 0);
    });

    await t.test('returns singleton instance', () => {
        const monitor1 = getCreditMonitor();
        const monitor2 = getCreditMonitor();

        assert.strictEqual(monitor1, monitor2);
    });

    await t.test('calculates uptime in minutes', () => {
        const monitor = new CreditMonitor();

        // Simulate time passage
        const metrics = monitor.getMetrics();
        assert(metrics.uptime_minutes !== undefined, 'uptime_minutes should be defined');
        assert(parseFloat(metrics.uptime_minutes) >= 0, 'uptime should be >= 0');
    });

    await t.test('demonstrates 30% deduplication target', () => {
        const monitor = new CreditMonitor();

        // Simulate 1000 RPC calls with 30% deduplication rate (target from hypothesis)
        for (let i = 0; i < 700; i++) {
            monitor.recordCall('getBalance', 'helius', 1, false);
        }
        for (let i = 0; i < 300; i++) {
            monitor.recordCall('getBalance', 'helius', 1, true);
        }

        const metrics = monitor.getMetrics();
        assert.strictEqual(metrics.rpcCallsMade, 1000);
        assert.strictEqual(metrics.rpcCallsDedup, 300);
        assert.strictEqual(metrics.savingsPercent, '30.0');
        assert.strictEqual(metrics.creditsSaved, 300);

        // Without dedup: 1000 credits
        // With dedup: 700 credits
        // Savings: 300 credits (30%)
        assert.strictEqual(metrics.estimatedCreditsUsed, 700);
    });
});
