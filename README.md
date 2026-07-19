# Konfluence — MVP

Informační nástroj zobrazující "confluence skóre" pro hlavní měnové páry
(USD, EUR, GBP, CAD) — syntézu COT pozicování, zaceněnosti trhu a
nadcházejících makro událostí. Neslouží jako investiční doporučení.

Tento build je frontendový mockup MVP se statickými ukázkovými daty
(`src/data.ts`), postavený podle vizuálního návrhu produktu. Napojení na
reálná data (COT reporty, ekonomický kalendář, sazbové futures) je dalším
krokem.

## Vývoj

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Struktura

- `src/data.ts` — ukázková data pro jednotlivé měny a události
- `src/components/Gauge.tsx` — SVG gauge confluence skóre
- `src/components/EventRow.tsx`, `EventDetail.tsx` — kalendář událostí a detail
- `src/App.tsx` — hlavní layout stránky
