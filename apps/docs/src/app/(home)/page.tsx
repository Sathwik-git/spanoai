import Link from "next/link";
import {
  ArrowRight,
  Database,
  Radio,
  ScrollText,
  Files,
  Layers,
  ShieldCheck,
  Github,
} from "lucide-react";
import { Logo } from "@/components/logo";
import { Spotlight } from "@/components/ui/spotlight-new";
import { HoverBorderGradient } from "@/components/ui/hover-border-gradient";

const features = [
  {
    icon: Database,
    title: "Context Store",
    desc: "A shared, versioned key/value memory. Atomic append & increment, compare-and-set, blocking awaitKey, and semantic search.",
    href: "/docs/concepts/context-store",
  },
  {
    icon: Radio,
    title: "Message Bus",
    desc: "Durable agent-to-agent messaging on Redis Streams: claim/ack, request/reply, broadcast fan-out, priorities and a DLQ.",
    href: "/docs/concepts/message-bus",
  },
  {
    icon: ScrollText,
    title: "Audit Log",
    desc: "Every write and message recorded durably in Postgres — a replayable, queryable trail of who did what, when.",
    href: "/docs/concepts/sessions",
  },
  {
    icon: Files,
    title: "Artifacts",
    desc: "Hand files between agents with a claim-check pattern: direct-to-storage upload, verified by size + SHA-256, short-lived URLs.",
    href: "/docs/concepts/artifacts",
  },
  {
    icon: Layers,
    title: "Sessions",
    desc: "Scope context and messages to a run. Membership, TTLs, and a cooperative abort flag for cancellation.",
    href: "/docs/concepts/sessions",
  },
  {
    icon: ShieldCheck,
    title: "Security",
    desc: "Scoped API keys (argon2), per-agent namespace allowlists, and single-use WebSocket tickets.",
    href: "/docs/authentication",
  },
];

const footerCols = [
  {
    title: "Product",
    links: [
      { text: "Context Store", href: "/docs/concepts/context-store" },
      { text: "Message Bus", href: "/docs/concepts/message-bus" },
      { text: "Artifacts", href: "/docs/concepts/artifacts" },
      { text: "Sessions & Audit", href: "/docs/concepts/sessions" },
    ],
  },
  {
    title: "Resources",
    links: [
      { text: "Introduction", href: "/docs" },
      { text: "Quickstart", href: "/docs/quickstart" },
      { text: "Cookbook", href: "/docs/cookbook" },
      { text: "Authentication", href: "/docs/authentication" },
    ],
  },
  {
    title: "Developers",
    links: [
      { text: "TypeScript SDK", href: "/docs/api/sdk" },
      { text: "REST & WebSocket API", href: "/docs/api/rest" },
      { text: "GitHub", href: "https://github.com/Sathwik-git/spanoai" },
    ],
  },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col bg-fd-background text-fd-foreground">
      {/* ---------- Hero ---------- */}
      <section className="relative isolate overflow-hidden">
        {/* spotlight + grid are dark-mode flourishes only */}
        <div className="pointer-events-none absolute inset-0 hidden dark:block">
          <Spotlight />
        </div>
        <div className="pointer-events-none absolute inset-0 [background-image:linear-gradient(to_right,var(--color-fd-border)_1px,transparent_1px),linear-gradient(to_bottom,var(--color-fd-border)_1px,transparent_1px)] [background-size:48px_48px] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)] opacity-60" />
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_-10%,rgba(59,130,246,0.14),transparent_55%)]" />

        <div className="relative z-50 mx-auto flex max-w-5xl flex-col items-center px-6 py-28 text-center md:py-40">
          <Logo className="fade-up mb-6 size-14 text-fd-foreground" />
          <span className="fade-up mb-5 inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card px-3 py-1 text-sm text-fd-muted-foreground [animation-delay:80ms]">
            <span className="size-1.5 rounded-full bg-blue-500" />
            The coordination layer for multi-agent systems
          </span>
          <h1 className="fade-up max-w-3xl text-balance text-4xl font-bold tracking-tight [animation-delay:140ms] sm:text-5xl md:text-6xl">
            Give your agents a shared brain and a bus to talk over
          </h1>
          <p className="fade-up mt-6 max-w-2xl text-balance text-lg text-fd-muted-foreground [animation-delay:220ms]">
            Today every team reinvents how agents pass context, share memory, and
            coordinate state. SpanoAI is the substrate — a shared context store and a
            durable message bus, with built-in conflict resolution, priority queuing,
            and audit trails. Like Kafka, purpose-built for agent-to-agent communication.
          </p>
          <div className="fade-up mt-9 flex flex-wrap items-center justify-center gap-3 [animation-delay:300ms]">
            <Link href="/docs" className="rounded-full">
              <HoverBorderGradient
                as="div"
                containerClassName="rounded-full"
                className="flex items-center gap-2 bg-blue-600 px-5 py-2.5 text-sm font-medium text-white"
              >
                Get started
                <ArrowRight className="size-4" />
              </HoverBorderGradient>
            </Link>
            <Link
              href="/docs/cookbook"
              className="inline-flex items-center gap-2 rounded-full border border-fd-border px-5 py-2.5 text-sm font-medium text-fd-foreground transition-colors hover:bg-fd-accent"
            >
              Browse the cookbook
            </Link>
          </div>
        </div>
      </section>

      {/* ---------- Features ---------- */}
      <section className="relative mx-auto w-full max-w-6xl px-6 py-20 md:py-24">
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight">
            One layer, every coordination primitive
          </h2>
          <p className="mt-3 text-fd-muted-foreground">
            Everything a fleet of agents needs to share state and work together —
            without reinventing the plumbing.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <Link
              key={f.title}
              href={f.href}
              className="group relative flex flex-col rounded-xl border border-fd-border bg-fd-card p-6 transition-colors hover:border-fd-primary/40 hover:bg-fd-accent"
            >
              <div className="flex size-10 items-center justify-center rounded-lg border border-fd-border bg-fd-primary/10 text-fd-primary transition-colors group-hover:bg-fd-primary/15">
                <f.icon className="size-5" />
              </div>
              <h3 className="mt-4 font-semibold">{f.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-fd-muted-foreground">
                {f.desc}
              </p>
            </Link>
          ))}
        </div>
      </section>

      {/* ---------- CTA band ---------- */}
      <section className="mx-auto w-full max-w-6xl px-6 pb-24">
        <div className="relative isolate overflow-hidden rounded-2xl border border-fd-border bg-fd-card px-8 py-16 text-center">
          <div className="pointer-events-none absolute left-1/2 top-1/2 -z-10 size-[36rem] max-w-[120%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(59,130,246,0.12),transparent)]" />
          <h2 className="relative text-2xl font-bold tracking-tight sm:text-3xl">
            Ready to coordinate your agents?
          </h2>
          <p className="relative mx-auto mt-3 max-w-xl text-fd-muted-foreground">
            Spin up the stack locally and write your first multi-agent program in a few
            minutes.
          </p>
          <Link
            href="/docs/quickstart"
            className="relative mt-7 inline-flex items-center gap-2 rounded-full bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
          >
            Read the quickstart
            <ArrowRight className="size-4" />
          </Link>
        </div>
      </section>

      {/* ---------- Footer ---------- */}
      <footer className="border-t border-fd-border">
        <div className="mx-auto max-w-6xl px-6 py-14">
          <div className="grid gap-10 sm:grid-cols-2 md:grid-cols-[1.6fr_1fr_1fr_1fr]">
            <div className="max-w-xs">
              <div className="flex items-center gap-2">
                <Logo className="size-5 text-fd-foreground" />
                <span className="font-semibold tracking-tight">
                  Spano<span className="font-normal text-fd-muted-foreground">AI</span>
                </span>
              </div>
              <p className="mt-3 text-sm text-fd-muted-foreground">
                Shared context &amp; a communication bus for multi-agent systems.
              </p>
              <a
                href="https://github.com/Sathwik-git/spanoai"
                className="mt-4 inline-flex size-9 items-center justify-center rounded-lg border border-fd-border text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground"
                aria-label="GitHub"
              >
                <Github className="size-4" />
              </a>
            </div>
            {footerCols.map((col) => (
              <div key={col.title}>
                <h3 className="text-sm font-semibold">{col.title}</h3>
                <ul className="mt-3 space-y-2">
                  {col.links.map((l) => (
                    <li key={l.text}>
                      <Link
                        href={l.href}
                        className="text-sm text-fd-muted-foreground transition-colors hover:text-fd-foreground"
                      >
                        {l.text}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="mt-12 flex flex-col gap-2 border-t border-fd-border pt-6 text-xs text-fd-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>© 2026 SpanoAI</span>
            <span>The agent coordination standard isn&apos;t set yet.</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
