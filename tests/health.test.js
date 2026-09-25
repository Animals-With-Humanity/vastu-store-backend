const request = require('supertest');

jest.mock('firebase-admin', () => require('./setup/firebaseAdminMock'));
jest.mock('razorpay', () => require('./setup/razorpayMock').RazorpayMock);
jest.mock('nodemailer', () => require('./setup/nodemailerMock'));

let app;

beforeAll(() => {
  app = require('../index');
});

describe('GET /health', () => {
  // WHY: This is the uptime probe hosting/monitoring will hit. It must
  // never depend on Firestore/Razorpay being reachable — verifying that
  // here (no mocks configured with data) proves it's dependency-free.
  it('returns 200 with status "ok" and a numeric timestamp', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.ts).toBe('number');
  });
});