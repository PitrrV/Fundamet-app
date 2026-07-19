import type { CurrencyData } from "./types";

export const CURRENCIES: CurrencyData[] = [
  {
    code: "USD",
    score: -1.2,
    convictionLabel: "NÍZKÁ CONVICTION",
    summary:
      "Dolar zůstává bez jasného směru — **slabší než čekaná jádrová inflace** kontrastuje se **silným trhem práce**. Sazbové futures zaceňují přibližně dva poklesy sazby Fedu do konce roku, což je v souladu s posledním dot plotem. Dlouhodobý makro bias je **neutrální až mírně bearish**, tažený rostoucím fiskálním deficitem.",
    cotPositioning: "Blízko neutrálu",
    pricedIn: "~55 % v ceně",
    longTermBias: "Neutrální až mírně bearish",
    events: [
      {
        date: "22. 7.",
        title: "Maloobchodní tržby",
        subtitle: "Konsensus 0.3 % · Předchozí 0.1 %",
        importance: "STŘEDNÍ",
        pricedInPct: 45,
        verdict: "Neutrální",
        detail: {
          consensusVsHistory: "Mírné zrychlení",
          pricedInMarket: "~45 %",
          cotExtreme: "Ne",
          historicalReaction: {
            label: "5 / 9",
            trendUp: true,
            bars: [0.4, -0.3, 0.5, -0.2, 0.6, 0.3, -0.4, 0.5, 0.2],
          },
          reasoning:
            "Data jsou blízko konsensu, trh nemá silnou předchozí pozici — reakce by měla být **omezená a krátkodobá**.",
        },
      },
      {
        date: "31. 7.",
        title: "FOMC Rozhodnutí o sazbách",
        subtitle: "Konsensus: beze změny · Focus na dot plot",
        importance: "VYSOKÁ",
        pricedInPct: 80,
        verdict: "Neutrální",
        detail: {
          consensusVsHistory: "Beze změny",
          pricedInMarket: "~80 %",
          cotExtreme: "Ne",
          historicalReaction: {
            label: "4 / 9",
            trendUp: false,
            bars: [0.3, -0.5, 0.2, -0.6, 0.4, -0.3, 0.5, -0.4, -0.2],
          },
          reasoning:
            "Rozhodnutí je téměř plně zaceněné, klíčový bude **tón k zářijovému zasedání**. Bez extrémního COT pozicování je prostor pro překvapení symetrický.",
        },
      },
    ],
  },
  {
    code: "EUR",
    score: 2.4,
    convictionLabel: "STŘEDNÍ CONVICTION",
    summary:
      "Krátkodobě je EUR podpořeno **lepším než čekaným PMI** a poklesem short pozic velkých hráčů za poslední 2 týdny. Trh ale podle sazbových futures z velké části **již zaceňuje** jedno snížení sazby ECB v září — pozitivní překvapení v datech proto pravděpodobně vyvolá jen omezenou reakci. Dlouhodobý makro bias zůstává **mírně bullish**, poháněný relativně jestřábí rétorikou ECB oproti Fedu.",
    cotPositioning: "Blízko extrému (long)",
    pricedIn: "~70 % v ceně",
    longTermBias: "Mírně bullish",
    events: [
      {
        date: "21. 7.",
        title: "PMI Služby (flash)",
        subtitle: "Konsensus 52.1 · Předchozí 51.6",
        importance: "STŘEDNÍ",
        pricedInPct: 40,
        verdict: "Souhlasí",
        detail: {
          consensusVsHistory: "Mírné zrychlení",
          pricedInMarket: "~40 %",
          cotExtreme: "Ano — long",
          historicalReaction: {
            label: "6 / 9",
            trendUp: true,
            bars: [0.5, -0.2, 0.6, 0.3, -0.3, 0.5, 0.4, -0.2, 0.5],
          },
          reasoning:
            "Data nejsou plně zaceněná a COT pozicování je blízko extrému — pozitivní překvapení má prostor vyvolat **další nákupy**, negativní by mohlo spustit rychlou korekci.",
        },
      },
      {
        date: "24. 7.",
        title: "Ifo Business Climate (DE)",
        subtitle: "Konsensus 89.4 · Předchozí 88.9",
        importance: "STŘEDNÍ",
        pricedInPct: 55,
        verdict: "Souhlasí",
        detail: {
          consensusVsHistory: "Mírné zlepšení",
          pricedInMarket: "~55 %",
          cotExtreme: "Ano — long",
          historicalReaction: {
            label: "5 / 9",
            trendUp: true,
            bars: [0.3, 0.4, -0.2, 0.5, -0.3, 0.4, 0.2, -0.1, 0.5],
          },
          reasoning:
            "Sentiment ukazatel s částečnou korelací k PMI. Trh je již částečně připraven na zlepšení, reakce proto bude **mírnější než u PMI**.",
        },
      },
      {
        date: "30. 7.",
        title: "ECB Rozhodnutí o sazbách",
        subtitle: "Konsensus: beze změny · Focus na rétoriku",
        importance: "VYSOKÁ",
        pricedInPct: 85,
        verdict: "Neutrální",
        detail: {
          consensusVsHistory: "Beze změny",
          pricedInMarket: "~85 %",
          cotExtreme: "Ano — long",
          historicalReaction: {
            label: "6 / 9",
            trendUp: true,
            bars: [0.5, -0.3, 0.4, 0.6, -0.2, 0.5, -0.4, 0.6, 0.3],
          },
          reasoning:
            "Trh má už z 85 % zaceněné, že sazba zůstane beze změny — reakce proto bude záviset téměř výhradně na tónu tiskové konference, ne na samotném rozhodnutí. V posledních 9 srovnatelných zasedáních vedla jestřábí rétorika k pohybu EUR nahoru v 6 případech. Kombinace s dlouhodobě mírně bullish bias a COT pozicováním blízko extrému znamená **střední conviction**, ne vysokou — extrémní pozicování zároveň zvyšuje riziko prudké korekce, pokud rétorika překvapí holubičím tónem.",
        },
      },
    ],
  },
  {
    code: "GBP",
    score: -3.1,
    convictionLabel: "VYSOKÁ CONVICTION",
    summary:
      "Libra je pod tlakem kvůli **slabším datům z trhu práce** a rostoucím sázkám na zářijové snížení sazby BoE. COT pozicování velkých spekulantů se přehouplo do **čistého shortu poprvé za 4 měsíce**, což potvrzuje směr příběhu. Trh dle OIS zaceňuje více než jedno snížení sazby do konce roku — **zaceněnost je vysoká**, ale dlouhodobý bias zůstává jasně bearish kvůli fiskálním obavám.",
    cotPositioning: "Čistý short (nově)",
    pricedIn: "~75 % v ceně",
    longTermBias: "Bearish",
    events: [
      {
        date: "23. 7.",
        title: "CPI (meziročně)",
        subtitle: "Konsensus 2.6 % · Předchozí 2.8 %",
        importance: "VYSOKÁ",
        pricedInPct: 60,
        verdict: "Souhlasí",
        detail: {
          consensusVsHistory: "Pokles",
          pricedInMarket: "~60 %",
          cotExtreme: "Ano — short",
          historicalReaction: {
            label: "7 / 9",
            trendUp: false,
            bars: [-0.5, 0.3, -0.6, -0.4, 0.2, -0.5, -0.3, 0.4, -0.6],
          },
          reasoning:
            "Nižší inflace by potvrdila cestu k zářijovému snížení sazby — v kombinaci s **novým čistým short pozicováním** je prostor pro pokračování trendu výrazně asymetrický směrem dolů.",
        },
      },
      {
        date: "1. 8.",
        title: "BoE Rozhodnutí o sazbách",
        subtitle: "Konsensus: beze změny · Riziko snížení",
        importance: "VYSOKÁ",
        pricedInPct: 65,
        verdict: "Souhlasí",
        detail: {
          consensusVsHistory: "Riziko překvapivého snížení",
          pricedInMarket: "~65 %",
          cotExtreme: "Ano — short",
          historicalReaction: {
            label: "7 / 9",
            trendUp: false,
            bars: [-0.4, -0.5, 0.2, -0.6, -0.3, 0.3, -0.5, -0.4, -0.2],
          },
          reasoning:
            "Menšina trhu už sází na překvapivé snížení — pokud se naplní, **shortové pozice přidají na síle pohybu**. Vysoká conviction díky shodě všech tří pilířů příběhu.",
        },
      },
    ],
  },
  {
    code: "CAD",
    score: 0.3,
    convictionLabel: "NÍZKÁ CONVICTION",
    summary:
      "Kanadský dolar se obchoduje bez jasného vlastního příběhu — pohyb je z velké části **vedený cenou ropy a náladou k USD**. COT pozicování je blízko neutrálu a data z posledních týdnů byla smíšená. Dlouhodobý bias je **neutrální**, BoC zatím nesignalizuje jasný směr dalších kroků.",
    cotPositioning: "Neutrální",
    pricedIn: "~50 % v ceně",
    longTermBias: "Neutrální",
    events: [
      {
        date: "25. 7.",
        title: "CPI (meziročně)",
        subtitle: "Konsensus 2.0 % · Předchozí 1.9 %",
        importance: "STŘEDNÍ",
        pricedInPct: 50,
        verdict: "Neutrální",
        detail: {
          consensusVsHistory: "Mírné zrychlení",
          pricedInMarket: "~50 %",
          cotExtreme: "Ne",
          historicalReaction: {
            label: "4 / 8",
            trendUp: true,
            bars: [0.3, -0.4, 0.2, -0.3, 0.4, -0.2, 0.3, -0.3],
          },
          reasoning:
            "Bez extrémního pozicování a s daty blízko konsensu chybí katalyzátor pro silný směrový pohyb — **conviction je nízká**.",
        },
      },
      {
        date: "4. 8.",
        title: "BoC Rozhodnutí o sazbách",
        subtitle: "Konsensus: beze změny",
        importance: "VYSOKÁ",
        pricedInPct: 70,
        verdict: "Neutrální",
        detail: {
          consensusVsHistory: "Beze změny",
          pricedInMarket: "~70 %",
          cotExtreme: "Ne",
          historicalReaction: {
            label: "5 / 8",
            trendUp: true,
            bars: [0.3, -0.3, 0.4, -0.2, 0.5, -0.4, 0.3, -0.2],
          },
          reasoning:
            "Bez jasného makro bias ani extrémního pozicování je reakce obtížně predikovatelná — **nízká conviction**, primárně sledovat tón k inflaci.",
        },
      },
    ],
  },
];
