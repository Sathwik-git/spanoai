/**
 * SpanoAI mark — three connected agents around a shared hub (the "agent mesh").
 * Monochrome via currentColor, so it inherits the surrounding text color and
 * works on any background. Size it with `className` (defaults to size-6).
 */
export function Logo({ className = "size-6" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M12 5 5 18.5 19 18.5Z"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinejoin="round"
        opacity={0.4}
      />
      <g stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" opacity={0.85}>
        <path d="M12 12.5V5" />
        <path d="M12 12.5 5 18.5" />
        <path d="M12 12.5 19 18.5" />
      </g>
      <g fill="currentColor" opacity={0.85}>
        <circle cx="12" cy="5" r="2" />
        <circle cx="5" cy="18.5" r="2" />
        <circle cx="19" cy="18.5" r="2" />
      </g>
      <circle cx="12" cy="12.5" r="2.7" fill="currentColor" />
    </svg>
  );
}
