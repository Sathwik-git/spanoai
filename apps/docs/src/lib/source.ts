import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";

// The page tree (sidebar), TOC, breadcrumbs and search index are all derived
// from this single source — built from the MDX in content/docs.
export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
});
