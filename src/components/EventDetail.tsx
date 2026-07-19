import type { ReactNode } from "react";
import type { MacroEvent } from "../types";
import { RichText } from "./RichText";

interface Props {
  event: MacroEvent;
}

function ReactionBars({ bars }: { bars: number[] }) {
  return (
    <div className="flex items-end gap-1 h-8">
      {bars.map((v, i) => {
        const positive = v >= 0;
        const height = Math.max(4, Math.abs(v) * 32);
        return (
          <div
            key={i}
            className={`w-2 rounded-sm ${positive ? "bg-emerald-500" : "bg-red-500/70"}`}
            style={{ height }}
          />
        );
      })}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bg-panel border border-panelborder rounded-lg p-4">
      <div className="text-xs tracking-wide text-muted mb-2">{label}</div>
      <div className="font-mono text-lg text-slate-100">{children}</div>
    </div>
  );
}

export function EventDetail({ event }: Props) {
  const { detail } = event;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="KONSENSUS VS. HISTORIE">{detail.consensusVsHistory}</Field>
        <Field label="ZACENĚNO TRHEM">{detail.pricedInMarket}</Field>
        <Field label="COT EXTRÉM">
          <span className={detail.cotExtreme.startsWith("Ano") ? "text-emerald-400" : ""}>
            {detail.cotExtreme}
          </span>
        </Field>
        <Field label="HISTORICKÁ REAKCE">
          <div className="flex items-center gap-2 mb-2">
            <span>{detail.historicalReaction.label}</span>
            <span className={detail.historicalReaction.trendUp ? "text-emerald-400" : "text-red-400"}>
              {detail.historicalReaction.trendUp ? "↑" : "↓"}
            </span>
          </div>
          <ReactionBars bars={detail.historicalReaction.bars} />
        </Field>
      </div>

      <div className="bg-panel border-l-4 border-gold border-t border-r border-b border-panelborder rounded-lg p-5">
        <div className="text-xs tracking-wide text-gold mb-2">ZDŮVODNĚNÍ SKÓRE</div>
        <RichText text={detail.reasoning} className="text-sm leading-relaxed text-slate-300" />
      </div>
    </div>
  );
}
