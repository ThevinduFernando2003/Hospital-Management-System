/**
 * Simple in-memory sliding-window rate limiter (per key).
 * Suitable for single-instance demos; use Redis for multi-instance production.
 */
function createRateLimiter({ windowMs = 15 * 60 * 1000, max = 20, message } = {}) {
    const hits = new Map();

    function prune(now) {
        for (const [key, timestamps] of hits.entries()) {
            const fresh = timestamps.filter((t) => now - t < windowMs);
            if (fresh.length === 0) hits.delete(key);
            else hits.set(key, fresh);
        }
    }

    function middleware(req, res, next) {
        const now = Date.now();
        prune(now);

        const key = req.ip || req.headers['x-forwarded-for'] || 'unknown';
        const timestamps = hits.get(key) || [];
        const recent = timestamps.filter((t) => now - t < windowMs);

        if (recent.length >= max) {
            return res.status(429).json({
                message: message || 'Too many requests. Please try again later.',
            });
        }

        recent.push(now);
        hits.set(key, recent);
        next();
    }

    middleware._hits = hits;
    middleware.reset = () => hits.clear();

    return middleware;
}

module.exports = { createRateLimiter };
