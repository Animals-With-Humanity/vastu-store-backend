const request = require('supertest');

jest.mock('firebase-admin', () => require('./setup/firebaseAdminMock'));
jest.mock('razorpay', () => require('./setup/razorpayMock').RazorpayMock);
jest.mock('nodemailer', () => require('./setup/nodemailerMock'));

const fbMock = require('./setup/firebaseAdminMock');
const { mockOrdersCreate } = require('./setup/razorpayMock');

let app;

beforeAll(() => {
  app = require('../index');
});

beforeEach(() => {
  fbMock.__reset();
  mockOrdersCreate.mockReset();
});

describe('POST /create-order', () => {

  // WHY: Baseline happy path. Locks in the exact pricing math (subtotal,
  // free-shipping threshold, platform fee, GST) so any future change to
  // computeAmount() that alters the numbers is caught immediately.
  it('CO-01: creates an order with correct server-computed pricing', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    mockOrdersCreate.mockResolvedValue({ id: 'order_abc123', amount: 51180, currency: 'INR' });

    const res = await request(app)
      .post('/create-order')
      .send({ cartItems: [{ id: 'prod1', qty: 1 }] });

    expect(res.status).toBe(200);
    expect(res.body.orderId).toBe('order_abc123');
    expect(res.body.pricing.subtotal).toBe(500);
    expect(res.body.pricing.shipping).toBe(0); // 500 >= default free-shipping threshold of 499
    expect(res.body.pricing.platformFee).toBe(10);
    expect(res.body.pricing.platformFeeGst).toBe(1.8);
    expect(res.body.pricing.total).toBe(511.8);

    // Razorpay must receive the amount in paise, rounded
    expect(mockOrdersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 51180, currency: 'INR' })
    );

    // Order persisted as 'pending' before responding to the client
    const savedOrder = fbMock.__getOrder('order_abc123');
    expect(savedOrder.status).toBe('pending');
    expect(savedOrder.total).toBe(511.8);
  });

  // WHY: `cartItems` missing entirely is a very likely client bug (e.g. a
  // frontend JS error clearing the cart object). The API currently returns
  // 500 here rather than 400 — this test documents that actual behavior.
  it('CO-02: missing cartItems returns 500 "Cart is empty"', async () => {
    const res = await request(app).post('/create-order').send({});
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Cart is empty');
  });

  // WHY: Same as CO-02 but for an explicit empty array, which the frontend
  // could plausibly send if all items were removed before checkout.
  it('CO-03: empty cartItems array returns 500 "Cart is empty"', async () => {
    const res = await request(app).post('/create-order').send({ cartItems: [] });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Cart is empty');
  });

  // WHY: Guards against a stale/tampered product id in the client cart
  // (e.g. product deleted from the catalog after being added to cart).
  it('CO-04: non-existent product id returns 500 with product id in message', async () => {
    const res = await request(app)
      .post('/create-order')
      .send({ cartItems: [{ id: 'ghost-product', qty: 1 }] });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Product not found: ghost-product');
  });

  // WHY: A product that's been deactivated (e.g. discontinued) must not be
  // purchasable even if it's still cached in a user's browser cart.
  it('CO-05: inactive product returns 500 with product name in message', async () => {
    fbMock.__setProduct('prod1', { name: 'Discontinued Leash', price: 200, active: false, stock: 5 });

    const res = await request(app)
      .post('/create-order')
      .send({ cartItems: [{ id: 'prod1', qty: 1 }] });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Product inactive: Discontinued Leash');
  });

  // WHY: Prevents overselling — the core anti-fraud/anti-overselling check
  // for this endpoint.
  it('CO-06: insufficient stock returns 500 with requested/available counts', async () => {
    fbMock.__setProduct('prod1', { name: 'Cat Food', price: 100, active: true, stock: 5 });

    const res = await request(app)
      .post('/create-order')
      .send({ cartItems: [{ id: 'prod1', qty: 10 }] });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Out of stock for Cat Food');
    expect(res.body.error).toContain('Total requested: 10, Available: 5');
  });

  // WHY: computeAmount aggregates duplicate cart lines for the same
  // product/variant BEFORE checking stock. Two lines that are each
  // individually "in stock" must still be rejected if their sum exceeds
  // available stock — this is exactly the kind of bug that slips through
  // if you only test single-line carts.
  it('CO-07: duplicate cart lines for the same product are aggregated for the stock check', async () => {
    fbMock.__setProduct('prod1', { name: 'Chew Toy', price: 50, active: true, stock: 10 });

    const res = await request(app)
      .post('/create-order')
      .send({
        cartItems: [
          { id: 'prod1', qty: 6 },
          { id: 'prod1', qty: 6 },
        ],
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Total requested: 12, Available: 10');
  });

  // WHY: `Math.max(1, Math.floor(item.qty || 0))` silently clamps
  // zero/negative quantities to 1 instead of rejecting them. This is a
  // deliberate(?) behavior in the code — a test makes it explicit so it
  // can't regress unnoticed into either "crashes" or "allows qty 0 for free".
  it('CO-08: zero or negative quantity is silently clamped to 1', async () => {
    fbMock.__setProduct('prod1', { name: 'Collar', price: 300, active: true, stock: 10 });
    mockOrdersCreate.mockResolvedValue({ id: 'order_qty', amount: 1, currency: 'INR' });

    const res = await request(app)
      .post('/create-order')
      .send({ cartItems: [{ id: 'prod1', qty: -5 }] });

    expect(res.status).toBe(200);
    expect(res.body.pricing.subtotal).toBe(300); // treated as qty 1, not qty -5 or an error
    expect(res.body.pricing.resolvedItems[0].qty).toBe(1);
  });

  // WHY: Variant-specific price and salePrice must override the base
  // product price, and the resolved price must be the lower of price vs
  // salePrice — this is the exact discount-display logic on the storefront.
  it('CO-09: variant price/salePrice overrides are applied correctly', async () => {
    fbMock.__setProduct('prod2', {
      name: 'Premium Bed',
      price: 600,
      active: true,
      stock: 20,
      variants: { Large: { price: 800, salePrice: 700, stock: 5 } },
    });
    mockOrdersCreate.mockResolvedValue({ id: 'order_variant', amount: 1, currency: 'INR' });

    const res = await request(app)
      .post('/create-order')
      .send({ cartItems: [{ id: 'prod2', qty: 2, variant: 'Large' }] });

    expect(res.status).toBe(200);
    // 700 (sale price, lower than 800) * 2 = 1400, not the base price of 600
    expect(res.body.pricing.subtotal).toBe(1400);
    expect(res.body.pricing.resolvedItems[0].price).toBe(700);
  });

  // WHY: Confirms percent coupons apply correctly and that lookups are
  // case-insensitive (frontend may not normalize user input).
  it('CO-10: valid percent coupon (entered lowercase) reduces the total', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    fbMock.__setCoupon('coupon1', {
      code: 'SAVE10', type: 'percent', value: 10, active: true,
      minOrder: 100, maxUses: 100, usedCount: 0,
    });
    mockOrdersCreate.mockResolvedValue({ id: 'order_coupon', amount: 1, currency: 'INR' });

    const res = await request(app)
      .post('/create-order')
      .send({ cartItems: [{ id: 'prod1', qty: 1 }], couponCode: 'save10' });

    expect(res.status).toBe(200);
    expect(res.body.pricing.discount).toBe(50); // 10% of 500
    expect(res.body.pricing.appliedCoupon.code).toBe('SAVE10');
  });

  // WHY: An expired coupon must be silently ignored (no discount) rather
  // than blocking checkout — the code treats "coupon problem" as
  // non-fatal, and the order must still succeed.
  it('CO-11: expired coupon is ignored, order still succeeds without discount', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    fbMock.__setCoupon('coupon1', {
      code: 'OLDCODE', type: 'percent', value: 50, active: true,
      expiresAt: { toMillis: () => Date.now() - 1000 * 60 * 60 * 24 }, // expired yesterday
    });
    mockOrdersCreate.mockResolvedValue({ id: 'order_expired', amount: 1, currency: 'INR' });

    const res = await request(app)
      .post('/create-order')
      .send({ cartItems: [{ id: 'prod1', qty: 1 }], couponCode: 'OLDCODE' });

    expect(res.status).toBe(200);
    expect(res.body.pricing.discount).toBe(0);
    expect(res.body.pricing.appliedCoupon).toBeNull();
  });

  // WHY: A coupon that requires a higher minimum order than the current
  // cart must not apply — verifies the minOrder gate independently of
  // expiry/usage-limit gates.
  it('CO-12: coupon below its minOrder threshold is ignored', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    fbMock.__setCoupon('coupon1', { code: 'BIGORDER', type: 'fixed', value: 100, active: true, minOrder: 1000 });
    mockOrdersCreate.mockResolvedValue({ id: 'order_min', amount: 1, currency: 'INR' });

    const res = await request(app)
      .post('/create-order')
      .send({ cartItems: [{ id: 'prod1', qty: 1 }], couponCode: 'BIGORDER' });

    expect(res.status).toBe(200);
    expect(res.body.pricing.discount).toBe(0);
  });

  // WHY: Shipping is computed on `afterDiscount`, NOT on the pre-discount
  // subtotal. A coupon can push the order back under the free-shipping
  // threshold even though the raw cart total qualified for free shipping —
  // this is easy to get backwards in a refactor, so it's worth locking in.
  it('CO-13: applying a coupon can push the order below the free-shipping threshold', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    fbMock.__setCoupon('coupon1', { code: 'SAVE10', type: 'percent', value: 10, active: true });
    mockOrdersCreate.mockResolvedValue({ id: 'order_shiptest', amount: 1, currency: 'INR' });

    const res = await request(app)
      .post('/create-order')
      .send({ cartItems: [{ id: 'prod1', qty: 1 }], couponCode: 'SAVE10' });

    expect(res.status).toBe(200);
    // subtotal 500 -> discount 50 -> afterDiscount 450, which is BELOW the
    // default 499 free-shipping threshold, so shipping (99) is charged.
    expect(res.body.pricing.discount).toBe(50);
    expect(res.body.pricing.shipping).toBe(99);
    expect(res.body.pricing.total).toBe(559.62);
  });

  // WHY: Firestore config reads are wrapped in try/catch specifically so a
  // config-service outage doesn't take down checkout. This proves the
  // fallback defaults actually kick in rather than the request 500-ing.
  it('CO-14: falls back to hardcoded defaults if the Firestore config read fails', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    fbMock.__injectFailure('config', 'get');
    mockOrdersCreate.mockResolvedValue({ id: 'order_cfgfail', amount: 1, currency: 'INR' });

    const res = await request(app)
      .post('/create-order')
      .send({ cartItems: [{ id: 'prod1', qty: 1 }] });

    expect(res.status).toBe(200);
    expect(res.body.pricing.shipping).toBe(0); // still used default 499 threshold
  });

  // WHY: This is the ONE validation error in the whole endpoint that
  // returns 400 instead of 500 — worth pinning down precisely, including
  // the exact scenario that triggers it (heavy discount + zero fees).
  it('CO-15: order total under ₹1 returns 400, not 500', async () => {
    fbMock.__setProduct('prodfree', { name: 'Sample Sticker', price: 0.5, active: true, stock: 10 });
    fbMock.__setConfig({ freeShippingThreshold: 0, shippingCost: 0, platformFeePercent: 0, platformFeeGst: 0 });
    fbMock.__setCoupon('c1', { code: 'FULL', type: 'fixed', value: 0.5, active: true });

    const res = await request(app)
      .post('/create-order')
      .send({ cartItems: [{ id: 'prodfree', qty: 1 }], couponCode: 'FULL' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Order total must be at least ₹1');
    // Confirms no Razorpay order was created for a sub-₹1 total
    expect(mockOrdersCreate).not.toHaveBeenCalled();
  });

  // WHY: Razorpay outages/API errors must surface as a clean 500 with the
  // provider's message rather than an unhandled rejection/timeout.
  it('CO-16: Razorpay order creation failure returns 500 with its error message', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    mockOrdersCreate.mockRejectedValue(new Error('Razorpay: gateway timeout'));

    const res = await request(app)
      .post('/create-order')
      .send({ cartItems: [{ id: 'prod1', qty: 1 }] });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Razorpay: gateway timeout');
  });

  // WHY: If the Razorpay order succeeds but persisting our own order
  // record fails, the client must still be told it failed (500) — an
  // order that exists in Razorpay but not in our Firestore would be an
  // orphaned/unreconcilable payment.
  it('CO-17: Firestore order-save failure returns 500 after a successful Razorpay order', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    mockOrdersCreate.mockResolvedValue({ id: 'order_dbfail', amount: 51180, currency: 'INR' });
    fbMock.__injectFailure('orders', 'set', new Error('Firestore write failed'));

    const res = await request(app)
      .post('/create-order')
      .send({ cartItems: [{ id: 'prod1', qty: 1 }] });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Firestore write failed');
  });

  // WHY (security finding): CORS is currently configured with origin: '*',
  // meaning ANY website can call this payment API from a browser. This
  // test documents the current (insecure) behavior so it's visible in the
  // test report; see the recommendations section for the fix.
  it('CO-18 [security finding]: CORS currently allows any origin', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    mockOrdersCreate.mockResolvedValue({ id: 'order_cors', amount: 1, currency: 'INR' });

    const res = await request(app)
      .post('/create-order')
      .set('Origin', 'https://totally-unrelated-site.example')
      .send({ cartItems: [{ id: 'prod1', qty: 1 }] });

    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});