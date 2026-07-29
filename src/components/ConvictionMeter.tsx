// 5-segmentový bar meter nahrazující ★★★☆☆ glyfy — čistší a víc "institucionální" než
// hvězdičky, používá se v gauge kartě i v kartě makro teze.
export function ConvictionMeter({ filled }: { filled: number }) {
  const segments = Array.from({ length: 5 }, (_, i) => i < filled);
  return (
    <div className="flex justify-center gap-[3px]">
      {segments.map((isFilled, i) => (
        <span key={i} className={`w-[18px] h-[5px] rounded-sm ${isFilled ? "bg-accent" : "bg-line2"}`} />
      ))}
    </div>
  );
}
