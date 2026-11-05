// One-time helper: find the chat id for the Aroon Telegram bot.
// 1) Create the bot with the official @BotFather in Telegram, copy the token.
// 2) Open your new bot in Telegram and send it any message (e.g. "hi").
// 3) In PowerShell, in this folder:   $env:AROON_BOT_TOKEN = 'paste-token-here'; node aroon_chat_id.js
// It only READS the bot's recent messages from api.telegram.org and prints the chat id(s). The token is never saved anywhere.
const tok = process.env.AROON_BOT_TOKEN;
if (!tok) { console.error('Set AROON_BOT_TOKEN first (see the comment at the top of this file).'); process.exit(1); }

(async () => {
  const me = await (await fetch(`https://api.telegram.org/bot${tok}/getMe`)).json();
  if (!me.ok) { console.error('Token not accepted by Telegram: ' + me.description); process.exit(1); }
  console.log(`Bot: @${me.result.username} (${me.result.first_name})`);
  const up = await (await fetch(`https://api.telegram.org/bot${tok}/getUpdates`)).json();
  if (!up.ok) { console.error('getUpdates failed: ' + up.description); process.exit(1); }
  const chats = new Map();
  for (const u of up.result) {
    const c = (u.message || u.channel_post || u.my_chat_member || {}).chat;
    if (c) chats.set(c.id, c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || c.type);
  }
  if (!chats.size) { console.log('No messages yet. Send your bot a message in Telegram, then run this again.'); return; }
  for (const [id, name] of chats) console.log(`AROON_CHAT_ID = ${id}   (${name})`);
})();
