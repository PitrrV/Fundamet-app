/** @type {import('tailwindcss').Config} */
// Paleta převzatá z Fx Analyzeru (PitrrV/Fx-Analyzer, index.html + m.html), aby obě appky
// vypadaly jako jeden nástroj. Hodnoty jsou vytažené přímo z jeho CSS, ne odhadnuté.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Plochy — čtyři úrovně vyvýšení místo jedné, aby šlo odlišit důležitost sekcí.
        bg: "#07080c",
        surface: "#0c0f16",
        surface2: "#11151d",
        surface3: "#161b27",
        // Linky
        line: "#1f2637",
        line2: "#2a3242",
        // Text
        ink: "#eaedf3",
        muted: "#8b93a3",
        // Původní #5a6273 vycházelo proti bg (#07080c) na kontrastní poměr ~3.4:1 — pod WCAG AA
        // minimem pro běžný text (4.5:1), a u drobných 9-11px popisků (agenda, hinty, labely)
        // to bylo živě nahlášené jako špatně čitelné. Nové ~5.7:1, pořád viditelně tlumenější
        // než `muted` (~6.7:1), jen ne až na hraně nečitelnosti.
        faint: "#7e8697",
        // Akcent Analyzeru — nahrazuje původní zlatou jako hlavní interaktivní barvu.
        accent: "#5e7cfb",
        accentdim: "#4c63d9",
        // Sémantika (m.html)
        pos: "#2ed3a0",
        neg: "#f2606e",
        warn: "#e8ab3f",
        special: "#9d7bff",

        // Zpětná kompatibilita: `panel`/`panelborder`/`gold` jsou použité na spoustě míst
        // v komponentách. Mapuju je na nové hodnoty, takže se nic nerozbije a jde migrovat
        // postupně. `gold` teď ukazuje na jantarovou Analyzeru, ne na původní #e8b756.
        panel: "#0c0f16",
        panelborder: "#1f2637",
        gold: "#e8ab3f",
      },
      keyframes: {
        // Pulsující tečka "ŽIVÁ DATA" v hlavičce — box-shadow prstenec, ne škálování,
        // aby tečka neposouvala okolní text.
        livePulse: {
          "0%": { boxShadow: "0 0 0 0 rgba(46,211,160,.5)" },
          "70%": { boxShadow: "0 0 0 6px rgba(46,211,160,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(46,211,160,0)" },
        },
      },
      animation: {
        "live-pulse": "livePulse 2s infinite",
      },
      fontFamily: {
        // Manrope napříč celou appkou — stejně jako Analyzer. Playfair Display (serif) jsem
        // vypustil: dva různé displayové řezy vedle sebe působily jako dva různé produkty.
        sans: ["Manrope", "system-ui", "-apple-system", "sans-serif"],
        serif: ["Manrope", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "SFMono-Regular", "monospace"],
      },
    },
  },
  plugins: [],
};
