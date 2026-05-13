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
//  LIMIT PLANS — editable from admin dashboard in real time
//  Admin can change any fee; frontend fetches this array via /api/plans
// ─────────────────────────────────────────────────────────────────────────────
let limitPlans = [
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

function formatPhone(raw) {
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('0'))                       p = '254' + p.slice(1);
  if (p.startsWith('7') || p.startsWith('1')) p = '254' + p;
  if (!p.startsWith('254'))                    p = '254' + p;
  return '+' + p;
}

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

let lipanaClient = null;
if (LIPANA_SECRET_KEY) {
  try {
    const { Lipana } = require('@lipana/sdk');
    lipanaClient = new Lipana({ apiKey: LIPANA_SECRET_KEY, environment: 'production' });
    console.log('✅  Lipana SDK initialised');
  } catch (e) {
    console.error('❌  Lipana SDK error:', e.message);
  }
} else {
  console.warn('⚠️   LIPANA_SECRET_KEY not set — DEMO MODE');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Middleware — parsers FIRST, then API routes, then static
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC API ROUTES (before static)
// ─────────────────────────────────────────────────────────────────────────────

// Limit plans — fetched by frontend on load
app.get('/api/plans', (req, res) => {
  res.json({ success: true, data: limitPlans });
});

// Live boosts feed
// Public — frontend fetches current fees on every page load
app.get('/api/plans', (req, res) => {
  res.json({ success: true, data: limitPlans });
});

app.get('/api/live-boosts', (req, res) => {
  const real = transactions
    .filter(t => t.status === 'success')
    .map(t => ({ phone: t.phone.slice(0,5)+'***'+t.phone.slice(-3), limit: t.limit, ts: new Date(t.ts).getTime() }));
  const all = [...real, ...liveBoosts].sort((a,b) => b.ts - a.ts).slice(0, 20);
  res.json({ success: true, data: all });
});

// STK Push
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

  // Validate fee against current server-side plan (prevents tampering)
  const plan = limitPlans.find(p => p.amount === parseInt(limitAmount));
  if (!plan)
    return res.status(400).json({ success: false, message: 'Invalid limit plan selected.' });
  const validatedFee = plan.fee; // always use server-side fee

  const txnId = 'TXN' + uuidv4().replace(/-/g,'').substring(0,8).toUpperCase();
  const txn = {
    id: txnId, phone: formattedPhone, nationalId: cleanId,
    limit: parseInt(limitAmount), fee: validatedFee,
    status: 'pending', lipanaRef: null, mpesaCode: null,
    ts: new Date().toISOString(),
  };
  transactions.unshift(txn);

  liveBoosts.unshift({ phone: formattedPhone.slice(0,5)+'***'+formattedPhone.slice(-3), limit: parseInt(limitAmount), ts: Date.now() });
  if (liveBoosts.length > 50) liveBoosts.pop();

  if (!lipanaClient) {
    console.warn(`[Demo] STK would go to ${formattedPhone} KES ${validatedFee}`);
    return res.json({ success: true, transactionId: txnId, demo: true, message: 'Demo mode — set LIPANA_SECRET_KEY.' });
  }

  try {
    console.log(`[STK] → ${formattedPhone} | KES ${validatedFee} | ref ${txnId}`);
    const response = await lipanaClient.transactions.initiateStkPush({
      phone:  formattedPhone,
      amount: validatedFee,
    });
    console.log('[Lipana Response]', JSON.stringify(response));
    txn.lipanaRef = response?.transactionId || response?.id || response?.data?.id || null;
    return res.json({ success: true, transactionId: txnId, message: 'STK push sent. Check your phone.' });
  } catch (err) {
    txn.status = 'failed';
    const httpStatus = err?.response?.status;
    const errBody    = err?.response?.data;
    const errMsg     = errBody?.message || errBody?.error || err?.message || 'Unknown error';
    console.error(`[STK Error] ${httpStatus} | ${errMsg}`);
    if (httpStatus === 401 || httpStatus === 403)
      return res.status(500).json({ success: false, message: 'Authentication failed. Check LIPANA_SECRET_KEY.' });
    return res.status(500).json({ success: false, message: `STK push failed: ${errMsg}` });
  }
});

// Lipana webhook callback
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
        const find = n => (cb.CallbackMetadata.Item.find(i => i.Name === n) || {}).Value;
        mpesaCode = find('MpesaReceiptNumber') || null;
      }
    } else {
      const ref   = body.reference || body.accountReference || null;
      const lipId = body.transactionId || body.transaction_id || null;
      isSuccess   = body.status === 'success' || body.status === 'completed' || body.event === 'transaction.success';
      mpesaCode   = body.mpesaCode || body.mpesa_code || null;
      txn = (ref   ? transactions.find(t => t.id === ref) : null)
         || (lipId ? transactions.find(t => t.lipanaRef === lipId) : null);
      if (!txn && body.phone) {
        const ph = String(body.phone).replace(/\D/g,'');
        txn = transactions.find(t => t.status === 'pending' && t.phone.replace(/\D/g,'') === ph);
      }
    }
    if (txn) {
      txn.status = isSuccess ? 'success' : 'failed';
      txn.mpesaCode = mpesaCode;
      console.log(`[Webhook] TXN ${txn.id} → ${txn.status}`);
    }
  } catch (e) { console.error('[Webhook Error]', e.message); }
});

// Poll
app.get('/api/transaction/:id', (req, res) => {
  const txn = transactions.find(t => t.id === req.params.id);
  if (!txn) return res.status(404).json({ success: false });
  res.json({ success: true, transaction: { id: txn.id, status: txn.status, limit: txn.limit, fee: txn.fee, mpesaCode: txn.mpesaCode } });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Session
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

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN API
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const ok = transactions.filter(t => t.status === 'success');
  res.json({
    total:   transactions.length,
    success: ok.length,
    pending: transactions.filter(t => t.status === 'pending').length,
    failed:  transactions.filter(t => t.status === 'failed').length,
    revenue: ok.reduce((a,t) => a + t.fee, 0),
    todayCount: transactions.filter(t => new Date(t.ts).toDateString() === new Date().toDateString()).length,
    todayRevenue: transactions.filter(t => t.status === 'success' && new Date(t.ts).toDateString() === new Date().toDateString()).reduce((a,t)=>a+t.fee,0),
  });
});

app.get('/api/admin/transactions', requireAdmin, (req, res) => {
  const { q, status, page=1, limit=50 } = req.query;
  let data = [...transactions];
  if (q)      data = data.filter(t => t.phone.includes(q)||t.nationalId.includes(q)||t.id.includes(q.toUpperCase()));
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
  res.json({ success: true, data: Object.values(users).sort((a,b)=>b.paid-a.paid) });
});

// ── Limit Plans management (admin) ──
app.get('/api/admin/plans', requireAdmin, (req, res) => {
  res.json({ success: true, data: limitPlans });
});

// Update a single plan's fee
app.patch('/api/admin/plans/:id', requireAdmin, (req, res) => {
  const plan = limitPlans.find(p => p.id === parseInt(req.params.id));
  if (!plan) return res.status(404).json({ success: false, message: 'Plan not found' });
  const newFee = parseInt(req.body.fee);
  if (isNaN(newFee) || newFee < 1)
    return res.status(400).json({ success: false, message: 'Fee must be a positive number' });
  plan.fee = newFee;
  console.log(`[Admin] Plan ${plan.amount} fee updated to KES ${newFee}`);
  res.json({ success: true, plan });
});

// Bulk update all fees at once
app.put('/api/admin/plans', requireAdmin, (req, res) => {
  const updates = req.body.plans; // [{ id, fee }, ...]
  if (!Array.isArray(updates))
    return res.status(400).json({ success: false, message: 'Expected plans array' });
  updates.forEach(u => {
    const plan = limitPlans.find(p => p.id === parseInt(u.id));
    const fee  = parseInt(u.fee);
    if (plan && !isNaN(fee) && fee > 0) plan.fee = fee;
  });
  console.log('[Admin] All plans bulk-updated');
  res.json({ success: true, data: limitPlans });
});

// Reset fees to defaults
app.post('/api/admin/plans/reset', requireAdmin, (req, res) => {
  limitPlans = [
    { id:1,  amount:5000,  fee:99   }, { id:2,  amount:7500,  fee:150  },
    { id:3,  amount:10000, fee:240  }, { id:4,  amount:12500, fee:360  },
    { id:5,  amount:16000, fee:450  }, { id:6,  amount:21000, fee:570  },
    { id:7,  amount:25500, fee:670  }, { id:8,  amount:30000, fee:780  },
    { id:9,  amount:35000, fee:910  }, { id:10, amount:40000, fee:1050 },
    { id:11, amount:45000, fee:1200 }, { id:12, amount:50000, fee:1400 },
    { id:13, amount:60000, fee:1600 }, { id:14, amount:70000, fee:2000 },
  ];
  res.json({ success: true, data: limitPlans });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Static + page routes — AFTER all API routes
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.use((req, res, next) => {
  if (req.path === '/admin.html') return res.redirect('/admin');
  if (req.path === '/login.html') return res.redirect('/admin/login');
  next();
});
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`✅  FulizaBoost → http://localhost:${PORT}`);
  console.log(`📡  Webhook     → ${BASE_URL}/api/lipana-callback`);
  console.log(`🔑  Lipana key  → ${LIPANA_SECRET_KEY ? 'SET ✅' : 'NOT SET ⚠️'}`);
});
