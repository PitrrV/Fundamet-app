import { useEffect, useRef, useState } from "react";

interface Props {
  audioUrl: string | null;
}

// Tlačítko se zvukovou ikonou u "SHRNUTÍ PŘÍBĚHU" — přehraje AI namluvenou verzi textu
// (OpenAI tts-1, generováno vedle textu v generate-narrative.mjs). Když audio ještě
// neexistuje (narrative bylo vygenerováno před zavedením TTS, nebo TTS krok selhal),
// tlačítko se zobrazí jako neaktivní, ne skryté — je jasné, že funkce existuje, jen pro
// tenhle konkrétní text zatím není namluvená verze.
export function NarrativeAudioButton({ audioUrl }: Props) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    setPlaying(false);
    audioRef.current?.pause();
    audioRef.current = null;
  }, [audioUrl]);

  function toggle() {
    if (!audioUrl) return;

    if (!audioRef.current) {
      const audio = new Audio(audioUrl);
      audio.addEventListener("ended", () => setPlaying(false));
      audioRef.current = audio;
    }

    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      audioRef.current.play().catch(() => setPlaying(false));
      setPlaying(true);
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={!audioUrl}
      title={audioUrl ? (playing ? "Zastavit přečtení" : "Přečíst nahlas") : "Namluvená verze zatím není k dispozici"}
      className={`inline-flex items-center justify-center w-6 h-6 rounded-full border transition-colors ${
        audioUrl
          ? "border-accent/50 text-accent hover:bg-accent/10"
          : "border-line text-faint/50 cursor-not-allowed"
      }`}
    >
      {playing ? (
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
          <rect x="6" y="5" width="4" height="14" />
          <rect x="14" y="5" width="4" height="14" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
          <path d="M8 5v14l11-7z" />
        </svg>
      )}
    </button>
  );
}
