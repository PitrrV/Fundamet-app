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
          <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#d9534f" />
            <stop offset="22%" stopColor="#e8934f" />
            <stop offset="42%" stopColor="#e8c94f" />
            <stop offset="58%" stopColor="#b9d46a" />
            <stop offset="75%" stopColor="#5f9ea8" />
            <stop offset="90%" stopColor="#3d5a8a" />
            <stop offset="100%" stopColor="#1c2540" />
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
          stroke="#e8b756"
          strokeWidth={2.5}
          strokeLinecap="round"
        />
        <circle cx={CX} cy={CY} r={5} fill="#e8b756" />
      </svg>

      <div className="flex justify-between text-[11px] tracking-wide text-muted -mt-2 px-2">
        <span>BEARISH</span>
        <span>NEUTRÁLNÍ</span>
        <span>BULLISH</span>
      </div>
    </div>
  );
}
