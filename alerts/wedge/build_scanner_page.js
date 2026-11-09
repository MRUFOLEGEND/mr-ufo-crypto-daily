// Builds the Wedge Scanner page from live/scan.json (Crypto Daily brand, English).
//   node build_scanner_page.js                      -> wedge_scanner.html, data embedded (Claude artifact snapshot)
//   node build_scanner_page.js --pages OUT.html     -> GitHub Pages version: loads scan.json from the wedge-data branch, Refresh button
//   node build_scanner_page.js --data OUT.json      -> slim scan data only (what the GitHub workflow pushes to wedge-data)
// Charts are drawn in the browser from the data. Uses brand.css + scanner_client.js next to this file.
const fs = require('fs'), path = require('path');
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const DATA_URL = 'https://raw.githubusercontent.com/MRUFOLEGEND/mr-ufo-crypto-daily/wedge-data/scan.json';
const S = JSON.parse(fs.readFileSync(path.join(__dirname, 'live/scan.json'), 'utf8'));
const r6 = x => x == null ? null : +(+x).toPrecision(6);
const slim = { at: S.at, coins: S.coins, list: S.list.map(h => { const o = { ...h, bars: h.chart.bars.map(b => b.map(r6)), start: h.chart.start,
  lines: { tA: [h.lines.trigA[0], r6(h.lines.trigA[1])], tB: [h.lines.trigB[0], r6(h.lines.trigB[1])], oA: [h.lines.outA[0], r6(h.lines.outA[1])], oB: [h.lines.outB[0], r6(h.lines.outB[1])] } };
  delete o.chart; return o; }) };
if (arg('--data')) { fs.writeFileSync(arg('--data'), JSON.stringify(slim)); console.log('wrote', arg('--data'), (JSON.stringify(slim).length / 1024).toFixed(0) + ' KB'); process.exit(0); }

const pages = !!arg('--pages'), out = arg('--pages') || path.join(__dirname, 'wedge_scanner.html');
const ape = pages ? 'BASC.png' : fs.readFileSync(process.env.USERPROFILE + '/.claude/skills/crypto-daily-brand/assets/basc-ape-180.datauri.txt', 'utf8').trim();
const css = fs.readFileSync(path.join(__dirname, 'brand.css'), 'utf8') + `
.rbar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:13px 15px}
.rbtn{min-height:44px;background:var(--surface2);border:1px solid var(--accent);color:var(--white);border-radius:6px;font:700 14px var(--mono);letter-spacing:1px;text-transform:uppercase;padding:0 18px;cursor:pointer}
.rbtn:disabled{opacity:.6;cursor:wait}
.rs{font-size:14px;color:var(--dim);transition:background .4s}.rs.ok{color:var(--bull)}.rs.bad{color:var(--bear)}.rs.flash{background:var(--surface2)}
`;
const client = fs.readFileSync(path.join(__dirname, 'scanner_client.js'), 'utf8');
const head = pages
  ? `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<title>Wedge Scanner</title>\n<link rel="icon" href="BASC.png">`
  : `<title>Wedge Scanner</title>\n<meta name="claude:viewport-fit-sides" content="cover">`;
const html = `${head}
<style>${css}</style>
${pages ? '</head><body>' : ''}
<div class="brand-sticky">
  <div class="brand-block">
    <img class="brand-ape" src="${ape}" alt="Mr UFO">
    <div><div class="brand-title">CRYPTO DAILY</div><div class="brand-sub">Wedge Scanner</div></div>
  </div>
  <div class="stamp" id="stamp">Loading scan…</div>
</div>

<main class="wrap">
${pages ? `  <section class="card">
    <div class="rbar"><button class="rbtn" id="refresh" type="button">Refresh</button><span class="bias bias-neutral" id="conn">Connecting…</span><span class="rs" id="rstatus" role="status" aria-live="polite">Loading the latest scan…</span></div>
  </section>
  <div class="note" id="stale" hidden>The last scan is more than 45 minutes old. The scanner normally runs every 15 minutes, so the GitHub workflow may be stopped. Levels below can be out of date.</div>` : '  <button id="refresh" hidden></button><span id="conn" hidden></span><span id="rstatus" hidden></span>'}
  <section class="gates" id="tiles"></section>

  <div class="note">This is a <b>watch list, not a trade call</b>. A wedge on its own had no edge in the backtest (110 coins, 15m/1H/4H, 2024–2026). The order-block checklist is <b>not backtested</b> yet. Check every level on your own chart before acting.</div>

  <section class="card">
    <div class="card-hdr"><span class="card-title">Filters</span><span class="card-hint" id="shown"></span></div>
    <div class="filters">
      <div class="frow" role="group" aria-label="Level"><span class="fl">Level</span>
        <button class="chip" data-f="level" data-v="ob" aria-pressed="true">Fresh OB (Watch + Weak)</button>
        <button class="chip" data-f="level" data-v="watch" aria-pressed="false">Watch only</button>
        <button class="chip" data-f="level" data-v="all" aria-pressed="false">All wedges</button></div>
      <div class="frow" role="group" aria-label="Timeframe"><span class="fl">Timeframe</span>
        <button class="chip" data-f="tf" data-v="all" aria-pressed="true">All</button><button class="chip" data-f="tf" data-v="4H" aria-pressed="false">4H</button><button class="chip" data-f="tf" data-v="1H" aria-pressed="false">1H</button><button class="chip" data-f="tf" data-v="15m" aria-pressed="false">15m</button></div>
      <div class="frow" role="group" aria-label="Direction"><span class="fl">Side</span>
        <button class="chip" data-f="dir" data-v="all" aria-pressed="true">Both</button><button class="chip" data-f="dir" data-v="short" aria-pressed="false">Rising → short</button><button class="chip" data-f="dir" data-v="long" aria-pressed="false">Falling → long</button></div>
      <div class="frow" role="group" aria-label="Status"><span class="fl">Status</span>
        <button class="chip" data-f="st" data-v="all" aria-pressed="true">All</button><button class="chip" data-f="st" data-v="FORMING" aria-pressed="false">Forming</button><button class="chip" data-f="st" data-v="TRIGGERED" aria-pressed="false">Triggered</button></div>
      <div class="frow"><span class="fl">Coin</span><input id="q" type="search" placeholder="e.g. BTC" aria-label="Search coin" style="min-height:44px;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:0 12px;font:15px var(--mono);width:min(100%,220px)"></div>
    </div>
  </section>

  <section class="card">
    <div class="card-hdr"><span class="card-title">Overview</span><span class="card-hint">tap a coin for its card</span></div>
    <div class="tbl"><table><thead><tr><th>Coin</th><th>TF</th><th>Pattern</th><th>Status</th><th>Level</th><th>Score</th><th>Trigger</th><th>Stop</th><th>2R target</th><th>Risk</th><th>R to zone</th></tr></thead><tbody id="tb"></tbody></table></div>
    <div class="empty" id="none" hidden>No wedges match these filters.</div>
  </section>

  <section class="cards" id="cards"></section>

  <section class="card">
    <div class="card-hdr"><span class="card-title">How each check is measured</span></div>
    <div class="card-body">
      <p><b>Wedge:</b> two trendlines through swing points, both sloping the same way and converging, at least 4 touches, 10–80 candles, no close outside. Same detector as the backtest. Only closed candles are used.</p>
      <p><b>1 · Order block (4H):</b> supply = last green 4H candle before a drop of at least 2 ATR within 3 candles that closes below the last swing low. Demand is the mirror. Zone = that candle's low to high. Dead once a 4H candle closes through it. <i>Fresh</i> = not touched between its creation and the start of the wedge. The wedge's high (low for falling) must be within 0.5 4H ATR of the zone.</p>
      <p><b>2 · Volume:</b> last third of the wedge under 0.8× the first third. A triggered wedge also needs a break candle at 1.5× the wedge average.</p>
      <p><b>3 · Sweep:</b> a wick beyond the outer line by more than 0.1 ATR that closed back inside, in the last third of the wedge.</p>
      <p><b>4 · Divergence:</b> RSI(14) lower at the last swing high than at the one before, while price is higher (mirror for falling).</p>
      <p><b>5 · Derivatives:</b> open interest up more than 3% over 24h, funding positive for a short idea and negative for a long idea. Only fetched for coins at a fresh order block.</p>
      <p><b>6 · Context:</b> coin's 4H EMA50 below EMA200 for a short idea (above for long), and BTC 4H close on the same side of its EMA50.</p>
      <p><b>Plan:</b> trigger = next value of the trigger line. Stop = beyond the wedge extreme or the order-block edge, whichever is further, plus 0.25 ATR. Target 1 = 2R. "R to zone" = distance to the nearest opposite live 4H order block in R. Under 2R means skip.</p>
    </div>
  </section>

  <footer>${pages ? 'A GitHub workflow rescans all coins every 15 minutes. Refresh loads the newest scan; it does not start a new one.' : 'Snapshot only: levels move with every candle, and this page does not update itself. Ask Claude to "refresh the wedge scanner" for new data.'} Wedges alone were backtested with no edge; the order-block filter is not backtested. Keep live risk at 0.5–1% per trade. Not financial advice.</footer>
</main>

<script>
${pages ? `window.WEDGE_SRC=${JSON.stringify(DATA_URL)};` : `window.WEDGE_EMBED=${JSON.stringify(slim)};`}
${client}
</script>
${pages ? '</body></html>' : ''}
`;
fs.writeFileSync(out, html);
console.log('wrote', out, (html.length / 1024).toFixed(0) + ' KB,', slim.list.length, 'wedges');
