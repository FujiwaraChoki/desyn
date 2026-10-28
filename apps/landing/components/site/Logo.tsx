import Link from "next/link";

/**
 * The Desyn mark: two print crop corners around the sun. Drawn on a 48 px grid; the corners take
 * the text colour and the sun the accent, so it follows the theme.
 */
export function SunMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className={className}>
      <path
        d="M6 17V6h11M31 42h11V31"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="square"
      />
      <circle cx="24" cy="24" r="8.5" fill="var(--sun)" />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <SunMark size={24} />
      <span className="font-serif text-[27px] leading-none tracking-[-0.01em]">desyn</span>
    </span>
  );
}

export function LogoLink() {
  return (
    <Link href="/" aria-label="Desyn home" className="inline-flex items-center rounded-md py-1">
      <Wordmark />
    </Link>
  );
}
