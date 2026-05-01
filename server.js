const express  = require('express');
const session  = require('express-session');
const axios    = require('axios');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
//  RAILWAY ENVIRONMENT VARIABLES
//
//  LIPANA_SECRET_KEY   → Secret key from Lipana dashboard  (sk_live_...)
//  LIPANA_PUBLIC_KEY   → Public key from Lipana dashboard  (pk_live_...)
//  BASE_URL            → https://your-app.railway.app  (no trailing slash)
//  ADMIN_USER          → admin
//  ADMIN_PASS          → your secure password
//  SESSION_SECRET      → long random string
// ─────────────────────────────────────────────────────────────────────────────
const LIPANA_SECRET_KEY = process.env.LIPANA_SECRET_KEY || '';
const LIPANA_PUBLIC_KEY = process.env.LIPANA_PUBLIC_KEY || '';
const BASE_URL          = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_USER        = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS        = process.env.ADMIN_PASS || 'admin123';

// Lipana Technologies REST API base — confirmed from their SDK source
// The SDK internally uses this base + /transactions/stk-push
const LIPANA_API_BASE = 'https://api.lipana.dev/api';

// ─────────────────────────────────────────────────────────────────────────────
//  Phone formatter  →  +2547XXXXXXXX  (E.164, 13 chars)
// ─────────────────────────────────────────────────────────────────────────────
function formatPhone(raw) {
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('0'))                        p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1'))   p = '254' + p;
  if (!p.startsWith('254'))                     p = '254' + p;
  return '+' + p;  // +254712345678
}

// ─────────────────────────────────────────────────────────────────────────────
//  In-memory store (pre-seeded with demo data)
// ─────────────────────────────────────────────────────────────────────────────
let transactions = [
  { id:'TXN1A2B3C', phone:'+254712345678', nationalId:'234567890', limit:25000, fee:670,  status:'success', lipanaRef:null, mpesaCode:'SB12HGX9JE', ts:new Date(Date.now()-3600000).toISOString() },
  { id:'TXN4D5E6F', phone:'+254723456789', nationalId:'345678901', limit:10000, fee:240,  status:'success', lipanaRef:null, mpesaCode:'SC34HGX7KL', ts:new Date(Date.now()-7200000).toISOString() },
  { id:'TXN7G8H9I', phone:'+254734567890', nationalId:'456789012', limit:50000, fee:1400, status:'pending', lipanaRef:null, mpesaCode:null,         ts:new Date(Date.now()-1800000).toISOString() },
  { id:'TXNJK0LMN', phone:'+254745678901', nationalId:'567890123', limit:35000, fee:910,  status:'success', lipanaRef:null, mpesaCode:'SD56HGX5MN', ts:new Date(Date.now()-900000).toISOString()  },
  { id:'TXNOP1QRS', phone:'+254756789012', nationalId:'678901234', limit:16000, fee:450,  status:'failed',  lipanaRef:null, mpesaCode:null,         ts:new Date(Date.now()-5400000).toISOString() },
];

// ─────────────────────────────────────────────────────────────────────────────
//  Lipana STK Push — direct REST call
//  Endpoint confirmed from @lipana/sdk npm source code:
//    POST https://api.lipana.dev/api/transactions/stk-push
//  Headers: Authorization: Bearer <LIPANA_SECRET_KEY>
//  Body:    { phone, amount, callback_url, reference?, description? }
// ─────────────────────────────────────────────────────────────────────────────
async function sendLipanaSTK({ phone, amount, callbackUrl, reference, description }) {
  const url  = `${LIPANA_API_BASE}/transactions/stk-push`;
  const body = {
    phone:        phone,         // +254712345678
    amount:       amount,        // integer KES
    callback_url: callbackUrl,
    reference:    reference,     // your internal TXN ID
    description:  description,
  };

  console.log('[Lipana STK] POST', url, JSON.stringify({ ...body, phone: '***redacted***' }));

  const resp = await axios.post(url, body, {
    headers: {
      'Authorization': `Bearer ${LIPANA_SECRET_KEY}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    timeout: 30000,
  });

  return resp.data;
}

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
  cookie:            { maxAge: 8 * 60 * 60 * 1000 },
}));

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin/login');
}

// ─────────────────────────────────────────────────────────────────────────────
//  PAGE ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/',            (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin',       requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
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

app.post('/admin/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/stk-push
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/stk-push', async (req, res) => {
  const { phone, nationalId, limitAmount, fee } = req.body;

  // Validate
  if (!phone || !nationalId || !limitAmount || !fee) {
    return res.status(400).json({ success: false, message: 'All fields are required.' });
  }
  const cleanId = String(nationalId).replace(/\D/g, '');
  if (cleanId.length < 7 || cleanId.length > 9) {
    return res.status(400).json({ success: false, message: 'National ID must be 7–9 digits.' });
  }
  const formattedPhone = formatPhone(phone);
  if (formattedPhone.length !== 13) {
    return res.status(400).json({ success: false, message: 'Enter a valid Safaricom number, e.g. 0712345678.' });
  }

  // Create transaction
  const txnId = 'TXN' + uuidv4().replace(/-/g, '').substring(0, 8).toUpperCase();
  const txn = {
    id: txnId, phone: formattedPhone, nationalId: cleanId,
    limit: parseInt(limitAmount), fee: parseInt(fee),
    status: 'pending', lipanaRef: null, mpesaCode: null,
    ts: new Date().toISOString(),
  };
  transactions.unshift(txn);

  // No credentials → demo mode
  if (!LIPANA_SECRET_KEY) {
    console.warn('[FulizaBoost] LIPANA_SECRET_KEY not set → DEMO MODE');
    return res.json({ success: true, transactionId: txnId, demo: true,
      message: 'Demo mode: set LIPANA_SECRET_KEY in Railway env.' });
  }

  // Send real STK push
  try {
    const callbackUrl = `${BASE_URL}/api/lipana-callback`;
    const data = await sendLipanaSTK({
      phone:       formattedPhone,
      amount:      parseInt(fee),
      callbackUrl,
      reference:   txnId,
      description: `FulizaBoost ${limitAmount}`,
    });

    console.log('[Lipana STK Response]', JSON.stringify(data));

    // Lipana returns { success: true, data: { id, ... } } or { transactionId, ... }
    const accepted = data.success === true
                  || data.status  === 'success'
                  || data.status  === 'pending'
                  || !!(data.data && data.data.id)
                  || !!(data.transactionId);

    if (accepted) {
      txn.lipanaRef = data?.data?.id || data?.transactionId || data?.id || null;
      console.log(`[STK Push] ✅ Sent to ${formattedPhone} | lipanaRef: ${txn.lipanaRef}`);
      return res.json({
        success: true, transactionId: txnId,
        message: 'STK push sent. Check your phone and enter your M-Pesa PIN.',
      });
    } else {
      txn.status = 'failed';
      const msg = data?.message || data?.error || 'STK push rejected by Lipana.';
      console.error('[STK Push] Rejected:', msg, JSON.stringify(data));
      return res.status(400).json({ success: false, message: msg });
    }

  } catch (err) {
    txn.status = 'failed';
    const httpStatus = err.response?.status;
    const errBody    = err.response?.data;
    const errMsg     = errBody?.message || errBody?.error || errBody?.detail || err.message;
    console.error('[STK Push Error]', httpStatus, JSON.stringify(errBody), err.message);

    // Return specific actionable error
    if (httpStatus === 401 || httpStatus === 403) {
      return res.status(500).json({ success: false,
        message: 'Authentication failed. Check your LIPANA_SECRET_KEY in Railway env.' });
    }
    if (httpStatus === 422 || httpStatus === 400) {
      return res.status(400).json({ success: false,
        message: `Invalid request: ${errMsg}` });
    }
    return res.status(500).json({ success: false,
      message: `STK push failed: ${errMsg}` });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/lipana-callback
//  Set this URL in Lipana dashboard → Webhook URL:
//    https://your-app.railway.app/api/lipana-callback
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/lipana-callback', (req, res) => {
  try {
    const body = req.body;
    console.log('[Lipana Callback] Received:', JSON.stringify(body));

    // Extract transaction reference — Lipana sends our reference back
    // Shape A: { reference, status, data: { mpesa_code, ... } }
    // Shape B: { event, transactionId, status, mpesaCode, reference }
    // Shape C: { Body: { stkCallback: { ... } } }  (Daraja passthrough)

    let ourTxnId  = null;
    let lipanaId  = null;
    let isSuccess = false;
    let mpesaCode = null;

    if (body.Body && body.Body.stkCallback) {
      // Daraja passthrough format
      const cb = body.Body.stkCallback;
      isSuccess = cb.ResultCode === 0 || cb.ResultCode === '0';
      const matched = transactions.find(t => t.lipanaRef === cb.CheckoutRequestID);
      if (matched) {
        ourTxnId = matched.id;
        if (isSuccess && cb.CallbackMetadata?.Item) {
          const find = name => (cb.CallbackMetadata.Item.find(i => i.Name === name) || {}).Value;
          mpesaCode  = find('MpesaReceiptNumber') || null;
        }
      }
    } else {
      // Native Lipana format
      ourTxnId  = body.reference || body.accountReference || body.account_reference || null;
      lipanaId  = body.transactionId || body.transaction_id || body?.data?.id || null;
      isSuccess = body.status === 'success'
               || body.status === 'completed'
               || body.event  === 'transaction.success';
      mpesaCode = body.mpesaCode
               || body.mpesa_code
               || body.receipt
               || body?.data?.mpesa_code
               || null;
    }

    // Find the transaction
    let txn = ourTxnId ? transactions.find(t => t.id === ourTxnId) : null;
    if (!txn && lipanaId) txn = transactions.find(t => t.lipanaRef === lipanaId);

    if (txn) {
      txn.status    = isSuccess ? 'success' : 'failed';
      txn.mpesaCode = mpesaCode;
      txn.lipanaRef = lipanaId || txn.lipanaRef;
      console.log(`[Callback] TXN ${txn.id} → ${txn.status} | Receipt: ${mpesaCode || 'N/A'}`);
    } else {
      console.warn('[Callback] No matching transaction. ourTxnId:', ourTxnId, '| lipanaId:', lipanaId);
    }

  } catch (e) {
    console.error('[Callback Error]', e.message);
  }

  // Always 200 — Lipana retries on non-200
  res.status(200).json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/transaction/:id  — frontend polls every 4s
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/transaction/:id', (req, res) => {
  const txn = transactions.find(t => t.id === req.params.id);
  if (!txn) return res.status(404).json({ success: false, message: 'Transaction not found' });
  res.json({ success: true,
    transaction: { id: txn.id, status: txn.status, limit: txn.limit, fee: txn.fee, mpesaCode: txn.mpesaCode } });
});

// POST /api/confirm-payment — kept only for internal/admin use, NOT shown to user
app.post('/api/confirm-payment', (req, res) => {
  const { transactionId } = req.body;
  const txn = transactions.find(t => t.id === transactionId);
  if (!txn) return res.status(404).json({ success: false, message: 'Transaction not found' });
  if (txn.status === 'pending') txn.status = 'success';
  res.json({ success: true, transaction: txn });
});

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN API
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const success = transactions.filter(t => t.status === 'success');
  res.json({ total: transactions.length, success: success.length,
    pending: transactions.filter(t => t.status === 'pending').length,
    failed:  transactions.filter(t => t.status === 'failed').length,
    revenue: success.reduce((a, t) => a + t.fee, 0) });
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

// Block direct HTML access
app.use((req, res, next) => {
  if (req.path === '/admin.html') return res.redirect('/admin');
  if (req.path === '/login.html') return res.redirect('/admin/login');
  next();
});
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

// ─────────────────────────────────────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  FulizaBoost running  → http://localhost:${PORT}`);
  console.log(`📡  Callback URL         → ${BASE_URL}/api/lipana-callback`);
  if (!LIPANA_SECRET_KEY) console.warn('⚠️   LIPANA_SECRET_KEY not set — DEMO MODE');
});
