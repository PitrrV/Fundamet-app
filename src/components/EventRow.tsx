import type { MacroEvent } from "../types";
import { importanceBadgeClasses, verdictColor } from "../utils";

interface Props {
  event: MacroEvent;
  selected: boolean;
  onSelect: () => void;
}

export function EventRow({ event, selected, onSelect }: Props) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left bg-panel border rounded-lg p-5 flex items-start justify-between gap-4 transition-colors ${
        selected ? "border-gold/60" : "border-panelborder hover:border-slate-600"
      }`}
    >
      <div>
        <div className="text-xs text-muted font-mono mb-1">{event.date}</div>
        <div className="text-slate-100 font-medium mb-1">{event.title}</div>
        <div className="text-xs text-muted mb-2">{event.subtitle}</div>
        <span
          className={`inline-block text-[11px] tracking-wide px-2 py-0.5 rounded border ${importanceBadgeClasses(
            event.importance
          )}`}
        >
          {event.importance}
        </span>
      </div>

      <div className="text-right shrink-0">
        <div className="text-xs text-muted mb-0.5">Zaceněno</div>
        <div className="font-mono text-slate-100 mb-2">~{event.pricedInPct} %</div>
        <div className="text-xs text-muted mb-0.5">Confluence</div>
        <div className={`font-semibold ${verdictColor(event.verdict)}`}>{event.verdict}</div>
      </div>
    </button>
  );
}
