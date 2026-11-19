// In-browser "Refresh": pulls the last 300 closed 15m / 1H / 4H candles for every coin straight from the OKX public
// API and runs the same scan code as the GitHub workflow (scan_core.js + wedge_lib.js, inlined by build_scanner_page.js).
// Needs window.WedgeCore and window.WEDGE_UNIVERSE. OKX candle limit is 40 calls / 2 s; 4 workers stay under it.
(function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  async function get(url, tries) {
    for (var t = 0; t < (tries || 3); t++) {
      try { var j = await (await fetch(url, { cache: 'no-store' })).json(); if (j.code === '0') return j.data; } catch (e) {}
      await sleep(900 * (t + 1));
    }
    return null;
  }
  window.WedgeScanNow = async function (onProgress) {
    var C = window.WedgeCore, U = window.WEDGE_UNIVERSE, TF = ['15m', '1H', '4H'], jobs = [], D = {}, done = 0, bad = 0;
    U.forEach(function (id) { TF.forEach(function (tf) { jobs.push([id, tf]); }); });
    var next = 0;
    async function worker() {
      while (next < jobs.length) {
        var jb = jobs[next++], id = jb[0], tf = jb[1], sym = id.split('-')[0];
        var d = await get('https://www.okx.com/api/v5/market/candles?instId=' + id + '&bar=' + tf + '&limit=300');
        if (d) { (D[sym] = D[sym] || {})[tf] = C.toCandles(d); } else bad++;
        done++; onProgress('Fetching candles ' + done + ' / ' + jobs.length);
        await sleep(160);
      }
    }
    var at = Date.now();
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (!D.BTC || !D.BTC['4H']) throw new Error('could not load BTC candles from OKX');
    onProgress('Finding wedges…'); await sleep(30);
    var list = await C.scanAll(D, async function (s) {
      var id = s + '-USDT-SWAP';
      var fr = await get('https://www.okx.com/api/v5/public/funding-rate?instId=' + id, 2);
      // OKX does not allow browser access to open-interest history, so this usually comes back empty -> check 5 shows "–"
      var oi = await get('https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-history?instId=' + id + '&period=4H&limit=8', 1);
      return C.derFrom(fr, oi);
    }, function (k, n) { onProgress('Funding check ' + k + ' / ' + n); });
    var out = C.slim({ at: at, coins: Object.keys(D).length, list: list });
    out.local = true; out.failed = bad;
    return out;
  };
})();
