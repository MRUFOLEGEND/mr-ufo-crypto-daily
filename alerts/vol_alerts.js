// Telegram alerts for big volatility spikes on OKX USDT perps. Same data and coin filters as volatility.html,
// but stricter triggers (a phone ping has to be worth it) and runs in GitHub Actions, so the laptop can be off.
//   node vol_alerts.js --dry            one scan, print what would be sent (no Telegram needed)
//   node vol_alerts.js --loop 29        scan every 3 min for 29 min, send to Telegram (what the workflow runs)
//   node vol_alerts.js --test           send one test message
// Needs env TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (GitHub repo secrets). Nothing secret lives in this file.
//
// Three alert types:
//   🚨 BTC/ETH shock   — 15m or 1h move far outside the coin's normal, with open-interest read (flush / squeeze / new positions)
//   🌊 Market-wide     — a big share of the top 100 coins move ≥1.5% the same way in 15m (liquidation cascade style)
//   ⚡ Alt spike       — one coin: volume many × normal AND a big move vs its own normal (bundled, one message)
const fs = require('fs');

const API = 'https://www.okx.com/api/v5';
const PAGE = 'https://mrufolegend.github.io/mr-ufo-crypto-daily/volatility.html';
const STATE_FILE = process.env.STATE_FILE || 'vol_alerts_state.json';

const CFG = {
  topN: 100, memeLiq: 50e6, minAgeDays: 14,
  everyMin: 3,
  cooldownMin: 60,          // same coin + same alert type stays quiet this long...
  escalate: 1.6,            // ...unless the move grows to this × the move we last alerted
  // majors: fire when the move is ≥ zMin × the coin's typical 15m move AND ≥ minPct, or ≥ hardPct regardless
  majors: { BTC: { min15: 1.0, hard15: 2.0, hard1h: 3.0 }, ETH: { min15: 1.4, hard15: 2.8, hard1h: 4.0 } },
  zMin: 4,
  oiFlag: 1.0,              // % OI change in 15m that counts as "big"
  breadthPct: 1.5, breadthShare: 0.35,
  alt15: { volX: 5, pct: 4, z: 4 }, alt1h: { volX: 4, pct: 8 },
  maxAltRows: 6,
};
const MEMES = new Set(('DOGE PEPE SHIB BONK WIF FLOKI BOME MEME NEIRO NEIROETH TURBO PNUT MOODENG POPCAT MEW BRETT TRUMP MELANIA FARTCOIN GOAT PENGU SPX ' +
  'ACT CHILLGUY DOGS NOT MOG BABYDOGE PEOPLE SATS ORDI RATS CAT MUBARAK USELESS PUMP LUCE GIGA PONKE SLERF MYRO WEN BAN TST BROCCOLI ' +
  'AIDOGE ELON LADYS VINE JELLYJELLY HIPPO KOMA DEGEN TOSHI SUNDOG HMSTR CATI X 1000SATS PIPPIN AI16Z ZEREBRO FWOG MICHI').split(' '));
const STABLES = new Set('USDC USDE FDUSD DAI TUSD USD1 PYUSD RLUSD USDG USDD EURC USTC'.split(' '));

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- OKX (throttled, ~18 req/s; limit is 20/s per IP) ----------
let lastStart = 0;
async function okx(path, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const wait = Math.max(0, lastStart + 55 - Date.now());
    lastStart = Date.now() + wait;
    if (wait) await sleep(wait);
    try {
      const r = await fetch(API + path);
      const j = await r.json();
      if (j.code === '0') return j.data;
      if (j.code === '50011') { await sleep(1200 * (i + 1)); continue; }
      throw new Error('OKX ' + j.code + ' ' + j.msg);
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(800 * (i + 1));
    }
  }
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k]); } }));
}

// ---------- helpers ----------
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sum = (a, i, j) => { let t = 0; for (let k = i; k < j; k++) t += a[k]; return t; };
const sg = (x, d = 1) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d);
const fmtUsd = v => v >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? '$' + (v / 1e6).toFixed(1) + 'M' : '$' + (v / 1e3).toFixed(0) + 'K';
const fmtPx = v => v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v >= 1 ? v.toFixed(v >= 100 ? 2 : 4) : v.toPrecision(4);
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const okxLink = sym => `<a href="https://www.okx.com/trade-swap/${sym.toLowerCase()}-usdt-swap">${esc(sym)}</a>`;
const hhmm = t => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });

// Candles newest-first: [ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]. The newest bar is still forming.
const parse = rows => rows.slice().reverse().map(r => ({ t: +r[0], h: +r[2], l: +r[3], c: +r[4], v: +r[7] }));

// 15m and 1h windows on 5m candles, each compared with the coin's own past 24h.
// "Normal" move = robust sigma (1.4826 × median absolute return) so earlier spikes don't inflate it.
function analyse(sym, bars) {
  const N = bars.length;
  if (N < 200) return null;
  const c = bars.map(b => b.c), v = bars.map(b => b.v);
  const win = (w) => {
    const ch = c[N - 1] / c[N - 1 - w] - 1;
    const rets = [], vols = [];
    for (let e = N - 1 - w; e - w >= 0 && rets.length < 288 / w; e -= w) { rets.push(Math.abs(c[e] / c[e - w] - 1)); vols.push(sum(v, e - w + 1, e + 1)); }
    const sigma = 1.4826 * median(rets), vb = median(vols);
    const hi = Math.max(...bars.slice(N - w).map(b => b.h)), lo = Math.min(...bars.slice(N - w).map(b => b.l));
    return { ch, pct: ch * 100, z: sigma > 0 ? Math.abs(ch) / sigma : 0, volX: vb > 0 ? sum(v, N - w, N) / vb : 0, range: (hi / lo - 1) * 100 };
  };
  return { sym, price: c[N - 1], m15: win(3), h1: win(12), ch24: (c[N - 1] / c[Math.max(0, N - 289)] - 1) * 100 };
}

// ---------- coin list (same filters as volatility.html) ----------
let instCache = null;
async function universe() {
  if (!instCache || Date.now() - instCache.at > 6 * 3600e3) instCache = { at: Date.now(), map: new Map((await okx('/public/instruments?instType=SWAP')).map(x => [x.instId, x])) };
  const tick = await okx('/market/tickers?instType=SWAP');
  const out = [];
  for (const t of tick) {
    const m = instCache.map.get(t.instId);
    if (!m || !t.instId.endsWith('-USDT-SWAP') || m.state !== 'live' || m.instCategory !== '1') continue;
    const sym = t.instId.replace('-USDT-SWAP', ''), usd = +t.volCcy24h * +t.last;
    if (STABLES.has(sym) || (MEMES.has(sym) && usd < CFG.memeLiq) || Date.now() - +m.listTime < CFG.minAgeDays * 864e5) continue;
    out.push({ id: t.instId, sym, usd });
  }
  out.sort((a, b) => b.usd - a.usd);
  const majors = Object.keys(CFG.majors);
  return [...out.filter(x => majors.includes(x.sym)), ...out.filter(x => !majors.includes(x.sym)).slice(0, CFG.topN)];
}

// Open interest (USD, all OKX contracts for that coin) 15m ago vs now, plus current funding
async function derivs(sym) {
  try {
    const [oi, fr] = await Promise.all([
      okx(`/rubik/stat/contracts/open-interest-volume?ccy=${sym}&period=5m`),
      okx(`/public/funding-rate?instId=${sym}-USDT-SWAP`)]);
    return { oi: +oi[0][1], oiCh: (+oi[0][1] / +oi[3][1] - 1) * 100, funding: +fr[0].fundingRate * 100 };
  } catch { return null; }
}
// What the price + OI combo usually means, in plain words
function read(pct, oiCh) {
  if (oiCh == null || Math.abs(oiCh) < CFG.oiFlag / 2) return 'OI barely moved: spot/whale driven, not leverage.';
  if (pct < 0 && oiCh < 0) return 'Longs getting liquidated (flush). Often near a short-term low once the wicks stop. Don\'t chase the short.';
  if (pct < 0) return 'New shorts piling in: real selling pressure, can keep trending.';
  if (oiCh < 0) return 'Short squeeze: shorts covering. Often fades once the squeeze is done. Don\'t chase the long.';
  return 'New longs piling in: fresh buying, but crowded if funding is high.';
}

// ---------- cooldowns ----------
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
function allowed(key, mag) {
  const p = state[key];
  return !p || Date.now() - p.t > CFG.cooldownMin * 60e3 || Math.abs(mag) >= Math.abs(p.mag) * CFG.escalate;
}
const mark = (key, mag) => { state[key] = { t: Date.now(), mag }; };
const saveState = () => {
  for (const k of Object.keys(state)) if (Date.now() - state[k].t > 24 * 3600e3) delete state[k];
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
};

// ---------- one scan ----------
async function scan() {
  const uni = await universe();
  const res = [];
  await pool(uni, 10, async u => {
    try { const r = analyse(u.sym, parse(await okx(`/market/candles?instId=${u.id}&bar=5m&limit=300`))); if (r) res.push({ ...r, usd: u.usd }); } catch {}
  });
  const by = new Map(res.map(r => [r.sym, r]));
  const msgs = [];
  const now = Date.now();

  // 🚨 BTC / ETH
  for (const [sym, t] of Object.entries(CFG.majors)) {
    const r = by.get(sym); if (!r) continue;
    const f15 = (r.m15.z >= CFG.zMin && Math.abs(r.m15.pct) >= t.min15) || Math.abs(r.m15.pct) >= t.hard15;
    const f1h = Math.abs(r.h1.pct) >= t.hard1h;
    if (!f15 && !f1h) continue;
    const w = f15 ? r.m15 : r.h1, tf = f15 ? '15m' : '1h', key = `major:${sym}:${tf}:${w.pct > 0 ? 'up' : 'dn'}`;
    if (!allowed(key, w.pct)) continue;
    mark(key, w.pct);
    const d = await derivs(sym);
    const L = [];
    L.push(`🚨 <b>${sym} ${w.pct > 0 ? 'PUMP' : 'DUMP'} ${sg(w.pct, 2)}% in ${tf}</b>`);
    L.push(`Price ${fmtPx(r.price)} · ${w.z.toFixed(1)}× a normal ${tf} move`);
    L.push(`Range ${w.range.toFixed(2)}% · volume ${w.volX.toFixed(1)}× normal`);
    if (d) {
      L.push(`OI ${sg(d.oiCh, 2)}% in 15m (${fmtUsd(d.oi)}) · funding ${sg(d.funding, 4)}%`);
      L.push(`💡 ${read(w.pct, d.oiCh)}`);
    }
    L.push(`24h ${sg(r.ch24, 1)}% · ${hhmm(now)}`);
    L.push(`${okxLink(sym)} · <a href="${PAGE}">scanner</a>`);
    msgs.push(L.join('\n'));
  }

  // 🌊 Market-wide
  const alts = res.filter(r => !CFG.majors[r.sym]);
  let wide = null;
  if (alts.length >= 50) {
    const up = alts.filter(r => r.m15.pct >= CFG.breadthPct), dn = alts.filter(r => r.m15.pct <= -CFG.breadthPct);
    const side = up.length >= dn.length ? { dir: 'up', list: up } : { dir: 'dn', list: dn };
    const share = side.list.length / alts.length;
    if (share >= CFG.breadthShare) {
      wide = side.dir;
      const key = `wide:${side.dir}`;
      if (allowed(key, share)) {
        mark(key, share);
        const btc = by.get('BTC'), avg = median(alts.map(r => r.m15.pct));
        const top = [...side.list].sort((a, b) => side.dir === 'up' ? b.m15.pct - a.m15.pct : a.m15.pct - b.m15.pct).slice(0, 5);
        const L = [];
        L.push(`🌊 <b>Market-wide ${side.dir === 'up' ? 'PUMP' : 'DUMP'}</b>`);
        L.push(`${side.list.length}/${alts.length} top coins ${side.dir === 'up' ? 'up' : 'down'} ≥${CFG.breadthPct}% in 15m`);
        L.push(`Median alt ${sg(avg, 2)}%${btc ? ` · BTC ${sg(btc.m15.pct, 2)}%` : ''}`);
        L.push(`Biggest: ${top.map(r => `${esc(r.sym)} ${sg(r.m15.pct, 1)}%`).join(', ')}`);
        L.push(`💡 ${side.dir === 'dn' ? 'Looks like a liquidation cascade. Wait for the flush to finish before buying the dip; check the Cascade playbook.' : 'Broad squeeze/risk-on burst. Late entries here often get faded.'}`);
        L.push(`${hhmm(now)} · <a href="${PAGE}">scanner</a>`);
        msgs.push(L.join('\n'));
      }
    }
  }

  // ⚡ Alt spikes (during a market-wide move only coins going against it, or 2× the median, are news)
  const medAlt = median(alts.map(r => Math.abs(r.m15.pct)));
  const spikes = [];
  for (const r of alts) {
    const a = CFG.alt15, b = CFG.alt1h;
    const f15 = r.m15.volX >= a.volX && Math.abs(r.m15.pct) >= a.pct && r.m15.z >= a.z;
    const f1h = r.h1.volX >= b.volX && Math.abs(r.h1.pct) >= b.pct;
    if (!f15 && !f1h) continue;
    const w = f15 ? r.m15 : r.h1, tf = f15 ? '15m' : '1h';
    if (wide && (w.pct > 0) === (wide === 'up') && Math.abs(w.pct) < 2 * medAlt + a.pct) continue;
    const key = `alt:${r.sym}:${w.pct > 0 ? 'up' : 'dn'}`;
    if (!allowed(key, w.pct)) continue;
    spikes.push({ r, w, tf, key });
  }
  if (spikes.length) {
    spikes.sort((x, y) => Math.abs(y.w.pct) - Math.abs(x.w.pct));
    const shown = spikes.slice(0, CFG.maxAltRows);
    shown.forEach(s => mark(s.key, s.w.pct));
    const L = [`⚡ <b>Alt volatility spike${shown.length > 1 ? 's' : ''}</b>`];
    for (const { r, w, tf } of shown) {
      L.push(`${w.pct > 0 ? '🟢' : '🔴'} ${okxLink(r.sym)} <b>${sg(w.pct, 1)}%</b> in ${tf} · vol ${w.volX.toFixed(1)}× · ${w.z.toFixed(1)}× normal move`);
      L.push(`    ${fmtPx(r.price)} · 24h ${sg(r.ch24, 1)}% · ${fmtUsd(r.usd)} 24h vol`);
    }
    if (spikes.length > shown.length) L.push(`…and ${spikes.length - shown.length} more`);
    L.push(`${hhmm(now)} · <a href="${PAGE}">scanner</a>`);
    msgs.push(L.join('\n'));
  }
  return { msgs, n: res.length };
}

// ---------- Telegram ----------
async function send(html) {
  if (DRY) {
    console.log('\n' + html.replace(/<a href="([^"]+)">([^<]+)<\/a>/g, '$2').replace(/<\/?b>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    return;
  }
  const { TELEGRAM_BOT_TOKEN: tok, TELEGRAM_CHAT_ID: chat } = process.env;
  if (!tok || !chat) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set');
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true }) });
  const j = await r.json();
  if (!j.ok) throw new Error('Telegram: ' + j.description);
}

async function main() {
  if (args.includes('--test')) {
    const { n } = await scan();
    await send(`✅ <b>Volatility alerts connected</b>\nScanned ${n} coins on OKX just now. You'll get a message here when something big moves.`);
    return console.log('test message sent');
  }
  const li = args.indexOf('--loop'), mins = li >= 0 ? +args[li + 1] || 29 : 0;
  const end = Date.now() + mins * 60e3;
  do {
    const t0 = Date.now();
    try {
      const { msgs, n } = await scan();
      for (const m of msgs) await send(m);
      if (!DRY) saveState();
      console.log(`${new Date().toISOString()} scanned ${n} coins, ${msgs.length} alert(s), ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    } catch (e) { console.error(new Date().toISOString(), e.message); }
    const next = t0 + CFG.everyMin * 60e3;
    if (next >= end) break;
    await sleep(next - Date.now());
  } while (true);
}
main().catch(e => { console.error(e); process.exit(1); });
