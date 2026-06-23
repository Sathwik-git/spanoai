import defaultMdxComponents from "fumadocs-ui/mdx";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { Card, Cards } from "fumadocs-ui/components/card";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Callout } from "fumadocs-ui/components/callout";
import { TypeTable } from "fumadocs-ui/components/type-table";
import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import type { MDXComponents } from "mdx/types";
import type { ReactElement } from "react";
import { CodeBlock } from "@/components/ui/code-block";

// react-syntax-highlighter (Prism) wants full language names.
const LANG_ALIAS: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  sh: "bash",
  shell: "bash",
  yml: "yaml",
};

// Block code (```lang title="…") is rendered with the Aceternity CodeBlock.
// Shiki is disabled in source.config, so the child <code> carries the raw text
// plus the data-lang / data-title attributes set by the remark plugin.
function Pre({ children }: { children?: unknown }) {
  const codeEl = children as ReactElement<Record<string, unknown>> | undefined;
  const p = (codeEl?.props ?? {}) as Record<string, unknown>;
  const raw = p.children;
  const code =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? raw.join("")
        : String(raw ?? "");
  const langRaw =
    (p["data-lang"] as string) ||
    String(p.className ?? "").replace(/^language-/, "") ||
    "text";
  const filename = (p["data-title"] as string) || langRaw;
  return (
    <div className="my-4">
      <CodeBlock
        language={LANG_ALIAS[langRaw] ?? langRaw}
        filename={filename}
        code={code.replace(/\n$/, "")}
      />
    </div>
  );
}

// Components available to every .mdx file without an import. Fenced code uses
// the Aceternity CodeBlock (via the `pre` mapping); these expose the richer
// building blocks to authors so content stays plain markdown.
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    pre: Pre,
    Tab,
    Tabs,
    Card,
    Cards,
    Step,
    Steps,
    Callout,
    TypeTable,
    Accordion,
    Accordions,
    ...components,
  };
}

export const useMDXComponents = getMDXComponents;
