// Fetches the latest 300 CLOSED candles per coin for 15m / 1H / 4H (one call each) + BTC, into live/*.json.
// Public OKX API, no keys. ~330 calls, about 1 minute.
const fs = require('fs'), DIR = __dirname + '/live';
fs.mkdirSync(DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url) { for (let t = 0; t < 5; t++) { try { const j = await (await fetch(url)).json(); if (j.code === '0') return j.data; } catch (e) {} await sleep(1500); } return null; }
(async () => {
  const uf = fs.existsSync(__dirname + '/universe.json') ? __dirname + '/universe.json' : __dirname + '/data/universe.json';
  const uni = JSON.parse(fs.readFileSync(uf, 'utf8'));
  let ok = 0, bad = [];
  for (const id of uni) {
    const out = {};
    for (const bar of ['15m', '1H', '4H']) {
      const d = await get(`https://www.okx.com/api/v5/market/candles?instId=${id}&bar=${bar}&limit=300`); await sleep(70);
      if (!d) { bad.push(id + ' ' + bar); continue; }
      const rows = d.filter(x => x[8] === '1').reverse();
      out[bar] = { time: rows.map(x => +x[0] / 1000), open: rows.map(x => +x[1]), high: rows.map(x => +x[2]), low: rows.map(x => +x[3]), close: rows.map(x => +x[4]), vol: rows.map(x => +x[5]) };
    }
    fs.writeFileSync(`${DIR}/${id.split('-')[0]}.json`, JSON.stringify(out)); ok++;
  }
  fs.writeFileSync(DIR + '/_meta.json', JSON.stringify({ fetchedAt: Date.now(), ok, bad }));
  console.log('fetched', ok, 'coins; failed:', bad.length ? bad.join(', ') : 'none');
})();
