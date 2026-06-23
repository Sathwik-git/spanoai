import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/notebook";
import { source } from "@/lib/source";
import { baseOptions } from "@/lib/layout.shared";

// Notebook layout = a persistent top navbar (logo + links + search + theme)
// with the page tree in the sidebar below it. Nav stays visible regardless of
// the sidebar's collapsed state.
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      sidebar={{ defaultOpenLevel: 1, collapsible: false }}
      {...baseOptions()}
    >
      {children}
    </DocsLayout>
  );
}
