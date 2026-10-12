import test from "node:test";
import assert from "node:assert/strict";
import { findAgendaIssues } from "./check-agenda-freshness.mjs";

const TODAY = "2026-10-12";
const cal = (currency_code, event_title, event_day, actual = null) => ({ currency_code, event_title, event_day, actual });

test("zastaralá agenda: chybí výsledek, stará položka, chybějící CPI", () => {
  const agenda = { USD: [{ event: "Retail Sales m/m", date: "2026-10-10", outcome: null }, { event: "Unemployment Rate", date: "2026-10-02", outcome: "Vyšlo to dobře pro dolar." }] };
  const events = [cal("USD", "Retail Sales m/m", "2026-10-10", "1.2"), cal("USD", "CPI y/y", "2026-10-14")];
  const kinds = findAgendaIssues(agenda, events, TODAY).map((i) => i.kind).sort();
  assert.deepEqual(kinds, ["bez_vysledku", "chybi", "stara_polozka"]);
});

test("čerstvá agenda nehlásí nic", () => {
  const agenda = { USD: [{ event: "CPI y/y", date: "2026-10-14", outcome: null }] };
  assert.deepEqual(findAgendaIssues(agenda, [cal("USD", "CPI y/y", "2026-10-14")], TODAY), []);
});

test("nedůležitá nebo vzdálená událost nevadí", () => {
  const events = [cal("USD", "Bank Holiday", "2026-10-13"), cal("USD", "CPI y/y", "2026-10-30")];
  assert.deepEqual(findAgendaIssues({ USD: [] }, events, TODAY), []);
});
