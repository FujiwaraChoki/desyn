/**
 * Motion and texture classes of the AI surfaces (shimmering "working" text, skeleton sweeps, the canvas pulse
 * and the sunrise sweep). Rendered as a React 19 hoisted <style> (deduplicated by `href`) so the AI feature
 * carries its own CSS without touching the app's stylesheet. Colors come from the design tokens, so both
 * themes work; every animation stops under `prefers-reduced-motion`.
 */
const CSS = `
@keyframes dsn-ai-shimmer { from { background-position: 150% 0; } to { background-position: -50% 0; } }
@keyframes dsn-ai-pulse {
  0%, 100% { box-shadow: 0 0 0 1.5px rgb(var(--accent-rgb) / 0.5); }
  50% { box-shadow: 0 0 0 1.5px rgb(var(--accent-rgb) / 1); }
}
@keyframes dsn-ai-sweep {
  0% { background-position: 120% 0; opacity: 0; }
  15% { opacity: 1; }
  100% { background-position: -40% 0; opacity: 0; }
}
@keyframes dsn-ai-rise {
  0% { opacity: 0; transform: translateY(6px) scale(0.995); }
  100% { opacity: 1; transform: none; }
}
@keyframes dsn-ai-orbit { to { transform: rotate(360deg); } }
.dsn-ai-shimmer-text {
  background: linear-gradient(90deg, var(--fg-secondary) 0%, var(--fg-secondary) 35%, var(--accent-hi) 50%, var(--fg-secondary) 65%, var(--fg-secondary) 100%);
  background-size: 250% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: dsn-ai-shimmer 2.4s linear infinite;
}
.dsn-ai-shimmer {
  background: linear-gradient(110deg, rgb(var(--foreground-rgb) / 0.03) 30%, rgb(var(--accent-rgb) / 0.13) 50%, rgb(var(--foreground-rgb) / 0.03) 70%);
  background-size: 250% 100%;
  animation: dsn-ai-shimmer 1.8s linear infinite;
}
.dsn-ai-checker {
  background-color: rgb(var(--foreground-rgb) / 0.02);
  background-image: conic-gradient(rgb(var(--foreground-rgb) / 0.07) 25%, transparent 0 50%, rgb(var(--foreground-rgb) / 0.07) 0 75%, transparent 0);
  background-size: 14px 14px;
}
.dsn-ai-enter { animation: dsn-ai-rise 0.5s var(--ease-out) both; }
.dsn-ai-running::before {
  content: "";
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  padding: 1px;
  background: conic-gradient(from var(--dsn-ai-angle, 0deg), transparent 0deg, rgb(var(--accent-hi-rgb) / 0.95) 40deg, rgb(var(--accent-lo-rgb) / 0.8) 80deg, transparent 140deg, transparent 360deg);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
  animation: dsn-ai-angle 2.6s linear infinite;
}
@property --dsn-ai-angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
@keyframes dsn-ai-angle { to { --dsn-ai-angle: 360deg; } }
.dsn-ai-glow {
  border-radius: 6px;
  animation: dsn-ai-pulse 2.4s var(--ease-in-out) infinite;
}
.dsn-ai-sunrise {
  background: linear-gradient(100deg, transparent 25%, rgb(var(--accent-hi-rgb) / 0.0) 35%, rgb(var(--accent-hi-rgb) / 0.55) 48%, rgb(var(--accent-lo-rgb) / 0.35) 54%, rgb(var(--accent-lo-rgb) / 0) 65%, transparent 75%);
  background-size: 260% 100%;
  mix-blend-mode: screen;
  animation: dsn-ai-sweep 1.5s var(--ease-out) forwards;
}
.dsn-ai-sunrise-ring {
  box-shadow: 0 0 0 1.5px rgb(var(--accent-rgb) / 0.9);
  border-radius: 6px;
  animation: dsn-ai-sweep-ring 1.6s var(--ease-out) forwards;
}
@keyframes dsn-ai-sweep-ring { 0% { opacity: 0; } 20% { opacity: 1; } 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .dsn-ai-shimmer-text, .dsn-ai-shimmer, .dsn-ai-enter, .dsn-ai-running::before, .dsn-ai-glow, .dsn-ai-sunrise, .dsn-ai-sunrise-ring { animation: none; }
  .dsn-ai-shimmer-text { color: var(--fg-secondary); background: none; }
  .dsn-ai-glow { box-shadow: 0 0 0 1.5px rgb(var(--accent-rgb) / 0.9); }
  .dsn-ai-sunrise { display: none; }
}
`;

export function AiStyles() {
  return (
    <style href="desyn-ai-styles" precedence="default">
      {CSS}
    </style>
  );
}
