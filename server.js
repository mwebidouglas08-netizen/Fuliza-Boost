const express = require('express');
const session = require('express-session');
const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────
//  ENV — set ALL of these in your Railway Variables tab
//
//  LIPANA_API_KEY      → Your API Key from Lipana dashboard
//  LIPANA_API_SECRET   → Your API Secret from Lipana dashboard
//  LIPANA_SHORTCODE    → Your Paybill/Till from Lipana dashboard
//  LIPANA_WEBHOOK_SECRET → Webhook secret (optional, for sig verification)
//  BASE_URL            → https://your-app.railway.app  (no trailing slash)
//  ADMIN_USER          → admin
//  ADMIN_PASS          → your secure password
//  SESSION_SECRET      → long random string
// ─────────────────────────────────────────────────────────────
const LIPANA_API_KEY       = process.env.LIPANA_API_KEY       || '';
const LIPANA_API_SECRET    = process.env.LIPANA_API_SECRET    || '';
const LIPANA_SHORTCODE     = process.env.LIPANA_SHORTCODE     || '';
const LIPANA_WEBHOOK_SECRET= process.env.LIPANA_WEBHOOK_SECRET|| '';
const BASE_URL             = process.env.BASE_URL             || `http://localhost:${PORT}`;
const ADMIN_USER           = process.env.ADMIN_USER           || 'admin';
const ADMIN_PASS           = process.env.ADMIN_PASS           || 'admin123';

// Lipana Technologies API base
// Adjust path below if Lipana gives you a different base URL in your dashboard
const LIPANA_BASE = 'https://api.lipana.co.ke';

// ─────────────────────────────────────────────────────────────
//  In-memory transaction store
//  Replace with a real DB (PostgreSQL/MongoDB) for production
// ─────────────────────────────────────────────────────────────
let transactions = [
  { id:'TXN1A2B3C', phone:'+254712345678', nationalId:'234567890', limit:25000, fee:670,  status:'success', ts: new Date(Date.now()-3600000).toISOString() },
  { id:'TXN4D5E6F', phone:'+254723456789', nationalId:'345678901', limit:10000, fee:240,  status:'success', ts: new Date(Date.now()-7200000).toISOString() },
  { id:'TXN7G8H9I', phone:'+254734567890', nationalId:'456789012', limit:50000, fee:1400, status:'pending', ts: new Date(Date.now()-1800000).toISOString() },
  { id:'TXNJK0LMN', phone:'+254745678901', nationalId:'567890123', limit:35000, fee:910,  status:'success', ts: new Date(Date.now()-900000).toISOString()  },
  { id:'TXNOP1QRS', phone:'+254756789012', nationalId:'678901234', limit:16000, fee:450,  status:'failed',  ts: new Date(Date.now()-5400000).toISOString() },
];

// ─────────────────────────────────────────────────────────────
//  Phone formatter → 2547XXXXXXXX
// ─────────────────────────────────────────────────────────────
function formatPhone(raw) {
  let p = raw.replace(/\D/g, '');
  if (p.startsWith('0'))   p = '254' + p.slice(1);
  if (p.startsWith('+'))   p = p.slice(1);
  if (!p.startsWith('254')) p = '254' + p;
  return p; // returns e.g. 254712345678
}

// ─────────────────────────────────────────────────────────────
//  Lipana STK Push
//  Lipana wraps Daraja — their endpoint accepts:
//    POST /v1/mpesa/stkpush
//    Authorization: Bearer <LIPANA_API_KEY>
//    Body: { phone, amount, account_ref, description, callback_url }
//
//  If Lipana's dashboard shows a DIFFERENT endpoint path or body keys,
//  update ONLY the LIPANA_STK_ENDPOINT constant and stkBody keys below.
// ─────────────────────────────────────────────────────────────
const LIPANA_STK_ENDPOINT = '/v1/mpesa/stkpush';

async function sendLipanaSTK({ phone, amount, accountRef, description, callbackUrl }) {
  const headers = {
    'Authorization': `Bearer ${LIPANA_API_KEY}`,
    'Content-Type':  'application/json',
  };

  // If Lipana uses Basic auth instead of Bearer, swap to:
  // 'Authorization': 'Basic ' + Buffer.from(`${LIPANA_API_KEY}:${LIPANA_API_SECRET}`).toString('base64')

  const body = {
    phone:        phone,          // 2547XXXXXXXX
    amount:       amount,         // integer
    account_ref:  accountRef,     // your TXN ID
    description:  description,
    callback_url: callbackUrl,
    shortcode:    LIPANA_SHORTCODE,
  };

  const response = await axios.post(`${LIPANA_BASE}${LIPANA_STK_ENDPOINT}`, body, {
    headers,
    timeout: 30000,
  });

  return response.data;
}

// ─────────────────────────────────────────────────────────────
//  Middleware
// ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret:            process.env.SESSION_SECRET || 'fulizaboost-change-in-prod',
  resave:            false,
  saveUninitialized: false,
  cookie:            { maxAge: 8 * 60 * 60 * 1000 }, // 8 hours
}));

// ─────────────────────────────────────────────────────────────
//  Admin auth guard
// ─────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin/login');
}

// ─────────────────────────────────────────────────────────────
//  PAGE ROUTES
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
//  PUBLIC API — STK Push
// ─────────────────────────────────────────────────────────────
app.post('/api/stk-push', async (req, res) => {
  const { phone, nationalId, limitAmount, fee } = req.body;

  // ── Validate inputs ──
  if (!phone || !nationalId || !limitAmount || !fee) {
    return res.status(400).json({ success: false, message: 'All fields are required.' });
  }
  const cleanId = nationalId.replace(/\D/g, '');
  if (cleanId.length < 7 || cleanId.length > 9) {
    return res.status(400).json({ success: false, message: 'National ID must be 7–9 digits.' });
  }
  const formattedPhone = formatPhone(phone);
  if (formattedPhone.length !== 12) {
    return res.status(400).json({ success: false, message: 'Enter a valid Safaricom number.' });
  }

  // ── Create transaction record ──
  const txnId = 'TXN' + uuidv4().replace(/-/g, '').substring(0, 8).toUpperCase();
  const txn = {
    id:          txnId,
    phone:       '+' + formattedPhone,
    nationalId:  cleanId,
    limit:       parseInt(limitAmount),
    fee:         parseInt(fee),
    status:      'pending',
    lipanaRef:   null,   // Lipana's own reference returned in response
    mpesaCode:   null,   // M-Pesa receipt number from callback
    ts:          new Date().toISOString(),
  };
  transactions.unshift(txn);

  // ── Demo mode: no credentials set ──
  if (!LIPANA_API_KEY || !LIPANA_SHORTCODE) {
    console.warn('[FulizaBoost] LIPANA_API_KEY / LIPANA_SHORTCODE not set → DEMO MODE');
    return res.json({
      success:       true,
      transactionId: txnId,
      demo:          true,
      message:       'Demo mode — set LIPANA_API_KEY and LIPANA_SHORTCODE in env to send real STK push.',
    });
  }

  // ── Send STK Push via Lipana ──
  try {
    const callbackUrl = `${BASE_URL}/api/lipana-callback`;
    const lipanaRes = await sendLipanaSTK({
      phone:       formattedPhone,
      amount:      parseInt(fee),
      accountRef:  txnId,
      description: `FulizaBoost limit unlock ${limitAmount}`,
      callbackUrl,
    });

    console.log('[Lipana STK Response]', JSON.stringify(lipanaRes));

    // Lipana returns { success: true, reference: "...", message: "..." }
    // or { status: 200, request_id: "...", description: "..." }
    // We treat any 2xx with truthy success / status as accepted
    const accepted =
      lipanaRes.success === true ||
      lipanaRes.status  === 200  ||
      lipanaRes.status  === 'success' ||
      lipanaRes.ResponseCode === '0';

    if (accepted) {
      txn.lipanaRef = lipanaRes.reference || lipanaRes.request_id || lipanaRes.CheckoutRequestID || null;
      return res.json({
        success:       true,
        transactionId: txnId,
        message:       'STK push sent. Check your phone and enter your M-Pesa PIN.',
      });
    } else {
      txn.status = 'failed';
      const errMsg = lipanaRes.message || lipanaRes.description || lipanaRes.errorMessage || 'STK push rejected by Lipana.';
      console.error('[Lipana] Rejected:', errMsg);
      return res.status(400).json({ success: false, message: errMsg });
    }

  } catch (err) {
    txn.status = 'failed';
    // Extract the most useful error message
    const status  = err.response?.status;
    const errData = err.response?.data;
    const errMsg  = errData?.message || errData?.description || errData?.errorMessage || err.message;
    console.error('[Lipana STK Error]', status, JSON.stringify(errData), err.message);
    return res.status(500).json({
      success: false,
      message: `STK push failed (${status || 'network error'}): ${errMsg}`,
    });
  }
});

// ─────────────────────────────────────────────────────────────
//  Lipana Webhook Callback
//  Lipana POSTs here after customer approves/rejects the STK prompt.
//  Set this URL in your Lipana dashboard:
//    https://your-app.railway.app/api/lipana-callback
//
//  Lipana callback body (typical shape — adjust if their docs differ):
//  {
//    "reference": "TXN...",          ← your account_ref / our txnId
//    "status": "success"|"failed",
//    "mpesa_code": "SH98HGX9JE",     ← M-Pesa receipt number
//    "amount": 670,
//    "phone": "254712345678",
//    "message": "Payment received"
//  }
//
//  Some providers use ResultCode / Body.stkCallback (Daraja-style).
//  Both formats are handled below.
// ─────────────────────────────────────────────────────────────
app.post('/api/lipana-callback', (req, res) => {
  try {
    const body = req.body;
    console.log('[Lipana Callback] Received:', JSON.stringify(body));

    let txnRef    = null;
    let isSuccess = false;
    let mpesaCode = null;

    // ── Format A: Lipana native ──
    // { reference, status, mpesa_code }
    if (body.reference) {
      txnRef    = body.reference;
      isSuccess = body.status === 'success' || body.status === 'completed' || body.ResultCode === 0 || body.ResultCode === '0';
      mpesaCode = body.mpesa_code || body.MpesaReceiptNumber || null;
    }

    // ── Format B: Daraja-style (some Lipana versions wrap Daraja) ──
    // { Body: { stkCallback: { CheckoutRequestID, ResultCode, CallbackMetadata } } }
    else if (body.Body && body.Body.stkCallback) {
      const cb  = body.Body.stkCallback;
      isSuccess = cb.ResultCode === 0 || cb.ResultCode === '0';
      // Match by Lipana ref stored on txn
      const matchedTxn = transactions.find(t => t.lipanaRef === cb.CheckoutRequestID);
      if (matchedTxn) {
        txnRef = matchedTxn.id;
        if (isSuccess && cb.CallbackMetadata && cb.CallbackMetadata.Item) {
          const items  = cb.CallbackMetadata.Item;
          const getVal = name => (items.find(i => i.Name === name) || {}).Value;
          mpesaCode = getVal('MpesaReceiptNumber') || null;
        }
      }
    }

    // ── Format C: flat Lipana response ──
    // { txn_id, payment_status, receipt_number }
    else if (body.txn_id || body.transaction_id || body.order_id) {
      txnRef    = body.txn_id || body.transaction_id || body.order_id;
      isSuccess = body.payment_status === 'success' || body.payment_status === 'paid' || body.ResultCode === '0';
      mpesaCode = body.receipt_number || body.mpesa_receipt || null;
    }

    // ── Update transaction ──
    if (txnRef) {
      const txn = transactions.find(t => t.id === txnRef);
      if (txn) {
        txn.status    = isSuccess ? 'success' : 'failed';
        txn.mpesaCode = mpesaCode;
        console.log(`[Lipana Callback] TXN ${txn.id} → ${txn.status} | M-Pesa Code: ${mpesaCode || 'N/A'}`);
      } else {
        console.warn('[Lipana Callback] No matching TXN for ref:', txnRef);
      }
    } else {
      console.warn('[Lipana Callback] Could not extract transaction reference from body:', JSON.stringify(body));
    }

  } catch (e) {
    console.error('[Lipana Callback Error]', e.message);
  }

  // Always respond 200 to Lipana so they don't retry
  res.status(200).json({ success: true });
});

// ─────────────────────────────────────────────────────────────
//  Poll transaction status (frontend polls every 4s)
// ─────────────────────────────────────────────────────────────
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

// Manual confirm (user taps "I approved")
app.post('/api/confirm-payment', (req, res) => {
  const { transactionId } = req.body;
  const txn = transactions.find(t => t.id === transactionId);
  if (!txn) return res.status(404).json({ success: false, message: 'Transaction not found' });
  if (txn.status === 'pending') txn.status = 'success';
  res.json({ success: true, transaction: txn });
});

// ─────────────────────────────────────────────────────────────
//  ADMIN API (all routes protected)
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
//  Security: block direct access to HTML files
// ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/admin.html') return res.redirect('/admin');
  if (req.path === '/login.html') return res.redirect('/admin/login');
  next();
});

// 404 → serve landing page
app.use((req, res) =>
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

// ─────────────────────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  FulizaBoost running → http://localhost:${PORT}`);
  console.log(`📡  Lipana callback URL  → ${BASE_URL}/api/lipana-callback`);
  if (!LIPANA_API_KEY) console.warn('⚠️   LIPANA_API_KEY not set — running in demo mode');
});
