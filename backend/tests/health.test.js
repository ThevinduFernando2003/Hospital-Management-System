/**
 * @jest-environment node
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-jest';

const request = require('supertest');

// Import after env is set so server.js does not exit
const { app, loginRateLimiter } = require('../server');

describe('GET /api/health', () => {
    test('returns JSON health payload (ok or degraded)', async () => {
        const res = await request(app).get('/api/health');
        expect([200, 503]).toContain(res.status);
        expect(res.body).toHaveProperty('service', 'clinicpro-api');
        expect(res.body).toHaveProperty('status');
        expect(res.body).toHaveProperty('database');
        expect(res.body).toHaveProperty('uptimeSeconds');
    });
});

describe('POST /api/login rate limiting', () => {
    beforeEach(() => {
        loginRateLimiter.reset();
    });

    test('returns 400 when credentials missing (still counts as attempt path)', async () => {
        const res = await request(app).post('/api/login').send({});
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/required/i);
    });
});
