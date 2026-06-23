import { Logo } from "@/components/logo";

/**
 * Full-screen branded loading state — a gently pulsing logo tile. Used while
 * the dashboard verifies credentials and as the route-level loading fallback,
 * so navigations show the mark instead of a blank flash.
 */
export function BrandLoader({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex min-h-svh w-full flex-col items-center justify-center gap-4">
      <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground motion-safe:animate-pulse">
        <Logo className="size-7" />
      </div>
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}
