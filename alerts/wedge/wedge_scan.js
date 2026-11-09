// Live wedge scanner: finds wedges that are FORMING (price still inside) or TRIGGERED (first close through the
// trigger line in the last 3 closed bars) on 15m / 1H / 4H, checks 4H order-block confluence and the checklist,
// and writes live/scan.json. Input: live/*.json from live_fetch.js. Derivatives (funding, OI) fetched for hits only.
// Same wedge rules as wedge_lib.js (the backtested detector); the order-block rules below are NOT backtested.
const fs = require('fs');
const { detect, atrWilder, ema, DEF } = require('./wedge_lib.js');
const DIR = __dirname + '/live';
const o = { ...DEF };

function pivots(hi, lo, R) {
  const ph = [], pl = [];
  for (let i = R; i < hi.length - R; i++) {
    let isH = true, isL = true;
    for (let k = 1; k <= R; k++) {
      if (hi[i - k] >= hi[i] || hi[i + k] > hi[i]) isH = false;
      if (lo[i - k] <= lo[i] || lo[i + k] < lo[i]) isL = false;
    }
    if (isH) ph.push(i); if (isL) pl.push(i);
  }
  return { ph, pl };
}
function rsi(C, n = 14) {
  const out = new Array(C.length).fill(NaN); let g = 0, l = 0;
  for (let i = 1; i < C.length; i++) {
    const d = C[i] - C[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = 100 - 100 / (1 + g / (l || 1e-12)); } }
    else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = 100 - 100 / (1 + g / (l || 1e-12)); }
  }
  return out;
}

// Forming wedge at the last bar i: same geometry as scanDir in wedge_lib.js, but price must still be INSIDE both lines.
function formingDir(i, Hg, Lg, Cg, A, phs, pls) {
  let best = null;
  for (let bk = pls.length - 1; bk >= 1; bk--) {
    const b = pls[bk]; if (b + o.pivR > i) continue; if (i - b > o.maxDur) break;
    for (let ak = bk - 1; ak >= 0; ak--) {
      const a = pls[ak]; if (i - a > o.maxDur) break; if (b - a < 3) continue;
      const sl = (Lg[b] - Lg[a]) / (b - a); if (sl <= 0) continue;
      let ok = true;
      for (let k = a; k <= i; k++) { const v = Lg[a] + sl * (k - a); if (Cg[k] < v || Lg[k] < v - o.wick * A) { ok = false; break; } }
      if (!ok) continue;
      for (let dk = phs.length - 1; dk >= 1; dk--) {
        const d = phs[dk]; if (d + o.pivR > i) continue; if (d <= a) break;
        for (let ck = dk - 1; ck >= 0; ck--) {
          const c = phs[ck]; if (d - c < 3) continue; if (i - c > o.maxDur) break;
          const su = (Hg[d] - Hg[c]) / (d - c); if (su <= 0 || su >= sl) continue;
          const start = Math.min(a, c), dur = i - start;
          if (dur < o.minDur || dur > o.maxDur) continue;
          if (Math.abs(a - c) > 0.5 * dur) continue;
          if (Math.max(b, d) < start + 0.5 * dur) continue;
          const wS = (Hg[c] + su * (start - c)) - (Lg[a] + sl * (start - a)), wE = (Hg[c] + su * (i - c)) - (Lg[a] + sl * (i - a));
          if (wS <= 0 || wE <= 0 || wE > o.conv * wS) continue;
          let good = true;
          for (let k = start; k <= i; k++) { const v = Hg[c] + su * (k - c); if (Cg[k] > v || Hg[k] > v + o.wick * A) { good = false; break; } }
          if (!good) continue;
          let tl = 0, tu = 0;
          for (const p of pls) if (p >= start && p + o.pivR <= i && Math.abs(Lg[p] - (Lg[a] + sl * (p - a))) <= o.tol * A) tl++;
          for (const p of phs) if (p >= start && p + o.pivR <= i && Math.abs(Hg[p] - (Hg[c] + su * (p - c))) <= o.tol * A) tu++;
          if (tl + tu < o.minTouch) continue;
          const score = (tl + tu) * 100 + dur;
          if (!best || score > best.score) best = { score, a, b, c, d, start, dur, touches: tl + tu, steep: (sl + su) / 2 / A };
        }
      }
    }
  }
  return best;
}
function forming(c) {
  const n = c.close.length, i = n - 1;
  const lh = c.high.map(Math.log), ll = c.low.map(Math.log), lc = c.close.map(Math.log);
  const atr = atrWilder(c.high, c.low, c.close), A = atr[i] / c.close[i];
  const P = pivots(lh, ll, o.pivR), M = pivots(ll.map(v => -v), lh.map(v => -v), o.pivR);
  const win = arr => arr.filter(k => k <= i && i - k <= o.maxDur + 5);
  const out = [];
  for (const dir of [-1, 1]) {
    const Hg = dir < 0 ? lh : ll.map(v => -v), Lg = dir < 0 ? ll : lh.map(v => -v), Cg = dir < 0 ? lc : lc.map(v => -v), pv = dir < 0 ? P : M;
    const w = formingDir(i, Hg, Lg, Cg, A, win(pv.ph), win(pv.pl));
    if (w) out.push({ ...w, dir, i, status: 'FORMING' });
  }
  return out;
}

// 4H order blocks. Supply = last bullish candle before a drop of >= 2 ATR within 3 bars that closes below the last
// confirmed swing low. Demand = mirror. Zone = that candle's low-high. Dead once a 4H candle CLOSES through the far side.
function orderBlocks(c) {
  const n = c.close.length, atr = atrWilder(c.high, c.low, c.close), P = pivots(c.high, c.low, 2), out = [];
  const lastBefore = (arr, j) => { let r = -1; for (const p of arr) if (p + 2 <= j) r = p; else break; return r; };
  for (let j = 20; j < n - 3; j++) {
    if (!(atr[j] > 0)) continue;
    const nx = [1, 2, 3].map(k => c.close[j + k]);
    if (c.close[j] > c.open[j]) {
      const sw = lastBefore(P.pl, j), mn = Math.min(...nx);
      if (c.close[j] - mn >= 2 * atr[j] && sw >= 0 && mn < c.low[sw]) out.push({ type: 'supply', j, lo: c.low[j], hi: c.high[j], t: c.time[j] });
    }
    if (c.close[j] < c.open[j]) {
      const sw = lastBefore(P.ph, j), mx = Math.max(...nx);
      if (mx - c.close[j] >= 2 * atr[j] && sw >= 0 && mx > c.high[sw]) out.push({ type: 'demand', j, lo: c.low[j], hi: c.high[j], t: c.time[j] });
    }
  }
  for (const b of out) {
    b.dead = false; b.firstTouch = null;
    for (let k = b.j + 4; k < n; k++) {
      if (b.type === 'supply') { if (b.firstTouch == null && c.high[k] >= b.lo) b.firstTouch = c.time[k]; if (c.close[k] > b.hi) { b.dead = true; break; } }
      else { if (b.firstTouch == null && c.low[k] <= b.hi) b.firstTouch = c.time[k]; if (c.close[k] < b.lo) { b.dead = true; break; } }
    }
  }
  return out.filter(b => !b.dead);
}


function analyse(sym, tf, c, w, c4, obs, btc4) {
  const n = c.close.length, i = n - 1, dir = w.dir, short = dir < 0;
  const atr = atrWilder(c.high, c.low, c.close), A = atr[i];
  // trigger line through (a,b), outer line through (c,d); rising: trigger = lows, outer = highs. Falling: trigger = highs, outer = lows.
  const trigSrc = short ? c.low : c.high, outSrc = short ? c.high : c.low;
  const mk = (src, p, q) => { const s = (Math.log(src[q]) - Math.log(src[p])) / (q - p); return k => Math.exp(Math.log(src[p]) + s * (k - p)); };
  const trig = mk(trigSrc, w.a, w.b), outer = mk(outSrc, w.c, w.d);
  let ext = short ? -Infinity : Infinity, base = short ? Infinity : -Infinity;
  for (let k = w.start; k <= i; k++) {
    if (short) { ext = Math.max(ext, c.high[k]); base = Math.min(base, c.low[k]); }
    else { ext = Math.min(ext, c.low[k]); base = Math.max(base, c.high[k]); }
  }
  const startT = c.time[w.start], third = Math.max(2, Math.floor(w.dur / 3));
  // 1 location: a live 4H OB of the right type, created before the wedge, not touched before the wedge started, wedge extreme in or near it
  const atr4 = atrWilder(c4.high, c4.low, c4.close), A4 = atr4[c4.close.length - 1];
  const want = short ? 'supply' : 'demand';
  const cand = obs.filter(b => b.type === want && b.t + 4 * 14400 <= startT)
    .filter(b => short ? (ext >= b.lo - 0.5 * A4 && ext <= b.hi + 0.5 * A4) : (ext <= b.hi + 0.5 * A4 && ext >= b.lo - 0.5 * A4));
  cand.sort((x, y) => y.t - x.t);
  const ob = cand[0] || null, fresh = ob ? (ob.firstTouch == null || ob.firstTouch >= startT) : false;
  // 2 volume: fades inside the wedge (last third < 0.8x first third); triggered wedges also need a break bar >= 1.5x average
  let v1 = 0, v3 = 0, vAll = 0; for (let k = w.start; k < w.start + third; k++) v1 += c.vol[k];
  const endIn = w.status === 'TRIGGERED' ? w.breakI : i + 1;
  for (let k = endIn - third; k < endIn; k++) v3 += c.vol[k]; for (let k = w.start; k < endIn; k++) vAll += c.vol[k];
  const volFade = v3 / Math.max(v1, 1e-12), breakVol = w.status === 'TRIGGERED' ? c.vol[w.breakI] / (vAll / (endIn - w.start)) : null;
  // 3 sweep / throw-over: a wick beyond the OUTER line by > 0.1 ATR that closed back inside, in the last third
  let sweep = false; const lastIn = w.status === 'TRIGGERED' ? w.breakI - 1 : i;
  for (let k = lastIn - third; k <= lastIn; k++) { const v = outer(k); if (short ? (c.high[k] > v + 0.1 * A && c.close[k] <= v) : (c.low[k] < v - 0.1 * A && c.close[k] >= v)) sweep = true; }
  // 4 RSI divergence across the last two outer-line pivots
  const R = rsi(c.close), pv = pivots(c.high, c.low, 2), piv = (short ? pv.ph : pv.pl).filter(p => p >= w.start && p + 2 <= lastIn);
  let div = false; if (piv.length >= 2) { const [p, q] = piv.slice(-2); div = short ? (c.high[q] > c.high[p] && R[q] < R[p]) : (c.low[q] < c.low[p] && R[q] > R[p]); }
  // 6 context: coin 4H trend against the wedge + BTC 4H on the trade side of its EMA50
  const e50 = ema(c4.close, 50), e200 = ema(c4.close, 200), m = c4.close.length - 1;
  const b50 = ema(btc4.close, 50), bm = btc4.close.length - 1;
  const trendOk = short ? e50[m] < e200[m] : e50[m] > e200[m], btcOk = short ? btc4.close[bm] < b50[bm] : btc4.close[bm] > b50[bm];
  // trade plan
  const trigNow = trig(i + 1), outerNow = outer(i + 1);
  const entry = w.status === 'TRIGGERED' ? c.close[w.breakI] : trigNow;
  const stopBase = short ? Math.max(ext, ob ? ob.hi : -Infinity) : Math.min(ext, ob ? ob.lo : Infinity);
  const stop = short ? stopBase + 0.25 * A : stopBase - 0.25 * A, risk = Math.abs(stop - entry);
  const t1 = short ? entry - 2 * risk : entry + 2 * risk;
  const opp = obs.filter(b => b.type === (short ? 'demand' : 'supply') && (short ? b.hi < entry : b.lo > entry));
  opp.sort((x, y) => short ? y.hi - x.hi : x.lo - y.lo);
  const zone = opp[0] || null, zoneEdge = zone ? (short ? zone.hi : zone.lo) : null;
  const rrZone = zone ? Math.abs(zoneEdge - entry) / risk : null, rrBase = Math.abs(base - entry) / risk;
  const movedR = w.status === 'TRIGGERED' ? (short ? (entry - c.close[i]) : (c.close[i] - entry)) / risk : 0;
  const pts = {
    location: !!(ob && fresh), volume: w.status === 'TRIGGERED' ? (volFade < 0.8 && breakVol >= 1.5) : volFade < 0.8,
    sweep, divergence: div, derivatives: null, context: trendOk && btcOk,
  };
  const s0 = Math.max(0, w.start - 15);
  const bars = []; for (let k = s0; k <= i; k++) bars.push([c.open[k], c.high[k], c.low[k], c.close[k]]);
  return {
    sym, tf, dir: short ? 'short' : 'long', type: short ? 'Rising wedge' : 'Falling wedge', status: w.status, barsSinceBreak: w.status === 'TRIGGERED' ? i - w.breakI : null,
    lastClose: c.close[i], lastTime: c.time[i], startTime: startT, dur: w.dur, touches: w.touches, steep: w.steep,
    trigNow, outerNow, trigSlopePct: (trig(i + 2) / trig(i + 1) - 1) * 100, outerSlopePct: (outer(i + 2) / outer(i + 1) - 1) * 100,
    ext, base, entry, movedR, stop, risk, riskPct: risk / entry * 100, t1, zone: zone && { lo: zone.lo, hi: zone.hi, t: zone.t }, rrZone, rrBase,
    ob: ob && { lo: ob.lo, hi: ob.hi, t: ob.t, fresh }, anyOb: cand.length > 0,
    volFade, breakVol, trend: { coin: trendOk, btc: btcOk }, pts,
    chart: { s0, bars, a: w.a - s0, b: w.b - s0, c: w.c - s0, d: w.d - s0, start: w.start - s0, trigSrc: short ? 'low' : 'high' },
    lines: { trigA: [w.a - s0, trigSrc[w.a]], trigB: [w.b - s0, trigSrc[w.b]], outA: [w.c - s0, outSrc[w.c]], outB: [w.d - s0, outSrc[w.d]] },
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url) { for (let t = 0; t < 4; t++) { try { const j = await (await fetch(url)).json(); if (j.code === '0') return j.data; } catch (e) {} await sleep(1200); } return null; }

(async () => {
  const meta = JSON.parse(fs.readFileSync(DIR + '/_meta.json', 'utf8'));
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json') && !f.startsWith('_') && f !== 'scan.json');
  const btc4 = JSON.parse(fs.readFileSync(DIR + '/BTC.json', 'utf8'))['4H'];
  const hits = [];
  for (const f of files) {
    const sym = f.replace('.json', ''), D = JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8'));
    if (!D['4H'] || D['4H'].close.length < 60) continue;
    const obs = orderBlocks(D['4H']);
    for (const tf of ['15m', '1H', '4H']) {
      const c = D[tf]; if (!c || c.close.length < 120) continue;
      const n = c.close.length;
      for (const w of forming(c)) hits.push(analyse(sym, tf, c, w, D['4H'], obs, btc4));
      for (const x of detect(c, {}, n - 3)) {
        hits.push(analyse(sym, tf, c, { ...x.lines, start: x.start, dur: x.dur, touches: x.touches, steep: x.steep, dir: x.dir, status: 'TRIGGERED', breakI: x.i }, D['4H'], obs, btc4));
      }
    }
  }
  // keep one triggered per coin/TF/direction (the latest break)
  const seen = new Set(), list = [];
  for (const h of hits.sort((a, b) => (a.barsSinceBreak ?? -1) - (b.barsSinceBreak ?? -1))) { const k = [h.sym, h.tf, h.dir, h.status].join('|'); if (seen.has(k)) continue; seen.add(k); list.push(h); }
  // derivatives for coins with an OB-confluence hit (funding now, OI change over the last 24h)
  const need = [...new Set(list.filter(h => h.pts.location).map(h => h.sym))];
  const der = {};
  for (const s of need) {
    const id = `${s}-USDT-SWAP`;
    const fr = await get(`https://www.okx.com/api/v5/public/funding-rate?instId=${id}`); await sleep(120);
    const oi = await get(`https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-history?instId=${id}&period=4H&limit=8`); await sleep(220);
    const funding = fr && fr[0] ? +fr[0].fundingRate * 100 : null;
    let oiChg = null; if (oi && oi.length >= 7) { const now = +oi[0][3], ago = +oi[6][3]; if (ago > 0) oiChg = (now / ago - 1) * 100; }
    der[s] = { funding, oiChg };
  }
  for (const h of list) {
    const d = der[h.sym]; h.der = d || null;
    if (d && d.funding != null && d.oiChg != null) h.pts.derivatives = d.oiChg > 3 && (h.dir === 'short' ? d.funding > 0 : d.funding < 0);
    const extra = ['volume', 'sweep', 'divergence', 'derivatives', 'context'].filter(k => h.pts[k] === true).length;
    h.score = (h.pts.location ? 1 : 0) + extra;
    h.level = !h.pts.location ? (h.anyOb ? 'TESTED OB' : 'NO OB') : extra >= 2 ? 'WATCH' : 'WEAK';
  }
  const rank = { WATCH: 0, WEAK: 1, 'TESTED OB': 2, 'NO OB': 3 }, tfr = { '4H': 0, '1H': 1, '15m': 2 };
  list.sort((a, b) => rank[a.level] - rank[b.level] || b.score - a.score || tfr[a.tf] - tfr[b.tf] || a.sym.localeCompare(b.sym));
  fs.writeFileSync(DIR + '/scan.json', JSON.stringify({ at: meta.fetchedAt, coins: files.length, list }));
  const cnt = k => list.filter(h => h.level === k).length;
  console.log(`${list.length} wedges on ${new Set(list.map(h => h.sym)).size} coins | WATCH ${cnt('WATCH')} WEAK ${cnt('WEAK')} TESTED ${cnt('TESTED OB')} NO-OB ${cnt('NO OB')} | forming ${list.filter(h => h.status === 'FORMING').length} triggered ${list.filter(h => h.status === 'TRIGGERED').length}`);
  for (const h of list.slice(0, 12)) console.log(h.level.padEnd(9), h.sym.padEnd(9), h.tf.padEnd(4), h.type.padEnd(14), h.status.padEnd(9), 'score', h.score, 'entry', +h.entry.toPrecision(5), 'stop', +h.stop.toPrecision(5), 'risk%', h.riskPct.toFixed(2), 'RRzone', h.rrZone && h.rrZone.toFixed(1), JSON.stringify(h.der));
})();
