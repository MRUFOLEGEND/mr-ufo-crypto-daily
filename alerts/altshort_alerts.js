// Telegram entry + exit alerts for the Alt-Short Basket (OKX USDT perps, 1D UTC candles, 39 coins).
// Same rules as OKX Backtest Engine/alt_short_basket.js with the paper settings (cap 20, 3 ATR stop):
//   SHORT at the daily close when EMA20 < EMA50, RSI14 < 50, high >= EMA20 (rally into the 20 EMA) and close < EMA50.
//   EXIT at the daily close when close > EMA50 or EMA20 crosses above EMA50. Emergency stop = entry close + 3 x ATR14 (intrabar, from the next day).
//   Each short = 5% of the account (1/20), max 20 open; same-day signals are taken weakest-first (lowest 60-day return).
//   A signal skipped because the basket is full still blocks that coin until its exit (exactly like the backtest).
// Runs once an hour: new daily closes -> entries / exits; running daily candle -> stop alerts within the hour.
// State (model positions + closed trades) lives in altshort_alerts_state.json on the `altshort-state` branch.
// First run starts from altshort_seed.json = the model's open shorts from the backtest engine (2026-11-13 close).
//   node altshort_alerts.js --dry      one scan, print what would be sent, save nothing
//   node altshort_alerts.js            one scan (what the workflow runs)
//   node altshort_alerts.js --status   send the 2-week overview
//   node altshort_alerts.js --test     send one test message
// Needs env ALTSHORT_BOT_TOKEN + ALTSHORT_CHAT_ID (GitHub repo secrets, own bot). Nothing secret lives in this file.
const fs = require('fs');

const API = 'https://www.okx.com/api/v5';
const STATE_FILE = process.env.STATE_FILE || 'altshort_alerts_state.json', SEED_FILE = 'altshort_seed.json';
const COINS = ['AAVE', 'ADA', 'ALGO', 'APT', 'ARB', 'ATOM', 'AVAX', 'AXS', 'BCH', 'BNB', 'BTC', 'CRV', 'DOGE', 'DOT', 'ENA', 'ETC', 'ETH', 'FIL', 'HBAR', 'HYPE',
  'INJ', 'LINK', 'LTC', 'NEAR', 'ONDO', 'OP', 'PEPE', 'SAND', 'SHIB', 'SOL', 'SUI', 'TAO', 'TIA', 'TRX', 'UNI', 'WIF', 'WLD', 'XLM', 'XRP'];
const TYPE = c => ['BTC', 'ETH', 'SOL', 'XRP', 'BNB'].includes(c) ? 'Majors' : ['DOGE', 'SHIB', 'PEPE', 'WIF'].includes(c) ? 'Memes' : 'Alts';
const CAP = 20, STOP_ATR = 3, COST_PCT = 0.14, DAY = 86400e3, ACCOUNT = 10000, LATE_MS = 2 * 3600e3, PERIOD = 14 * DAY;
// Backtest reference: alt_short_basket.js cap 20 / stop 3, 39 coins, 2020 -> 2026-11-13, funding included (computed 2026-11-15)
const BT = { n: 1049, win: 32.1, pf: 1.42, avgPct: 1.72, per14d: 6, maxStreak: 48, mddPct: 30.2 };
const KILL_PCT = 1.5 * BT.mddPct;
const args = process.argv.slice(2), DRY = args.includes('--dry');

// ---------- indicators (same as bt_lib.js) ----------
function ema(src, len) {
  const n = src.length, out = new Array(n).fill(NaN), k = 2 / (len + 1); let sum = 0;
  for (let i = 0; i < n; i++) { if (i < len - 1) sum += src[i]; else if (i === len - 1) { sum += src[i]; out[i] = sum / len; } else out[i] = src[i] * k + out[i - 1] * (1 - k); }
  return out;
}
function rma(src, len) {
  const n = src.length, out = new Array(n).fill(NaN), start = src.findIndex(v => !isNaN(v)); if (start < 0) return out; let sum = 0;
  for (let i = start; i < n; i++) { const k = i - start; if (k < len) { sum += src[i]; if (k === len - 1) out[i] = sum / len; } else out[i] = (out[i - 1] * (len - 1) + src[i]) / len; }
  return out;
}
function indicators(rows) {
  const n = rows.length, c = rows.map(r => r.c), tr = new Array(n).fill(0), up = [NaN], dn = [NaN]; tr[0] = rows[0].h - rows[0].l;
  for (let i = 1; i < n; i++) { tr[i] = Math.max(rows[i].h - rows[i].l, Math.abs(rows[i].h - c[i - 1]), Math.abs(rows[i].l - c[i - 1])); const d = c[i] - c[i - 1]; up.push(Math.max(d, 0)); dn.push(Math.max(-d, 0)); }
  const u = rma(up, 14), d = rma(dn, 14);
  return { f: ema(c, 20), s: ema(c, 50), rsi: u.map((x, i) => d[i] === 0 ? 100 : 100 - 100 / (1 + x / d[i])), atr: rma(tr, 14) };
}

// ---------- data ----------
async function candles(coin) {
  const r = await fetch(`${API}/market/candles?instId=${coin}-USDT-SWAP&bar=1Dutc&limit=300`), j = await r.json();
  if (j.code !== '0') throw new Error(`OKX ${coin}: ${j.code} ${j.msg}`);
  const rows = j.data.slice().reverse().map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], closed: x[8] === '1' }));
  return { closed: rows.filter(x => x.closed), live: rows.find(x => !x.closed) || null };
}

// ---------- formatting ----------
const px = v => v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : v >= 10 ? v.toFixed(2) : v >= 0.1 ? v.toFixed(4) : v.toPrecision(4);
const pct = (v, d = 1) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d) + '%';
const day = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const days = ms => `${Math.max(0, Math.floor(ms / DAY))}d`;
const shortRet = (entry, exit) => (1 - exit / entry) * 100 - COST_PCT;           // 1x short return after fees, before funding
const openCount = s => COINS.filter(c => s.virt[c] && s.virt[c].taken).length;

function entryMsg(coin, p, s, nowPx, late) {
  const stopPct = 100 * (p.stop / p.entry - 1), size = ACCOUNT / CAP;
  const lines = [`🔴 <b>ALT-SHORT · ${coin}</b>  (1D)`, `Daily candle closed ${day(p.t + DAY)} 00:00 UTC.`, ``,
    `<b>Entry:</b> sell at market (close was $${px(p.entry)})`,
    `<b>Stop:</b> $${px(p.stop)} (${pct(stopPct)} away, 3× ATR). Put it on the exchange.`,
    `<b>Exit:</b> on a daily close above the EMA50 (now $${px(p.ema50)}) or when EMA20 crosses above EMA50. The bot tells you.`,
    `<b>Size:</b> 5% of the account per short (max 20 = 1× total). On $${ACCOUNT.toLocaleString('en-US')}: $${size}.`,
    `<b>Basket:</b> ${openCount(s)}/${CAP} shorts open · ${TYPE(coin)}`];
  if (late) lines.push(``, `⚠️ <b>Late alert.</b> Price is now $${px(nowPx)} (${pct(100 * (nowPx / p.entry - 1))} vs the close). Skip it if it has moved far.`);
  return lines.join('\n');
}
const WHY = { stop: 'STOPPED OUT', ema50: 'EXIT · close above EMA50', cross: 'EXIT · EMA20 crossed above EMA50' };
function exitMsg(coin, p, x) {
  const r = shortRet(p.entry, x.px);
  return [`${r >= 0 ? '✅' : '❌'} <b>ALT-SHORT ${WHY[x.why]} · ${coin}</b>`, ``,
    `<b>Short:</b> $${px(p.entry)} → $${px(x.px)}`,
    `<b>Result:</b> ${pct(r, 2)} on the position (${pct(r / CAP, 2)} on the account) after fees, held ${days(x.t - p.t)}`,
    x.why === 'stop' ? `If the exchange stop filled, you're out.` : `Buy back at market now and cancel the stop.`,
    ...(p.seeded ? [`<i>(model position from before the bot started)</i>`] : [])].join('\n');
}

// ---------- 2-week overview ----------
function winRange(n, p = BT.win / 100) {
  let cdf = 0, lo = 0, hi = n; const pmf = k => { let c = 1; for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1); return c * p ** k * (1 - p) ** (n - k); };
  for (let k = 0; k <= n; k++) { const prev = cdf; cdf += pmf(k); if (prev < 0.05 && cdf >= 0.05) lo = k; if (prev < 0.95 && cdf >= 0.95) { hi = k; break; } }
  return [lo, hi];
}
function block(L) {
  const n = L.length, w = L.filter(x => x.ret > 0).length, tot = L.reduce((a, x) => a + x.ret, 0);
  return { n, w, win: n ? `${Math.round(100 * w / n)}%` : '–', per: n ? pct(tot / n, 2) : '–', acc: n ? pct(tot / CAP, 2) : '–', stops: L.filter(x => x.why === 'stop').length };
}
function riskOf(s, last) { // account curve (simple sum, % of account) from closed trades + open shorts marked to market
  let eq = 0, pk = 0, dd = 0, streak = 0;
  for (const x of s.log) { eq += x.ret / CAP; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); streak = x.ret <= 0 ? streak + 1 : 0; }
  const open = COINS.filter(c => s.virt[c] && s.virt[c].taken && last[c] && !s.virt[c].seeded).reduce((a, c) => a + shortRet(s.virt[c].entry, last[c]) / CAP, 0);
  const now = eq + open; dd = Math.max(dd, pk - now);
  return { dd, cur: Math.max(0, pk - now), streak, eq, open };
}
function statusMsg(s, last) {
  const now = Date.now(), since = now - PERIOD, L = s.log.filter(x => !x.seeded), P = L.filter(x => x.t1 >= since), a = block(P), b = block(L);
  const lines = [`📋 <b>Alt-Short Basket · 2-week overview</b>`, `${COINS.length} OKX perps · 1D · ${day(since)} – ${day(now)}`, ``,
    `<b>━━ OPEN SHORTS (${openCount(s)}/${CAP}) ━━</b>`];
  const open = COINS.filter(c => s.virt[c] && s.virt[c].taken).map(c => ({ c, p: s.virt[c], r: last[c] ? shortRet(s.virt[c].entry, last[c]) : NaN }))
    .sort((x, y) => (y.r || 0) - (x.r || 0));
  const rowO = o => `${o.c.padEnd(5)}${(isNaN(o.r) ? '?' : pct(o.r)).padStart(8)}${days(now - o.p.t).padStart(5)}  ${last[o.c] ? pct(100 * (o.p.stop / last[o.c] - 1)) : '?'}${o.p.seeded ? ' *' : ''}`;
  if (open.length) lines.push(`<pre>` + [`coin     P&amp;L  held  to stop`, ...open.map(rowO)].join('\n') + `</pre>`);
  else lines.push(`No open shorts.`);
  if (open.some(o => o.p.seeded)) lines.push(`<i>* opened before the bot started, not counted in the results</i>`);
  const ro = riskOf(s, last);
  lines.push(`Open P&amp;L on the account (new shorts only): ${pct(ro.open, 2)} · exposure ${Math.round(100 * openCount(s) / CAP)}% of 1×`);

  const row = (k, x, y) => k.padEnd(14) + String(x).padStart(8) + String(y).padStart(13);
  lines.push(``, `<b>━━ CLOSED (after fees, before funding) ━━</b>`, `<pre>` + [row('', '14 days', 'since start'), row('Trades', a.n, b.n), row('Win rate', a.win, b.win),
    row('Per trade (1×)', a.per, b.per), row('On account', a.acc, b.acc), row('Stopped out', a.stops, b.stops)].join('\n') + `</pre>`);
  lines.push(`Per type (since start)`);
  for (const t of ['Majors', 'Alts', 'Memes']) { const q = block(L.filter(x => TYPE(x.coin) === t)); lines.push(`${t.padEnd(7)} ${q.n} trade${q.n === 1 ? '' : 's'} · ${q.win} win · ${q.per}/trade`); }
  const byCoin = [...new Set(L.map(x => x.coin))].map(c => ({ c, r: L.filter(x => x.coin === c).reduce((q, x) => q + x.ret, 0) })).sort((x, y) => y.r - x.r);
  if (byCoin.length >= 2) lines.push(`Best ${byCoin[0].c} ${pct(byCoin[0].r)} · worst ${byCoin[byCoin.length - 1].c} ${pct(byCoin[byCoin.length - 1].r)}`);

  const [lo, hi] = winRange(b.n), low = b.n && b.w < lo;
  lines.push(``, `<b>━━ LIVE vs BACKTEST ━━</b>`, `Backtest: ${BT.win}% win · ${pct(BT.avgPct, 2)}/trade (1×, incl. funding) · PF ${BT.pf}`,
    `          ~${BT.per14d} closed trades per 2 weeks`, b.n ? `Live after ${b.n} trades: ${b.win} win, ${b.per}/trade` : `Live: no closed trades yet`);
  if (b.n) lines.push(`Normal range at ${b.n} trades: ${Math.round(100 * lo / b.n)}–${Math.round(100 * hi / b.n)}% win`,
    low ? `⚠️ Win rate below the normal range` : b.n < 30 ? `✅ Within expectations (too few trades to judge)` : `✅ Within expectations`);

  const used = Math.min(100, Math.round(100 * ro.cur / KILL_PCT)), k = Math.round(used / 10);
  lines.push(``, `<b>━━ RISK ━━</b>`, `Current losing streak: ${ro.streak} (backtest longest: ${BT.maxStreak})`, `Max live DD: −${ro.dd.toFixed(1)}% of the account`,
    `Kill switch at −${KILL_PCT.toFixed(0)}%: ${used}% used`, '▓'.repeat(k) + '░'.repeat(10 - k));
  if (ro.cur >= KILL_PCT) lines.push(`🛑 <b>Kill switch hit.</b> Stop following this strategy.`);

  const ent = L.filter(x => x.t0 >= since).length + COINS.filter(c => s.virt[c] && s.virt[c].taken && !s.virt[c].seeded && s.virt[c].t >= since).length;
  const late = (s.late || []).filter(t => t >= since).length, skipped = (s.skipped || []).filter(t => t >= since).length;
  lines.push(``, `<b>━━ EXECUTION ━━</b>`, `Alerts (14 days): ${ent} entr${ent === 1 ? 'y' : 'ies'}, ${late} late (>2h)`,
    `Signals skipped (basket full): ${skipped}`, `Fees: ${COST_PCT}% per trade. Funding not counted (a short receives positive funding).`);
  return lines.join('\n');
}

// ---------- Telegram ----------
async function send(html, replyTo) {
  if (DRY) { console.log('\n' + (replyTo ? '[reply to entry alert] ' : '') + html.replace(/<\/?(b|i|pre)>/g, '').replace(/&amp;/g, '&')); return null; }
  const { ALTSHORT_BOT_TOKEN: tok, ALTSHORT_CHAT_ID: chat } = process.env;
  if (!tok || !chat) throw new Error('ALTSHORT_BOT_TOKEN / ALTSHORT_CHAT_ID not set');
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) }) });
  const j = await r.json();
  if (!j.ok) throw new Error('Telegram: ' + j.description);
  return j.result.message_id;
}
async function flush(s) { // a message that fails stays in the outbox and is retried on the next run
  while (s.outbox.length) {
    const m = s.outbox[0];
    try { const id = await send(m.html, m.replyKey ? s.msgIds[m.replyKey] : null); if (m.key) s.msgIds[m.key] = id; if (m.replyKey) delete s.msgIds[m.replyKey]; s.outbox.shift(); }
    catch (e) { console.log('send failed, will retry:', e.message); return; }
  }
}

// ---------- state ----------
function load() {
  let s = null; try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {}
  if (!s || !s.lastBar) { s = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')); s.fromSeed = true; }
  return { lastBar: s.lastBar || {}, virt: s.virt || {}, log: s.log || [], outbox: s.outbox || [], msgIds: s.msgIds || {}, lastStatus: s.lastStatus || 0,
    late: s.late || [], skipped: s.skipped || [], killSent: !!s.killSent, startSent: !!s.startSent, fromSeed: !!s.fromSeed };
}
const save = s => { if (!DRY) { const { fromSeed, ...o } = s; fs.writeFileSync(STATE_FILE, JSON.stringify(o)); } };
function close(s, coin, x) {
  const p = s.virt[coin]; s.virt[coin] = null;
  if (!p.taken) return;
  s.outbox.push({ html: exitMsg(coin, p, x), replyKey: coin + ':' + p.t });
  s.log.push({ coin, t0: p.t, t1: x.t, entry: p.entry, exit: x.px, why: x.why, ret: +shortRet(p.entry, x.px).toFixed(3), ...(p.seeded ? { seeded: true } : {}) });
  s.log = s.log.slice(-3000);
}

// ---------- one scan ----------
async function scan(s) {
  const data = {}, last = {}; let failed = 0;
  for (const coin of COINS) {
    try { const d = await candles(coin); if (d.closed.length < 120) throw new Error(`${coin}: only ${d.closed.length} candles`); data[coin] = { ...d, ind: indicators(d.closed) }; last[coin] = d.live ? d.live.c : d.closed[d.closed.length - 1].c; }
    catch (e) { console.log('fetch failed:', e.message); failed++; }
  }
  // 1) new daily closes, day by day across all coins (only when every coin loaded, so the weakest-first order and the cap stay right)
  if (!failed) {
    const dayset = new Set();
    for (const c of COINS) for (const b of data[c].closed) if (b.t > (s.lastBar[c] || 0)) dayset.add(b.t);
    for (const D of [...dayset].sort((x, y) => x - y)) {
      const cand = [];
      for (const c of COINS) {
        const { closed, ind } = data[c], i = closed.findIndex(b => b.t === D); if (i < 1 || D <= (s.lastBar[c] || 0)) continue;
        const b = closed[i], p = s.virt[c];
        if (p && D > p.t && b.h >= p.stop) close(s, c, { px: Math.max(b.o, p.stop), why: 'stop', t: D });
        const exitSig = b.c > ind.s[i] || (ind.f[i] > ind.s[i] && ind.f[i - 1] <= ind.s[i - 1]);
        if (s.virt[c] && exitSig) close(s, c, { px: b.c, why: b.c > ind.s[i] ? 'ema50' : 'cross', t: D + DAY });
        if (!s.virt[c] && !exitSig && !isNaN(ind.s[i]) && !isNaN(ind.rsi[i]) && ind.f[i] < ind.s[i] && b.c < ind.s[i] && ind.rsi[i] < 50 && b.h >= ind.f[i])
          cand.push({ c, i, mom: i >= 60 ? b.c / closed[i - 60].c - 1 : 0, p: { t: D, entry: b.c, stop: b.c + STOP_ATR * ind.atr[i], ema50: ind.s[i] } });
        s.lastBar[c] = D;
      }
      cand.sort((x, y) => x.mom - y.mom);
      for (const k of cand) {
        const taken = openCount(s) < CAP; s.virt[k.c] = { ...k.p, taken };
        if (!taken) { s.skipped = [...s.skipped, D].slice(-500); continue; }
        const late = Date.now() - (D + DAY) > LATE_MS; if (late) s.late = [...s.late, D].slice(-500);
        s.outbox.push({ html: entryMsg(k.c, k.p, s, last[k.c], late), key: k.c + ':' + D });
      }
    }
  }
  // 2) emergency stop inside the running daily candle, so the stop alert does not wait for the close
  for (const c of COINS) {
    const p = s.virt[c], live = data[c] && data[c].live;
    if (p && p.taken && live && live.t > p.t && live.t > (s.lastBar[c] || 0) && live.h >= p.stop) close(s, c, { px: Math.max(live.o, p.stop), why: 'stop', t: live.t });
  }
  // 3) kill switch: one alert when the live drawdown reaches 1.5x the backtest max DD
  const ro = riskOf(s, last);
  if (ro.cur >= KILL_PCT && !s.killSent) { s.outbox.push({ html: `🛑 <b>ALT-SHORT KILL SWITCH HIT</b>\n\nLive drawdown −${ro.cur.toFixed(1)}% of the account ≥ −${KILL_PCT.toFixed(0)}%.\nStop following this strategy.` }); s.killSent = true; }
  await flush(s); save(s);
  return last;
}
function startMsg(s) {
  const open = COINS.filter(c => s.virt[c] && s.virt[c].taken);
  return [`🚀 <b>Alt-Short Basket bot started</b>`, ``, `Entry and exit alerts for ${COINS.length} OKX perps (1D) come here. Daily signals arrive just after 00:00 UTC, stop alerts within the hour.`, ``,
    `The model already holds <b>${open.length} shorts</b> from before the bot started: ${open.join(', ')}.`,
    `You're not in those. Their exits will still show up here, marked as old. New entries start from ${open.length}/${CAP}.`].join('\n');
}

async function main() {
  const s = load();
  if (args.includes('--test')) { await send(`🔔 <b>Alt-short alerts test</b>\nThe bot works. Entry and exit alerts for the Alt-Short Basket (1D) will come here.`); return; }
  if (s.fromSeed && !s.startSent) { s.outbox.unshift({ html: startMsg(s) }); s.startSent = true; }
  const last = await scan(s);
  if (args.includes('--status')) { await send(statusMsg(s, last)); s.lastStatus = Date.now(); save(s); }
  else if (DRY) console.log('\n--- overview ---\n' + statusMsg(s, last).replace(/<\/?(b|i|pre)>/g, '').replace(/&amp;/g, '&'));
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { indicators, ema, rma, entryMsg, exitMsg };
