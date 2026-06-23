# @spanoai/docs

The developer documentation site for SpanoAI, built with [Fumadocs](https://fumadocs.dev)
(Next.js 16 + MDX + Tailwind v4, themed with the shadcn preset).

## Run it

```bash
bun install            # from the repo root
cd docs && bun run dev # http://localhost:3001
```

`bun run build` produces a static export of every page; `bun run typecheck` runs `tsc`.

## Editing the docs (this is the point)

**Content is not hardcoded in components.** All pages are plain Markdown/MDX under
`content/docs/`. To change a page, edit its `.mdx`. To add a page, drop a new `.mdx`
file in the right folder and list it in that folder's `meta.json`.

```
content/docs/
  meta.json                 ← top-level order
  index.mdx                 ← Introduction
  quickstart.mdx
  authentication.mdx
  concepts/
    meta.json               ← section title + page order
    context-store.mdx
    message-bus.mdx
    artifacts.mdx
    sessions.mdx
  cookbook/                 ← the example apps live here
    meta.json
    index.mdx
    parallel-research.mdx
    coding-team.mdx
    broadcast-fanout.mdx
    artifact-share.mdx
  api/
    meta.json
    sdk.mdx
    rest.mdx
```

- **Frontmatter** — each page starts with `--- title / description ---`.
- **Sidebar order & titles** — controlled entirely by `meta.json` files (the
  `"pages"` array and `"title"`). No code change needed.
- **Sidebar tree, table-of-contents, breadcrumbs, ⌘K search** — all generated from the
  content automatically.

### Components available in MDX (no import needed)

`Callout`, `Cards`/`Card`, `Tabs`/`Tab`, `Steps`/`Step`, `TypeTable`,
`Accordions`/`Accordion`. Fenced code blocks get Shiki syntax highlighting, a copy
button, and `title="file.ts"` filename tabs out of the box. Register more in
`src/components/mdx.tsx`.

## Layout / chrome

- Top nav, logo, and links: `src/lib/layout.shared.tsx`
- Landing page (custom hero): `src/app/(home)/page.tsx`
- Theme: shadcn preset via `src/app/global.css`
- Search index: `src/app/api/search/route.ts` (Orama, built from the content)

## Notes

- Requires **Next 16 + React 19.2+** (Fumadocs v16 peer requirement — React 19.2 added
  `useEffectEvent`, which Fumadocs uses). The `web/` dashboard stays on Next 15
  independently.
- The generated `.source/` folder (created by `fumadocs-mdx` on install/dev/build) is
  gitignored.
