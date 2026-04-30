const express = require('express');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── In-memory store (replace with DB in production) ──
let transactions = [
  { id: 'TXN1A2B3C', phone: '+254712345678', nationalId: '234567890', limit: 25000, fee: 670, status: 'success', ts: new Date(Date.now() - 3600000).toISOString() },
  { id: 'TXN4D5E6F', phone: '+254723456789', nationalId: '345678901', limit: 10000, fee: 240, status: 'success', ts: new Date(Date.now() - 7200000).toISOString() },
  { id: 'TXN7G8H9I', phone: '+254734567890', nationalId: '456789012', limit: 50000, fee: 1400, status: 'pending', ts: new Date(Date.now() - 1800000).toISOString() },
  { id: 'TXNJK0LMN', phone: '+254745678901', nationalId: '567890123', limit: 35000, fee: 910,  status: 'success', ts: new Date(Date.now() - 900000).toISOString() },
  { id: 'TXNOP1QRS', phone: '+254756789012', nationalId: '678901234', limit: 16000, fee: 450,  status: 'failed',  ts: new Date(Date.now() - 5400000).toISOString() },
];

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

// ── Middleware ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fulizaboost-super-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

// ── Auth middleware for admin ──
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.redirect('/admin/login');
}

// ── PUBLIC ROUTES ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Block any /admin attempt from hitting static files
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── ADMIN AUTH ROUTES ──
app.get('/admin/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
});

app.post('/admin/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ── PUBLIC API ──

// Initiate STK Push (Lipana Technologies integration point)
app.post('/api/stk-push', async (req, res) => {
  const { phone, nationalId, limitAmount, fee } = req.body;

  // Validate
  if (!phone || !nationalId || !limitAmount || !fee) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }
  if (nationalId.replace(/\D/g, '').length < 7 || nationalId.replace(/\D/g, '').length > 9) {
    return res.status(400).json({ success: false, message: 'Invalid National ID (7–9 digits)' });
  }
  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length < 9) {
    return res.status(400).json({ success: false, message: 'Invalid phone number' });
  }

  const txnId = 'TXN' + uuidv4().replace(/-/g,'').substring(0,8).toUpperCase();
  const fullPhone = cleanPhone.startsWith('254') ? '+' + cleanPhone : '+254' + cleanPhone.replace(/^0/, '');

  const txn = {
    id: txnId,
    phone: fullPhone,
    nationalId,
    limit: parseInt(limitAmount),
    fee: parseInt(fee),
    status: 'pending',
    ts: new Date().toISOString()
  };

  transactions.unshift(txn);

  // ── Lipana Technologies STK Push ──
  // Uncomment and configure when you have your Lipana API credentials:
  /*
  try {
    const lipanaRes = await fetch('https://api.lipana.co.ke/v1/stk-push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.LIPANA_API_KEY}`
      },
      body: JSON.stringify({
        phone: fullPhone,
        amount: parseInt(fee),
        accountReference: txnId,
        transactionDesc: `FulizaBoost - Ksh ${limitAmount} limit unlock`,
        callbackUrl: `${process.env.BASE_URL}/api/mpesa-callback`
      })
    });
    const lipanaData = await lipanaRes.json();
    if (!lipanaData.success) throw new Error(lipanaData.message);
  } catch (err) {
    transactions[0].status = 'failed';
    return res.status(500).json({ success: false, message: 'STK Push failed: ' + err.message });
  }
  */

  res.json({ success: true, transactionId: txnId, message: 'STK push sent successfully' });
});

// M-Pesa callback from Lipana Technologies
app.post('/api/mpesa-callback', (req, res) => {
  const { transactionId, status, mpesaCode } = req.body;
  const txn = transactions.find(t => t.id === transactionId);
  if (txn) {
    txn.status = status === 'success' ? 'success' : 'failed';
    txn.mpesaCode = mpesaCode || null;
  }
  res.json({ success: true });
});

// Poll transaction status
app.get('/api/transaction/:id', (req, res) => {
  const txn = transactions.find(t => t.id === req.params.id);
  if (!txn) return res.status(404).json({ success: false, message: 'Transaction not found' });
  res.json({ success: true, transaction: txn });
});

// Confirm payment (user confirms on frontend)
app.post('/api/confirm-payment', (req, res) => {
  const { transactionId } = req.body;
  const txn = transactions.find(t => t.id === transactionId);
  if (!txn) return res.status(404).json({ success: false, message: 'Transaction not found' });
  txn.status = 'success';
  res.json({ success: true, transaction: txn });
});

// ── ADMIN API (protected) ──
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const success = transactions.filter(t => t.status === 'success');
  const revenue = success.reduce((a, t) => a + t.fee, 0);
  res.json({
    total: transactions.length,
    success: success.length,
    pending: transactions.filter(t => t.status === 'pending').length,
    failed: transactions.filter(t => t.status === 'failed').length,
    revenue
  });
});

app.get('/api/admin/transactions', requireAdmin, (req, res) => {
  const { q, status, page = 1, limit = 50 } = req.query;
  let data = [...transactions];
  if (q) data = data.filter(t => t.phone.includes(q) || t.nationalId.includes(q) || t.id.includes(q));
  if (status) data = data.filter(t => t.status === status);
  const start = (page - 1) * limit;
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

// ── Catch-all: block direct file access to admin.html ──
app.use((req, res, next) => {
  if (req.path === '/admin.html') return res.redirect('/admin');
  next();
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`FulizaBoost running on port ${PORT}`);
});
