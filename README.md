# FulizaBoost 🚀
**Instant Fuliza Limit Increase Platform** — powered by Lipana Technologies M-Pesa Integration

---

## Project Structure

```
fulizaboost/
├── server.js          ← Express backend (routing + API)
├── package.json
├── .gitignore
├── .env.example       ← Copy to .env for local dev
└── public/
    ├── index.html     ← Landing page (users)
    ├── admin.html     ← Admin dashboard (session-protected)
    └── login.html     ← Admin login page
```

---

## Local Development

```bash
# 1. Clone and install
git clone <your-repo-url>
cd fulizaboost
npm install

# 2. Create .env file
cp .env.example .env
# Edit .env with your values

# 3. Run
npm run dev        # development (nodemon)
npm start          # production
```

Visit `http://localhost:3000`

---

## Deploy to Railway

### Step 1 — Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/fulizaboost.git
git push -u origin main
```

### Step 2 — Create Railway Project
1. Go to [railway.app](https://railway.app) and sign in
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `fulizaboost` repository
4. Railway auto-detects Node.js and deploys

### Step 3 — Set Environment Variables on Railway
In your Railway project → **Variables** tab, add:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | `any-long-random-string-here` |
| `ADMIN_USER` | `admin` |
| `ADMIN_PASS` | `your-secure-password` |
| `LIPANA_API_KEY` | `your-lipana-api-key` |
| `BASE_URL` | `https://your-app.railway.app` |

Railway automatically sets `PORT` — do NOT add it manually.

### Step 4 — Generate Domain
In Railway → **Settings** → **Networking** → **Generate Domain**
You'll get a URL like `https://fulizaboost-production.up.railway.app`

---

## Routes

| Route | Description | Auth |
|---|---|---|
| `GET /` | Landing page | Public |
| `GET /admin/login` | Admin login | Public |
| `POST /admin/login` | Login action | Public |
| `GET /admin` | Admin dashboard | Session required |
| `POST /admin/logout` | Logout | Session |

**Note:** `/admin.html` direct access is blocked and redirected to `/admin`

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/stk-push` | POST | Initiate M-Pesa STK push |
| `/api/confirm-payment` | POST | Confirm payment from user |
| `/api/transaction/:id` | GET | Poll transaction status |
| `/api/mpesa-callback` | POST | Lipana Technologies callback |
| `/api/admin/stats` | GET | Dashboard stats (admin) |
| `/api/admin/transactions` | GET | All transactions (admin) |
| `/api/admin/transactions/:id` | PATCH | Update transaction (admin) |
| `/api/admin/transactions/:id` | DELETE | Delete transaction (admin) |
| `/api/admin/users` | GET | All users (admin) |

---

## Lipana Technologies Integration

Edit `server.js` and uncomment the STK push block inside `/api/stk-push`:

```javascript
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
```

Set `BASE_URL` to your live Railway domain so Lipana can POST payment confirmations back.

---

## Admin Login (Default)

- **URL:** `/admin/login`
- **Username:** `admin`
- **Password:** `admin123`

⚠️ Change these via environment variables before going live!

---

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** Vanilla HTML/CSS/JS
- **Payments:** Lipana Technologies (M-Pesa STK Push)
- **Sessions:** express-session (in-memory; add Redis/DB for production scale)
- **Deploy:** Railway
