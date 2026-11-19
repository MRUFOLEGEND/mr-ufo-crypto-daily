// Live wedge scanner: finds wedges that are FORMING (price still inside) or TRIGGERED (first close through the
// trigger line in the last 3 closed bars) on 15m / 1H / 4H, checks 4H order-block confluence and the checklist,
// and writes live/scan.json. Input: live/*.json from live_fetch.js. Derivatives (funding, OI) fetched for hits only.
// The scan logic itself lives in scan_core.js (shared with the page's in-browser "Scan now").
const fs = require('fs');
const { scanAll, derFrom } = require('./scan_core.js');
const DIR = __dirname + '/live';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url) { for (let t = 0; t < 4; t++) { try { const j = await (await fetch(url)).json(); if (j.code === '0') return j.data; } catch (e) {} await sleep(1200); } return null; }

(async () => {
  const meta = JSON.parse(fs.readFileSync(DIR + '/_meta.json', 'utf8'));
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json') && !f.startsWith('_') && f !== 'scan.json');
  const D = {};
  for (const f of files) D[f.replace('.json', '')] = JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8'));
  const list = await scanAll(D, async s => {
    const id = `${s}-USDT-SWAP`;
    const fr = await get(`https://www.okx.com/api/v5/public/funding-rate?instId=${id}`); await sleep(120);
    const oi = await get(`https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-history?instId=${id}&period=4H&limit=8`); await sleep(220);
    return derFrom(fr, oi);
  });
  fs.writeFileSync(DIR + '/scan.json', JSON.stringify({ at: meta.fetchedAt, coins: files.length, list }));
  const cnt = k => list.filter(h => h.level === k).length;
  console.log(`${list.length} wedges on ${new Set(list.map(h => h.sym)).size} coins | WATCH ${cnt('WATCH')} WEAK ${cnt('WEAK')} TESTED ${cnt('TESTED OB')} NO-OB ${cnt('NO OB')} | forming ${list.filter(h => h.status === 'FORMING').length} triggered ${list.filter(h => h.status === 'TRIGGERED').length}`);
  for (const h of list.slice(0, 12)) console.log(h.level.padEnd(9), h.sym.padEnd(9), h.tf.padEnd(4), h.type.padEnd(14), h.status.padEnd(9), 'score', h.score, 'entry', +h.entry.toPrecision(5), 'stop', +h.stop.toPrecision(5), 'risk%', h.riskPct.toFixed(2), 'RRzone', h.rrZone && h.rrZone.toFixed(1), JSON.stringify(h.der));
})();
