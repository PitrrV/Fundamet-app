interface Tab {
  code: string;
  score: number;
}

interface Props {
  currencies: Tab[];
  selected: string;
  onSelect: (code: string) => void;
}

export function CurrencyTabs({ currencies, selected, onSelect }: Props) {
  return (
    <div className="flex gap-2 overflow-x-auto">
      {currencies.map(({ code, score }) => {
        const active = code === selected;
        const dotColor = score > 0.05 ? "bg-pos" : score < -0.05 ? "bg-neg" : "bg-muted";
        return (
          <button
            key={code}
            onClick={() => onSelect(code)}
            className={`shrink-0 flex items-center gap-2 px-4 py-2 rounded-md text-sm font-bold border transition-colors duration-200 ${
              active
                ? "bg-accent/[.14] border-accent/50 text-ink"
                : "border-line text-muted hover:border-line2"
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
            <span>{code}</span>
            <span className="font-mono text-xs opacity-75">
              {score > 0 ? "+" : ""}
              {score.toFixed(1)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
