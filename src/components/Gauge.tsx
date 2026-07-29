import { useEffect, useState } from "react";

interface Props {
  score: number; // -5..+5
}

const VIEWBOX = "0 0 300 175";
// Půlkruhový oblouk, střed (150,150), poloměr 110 — stejná geometrie jako design handoff.
const ARC_PATH = "M 40 150 A 110 110 0 0 1 260 150";

export function Gauge({ score }: Props) {
  const clamped = Math.max(-5, Math.min(5, score));
  // -90° = bearish (vlevo), 0° = neutrální (nahoru), +90° = bullish (vpravo).
  const targetAngle = (clamped / 5) * 90;

  // Jehla se při mountu (a při každé změně skóre) "vysune" z 0° do cílového úhlu přes CSS
  // transition, ne skokem — první render musí jít s angle=0, aby transition měla co animovat.
  const [angle, setAngle] = useState(0);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setAngle(targetAngle));
    return () => cancelAnimationFrame(raf);
  }, [targetAngle]);

  return (
    <div className="relative w-full max-w-[320px] mx-auto">
      <svg viewBox={VIEWBOX} className="w-full overflow-visible block">
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

        {/* Tmavá dráha za obloukem — dřív byl jen samotný gradient, teď má za sebou hloubku. */}
        <path d={ARC_PATH} fill="none" stroke="#1b2130" strokeWidth={18} strokeLinecap="round" />
        <path
          d={ARC_PATH}
          fill="none"
          stroke="url(#gaugeGrad)"
          strokeWidth={11}
          strokeLinecap="round"
          opacity={0.95}
        />

        {/* Rysky na -90°/0°/+90°. */}
        <line x1={150} y1={33} x2={150} y2={45} stroke="#2a3242" strokeWidth={2} />
        <line x1={62} y1={88} x2={72} y2={95} stroke="#2a3242" strokeWidth={2} />
        <line x1={238} y1={88} x2={228} y2={95} stroke="#2a3242" strokeWidth={2} />

        <g
          style={{
            transformOrigin: "150px 150px",
            transform: `rotate(${angle}deg)`,
            transition: "transform 900ms cubic-bezier(.16,1,.3,1)",
          }}
        >
          <polygon points="150,50 145,150 150,161 155,150" fill="#5e7cfb" />
          <circle cx={150} cy={150} r={9} fill="#11151d" stroke="#5e7cfb" strokeWidth={3} />
        </g>
      </svg>

      <div className="flex justify-between text-[9.5px] tracking-[0.1em] text-faint font-bold -mt-2 px-1">
        <span>BEARISH</span>
        <span>NEUTRÁLNÍ</span>
        <span>BULLISH</span>
      </div>
    </div>
  );
}
