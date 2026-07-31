const request = require('supertest');

jest.mock('firebase-admin', () => require('./setup/firebaseAdminMock'));
jest.mock('razorpay', () => require('./setup/razorpayMock').RazorpayMock);
jest.mock('nodemailer', () => require('./setup/nodemailerMock'));

const fbMock = require('./setup/firebaseAdminMock');

let app;

beforeAll(() => {
  app = require('../index');
});

beforeEach(() => {
  fbMock.__reset();
});

describe('POST /payment-failed', () => {

  // WHY: Main path used when the frontend detects a Razorpay failure or
  // the checkout modal is dismissed — must log for support and mark the
  // order abandoned so stock isn't held against it indefinitely.
  it('PF-01: full payload logs the failure and marks the order abandoned', async () => {
    fbMock.__setOrder('order_1', { status: 'pending' });

    const res = await request(app).post('/payment-failed').send({
      orderId: 'order_1',
      error: { description: 'Payment cancelled by user', code: 'BAD_REQUEST_ERROR' },
    });

    expect(res.status).toBe(200);
    expect(res.body.logged).toBe(true);
    expect(fbMock.__getOrder('order_1').status).toBe('abandoned');
    const failures = fbMock.__getFailedPayments();
    expect(failures).toHaveLength(1);
    expect(failures[0].errorDescription).toBe('Payment cancelled by user');
  });

  // WHY: The checkout modal can be dismissed before an order was even
  // created server-side (e.g. Razorpay script failed to load) — no
  // orderId must not crash the endpoint, and no order-update should even
  // be attempted.
  it('PF-02: missing orderId logs with null razorpayOrderId and skips order update', async () => {
    const res = await request(app).post('/payment-failed').send({
      error: { description: 'Script failed to load' },
    });

    expect(res.status).toBe(200);
    expect(res.body.logged).toBe(true);
    const failures = fbMock.__getFailedPayments();
    expect(failures[0].razorpayOrderId).toBeNull();
  });

  // WHY: Confirms the defaulting behavior ('Unknown' description, null
  // code) when the frontend sends an incomplete/absent error object.
  it('PF-03: missing error object defaults to "Unknown" description', async () => {
    const res = await request(app).post('/payment-failed').send({ orderId: 'order_1' });

    expect(res.status).toBe(200);
    const failures = fbMock.__getFailedPayments();
    expect(failures[0].errorDescription).toBe('Unknown');
    expect(failures[0].errorCode).toBeNull();
  });

  // WHY: If we can't even log the failure (Firestore down), the client
  // needs to know logging didn't happen rather than getting a false
  // "logged:true".
  it('PF-04: Firestore add() failure returns 500', async () => {
    fbMock.__injectFailure('failed_payments', 'add', new Error('Firestore unavailable'));

    const res = await request(app).post('/payment-failed').send({ orderId: 'order_1' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Firestore unavailable');
  });

  // WHY: The order-status update is wrapped in `.catch(() => {})` — even
  // if the referenced order doesn't exist (e.g. already deleted, or never
  // created), the failure log must still succeed and the endpoint must
  // still report logged:true.
  it('PF-05: order update failure (order does not exist) is swallowed, still returns logged:true', async () => {
    const res = await request(app).post('/payment-failed').send({
      orderId: 'order_that_does_not_exist',
      error: { description: 'Card declined' },
    });

    expect(res.status).toBe(200);
    expect(res.body.logged).toBe(true);
  });
});