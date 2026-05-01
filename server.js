const express  = require('express');
const session  = require('express-session');
const { Lipana } = require('@lipana/sdk');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
//  RAILWAY ENVIRONMENT VARIABLES — set these in Railway → Variables
//
//  LIPANA_SECRET_KEY   → Your Secret Key from Lipana dashboard (starts with sk_)
//  LIPANA_ENV          → "production"  or  "sandbox"  (default: production)
//  BASE_URL            → https://your-app.railway.app   (no trailing slash)
//  ADMIN_USER          → admin
//  ADMIN_PASS          → your secure admin password
//  SESSION_SECRET      → long random string
// ─────────────────────────────────────────────────────────────────────────────
const LIPANA_SECRET_KEY = process.env.LIPANA_SECRET_KEY || '';
const LIPANA_ENV        = process.env.LIPANA_ENV        || 'production';
const BASE_URL          = (process.env.BASE_URL         || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_USER        = process.env.ADMIN_USER        || 'admin';
const ADMIN_PASS        = process.env.ADMIN_PASS        || 'admin123';

// ─────────────────────────────────────────────────────────────────────────────
//  Initialise Lipana SDK
//  Uses the official @lipana/sdk package — no manual endpoint guessing needed.
//  Docs: https://lipana.dev/docs  |  npm: https://www.npmjs.com/package/@lipana/sdk
// ─────────────────────────────────────────────────────────────────────────────
let lipana = null;
if (LIPANA_SECRET_KEY) {
  lipana = new Lipana({
    apiKey:      LIPANA_SECRET_KEY,
    environment: LIPANA_ENV,   // 'production' | 'sandbox'
  });
  console.log(`✅  Lipana SDK initialised (${LIPANA_ENV})`);
} else {
  console.warn('⚠️   LIPANA_SECRET_KEY not set — running in DEMO MODE (no real STK push)');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Phone formatter → +2547XXXXXXXX  (Lipana SDK expects E.164 with + prefix)
// ─────────────────────────────────────────────────────────────────────────────
function formatPhone(raw) {
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('0'))   p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  // ensure no leading + yet — SDK handles it or we add it
  if (!p.startsWith('254')) p = '254' + p;
  return '+' + p;   // e.g. +254712345678
}

// ─────────────────────────────────────────────────────────────────────────────
//  In-memory transaction store
// ─────────────────────────────────────────────────────────────────────────────
let transactions = [
  { id:'TXN1A2B3C', phone:'+254712345678', nationalId:'234567890', limit:25000, fee:670,  status:'success', lipanaRef:null, mpesaCode:'SB12HGX9JE', ts:new Date(Date.now()-3600000).toISOString() },
  { id:'TXN4D5E6F', phone:'+254723456789', nationalId:'345678901', limit:10000, fee:240,  status:'success', lipanaRef:null, mpesaCode:'SC34HGX7KL', ts:new Date(Date.now()-7200000).toISOString() },
  { id:'TXN7G8H9I', phone:'+254734567890', nationalId:'456789012', limit:50000, fee:1400, status:'pending', lipanaRef:null, mpesaCode:null,         ts:new Date(Date.now()-1800000).toISOString() },
  { id:'TXNJK0LMN', phone:'+254745678901', nationalId:'567890123', limit:35000, fee:910,  status:'success', lipanaRef:null, mpesaCode:'SD56HGX5MN', ts:new Date(Date.now()-900000).toISOString()  },
  { id:'TXNOP1QRS', phone:'+254756789012', nationalId:'678901234', limit:16000, fee:450,  status:'failed',  lipanaRef:null, mpesaCode:null,         ts:new Date(Date.now()-5400000).toISOString() },
];

// ─────────────────────────────────────────────────────────────────────────────
//  Middleware
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret:            process.env.SESSION_SECRET || 'fulizaboost-change-in-prod',
  resave:            false,
  saveUninitialized: false,
  cookie:            { maxAge: 8 * 60 * 60 * 1000 }, // 8 hours
}));

// ─────────────────────────────────────────────────────────────────────────────
//  Admin guard
// ─────────────────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin/login');
}

// ─────────────────────────────────────────────────────────────────────────────
//  PAGE ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/admin', requireAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false, message: 'Invalid credentials' });
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  STK PUSH  →  POST /api/stk-push
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/stk-push', async (req, res) => {
  const { phone, nationalId, limitAmount, fee } = req.body;

  // ── Input validation ──
  if (!phone || !nationalId || !limitAmount || !fee) {
    return res.status(400).json({ success: false, message: 'All fields are required.' });
  }
  const cleanId = String(nationalId).replace(/\D/g, '');
  if (cleanId.length < 7 || cleanId.length > 9) {
    return res.status(400).json({ success: false, message: 'National ID must be 7–9 digits.' });
  }
  const formattedPhone = formatPhone(phone);
  // After formatting should be +254XXXXXXXXX (13 chars including +)
  if (formattedPhone.length !== 13) {
    return res.status(400).json({ success: false, message: 'Enter a valid Safaricom number, e.g. 0712345678.' });
  }

  // ── Create transaction record ──
  const txnId = 'TXN' + uuidv4().replace(/-/g, '').substring(0, 8).toUpperCase();
  const txn = {
    id:          txnId,
    phone:       formattedPhone,
    nationalId:  cleanId,
    limit:       parseInt(limitAmount),
    fee:         parseInt(fee),
    status:      'pending',
    lipanaRef:   null,
    mpesaCode:   null,
    ts:          new Date().toISOString(),
  };
  transactions.unshift(txn);

  // ── Demo mode (no key configured) ──
  if (!lipana) {
    console.warn(`[Demo] Would send STK push to ${formattedPhone} for Ksh ${fee}`);
    return res.json({
      success:       true,
      transactionId: txnId,
      demo:          true,
      message:       'Demo mode — set LIPANA_SECRET_KEY in Railway env to send real STK push.',
    });
  }

  // ── Real STK push via Lipana SDK ──
  try {
    console.log(`[STK Push] → ${formattedPhone} | amount=${fee} | ref=${txnId}`);

    // The Lipana SDK handles all endpoint construction, auth headers, and retries.
    // initiateStkPush sends the prompt to the customer's phone immediately.
    const response = await lipana.transactions.initiateStkPush({
      phone:  formattedPhone,   // E.164 format: +254712345678
      amount: parseInt(fee),    // integer KES amount
    });

    console.log('[Lipana SDK Response]', JSON.stringify(response));

    // SDK returns { transactionId, status, message, ... } on success
    if (response && response.transactionId) {
      txn.lipanaRef = response.transactionId;
      return res.json({
        success:       true,
        transactionId: txnId,
        lipanaRef:     response.transactionId,
        message:       'STK push sent. Check your phone and enter your M-Pesa PIN.',
      });
    } else {
      txn.status = 'failed';
      const msg = response?.message || 'STK push was not accepted by Lipana.';
      console.error('[Lipana] Unexpected response:', JSON.stringify(response));
      return res.status(400).json({ success: false, message: msg });
    }

  } catch (err) {
    txn.status = 'failed';
    // Lipana SDK throws proper Error objects with descriptive messages
    const errMsg = err?.message || 'Unknown error';
    const errData = err?.response?.data || err?.data || null;
    console.error('[Lipana STK Error]', errMsg, errData ? JSON.stringify(errData) : '');
    return res.status(500).json({
      success: false,
      message: `STK push failed: ${errMsg}`,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  LIPANA WEBHOOK CALLBACK  →  POST /api/lipana-callback
//
//  Set this exact URL in your Lipana dashboard → Webhooks:
//    https://your-app.railway.app/api/lipana-callback
//
//  Lipana posts payment result here after customer acts on the STK prompt.
//  SDK webhook payload shape:
//  {
//    "event":          "transaction.success" | "transaction.failed",
//    "transactionId":  "txn_XXXXXX",       ← Lipana's transaction ID (our lipanaRef)
//    "status":         "success" | "failed",
//    "amount":         670,
//    "phone":          "+254712345678",
//    "mpesaCode":      "SH98HGX9JE",       ← M-Pesa receipt number
//    "reference":      "TXN...",            ← AccountReference we sent (our txnId)
//    "message":        "Payment received."
//  }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/lipana-callback', (req, res) => {
  try {
    const body = req.body;
    console.log('[Lipana Callback] Received:', JSON.stringify(body));

    // Find transaction — try our txnId first (reference), then lipanaRef
    const txnId    = body.reference   || body.accountReference || null;
    const lipanaId = body.transactionId || null;

    let txn = txnId    ? transactions.find(t => t.id       === txnId)    : null;
    if (!txn) txn      = lipanaId ? transactions.find(t => t.lipanaRef === lipanaId) : null;

    if (!txn) {
      console.warn('[Lipana Callback] No transaction matched. ref:', txnId, '| lipanaId:', lipanaId);
      return res.status(200).json({ success: true }); // still 200 so Lipana doesn't retry
    }

    const isSuccess = body.status === 'success'
                   || body.event  === 'transaction.success'
                   || body.ResultCode === 0
                   || body.ResultCode === '0';

    if (isSuccess) {
      txn.status    = 'success';
      txn.mpesaCode = body.mpesaCode || body.MpesaReceiptNumber || body.receipt || null;
      txn.lipanaRef = lipanaId || txn.lipanaRef;
      console.log(`[Callback] ✅ TXN ${txn.id} SUCCESS | M-Pesa: ${txn.mpesaCode}`);
    } else {
      txn.status     = 'failed';
      txn.failReason = body.message || body.ResultDesc || 'Payment not completed';
      console.log(`[Callback] ❌ TXN ${txn.id} FAILED | Reason: ${txn.failReason}`);
    }

  } catch (e) {
    console.error('[Callback Error]', e.message, e.stack);
  }

  // Always 200 — Lipana retries on any non-200 response
  res.status(200).json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POLL  →  GET /api/transaction/:id
//  Frontend polls every 4 seconds to check if callback has arrived
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/transaction/:id', (req, res) => {
  const txn = transactions.find(t => t.id === req.params.id);
  if (!txn) return res.status(404).json({ success: false, message: 'Transaction not found' });
  res.json({
    success: true,
    transaction: {
      id:        txn.id,
      status:    txn.status,
      limit:     txn.limit,
      fee:       txn.fee,
      mpesaCode: txn.mpesaCode,
    },
  });
});

// Manual confirm — user taps "I've approved" button
app.post('/api/confirm-payment', (req, res) => {
  const { transactionId } = req.body;
  const txn = transactions.find(t => t.id === transactionId);
  if (!txn) return res.status(404).json({ success: false, message: 'Transaction not found' });
  if (txn.status === 'pending') txn.status = 'success';
  res.json({ success: true, transaction: txn });
});

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN API  (all routes session-protected)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const success = transactions.filter(t => t.status === 'success');
  res.json({
    total:   transactions.length,
    success: success.length,
    pending: transactions.filter(t => t.status === 'pending').length,
    failed:  transactions.filter(t => t.status === 'failed').length,
    revenue: success.reduce((a, t) => a + t.fee, 0),
  });
});

app.get('/api/admin/transactions', requireAdmin, (req, res) => {
  const { q, status, page = 1, limit = 100 } = req.query;
  let data = [...transactions];
  if (q)      data = data.filter(t => t.phone.includes(q) || t.nationalId.includes(q) || t.id.includes(q));
  if (status) data = data.filter(t => t.status === status);
  const start = (parseInt(page) - 1) * parseInt(limit);
  res.json({ success: true, data: data.slice(start, start + parseInt(limit)), total: data.length });
});

app.patch('/api/admin/transactions/:id', requireAdmin, (req, res) => {
  const txn = transactions.find(t => t.id === req.params.id);
  if (!txn) return res.status(404).json({ success: false });
  Object.assign(txn, req.body);
  res.json({ success: true, transaction: txn });
});

app.delete('/api/admin/transactions/:id', requireAdmin, (req, res) => {
  transactions = transactions.filter(t => t.id !== req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = {};
  transactions.forEach(t => {
    if (!users[t.phone]) users[t.phone] = { phone: t.phone, nationalId: t.nationalId, paid: 0, upgrades: 0, last: t.ts };
    if (t.status === 'success') { users[t.phone].paid += t.fee; users[t.phone].upgrades++; }
    if (t.ts > users[t.phone].last) users[t.phone].last = t.ts;
  });
  res.json({ success: true, data: Object.values(users) });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Security: block direct HTML file access
// ─────────────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/admin.html') return res.redirect('/admin');
  if (req.path === '/login.html') return res.redirect('/admin/login');
  next();
});

app.use((req, res) =>
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

// ─────────────────────────────────────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  FulizaBoost running  → http://localhost:${PORT}`);
  console.log(`📡  Lipana callback URL  → ${BASE_URL}/api/lipana-callback`);
  console.log(`🌍  Lipana environment   → ${LIPANA_ENV}`);
});
