export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-label="Hisaab">
      <rect width="64" height="64" rx="16" fill="rgb(var(--primary))" />
      <path d="M20 16v32M44 16v32M20 32h24" stroke="#fff" strokeWidth="6" strokeLinecap="round" />
      <circle cx="48" cy="48" r="7" fill="rgb(var(--saffron))" />
    </svg>
  );
}
