// Wintermute on Hyperliquid: Telegram alert when the book adds or cuts a BIG long/short, plus a forward test + history log.
// Wallet 0xecb63caa47c7c4e77f60f1ce858cf28dc2b82b00 = the address Arkham / Onchain Lens label as Wintermute (not confirmed by Wintermute).
// CAUTION: this is a market maker. Most shorts are probably hedges of tokens they hold elsewhere (they're short ~80 alts at once),
// so a big short is NOT automatically a bearish view. The signal is untested -> every alert is logged and scored 4h/24h/72h later.
//
// How it works (Hyperliquid public API, no key):
//   every scan: read open positions -> compare each coin with the snapshot ~1h and ~4h ago, valued at today's price
//   (so price moves don't count, only real buying/selling) -> alert when the change is big.
//   BIG = change >= $10M on BTC/ETH, >= $5M on SOL/HYPE, >= $2M on anything else, or a flip long<->short of that size.
//
//   node wintermute_alerts.js --dry        one scan, print what would be sent (no Telegram)
//   node wintermute_alerts.js --loop 340   scan every 5 min for 340 min (what the workflow runs)
//   node wintermute_alerts.js --status     send the current book (top positions) + forward-test score
//   node wintermute_alerts.js --test       send one test message
// Telegram: own bot, env WM_BOT_TOKEN + WM_CHAT_ID (GitHub secrets). Not set = log only (history + forward test still run).
// State (snapshots, cooldowns, alert log) in wintermute_state.json; hourly position history in wintermute_history.jsonl.
const fs = require('fs');

const ADDR = '0xecb63caa47c7c4e77f60f1ce858cf28dc2b82b00';
const INFO = 'https://api.hyperliquid.xyz/info';
const STATE_FILE = process.env.STATE_FILE || 'wintermute_state.json';
const HIST_FILE = process.env.HIST_FILE || 'wintermute_history.jsonl';
const BIG = { BTC: 10e6, ETH: 10e6, SOL: 5e6, HYPE: 5e6 }, BIG_OTHER = 2e6;
const WINDOWS = [{ h: 1, label: '1h' }, { h: 4, label: '4h' }];
const COOLDOWN_H = 6;           // same coin + same direction: quiet for 6h unless the move doubles
const HORIZONS = [4, 24, 72];   // forward test: price move in the alert's direction after N hours
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const H = 3600e3, sleep = ms => new Promise(r => setTimeout(r, ms));
const big = c => BIG[c] || BIG_OTHER;

async function post(body, tries = 4) {
  for (let k = 1; ; k++) {
    try {
      const r = await fetch(INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (k >= tries) throw e; await sleep(2000 * k); }
  }
}

async function book() {
  const j = await post({ type: 'clearinghouseState', user: ADDR });
  const pos = {};
  for (const { position: p } of j.assetPositions) {
    const sz = +p.szi; if (!sz) continue;
    pos[p.coin] = [sz, +p.positionValue / Math.abs(sz)];   // [signed size, mark price]
  }
  return { t: Date.now(), acct: +j.marginSummary.accountValue, pos };
}

// ---------- formatting ----------
const usd = v => { const a = Math.abs(v), s = v < 0 ? '−' : ''; return a >= 1e6 ? `${s}$${(a / 1e6).toFixed(1)}M` : `${s}$${(a / 1e3).toFixed(0)}k`; };
const sgn = v => (v >= 0 ? '+' : '−') + usd(Math.abs(v)).replace('−', '');
const px = v => v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v >= 1 ? v.toFixed(2) : v.toPrecision(3);
const side = n => Math.abs(n) < 1 ? 'flat' : (n > 0 ? 'LONG ' : 'SHORT ') + usd(Math.abs(n));
const pct = v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%';

// ---------- signal ----------
function snapAt(snaps, t) { let best = null; for (const s of snaps) if (s.t <= t) best = s; return best; }

function detect(now, state) {
  const out = [];
  for (const w of WINDOWS) {
    const then = snapAt(state.snaps, now.t - w.h * H + 2 * 60e3);
    if (!then || now.t - then.t > w.h * H * 1.5) continue;           // no snapshot that old yet (or a big gap)
    const coins = new Set([...Object.keys(now.pos), ...Object.keys(then.pos)]);
    for (const c of coins) {
      const p = (now.pos[c] || then.pos[c])[1];
      const sNow = now.pos[c] ? now.pos[c][0] : 0, sThen = then.pos[c] ? then.pos[c][0] : 0;
      const nNow = sNow * p, nThen = sThen * p, d = nNow - nThen;     // both valued at today's price
      const flip = Math.sign(nNow) !== Math.sign(nThen) && Math.abs(nNow) >= big(c) / 2 && Math.abs(nThen) >= big(c) / 2;
      if (Math.abs(d) < big(c) && !flip) continue;
      out.push({ coin: c, win: w.label, d, nNow, nThen, p, flip, dir: d > 0 ? 'BUY' : 'SELL' });
    }
  }
  // one alert per coin: keep the biggest change
  const by = {};
  for (const a of out) if (!by[a.coin] || Math.abs(a.d) > Math.abs(by[a.coin].d)) by[a.coin] = a;
  return Object.values(by).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
}

function alertText(a) {
  const what = a.flip ? `FLIPPED ${a.nNow > 0 ? 'to LONG' : 'to SHORT'}`
    : a.d > 0 ? (a.nThen < 0 ? 'covered short / bought' : 'added LONG') : (a.nThen > 0 ? 'sold long / went short' : 'added SHORT');
  return `${a.d > 0 ? '🟢' : '🔴'} <b>Wintermute ${a.dir} ${a.coin}</b> (Hyperliquid)\n` +
    `${what}: <b>${sgn(a.d)}</b> in ${a.win}\n` +
    `Position: ${side(a.nThen)} → <b>${side(a.nNow)}</b>\n` +
    `${a.coin} price: ${px(a.p)}\n` +
    `<i>Market-maker flow, often a hedge. Signal untested, logged for the forward test.</i>`;
}

// ---------- forward test ----------
function score(state, mids) {
  const now = Date.now();
  for (const a of state.log) {
    a.r = a.r || {};
    for (const h of HORIZONS) {
      if (a.r[h] !== undefined || now - a.t < h * H || !mids[a.coin]) continue;
      if (now - a.t > (h + 6) * H) { a.r[h] = null; continue; }      // missed the window (runner was down): don't fake it
      a.r[h] = (a.dir === 'BUY' ? 1 : -1) * (+mids[a.coin] / a.p - 1) * 100;
    }
  }
}
function scoreText(state) {
  const lines = [];
  for (const h of HORIZONS) {
    const v = state.log.map(a => a.r && a.r[h]).filter(x => typeof x === 'number');
    if (!v.length) { lines.push(`${h}h: no results yet`); continue; }
    const avg = v.reduce((s, x) => s + x, 0) / v.length, win = v.filter(x => x > 0).length / v.length * 100;
    lines.push(`${h}h: n=${v.length}, avg ${pct(avg)} in alert direction, ${win.toFixed(0)}% right`);
  }
  return lines.join('\n');
}

// ---------- telegram ----------
async function send(html) {
  const tok = process.env.WM_BOT_TOKEN, chat = process.env.WM_CHAT_ID;
  if (DRY || !tok || !chat) { console.log('--- (dry) ---\n' + html.replace(/<[^>]+>/g, '') + '\n'); return; }
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) console.error('Telegram error', r.status, await r.text());
}

// ---------- state ----------
function load() {
  let s = {}; try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {}
  return { snaps: s.snaps || [], cool: s.cool || {}, log: s.log || [], lastHist: s.lastHist || 0, lastStatus: s.lastStatus || 0 };
}
function save(state) { if (!DRY) fs.writeFileSync(STATE_FILE, JSON.stringify(state)); }
function keepSnaps(snaps, now) {
  // every 5 min for the last 5h, roughly hourly back to 26h
  const out = []; let lastKept = -Infinity;
  for (const s of snaps) {
    const age = now - s.t; if (age > 26 * H) continue;
    const gap = age <= 5 * H ? 4 * 60e3 : 55 * 60e3;
    if (s.t - lastKept >= gap || age <= 5 * H) { out.push(s); lastKept = s.t; }
  }
  return out;
}

async function scan(state) {
  const now = await book();
  const mids = await post({ type: 'allMids' });
  score(state, mids);
  const alerts = detect(now, state);
  for (const a of alerts) {
    const key = a.coin + ':' + a.dir, c = state.cool[key];
    if (c && now.t - c.t < COOLDOWN_H * H && Math.abs(a.d) < 2 * Math.abs(c.d)) continue;
    state.cool[key] = { t: now.t, d: a.d };
    state.log.push({ t: now.t, coin: a.coin, dir: a.dir, d: Math.round(a.d), nNow: Math.round(a.nNow), p: a.p, win: a.win, flip: a.flip });
    await send(alertText(a));
  }
  state.snaps = keepSnaps([...state.snaps, now], now.t);
  for (const k of Object.keys(state.cool)) if (now.t - state.cool[k].t > 48 * H) delete state.cool[k];
  state.log = state.log.slice(-1000);
  // hourly history (positions >= $50k) so a proper event study can be done in a few months
  if (now.t - state.lastHist >= 55 * 60e3 && !DRY) {
    const pos = {}; for (const [c, [sz, p]] of Object.entries(now.pos)) if (Math.abs(sz * p) >= 5e4) pos[c] = [sz, p];
    fs.appendFileSync(HIST_FILE, JSON.stringify({ t: now.t, acct: Math.round(now.acct), pos }) + '\n');
    state.lastHist = now.t;
  }
  save(state);
  const net = Object.values(now.pos).reduce((s, [sz, p]) => s + sz * p, 0);
  console.log(`${new Date(now.t).toISOString()} ${Object.keys(now.pos).length} positions, net ${usd(net)}, ${alerts.length} big change(s)`);
  return now;
}

function statusText(now, state) {
  const rows = Object.entries(now.pos).map(([c, [sz, p]]) => [c, sz * p]).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const long = rows.filter(r => r[1] > 0).reduce((s, r) => s + r[1], 0), short = rows.filter(r => r[1] < 0).reduce((s, r) => s + r[1], 0);
  return `📒 <b>Wintermute Hyperliquid book</b>\nAccount ${usd(now.acct)} · longs ${usd(long)} · shorts ${usd(short)} · net ${usd(long + short)}\n\n` +
    rows.slice(0, 12).map(([c, n]) => `${n > 0 ? '🟢' : '🔴'} ${c} ${side(n)}`).join('\n') +
    `\n\n<b>Forward test of the alerts</b> (${state.log.length} alerts so far)\n${scoreText(state)}`;
}

(async () => {
  const state = load();
  if (args.includes('--test')) { await send('✅ Wintermute alert bot test. Alerts on big Hyperliquid position changes will arrive here.'); return; }
  if (args.includes("--status")) { const now = await scan(state); await send(statusText(now, state)); state.lastStatus = Date.now(); save(state); return; }
  const li = args.indexOf('--loop'), mins = li >= 0 ? +args[li + 1] || 30 : 0;
  if (!mins) { const now = await scan(state); if (DRY) console.log(statusText(now, state).replace(/<[^>]+>/g, '')); return; }
  const end = Date.now() + mins * 60e3;
  while (Date.now() < end) {
    const next = Date.now() + 5 * 60e3;
    try { await scan(state); } catch (e) { console.error('scan failed:', e.message); }
    if (next > end) break;
    await sleep(next - Date.now());
  }
})().catch(e => { console.error(e); process.exit(1); });
