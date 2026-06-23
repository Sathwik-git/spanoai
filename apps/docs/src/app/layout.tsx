import "./global.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001"),
  title: {
    default: "SpanoAI Docs",
    template: "%s · SpanoAI Docs",
  },
  description:
    "Shared context and communication bus for multi-agent systems — context store, message bus, and audit log.",
  openGraph: {
    type: "website",
    siteName: "SpanoAI",
    title: "SpanoAI",
    description:
      "Shared memory and a message bus for multi-agent systems — context store, message bus, and audit log.",
  },
  twitter: {
    card: "summary_large_image",
    title: "SpanoAI",
    description:
      "Shared memory and a message bus for multi-agent systems.",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
