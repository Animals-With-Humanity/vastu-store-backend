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

describe('POST /validate-coupon', () => {

  // WHY: Basic required-field validation for live "apply coupon" UI feedback.
  it('VC-01: missing couponCode returns 400', async () => {
    const res = await request(app).post('/validate-coupon').send({});
    expect(res.status).toBe(400);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toBe('No code provided');
  });

  // WHY: This endpoint reuses computeAmount(), which throws "Cart is empty"
  // for a missing/empty cart. Because this route's catch block returns
  // 500 (not 400) for that error, a coupon-preview call made before any
  // items are added to the cart currently 500s instead of giving a clean
  // "add items to your cart first" message — documenting this quirk so the
  // team can decide if it's intentional.
  it('VC-02: no cartItems provided results in a 500 due to shared "Cart is empty" logic', async () => {
    const res = await request(app).post('/validate-coupon').send({ couponCode: 'SAVE10' });
    expect(res.status).toBe(500);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toBe('Cart is empty');
  });

  // WHY: The primary "does this code work" happy path used for live
  // checkout feedback before the user clicks Pay.
  it('VC-03: a valid, applicable coupon returns valid:true with the discount', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    fbMock.__setCoupon('c1', { code: 'SAVE10', type: 'percent', value: 10, active: true, minOrder: 0 });

    const res = await request(app)
      .post('/validate-coupon')
      .send({ couponCode: 'SAVE10', cartItems: [{ id: 'prod1', qty: 1 }] });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.discount).toBe(50);
  });

  // WHY: Covers the "not found / expired / below minimum" branch together,
  // since computeAmount folds all three into the same non-error outcome
  // (appliedCoupon stays null) — the endpoint must respond 200 with
  // valid:false, not treat this as a server error.
  it('VC-04: an unknown coupon code returns 200 with valid:false', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });

    const res = await request(app)
      .post('/validate-coupon')
      .send({ couponCode: 'DOESNOTEXIST', cartItems: [{ id: 'prod1', qty: 1 }] });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toBe('Invalid, expired, or minimum order not met');
  });

  // WHY: Unlike the config-settings read, the coupon query in computeAmount
  // is NOT wrapped in its own try/catch, so a Firestore outage here
  // propagates all the way up and must surface as a clean 500, not crash
  // the process or hang the request.
  it('VC-05: a Firestore coupon-query failure returns 500', async () => {
    fbMock.__setProduct('prod1', { name: 'Dog Bed', price: 500, active: true, stock: 10 });
    fbMock.__injectFailure('coupons', 'query');

    const res = await request(app)
      .post('/validate-coupon')
      .send({ couponCode: 'SAVE10', cartItems: [{ id: 'prod1', qty: 1 }] });

    expect(res.status).toBe(500);
    expect(res.body.valid).toBe(false);
    expect(res.body.error).toBe('Simulated Firestore failure');
  });
});