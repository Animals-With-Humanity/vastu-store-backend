/**
 * VASTU × AWH — Secure Payment Backend
 * Node.js + Express
 *
 * Endpoints:
 *   POST /create-order       — Create Razorpay order (amount is server-authoritative)
 *   POST /verify-payment     — Verify HMAC-SHA256 signature after payment
 *   POST /validate-coupon    — Server-side coupon validation (reads Firestore)
 *   POST /webhook            — Razorpay webhook (payment.captured / payment.failed)
 *   POST /payment-failed     — Log failures for manual review
 *   GET  /health             — Uptime check
 */

const express      = require('express');
const cors         = require('cors');
const crypto       = require('crypto');
const Razorpay     = require('razorpay');
const admin        = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); // ← Firebase service account

// ─── Firebase Admin ────────────────────────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ─── Razorpay ──────────────────────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET; // set in Razorpay dashboard
const FREE_SHIPPING_THRESHOLD = 499;
const SHIPPING_COST           = 99;

// ─── App ───────────────────────────────────────────────────────────────────────
const app = express();

// Raw body for webhook signature (must be before express.json())
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// // CORS — restrict to your domain in production
// const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5500,http://127.0.0.1:5500').split(',');
// app.use(cors({
//   origin: (origin, cb) => {
//     if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
//     cb(new Error('CORS blocked: ' + origin));
//   },
//   methods: ['GET', 'POST'],
//   allowedHeaders: ['Content-Type']
// }));

app.use(cors({
  origin: '*'
}));
// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute authoritative order amount from cart items stored in Firestore.
 * @param {Array} cartItems  — [{ id, qty, variant }]
 * @param {string|null} couponCode
 * @returns {{ subtotal, discount, shipping, total, coupon }}
 */
async function computeAmount(cartItems, couponCode) {
  if (!Array.isArray(cartItems) || cartItems.length === 0)
    throw new Error('Cart is empty');

  // Fetch product prices from Firestore (never trust client-sent prices)
  const productRefs = cartItems.map(item => db.collection('products').doc(item.id));
  const productDocs = await Promise.all(productRefs.map(r => r.get()));

  let subtotal = 0;
  const resolvedItems = [];

  for (let i = 0; i < cartItems.length; i++) {
    const doc = productDocs[i];
    if (!doc.exists) throw new Error(`Product not found: ${cartItems[i].id}`);
    const p = doc.data();

    if (p.active === false)  throw new Error(`Product inactive: ${p.name}`);
    if (p.stock === 0)       throw new Error(`Out of stock: ${p.name}`);

    const price = (p.salePrice && p.salePrice < p.price) ? p.salePrice : p.price;
    const qty   = Math.max(1, Math.floor(cartItems[i].qty));
    subtotal   += price * qty;

    resolvedItems.push({ id: cartItems[i].id, name: p.name, variant: cartItems[i].variant || null, qty, price });
  }

  // Coupon validation
  let discount = 0;
  let appliedCoupon = null;

  if (couponCode) {
    const couponSnap = await db.collection('coupons')
      .where('code', '==', couponCode.toUpperCase())
      .where('active', '==', true)
      .limit(1)
      .get();

    if (!couponSnap.empty) {
      const c = couponSnap.docs[0].data();
      const now = Date.now();

      // Expiry check
      const expired = c.expiresAt && c.expiresAt.toMillis && c.expiresAt.toMillis() < now;

      // Usage limit
      const overLimit = c.maxUses && c.usedCount >= c.maxUses;

      // Min order
      const belowMin = c.minOrder && subtotal < c.minOrder;

      if (!expired && !overLimit && !belowMin) {
        discount = c.type === 'percent'
          ? Math.round(subtotal * c.value / 100)
          : Math.min(c.value, subtotal);
        appliedCoupon = { code: c.code, type: c.type, value: c.value, docId: couponSnap.docs[0].id };
      }
    }
  }

  const afterDiscount = subtotal - discount;
  const shipping = afterDiscount >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_COST;
  const total    = Math.max(0, afterDiscount + shipping);

  return { subtotal, discount, shipping, total, appliedCoupon, resolvedItems };
}

// ─── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

/**
 * POST /create-order
 * Body: { cartItems: [{id, qty, variant}], couponCode?: string }
 */
app.post('/create-order', async (req, res) => {
  try {
    const { cartItems, couponCode } = req.body;
    const pricing = await computeAmount(cartItems, couponCode);

    if (pricing.total < 1)
      return res.status(400).json({ error: 'Order total must be at least ₹1' });

    const options = {
      amount:   pricing.total * 100, // Razorpay uses paise
      currency: 'INR',
      receipt:  `awh_${Date.now()}`,
      notes: {
        discount:      pricing.discount,
        shipping:      pricing.shipping,
        coupon:        pricing.appliedCoupon?.code || '',
        itemCount:     pricing.resolvedItems.length
      }
    };

    const order = await razorpay.orders.create(options);

    // Persist pending order to Firestore so webhook can hydrate it
    await db.collection('pending_orders').doc(order.id).set({
      razorpayOrderId: order.id,
      pricing,
      cartItems:       pricing.resolvedItems,
      coupon:          pricing.appliedCoupon,
      status:          'pending',
      createdAt:       admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      orderId:  order.id,
      amount:   order.amount,
      currency: order.currency,
      key:      process.env.RAZORPAY_KEY_ID,
      pricing   // so frontend can show accurate totals
    });

  } catch (err) {
    console.error('[create-order]', err.message);
    res.status(500).json({ error: err.message || 'Order creation failed' });
  }
});

/**
 * POST /validate-coupon
 * Body: { couponCode, cartItems }
 * Used for live coupon feedback before checkout
 */
app.post('/validate-coupon', async (req, res) => {
  try {
    const { couponCode, cartItems } = req.body;
    if (!couponCode) return res.status(400).json({ valid: false, error: 'No code provided' });

    const pricing = await computeAmount(cartItems || [], couponCode);
    if (pricing.appliedCoupon) {
      res.json({ valid: true, discount: pricing.discount, coupon: pricing.appliedCoupon, pricing });
    } else {
      res.json({ valid: false, error: 'Invalid, expired, or minimum order not met' });
    }
  } catch (err) {
    res.status(500).json({ valid: false, error: err.message });
  }
});

/**
 * POST /verify-payment
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, customer }
 * Call this from frontend after Razorpay success callback.
 */
app.post('/verify-payment', async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, customer } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return res.status(400).json({ verified: false, error: 'Missing payment fields' });

  // ── HMAC-SHA256 verification ───────────────────────────────
  const body    = razorpay_order_id + '|' + razorpay_payment_id;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
                         .update(body)
                         .digest('hex');

  if (expected !== razorpay_signature) {
    console.warn('[verify-payment] Signature mismatch!', { razorpay_order_id, razorpay_payment_id });
    await logFailure(razorpay_order_id, 'Signature mismatch');
    return res.status(400).json({ verified: false, error: 'Signature mismatch' });
  }

  try {
    // Fetch pending order to get server-computed pricing
    const pendingRef = db.collection('pending_orders').doc(razorpay_order_id);
    const pending    = await pendingRef.get();

    if (!pending.exists)
      return res.status(400).json({ verified: false, error: 'Order not found' });

    const pendingData = pending.data();

    // Increment coupon usage count if applicable
    if (pendingData.coupon?.docId) {
      await db.collection('coupons').doc(pendingData.coupon.docId)
        .update({ usedCount: admin.firestore.FieldValue.increment(1) });
    }

    // Save confirmed order
    const orderDoc = await db.collection('orders').add({
      razorpayOrderId:   razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      customer:          customer || null,
      items:             pendingData.cartItems,
      coupon:            pendingData.coupon?.code || null,
      discount:          pendingData.pricing.discount,
      shipping:          pendingData.pricing.shipping,
      subtotal:          pendingData.pricing.subtotal,
      total:             pendingData.pricing.total,
      status:            'paid',
      verifiedAt:        admin.firestore.FieldValue.serverTimestamp(),
      createdAt:         admin.firestore.FieldValue.serverTimestamp()
    });

    // Mark pending order done
    await pendingRef.update({ status: 'verified', orderId: orderDoc.id });

    console.log(`[verify-payment] ✅ Order confirmed: ${orderDoc.id} | Payment: ${razorpay_payment_id}`);
    res.json({ verified: true, orderId: orderDoc.id, paymentId: razorpay_payment_id });

  } catch (err) {
    console.error('[verify-payment] Firestore error:', err.message);
    res.status(500).json({ verified: false, error: 'Database error' });
  }
});

/**
 * POST /webhook
 * Razorpay sends events here. Used as a reliable fallback for payment.captured
 * and to handle payment.failed automatically.
 *
 * Set the Webhook URL in Razorpay Dashboard → Settings → Webhooks
 * Events to subscribe: payment.captured, payment.failed, order.paid
 */
app.post('/webhook', async (req, res) => {
  // ── Verify webhook signature ───────────────────────────────
  const webhookSignature = req.headers['x-razorpay-signature'];
  if (!webhookSignature || !WEBHOOK_SECRET) {
    console.warn('[webhook] Missing signature or secret');
    return res.status(400).json({ error: 'Invalid webhook' });
  }

  const expectedSig = crypto.createHmac('sha256', WEBHOOK_SECRET)
                            .update(req.body)
                            .digest('hex');

  if (expectedSig !== webhookSignature) {
    console.warn('[webhook] Signature mismatch');
    return res.status(400).json({ error: 'Signature mismatch' });
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch (e) {
    return res.status(400).json({ error: 'Bad JSON' });
  }

  const event   = payload.event;
  const entity  = payload.payload?.payment?.entity || payload.payload?.order?.entity || {};

  console.log(`[webhook] Event: ${event} | ID: ${entity.id}`);

  try {
    switch (event) {

      // ── payment.captured ────────────────────────────────────
      case 'payment.captured': {
        const orderId   = entity.order_id;
        const paymentId = entity.id;

        // Find order in Firestore by razorpayOrderId
        const snap = await db.collection('orders')
          .where('razorpayOrderId', '==', orderId).limit(1).get();

        if (snap.empty) {
          // Payment captured but no verified order — possible if user closed tab before /verify-payment
          // Fetch pending order and create the confirmed record
          const pendingSnap = await db.collection('pending_orders').doc(orderId).get();
          if (pendingSnap.exists) {
            const pd = pendingSnap.data();

            if (pd.coupon?.docId) {
              await db.collection('coupons').doc(pd.coupon.docId)
                .update({ usedCount: admin.firestore.FieldValue.increment(1) });
            }

            await db.collection('orders').add({
              razorpayOrderId:   orderId,
              razorpayPaymentId: paymentId,
              items:             pd.cartItems,
              coupon:            pd.coupon?.code || null,
              discount:          pd.pricing.discount,
              shipping:          pd.pricing.shipping,
              subtotal:          pd.pricing.subtotal,
              total:             pd.pricing.total,
              status:            'paid',
              source:            'webhook_fallback',
              capturedAt:        admin.firestore.FieldValue.serverTimestamp(),
              createdAt:         admin.firestore.FieldValue.serverTimestamp()
            });

            await db.collection('pending_orders').doc(orderId).update({ status: 'captured_via_webhook' });
            console.log(`[webhook] ✅ Fallback order created for ${orderId}`);
          }
        } else {
          // Already verified — just update capturedAt
          await snap.docs[0].ref.update({
            capturedAt: admin.firestore.FieldValue.serverTimestamp(),
            webhookConfirmed: true
          });
        }
        break;
      }

      // ── payment.failed ───────────────────────────────────────
      case 'payment.failed': {
        const orderId = entity.order_id || entity.id;
        await db.collection('failed_payments').add({
          razorpayOrderId:   orderId,
          razorpayPaymentId: entity.id,
          errorCode:         entity.error_code,
          errorDescription:  entity.error_description,
          errorSource:       entity.error_source,
          errorStep:         entity.error_step,
          errorReason:       entity.error_reason,
          amount:            entity.amount,
          source:            'webhook',
          failedAt:          admin.firestore.FieldValue.serverTimestamp()
        });

        // Update pending order status
        if (orderId) {
          await db.collection('pending_orders').doc(orderId)
            .update({ status: 'failed' }).catch(() => {});
        }

        console.log(`[webhook] ❌ Payment failed for order ${orderId}: ${entity.error_description}`);
        break;
      }

      // ── order.paid ───────────────────────────────────────────
      case 'order.paid': {
        const orderId = entity.id;
        await db.collection('pending_orders').doc(orderId)
          .update({ status: 'order_paid_webhook' }).catch(() => {});
        console.log(`[webhook] 📦 order.paid received for ${orderId}`);
        break;
      }

      default:
        console.log(`[webhook] Unhandled event: ${event}`);
    }

    res.json({ received: true });

  } catch (err) {
    console.error('[webhook] Handler error:', err.message);
    // Always return 200 to prevent Razorpay from retrying indefinitely
    res.status(200).json({ received: true, warning: 'Processing error logged' });
  }
});

/**
 * POST /payment-failed
 * Called from frontend on modal dismiss or payment.failed event
 */
app.post('/payment-failed', async (req, res) => {
  try {
    const { error, orderId } = req.body;
    await db.collection('failed_payments').add({
      razorpayOrderId:  orderId || null,
      errorDescription: error?.description || 'Unknown',
      errorCode:        error?.code || null,
      source:           'frontend',
      failedAt:         admin.firestore.FieldValue.serverTimestamp()
    });
    if (orderId) {
      await db.collection('pending_orders').doc(orderId)
        .update({ status: 'abandoned' }).catch(() => {});
    }
    res.json({ logged: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────
async function logFailure(orderId, reason) {
  try {
    await db.collection('failed_payments').add({
      razorpayOrderId:  orderId,
      errorDescription: reason,
      source:           'verify_endpoint',
      failedAt:         admin.firestore.FieldValue.serverTimestamp()
    });
  } catch(e) { /* silent */ }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🐾 VASTU Payment Server running on port ${PORT}\n`));