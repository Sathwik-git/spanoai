import type { ReactNode } from "react";
import { HomeLayout } from "fumadocs-ui/layouts/home";
import { baseOptions } from "@/lib/layout.shared";

// The landing is theme-aware (follows the light/dark toggle like the docs).
// The nav is transparent so it blends into the hero, and search is hidden here
// (it belongs in the docs, not on the landing).
export default function Layout({ children }: { children: ReactNode }) {
  const base = baseOptions();
  return (
    <HomeLayout
      {...base}
      nav={{ ...base.nav, transparentMode: "top" }}
      searchToggle={{ enabled: false }}
    >
      {children}
    </HomeLayout>
  );
}
