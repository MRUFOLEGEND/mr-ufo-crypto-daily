// Telegram alerts for the two Aroon strategies on BTC / ETH / SOL (OKX USDT perps, daily UTC candles).
// Same rules as the backtests (OKX Backtest Engine/qs_ind.js):
//   QS0720  long while Aroon-Up(25) > Aroon-Down(25)  -> BUY on the cross up, SELL on the cross down
//   QS0231  buy when Aroon-Down(14) < 10, sell when Aroon-Down(14) > 50
// Signals happen at the daily close (00:00 UTC). Each run replays the last 300 closed daily candles,
// so it needs no history of its own; a small state file (kept on the `aroon-state` branch) only stops repeat messages.
//   node aroon_alerts.js --dry       print what would be sent (no Telegram needed)
//   node aroon_alerts.js             send new BUY / SELL alerts (what the workflow runs)
//   node aroon_alerts.js --status    send the "where are we" overview (Mondays)
//   node aroon_alerts.js --test      send one test message
// Needs env AROON_BOT_TOKEN + AROON_CHAT_ID (GitHub repo secrets, separate bot from the vol alerts). Nothing secret lives in this file.
const fs = require('fs');

const API = 'https://www.okx.com/api/v5';
const STATE_FILE = process.env.STATE_FILE || 'aroon_alerts_state.json';
const COINS = ['BTC', 'ETH', 'SOL'];
const args = process.argv.slice(2);
const DRY = args.includes('--dry');

// Exit numbers come from qs_aroon_improve.js (2026-10-21): 2xATR safety stop and the 200-day-MA filter
// improved QS0720 both before and after 2024; partial TPs / tight trails hurt (exit lab 2026-10-30).
const STRATS = {
  QS0720: { name: 'Aroon 25 cross', medHold: 21, stopAtr: 2, stopNote: '2×ATR safety stop (tested: helped)' },
  QS0231: { name: 'Aroon 14 dip-buy', medHold: 8, stopAtr: 3, stopNote: '3×ATR disaster stop only (tested: neutral)' },
};

// ---------- indicators (copied from qs_ind.js so the signals match the backtest) ----------
function aroon(H, L, n) {
  const up = new Array(H.length).fill(NaN), dn = up.slice();
  for (let i = n; i < H.length; i++) {
    let hi = -Infinity, hk = 0, lo = Infinity, lk = 0;
    for (let j = 0; j <= n; j++) { if (H[i - j] > hi) { hi = H[i - j]; hk = j; } if (L[i - j] < lo) { lo = L[i - j]; lk = j; } }
    up[i] = 100 * (n - hk) / n; dn[i] = 100 * (n - lk) / n;
  }
  return { up, dn };
}
function atr14(H, L, C) {   // Wilder ATR
  const o = new Array(C.length).fill(NaN); let p = NaN, s = 0, k = 0;
  for (let i = 1; i < C.length; i++) {
    const tr = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
    if (!isFinite(p)) { s += tr; k++; if (k === 14) { p = s / 14; o[i] = p; } } else { p = (p * 13 + tr) / 14; o[i] = p; }
  }
  return o;
}
function sma(a, n) { return a.map((_, i) => { if (i < n - 1) return NaN; let s = 0; for (let j = i - n + 1; j <= i; j++) s += a[j]; return s / n; }); }

// ---------- data ----------
async function candles(coin) {
  const r = await fetch(`${API}/market/candles?instId=${coin}-USDT-SWAP&bar=1Dutc&limit=300`);
  const j = await r.json();
  if (j.code !== '0') throw new Error(`OKX ${coin}: ${j.code} ${j.msg}`);
  const rows = j.data.filter(x => x[8] === '1').reverse();   // closed candles only, oldest first
  return { T: rows.map(x => +x[0] / 1000), O: rows.map(x => +x[1]), H: rows.map(x => +x[2]), L: rows.map(x => +x[3]), C: rows.map(x => +x[4]) };
}

// Replay a strategy over the candles -> list of trades (last one may still be open) and the position on every bar.
function replay(id, d) {
  const n = d.C.length, A = atr14(d.H, d.L, d.C), pos = new Array(n).fill(0), trades = [];
  const ar = aroon(d.H, d.L, id === 'QS0720' ? 25 : 14);
  let open = null;
  for (let i = 1; i < n; i++) {
    if (!isFinite(ar.dn[i])) continue;
    let want;
    if (id === 'QS0720') want = ar.up[i] > ar.dn[i];
    else want = open ? !(ar.dn[i] > 50) : ar.dn[i] < 10 && !(trades.length && trades[trades.length - 1].i1 === i);
    if (open) {
      if (!open.stopHit && d.L[i] <= open.stop) open.stopHit = { t: d.T[i], px: Math.min(d.O[i], open.stop) };
      if (!want) { open.i1 = i; open.t1 = d.T[i]; open.x = d.C[i]; trades.push(open); open = null; }
    } else if (want) {
      open = { i0: i, t0: d.T[i], e: d.C[i], stop: d.C[i] - STRATS[id].stopAtr * A[i], stopHit: null };
    }
    pos[i] = open ? 1 : 0;
  }
  return { trades, open, pos, A, ma200: sma(d.C, 200), up: ar.up, dn: ar.dn };
}

// ---------- formatting ----------
const day = t => new Date(t * 1000).toISOString().slice(0, 10);
const px = v => v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v >= 10 ? v.toFixed(2) : v.toFixed(3);
const pct = v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%';

function buyMsg(id, coin, d, r, t) {
  const S = STRATS[id], i = t.i0, ma = r.ma200[i], above = d.C[i] > ma, stopPct = 100 * (t.stop / t.e - 1);
  return [
    `🟢 <b>AROON BUY · ${coin}</b>  (${id} ${S.name})`,
    `Signal at the ${day(d.T[i] + 86400)} 00:00 UTC daily close.`,
    ``,
    `<b>Entry:</b> buy now at market (close was $${px(t.e)})`,
    `<b>Stop:</b> $${px(t.stop)} (${pct(stopPct)}) – ${S.stopNote}. Put it on the exchange.`,
    `<b>Take profit:</b> none. Hold until the SELL alert (typical hold ${S.medHold} days; the big winners pay for the small losers).`,
    `<b>200-day MA:</b> ${above ? '✅ price above it – the stronger kind of setup' : '⚠️ price BELOW it – trades like this did clearly worse in tests; skip or use half size'}`,
    `<b>Size:</b> 1/3 of your Aroon money per coin.`,
  ].join('\n');
}
function sellMsg(id, coin, d, r, t) {
  const S = STRATS[id], ret = 100 * (t.x / t.e - 1);
  const lines = [
    `🔴 <b>AROON SELL · ${coin}</b>  (${id} ${S.name})`,
    `Signal at the ${day(d.T[t.i1] + 86400)} 00:00 UTC daily close.`,
    ``,
    `<b>Exit:</b> close the position now at market (close was $${px(t.x)}) and cancel the stop order.`,
    `<b>Trade:</b> bought ${day(t.t0 + 86400)} at $${px(t.e)} → ${pct(ret)} before fees, ${t.i1 - t.i0} days.`,
  ];
  if (t.stopHit) lines.push(`ℹ️ The stop ($${px(t.stop)}) was touched on ${day(t.stopHit.t)} – if it filled, you are already out.`);
  return lines.join('\n');
}
function statusMsg(all) {
  const lines = [`📋 <b>Aroon weekly status</b> (BTC / ETH / SOL, daily candles)`];
  for (const id of Object.keys(STRATS)) {
    lines.push('', `<b>${id} ${STRATS[id].name}</b>`);
    for (const coin of COINS) {
      const { d, R } = all[coin], r = R[id], last = d.C.length - 1;
      if (r.open) {
        const t = r.open;
        lines.push(`🟢 ${coin}: IN since ${day(t.t0 + 86400)} at $${px(t.e)}, now $${px(d.C[last])} (${pct(100 * (d.C[last] / t.e - 1))}), stop $${px(t.stop)}${t.stopHit ? ' (touched!)' : ''}`);
      } else {
        const t = r.trades[r.trades.length - 1];
        lines.push(`⚪ ${coin}: OUT${t ? ` since ${day(t.t1 + 86400)}` : ''} – waiting for a BUY`);
      }
    }
  }
  lines.push('', `Last closed candle: ${day(all.BTC.d.T[all.BTC.d.C.length - 1])}. Alerts come after each daily close (00:00 UTC).`);
  return lines.join('\n');
}

// ---------- Telegram ----------
async function send(html) {
  if (DRY) { console.log('\n' + html.replace(/<\/?b>/g, '')); return; }
  const { AROON_BOT_TOKEN: tok, AROON_CHAT_ID: chat } = process.env;
  if (!tok || !chat) throw new Error('AROON_BOT_TOKEN / AROON_CHAT_ID not set');
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true }) });
  const j = await r.json();
  if (!j.ok) throw new Error('Telegram: ' + j.description);
}

async function main() {
  const all = {};
  for (const coin of COINS) { const d = await candles(coin); all[coin] = { d, R: { QS0720: replay('QS0720', d), QS0231: replay('QS0231', d) } }; }

  if (args.includes('--test')) {
    await send(`✅ <b>Aroon alerts connected</b>\nWatching BTC, ETH and SOL on daily candles. You'll get a 🟢 BUY or 🔴 SELL here after a daily close (00:00 UTC) when a signal fires, plus a status message every Monday.`);
    await send(statusMsg(all));
    return;
  }
  if (args.includes('--status')) { await send(statusMsg(all)); }

  // New signals: any BUY/SELL on the last 3 closed candles not alerted yet (covers a late or skipped run).
  let state = {}; try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) {}
  const first = !Object.keys(state).length, out = [];
  for (const coin of COINS) {
    const { d, R } = all[coin], last = d.C.length - 1, minI = last - 2;
    for (const id of Object.keys(STRATS)) {
      const r = R[id], ev = [];
      for (const t of r.trades) { if (t.i0 >= minI) ev.push({ i: t.i0, kind: 'buy', t }); if (t.i1 >= minI) ev.push({ i: t.i1, kind: 'sell', t }); }
      if (r.open && r.open.i0 >= minI) ev.push({ i: r.open.i0, kind: 'buy', t: r.open });
      ev.sort((a, b) => a.i - b.i);
      const key = `${id}_${coin}`;
      for (const e of ev) {
        const ts = d.T[e.i];
        if (state[key] && ts <= state[key]) continue;
        if (first && e.i < last) { state[key] = ts; continue; }   // first run ever: only alert today's candle
        out.push(e.kind === 'buy' ? buyMsg(id, coin, d, r, e.t) : sellMsg(id, coin, d, r, e.t));
        state[key] = ts;
      }
      if (!state[key]) state[key] = d.T[last];
    }
  }
  for (const m of out) await send(m);
  if (!DRY) fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  console.log(`${out.length} alert(s) ${DRY ? 'would be sent' : 'sent'}; last candle ${day(all.BTC.d.T[all.BTC.d.C.length - 1])}`);
  if (DRY) console.log('\n--- status preview ---' + '\n' + statusMsg(all).replace(/<\/?b>/g, ''));
}
main().catch(e => { console.error(e); process.exit(1); });
