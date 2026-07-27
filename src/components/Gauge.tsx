interface Props {
  score: number; // -5..+5
}

const CX = 150;
const CY = 150;
const R = 110;
const NEEDLE_R = 95;

function pointOnArc(radius: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: CX + radius * Math.cos(rad),
    y: CY - radius * Math.sin(rad),
  };
}

export function Gauge({ score }: Props) {
  const clamped = Math.max(-5, Math.min(5, score));
  const needleAngle = 180 - ((clamped + 5) / 10) * 180;
  const needleTip = pointOnArc(NEEDLE_R, needleAngle);

  const arcStart = pointOnArc(R, 180);
  const arcEnd = pointOnArc(R, 0);

  return (
    <div className="relative w-full max-w-[320px] mx-auto">
      <svg viewBox="0 0 300 170" className="w-full">
        <defs>
          {/* Přechod korálová → jantarová → mátová: přesně sémantické barvy Analyzeru,
              takže záporné/kladné skóre má v obou nástrojích stejný barevný význam. */}
          <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#f2606e" />
            <stop offset="25%" stopColor="#e8794f" />
            <stop offset="45%" stopColor="#e8ab3f" />
            <stop offset="55%" stopColor="#b9c15a" />
            <stop offset="75%" stopColor="#5ec9a8" />
            <stop offset="100%" stopColor="#2ed3a0" />
          </linearGradient>
        </defs>

        <path
          d={`M ${arcStart.x} ${arcStart.y} A ${R} ${R} 0 0 1 ${arcEnd.x} ${arcEnd.y}`}
          fill="none"
          stroke="url(#gaugeGrad)"
          strokeWidth={14}
          strokeLinecap="round"
        />

        <line
          x1={CX}
          y1={CY}
          x2={needleTip.x}
          y2={needleTip.y}
          stroke="#5e7cfb"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
        <circle cx={CX} cy={CY} r={5} fill="#5e7cfb" />
      </svg>

      <div className="flex justify-between text-[10px] tracking-widest text-faint -mt-2 px-2">
        <span>BEARISH</span>
        <span>NEUTRÁLNÍ</span>
        <span>BULLISH</span>
      </div>
    </div>
  );
}
