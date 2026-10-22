/** Original illustration: a house, a doorstep package and a clock. Decorative only; it animates once on mount. */
export function HomeIllustration({ className = "" }: { className?: string }) {
  return (
    <svg className={`home-art ${className}`} viewBox="0 0 320 220" role="img" aria-label="A house with a package on the doorstep" focusable="false">
      <defs>
        <linearGradient id="ha-roof" x1="0" x2="1"><stop offset="0" stopColor="#154a3d" /><stop offset="1" stopColor="#1d5d4d" /></linearGradient>
        <linearGradient id="ha-wall" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#fcfaf4" /><stop offset="1" stopColor="#ece7d8" /></linearGradient>
      </defs>
      <ellipse cx="160" cy="196" rx="120" ry="10" fill="#0e3b31" opacity=".08" />
      <path className="ha-glow" d="M40 196 Q160 150 280 196" fill="none" stroke="#2e9378" strokeWidth="1.5" strokeDasharray="3 6" opacity=".5" />
      <rect x="78" y="92" width="164" height="104" rx="6" fill="url(#ha-wall)" stroke="#d9d3c0" />
      <path d="M62 98 L160 36 L258 98 Z" fill="url(#ha-roof)" />
      <rect x="196" y="48" width="14" height="26" fill="#154a3d" />
      <rect x="140" y="136" width="40" height="60" rx="4" fill="#0e3b31" />
      <circle cx="171" cy="168" r="2.5" fill="#f3c9a1" />
      <rect x="96" y="112" width="30" height="30" rx="3" fill="#cfe9df" stroke="#2e9378" />
      <path d="M111 112 v30 M96 127 h30" stroke="#2e9378" strokeWidth="1.2" />
      <rect x="194" y="112" width="30" height="30" rx="3" fill="#cfe9df" stroke="#2e9378" />
      <path d="M209 112 v30 M194 127 h30" stroke="#2e9378" strokeWidth="1.2" />
      <g className="ha-package">
        <rect x="204" y="170" width="38" height="26" rx="3" fill="#d9965a" />
        <rect x="204" y="170" width="38" height="8" rx="3" fill="#bf6a2c" />
        <rect x="220" y="170" width="6" height="26" fill="#f6e4d3" opacity=".85" />
      </g>
      <g className="ha-clock">
        <circle cx="268" cy="62" r="20" fill="#fcfaf4" stroke="#bf6a2c" strokeWidth="2" />
        <path d="M268 50 v12 l8 5" fill="none" stroke="#bf6a2c" strokeWidth="2.4" strokeLinecap="round" />
      </g>
    </svg>
  );
}
