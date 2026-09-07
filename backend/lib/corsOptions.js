/**
 * Build CORS options from ALLOWED_ORIGINS (comma-separated).
 * If unset/empty, reflect any origin (legacy demo behaviour).
 */
function buildCorsOptions(allowedOriginsEnv = process.env.ALLOWED_ORIGINS) {
    const raw = (allowedOriginsEnv || '').trim();
    if (!raw) {
        return { origin: true };
    }

    const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);

    return {
        origin(origin, callback) {
            // Non-browser clients (curl, server-to-server) often omit Origin
            if (!origin || allowed.includes(origin)) {
                return callback(null, true);
            }
            return callback(new Error(`CORS blocked for origin: ${origin}`));
        },
    };
}

module.exports = { buildCorsOptions };
