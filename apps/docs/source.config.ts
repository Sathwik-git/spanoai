import { defineDocs, defineConfig } from "fumadocs-mdx/config";

// Content lives in content/docs as plain .mdx files. Editing docs = editing
// markdown; sidebar order/titles come from meta.json files in each folder.
export const docs = defineDocs({
  dir: "content/docs",
});

// Preserve each fenced block's language + `title="..."` as data attributes so
// the MDX `pre` mapping can hand them to the Aceternity CodeBlock (Shiki is
// disabled below, so the `<code>` child carries the raw source text).
function remarkCodeMeta() {
  return (tree: { children?: unknown[] }) => {
    const walk = (node: Record<string, unknown>) => {
      if (node.type === "code") {
        const data = (node.data ??= {}) as Record<string, unknown>;
        const props = (data.hProperties ??= {}) as Record<string, unknown>;
        props["data-lang"] = (node.lang as string) ?? "text";
        const m = /title="([^"]+)"/.exec((node.meta as string) ?? "");
        if (m) props["data-title"] = m[1];
      }
      const children = node.children as Record<string, unknown>[] | undefined;
      if (Array.isArray(children)) children.forEach(walk);
    };
    walk(tree as Record<string, unknown>);
  };
}

export default defineConfig({
  mdxOptions: {
    // Render code with the Aceternity CodeBlock instead of Shiki — disable the
    // built-in highlighter so `pre > code` carries raw text + our data attrs.
    rehypeCodeOptions: false,
    remarkPlugins: (v) => [remarkCodeMeta, ...v],
    // Keep leaf MDX components out of the search index (else they serialize to
    // raw "<Card .../>" text in results).
    remarkStructureOptions: {
      types: ["heading", "paragraph", "blockquote", "tableCell"],
    },
  },
});
