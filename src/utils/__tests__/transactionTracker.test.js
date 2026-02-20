/**
 * Transaction Tracker Tests
 */

const { TransactionTracker, getTracker, resetTracker } = require('../transactionTracker');

describe('TransactionTracker', () => {
    let tracker;

    beforeEach(() => {
        resetTracker();
        tracker = new TransactionTracker();
    });

    describe('trackTransaction()', () => {
        test('should track new transaction', () => {
            const activity = tracker.trackTransaction({
                signature: 'sig123',
                method: 'sendTransaction',
                size: 100,
            });

            expect(activity.signature).toBe('sig123');
            expect(activity.status).toBe('pending');
            expect(activity.timestamp).toBeDefined();
        });

        test('should emit transaction:tracked event', (done) => {
            tracker.on('transaction:tracked', (data) => {
                expect(data.signature).toBe('sig456');
                expect(data.status).toBe('pending');
                done();
            });

            tracker.trackTransaction({
                signature: 'sig456',
                method: 'sendTransaction',
            });
        });

        test('should maintain rolling cap (FIFO)', () => {
            // Fill to capacity
            for (let i = 0; i < 25; i++) {
                tracker.trackTransaction({
                    signature: `sig${i}`,
                    method: 'test',
                });
            }

            // Should only have MAX_TRANSACTIONS
            expect(tracker.getAll()).toHaveLength(20);

            // Most recent should be first
            expect(tracker.getAll()[0].signature).toBe('sig24');
        });
    });

    describe('updateStatus()', () => {
        test('should update transaction status', () => {
            tracker.trackTransaction({
                signature: 'sig789',
                status: 'pending',
            });

            tracker.updateStatus('sig789', 'confirmed');

            const tx = tracker.getBySignature('sig789');
            expect(tx.status).toBe('confirmed');
        });

        test('should emit transaction:updated event', (done) => {
            tracker.trackTransaction({ signature: 'sigA' });

            tracker.on('transaction:updated', (data) => {
                expect(data.signature).toBe('sigA');
                expect(data.status).toBe('confirmed');
                expect(data.oldStatus).toBe('pending');
                done();
            });

            tracker.updateStatus('sigA', 'confirmed');
        });

        test('should store error message on failure', () => {
            tracker.trackTransaction({ signature: 'sigB' });

            tracker.updateStatus('sigB', 'failed', 'Network timeout');

            const tx = tracker.getBySignature('sigB');
            expect(tx.error).toBe('Network timeout');
        });

        test('should handle missing transaction gracefully', () => {
            expect(() => {
                tracker.updateStatus('nonexistent', 'confirmed');
            }).not.toThrow();
        });
    });

    describe('getByStatus()', () => {
        beforeEach(() => {
            tracker.trackTransaction({ signature: 'p1', status: 'pending' });
            tracker.trackTransaction({ signature: 'c1', status: 'confirmed' });
            tracker.trackTransaction({ signature: 'p2', status: 'pending' });
            tracker.trackTransaction({ signature: 'f1', status: 'failed' });
        });

        test('should filter by pending', () => {
            const pending = tracker.getByStatus('pending');
            expect(pending).toHaveLength(2);
        });

        test('should filter by confirmed', () => {
            const confirmed = tracker.getByStatus('confirmed');
            expect(confirmed).toHaveLength(1);
        });

        test('should filter by failed', () => {
            const failed = tracker.getByStatus('failed');
            expect(failed).toHaveLength(1);
        });
    });

    describe('getRecent()', () => {
        beforeEach(() => {
            for (let i = 0; i < 10; i++) {
                tracker.trackTransaction({ signature: `sig${i}` });
            }
        });

        test('should return N most recent', () => {
            const recent = tracker.getRecent(3);
            expect(recent).toHaveLength(3);
            expect(recent[0].signature).toBe('sig9');
            expect(recent[2].signature).toBe('sig7');
        });

        test('should return fewer if not enough transactions', () => {
            tracker.clear();
            tracker.trackTransaction({ signature: 'only1' });

            const recent = tracker.getRecent(5);
            expect(recent).toHaveLength(1);
        });
    });

    describe('getStats()', () => {
        beforeEach(() => {
            tracker.trackTransaction({ signature: 'p1', status: 'pending', size: 100 });
            tracker.trackTransaction({ signature: 'c1', status: 'confirmed', size: 150 });
            tracker.trackTransaction({ signature: 'f1', status: 'failed', size: 50 });
        });

        test('should count by status', () => {
            const stats = tracker.getStats();
            expect(stats.pending).toBe(1);
            expect(stats.confirmed).toBe(1);
            expect(stats.failed).toBe(1);
        });

        test('should calculate success rate', () => {
            const stats = tracker.getStats();
            expect(stats.successRate).toBe(0.5); // 1 success, 1 failure
        });

        test('should calculate average size', () => {
            const stats = tracker.getStats();
            expect(stats.avgSize).toBe(100); // (100+150+50)/3
        });

        test('should handle empty tracker', () => {
            tracker.clear();
            const stats = tracker.getStats();

            expect(stats.total).toBe(0);
            expect(stats.successRate).toBe(0);
            expect(stats.avgSize).toBe(0);
        });
    });

    describe('subscribe()', () => {
        test('should call callback on events', (done) => {
            let eventCount = 0;

            const unsub = tracker.subscribe((eventType, data) => {
                eventCount++;
                if (eventCount === 2) {
                    expect(eventType).toBe('updated');
                    unsub();
                    done();
                }
            });

            tracker.trackTransaction({ signature: 'test' });
            tracker.updateStatus('test', 'confirmed');
        });

        test('should unsubscribe correctly', () => {
            let callCount = 0;

            const unsub = tracker.subscribe(() => {
                callCount++;
            });

            tracker.trackTransaction({ signature: 'test1' });
            unsub();
            tracker.trackTransaction({ signature: 'test2' });

            expect(callCount).toBe(1); // Only first call
        });
    });

    describe('Singleton', () => {
        test('getTracker() should return same instance', () => {
            const t1 = getTracker();
            const t2 = getTracker();

            expect(t1).toBe(t2);
        });

        test('resetTracker() should clear singleton', () => {
            const t = getTracker();
            t.trackTransaction({ signature: 'x' });

            resetTracker();

            expect(getTracker().getAll()).toHaveLength(0);
        });
    });
});
