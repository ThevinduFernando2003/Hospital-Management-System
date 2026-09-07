/**
 * Generate free appointment time slots from weekly availability windows.
 * @param {Array<{start_time: string, end_time: string}>} availabilityWindows
 * @param {Iterable<string>} bookedTimes - times like "09:00:00" or "09:00"
 * @param {number} [slotDurationMinutes=30]
 * @returns {string[]} free slots as "HH:MM"
 */
function generateAvailableSlots(availabilityWindows, bookedTimes = [], slotDurationMinutes = 30) {
    if (!Array.isArray(availabilityWindows) || availabilityWindows.length === 0) {
        return [];
    }
    if (!Number.isInteger(slotDurationMinutes) || slotDurationMinutes <= 0) {
        throw new Error('slotDurationMinutes must be a positive integer');
    }

    const booked = new Set(
        [...bookedTimes].map((t) => {
            const s = String(t).trim();
            return s.length === 5 ? `${s}:00` : s;
        })
    );

    const availableSlots = [];

    for (const slot of availabilityWindows) {
        if (!slot || !slot.start_time || !slot.end_time) continue;

        const startHour = parseInt(String(slot.start_time).substring(0, 2), 10);
        const startMin = parseInt(String(slot.start_time).substring(3, 5), 10);
        const endHour = parseInt(String(slot.end_time).substring(0, 2), 10);
        const endMin = parseInt(String(slot.end_time).substring(3, 5), 10);

        if ([startHour, startMin, endHour, endMin].some((n) => Number.isNaN(n))) {
            continue;
        }

        let currentHour = startHour;
        let currentMin = startMin;

        while (currentHour < endHour || (currentHour === endHour && currentMin < endMin)) {
            const timeSlot = `${String(currentHour).padStart(2, '0')}:${String(currentMin).padStart(2, '0')}:00`;
            if (!booked.has(timeSlot)) {
                availableSlots.push(timeSlot.substring(0, 5));
            }

            currentMin += slotDurationMinutes;
            if (currentMin >= 60) {
                currentHour += Math.floor(currentMin / 60);
                currentMin = currentMin % 60;
            }
        }
    }

    return availableSlots;
}

/**
 * True if two appointment datetimes conflict within the clinic slot window.
 * Mirrors PreventOverlappingAppointments trigger (30-minute window).
 */
function appointmentsOverlap(dateA, dateB, windowMinutes = 30) {
    const a = new Date(dateA).getTime();
    const b = new Date(dateB).getTime();
    if (Number.isNaN(a) || Number.isNaN(b)) {
        throw new Error('Invalid appointment datetime');
    }
    const diffMinutes = Math.abs(a - b) / (60 * 1000);
    return diffMinutes < windowMinutes;
}

module.exports = {
    generateAvailableSlots,
    appointmentsOverlap,
};
