-- v2 "Top příležitost týdne": appka už NEskrývá výsledek za hvězdičkovou bránu (viz
-- top-opportunity.mjs) — vždy ukáže nejsilnější/nejslabší měnu podle overall_score a jen
-- odstupňuje tón v `confidence_tier` ('strong' | 'soft' | 'flat').
alter table weekly_top_opportunity add column if not exists confidence_tier text;
