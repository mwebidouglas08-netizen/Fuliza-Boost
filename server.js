const express  = require('express');
const session  = require('express-session');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const LIPANA_SECRET_KEY = process.env.LIPANA_SECRET_KEY || '';
const BASE_URL          = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_USER        = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS        = process.env.ADMIN_PASS || 'admin123';

// ─────────────────────────────────────────────────────────────────────────────
//  LIMIT PLANS — editable by admin in real time via Fee Manager
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_PLANS = [
  { id:1,  amount:5000,  fee:99   },
  { id:2,  amount:7500,  fee:150  },
  { id:3,  amount:10000, fee:240  },
  { id:4,  amount:12500, fee:360  },
  { id:5,  amount:16000, fee:450  },
  { id:6,  amount:21000, fee:570  },
  { id:7,  amount:25500, fee:670  },
  { id:8,  amount:30000, fee:780  },
  { id:9,  amount:35000, fee:910  },
  { id:10, amount:40000, fee:1050 },
  { id:11, amount:45000, fee:1200 },
  { id:12, amount:50000, fee:1400 },
  { id:13, amount:60000, fee:1600 },
  { id:14, amount:70000, fee:2000 },
];
let limitPlans = DEFAULT_PLANS.map(p => ({ ...p }));

// ─────────────────────────────────────────────────────────────────────────────
//  Real data only — no fake/seed records
// ─────────────────────────────────────────────────────────────────────────────
let transactions = [];
let liveBoosts   = [];

// ─────────────────────────────────────────────────────────────────────────────
//  Phone formatter → +2547XXXXXXXX
// ─────────────────────────────────────────────────────────────────────────────
function formatPhone(raw) {
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('0'))                       p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  if (!p.startsWith('254'))                    p = '254' + p;
  return '+' + p;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Lipana SDK
// ─────────────────────────────────────────────────────────────────────────────
let lipanaClient = null;
if (LIPANA_SECRET_KEY) {
  try {
    const { Lipana } = require('@lipana/sdk');
    lipanaClient = new Lipana({ apiKey: LIPANA_SECRET_KEY, environment: 'production' });
    console.log('✅  Lipana SDK initialised — production mode');
  } catch (e) {
    console.error('❌  Lipana SDK error:', e.message);
  }
} else {
  console.warn('⚠️   LIPANA_SECRET_KEY not set — DEMO MODE');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Middleware
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC API — all registered BEFORE express.static
// ─────────────────────────────────────────────────────────────────────────────

// Current limit plans (fees editable by admin)
app.get('/api/plans', (req, res) => {
  res.json({ success: true, data: limitPlans });
});

// Live boosts feed — only real successful transactions
app.get('/api/live-boosts', (req, res) => {
  const data = liveBoosts.slice(0, 20);
  res.json({ success: true, data });
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
  if (formattedPhone.length !== 13)
    return res.status(400).json({ success: false, message: 'Enter a valid Safaricom number e.g. 0712345678.' });

  const txnId = 'TXN' + uuidv4().replace(/-/g,'').substring(0,8).toUpperCase();
  const txn = {
    id: txnId, phone: formattedPhone, nationalId: cleanId,
    limit: parseInt(limitAmount), fee: parseInt(fee),
    status: 'pending', lipanaRef: null, mpesaCode: null,
    ts: new Date().toISOString(),
  };
  transactions.unshift(txn);

  if (!lipanaClient) {
    console.warn(`[Demo] STK push to ${formattedPhone} for KES ${fee}`);
    return res.json({ success: true, transactionId: txnId, demo: true,
      message: 'Demo mode — set LIPANA_SECRET_KEY in environment.' });
  }

  try {
    console.log(`[STK] → ${formattedPhone} | KES ${fee} | ${txnId}`);
    const response = await lipanaClient.transactions.initiateStkPush({
      phone:  formattedPhone,
      amount: parseInt(fee),
    });
    console.log('[Lipana Response]', JSON.stringify(response));
    txn.lipanaRef = response?.transactionId || response?.id || response?.data?.id || null;
    return res.json({ success: true, transactionId: txnId,
      message: 'STK push sent. Check your phone and enter your M-Pesa PIN.' });
  } catch (err) {
    txn.status = 'failed';
    const httpStatus = err?.response?.status || err?.statusCode;
    const errMsg = err?.response?.data?.message || err?.response?.data?.error || err?.message || 'Unknown error';
    console.error(`[STK Error] HTTP ${httpStatus||'N/A'} | ${errMsg}`);
    if (httpStatus === 401 || httpStatus === 403)
      return res.status(500).json({ success: false, message: 'Lipana authentication failed. Check LIPANA_SECRET_KEY.' });
    return res.status(500).json({ success: false, message: `STK push failed: ${errMsg}` });
  }
});

// ── Lipana Webhook ────────────────────────────────────────────────────────────
app.post('/api/lipana-callback', (req, res) => {
  res.status(200).json({ success: true });
  try {
    const body = req.body;
    console.log('[Webhook]', JSON.stringify(body));
    let txn = null, isSuccess = false, mpesaCode = null;

    if (body?.Body?.stkCallback) {
      const cb  = body.Body.stkCallback;
      isSuccess = cb.ResultCode === 0 || cb.ResultCode === '0';
      txn = transactions.find(t => t.lipanaRef === cb.CheckoutRequestID)
         || transactions.find(t => t.id === cb.AccountReference);
      if (isSuccess && cb.CallbackMetadata?.Item) {
        const find = n => (cb.CallbackMetadata.Item.find(i => i.Name===n)||{}).Value;
        mpesaCode = find('MpesaReceiptNumber') || null;
      }
    } else {
      const ref   = body.reference || body.accountReference || null;
      const lipId = body.transactionId || body.transaction_id || body?.data?.id || null;
      isSuccess   = body.status==='success' || body.status==='completed' || body.event==='transaction.success';
      mpesaCode   = body.mpesaCode || body.mpesa_code || body?.data?.mpesaCode || null;
      txn = (ref   ? transactions.find(t => t.id===ref) : null)
         || (lipId ? transactions.find(t => t.lipanaRef===lipId) : null);
      if (!txn && body.phone) {
        const ph = String(body.phone).replace(/\D/g,'');
        txn = transactions.find(t => t.status==='pending' && t.phone.replace(/\D/g,'')===ph);
      }
    }

    if (txn) {
      txn.status    = isSuccess ? 'success' : 'failed';
      txn.mpesaCode = mpesaCode;
      txn.failReason= isSuccess ? null : (body.message || body.ResultDesc || 'Not completed');
      console.log(`[Webhook] TXN ${txn.id} → ${txn.status} | Receipt: ${mpesaCode||'N/A'}`);

      // Add to live boosts only on genuine success
      if (isSuccess) {
        liveBoosts.unshift({
          phone: txn.phone.slice(0,4) + '***' + txn.phone.slice(-3),
          limit: txn.limit,
          ts:    Date.now(),
        });
        if (liveBoosts.length > 50) liveBoosts.pop();
      }
    } else {
      console.warn('[Webhook] No matching transaction. Body:', JSON.stringify(body));
    }
  } catch (e) {
    console.error('[Webhook Error]', e.message);
  }
});

// Poll transaction status
app.get('/api/transaction/:id', (req, res) => {
  const txn = transactions.find(t => t.id === req.params.id);
  if (!txn) return res.status(404).json({ success: false, message: 'Not found' });
  res.json({ success: true, transaction: { id:txn.id, status:txn.status, limit:txn.limit, fee:txn.fee, mpesaCode:txn.mpesaCode } });
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
  res.json({
    total:   transactions.length,
    success: ok.length,
    pending: transactions.filter(t => t.status === 'pending').length,
    failed:  transactions.filter(t => t.status === 'failed').length,
    revenue: ok.reduce((a,t) => a+t.fee, 0),
  });
});

app.get('/api/admin/transactions', requireAdmin, (req, res) => {
  const { q, status, page=1, limit=100 } = req.query;
  let data = [...transactions];
  if (q)      data = data.filter(t => t.phone.includes(q)||t.nationalId.includes(q)||t.id.includes(q));
  if (status) data = data.filter(t => t.status===status);
  const s = (parseInt(page)-1)*parseInt(limit);
  res.json({ success:true, data: data.slice(s, s+parseInt(limit)), total: data.length });
});

app.patch('/api/admin/transactions/:id', requireAdmin, (req, res) => {
  const txn = transactions.find(t => t.id===req.params.id);
  if (!txn) return res.status(404).json({ success:false });
  Object.assign(txn, req.body);
  res.json({ success:true, transaction: txn });
});

app.delete('/api/admin/transactions/:id', requireAdmin, (req, res) => {
  transactions = transactions.filter(t => t.id!==req.params.id);
  res.json({ success:true });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = {};
  transactions.forEach(t => {
    if (!users[t.phone]) users[t.phone] = { phone:t.phone, nationalId:t.nationalId, paid:0, upgrades:0, last:t.ts };
    if (t.status==='success') { users[t.phone].paid+=t.fee; users[t.phone].upgrades++; }
    if (t.ts>users[t.phone].last) users[t.phone].last=t.ts;
  });
  res.json({ success:true, data: Object.values(users) });
});

// Admin Fee Manager
app.get('/api/admin/plans', requireAdmin, (req, res) => {
  res.json({ success:true, data: limitPlans });
});

app.put('/api/admin/plans', requireAdmin, (req, res) => {
  const { plans } = req.body;
  if (!Array.isArray(plans)) return res.status(400).json({ success:false, message:'plans array required' });
  plans.forEach(({ id, fee }) => {
    const plan = limitPlans.find(p => p.id===id);
    if (plan && typeof fee==='number' && fee>0) plan.fee = fee;
  });
  console.log('[Fee Manager] Plans updated by admin');
  res.json({ success:true, data: limitPlans });
});

app.post('/api/admin/plans/reset', requireAdmin, (req, res) => {
  limitPlans = DEFAULT_PLANS.map(p => ({ ...p }));
  console.log('[Fee Manager] Plans reset to defaults');
  res.json({ success:true, data: limitPlans });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Static + Page routes — AFTER all API routes
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/',            (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin',       requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.use((req, res, next) => {
  if (req.path==='/admin.html') return res.redirect('/admin');
  if (req.path==='/login.html') return res.redirect('/admin/login');
  next();
});
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`✅  FulizaBoost → http://localhost:${PORT}`);
  console.log(`📡  Callback   → ${BASE_URL}/api/lipana-callback`);
  console.log(`🔑  Lipana key → ${LIPANA_SECRET_KEY ? 'SET ✅' : 'NOT SET ⚠️ (demo mode)'}`);
});
