const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
  console.error("Chybí TELEGRAM_BOT_TOKEN nebo TELEGRAM_CHAT_ID v prostředí.");
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    chat_id: chatId,
    text: "✅ <b>Test alertu Konfluence</b>\nTohle je zkušební zpráva — pokud tohle vidíte, je propojení na Telegram funkční. Ostré alerty přijdou při pohybu skóre o 0,2 bodu a víc.",
    parse_mode: "HTML",
  }),
});

console.log("HTTP status:", res.status);
console.log(await res.text());
