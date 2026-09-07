const {
    calculateInvoiceTotals,
    wouldOverpay,
    isValidPatientDob,
    DEFAULT_CONSULTATION_FEE,
} = require('../lib/billing');

describe('calculateInvoiceTotals', () => {
    test('uses default consultation fee when no treatments', () => {
        const result = calculateInvoiceTotals([], 0, 0);
        expect(result.totalAmount).toBe(DEFAULT_CONSULTATION_FEE);
        expect(result.status).toBe('Pending');
        expect(result.dueAmount).toBe(DEFAULT_CONSULTATION_FEE);
    });

    test('sums treatment prices and applies insurance', () => {
        const result = calculateInvoiceTotals([50, 30], 20, 0);
        expect(result.totalAmount).toBe(80);
        expect(result.insuranceCoverage).toBe(20);
        expect(result.outOfPocketAmount).toBe(60);
        expect(result.dueAmount).toBe(60);
        expect(result.status).toBe('Pending');
    });

    test('clamps insurance coverage that exceeds total', () => {
        const result = calculateInvoiceTotals([40], 100, 0);
        expect(result.insuranceCoverage).toBe(40);
        expect(result.insuranceClamped).toBe(true);
        expect(result.dueAmount).toBe(0);
        expect(result.status).toBe('Paid');
    });

    test('marks partially paid when initial payment is below due', () => {
        const result = calculateInvoiceTotals([100], 0, 40);
        expect(result.status).toBe('Partially Paid');
        expect(result.dueAmount).toBe(60);
    });

    test('rejects negative money inputs', () => {
        expect(() => calculateInvoiceTotals([10], -1, 0)).toThrow(/negative/);
    });
});

describe('wouldOverpay', () => {
    test('blocks payments that exceed invoice total', () => {
        expect(wouldOverpay(100, 80, 30)).toBe(true);
        expect(wouldOverpay(100, 80, 20)).toBe(false);
    });

    test('rejects non-positive payment amounts', () => {
        expect(() => wouldOverpay(100, 0, 0)).toThrow(/positive/);
    });
});

describe('isValidPatientDob', () => {
    const today = new Date('2026-09-07T00:00:00Z');

    test('rejects future DOB', () => {
        expect(isValidPatientDob('2027-01-01', today)).toBe(false);
    });

    test('rejects DOB older than 120 years', () => {
        expect(isValidPatientDob('1800-01-01', today)).toBe(false);
    });

    test('accepts a reasonable DOB', () => {
        expect(isValidPatientDob('1995-05-20', today)).toBe(true);
    });
});
