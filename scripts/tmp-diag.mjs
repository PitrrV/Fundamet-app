const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

// Ukázka s reálnými čísly (AUD/CAD z aktuálních dat), ale ručně sestavená — jen ukázka
// formátu, nezasahuje do žádných produkčních dat.
const text =
  `📈 <b>AUD</b> +0.5 bodu → celkem <b>+1.9</b>\n\n` +
  `Nejsilnější: AUD (+1.9)\n` +
  `Nejslabší: CAD (-1.8)\n\n` +
  `<i>(ukázka formátu, ne reálný alert)</i>`;

const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
});

console.log("HTTP status:", res.status);
console.log(await res.text());
