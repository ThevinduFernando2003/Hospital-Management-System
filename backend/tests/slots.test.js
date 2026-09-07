const {
    generateAvailableSlots,
    appointmentsOverlap,
} = require('../lib/slots');

describe('generateAvailableSlots', () => {
    test('returns empty array when no availability', () => {
        expect(generateAvailableSlots([], [])).toEqual([]);
        expect(generateAvailableSlots(null, [])).toEqual([]);
    });

    test('builds 30-minute slots inside a window', () => {
        const slots = generateAvailableSlots(
            [{ start_time: '09:00:00', end_time: '11:00:00' }],
            []
        );
        expect(slots).toEqual(['09:00', '09:30', '10:00', '10:30']);
    });

    test('excludes booked times in HH:MM:SS and HH:MM forms', () => {
        const slots = generateAvailableSlots(
            [{ start_time: '09:00:00', end_time: '10:30:00' }],
            ['09:00:00', '09:30']
        );
        expect(slots).toEqual(['10:00']);
    });

    test('rejects invalid slot duration', () => {
        expect(() =>
            generateAvailableSlots([{ start_time: '09:00:00', end_time: '10:00:00' }], [], 0)
        ).toThrow(/positive integer/);
    });
});

describe('appointmentsOverlap', () => {
    test('detects conflict inside 30-minute window', () => {
        expect(
            appointmentsOverlap('2026-09-07 09:00:00', '2026-09-07 09:20:00', 30)
        ).toBe(true);
    });

    test('allows appointments 30+ minutes apart', () => {
        expect(
            appointmentsOverlap('2026-09-07 09:00:00', '2026-09-07 09:30:00', 30)
        ).toBe(false);
    });

    test('throws on invalid dates', () => {
        expect(() => appointmentsOverlap('not-a-date', '2026-09-07')).toThrow(/Invalid/);
    });
});
