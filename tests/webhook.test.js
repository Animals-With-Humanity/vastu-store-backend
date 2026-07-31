const request = require('supertest');
const crypto = require('crypto');

jest.mock('firebase-admin', () => require('./setup/firebaseAdminMock'));
jest.mock('razorpay', () => require('./setup/razorpayMock').RazorpayMock);
jest.mock('nodemailer', () => require('./setup/nodemailerMock'));

const fbMock = require('./setup/firebaseAdminMock');
const { mockSendMail } = require('./setup/nodemailerMock');

let app;

beforeAll(() => {
  app = require('../index');
});

beforeEach(() => {
  fbMock.__reset();
  mockSendMail.mockClear();
  mockSendMail.mockResolvedValue({ messageId: 'ok' });
});

// Must match RAZORPAY_WEBHOOK_SECRET set in tests/setup/env.js
const WEBHOOK_SECRET = 'whsec_test_secret';

// IMPORTANT: the signature is computed over the exact raw bytes Razorpay
// would send. We must post that exact same string (not re-serialize it)
// or the signature won't match — this mirrors the real webhook contract.
function signedPost(payloadObj) {
  const raw = JSON.stringify(payloadObj);
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  return request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set('x-razorpay-signature', signature)
    .send(raw);
}

const baseOrderDoc = () => ({
  razorpayOrderId: 'order_1',
  items: [{ id: 'prod1', name: 'Dog Bed', variant: null, qty: 1, price: 500 }],
  couponDocId: null,
  status: 'pending',
  customer: null,
});

describe('POST /webhook', () => {

  // WHY: Without a signature header, we can't trust the payload is really
  // from Razorpay — must reject before even trying to parse the body.
  it('WH-01: missing signature header returns 400', async () => {
    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ event: 'payment.captured' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid webhook');
  });

  // WHY: Core webhook security check — a forged event must never be
  // allowed to mark an order as paid.
  it('WH-02: signature mismatch returns 400', async () => {
    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', 'forged-signature')
      .send(JSON.stringify({ event: 'payment.captured' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Signature mismatch');
  });

  // WHY: A signature can be valid over garbage bytes (e.g. truncated
  // request) — JSON.parse failure must be handled distinctly from a
  // signature failure.
  it('WH-03: valid signature but malformed JSON body returns 400 "Bad JSON"', async () => {
    const raw = '{not valid json';
    const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');

    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', signature)
      .send(raw);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Bad JSON');
  });

  // WHY: The main server-to-server confirmation path — this is often the
  // FIRST confirmation to arrive (faster than the client's own callback),
  // so it must fully confirm the order and email the customer on its own.
  it('WH-04: payment.captured confirms a pending order and sends the email', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    fbMock.__setOrder('order_1', {
      ...baseOrderDoc(),
      customer: { firstName: 'Asha', lastName: 'K', email: 'asha@example.com', phone: '9999999999',
        address: { line1: 'A1', city: 'Bhopal', state: 'MP', pin: '462001' } },
    });

    const res = await signedPost({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1' } } },
    });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(fbMock.__getOrder('order_1').status).toBe('paid');
    expect(fbMock.__getProduct('prod1').stock).toBe(9);

    await new Promise((r) => setImmediate(r));
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  // WHY: Duplicate webhook deliveries are expected from Razorpay (at-least-
  // once delivery). If the client's /verify-payment call already confirmed
  // the order, a duplicate payment.captured webhook must be a safe no-op —
  // no double stock deduction, no duplicate email.
  it('WH-05: payment.captured for an already-paid order is idempotent', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    fbMock.__setOrder('order_1', { ...baseOrderDoc(), status: 'paid' });

    const res = await signedPost({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1' } } },
    });

    expect(res.status).toBe(200);
    expect(fbMock.__getProduct('prod1').stock).toBe(10); // untouched
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  // WHY: Critical behavior to document — Razorpay expects a 2xx response
  // or it will retry (and eventually alert) the webhook delivery. This
  // handler deliberately swallows confirmOrder() errors and still returns
  // 200 (with a warning field) so a single bad event doesn't trigger a
  // retry storm. If this ever silently changed to a 500, Razorpay would
  // hammer the endpoint with retries.
  it('WH-06: payment.captured for an unknown order still returns 200 with a warning', async () => {
    const res = await signedPost({
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_1', order_id: 'order_does_not_exist' } } },
    });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
    expect(res.body.warning).toBeDefined();
  });

  // WHY: Failed payments must be recorded for the ops/support team, and
  // the order status flipped so it doesn't look "pending" forever.
  it('WH-07: payment.failed logs to failed_payments and marks the order failed', async () => {
    fbMock.__setOrder('order_1', baseOrderDoc());

    const res = await signedPost({
      event: 'payment.failed',
      payload: { payment: { entity: {
        id: 'pay_1', order_id: 'order_1', error_code: 'BAD_REQUEST_ERROR', error_description: 'Card declined',
      } } },
    });

    expect(res.status).toBe(200);
    expect(fbMock.__getOrder('order_1').status).toBe('failed');
    const failures = fbMock.__getFailedPayments();
    expect(failures).toHaveLength(1);
    expect(failures[0].errorDescription).toBe('Card declined');
  });

  // WHY: The order-status update after a failure is wrapped in
  // `.catch(() => {})` — verifies that's truly non-fatal even when the
  // order doesn't exist to update.
  it('WH-08: payment.failed for a non-existent order still returns 200', async () => {
    const res = await signedPost({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_1', order_id: 'order_ghost', error_description: 'timeout' } } },
    });

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  // WHY: `order.paid` is a distinct Razorpay event from `payment.captured`
  // and uses a different status label — confirms it's handled and doesn't
  // fall through to the "unhandled event" branch.
  it('WH-09: order.paid updates order status to order_paid_webhook', async () => {
    fbMock.__setOrder('order_1', baseOrderDoc());

    const res = await signedPost({
      event: 'order.paid',
      payload: { order: { entity: { id: 'order_1' } } },
    });

    expect(res.status).toBe(200);
    expect(fbMock.__getOrder('order_1').status).toBe('order_paid_webhook');
  });

  // WHY: Razorpay may add new event types over time; unrecognized events
  // must be a harmless no-op, never a crash.
  it('WH-10: an unrecognized event type is a no-op that still returns 200', async () => {
    const res = await signedPost({ event: 'refund.processed', payload: {} });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});