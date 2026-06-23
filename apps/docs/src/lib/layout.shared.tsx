import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Logo } from "@/components/logo";

// Shared chrome (logo, nav links, GitHub) for both the docs layout and the
// landing page. One place to change the top-level navigation.
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <Logo className="size-5" />
          <span className="font-semibold tracking-tight">
            Spano<span className="font-normal text-fd-muted-foreground">AI</span>
          </span>
        </>
      ),
    },
    // The full doc tree lives in the sidebar; the dashboard is an internal app,
    // not a public nav target — so the top bar is just brand + search + GitHub.
    links: [],
    githubUrl: "https://github.com/Sathwik-git/spanoai",
  };
}
