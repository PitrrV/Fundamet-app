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
                ? "border-accent text-accent bg-accent/10"
                : "border-line text-muted hover:text-ink hover:border-line2"
            }`}
          >
            {code}
          </button>
        );
      })}
    </div>
  );
}
