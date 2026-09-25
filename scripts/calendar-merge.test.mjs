import { test } from "node:test";
import assert from "node:assert/strict";
import { planCalendarMerge } from "./calendar-merge.mjs";

const NOW = "2026-09-25T05:10:00.000Z";
const base = {
  currency_code: "JPY",
  event_title: "BOJ Core CPI y/y",
  event_day: "2026-09-25",
  event_time: "2026-09-25T05:00:00.000Z",
  impact: "Low",
  actual: null,
  estimate: "1.5%",
  previous: "1.6%",
};

test("new event (not in DB) is written", () => {
  const { rows, unchanged } = planCalendarMerge([base], [], NOW);
  assert.equal(rows.length, 1);
  assert.equal(unchanged, 0);
  assert.equal(rows[0].updated_at, NOW);
});

test("identical event is skipped, event_time format difference is not a change", () => {
  const existing = { ...base, event_time: "2026-09-25T05:00:00+00:00" };
  const { rows, unchanged } = planCalendarMerge([base], [existing], NOW);
  assert.equal(rows.length, 0);
  assert.equal(unchanged, 1);
});

test("fresh actual is written and marks the currency as material", () => {
  const scraped = { ...base, actual: "1.8%" };
  const { rows, materialCurrencies } = planCalendarMerge([scraped], [base], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actual, "1.8%");
  assert.ok(materialCurrencies.has("JPY"));
});

test("re-scrape without actual never erases a previously captured actual", () => {
  const existing = { ...base, actual: "1.8%" };
  const { rows, unchanged, materialCurrencies } = planCalendarMerge([base], [existing], NOW);
  assert.equal(rows.length, 0);
  assert.equal(unchanged, 1);
  assert.equal(materialCurrencies.size, 0);
});

test("impact or event_time revision is written, keeping the existing actual", () => {
  const existing = { ...base, actual: "1.8%" };
  const scraped = { ...base, impact: "Medium" };
  const { rows } = planCalendarMerge([scraped], [existing], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].impact, "Medium");
  assert.equal(rows[0].actual, "1.8%");
});

test("actual on an event without EVENT_RULES weight is written but not material", () => {
  const noWeight = { ...base, event_title: "Bank Holiday" };
  const { rows, materialCurrencies } = planCalendarMerge([{ ...noWeight, actual: "x" }], [noWeight], NOW);
  assert.equal(rows.length, 1);
  assert.equal(materialCurrencies.size, 0);
});
