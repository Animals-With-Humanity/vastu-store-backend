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

<<<<<<< HEAD
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
// const serviceAccount = require('./serviceAccountKey.json');
=======
const express      = require('express');
const cors         = require('cors');
const crypto       = require('crypto');
const Razorpay     = require('razorpay');
const admin        = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
>>>>>>> 95a1c20d6eac70884eb0152f41ac03c475e26b52

// ─── Firebase Admin ────────────────────────────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ─── Razorpay ──────────────────────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET; // set in Razorpay dashboard
// Shipping thresholds and platform fee config are fetched dynamically from Firestore config/settings

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

const nodemailer = require('nodemailer');

// Setup NodeMailer Transporter
const mailTransporter = (process.env.EMAIL_USER && process.env.EMAIL_PASS) ? nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.EMAIL_PORT || '587'),
  secure: process.env.EMAIL_PORT === '465',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
}) : null;

/**
 * Send customized premium order confirmation email with animal welfare support thank-you note
 */
async function sendOrderEmail(orderData) {
  if (!mailTransporter) {
    console.log('[Email] Mail transporter not configured. Skipping email.');
    return;
  }

  const customer = orderData.customer;
  if (!customer || !customer.email) return;

  const itemsList = (orderData.items || []).map(item => `
    <tr>
      <td style="padding: 10px; border-bottom: 1px solid #eee;">
        <strong>${item.name}</strong>${item.variant ? ` (${item.variant})` : ''}
      </td>
      <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: center;">
        ${item.qty}
      </td>
      <td style="padding: 10px; border-bottom: 1px solid #eee; text-align: right;">
        ₹${item.price}
      </td>
    </tr>
  `).join('');

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
      <div style="text-align: center; margin-bottom: 20px;">
        <img src="https://awhbharat.org/assets/images/logo.png" alt="AWH Logo" style="width: 80px; height: 80px;" />
        <h2 style="color: #70355c; margin-top: 10px;">Thank you for your support! 🐾</h2>
        <p style="color: #666;">Every purchase helps save lives and fund animal rescue in Bhopal.</p>
      </div>
      
      <div style="background-color: #faf5fc; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
        <h3 style="color: #70355c; margin-top: 0;">Order Summary</h3>
        <p><strong>Order ID:</strong> ${orderData.razorpayOrderId}</p>
        ${orderData.razorpayPaymentId ? `<p><strong>Payment ID:</strong> ${orderData.razorpayPaymentId}</p>` : ''}
        <p><strong>Date:</strong> ${new Date().toLocaleDateString('en-IN')}</p>
      </div>

      <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
        <thead>
          <tr style="background-color: #70355c; color: white;">
            <th style="padding: 10px; text-align: left;">Item</th>
            <th style="padding: 10px; text-align: center;">Qty</th>
            <th style="padding: 10px; text-align: right;">Price</th>
          </tr>
        </thead>
        <tbody>
          ${itemsList}
        </tbody>
      </table>

      <div style="margin-left: auto; width: 270px; margin-bottom: 20px;">
        <div style="display: flex; justify-content: space-between; padding: 5px 0;">
          <span>Subtotal:</span>
          <span>₹${orderData.subtotal}</span>
        </div>
        ${orderData.discount > 0 ? `
        <div style="display: flex; justify-content: space-between; padding: 5px 0; color: #10b981;">
          <span>Discount:</span>
          <span>-₹${orderData.discount}</span>
        </div>` : ''}
        <div style="display: flex; justify-content: space-between; padding: 5px 0;">
          <span>Shipping:</span>
          <span>${orderData.shipping === 0 ? 'Free' : `₹${orderData.shipping}`}</span>
        </div>
        <div style="display: flex; justify-content: space-between; padding: 5px 0;">
          <span>Platform Fee:</span>
          <span>₹${orderData.platformFee || 0}</span>
        </div>
        <div style="display: flex; justify-content: space-between; padding: 5px 0;">
          <span>GST on Platform Fee:</span>
          <span>₹${orderData.platformFeeGst || 0}</span>
        </div>
        <div style="display: flex; justify-content: space-between; padding: 10px 0; font-weight: bold; border-top: 1px solid #ddd; color: #70355c; font-size: 16px;">
          <span>Total:</span>
          <span>₹${orderData.total}</span>
        </div>
      </div>

      <div style="background-color: #eee; padding: 15px; border-radius: 8px; font-size: 12px; color: #666;">
        <h4 style="margin-top: 0; margin-bottom: 5px;">Shipping Address:</h4>
        <p style="margin: 0;">${customer.firstName} ${customer.lastName}</p>
        <p style="margin: 0;">${customer.address.line1}</p>
        ${customer.address.line2 ? `<p style="margin: 0;">${customer.address.line2}</p>` : ''}
        <p style="margin: 0;">${customer.address.city}, ${customer.address.state} - ${customer.address.pin}</p>
        <p style="margin: 0;">Phone: ${customer.phone}</p>
      </div>

      <div style="text-align: center; margin-top: 30px; font-size: 12px; color: #999; border-top: 1px solid #eee; padding-top: 20px;">
        <p>© 2026 Animals With Humanity. Bhopal, MP.</p>
        <p>If you have any questions, please contact us at <a href="mailto:team@awhbharat.org" style="color: #70355c;">team@awhbharat.org</a>.</p>
      </div>
    </div>
  `;

  try {
    await mailTransporter.sendMail({
      from: process.env.EMAIL_FROM || '"VASTU x AWH" <team@awhbharat.org>',
      to: customer.email,
      subject: `🐾 Order Confirmed! - VASTU x AWH`,
      html: emailHtml
    });
    console.log(`[Email] Order confirmation email sent to ${customer.email}`);
  } catch (err) {
    console.error('[Email] Failed to send email:', err);
  }
}

/**
 * Compute authoritative order amount from cart items stored in Firestore.
 * @param {Array} cartItems  — [{ id, qty, variant }]
 * @param {string|null} couponCode
 * @returns {{ subtotal, discount, shipping, platformFee, platformFeeGst, total, coupon, resolvedItems }}
 */
async function computeAmount(cartItems, couponCode) {
  if (!Array.isArray(cartItems) || cartItems.length === 0)
    throw new Error('Cart is empty');

  // Fetch settings from Firestore config/settings
  let freeShippingThreshold = 499;
  let shippingCost = 99;
  let platformFeePercent = 2;
  let platformFeeGst = 18;

  try {
    const configSnap = await db.collection('config').doc('settings').get();
    if (configSnap.exists) {
      const configData = configSnap.data();
      if (typeof configData.freeShippingThreshold === 'number') freeShippingThreshold = configData.freeShippingThreshold;
      if (typeof configData.shippingCost === 'number') shippingCost = configData.shippingCost;
      if (typeof configData.platformFeePercent === 'number') platformFeePercent = configData.platformFeePercent;
      if (typeof configData.platformFeeGst === 'number') platformFeeGst = configData.platformFeeGst;
    }
  } catch (err) {
    console.error('Error fetching configuration from Firestore settings:', err);
  }

  // Aggregate requested quantities by {productId, variant} key to verify stock limits safely
  const aggregatedQtys = {};
  for (const item of cartItems) {
    if (item && item.id) {
      const qty = Math.max(1, Math.floor(item.qty || 0));
      const key = item.variant ? `${item.id}_${item.variant}` : item.id;
      aggregatedQtys[key] = (aggregatedQtys[key] || 0) + qty;
    }
  }

  // Fetch product prices from Firestore (never trust client-sent prices)
  const productRefs = cartItems.map(item => db.collection('products').doc(item.id));
  const productDocs = await Promise.all(productRefs.map(r => r.get()));

  let subtotal = 0;
  const resolvedItems = [];
  const checkedProducts = new Set();

  for (let i = 0; i < cartItems.length; i++) {
    const doc = productDocs[i];
    if (!doc.exists) throw new Error(`Product not found: ${cartItems[i].id}`);
    const p = doc.data();

    if (p.active === false) throw new Error(`Product inactive: ${p.name}`);

    const selectedVariant = cartItems[i].variant || null;
    const stockKey = selectedVariant ? `${cartItems[i].id}_${selectedVariant}` : cartItems[i].id;

    // Check aggregated stock for the specific product/variant combination
    if (!checkedProducts.has(stockKey)) {
      let stock = typeof p.stock === 'number' ? p.stock : -1;
      if (selectedVariant && p.variants && p.variants[selectedVariant]) {
        const v = p.variants[selectedVariant];
        stock = typeof v.stock === 'number' ? v.stock : -1;
      }
      const totalQty = aggregatedQtys[stockKey];
      if (stock !== -1 && stock < totalQty) {
        throw new Error(`Out of stock for ${p.name}${selectedVariant ? ` (${selectedVariant})` : ''}. Total requested: ${totalQty}, Available: ${stock}`);
      }
      checkedProducts.add(stockKey);
    }

    const qty = Math.max(1, Math.floor(cartItems[i].qty));

    // Resolve pricing: check if variant has custom pricing
    let price = p.price;
    let salePrice = p.salePrice;
    if (selectedVariant && p.variants && p.variants[selectedVariant]) {
      const v = p.variants[selectedVariant];
      price = typeof v.price === 'number' ? v.price : price;
      salePrice = typeof v.salePrice === 'number' ? v.salePrice : salePrice;
    }

    const resolvedPrice = (salePrice && salePrice < price) ? salePrice : price;
    subtotal += resolvedPrice * qty;

    resolvedItems.push({ id: cartItems[i].id, name: p.name, variant: selectedVariant, qty, price: resolvedPrice });
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
  const shipping = afterDiscount >= freeShippingThreshold ? 0 : shippingCost;

  // Platform fee
  const platformFee = Number(((afterDiscount * platformFeePercent) / 100).toFixed(2));

  // GST on platform fee
  const platformFeeGstAmt = Number(((platformFee * platformFeeGst) / 100).toFixed(2));

  const total = Number((afterDiscount + shipping + platformFee + platformFeeGstAmt).toFixed(2));

  return { subtotal, discount, shipping, platformFee, platformFeeGst: platformFeeGstAmt, total, appliedCoupon, resolvedItems };
}

/**
 * Idempotent, Atomic transaction-based order confirmation and stock deduction helper
 */
async function confirmOrder(orderId, paymentId, customer, source) {
  return db.runTransaction(async (transaction) => {
    const orderRef = db.collection('orders').doc(orderId);
    const orderSnap = await transaction.get(orderRef);

    if (!orderSnap.exists) {
      throw new Error('Order not found');
    }

    const orderData = orderSnap.data();

    // If already paid, skip to prevent double execution (idempotency!)
    if (orderData.status === 'paid' || orderData.status === 'captured_via_webhook') {
      return { alreadyProcessed: true };
    }

    // 1. Aggregate requested quantities by {productId, variant} key to avoid transaction write-override collisions on duplicate variants
    const aggregatedQtys = {};
    for (const item of orderData.items) {
      const variantKey = item.variant ? `${item.id}_${item.variant}` : item.id;
      if (!aggregatedQtys[variantKey]) {
        aggregatedQtys[variantKey] = {
          id: item.id,
          variant: item.variant || null,
          qty: 0,
          name: item.name
        };
      }
      aggregatedQtys[variantKey].qty += item.qty;
    }

    const uniqueKeys = Object.keys(aggregatedQtys);
    const uniqueProductIds = [...new Set(uniqueKeys.map(k => aggregatedQtys[k].id))];
    const productRefs = uniqueProductIds.map(id => db.collection('products').doc(id));
    const productSnaps = [];
    for (const ref of productRefs) {
      productSnaps.push(await transaction.get(ref));
    }

    const productMap = {};
    for (let i = 0; i < uniqueProductIds.length; i++) {
      productMap[uniqueProductIds[i]] = productSnaps[i];
    }

    const productUpdates = {};

    for (const key of uniqueKeys) {
      const agg = aggregatedQtys[key];
      const prodSnap = productMap[agg.id];
      if (!prodSnap.exists) {
        throw new Error(`Product not found: ${agg.id}`);
      }
      const prodData = prodSnap.data();

      let stock = typeof prodData.stock === 'number' ? prodData.stock : -1;
      let isVariant = false;

      if (agg.variant && prodData.variants && prodData.variants[agg.variant]) {
        const v = prodData.variants[agg.variant];
        stock = typeof v.stock === 'number' ? v.stock : -1;
        isVariant = true;
      }

      if (stock !== -1) {
        if (stock < agg.qty) {
          throw new Error(`Out of stock for ${agg.name}${agg.variant ? ` (${agg.variant})` : ''}. Available: ${stock}, Requested: ${agg.qty}`);
        }

        if (!productUpdates[agg.id]) {
          productUpdates[agg.id] = {};
        }

        if (isVariant) {
          productUpdates[agg.id][`variants.${agg.variant}.stock`] = stock - agg.qty;
        } else {
          productUpdates[agg.id].stock = stock - agg.qty;
        }
      }
    }

    for (const prodId of Object.keys(productUpdates)) {
      transaction.update(db.collection('products').doc(prodId), productUpdates[prodId]);
    }

    // 2. Increment coupon usage count if applicable
    if (orderData.couponDocId) {
      const couponRef = db.collection('coupons').doc(orderData.couponDocId);
      const couponSnap = await transaction.get(couponRef);
      if (couponSnap.exists) {
        transaction.update(couponRef, {
          usedCount: admin.firestore.FieldValue.increment(1)
        });
      }
    }

    // 3. Update the order document to 'paid' status
    const updateData = {
      razorpayPaymentId: paymentId,
      status: 'paid',
      source: source || 'direct',
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (customer) {
      updateData.customer = customer;
    }

    transaction.update(orderRef, updateData);

    return { alreadyProcessed: false };
  });
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
      amount: Math.round(pricing.total * 100), // Razorpay uses paise
      currency: 'INR',
      receipt: `awh_${Date.now()}`,
      notes: {
        discount: pricing.discount,
        shipping: pricing.shipping,
        coupon: pricing.appliedCoupon?.code || '',
        itemCount: pricing.resolvedItems.length
      }
    };

    const order = await razorpay.orders.create(options);

    // Save initial pending order document in the central 'orders' collection
    await db.collection('orders').doc(order.id).set({
      razorpayOrderId: order.id,
      items: pricing.resolvedItems,
      coupon: pricing.appliedCoupon?.code || null,
      couponDocId: pricing.appliedCoupon?.docId || null,
      subtotal: pricing.subtotal,
      discount: pricing.discount,
      shipping: pricing.shipping,
      platformFee: pricing.platformFee,
      platformFeeGst: pricing.platformFeeGst,
      total: pricing.total,
      status: 'pending',
      customer: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID,
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
  const body = razorpay_order_id + '|' + razorpay_payment_id;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  if (expected !== razorpay_signature) {
    console.warn('[verify-payment] Signature mismatch!', { razorpay_order_id, razorpay_payment_id });
    await logFailure(razorpay_order_id, 'Signature mismatch');
    return res.status(400).json({ verified: false, error: 'Signature mismatch' });
  }

  try {
    // Atomically confirm order, decrement stock, and apply coupon counts
    const { alreadyProcessed } = await confirmOrder(razorpay_order_id, razorpay_payment_id, customer, 'verify_endpoint');

    console.log(`[verify-payment] ✅ Order confirmed: ${razorpay_order_id} | Payment: ${razorpay_payment_id}`);

    // Fetch and send email confirmation (outside transaction, only if not already processed by webhook)
    if (!alreadyProcessed) {
      const finalSnap = await db.collection('orders').doc(razorpay_order_id).get();
      if (finalSnap.exists) {
        const orderData = finalSnap.data();
        sendOrderEmail(orderData).catch(err => console.error('[verify-payment] Email failed:', err));
      }
    }

    res.json({ verified: true, orderId: razorpay_order_id, paymentId: razorpay_payment_id });

  } catch (err) {
    console.error('[verify-payment] Firestore error:', err.message);
    res.status(500).json({ verified: false, error: err.message || 'Database error' });
  }
});

/**
 * POST /webhook
 * Razorpay webhook event receiver
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

  const event = payload.event;
  const entity = payload.payload?.payment?.entity || payload.payload?.order?.entity || {};

  console.log(`[webhook] Event: ${event} | ID: ${entity.id}`);

  try {
    switch (event) {

      case 'payment.captured': {
        const orderId = entity.order_id;
        const paymentId = entity.id;

        // Atomically confirm order via webhook fallback
        const { alreadyProcessed } = await confirmOrder(orderId, paymentId, null, 'webhook_fallback');

        // Fetch and send email confirmation if this captured event confirmed it (and was not already processed)
        if (!alreadyProcessed) {
          const finalSnap = await db.collection('orders').doc(orderId).get();
          if (finalSnap.exists) {
            const orderData = finalSnap.data();
            sendOrderEmail(orderData).catch(err => console.error('[webhook] Email failed:', err));
          }
        }

        break;
      }

      case 'payment.failed': {
        const orderId = entity.order_id || entity.id;
        await db.collection('failed_payments').add({
          razorpayOrderId: orderId,
          razorpayPaymentId: entity.id,
          errorCode: entity.error_code,
          errorDescription: entity.error_description,
          amount: entity.amount,
          source: 'webhook',
          failedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        if (orderId) {
          await db.collection('orders').doc(orderId)
            .update({ status: 'failed', updatedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => { });
        }

        console.log(`[webhook] ❌ Payment failed for order ${orderId}: ${entity.error_description}`);
        break;
      }

      case 'order.paid': {
        const orderId = entity.id;
        await db.collection('orders').doc(orderId)
          .update({ status: 'order_paid_webhook', updatedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => { });
        console.log(`[webhook] 📦 order.paid received for ${orderId}`);
        break;
      }

      default:
        console.log(`[webhook] Unhandled event: ${event}`);
    }

    res.json({ received: true });

  } catch (err) {
    console.error('[webhook] Handler error:', err.message);
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
      razorpayOrderId: orderId || null,
      errorDescription: error?.description || 'Unknown',
      errorCode: error?.code || null,
      source: 'frontend',
      failedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    if (orderId) {
      await db.collection('orders').doc(orderId)
        .update({ status: 'abandoned', updatedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(() => { });
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
      razorpayOrderId: orderId,
      errorDescription: reason,
      source: 'verify_endpoint',
      failedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { /* silent */ }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🐾 VASTU Payment Server running on port ${PORT}\n`));
