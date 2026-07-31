// Průzkum bezplatných zdrojů intradenního VIX — žádný zápis do DB, jen log výstupů.

async function tryFetch(label, url, opts = {}) {
  console.log(`\n=== ${label} ===`);
  console.log(url);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, ...opts });
    console.log("status:", res.status);
    const text = await res.text();
    console.log("body (prvních 1500 znaků):", text.slice(0, 1500));
  } catch (err) {
    console.log("CHYBA:", err.message);
  }
}

// 1) Yahoo Finance neoficiální chart API — žádný klíč, hojně používané v komunitních projektech.
await tryFetch("Yahoo Finance ^VIX chart", "https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d");

// 2) Yahoo Finance query2 (alternativní hostname, pro případ že query1 je blokované/throttlované)
await tryFetch("Yahoo Finance query2 ^VIX chart", "https://query2.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d");

// 3) Stooq CSV — žádný klíč
await tryFetch("Stooq ^VIX CSV", "https://stooq.com/q/l/?s=^vix&f=sd2t2ohlcv&h&e=csv");

// 4) CBOE přímo (pro srovnání, jestli má veřejně dostupný jednoduchý endpoint)
await tryFetch("CBOE VIX current", "https://cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json");

console.log("\n=== aktuální čas (UTC) ===");
console.log(new Date().toISOString());
