interface Props {
  text: string;
  className?: string;
}

// Renders **bold** segments as bold light text (dřív zlatě — akcent je teď vyhrazený
// interaktivním prvkům, aby zvýraznění v textu nesoupeřilo s tlačítky).
export function RichText({ text, className }: Props) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <span className={className}>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={i} className="text-ink font-bold">
              {part.slice(2, -2)}
            </strong>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </span>
  );
}
