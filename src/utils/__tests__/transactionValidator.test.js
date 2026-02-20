/**
 * Transaction Validator Tests
 */

const validator = require('../transactionValidator');

// Mock Solana Transaction for testing
class MockTransaction {
    constructor(options = {}) {
        this.feePayer = options.feePayer || null;
        this.instructions = options.instructions || [];
        this.signatures = options.signatures || [];
        this.recentBlockhash = options.recentBlockhash || 'BlockhashHere11111111111111111111';
    }

    serialize(options = {}) {
        // Simulate serialize: return buffer
        if (this.instructions.length === 0 && !this.feePayer) {
            return new Uint8Array(0); // Empty
        }
        // Mock: return buffer based on instruction count
        const size = 32 + (this.instructions.length * 64);
        return new Uint8Array(Math.min(size, 2000));
    }
}

describe('TransactionValidator', () => {
    describe('validate()', () => {
        test('should pass valid transaction', () => {
            const tx = new MockTransaction({
                feePayer: 'Phantom',
                instructions: [{ keys: [] }],
            });

            const result = validator.validate(tx);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
            expect(result.size).toBeGreaterThan(0);
        });

        test('should reject empty transaction', () => {
            const tx = new MockTransaction({});
            const result = validator.validate(tx);

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Transaction is empty (size 0 bytes)');
        });

        test('should reject oversized transaction', () => {
            const tx = new MockTransaction({
                feePayer: 'test',
                instructions: Array(50).fill({ keys: [] }), // Will exceed 1232 bytes
            });

            const result = validator.validate(tx);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.includes('too large'))).toBe(true);
        });

        test('should warn on no fee payer', () => {
            const tx = new MockTransaction({
                instructions: [{ keys: [] }],
            });

            const result = validator.validate(tx);

            expect(result.warnings.some(w => w.includes('fee payer'))).toBe(true);
        });

        test('should warn on no instructions', () => {
            const tx = new MockTransaction({
                feePayer: 'test',
                instructions: [],
            });

            const result = validator.validate(tx);

            expect(result.warnings.some(w => w.includes('no instructions'))).toBe(true);
        });

        test('should include timestamp', () => {
            const tx = new MockTransaction({
                feePayer: 'test',
                instructions: [{ keys: [] }],
            });

            const result = validator.validate(tx);

            expect(result.timestamp).toBeDefined();
            expect(new Date(result.timestamp).getTime()).toBeGreaterThan(0);
        });
    });

    describe('validateOrThrow()', () => {
        test('should throw on invalid transaction', () => {
            const tx = new MockTransaction({});

            expect(() => {
                validator.validateOrThrow(tx);
            }).toThrow('Transaction validation failed');
        });

        test('should not throw on valid transaction', () => {
            const tx = new MockTransaction({
                feePayer: 'test',
                instructions: [{ keys: [] }],
            });

            expect(() => {
                validator.validateOrThrow(tx);
            }).not.toThrow();
        });

        test('should attach validation result to error', () => {
            const tx = new MockTransaction({});

            try {
                validator.validateOrThrow(tx);
            } catch (err) {
                expect(err.validationResult).toBeDefined();
                expect(err.validationResult.errors).toBeDefined();
            }
        });
    });

    describe('validateSilent()', () => {
        test('should never throw', () => {
            const tx = new MockTransaction({});

            expect(() => {
                validator.validateSilent(tx);
            }).not.toThrow();
        });

        test('should return result with errors', () => {
            const tx = new MockTransaction({});

            const result = validator.validateSilent(tx);

            expect(result.valid).toBe(false);
            expect(result.errors).toHaveLength(1);
        });
    });

    describe('Constants', () => {
        test('should export size limits', () => {
            expect(validator.MAX_TRANSACTION_SIZE).toBe(1232);
            expect(validator.MIN_TRANSACTION_SIZE).toBe(32);
        });
    });
});
