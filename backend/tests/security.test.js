const { createRateLimiter } = require('../lib/rateLimit');
const { buildCorsOptions } = require('../lib/corsOptions');

function mockReqRes(ip = '1.2.3.4') {
    const req = { ip, headers: {} };
    const res = {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
    };
    return { req, res };
}

describe('createRateLimiter', () => {
    test('allows requests under the max and blocks afterwards', () => {
        const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
        const { req, res } = mockReqRes('10.0.0.1');

        let nextCount = 0;
        const next = () => {
            nextCount += 1;
        };

        limiter(req, res, next);
        limiter(req, res, next);
        expect(nextCount).toBe(2);

        limiter(req, res, next);
        expect(nextCount).toBe(2);
        expect(res.statusCode).toBe(429);
        expect(res.body.message).toMatch(/Too many/i);
    });

    test('reset clears counters', () => {
        const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
        const { req, res } = mockReqRes('10.0.0.2');
        let nextCount = 0;
        const next = () => {
            nextCount += 1;
        };

        limiter(req, res, next);
        limiter(req, res, next);
        expect(res.statusCode).toBe(429);

        limiter.reset();
        const again = mockReqRes('10.0.0.2');
        limiter(again.req, again.res, next);
        expect(nextCount).toBe(2);
    });
});

describe('buildCorsOptions', () => {
    test('reflects any origin when allow-list is empty', () => {
        expect(buildCorsOptions('')).toEqual({ origin: true });
        expect(buildCorsOptions(undefined)).toEqual({ origin: true });
    });

    test('allows listed origins and rejects others', (done) => {
        const options = buildCorsOptions('https://a.example,https://b.example');
        options.origin('https://a.example', (err, ok) => {
            expect(err).toBeNull();
            expect(ok).toBe(true);

            options.origin('https://evil.example', (err2) => {
                expect(err2).toBeInstanceOf(Error);
                done();
            });
        });
    });

    test('allows non-browser requests with no Origin header', (done) => {
        const options = buildCorsOptions('https://a.example');
        options.origin(undefined, (err, ok) => {
            expect(err).toBeNull();
            expect(ok).toBe(true);
            done();
        });
    });
});
