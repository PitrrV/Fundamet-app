interface Props {
  currencies: string[];
  selected: string;
  onSelect: (code: string) => void;
}

export function CurrencyTabs({ currencies, selected, onSelect }: Props) {
  return (
    <div className="flex gap-2">
      {currencies.map((code) => {
        const active = code === selected;
        return (
          <button
            key={code}
            onClick={() => onSelect(code)}
            className={`px-4 py-2 rounded-md text-sm font-medium border transition-colors ${
              active
                ? "border-gold text-gold bg-gold/5"
                : "border-panelborder text-muted hover:text-slate-200 hover:border-slate-500"
            }`}
          >
            {code}
          </button>
        );
      })}
    </div>
  );
}
