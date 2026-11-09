// Wedge detector (rising + falling), no lookahead: a signal at bar i uses only bars <= i, and only pivots
// already confirmed by bar i. Works on log prices so slopes mean the same on a $0.10 coin and on BTC.
// A falling wedge is a rising wedge on the mirrored series (-log price), so one rule set covers both.
//
// Rising wedge at breakout bar i (mirror for falling):
//   lower line = through 2 swing lows a<b, upper line = through 2 swing highs c<d
//   both lines slope up; lower slope > upper slope (converging); width at i <= conv x width at start; apex not passed
//   no CLOSE outside either line between start and i-1, wicks may poke through by up to wick x ATR
//   close[i] is the first close through the lower line (bar i-1 was still inside)
//   start = min(a,c); dur = i-start in [minDur,maxDur]; touches = swing points within tol x ATR of a line
// Trade: rising -> short at next open, falling -> long at next open. Stop = wedge extreme + stopBuf x ATR.
const DEF = { pivR: 2, minDur: 10, maxDur: 80, minTouch: 4, conv: 0.8, wick: 0.6, tol: 0.35, stopBuf: 0.25 };

function atrWilder(H, L, C, n = 14) {
  const out = new Array(C.length).fill(NaN); let s = 0, a = NaN;
  for (let i = 1; i < C.length; i++) {
    const tr = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
    if (i <= n) { s += tr; if (i === n) a = s / n; } else a = (a * (n - 1) + tr) / n;
    out[i] = a;
  }
  return out;
}
function ema(src, n) {
  const k = 2 / (n + 1), o = new Array(src.length).fill(NaN); let v = NaN, s = 0;
  for (let i = 0; i < src.length; i++) { if (i < n - 1) s += src[i]; else if (i === n - 1) v = (s + src[i]) / n; else v = src[i] * k + v * (1 - k); o[i] = v; }
  return o;
}
function pivots(hi, lo, R) { // indices of swing highs / lows; each becomes usable at index + R
  const ph = [], pl = [];
  for (let i = R; i < hi.length - R; i++) {
    let isH = true, isL = true;
    for (let k = 1; k <= R; k++) {
      if (hi[i - k] >= hi[i] || hi[i + k] > hi[i]) isH = false;
      if (lo[i - k] <= lo[i] || lo[i + k] < lo[i]) isL = false;
    }
    if (isH) ph.push(i);
    if (isL) pl.push(i);
  }
  return { ph, pl };
}

// One direction, on (possibly mirrored) log series. Returns the best wedge that breaks at bar i, or null.
function scanDir(i, Hg, Lg, Cg, atrPct, phs, pls, o) {
  const A = atrPct[i], c0 = Cg[i], c1 = Cg[i - 1];
  if (!(A > 0)) return null;
  let best = null;
  for (let bk = pls.length - 1; bk >= 1; bk--) {
    const b = pls[bk];
    if (b + o.pivR > i) continue;
    if (i - b > o.maxDur) break;
    for (let ak = bk - 1; ak >= 0; ak--) {
      const a = pls[ak];
      if (i - a > o.maxDur) break;
      if (b - a < 3) continue;
      const sl = (Lg[b] - Lg[a]) / (b - a);
      if (sl <= 0) continue;
      const li = Lg[a] + sl * (i - a), lp = li - sl;
      if (!(c0 < li && c1 >= lp)) continue;                                   // first close through the lower line
      let ok = true;
      for (let k = a; k < i; k++) { const v = Lg[a] + sl * (k - a); if (Cg[k] < v || Lg[k] < v - o.wick * A) { ok = false; break; } }
      if (!ok) continue;
      for (let dk = phs.length - 1; dk >= 1; dk--) {
        const d = phs[dk];
        if (d + o.pivR > i) continue;
        if (d <= a) break;
        for (let ck = dk - 1; ck >= 0; ck--) {
          const c = phs[ck];
          if (d - c < 3) continue;
          if (i - c > o.maxDur) break;
          const su = (Hg[d] - Hg[c]) / (d - c);
          if (su <= 0 || su >= sl) continue;
          const start = Math.min(a, c), dur = i - start;
          if (dur < o.minDur || dur > o.maxDur) continue;
          if (Math.abs(a - c) > 0.5 * dur) continue;                          // both lines must start near each other
          if (Math.max(b, d) < start + 0.5 * dur) continue;                   // lines must be informed by the back half
          const uS = Hg[c] + su * (start - c), lS = Lg[a] + sl * (start - a), uE = Hg[c] + su * (i - c), lE = li;
          const wS = uS - lS, wE = uE - lE;
          if (wS <= 0 || wE <= 0 || wE > o.conv * wS) continue;
          let good = true;
          for (let k = start; k < i; k++) { const v = Hg[c] + su * (k - c); if (Cg[k] > v || Hg[k] > v + o.wick * A) { good = false; break; } }
          if (!good) continue;
          let tl = 0, tu = 0;
          for (const p of pls) if (p >= start && p + o.pivR <= i && Math.abs(Lg[p] - (Lg[a] + sl * (p - a))) <= o.tol * A) tl++;
          for (const p of phs) if (p >= start && p + o.pivR <= i && Math.abs(Hg[p] - (Hg[c] + su * (p - c))) <= o.tol * A) tu++;
          if (tl + tu < o.minTouch) continue;
          const score = (tl + tu) * 100 + dur;
          if (!best || score > best.score) best = { score, a, b, c, d, sl, su, start, dur, tl, tu, wS, wE };
        }
      }
    }
  }
  return best;
}

// Returns every signal over the series (from bar `from`). c = {time,open,high,low,close,vol} arrays.
function detect(c, opts = {}, from = 60) {
  const o = { ...DEF, ...opts }, n = c.close.length;
  const lh = c.high.map(Math.log), ll = c.low.map(Math.log), lc = c.close.map(Math.log);
  const atr = atrWilder(c.high, c.low, c.close), atrPct = atr.map((a, i) => a / c.close[i]);
  const e200 = ema(c.close, 200), e50 = ema(c.close, 50);
  const mh = ll.map(v => -v), ml = lh.map(v => -v), mc = lc.map(v => -v);
  const P = pivots(lh, ll, o.pivR), M = pivots(mh, ml, o.pivR);
  const out = [];
  const win = (arr, i) => { const r = []; for (let k = arr.length - 1; k >= 0; k--) { if (arr[k] > i) continue; if (i - arr[k] > o.maxDur + 5) break; r.unshift(arr[k]); } return r; };
  for (let i = Math.max(from, 30); i < n; i++) {
    for (const dir of [-1, 1]) { // -1 rising wedge -> short, +1 falling wedge -> long
      const Hg = dir < 0 ? lh : mh, Lg = dir < 0 ? ll : ml, Cg = dir < 0 ? lc : mc, pv = dir < 0 ? P : M;
      const w = scanDir(i, Hg, Lg, Cg, atrPct, win(pv.ph, i), win(pv.pl, i), o);
      if (!w) continue;
      let ext = -Infinity, extK = w.start, base = Infinity;
      for (let k = w.start; k <= i; k++) { if (Hg[k] > ext) { ext = Hg[k]; extK = k; } if (Lg[k] < base) base = Lg[k]; }
      const A = atrPct[i], stopLog = ext + o.stopBuf * A;
      const stop = dir < 0 ? Math.exp(stopLog) : Math.exp(-stopLog);
      const third = Math.max(2, Math.floor(w.dur / 3));
      let v1 = 0, v3 = 0, vAll = 0;
      for (let k = w.start; k < w.start + third; k++) v1 += c.vol[k];
      for (let k = i - third; k < i; k++) v3 += c.vol[k];
      for (let k = w.start; k < i; k++) vAll += c.vol[k];
      const lb = Math.min(w.dur, w.start);
      out.push({
        i, time: c.time[i], dir, type: dir < 0 ? 'rising' : 'falling', close: c.close[i], stop,
        base: dir < 0 ? Math.exp(base) : Math.exp(-base),
        start: w.start, startTime: c.time[w.start], dur: w.dur, touches: w.tl + w.tu,
        steep: (w.sl + w.su) / 2 / A,            // mean line slope in ATR per bar: the "angle"
        slowSlope: w.su / A, fastSlope: w.sl / A,
        heightAtr: (ext - base) / A, convRatio: w.wE / w.wS, apexPos: 1 - w.wE / w.wS,
        extBarsAgo: i - extK, riskPct: Math.abs(c.close[i] / stop - 1) * 100, riskAtr: Math.abs(stopLog - Cg[i]) / A,
        atrPct: A * 100, volFade: v3 / Math.max(v1, 1e-9), breakVol: c.vol[i] / (vAll / w.dur),
        aboveE200: c.close[i] > e200[i] ? 1 : 0, e50vsE200: e50[i] > e200[i] ? 1 : 0,
        preMoveAtr: (Hg[w.start] - Hg[w.start - lb]) / A,   // positive = price already moved in the wedge's direction before it started
        lines: { a: w.a, b: w.b, c: w.c, d: w.d },
      });
    }
  }
  return out;
}
module.exports = { detect, atrWilder, ema, DEF };
