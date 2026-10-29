// Daily paper-trading report for Telegram. Runs in GitHub Actions (paper-daily.yml) from paper_summary.json,
// which the laptop's 06:15 Top-25 paper run writes and pushes (OKX Backtest Engine/paper_daily_message.js).
// If the laptop was off, the summary is old and the message says so, instead of going quiet.
//   node paper_daily.js --dry     print the message (no Telegram needed)
//   node paper_daily.js           send it
//   node paper_daily.js --test    send a short test message
// Needs env TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (same repo secrets as vol_alerts.js). Nothing secret lives in this file.
//
// Pro-trader layout: rank on $ only with enough trades, show N / win / PF / $ / expectancy / DD on every line,
// and judge each strategy against its OWN backtest PF. Monospace blocks <= 34 chars wide for a phone.
const fs = require('fs');

const SUMMARY = process.env.SUMMARY_FILE || 'paper_summary.json';
const PAGE = 'https://mrufolegend.github.io/mr-ufo-crypto-daily/paper-top25.html';
const MIN_N_PNL = 5, MIN_N_WIN = 10, JUDGE_N = 15, TOP = 10, W = 34, STALE_H = 26;
const args = process.argv.slice(2), DRY = args.includes('--dry');

const usd = x => (x >= 0 ? '+$' : '-$') + Math.abs(Math.round(x)).toLocaleString('en-US');
const pf = x => x == null || !isFinite(x) ? ' -- ' : x >= 10 ? ' 10+' : x.toFixed(2);
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const short = n => n.replace(/^Stonehill #\d+\s*/, '').replace(/^TV Editor's Pick\s*/, '').replace(/^(QuantifiedStrategies|Quantpedia|CoinGlass Learn)\s*/, '')
  .replace(/\s*[\[(].*$/, '').replace(/\s+-\s+.*$/, '').trim();
const fit = (l, r) => { const room = W - r.length - 1; return (l.length > room ? l.slice(0, room - 1) + '…' : l.padEnd(room)) + ' ' + r; };
// verdict vs its own backtest: too early / on track / profitable but below / losing
const status = (n, paperPf, btPf) => n < JUDGE_N ? '⏳' : paperPf >= Math.min(btPf, 1.2) ? '✅' : paperPf >= 1 ? '🟡' : '🔴';

function build(sum, now = Date.now()) {
  const S = sum.strategies;
  const card = (i, s) => fit(`${i}. ${short(s.name)} #${s.rank}`, usd(s.pnlUsd)) + '\n' +
    `   n${String(s.n).padEnd(3)} W${(s.win == null ? '--' : s.win.toFixed(0) + '%').padEnd(4)} PF${pf(s.pf)} ${usd(s.n ? s.realizedUsd / s.n : 0)}/t\n` +
    `   DD ${s.dd.toFixed(1)}%  BT PF ${pf(s.btPf)} ${status(s.n, s.pf, s.btPf)}`;
  const ageH = (now - Date.parse(sum.generatedAt)) / 3600e3;
  const tot = k => S.reduce((a, s) => a + s[k], 0);
  const judged = S.filter(s => s.n >= JUDGE_N), cnt = k => judged.filter(s => status(s.n, s.pf, s.btPf) === k).length;
  const dateStr = new Date(now).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/Amsterdam' });
  const byPnl = S.filter(s => s.n >= MIN_N_PNL).sort((a, b) => b.pnlUsd - a.pnlUsd).slice(0, TOP);
  const byWin = S.filter(s => s.n >= MIN_N_WIN).sort((a, b) => b.win - a.win || b.pf - a.pf).slice(0, TOP);

  const L = [];
  L.push(`📊 <b>PAPER DESK — ${dateStr}</b>`);
  if (ageH > STALE_H) L.push(`❌ <b>Data is ${Math.round(ageH)}h old</b> (laptop off or run failed). Numbers below are from ${sum.lastBar}.`);
  L.push(`<pre>${[
    fit('Total P&L', usd(tot('pnlUsd'))), fit('Today', usd(tot('dayUsd'))), fit('Realized', `${usd(tot('realizedUsd'))} (${tot('n')} tr)`),
    fit('Open', `${tot('openN')} pos  ${usd(tot('openUsd'))}`),
    fit(`Judged (n≥${JUDGE_N})`, `${judged.length} of ${S.length}`), fit('  vs backtest', `✅${cnt('✅')} 🟡${cnt('🟡')} 🔴${cnt('🔴')}`),
  ].map(esc).join('\n')}</pre>`);
  L.push(`🏆 <b>TOP 10 — $ P&amp;L</b> (n≥${MIN_N_PNL})`);
  L.push(`<pre>${byPnl.map((s, i) => esc(card(i + 1, s))).join('\n')}</pre>`);
  L.push(`🎯 <b>TOP 10 — WIN RATE</b> (n≥${MIN_N_WIN})`);
  L.push(`<pre>${byWin.map((s, i) => esc(card(i + 1, s))).join('\n')}</pre>`);

  const A = sum.accounts;
  if (A) {
    L.push('🧪 <b>PAPER ACCOUNTS</b> ($10k each)');
    L.push(`<pre>${A.list.map(a => esc(fit(a.label + (a.open ? ' ' + a.open : '') + (a.cap ? ` ${a.n}/${a.cap}` : ''), usd(a.pnlUsd)) + '\n' +
      `   n${String(a.n).padEnd(3)} W${(a.n ? (100 * a.wins / a.n).toFixed(0) + '%' : '--').padEnd(4)} PF${pf(a.gl ? a.gp / a.gl : null)} ${usd(a.n ? (a.gp - a.gl) / a.n : 0)}/t\n` +
      `   DD ${a.dd.toFixed(1)}%${a.expR != null ? `  ${(a.expR >= 0 ? '+' : '') + a.expR.toFixed(2)}R/t` : ''}  ${a.n < JUDGE_N ? '⏳' : a.gp > a.gl ? '✅' : '🔴'}`)).join('\n')}</pre>`);
  }

  // what needs a decision, worst first
  const flags = [];
  if (A && (now - A.updatedAt) / 3600e3 > STALE_H) flags.push('❌ VWAP/accounts data is stale');
  const fails = judged.filter(s => status(s.n, s.pf, s.btPf) === '🔴').sort((a, b) => a.pnlUsd - b.pnlUsd);
  for (const s of fails.slice(0, 5)) flags.push(`🔴 ${short(s.name).slice(0, 16)} #${s.rank}: PF ${pf(s.pf)} vs BT ${pf(s.btPf)}, n${s.n}`);
  if (fails.length > 5) flags.push(`   …+${fails.length - 5} more failing vs backtest`);
  for (const s of S.filter(s => s.dd >= 5)) flags.push(`🛑 ${short(s.name).slice(0, 16)} #${s.rank}: DD ${s.dd.toFixed(1)}%`);
  if (A) for (const a of A.list) if (a.cap && a.n >= a.cap) flags.push(`🏁 ${a.label} hit ${a.n}/${a.cap} → retire`);
  if (!flags.length) flags.push('✅ Nothing needs action');
  L.push('🚦 <b>NEEDS A DECISION</b>');
  L.push(flags.map(esc).join('\n'));
  L.push('');
  L.push('⏳ n&lt;15 too early · ✅ PF on track vs backtest · 🟡 PF&gt;1 but below BT · 🔴 PF&lt;1');
  L.push(`🔗 <a href="${PAGE}">Full dashboard</a> · data to ${esc(sum.lastBar)}`);
  return L.join('\n');
}

async function send(html) {
  if (DRY) return console.log(html.replace(/<\/?(b|pre)>/g, '').replace(/<a href="([^"]+)">([^<]+)<\/a>/g, '$2').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') + `\n\n[${html.length} chars; Telegram limit 4096]`);
  const { TELEGRAM_BOT_TOKEN: tok, TELEGRAM_CHAT_ID: chat } = process.env;
  if (!tok || !chat) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set');
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true }) });
  const j = await r.json();
  if (!j.ok) throw new Error('Telegram: ' + j.description);
}

module.exports = { build };
if (require.main === module) (async () => {
  if (args.includes('--test')) { await send('✅ <b>Paper desk report connected</b>\nYou\'ll get the paper-trading summary here every morning around 07:30.'); return console.log('test message sent'); }
  let sum = null;
  try { sum = JSON.parse(fs.readFileSync(SUMMARY, 'utf8')); } catch (e) { }
  await send(sum ? build(sum) : '❌ <b>Paper desk</b>: no paper_summary.json found in the repo. Has the laptop run the Top-25 paper task yet?');
  if (!DRY) console.log('paper report sent');
})().catch(e => { console.error(e); process.exit(1); });
