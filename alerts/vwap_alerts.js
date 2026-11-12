// Telegram entry + exit alerts for VWAP 2-Band Reversion v4 on ETH / XRP only (BTC + SOL removed 2026-11-11) (OKX USDT perps, 1H candles).
// Same rules and defaults as OKX Backtest Engine/vwap_2band_backtest.js (trades checked against it):
//   entry at a 1H close: previous candle touched a daily-VWAP 2.5 sd band, this candle closes back inside it in the direction of VWAP,
//   ADX(14,14) < 25, band width >= 2 x ATR(14). Stop = extreme of the 2 candles + 0.75 x ATR. Target = 2R.
// Checks every minute: entries at each new closed candle, stop / target inside the running candle, so an exit alert comes within ~1 minute.
// The open position lives in vwap_alerts_state.json (kept on the `vwap-state` branch). First run starts flat and sends nothing old.
//   node vwap_alerts.js --dry        one scan, print what would be sent (no Telegram needed)
//   node vwap_alerts.js --loop 340   scan every minute for 340 minutes (what the workflow runs)
//   node vwap_alerts.js --status     send the overview (open trades + results so far)
//   node vwap_alerts.js --test       send one test message
// Needs env VWAP_BOT_TOKEN + VWAP_CHAT_ID (GitHub repo secrets, own bot). Nothing secret lives in this file.
const fs = require('fs');

const API = 'https://www.okx.com/api/v5';
const STATE_FILE = process.env.STATE_FILE || 'vwap_alerts_state.json';
const COINS = ['ETH', 'XRP'];
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const P = { adxLen: 14, adxSmooth: 14, maxAdx: 25, stdevMult: 2.5, atrLen: 14, minBandWidthAtr: 2, atrBufferMult: 0.75, rMultiple: 2 };
const HOUR = 3600e3, RISK_PCT = 1, ACCOUNT = 10000;

// ---------- indicators (copied from vwap_2band_backtest.js so the signals match the backtest) ----------
function rma(src, len) {
  const n = src.length, out = new Array(n).fill(NaN);
  const start = src.findIndex(v => !isNaN(v)); if (start < 0) return out;
  let sum = 0;
  for (let i = start; i < n; i++) {
    const k = i - start;
    if (k < len) { sum += src[i]; if (k === len - 1) out[i] = sum / len; } else out[i] = (out[i - 1] * (len - 1) + src[i]) / len;
  }
  return out;
}
function indicators(rows) {
  const n = rows.length, high = rows.map(r => r.h), low = rows.map(r => r.l), close = rows.map(r => r.c);
  const tr = new Array(n).fill(0); tr[0] = high[0] - low[0];
  for (let i = 1; i < n; i++) tr[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  const atr = rma(tr, P.atrLen), plusDM = new Array(n).fill(0), minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = high[i] - high[i - 1], down = low[i - 1] - low[i];
    plusDM[i] = (up > down && up > 0) ? up : 0; minusDM[i] = (down > up && down > 0) ? down : 0;
  }
  const smP = rma(plusDM, P.adxLen), smM = rma(minusDM, P.adxLen), atrA = rma(tr, P.adxLen), dx = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (isNaN(atrA[i]) || atrA[i] === 0) continue;
    const a = 100 * smP[i] / atrA[i], b = 100 * smM[i] / atrA[i], s = a + b;
    dx[i] = s === 0 ? 0 : 100 * Math.abs(a - b) / s;
  }
  const adx = rma(dx, P.adxSmooth), vwap = new Array(n).fill(NaN), upperBand = new Array(n).fill(NaN), lowerBand = new Array(n).fill(NaN);
  let pv = 0, v = 0, pv2 = 0, cur = null;
  for (let i = 0; i < n; i++) {
    const d = new Date(rows[i].t), day = d.getUTCDate() + '-' + d.getUTCMonth();
    if (day !== cur) { pv = 0; v = 0; pv2 = 0; cur = day; }
    const hlc3 = (rows[i].h + rows[i].l + rows[i].c) / 3; pv += rows[i].v * hlc3; v += rows[i].v; pv2 += rows[i].v * hlc3 * hlc3;
    const m = v > 0 ? pv / v : hlc3, sd = Math.sqrt(v > 0 ? Math.max(pv2 / v - m * m, 0) : 0);
    vwap[i] = m; upperBand[i] = m + P.stdevMult * sd; lowerBand[i] = m - P.stdevMult * sd;
  }
  return { atr, adx, vwap, upperBand, lowerBand };
}
// Exit check for one candle: stop first if both are inside it (same convention as the backtest)
function exitOf(pos, h, l) {
  if (pos.dir === 'long') { if (l <= pos.stop) return { px: pos.stop, why: 'stop' }; if (h >= pos.tp) return { px: pos.tp, why: 'target' }; }
  else { if (h >= pos.stop) return { px: pos.stop, why: 'stop' }; if (l <= pos.tp) return { px: pos.tp, why: 'target' }; }
  return null;
}
// Entry check at the close of candle i
function entryOf(rows, ind, i) {
  const b = rows[i], p = rows[i - 1], { atr, adx, upperBand, lowerBand } = ind;
  if (!(atr[i] > 0 && upperBand[i] - lowerBand[i] >= P.minBandWidthAtr * atr[i]) || !(adx[i] < P.maxAdx)) return null;
  const long = p.l <= lowerBand[i - 1] && b.c > lowerBand[i] && b.c > b.o, short = p.h >= upperBand[i - 1] && b.c < upperBand[i] && b.c < b.o;
  if (long) { const stop = Math.min(p.l, b.l) - atr[i] * P.atrBufferMult, risk = b.c - stop; if (risk > 0) return { dir: 'long', t: b.t, entry: b.c, stop, tp: b.c + risk * P.rMultiple, risk, adx: adx[i] }; }
  else if (short) { const stop = Math.max(p.h, b.h) + atr[i] * P.atrBufferMult, risk = stop - b.c; if (risk > 0) return { dir: 'short', t: b.t, entry: b.c, stop, tp: b.c - risk * P.rMultiple, risk, adx: adx[i] }; }
  return null;
}

// ---------- data ----------
async function candles(coin) {
  const r = await fetch(`${API}/market/candles?instId=${coin}-USDT-SWAP&bar=1H&limit=300`);
  const j = await r.json();
  if (j.code !== '0') throw new Error(`OKX ${coin}: ${j.code} ${j.msg}`);
  const rows = j.data.slice().reverse().map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[6], closed: x[8] === '1' }));
  return { closed: rows.filter(x => x.closed), live: rows.find(x => !x.closed) || null };
}

// ---------- formatting ----------
const px = v => v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : v >= 10 ? v.toFixed(2) : v.toFixed(4);
const pct = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const utc = t => new Date(t).toISOString().slice(5, 16).replace('T', ' ') + ' UTC';
const hrs = ms => { const h = Math.round(ms / HOUR); return h < 48 ? `${h}h` : `${(h / 24).toFixed(1)}d`; };
function entryMsg(coin, p, nowPx, late) {
  const stopPct = 100 * p.risk / p.entry, size = (ACCOUNT * RISK_PCT / 100) / (stopPct / 100), long = p.dir === 'long';
  const lines = [
    `${long ? '🟢' : '🔴'} <b>VWAP ${long ? 'LONG' : 'SHORT'} · ${coin}</b>  (1H)`,
    `Candle closed ${utc(p.t + HOUR)}.`, ``,
    `<b>Entry:</b> ${long ? 'buy' : 'sell'} at market (close was $${px(p.entry)})`,
    `<b>Stop:</b> $${px(p.stop)} (${stopPct.toFixed(2)}% away). Put it on the exchange.`,
    `<b>Target:</b> $${px(p.tp)} (2R). Don't exit early.`,
    `<b>Size:</b> at ${RISK_PCT}% risk on a $${ACCOUNT.toLocaleString('en-US')} account: $${Math.round(size).toLocaleString('en-US')} position.`,
    `<b>ADX:</b> ${p.adx.toFixed(1)}`,
  ];
  if (late) lines.push(``, `⚠️ <b>Late alert.</b> Price is now $${px(nowPx)}. Skip it if price has moved far from the entry.`);
  return lines.join('\n');
}
function exitMsg(coin, p, x, t) {
  const R = (p.dir === 'long' ? x.px - p.entry : p.entry - x.px) / p.risk, move = 100 * (p.dir === 'long' ? x.px / p.entry - 1 : 1 - x.px / p.entry);
  return [
    `${x.why === 'target' ? '✅' : '❌'} <b>VWAP ${x.why === 'target' ? 'TARGET HIT' : 'STOPPED OUT'} · ${coin}</b>`, ``,
    `<b>${p.dir === 'long' ? 'Long' : 'Short'}:</b> $${px(p.entry)} → $${px(x.px)}`,
    `<b>Result:</b> ${R >= 0 ? '+' : ''}${R.toFixed(1)}R (${pct(move)} before fees), held ${hrs(t - p.t)}`,
    `If the exchange order filled, you're out. Check it, and cancel the other order.`,
  ].join('\n');
}
// ---------- 2-week overview ----------
// Backtest reference: ETH + XRP 1H, 2022-11 -> 2026-11, 920 trades, same rules, costs 0.05% fee + 0.03% slippage per side
// (computed with OKX Backtest Engine/vwap_2band_backtest.js on data/top200, 2026-11-12).
const BT = { n: 920, win: 40.1, grossR: 0.20, netR: 0.10, pfNet: 1.15, per14d: 8.8, maxDDR: 33.5, maxStreak: 11 };
const COST_PCT = 0.16, KILL_R = 1.5 * BT.maxDDR, PERIOD = 14 * 86400e3;
const stopPctOf = x => x.stopPct || (x.R ? 100 * Math.abs(x.exit - x.entry) / (Math.abs(x.R) * x.entry) : NaN);
const costR = x => { const sp = stopPctOf(x); return sp > 0 ? COST_PCT / sp : 0; };
const netR = x => x.R - costR(x);
const sR = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + 'R';
const day = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
// 5-95% range of the win count for n trades at the backtest win rate (binomial)
function winRange(n, p = BT.win / 100) {
  let cdf = 0, lo = 0, hi = n; const pmf = k => { let c = 1; for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1); return c * p ** k * (1 - p) ** (n - k); };
  for (let k = 0; k <= n; k++) { const prev = cdf; cdf += pmf(k); if (prev < 0.05 && cdf >= 0.05) lo = k; if (prev < 0.95 && cdf >= 0.95) { hi = k; break; } }
  return [lo, hi];
}
function riskOf(L) { // drawdown + streaks in net R, in time order
  let eq = 0, pk = 0, dd = 0, cur = 0, streak = 0;
  for (const x of L) { eq += netR(x); pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); streak = netR(x) < 0 ? streak + 1 : 0; }
  cur = pk - eq; return { dd, cur, streak };
}
function block(L) {
  const n = L.length, w = L.filter(x => x.why === 'target').length, tot = L.reduce((a, x) => a + netR(x), 0);
  return { n, w, win: n ? `${Math.round(100 * w / n)}%` : '–', tot: n ? sR(tot) : '–', per: n ? sR(tot / n) : '–',
    ls: `${L.filter(x => x.dir === 'long').length}L / ${L.filter(x => x.dir === 'short').length}S` };
}
function statusMsg(s, last) {
  const now = Date.now(), since = now - PERIOD;
  const L = s.log.filter(x => COINS.includes(x.coin)), old = s.log.filter(x => !COINS.includes(x.coin));
  const P = L.filter(x => x.t1 >= since), a = block(P), b = block(L);
  const lines = [`📋 <b>VWAP 2-Band · 2-week overview</b>`, `${COINS.join(' / ')} · 1H · ${day(since)} – ${day(now)}`, ``, `<b>━━ OPEN TRADES ━━</b>`];
  for (const c of COINS) {
    const p = s.pos[c], n = last[c];
    if (!p) { lines.push(`⚪ ${c}  flat, waiting for a signal`); continue; }
    const long = p.dir === 'long', ur = n ? (long ? n - p.entry : p.entry - n) / p.risk : NaN;
    const toStop = n ? 100 * (p.stop / n - 1) : NaN, toTp = n ? 100 * (p.tp / n - 1) : NaN;
    lines.push(`${long ? '🟢' : '🔴'} <b>${c} ${p.dir.toUpperCase()}</b>  $${px(p.entry)} → now ${n ? '$' + px(n) : '?'}`,
      `   ${isNaN(ur) ? '?' : sR(ur)} open · running ${hrs(now - (p.t + HOUR))}`,
      `   stop $${px(p.stop)} (${isNaN(toStop) ? '?' : pct(toStop)}) · target $${px(p.tp)} (${isNaN(toTp) ? '?' : pct(toTp)})`);
  }
  const row = (k, x, y) => k.padEnd(13) + String(x).padStart(8) + String(y).padStart(13);
  lines.push(``, `<b>━━ RESULTS (after fees) ━━</b>`, `<pre>` + [row('', '14 days', 'since start'), row('Trades', a.n, b.n), row('Win rate', a.win, b.win),
    row('Total R', a.tot, b.tot), row('Per trade', a.per, b.per), row('Long / short', a.ls, b.ls)].join('\n') + `</pre>`);
  lines.push(``, `Per coin (since start)`);
  for (const c of COINS) { const q = block(L.filter(x => x.coin === c)); lines.push(`${c}  ${q.n} trade${q.n === 1 ? '' : 's'} · ${q.w} win${q.w === 1 ? '' : 's'} · ${q.tot}`); }
  if (old.length) { const by = [...new Set(old.map(x => x.coin))].map(c => `${c} ${old.filter(x => x.coin === c).length}`).join(' · ');
    lines.push(`<i>(old coins, removed Nov 11: ${by} → ${sR(old.reduce((q, x) => q + netR(x), 0))})</i>`); }

  const [lo, hi] = winRange(b.n), low = b.n && b.w < lo;
  lines.push(``, `<b>━━ LIVE vs BACKTEST ━━</b>`,
    `Backtest: ${BT.win}% win · ${sR(BT.netR)}/trade after fees · PF ${BT.pfNet}`, `          ~${Math.round(BT.per14d)} trades per 2 weeks`,
    b.n ? `Live after ${b.n} trades: ${b.win} win, ${b.per}/trade` : `Live: no closed trades yet`);
  if (b.n) lines.push(`Normal range at ${b.n} trades: ${Math.round(100 * lo / b.n)}–${Math.round(100 * hi / b.n)}% win`,
    low ? `⚠️ Win rate below the normal range` : b.n < 20 ? `✅ Within expectations (too few trades to judge)` : `✅ Within expectations`);

  const r = riskOf(L), used = Math.min(100, Math.round(100 * r.cur / KILL_R)), bar = '▓'.repeat(Math.round(used / 10)) + '░'.repeat(10 - Math.round(used / 10));
  lines.push(``, `<b>━━ RISK ━━</b>`, `Current losing streak: ${r.streak} (backtest longest: ${BT.maxStreak})`,
    `Max live DD: −${r.dd.toFixed(1)}R`,
    `Kill switch at −${KILL_R.toFixed(0)}R: ${used}% used`, bar);
  if (r.cur >= KILL_R) lines.push(`🛑 <b>Kill switch hit.</b> Stop following this strategy.`);

  const ent = P.length + COINS.filter(c => s.pos[c] && s.pos[c].t >= since).length, late = (s.late || []).filter(t => t >= since).length;
  const avgCost = L.length ? L.reduce((q, x) => q + costR(x), 0) / L.length : 0, avgStop = L.length ? L.reduce((q, x) => q + stopPctOf(x), 0) / L.length : 0;
  lines.push(``, `<b>━━ EXECUTION ━━</b>`, `Alerts (14 days): ${ent} entr${ent === 1 ? 'y' : 'ies'}, ${late} late (>15 min)`,
    L.length ? `Fees: ${COST_PCT}% per trade, avg stop ${avgStop.toFixed(2)}% → ${avgCost.toFixed(2)}R per trade` : `Fees: ${COST_PCT}% per trade (fee + slippage)`,
    ``, `ℹ️ Watch-only strategy. Do not trade live.`);
  return lines.join('\n');
}

// ---------- Telegram ----------
// replyTo = Telegram message id of the entry alert, so the exit shows up as a reply to it. Returns the id of the message sent.
async function send(html, replyTo) {
  if (DRY) { console.log('\n' + (replyTo ? '[reply to entry alert] ' : '') + html.replace(/<\/?(b|i|pre)>/g, '')); return null; }
  const { VWAP_BOT_TOKEN: tok, VWAP_CHAT_ID: chat } = process.env;
  if (!tok || !chat) throw new Error('VWAP_BOT_TOKEN / VWAP_CHAT_ID not set');
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) }) });
  const j = await r.json();
  if (!j.ok) throw new Error('Telegram: ' + j.description);
  return j.result.message_id;
}
async function flush(s) { // a message that fails stays in the outbox and is retried on the next scan
  while (s.outbox.length) {
    const m = s.outbox[0];
    try { const id = await send(m.html, m.replyKey ? s.msgIds[m.replyKey] : null); if (m.key) s.msgIds[m.key] = id; if (m.replyKey) delete s.msgIds[m.replyKey]; s.outbox.shift(); }
    catch (e) { console.log('send failed, will retry:', e.message); return; }
  }
}

// ---------- state ----------
function load() {
  let s = {}; try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {}
  return { lastBar: s.lastBar || {}, pos: s.pos || {}, log: s.log || [], outbox: s.outbox || [], msgIds: s.msgIds || {}, lastStatus: s.lastStatus || 0, late: s.late || [], killSent: s.killSent || false };
}
const save = s => { if (!DRY) fs.writeFileSync(STATE_FILE, JSON.stringify(s)); };
function close(s, coin, x, t) {
  const p = s.pos[coin]; s.outbox.push({ html: exitMsg(coin, p, x, t), replyKey: coin + ':' + p.t });
  s.log.push({ coin, dir: p.dir, t0: p.t, t1: t, entry: p.entry, exit: x.px, why: x.why, stopPct: +(100 * p.risk / p.entry).toFixed(4), R: +((p.dir === 'long' ? x.px - p.entry : p.entry - x.px) / p.risk).toFixed(2) });
  s.log = s.log.slice(-2000); s.pos[coin] = null;
}

// ---------- one scan ----------
async function scan(s) {
  const last = {};
  for (const coin of COINS) {
    const { closed, live } = await candles(coin), n = closed.length;
    if (n < 100) throw new Error(`${coin}: only ${n} candles`);
    last[coin] = live ? live.c : closed[n - 1].c;
    if (s.lastBar[coin] == null) { s.lastBar[coin] = closed[n - 1].t; s.pos[coin] = null; continue; }   // first run: start flat, send nothing old
    const ind = indicators(closed);
    for (let i = 1; i < n; i++) {
      const b = closed[i]; if (b.t <= s.lastBar[coin]) continue;
      s.lastBar[coin] = b.t;
      if (s.pos[coin]) { const x = exitOf(s.pos[coin], b.h, b.l); if (x) close(s, coin, x, b.t + HOUR); }
      if (!s.pos[coin]) {
        const e = entryOf(closed, ind, i);
        if (e) {
          const late = Date.now() - (e.t + HOUR) > 15 * 60e3;
          if (late) s.late = [...(s.late || []), e.t].slice(-200);
          s.pos[coin] = e; s.outbox.push({ html: entryMsg(coin, e, last[coin], late), key: coin + ':' + e.t });
        }
      }
    }
    // stop / target inside the running candle, so the exit alert does not wait for the close
    if (s.pos[coin] && live && live.t > s.pos[coin].t) { const x = exitOf(s.pos[coin], live.h, live.l); if (x) close(s, coin, x, Date.now()); }
  }
  // kill switch: one alert as soon as the live drawdown (ETH/XRP, net R) reaches 1.5x the backtest max DD
  const dd = riskOf(s.log.filter(x => COINS.includes(x.coin))).cur;
  if (dd >= KILL_R && !s.killSent) { s.outbox.push({ html: `🛑 <b>VWAP KILL SWITCH HIT</b>\n\nLive drawdown −${dd.toFixed(1)}R ≥ −${KILL_R.toFixed(0)}R (1.5× backtest max DD of −${BT.maxDDR}R).\nStop following this strategy.` }); s.killSent = true; }
  await flush(s); save(s);
  return last;
}

async function main() {
  const s = load();
  if (args.includes('--test')) { await send(`🔔 <b>VWAP alerts test</b>\nThe bot works. Entry and exit alerts for ETH and XRP (1H) will come here.`); return; }
  if (args.includes('--status')) { const last = await scan(s); await send(statusMsg(s, last)); s.lastStatus = Date.now(); save(s); return; }
  const li = args.indexOf('--loop'), mins = li >= 0 ? +args[li + 1] || 30 : 0;
  if (!mins) { const last = await scan(s); if (DRY) console.log(statusMsg(s, last).replace(/<\/?(b|i|pre)>/g, '')); return; }
  const end = Date.now() + mins * 60e3;
  while (Date.now() < end) {
    try { await scan(s); } catch (e) { console.log('scan failed:', e.message); }
    await new Promise(r => setTimeout(r, 60e3));
  }
  save(s);
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { indicators, entryOf, exitOf, rma, flush };
