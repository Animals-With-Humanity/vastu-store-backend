/**
 * VASTU × AWH — Diwali Gift module
 * ---------------------------------------------------------------------------
 * Self-contained. Wired into index.js with ONE line:
 *     require('./gift')(app, { db, admin, sendMail });
 * To remove the feature from the backend, delete that line (and this file).
 *
 * Endpoints
 *   GET  /gift/status    -> { enabled }
 *   POST /gift/validate  -> { valid } | { valid:false, reason:'invalid'|'used' }
 *   POST /gift/claim     -> redeems the code and stores delivery details
 *
 * Firestore
 *   gift_codes/{CODE}   { redeemed, active, label, createdAt, redeemedAt }
 *   gift_claims/{CODE}  { name, phone, email, address, status, claimedAt }
 *
 * Kill switches (either one turns the feature off, no code change needed):
 *   - env GIFT_ENABLED=false
 *   - Firestore config/settings  ->  giftEnabled: false
 */

const crypto = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────
const CODES = 'gift_codes';
const CLAIMS = 'gift_claims';
const MAX_FAILS = 8;                 // wrong attempts allowed per IP ...
const FAIL_WINDOW_MS = 15 * 60 * 1000; // ... per this window
const FLAG_CACHE_MS = 30 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** "abcd-ef12" / "ABCD EF12" -> "ABCDEF12". Anything non-alphanumeric is dropped. */
function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || 'unknown';
}

// In-memory failed-attempt limiter. Good enough for a single Render instance;
// the code space (~8.5e11) is the real protection against guessing.
const fails = new Map();
function isBlocked(ip) {
  const rec = fails.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > FAIL_WINDOW_MS) { fails.delete(ip); return false; }
  return rec.count >= MAX_FAILS;
}
function recordFail(ip) {
  const rec = fails.get(ip);
  if (!rec || Date.now() - rec.first > FAIL_WINDOW_MS) fails.set(ip, { count: 1, first: Date.now() });
  else rec.count++;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of fails) if (now - rec.first > FAIL_WINDOW_MS) fails.delete(ip);
}, 10 * 60 * 1000).unref();

// ── Input validation ──────────────────────────────────────────────────────────
function validateDetails(b) {
  const errors = {};
  const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

  const name = clean(b.name, 80);
  if (name.length < 2) errors.name = 'Please enter your full name';

  let phone = String(b.phone || '').replace(/[\s\-()]/g, '');
  phone = phone.replace(/^(\+?91|0)/, '');
  if (!/^[6-9]\d{9}$/.test(phone)) errors.phone = 'Enter a valid 10-digit mobile number';

  const email = clean(b.email, 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'Enter a valid email address';

  const line1 = clean(b.line1, 160);
  if (line1.length < 5) errors.line1 = 'Please enter your full address';
  const line2 = clean(b.line2, 160);

  const city = clean(b.city, 60);
  if (city.length < 2) errors.city = 'Enter your city';

  const state = clean(b.state, 60);
  if (state.length < 2) errors.state = 'Select your state';

  const pin = String(b.pin || '').replace(/\s/g, '');
  if (!/^[1-9]\d{5}$/.test(pin)) errors.pin = 'Enter a valid 6-digit PIN code';

  return {
    errors,
    value: { name, phone, email, address: { line1, line2, city, state, pin } }
  };
}

// ── Module ────────────────────────────────────────────────────────────────────
module.exports = function registerGift(app, { db, admin, sendMail }) {
  let flagCache = { at: 0, enabled: true };

  async function isEnabled() {
    if (String(process.env.GIFT_ENABLED).toLowerCase() === 'false') return false;
    if (Date.now() - flagCache.at < FLAG_CACHE_MS) return flagCache.enabled;
    let enabled = true;
    try {
      const snap = await db.collection('config').doc('settings').get();
      if (snap.exists && snap.data().giftEnabled === false) enabled = false;
    } catch (e) {
      console.error('[gift] flag read failed:', e.message);
    }
    flagCache = { at: Date.now(), enabled };
    return enabled;
  }

  // Disabled -> behave as if the routes don't exist for anything but /status.
  async function gate(req, res, next) {
    if (await isEnabled()) return next();
    return res.status(404).json({ error: 'Not available' });
  }

  app.get('/gift/status', async (req, res) => {
    res.json({ enabled: await isEnabled() });
  });

  app.post('/gift/validate', gate, async (req, res) => {
    const ip = clientIp(req);
    if (isBlocked(ip)) return res.status(429).json({ valid: false, reason: 'rate_limited' });

    try {
      const code = normalizeCode(req.body && req.body.code);
      if (code.length < 6) { recordFail(ip); return res.json({ valid: false, reason: 'invalid' }); }

      const snap = await db.collection(CODES).doc(code).get();
      if (!snap.exists || snap.data().active === false) {
        recordFail(ip);
        return res.json({ valid: false, reason: 'invalid' });
      }
      if (snap.data().redeemed) return res.json({ valid: false, reason: 'used' });
      res.json({ valid: true });
    } catch (err) {
      console.error('[gift/validate]', err.message);
      res.status(500).json({ valid: false, reason: 'server_error' });
    }
  });

  app.post('/gift/claim', gate, async (req, res) => {
    const ip = clientIp(req);
    if (isBlocked(ip)) return res.status(429).json({ ok: false, reason: 'rate_limited' });

    const body = req.body || {};
    // Honeypot: real users never fill this hidden field.
    if (body.website) return res.json({ ok: true });

    const code = normalizeCode(body.code);
    const { errors, value } = validateDetails(body);
    if (Object.keys(errors).length) return res.status(400).json({ ok: false, reason: 'validation', errors });

    try {
      const codeRef = db.collection(CODES).doc(code);
      const claimRef = db.collection(CLAIMS).doc(code);

      // Atomic: two people submitting the same code at once -> exactly one wins.
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(codeRef);
        if (!snap.exists || snap.data().active === false) {
          const e = new Error('invalid'); e.reason = 'invalid'; throw e;
        }
        if (snap.data().redeemed) {
          const e = new Error('used'); e.reason = 'used'; throw e;
        }
        const now = admin.firestore.FieldValue.serverTimestamp();
        tx.set(claimRef, {
          code,
          label: snap.data().label || null,
          name: value.name,
          phone: value.phone,
          email: value.email,
          address: value.address,
          status: 'pending_delivery',
          claimedAt: now
        });
        tx.update(codeRef, { redeemed: true, redeemedAt: now, redeemedBy: value.name });
      });

      res.json({ ok: true });

      // Best-effort confirmation email; never affects the claim result.
      sendGiftEmail(value).catch((e) => console.error('[gift] email failed:', e.message));
      console.log(`[gift] 🪔 code ${code} claimed by ${value.name}`);
    } catch (err) {
      if (err.reason === 'invalid' || err.reason === 'used') {
        if (err.reason === 'invalid') recordFail(ip);
        return res.status(err.reason === 'used' ? 409 : 400).json({ ok: false, reason: err.reason });
      }
      console.error('[gift/claim]', err.message);
      res.status(500).json({ ok: false, reason: 'server_error' });
    }
  });

  async function sendGiftEmail(v) {
    if (!sendMail) return;
    const a = v.address;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;border:1px solid #eee;border-radius:12px;">
        <div style="text-align:center;">
          <img src="https://vastu.awhbharat.org/vastu-circular.PNG" alt="Vastu" style="width:72px;height:72px;" />
          <h2 style="color:#70355c;margin:12px 0 4px;">Your Diwali gift is on its way 🪔</h2>
          <p style="color:#666;margin:0;">Happy Diwali, ${escapeHtml(v.name)}! Thank you for being part of the Vastu × Animals With Humanity family.</p>
        </div>
        <div style="background:#faf5fc;padding:16px;border-radius:8px;margin:20px 0;font-size:14px;color:#444;">
          <strong>We'll deliver to:</strong><br>
          ${escapeHtml(v.name)}<br>
          ${escapeHtml(a.line1)}${a.line2 ? '<br>' + escapeHtml(a.line2) : ''}<br>
          ${escapeHtml(a.city)}, ${escapeHtml(a.state)} - ${escapeHtml(a.pin)}<br>
          Phone: ${escapeHtml(v.phone)}
        </div>
        <p style="font-size:13px;color:#666;">Something wrong with these details? Reply to this email or write to
          <a href="mailto:team@awhbharat.org" style="color:#70355c;">team@awhbharat.org</a>.</p>
        <p style="text-align:center;font-size:12px;color:#999;border-top:1px solid #eee;padding-top:16px;">© Animals With Humanity · Bhopal, MP</p>
      </div>`;
    await sendMail({ to: v.email, bcc: process.env.EMAIL_BCC, subject: '🪔 Your Diwali gift from Vastu', html });
  }
};

module.exports.normalizeCode = normalizeCode;
module.exports.validateDetails = validateDetails;
