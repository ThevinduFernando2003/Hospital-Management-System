/**
 * Pure invoice calculation mirroring CalculateInvoiceFromTreatments.
 * Adds a safety clamp: insurance coverage cannot exceed total amount.
 */

const DEFAULT_CONSULTATION_FEE = 80.0;

/**
 * @param {number[]} treatmentPrices
 * @param {number} [insuranceCoverage=0]
 * @param {number} [initialPayment=0]
 * @param {number} [defaultFee=DEFAULT_CONSULTATION_FEE]
 */
function calculateInvoiceTotals(
    treatmentPrices = [],
    insuranceCoverage = 0,
    initialPayment = 0,
    defaultFee = DEFAULT_CONSULTATION_FEE
) {
    const prices = (treatmentPrices || []).map(Number).filter((p) => !Number.isNaN(p) && p >= 0);
    let totalAmount = prices.reduce((sum, p) => sum + p, 0);

    if (totalAmount === 0) {
        totalAmount = defaultFee;
    }

    const coverageRaw = Number(insuranceCoverage) || 0;
    const paymentRaw = Number(initialPayment) || 0;

    if (coverageRaw < 0 || paymentRaw < 0) {
        throw new Error('Insurance coverage and initial payment cannot be negative');
    }

    const insurance = Math.min(coverageRaw, totalAmount);
    const outOfPocket = roundMoney(totalAmount - insurance);
    const dueAmount = roundMoney(outOfPocket - paymentRaw);

    let status = 'Pending';
    if (dueAmount <= 0) {
        status = 'Paid';
    } else if (paymentRaw > 0) {
        status = 'Partially Paid';
    }

    return {
        totalAmount: roundMoney(totalAmount),
        insuranceCoverage: roundMoney(insurance),
        outOfPocketAmount: outOfPocket,
        dueAmount: Math.max(0, dueAmount),
        status,
        insuranceClamped: coverageRaw > totalAmount,
    };
}

/**
 * Whether a new payment would exceed the invoice total (PreventOverpayment).
 */
function wouldOverpay(invoiceTotal, alreadyPaid, newPayment) {
    const total = Number(invoiceTotal);
    const paid = Number(alreadyPaid) || 0;
    const next = Number(newPayment);

    if ([total, paid, next].some((n) => Number.isNaN(n))) {
        throw new Error('Invalid payment amounts');
    }
    if (next <= 0) {
        throw new Error('Payment amount must be positive');
    }

    return paid + next > total + 1e-9;
}

function roundMoney(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function isValidPatientDob(dob, today = new Date()) {
    const birth = new Date(dob);
    if (Number.isNaN(birth.getTime())) return false;

    const now = new Date(today);
    if (birth > now) return false;

    const oldest = new Date(now);
    oldest.setFullYear(oldest.getFullYear() - 120);
    if (birth < oldest) return false;

    return true;
}

module.exports = {
    DEFAULT_CONSULTATION_FEE,
    calculateInvoiceTotals,
    wouldOverpay,
    roundMoney,
    isValidPatientDob,
};
