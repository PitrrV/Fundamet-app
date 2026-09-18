// Jednorázový diagnostický skript — ověří, že appka umí reálně doručit Telegram zprávu se
// stejnými secrets (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID), jaké používá ostrá
// sendTelegramAlert() ve fetch-calendar.mjs. Nic nezapisuje do DB, nesahá na
// rate_decision_estimate_history ani žádná jiná data — jen jeden test POST na Telegram Bot API.
// Po ověření se tenhle soubor i workflow, co ho spouští, smažou (viz commit).

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
  console.error("Chybí TELEGRAM_BOT_TOKEN nebo TELEGRAM_CHAT_ID — test nelze provést.");
  process.exit(1);
}

const text =
  "🧪 <b>Test alertu</b> — takhle bude vypadat upozornění na revizi konsensu sazbového rozhodnutí, " +
  "např.:\n\n📊 <b>USD</b> — konsensus na \"Federal Funds Rate\" se posunul: 3.75 % → 4.00 %\n" +
  "Rozhodnutí za 3 dny (2026-09-21), aktuální sazba 3.75 %.\n\n" +
  "Pokud tohle vidíš, Telegram alerty na revizi konsensu jsou funkční.";

const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
});

if (res.ok) {
  console.log("Testovací Telegram zpráva odeslána úspěšně.");
} else {
  console.error(`Odeslání selhalo: HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}
