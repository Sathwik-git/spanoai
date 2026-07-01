import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";
import type { StaticSource } from "fumadocs-core/source";
// The page tree (sidebar), TOC, breadcrumbs and search index are all derived
// from this single source — built from the MDX in content/docs.

type DocsSource = StaticSource<{
  pageData: (typeof docs.docs)[number];
  metaData: (typeof docs.meta)[number];
}>;

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource() as DocsSource,
});

