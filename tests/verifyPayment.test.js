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

// Must match RAZORPAY_KEY_SECRET set in tests/setup/env.js
const KEY_SECRET = 'rzp_test_key_secret';

function sign(orderId, paymentId) {
  return crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}

const baseOrderDoc = () => ({
  razorpayOrderId: 'order_1',
  items: [{ id: 'prod1', name: 'Dog Bed', variant: null, qty: 2, price: 500 }],
  couponDocId: null,
  status: 'pending',
  customer: null,
  subtotal: 1000, discount: 0, shipping: 0, platformFee: 20, platformFeeGst: 3.6, total: 1023.6,
});

describe('POST /verify-payment', () => {

  // WHY: Basic required-field validation — the frontend must send all
  // three Razorpay callback fields; a missing field means the signature
  // can't even be computed.
  it('VP-01: missing fields returns 400 without attempting HMAC verification', async () => {
    const res = await request(app).post('/verify-payment').send({ razorpay_order_id: 'order_1' });
    expect(res.status).toBe(400);
    expect(res.body.verified).toBe(false);
    expect(res.body.error).toBe('Missing payment fields');
  });

  // WHY: This is the core anti-fraud check — a forged/tampered signature
  // must never confirm an order. Also verifies the failure gets logged
  // for manual review (failed_payments collection).
  it('VP-02: invalid signature returns 400 and logs to failed_payments', async () => {
    fbMock.__setOrder('order_1', baseOrderDoc());

    const res = await request(app).post('/verify-payment').send({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: 'not-a-real-signature',
    });

    expect(res.status).toBe(400);
    expect(res.body.verified).toBe(false);
    expect(res.body.error).toBe('Signature mismatch');
    expect(fbMock.__getFailedPayments().length).toBe(1);
    expect(fbMock.__getFailedPayments()[0].errorDescription).toBe('Signature mismatch');
  });

  // WHY: A valid signature for an order that doesn't exist in Firestore
  // (e.g. tampered order id, or a race where the order record was never
  // created) must fail cleanly rather than crash the transaction.
  it('VP-03: valid signature but unknown order returns 500 "Order not found"', async () => {
    const res = await request(app).post('/verify-payment').send({
      razorpay_order_id: 'order_missing',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: sign('order_missing', 'pay_1'),
    });

    expect(res.status).toBe(500);
    expect(res.body.verified).toBe(false);
    expect(res.body.error).toBe('Order not found');
  });

  // WHY: Idempotency guard — if the webhook already confirmed this order
  // (e.g. it arrived before this client callback), re-processing must be a
  // safe no-op: no double stock deduction, no duplicate email.
  it('VP-04: an already-paid order short-circuits without re-processing stock or sending email', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    fbMock.__setOrder('order_1', { ...baseOrderDoc(), status: 'paid' });

    const res = await request(app).post('/verify-payment').send({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: sign('order_1', 'pay_1'),
    });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(fbMock.__getProduct('prod1').stock).toBe(10); // untouched
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  // WHY: The main happy path — confirms the order, decrements stock by the
  // exact ordered quantity, and sends the confirmation email.
  it('VP-05: happy path confirms the order, deducts stock, and emails the customer', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    fbMock.__setOrder('order_1', {
      ...baseOrderDoc(),
      customer: { firstName: 'Asha', lastName: 'K', email: 'asha@example.com', phone: '9999999999',
        address: { line1: 'A1', city: 'Bhopal', state: 'MP', pin: '462001' } },
    });

    const res = await request(app).post('/verify-payment').send({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: sign('order_1', 'pay_1'),
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: true, orderId: 'order_1', paymentId: 'pay_1' });
    expect(fbMock.__getProduct('prod1').stock).toBe(8); // 10 - qty(2)
    expect(fbMock.__getOrder('order_1').status).toBe('paid');

    // email is fired-and-forgotten; give the microtask queue a tick
    await new Promise((r) => setImmediate(r));
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  // WHY: Confirms coupon usage counters are incremented exactly once on
  // successful confirmation, which matters for maxUses enforcement.
  it('VP-06: applies coupon usage increment when the order has a couponDocId', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    fbMock.__setCoupon('coupon_doc_1', { code: 'SAVE10', usedCount: 3, maxUses: 100, active: true });
    fbMock.__setOrder('order_1', { ...baseOrderDoc(), couponDocId: 'coupon_doc_1' });

    const res = await request(app).post('/verify-payment').send({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: sign('order_1', 'pay_1'),
    });

    expect(res.status).toBe(200);
    expect(fbMock.__getCoupon('coupon_doc_1').usedCount).toBe(4); // 3 -> 4
  });

  // WHY: Simulates a race condition — stock changed between the initial
  // /create-order check and payment confirmation (e.g. another customer
  // bought the last units first). The transaction must reject rather than
  // oversell.
  it('VP-07: insufficient stock at confirmation time returns 500', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 1 }); // less than order's qty:2
    fbMock.__setOrder('order_1', baseOrderDoc());

    const res = await request(app).post('/verify-payment').send({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: sign('order_1', 'pay_1'),
    });

    expect(res.status).toBe(500);
    expect(res.body.verified).toBe(false);
    expect(res.body.error).toContain('Out of stock for Dog Bed');
  });

  // WHY: `customer` is optional in the request body (e.g. guest checkout
  // edge cases) — verifies the order confirms fine and simply doesn't
  // overwrite the existing customer field.
  it('VP-08: missing customer in the request body still confirms the order', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    fbMock.__setOrder('order_1', baseOrderDoc()); // customer already null

    const res = await request(app).post('/verify-payment').send({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: sign('order_1', 'pay_1'),
      // no `customer` field
    });

    expect(res.status).toBe(200);
    expect(fbMock.__getOrder('order_1').customer).toBeNull();
  });

  // WHY: Email delivery failures (SMTP down, bad address, etc.) must never
  // fail the payment-verification response — the payment already went
  // through, so the customer-facing result must still be success.
  // WHY: confirmOrder() has its own, separate stock check inside the
  // transaction (distinct from computeAmount's check at /create-order
  // time). This test targets the variant-specific branch of that check
  // (isVariant = true), which is a different code path than the
  // non-variant out-of-stock test (VP-07) and was never exercised.
  it('VP-10: variant-specific stock shortfall at confirmation time is rejected', async () => {
    fbMock.__setProduct('prod2', {
      name: 'Premium Bed', price: 600, active: true, stock: 999,
      variants: { Large: { price: 800, stock: 1 } }, // only 1 Large left
    });
    fbMock.__setOrder('order_1', {
      ...baseOrderDoc(),
      items: [{ id: 'prod2', name: 'Premium Bed', variant: 'Large', qty: 3, price: 800 }],
    });

    const res = await request(app).post('/verify-payment').send({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: sign('order_1', 'pay_1'),
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Out of stock for Premium Bed (Large)');
    expect(res.body.error).toContain('Available: 1, Requested: 3');
  });

  // WHY: Simulates a product being deleted from the catalog in the window
  // between checkout (/create-order) and payment confirmation
  // (/verify-payment) — confirmOrder must reject rather than silently
  // confirm an order for a product that no longer exists.
  it('VP-11: a product removed from the catalog before confirmation is rejected', async () => {
    // Deliberately NOT calling fbMock.__setProduct — product doc is missing.
    fbMock.__setOrder('order_1', baseOrderDoc());

    const res = await request(app).post('/verify-payment').send({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: sign('order_1', 'pay_1'),
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Product not found: prod1');
  });

  // WHY: Products with no `stock` field are treated as unlimited (stock
  // resolves to -1, which skips the quantity check entirely) — a large
  // order quantity must succeed rather than being rejected.
  it('VP-12: a product with no stock field (unlimited stock) confirms regardless of quantity', async () => {
    fbMock.__setProduct('prod1', { name: 'Digital Donation Certificate', price: 100, active: true });
    // no `stock` key at all
    fbMock.__setOrder('order_1', {
      ...baseOrderDoc(),
      items: [{ id: 'prod1', name: 'Digital Donation Certificate', variant: null, qty: 500, price: 100 }],
    });

    const res = await request(app).post('/verify-payment').send({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: sign('order_1', 'pay_1'),
    });

    expect(res.status).toBe(200);
    expect(fbMock.__getOrder('order_1').status).toBe('paid');
  });

  // WHY: If the coupon document referenced by an order was deleted between
  // checkout and confirmation, the transaction must still confirm the
  // order successfully — it just skips the usage-count increment rather
  // than throwing. Covers the `couponSnap.exists === false` branch.
  it('VP-13: a coupon document deleted before confirmation does not block the order', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    // Deliberately NOT calling fbMock.__setCoupon — couponDocId points nowhere.
    fbMock.__setOrder('order_1', { ...baseOrderDoc(), couponDocId: 'coupon_deleted' });

    const res = await request(app).post('/verify-payment').send({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: sign('order_1', 'pay_1'),
    });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
  });

  // WHY: sendOrderEmail's guard is `if (!customer || !customer.email) return;`
  // — VP-08 already covers the "customer is null" side of that OR, but
  // branch coverage requires exercising "customer exists but has no email"
  // too (e.g. a customer record saved without an email address).
  it('VP-14: a customer record with no email address skips sending the confirmation email', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    fbMock.__setOrder('order_1', {
      ...baseOrderDoc(),
      customer: { firstName: 'Asha', lastName: 'K', phone: '9999999999',
        address: { line1: 'A1', city: 'Bhopal', state: 'MP', pin: '462001' } }, // no `email` field
    });

    const res = await request(app).post('/verify-payment').send({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: sign('order_1', 'pay_1'),
    });

    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('VP-09: email send failure does not affect the verified response', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    fbMock.__setOrder('order_1', {
      ...baseOrderDoc(),
      customer: { firstName: 'Asha', lastName: 'K', email: 'asha@example.com', phone: '9999999999',
        address: { line1: 'A1', city: 'Bhopal', state: 'MP', pin: '462001' } },
    });
    mockSendMail.mockRejectedValue(new Error('SMTP connection refused'));

    const res = await request(app).post('/verify-payment').send({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: sign('order_1', 'pay_1'),
    });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
  });
});